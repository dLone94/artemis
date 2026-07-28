// Artemis wake words — configurable list + fuzzy matching (browser speech
// recognition is rarely exact, so allow minor mis-transcriptions). Lightweight:
// a couple of short-string Levenshtein checks per final transcript, no network.

export const WAKE_WORDS = [
  "artemis",
  "hey artemis",
  "yo artemis",
  "ok artemis",
  "hi art",
  "hey art"
];

const CLOSING_PHRASES = new Set([
  "that's all",
  "that's it",
  "thanks that's all",
  "thank you that's all",
  "go to sleep",
  "stop listening",
  "never mind"
]);

export const FOLLOW_UP_STORAGE_KEY = "artemisFollowUp";

export function isClosingPhrase(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\p{P}+$/u, "")
    .trim();
  return CLOSING_PHRASES.has(normalized);
}

export function loadFollowUpEnabled(storage) {
  try {
    return !storage || storage.getItem(FOLLOW_UP_STORAGE_KEY) !== "0";
  } catch (e) {
    return true;
  }
}

export function saveFollowUpEnabled(storage, enabled) {
  try {
    if (storage) storage.setItem(FOLLOW_UP_STORAGE_KEY, enabled ? "1" : "0");
  } catch (e) {}
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// fuzzy-equal: exact, or within ~30% edit distance (min 1 edit) — catches
// "artemus" / "artmis" / "are art" style mis-hears without matching random words.
function fuzzyEq(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  return lev(a, b) <= Math.max(1, Math.floor(b.length * 0.3));
}

// Returns { matched:true, rest:"<command after the wake word>" } or null.
export function matchWake(transcript) {
  const words = normalize(transcript).split(" ").filter(Boolean);
  if (!words.length) return null;

  // multi-word phrases first (more reliable): compare the first K words
  for (const phrase of WAKE_WORDS) {
    const pw = normalize(phrase).split(" ");
    if (words.length < pw.length) continue;
    const ok = pw.every((p, i) => fuzzyEq(words[i], p));
    if (ok) return { matched: true, rest: words.slice(pw.length).join(" ") };
  }

  // single "artemis" appearing within the first 3 words (e.g. "um, artemis …")
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    if (fuzzyEq(words[i], "artemis")) return { matched: true, rest: words.slice(i + 1).join(" ") };
  }
  return null;
}
