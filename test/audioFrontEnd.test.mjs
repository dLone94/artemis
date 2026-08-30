// The adaptive capture front end: hear the USER better, not the room louder.
//
// The baseline bug these lock down: VAD used max(noiseFloor*3.5, 0.010) — an
// ABSOLUTE floor. Whispered or ~2 m speech lands at RMS 0.003–0.008, below that
// constant, so in a quiet room speech well above the noise was still ignored.
// Quiet speech could not be detected in principle, at any distance.
//
// Run: node --test test/audioFrontEnd.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAudioFrontEnd, createNoiseFloor, createAdaptiveGain, createHighPass,
  applyGain, rms, peak, snrDb, PROFILES
} from "../public/audioFrontEnd.js";
import { listeningProfileForText } from "../shutdownIntent.js";

/** A frame of "speech": band-limited tone burst at a chosen level. */
function speechFrame(level, n = 512, seed = 1) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    f[i] = level * (Math.sin((2 * Math.PI * 220 * (i + seed)) / 16000) +
                    0.5 * Math.sin((2 * Math.PI * 700 * (i + seed)) / 16000));
  }
  return f;
}
function noiseFrame(level, n = 512) {
  const f = new Float32Array(n);
  let s = 7;
  for (let i = 0; i < n; i += 1) { s = (s * 1103515245 + 12345) & 0x7fffffff; f[i] = ((s / 0x7fffffff) * 2 - 1) * level; }
  return f;
}

// ---- noise floor -------------------------------------------------------------

test("the noise floor follows a quieter room fast and a louder one slowly", () => {
  const nf = createNoiseFloor({ initial: 0.02 });
  for (let i = 0; i < 40; i += 1) nf.update(0.002, false);
  assert.ok(nf.value < 0.004, `should fall toward a quiet room, got ${nf.value}`);
  const quiet = nf.value;
  nf.update(0.5, false);   // one door slam
  assert.ok(nf.value < quiet * 3, "a single loud transient must not pin the floor high");
});

test("speech never teaches the estimator the room", () => {
  const nf = createNoiseFloor({ initial: 0.002 });
  for (let i = 0; i < 50; i += 1) nf.update(0.08, true);   // loud speech, flagged
  assert.ok(nf.value < 0.003, `speech must be excluded, got ${nf.value}`);
});

// ---- the core regression: quiet speech is detectable at all -------------------

test("QUIET speech in a quiet room is detected — the old absolute floor is gone", () => {
  const fe = createAudioFrontEnd();
  for (let i = 0; i < 30; i += 1) fe.process(noiseFrame(0.0008));   // learn a quiet room
  const info = fe.process(speechFrame(0.006));                      // whisper-level
  assert.equal(info.speech, true,
    `RMS ~0.006 over a ~0.0008 floor is speech; the old code required >0.010 and missed it`);
  assert.ok(info.snrDb > 10, `and it is comfortably above the noise (${info.snrDb} dB)`);
});

test("silence and steady room noise are NOT speech", () => {
  const fe = createAudioFrontEnd();
  let falsePositives = 0;
  for (let i = 0; i < 60; i += 1) if (fe.process(noiseFrame(0.001)).speech) falsePositives += 1;
  assert.ok(falsePositives <= 2, `steady noise must not read as speech, got ${falsePositives}`);
  assert.equal(fe.process(new Float32Array(512)).speech, false, "digital silence is never speech");
});

test("a NOISY room raises the bar — the threshold is relative, not fixed", () => {
  const fe = createAudioFrontEnd();
  for (let i = 0; i < 60; i += 1) fe.process(noiseFrame(0.02));  // loud room
  assert.ok(fe.noiseFloor > 0.005, `floor should track the room, got ${fe.noiseFloor}`);
  assert.equal(fe.process(speechFrame(0.004)).speech, false,
    "speech far below a loud room's floor must not register");
});

// ---- adaptive gain -----------------------------------------------------------

test("quiet speech is raised toward the target, loud speech is not amplified", () => {
  const quiet = createAdaptiveGain(PROFILES.NORMAL);
  for (let i = 0; i < 40; i += 1) quiet.update(0.005, 0.02, true);
  assert.ok(quiet.gain > 2, `quiet speech should be lifted, got ${quiet.gain}x`);
  assert.ok(quiet.gain <= PROFILES.NORMAL.maxGain, "and never beyond the profile ceiling");

  const loud = createAdaptiveGain(PROFILES.NORMAL);
  for (let i = 0; i < 40; i += 1) loud.update(0.20, 0.6, true);
  assert.ok(loud.gain < 1.2, `already-loud speech must not be amplified, got ${loud.gain}x`);
});

test("near-clipping input makes the gain back off immediately", () => {
  const g = createAdaptiveGain(PROFILES.WHISPER);      // the most aggressive profile
  for (let i = 0; i < 30; i += 1) g.update(0.004, 0.02, true);
  const lifted = g.gain;
  assert.ok(lifted > 3, "starts by lifting a very quiet signal");
  for (let i = 0; i < 10; i += 1) g.update(0.004, 0.97, true);   // peaks hit the rails
  assert.ok(g.gain < lifted, `gain must retreat from clipping (${lifted}x → ${g.gain}x)`);
  assert.ok(g.gain <= 1.05, "and settle at essentially unity when peaks are already full scale");
});

test("gain never amplifies silence, and never exceeds the ceiling", () => {
  const g = createAdaptiveGain(PROFILES.FAR_FIELD);
  for (let i = 0; i < 50; i += 1) g.update(0.0001, 0.0005, false);  // silence, not speech
  assert.equal(g.gain, 1, "silence is held at unity — amplifying a room is not hearing");
  for (let i = 0; i < 200; i += 1) g.update(0.00001, 0.0001, true);
  assert.ok(g.gain <= PROFILES.FAR_FIELD.maxGain, "the ceiling is absolute");
});

test("applyGain clamps rather than wrapping, and reports the true peak", () => {
  const f = new Float32Array([0.5, -0.5, 0.9, -0.9]);
  const p = applyGain(f, 4);
  const CEIL = Math.fround(0.98) + 1e-6;   // Float32 stores 0.98 as 0.98000001…
  assert.ok(f.every((v) => Math.abs(v) <= CEIL), "no sample escapes the ceiling");
  // Float32 stores 0.98 as 0.98000001…, so compare against the stored value.
  assert.ok(p <= CEIL && p > 0.9, "the returned peak reflects the clamped audio");
});

// ---- filtering ---------------------------------------------------------------

test("the high-pass removes DC/rumble without gutting speech", () => {
  const hp = createHighPass();
  // A one-pole filter needs a few frames to settle; feed it a steady offset.
  let dc;
  for (let i = 0; i < 6; i += 1) { dc = new Float32Array(512).fill(0.3); hp.process(dc); }
  assert.ok(rms(dc) < 0.3 * 0.25, `DC is largely removed, got ${rms(dc)}`);
  const hp2 = createHighPass();
  const voice = speechFrame(0.05);
  const before = rms(voice);
  hp2.process(voice);
  assert.ok(rms(voice) > before * 0.7, "speech-band energy survives — whisper.cpp wants natural audio");
});

// ---- profiles ----------------------------------------------------------------

test("the three profiles differ in the ways that matter", () => {
  const { NORMAL, FAR_FIELD, WHISPER } = PROFILES;
  assert.ok(FAR_FIELD.speechRatio < NORMAL.speechRatio, "far field accepts speech closer to the noise");
  assert.ok(WHISPER.minSpeech < NORMAL.minSpeech, "whisper accepts lower absolute level");
  assert.ok(WHISPER.maxGain > NORMAL.maxGain && FAR_FIELD.maxGain > NORMAL.maxGain, "both quiet modes get more headroom");
  assert.ok(WHISPER.silenceMs > NORMAL.silenceMs, "whispers have long internal gaps — don't cut them off");
  assert.ok(FAR_FIELD.silenceMs > NORMAL.silenceMs, "reflections smear the tail");
  assert.ok(WHISPER.preRollMs >= NORMAL.preRollMs, "quiet onsets need more pre-roll");
  assert.ok(FAR_FIELD.wakeBias < 0 && WHISPER.wakeBias < 0, "quiet modes are more wake-sensitive…");
  assert.ok(FAR_FIELD.wakeBias > -0.15 && WHISPER.wakeBias > -0.15, "…but never wide open");
});

// ---- AUTO --------------------------------------------------------------------

test("AUTO classifies per utterance and needs agreement before switching", () => {
  const fe = createAudioFrontEnd();
  assert.equal(fe.profileName, "NORMAL");
  // quiet but CLEAN → whisper
  assert.equal(fe.observeUtterance({ rms: 0.008, noiseFloor: 0.001 }), "NORMAL", "one utterance is not enough");
  assert.equal(fe.observeUtterance({ rms: 0.008, noiseFloor: 0.001 }), "WHISPER", "two agreeing utterances commit");
  // quiet and NOISY → far field
  fe.observeUtterance({ rms: 0.008, noiseFloor: 0.004 });
  assert.equal(fe.observeUtterance({ rms: 0.008, noiseFloor: 0.004 }), "FAR_FIELD");
  // strong close speech → back to normal
  fe.observeUtterance({ rms: 0.09, noiseFloor: 0.001 });
  assert.equal(fe.observeUtterance({ rms: 0.09, noiseFloor: 0.001 }), "NORMAL");
});

test("hysteresis prevents flapping on alternating utterances", () => {
  const fe = createAudioFrontEnd();
  for (let i = 0; i < 8; i += 1) {
    fe.observeUtterance({ rms: 0.008, noiseFloor: 0.001 });   // whisper-ish
    fe.observeUtterance({ rms: 0.09, noiseFloor: 0.001 });    // loud
  }
  assert.equal(fe.profileName, "NORMAL", "alternating evidence must not thrash the mode");
});

// ---- manual override ---------------------------------------------------------

test("a manual pin overrides AUTO and can be released", () => {
  const fe = createAudioFrontEnd();
  assert.deepEqual(fe.setOverride("FAR_FIELD"), { profile: "FAR_FIELD", auto: false });
  assert.equal(fe.overridden, true);
  // AUTO evidence must not move a pinned profile
  for (let i = 0; i < 6; i += 1) fe.observeUtterance({ rms: 0.09, noiseFloor: 0.001 });
  assert.equal(fe.profileName, "FAR_FIELD", "a pin outranks the classifier");
  assert.deepEqual(fe.setOverride(null), { profile: "FAR_FIELD", auto: true });
  assert.equal(fe.overridden, false);
  assert.equal(fe.setOverride("NONSENSE").error, "unknown-profile");
});

test("the spoken override phrases map to profiles, and ordinary speech does not", () => {
  assert.deepEqual(listeningProfileForText("Artemis, enable far-field listening."), { profile: "FAR_FIELD" });
  assert.deepEqual(listeningProfileForText("use far-field listening"), { profile: "FAR_FIELD" });
  assert.deepEqual(listeningProfileForText("listen from farther away"), { profile: "FAR_FIELD" });
  assert.deepEqual(listeningProfileForText("enable whisper mode"), { profile: "WHISPER" });
  assert.deepEqual(listeningProfileForText("Artemis, use normal listening."), { profile: null });
  assert.deepEqual(listeningProfileForText("disable far-field mode"), { profile: null });
  for (const p of ["open terminal", "shut it down", "what are those emails about"]) {
    assert.equal(listeningProfileForText(p), null, `"${p}" is not a listening-mode command`);
  }
});

// ---- output contract ---------------------------------------------------------

test("processed audio stays valid linear16-convertible PCM for local STT", () => {
  const fe = createAudioFrontEnd();
  const f = speechFrame(0.004);
  for (let i = 0; i < 20; i += 1) fe.process(speechFrame(0.004, 512, i));
  fe.process(f);
  assert.ok(f.every((v) => Number.isFinite(v) && v >= -1 && v <= 1),
    "every sample stays finite and in range — a NaN would poison the WAV");
  assert.ok(peak(f) <= 0.98, "and within the clipping ceiling");
});

test("diagnostics report metadata only — never audio", () => {
  const fe = createAudioFrontEnd();
  fe.process(speechFrame(0.01));
  const d = fe.diagnostics();
  assert.deepEqual(Object.keys(d).sort(), ["auto", "gain", "noiseFloor", "profile", "snrDb", "speechFrames"]);
  for (const v of Object.values(d)) {
    assert.ok(typeof v !== "object", "no buffers, no samples, nothing resembling audio");
  }
  assert.equal(snrDb(0.01, 0.001).toFixed(0), "20");
});
