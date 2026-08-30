// Measure the front end against whisper.cpp on REAL speech — before vs after.
//
// It cannot walk across a room, so it does the honest next thing: takes real
// spoken audio and attenuates it to the levels a quiet voice or a distant
// speaker actually produces, optionally adds room noise, then transcribes the
// same clip twice — raw, and through the front end. The comparison is what
// matters; the absolute levels are stated so nobody mistakes this for a
// distance guarantee.
//
//   node scripts/voice-bench.mjs
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeLocal, localSttStatus, SAMPLE_RATE } from "../providers/sttLocal.js";
import { createAudioFrontEnd, PROFILES, rms } from "../public/audioFrontEnd.js";

const PHRASES = [
  "Hey Artemis",
  "Open Terminal",
  "Show yourself",
  "Pick the second option",
  "Type one and press enter",
  "What are those emails about",
  "Go offline",
  "Run the tests"
];

// Attenuation ladder. These are LEVELS, not distances — level is what the
// microphone actually sees, and it is what the front end can act on.
const CONDITIONS = [
  { label: "close normal", atten: 1.0, noise: 0.0 },
  { label: "quiet voice", atten: 0.18, noise: 0.0015 },
  { label: "whisper-level", atten: 0.06, noise: 0.0015 },
  { label: "distant (low SNR)", atten: 0.08, noise: 0.006 }
];

const run = (file, args) => new Promise((res, rej) =>
  execFile(file, args, { maxBuffer: 1 << 24 }, (e, so) => (e ? rej(e) : res(so))));

async function sayToPcm(text) {
  const wav = join(tmpdir(), `bench-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  await run("/usr/bin/say", ["-o", wav, "--data-format=LEI16@16000", text]);
  const buf = await fs.readFile(wav);
  await fs.unlink(wav).catch(() => {});
  const pcm = buf.subarray(44);
  const f = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f.length; i += 1) f[i] = pcm.readInt16LE(i * 2) / 32768;
  return f;
}

function degrade(samples, atten, noiseLevel) {
  const out = new Float32Array(samples.length);
  let seed = 12345;                     // deterministic "room noise"
  for (let i = 0; i < samples.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed / 0x7fffffff) * 2 - 1) * noiseLevel;
    out[i] = samples[i] * atten + n;
  }
  return out;
}

function toPcmBuffer(f) {
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i += 1) {
    const v = Math.max(-1, Math.min(1, f[i]));
    b.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return b;
}

function throughFrontEnd(samples, profileName) {
  const fe = createAudioFrontEnd({ profile: profileName });
  if (profileName) fe.setOverride(profileName);
  const out = new Float32Array(samples.length);
  const FRAME = 512;
  let speechFrames = 0;
  for (let i = 0; i < samples.length; i += FRAME) {
    const frame = samples.slice(i, Math.min(i + FRAME, samples.length));
    const info = fe.process(frame);
    if (info.speech) speechFrames += 1;
    out.set(frame, i);
  }
  return { audio: out, diag: fe.diagnostics(), speechFrames };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
/** Word-level accuracy: how much of what was said actually came back. */
function wordAccuracy(expected, got) {
  const e = norm(expected).split(" ").filter(Boolean);
  const g = new Set(norm(got).split(" ").filter(Boolean));
  if (!e.length) return 0;
  return e.filter((w) => g.has(w)).length / e.length;
}

const status = localSttStatus();
if (!status.ready) {
  console.error("local STT not ready — run: npm run setup:stt");
  process.exit(1);
}
console.log(`model ${status.model} (${status.tier})\n`);

const totals = {};
for (const cond of CONDITIONS) {
  let rawAcc = 0, feAcc = 0, n = 0, rawMs = 0, feMs = 0;
  console.log(`── ${cond.label}  (atten ${cond.atten}, noise ${cond.noise})`);
  for (const phrase of PHRASES) {
    const clean = await sayToPcm(phrase);
    const degraded = degrade(clean, cond.atten, cond.noise);
    const inRms = rms(degraded);

    const before = await transcribeLocal(toPcmBuffer(degraded), { language: "en" });
    const { audio, diag, speechFrames } = throughFrontEnd(degraded);
    const after = await transcribeLocal(toPcmBuffer(audio), { language: "en" });

    const a1 = wordAccuracy(phrase, before.transcript);
    const a2 = wordAccuracy(phrase, after.transcript);
    rawAcc += a1; feAcc += a2; n += 1;
    rawMs += before.msElapsed || 0; feMs += after.msElapsed || 0;
    const mark = a2 > a1 ? "↑" : a2 < a1 ? "↓" : "=";
    console.log(
      `  ${mark} "${phrase}"  rms=${inRms.toFixed(4)} snr=${diag.snrDb}dB gain=${diag.gain}x ` +
      `prof=${diag.profile} speech=${speechFrames}f\n` +
      `      raw  ${(a1 * 100).toFixed(0)}%  "${before.transcript}"\n` +
      `      fe   ${(a2 * 100).toFixed(0)}%  "${after.transcript}"`
    );
  }
  totals[cond.label] = {
    raw: (rawAcc / n * 100).toFixed(1),
    fe: (feAcc / n * 100).toFixed(1),
    rawMs: Math.round(rawMs / n),
    feMs: Math.round(feMs / n)
  };
  console.log("");
}

console.log("── SUMMARY (word accuracy, mean over 8 real phrases)");
for (const [label, t] of Object.entries(totals)) {
  console.log(`  ${label.padEnd(20)} raw ${String(t.raw).padStart(5)}%  →  front-end ${String(t.fe).padStart(5)}%   (${t.rawMs}ms → ${t.feMs}ms)`);
}
