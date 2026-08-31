// Wake lifecycle: the reasons "Hey Artemis" silently did nothing.
//
// The root cause this locks down: an AudioContext can be created — or left —
// SUSPENDED, in which case the worklet delivers no frames, no inference runs,
// and nothing ever fires, while `running` is still true and the UI still says
// "listening". Armed in appearance, deaf in fact. Frames are the only honest
// evidence audio is flowing, so the engine counts them and heals when they stop.
//
// Run: node --test test/wakeLifecycle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceSuspended } from "../public/presentationPolicy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const wake = readFileSync(join(ROOT, "public/wakeLocal.js"), "utf8");
const main = readFileSync(join(ROOT, "public/main.js"), "utf8");

test("the wake engine RESUMES a suspended AudioContext — the root cause", () => {
  assert.match(wake, /c\.state !== "running"/, "it checks the context state after building the graph");
  assert.match(wake, /await c\.resume\(\)/, "and resumes it — without this the worklet gets no frames");
});

test("frame liveness is tracked, so a silent stall is detectable at all", () => {
  assert.match(wake, /framesSeen \+= 1/, "every delivered frame is counted");
  assert.match(wake, /lastFrameAt = Date\.now\(\)/, "and timestamped");
  assert.match(wake, /export function wakeHealth/, "health is inspectable for diagnostics/tests");
});

test("self-healing is bounded — never an infinite restart loop", () => {
  assert.match(wake, /HEAL_MAX = \d/, "a hard retry ceiling exists");
  assert.match(wake, /healRetries >= HEAL_MAX/, "and it is enforced");
  assert.match(wake, /wakeLog\("failure"/, "exhausting it surfaces an error state instead of spinning");
  assert.match(wake, /setTimeout\(\(r\) => setTimeout\(r, 250 \* healRetries\)|250 \* healRetries/, "with backoff between attempts");
});

test("returning to visibility proactively resumes, not just the watchdog", () => {
  assert.match(wake, /visibilitychange/, "the most common suspend moment is handled directly");
});

test("diagnostics log lifecycle transitions, never audio, never per frame", () => {
  assert.match(wake, /wakeLog\("armed"/);
  assert.match(wake, /wakeLog\("stopped"/);
  assert.match(wake, /wakeLog\("suspended"/);
  assert.match(wake, /wakeLog\("re-armed"/);
  assert.match(wake, /if \(line === lastHealth\) return;/, "repeated identical lines are suppressed");
  assert.doesNotMatch(wake, /console\.log\([^)]*audio\[/, "raw audio is never logged");
});

test("wake survives FULL and PILL, and suspends only where no surface vouches for the mic", () => {
  // pill: dashboard hidden BY DESIGN, the pill is the visible open-mic
  // indicator, so the runtime stays alive.
  assert.equal(voiceSuspended(true, "pill", true), false, "PILL keeps wake alive");
  assert.equal(voiceSuspended(false, "full", true), false, "visible FULL keeps wake alive");
  assert.equal(voiceSuspended(true, "background", true), true, "background suspends");
  assert.equal(voiceSuspended(true, "full", true), true, "a genuinely hidden dashboard suspends");
});

test("every terminal voice state routes back through re-arm", () => {
  // afterSpeak() runs on TTS finish, error and cancellation; each path must
  // end at restoreWakeListening() or a follow-up that re-arms itself.
  assert.match(main, /function afterSpeak\(\)/);
  const after = main.slice(main.indexOf("async function afterSpeak()"), main.indexOf("// ---- persistence"));
  assert.ok((after.match(/restoreWakeListening\(\)/g) || []).length >= 2,
    "afterSpeak re-arms on its terminal paths");
  assert.match(after, /speaking = false/, "the speaking flag is cleared first, or re-arm would bail");
});

test("the capture state is broadcast so the mix can react to a REAL wake", () => {
  assert.match(main, /wakeCapturing\) \? "capturing"/, "listening during capture is remapped to capturing for the mix");
  assert.match(main, /detail: mixState/, "the remapped state is what the bed hears");
  assert.match(main, /detail: "listening"/, "and capture end returns to armed");
});
