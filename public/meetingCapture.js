// Pure phrase matching for the client-owned meeting capture mode.
//
// The caller removes a leading wake phrase before invoking these helpers.
// Matching is deliberately whole-utterance only: speech about the command must
// remain meeting content and must never start or stop the microphone.

const START_PHRASES = new Set([
  "take notes",
  "start taking notes",
]);

const STOP_PHRASES = new Set([
  "stop taking notes",
  "that's the meeting",
]);

function normalizePhrase(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/\p{P}+$/u, "")
    .trim();
}

export function isMeetingStartPhrase(text) {
  return START_PHRASES.has(normalizePhrase(text));
}

export function isMeetingStopPhrase(text) {
  return STOP_PHRASES.has(normalizePhrase(text));
}
