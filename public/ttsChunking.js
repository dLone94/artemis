const SENTENCE = /^([\s\S]*?[.!?…]+["')\]]?)(\s|$)/;

function wordBoundary(text, limit) {
  const bounded = Math.min(limit, text.length);
  const space = text.lastIndexOf(" ", Math.max(0, bounded - 1));
  return space > Math.min(40, bounded / 2) ? space + 1 : bounded;
}

// Voicebox performs a full local model generation per request. Emit one
// sentence promptly, then retain the remainder so the caller can coalesce it
// instead of starting one model job for every sentence in the streamed reply.
export function takeVoiceboxChunks(text, options = {}) {
  let remainder = String(text || "");
  let firstChunkPending = options.firstChunkPending !== false;
  const flush = options.flush === true;
  const maxChunkChars = Math.max(80, Number(options.maxChunkChars) || 700);
  const firstChunkChars = Math.min(maxChunkChars, Math.max(80, Number(options.firstChunkChars) || 180));
  const chunks = [];

  if (firstChunkPending && remainder) {
    const sentence = remainder.match(SENTENCE);
    if (sentence) {
      const length = sentence[0].length <= maxChunkChars
        ? sentence[0].length
        : wordBoundary(remainder, maxChunkChars);
      chunks.push(remainder.slice(0, length));
      remainder = remainder.slice(length);
      firstChunkPending = false;
    } else if (remainder.length > firstChunkChars) {
      const length = wordBoundary(remainder, firstChunkChars);
      chunks.push(remainder.slice(0, length));
      remainder = remainder.slice(length);
      firstChunkPending = false;
    }
  }

  while (!firstChunkPending && remainder.length > maxChunkChars) {
    const length = wordBoundary(remainder, maxChunkChars);
    chunks.push(remainder.slice(0, length));
    remainder = remainder.slice(length);
  }

  if (flush && remainder.trim()) {
    chunks.push(remainder);
    remainder = "";
    firstChunkPending = false;
  }

  return { chunks, remainder, firstChunkPending };
}
