// STT routing policy + the local whisper.cpp adapter.
//
// The contract that matters most: in local-only mode the cloud provider is not
// "deprioritised", it is FORBIDDEN — no attempt, no retry, no silent fallback.
// A user who turned the internet off must be able to trust that.
//
// Run: node --test test/sttRouter.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseSttProvider,
  afterCloudFailure,
  sttUnavailableMessage,
  localFailureMessage,
  STT_LOCAL,
  STT_CLOUD
} from "../sttRouter.js";
import {
  pcmToWav,
  pcmDurationSec,
  parseWhisperOutput,
  localSttStatus,
  setupHint,
  transcribeLocal,
  modelPath,
  modelTier,
  MODEL_TIERS,
  SAMPLE_RATE
} from "../providers/sttLocal.js";

// ---- policy: local-only is a hard boundary ----------------------------------

test("local-only mode routes to LOCAL and forbids cloud outright", () => {
  const d = chooseSttProvider({ offline: true, cloudConfigured: true, localReady: true });
  assert.equal(d.provider, STT_LOCAL);
  assert.equal(d.cloudForbidden, true);
  assert.equal(d.fallback, null, "there is no cloud fallback offline");
  assert.equal(afterCloudFailure(d), null, "even a failure must not reach cloud");
});

test("local-only with no local model refuses honestly instead of using cloud", () => {
  const d = chooseSttProvider({ offline: true, cloudConfigured: true, localReady: false });
  assert.equal(d.provider, null, "nothing may run");
  assert.equal(d.cloudForbidden, true);
  assert.match(sttUnavailableMessage(d), /local-only|isn't installed/i);
  assert.ok(!/deepgram/i.test(sttUnavailableMessage(d)));
});

// ---- policy: hybrid prefers cloud, falls back locally ----------------------

test("hybrid prefers cloud when configured and healthy, with local standby", () => {
  const d = chooseSttProvider({ offline: false, cloudConfigured: true, localReady: true });
  assert.equal(d.provider, STT_CLOUD);
  assert.equal(d.fallback, STT_LOCAL);
  assert.equal(d.cloudForbidden, false);
  assert.equal(afterCloudFailure(d), STT_LOCAL, "a cloud failure falls back to local");
});

test("hybrid falls straight to local when the cloud is unhealthy or unkeyed", () => {
  const unhealthy = chooseSttProvider({ offline: false, cloudConfigured: true, localReady: true, cloudHealthy: false });
  assert.equal(unhealthy.provider, STT_LOCAL);
  const unkeyed = chooseSttProvider({ offline: false, cloudConfigured: false, localReady: true });
  assert.equal(unkeyed.provider, STT_LOCAL);
});

test("hybrid with cloud only (no local model) still works", () => {
  const d = chooseSttProvider({ offline: false, cloudConfigured: true, localReady: false });
  assert.equal(d.provider, STT_CLOUD);
  assert.equal(d.fallback, null);
  assert.equal(afterCloudFailure(d), null);
});

test("nothing configured at all is reported, not guessed", () => {
  const d = chooseSttProvider({ offline: false, cloudConfigured: false, localReady: false });
  assert.equal(d.provider, null);
  assert.match(sttUnavailableMessage(d), /speech provider/i);
  assert.match(localFailureMessage(true), /couldn't transcribe that locally/i);
});

// ---- the audio contract ------------------------------------------------------

test("PCM is framed as canonical 16 kHz mono 16-bit WAV, no re-encode", () => {
  const pcm = Buffer.alloc(3200); // 0.1s at 16 kHz mono 16-bit
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length, "44-byte header + untouched samples");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1, "format = PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE, "16 kHz");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data length");
  assert.equal(pcmDurationSec(pcm), 0.1);
});

// ---- whisper output parsing --------------------------------------------------

test("whisper output keeps speech and drops non-speech markers", () => {
  const out = [
    "[00:00:00.000 --> 00:00:02.000]   Open Terminal.",
    "[00:00:02.000 --> 00:00:03.000]   [BLANK_AUDIO]",
    "[00:00:03.000 --> 00:00:05.000]   Type one and press enter.",
    "[00:00:05.000 --> 00:00:06.000]   (silence)"
  ].join("\n");
  assert.equal(parseWhisperOutput(out), "Open Terminal. Type one and press enter.");
  assert.equal(parseWhisperOutput(""), "");
  assert.equal(parseWhisperOutput("[00:00:00.000 --> 00:00:01.000]   ♪"), "");
});

// ---- readiness is checked BEFORE a voice session, never mid-utterance -------

test("a missing engine or model is a setup state, not a failed utterance", () => {
  const noEngine = localSttStatus({ env: { ARTEMIS_STT_BINARY: "/nope/whisper-cli" }, exists: () => false });
  assert.equal(noEngine.ready, false);
  assert.equal(noEngine.reason, "engine-missing");
  assert.match(setupHint(noEngine), /npm run setup:stt/);

  const noModel = localSttStatus({
    env: { ARTEMIS_STT_BINARY: "/bin/whisper-cli", ARTEMIS_STT_MODEL_PATH: "/nope/model.bin" },
    exists: (p) => p === "/bin/whisper-cli"
  });
  assert.equal(noModel.ready, false);
  assert.equal(noModel.reason, "model-missing");
});

test("transcribing with no model returns the setup state and NEVER downloads", async () => {
  let ran = false;
  const r = await transcribeLocal(Buffer.alloc(3200), {
    status: { ready: false, reason: "model-missing", binary: "x", model: "y", tier: "balanced" },
    run: async () => { ran = true; return ""; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "model-missing");
  assert.equal(ran, false, "nothing is executed and nothing is fetched");
  assert.match(r.hint, /setup:stt/);
});

// ---- a real transcription, with the binary faked ----------------------------

test("a local transcription reports the transcript and MEASURED latency", async () => {
  const calls = [];
  const pcm = Buffer.alloc(SAMPLE_RATE * 2 * 2); // 2 seconds
  const r = await transcribeLocal(pcm, {
    status: { ready: true, reason: "ready", binary: "whisper-cli", model: "/m/ggml-base.bin", tier: "balanced" },
    run: async (bin, args) => {
      calls.push({ bin, args });
      return "[00:00:00.000 --> 00:00:02.000]   Open System Settings.";
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.transcript, "Open System Settings.");
  assert.equal(r.provider, "local");
  assert.equal(r.audioSec, 2);
  assert.ok(typeof r.msElapsed === "number", "elapsed time is measured, not invented");
  assert.ok(r.realtime !== null, "real-time factor derives from the measurement");
  assert.equal(calls[0].bin, "whisper-cli");
  assert.ok(calls[0].args.includes("-m") && calls[0].args.includes("/m/ggml-base.bin"));
});

test("language stays configurable so Bulgarian remains reachable", async () => {
  let seen = [];
  const status = { ready: true, reason: "ready", binary: "w", model: "/m/ggml-base.bin", tier: "balanced" };
  await transcribeLocal(Buffer.alloc(320), { status, language: "bg", run: async (b, a) => { seen = a; return ""; } });
  const i = seen.indexOf("-l");
  assert.equal(seen[i + 1], "bg", "an explicit language is pinned (and skips detection)");
  await transcribeLocal(Buffer.alloc(320), { status, language: "auto", run: async (b, a) => { seen = a; return ""; } });
  assert.equal(seen[seen.indexOf("-l") + 1], "auto", "auto-detect stays available for multilingual speech");
  // default is pinned English: measured twice as fast as detection
  await transcribeLocal(Buffer.alloc(320), { status, env: {}, run: async (b, a) => { seen = a; return ""; } });
  assert.equal(seen[seen.indexOf("-l") + 1], "en", "the default pins English for latency");
});

test("the decoding prompt biases toward real Artemis commands, and is overridable", async () => {
  const status = { ready: true, reason: "ready", binary: "w", model: "m", tier: "fast" };
  let seen = [];
  await transcribeLocal(Buffer.alloc(320), { status, env: {}, run: async (b, a) => { seen = a; return ""; } });
  const i = seen.indexOf("--prompt");
  assert.ok(i > 0, "a decoding prompt is passed");
  assert.match(seen[i + 1], /press enter/i, "it carries the command vocabulary");
  await transcribeLocal(Buffer.alloc(320), { status, prompt: "", run: async (b, a) => { seen = a; return ""; } });
  assert.equal(seen.includes("--prompt"), false, "an empty prompt disables the bias");
});

test("non-speech markers never become a transcript", async () => {
  const status = { ready: true, reason: "ready", binary: "w", model: "m", tier: "fast" };
  const r = await transcribeLocal(Buffer.alloc(3200), { status, run: async () => " (crickets chirping)" });
  assert.equal(r.transcript, "", "a tone transcribes to nothing, not to a noise label");
});

test("engine failure is reported, never silently blank", async () => {
  const r = await transcribeLocal(Buffer.alloc(3200), {
    status: { ready: true, reason: "ready", binary: "w", model: "m", tier: "fast" },
    run: async () => { throw new Error("whisper-cli: model load failed"); }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /model load failed/);
  assert.equal(r.transcript, "");
});

test("model tiers exist and default to a fast, multilingual choice", () => {
  assert.deepEqual(Object.keys(MODEL_TIERS), ["fast", "balanced", "accurate"]);
  assert.equal(modelTier({}), "balanced");
  assert.equal(modelTier({ ARTEMIS_STT_TIER: "fast" }), "fast");
  assert.equal(modelTier({ ARTEMIS_STT_TIER: "nonsense" }), "balanced", "an unknown tier falls back safely");
  assert.match(modelPath({ ARTEMIS_DATA_DIR: "/data" }), /^\/data\/models\/whisper\/ggml-base\.bin$/);
});
