// Local speech-to-text: whisper.cpp on Apple Silicon, entirely on this machine.
//
// Why whisper.cpp over the alternatives: it is a single self-contained native
// binary with GGML model files (no Python runtime, no venv, no pip resolution
// at install time), it is MIT-licensed so it can ship inside a commercial
// Artemis build, it uses Metal/Accelerate on M-series out of the box, and its
// model files are plain data we can place in a predictable Artemis directory.
// MLX-Whisper needs a Python environment; Apple's on-device SFSpeechRecognizer
// would only work inside the Swift shell and asks for a separate TCC grant,
// so neither survives headless operation.
//
// AUDIO CONTRACT — the one format that crosses this boundary:
//   16 kHz · mono · signed 16-bit little-endian PCM (linear16)
// The browser decodes and resamples once with Web Audio (offline-capable) and
// posts raw PCM; this module frames it with a 44-byte WAV header and hands it
// to the binary. No ffmpeg, no transcode, no second encode — the same encoding
// the native live-dictation path already speaks.
//
// Every process call is injected (opts.run / opts.exists) so the whole adapter
// is unit-testable with no binary, no model and no audio hardware.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;

/** Model tiers. Daily voice control wants speed, not benchmark accuracy. */
export const MODEL_TIERS = Object.freeze({
  fast: "ggml-tiny.bin",       // ~75 MB  — snappiest, fine for short commands
  balanced: "ggml-base.bin",   // ~148 MB — the default: multilingual, still quick
  accurate: "ggml-small.bin"   // ~488 MB — when accuracy matters more than latency
});
export const DEFAULT_TIER = "balanced";

// Decoding bias. whisper takes a prior-context prompt; feeding it the words
// Artemis actually hears fixes the misreads that matter — measured on this
// machine, "Type one and press enter" decoded as "Type 1 in press center"
// without it and "Type one, press enter" with it. Costs ~100ms; worth it,
// because a wrong verb is a wrong action. Override with ARTEMIS_STT_PROMPT="".
export const COMMAND_PROMPT =
  "Artemis voice commands: open Terminal, open System Settings, press enter, " +
  "type one, pick the second option, run the tests, tell Claude yes, " +
  "show yourself, minimize yourself, go offline, check my email, read the second one.";

/** Where Artemis keeps local models — predictable, overridable, never scattered. */
export function modelDir(env = process.env) {
  const explicit = String(env.ARTEMIS_STT_MODEL_DIR || "").trim();
  if (explicit) return explicit;
  const data = String(env.ARTEMIS_DATA_DIR || "").trim();
  return data ? join(data, "models", "whisper") : join(homedir(), ".artemis", "models", "whisper");
}

/** The whisper.cpp binary: an explicit path wins, else whatever is on PATH. */
export function binaryPath(env = process.env) {
  return String(env.ARTEMIS_STT_BINARY || "").trim() || "whisper-cli";
}

export function modelTier(env = process.env) {
  const tier = String(env.ARTEMIS_STT_TIER || DEFAULT_TIER).trim().toLowerCase();
  return MODEL_TIERS[tier] ? tier : DEFAULT_TIER;
}

export function modelPath(env = process.env) {
  const explicit = String(env.ARTEMIS_STT_MODEL_PATH || "").trim();
  if (explicit) return explicit;
  return join(modelDir(env), MODEL_TIERS[modelTier(env)]);
}

/**
 * Is local STT actually usable RIGHT NOW? Checked before a voice session
 * starts, so a missing model surfaces as a setup state instead of a failed
 * utterance — and never as a surprise download mid-conversation.
 *
 * @returns {{ready: boolean, reason: string, binary: string, model: string, tier: string}}
 */
export function localSttStatus(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || existsSync;
  const which = opts.which || defaultWhich;
  const binary = binaryPath(env);
  const model = modelPath(env);
  const tier = modelTier(env);
  const haveBinary = binary.includes("/") ? exists(binary) : !!which(binary);
  if (!haveBinary) {
    return { ready: false, reason: "engine-missing", binary, model, tier };
  }
  if (!exists(model)) {
    return { ready: false, reason: "model-missing", binary, model, tier };
  }
  return { ready: true, reason: "ready", binary, model, tier };
}

function defaultWhich(cmd) {
  const dirs = String(process.env.PATH || "").split(":").filter(Boolean);
  return dirs.some((d) => existsSync(join(d, cmd)));
}

/** Human setup guidance — shown, never acted on automatically. */
export function setupHint(status) {
  if (!status || status.ready) return "";
  if (status.reason === "engine-missing") {
    return "Local speech needs whisper.cpp. Run: npm run setup:stt";
  }
  return `Local speech model not installed (${status.model}). Run: npm run setup:stt`;
}

/**
 * Wrap raw linear16 PCM in a minimal WAV container.
 * 44-byte canonical header — no dependency, no re-encode of the samples.
 */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE, channels = CHANNELS) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8);
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Seconds of audio in a linear16 buffer — for the real-time factor, measured. */
export function pcmDurationSec(pcm, sampleRate = SAMPLE_RATE, channels = CHANNELS) {
  const bytes = (pcm && pcm.length) || 0;
  return bytes / (sampleRate * channels * (BITS_PER_SAMPLE / 8));
}

/**
 * whisper.cpp prints timestamped lines: "[00:00:00.000 --> 00:00:02.000]  text".
 * Keep only the spoken text, drop its bracketed noise markers, join to one line.
 */
export function parseWhisperOutput(stdout) {
  const lines = String(stdout || "").split("\n");
  const parts = [];
  for (const line of lines) {
    const m = line.match(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/);
    const text = m ? m[1] : "";
    if (!text) continue;
    // whisper marks non-speech as (silence)/[BLANK_AUDIO]/♪ — never a transcript
    const cleaned = text
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/[♪♫]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) parts.push(cleaned);
  }
  return parts.join(" ").trim();
}

function runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: opts.timeout || 60000 },
      (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve(stdout);
      });
  });
}

/**
 * Transcribe linear16 PCM locally.
 *
 * @param {Buffer} pcm 16 kHz mono signed 16-bit LE
 * @param {{language?: string, threads?: number, env?: object, run?: Function, signal?: AbortSignal}} opts
 *   language: BCP-47-ish whisper code ("en", "bg"), or "auto" to let whisper
 *   detect — the multilingual models keep Bulgarian on the table.
 * @returns {Promise<{ok, transcript, provider, audioSec, msElapsed, realtime, error?}>}
 */
export async function transcribeLocal(pcm, opts = {}) {
  const env = opts.env || process.env;
  const run = opts.run || runFile;
  const status = opts.status || localSttStatus({ env });
  const audioSec = pcmDurationSec(pcm);
  const started = Date.now();

  if (!status.ready) {
    return {
      ok: false, transcript: "", provider: "local", audioSec, msElapsed: 0, realtime: null,
      error: status.reason, hint: setupHint(status)
    };
  }
  if (!pcm || !pcm.length) {
    return { ok: false, transcript: "", provider: "local", audioSec: 0, msElapsed: 0, realtime: null, error: "no-audio" };
  }

  const wavPath = join(tmpdir(), `artemis-stt-${process.pid}-${Date.now()}.wav`);
  try {
    await fs.writeFile(wavPath, pcmToWav(pcm));
    // Pinning the language skips detection — measured 0.16s vs 0.31s on the
    // same clip. English is the default; "auto" and explicit codes ("bg")
    // stay available for multilingual speech.
    const language = String(opts.language || env.ARTEMIS_STT_LANGUAGE || "en").trim();
    const args = [
      "-m", status.model,
      "-f", wavPath,
      "-nt",                                   // no timestamps in the plain output
      "-t", String(opts.threads || env.ARTEMIS_STT_THREADS || 4),
      "--no-prints"
    ];
    // "auto" means: let whisper detect. Anything else pins the language, which
    // is measurably faster because detection is skipped.
    if (language && language !== "auto") args.push("-l", language);
    else args.push("-l", "auto");
    const prompt = opts.prompt !== undefined
      ? opts.prompt
      : (env.ARTEMIS_STT_PROMPT !== undefined ? env.ARTEMIS_STT_PROMPT : COMMAND_PROMPT);
    if (prompt) args.push("--prompt", prompt);

    const stdout = await run(status.binary, args, { timeout: opts.timeout || 60000, signal: opts.signal });
    // -nt already strips timestamps; parseWhisperOutput also handles the
    // timestamped shape so either build behaves.
    const direct = String(stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\[/.test(l) && !/^whisper_/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // "(crickets chirping)", "[BLANK_AUDIO]", "♪" are whisper's non-speech
    // markers — never a transcript, on either output shape.
    const transcript = (parseWhisperOutput(stdout) || direct)
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/[♪♫]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const msElapsed = Date.now() - started;
    return {
      ok: true,
      transcript,
      provider: "local",
      audioSec: Number(audioSec.toFixed(3)),
      msElapsed,
      realtime: audioSec > 0 ? Number((msElapsed / 1000 / audioSec).toFixed(2)) : null
    };
  } catch (error) {
    return {
      ok: false,
      transcript: "",
      provider: "local",
      audioSec: Number(audioSec.toFixed(3)),
      msElapsed: Date.now() - started,
      realtime: null,
      error: String((error && error.message) || error).split("\n")[0].slice(0, 200)
    };
  } finally {
    fs.unlink(wavPath).catch(() => {}); // audio is ephemeral: never left on disk
  }
}
