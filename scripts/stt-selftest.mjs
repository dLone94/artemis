// Prove the local speech path end to end, with no microphone and no network.
//
// Synthesizes a short silent-but-valid PCM buffer, runs it through the SAME
// adapter the server uses, and reports the MEASURED numbers. It asserts the
// engine executes and returns cleanly — a tone has no words, so an empty
// transcript here is a pass, not a failure.
//
//   node scripts/stt-selftest.mjs [modelPath]
import { transcribeLocal, localSttStatus, setupHint, SAMPLE_RATE } from "../providers/sttLocal.js";

const modelPath = process.argv[2];
if (modelPath) process.env.ARTEMIS_STT_MODEL_PATH = modelPath;

const status = localSttStatus();
if (!status.ready) {
  console.error(`local STT not ready: ${status.reason}`);
  console.error(setupHint(status));
  process.exit(1);
}
console.log(`engine ${status.binary}\nmodel  ${status.model} (${status.tier})`);

// One second of a quiet 440 Hz tone — valid audio, no speech.
const frames = SAMPLE_RATE;
const pcm = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i += 1) {
  pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 1200), i * 2);
}

const result = await transcribeLocal(pcm, { language: "en" });
if (!result.ok) {
  console.error(`engine failed: ${result.error}`);
  process.exit(1);
}
console.log(
  `ok · audio ${result.audioSec}s · transcribe ${result.msElapsed}ms · realtime x${result.realtime}` +
  (result.transcript ? `\ntranscript: ${result.transcript}` : "\ntranscript: (none — tone has no speech, as expected)")
);
