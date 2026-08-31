// Pure conversation-mode logic. No microphone, DOM, STT, or TTS.
// Run: node test/followup.test.mjs
import assert from "node:assert";
import {
  FOLLOW_UP_STORAGE_KEY,
  isClosingPhrase,
  loadFollowUpEnabled,
  matchWake,
  saveFollowUpEnabled
} from "../public/wakeWords.js";
import { FALLBACK_PROFILE } from "../public/wakeProfile.js";

const closingPhrases = [
  "that's all",
  "that's it",
  "thanks that's all",
  "thank you that's all",
  "go to sleep",
  "stop listening",
  "never mind"
];

for (const phrase of closingPhrases) {
  assert.equal(isClosingPhrase(phrase), true, `accepts closing phrase: ${phrase}`);
}
console.log("  ✓ accepts every closing phrase");

for (const phrase of closingPhrases) {
  assert.equal(isClosingPhrase(`  ${phrase.toUpperCase()}?!  `), true, `normalizes closing phrase: ${phrase}`);
}
console.log("  ✓ accepts case, whitespace, and trailing-punctuation noise");

assert.equal(isClosingPhrase("that's all the emails"), false, "does not close on a longer email command");
assert.equal(isClosingPhrase("stop listening to the radio"), false, "does not close on a longer listening command");
assert.equal(isClosingPhrase(""), false, "empty speech is not a closing phrase");
assert.equal(isClosingPhrase(null), false, "missing speech is not a closing phrase");
console.log("  ✓ rejects substring traps and empty input");

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();
assert.equal(FOLLOW_UP_STORAGE_KEY, "artemisFollowUp", "uses the approved settings key");
assert.equal(loadFollowUpEnabled(storage), true, "follow-up defaults ON");
saveFollowUpEnabled(storage, false);
assert.equal(storage.getItem("artemisFollowUp"), "0", "OFF persists under the approved key");
assert.equal(loadFollowUpEnabled(storage), false, "OFF round-trips");
saveFollowUpEnabled(storage, true);
assert.equal(storage.getItem("artemisFollowUp"), "1", "ON persists under the approved key");
assert.equal(loadFollowUpEnabled(storage), true, "ON round-trips");
console.log("  ✓ follow-up setting defaults ON and round-trips ON/OFF");

{
  const jarvis = matchWake("hey jarvis what's the weather", FALLBACK_PROFILE);
  assert.ok(jarvis && jarvis.matched, "the fallback profile hears Hey Jarvis");
  assert.match(jarvis.rest, /weather/);
  const alias = matchWake("gervais play some jazz", FALLBACK_PROFILE);
  assert.ok(alias && alias.matched, "declared Jarvis mishearings also wake her");
  assert.equal(alias.rest, "play some jazz");
  const silent = matchWake("hey jarvis what's the weather");
  assert.equal(silent, null, "without a profile, Jarvis is not a wake word");
  const artemis = matchWake("hey artemis check my email", FALLBACK_PROFILE);
  assert.ok(artemis && artemis.matched, "Artemis phrases still match as a second net");
  assert.equal(artemis.rest, "check my email");
}
console.log("  ✓ browser wake matching follows the active profile, not a hardcoded Artemis list");

console.log("PASS ✅  follow-up: closing phrases and persisted setting are pure and exact");
