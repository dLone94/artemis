// Local, on-device wake word via openWakeWord (ONNX Runtime Web / WASM).
// Detects "Hey Jarvis" entirely in the browser — reliable, private (no audio
// leaves the device), no account/key, and works on any browser INCLUDING
// iPhone Safari (where the built-in speech recognizer doesn't exist).
//
// Pipeline (openWakeWord): 16 kHz audio → melspectrogram.onnx → 16 sliding
// embeddings (embedding_model.onnx, 76-frame window, step 8) → hey_jarvis
// classifier → score. We recompute on a ~2 s rolling window each tick, which is
// simpler and less bug-prone than incremental buffering. Model I/O names are
// read from the sessions so tensor shapes can never drift.
//
// CRUCIALLY, this engine also CAPTURES THE COMMAND itself (captureCommand):
// the same mic stream that heard "Hey Jarvis" keeps flowing into a command
// buffer — including ~1.2 s of PRE-ROLL from before detection fired. The old
// design closed this mic and had MediaRecorder open a new one, and the words
// spoken during that handoff (plus the detection latency) were simply never
// recorded. One mic, zero gap, and the result is a plain 16 kHz WAV for batch
// STT — no MediaRecorder, no chunk streaming, no ordering hazards.

import { resolveWakeProfile, FALLBACK_PROFILE } from "./wakeProfile.js";

let ort = null;
let melSess = null, embSess = null, wwSess = null;
let ctx = null, node = null, micStream = null;
let keepAlive = null;   // silent sink — see openMic
let running = false, loading = null;
let mode = "detect"; // "detect" | "capture" | "idle" (idle: her speech — keep mic, don't listen)
let onDetectCb = null;
let lastFire = 0;

// Detection thresholds come from the active wake profile — a custom model has
// its own operating point, chosen from its ROC, and hardcoding one here is how
// the UI and the engine drift apart. These are the fallback's values until the
// profile resolves.
let profile = FALLBACK_PROFILE;
const THRESHOLD = () => profile.threshold;
const COOLDOWN_MS = () => profile.cooldownMs || 2000;   // one utterance = one trigger
/** The verified profile currently driving detection (phrase, threshold, id). */
export function activeWakeProfile() { return profile; }
const BUF = 32000;          // 2 s of 16 kHz audio (≥196 mel frames)
const audio = new Float32Array(BUF);
let filled = 0;
let sinceInfer = 0;
let inferBusy = false; // one inference at a time — overlap spirals CPU on slow devices
let micGen = 0;        // bumped by closeMic so an in-flight openMic knows it went stale

// ambient noise floor (RMS), learned continuously while in detect mode so the
// command endpointer adapts to the room instead of using a magic constant
let noiseFloor = 0.004;

// command-capture state
let capBuf = [], capLen = 0, capStart = 0, capHeard = false, capQuiet = 0;
let capResolve = null, capSafety = 0, capOnLevel = null;
const CAP_SILENCE_MS = 1100;  // this much quiet after speech = you finished
const CAP_NOSPEECH_MS = 4500; // never spoke → give up
const CAP_MAX_MS = 12000;     // hard cap per command
const PREROLL_MS = 1200;      // audio kept from BEFORE detection fired
let capWaitForSpeechMs = CAP_NOSPEECH_MS;

function rmsOf(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

function loadOrt() {
  return new Promise((resolve, reject) => {
    if (window.ort) return resolve(window.ort);
    const s = document.createElement("script");
    s.src = "/oww/ort.min.js";
    s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error("ort global missing")));
    s.onerror = () => reject(new Error("failed to load ort.min.js"));
    document.head.appendChild(s);
  });
}

async function ensureModels() {
  if (wwSess) return;
  // Resolve and hash-verify the wake profile BEFORE loading anything. If the
  // active profile doesn't check out this rolls back to the shipped Jarvis model
  // rather than starting recognition with an unverified classifier.
  const resolved = await resolveWakeProfile();
  profile = resolved.profile;
  if (resolved.fellBack && resolved.reason) console.warn("wake profile rolled back:", resolved.reason);

  ort = await loadOrt();
  ort.env.wasm.wasmPaths = "/oww/";
  ort.env.wasm.numThreads = 1;   // no threads → no COOP/COEP header requirement
  ort.env.wasm.simd = true;
  ort.env.logLevel = "error";
  const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  // build sessions from the ALREADY VERIFIED bytes where we have them, so the
  // file can't change between the hash check and the load
  const src = (url) => (resolved.bytes && resolved.bytes[url] ? new Uint8Array(resolved.bytes[url]) : url);
  [melSess, embSess, wwSess] = await Promise.all([
    ort.InferenceSession.create(src("/oww/melspectrogram.onnx"), opt),
    ort.InferenceSession.create(src("/oww/embedding_model.onnx"), opt),
    ort.InferenceSession.create(src(profile.classifierUrl), opt),
  ]);
}

async function infer() {
  // melspectrogram of the whole rolling buffer
  const melIn = new ort.Tensor("float32", audio, [1, BUF]);
  const melOut = (await melSess.run({ [melSess.inputNames[0]]: melIn }))[melSess.outputNames[0]];
  const md = melOut.dims;
  const frames = md[md.length - 2];
  const nBins = 32; // openWakeWord melspectrograms are always 32 mel bins
  const mel = melOut.data; // flat [.. frames*32], normalize openWakeWord-style
  for (let k = 0; k < mel.length; k++) mel[k] = mel[k] / 10 + 2;
  if (frames < 196) return 0; // not enough context yet
  const base = frames - 196;  // use the most recent 196 frames

  // 16 embeddings from 76-frame windows, step 8
  const embName = embSess.inputNames[0], embOutName = embSess.outputNames[0];
  const embs = new Float32Array(16 * 96);
  const win = new Float32Array(76 * nBins);
  for (let e = 0; e < 16; e++) {
    const start = base + e * 8;
    for (let f = 0; f < 76; f++) {
      const src = (start + f) * nBins;
      win.set(mel.subarray(src, src + nBins), f * nBins);
    }
    const embT = new ort.Tensor("float32", win, [1, 76, nBins, 1]);
    const out = (await embSess.run({ [embName]: embT }))[embOutName];
    embs.set(out.data, e * 96); // out is [1,1,1,96]
  }

  // classifier → score
  const wwT = new ort.Tensor("float32", embs, [1, 16, 96]);
  const wwOut = (await wwSess.run({ [wwSess.inputNames[0]]: wwT }))[wwSess.outputNames[0]];
  return wwOut.data[0];
}

function pushFrame(f) {
  // always slide the 1280-sample frame into the rolling 2 s buffer — it feeds
  // detection AND the command pre-roll, so it must stay fresh in every mode
  audio.copyWithin(0, f.length);
  audio.set(f, BUF - f.length);
  filled = Math.min(BUF, filled + f.length);

  const rms = rmsOf(f);
  window.__wakeDebug = { mode, rms, floor: noiseFloor, t: performance.now() }; // test-page telemetry

  if (mode === "capture") { captureFrame(f, rms); return; }
  if (mode !== "detect" || filled < BUF) return;

  // learn the room's noise floor from quiet detect-mode frames
  if (rms < noiseFloor * 4) noiseFloor = Math.max(0.0015, noiseFloor * 0.95 + rms * 0.05);

  // run inference every ~3 frames (~240 ms) to keep CPU modest; never overlap
  // runs — if the device is slower than the cadence, piled-up inferences would
  // starve the CPU and lag the whole tab (iPhone especially)
  if (++sinceInfer < 3 || inferBusy) return;
  sinceInfer = 0;
  inferBusy = true;
  infer().then((score) => {
    if (window.__wakeDebug) window.__wakeDebug.score = score;
    if (!running || mode !== "detect") return;
    if (score >= THRESHOLD() && performance.now() - lastFire > COOLDOWN_MS()) {
      lastFire = performance.now();
      onDetectCb && onDetectCb(score);
    }
  }).catch(() => {}).finally(() => { inferBusy = false; });
}

// ---- command capture (the engine's own recorder) ----

function captureFrame(f, rms) {
  capBuf.push(f.slice(0));
  capLen += f.length;
  capOnLevel && capOnLevel(rms);
  const now = performance.now();
  const dur = now - capStart;
  const speechThresh = Math.max(noiseFloor * 3.5, 0.010); // adapts to the room
  if (rms > speechThresh) { capHeard = true; capQuiet = 0; }
  else if (capHeard && !capQuiet) capQuiet = now;
  if ((capHeard && capQuiet && now - capQuiet > CAP_SILENCE_MS) ||
      (!capHeard && dur > capWaitForSpeechMs) ||
      dur > CAP_MAX_MS) {
    finishCapture(capHeard);
  }
}

function finishCapture(gotSpeech) {
  const resolve = capResolve;
  capResolve = null;
  if (capSafety) { clearTimeout(capSafety); capSafety = 0; }
  mode = "idle"; // caller decides when to re-arm detection (resumeLocalWake)
  const bufs = capBuf, len = capLen;
  capBuf = []; capLen = 0; capOnLevel = null;
  if (!resolve) return;
  resolve(gotSpeech && len > 0 ? encodeWav(bufs, len) : null);
}

// 16 kHz mono 16-bit PCM WAV — universally accepted by Deepgram's batch API
function encodeWav(bufs, len) {
  const out = new DataView(new ArrayBuffer(44 + len * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + len * 2, true); w(8, "WAVE");
  w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, len * 2, true);
  let o = 44;
  for (const b of bufs) {
    for (let i = 0; i < b.length; i++) {
      const v = Math.max(-1, Math.min(1, b[i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

// Start capturing the command NOW (call from the wake callback). Includes
// PREROLL_MS of audio from before this call — the words you spoke while
// detection was still deciding are already in the recording. Resolves with a
// WAV blob, or null if you never spoke. Leaves the engine in "idle" (won't
// hear her answer); resumeLocalWake() re-arms detection.
export function captureCommand(opts = {}) {
  if (!running) return Promise.resolve(null);
  if (capResolve) return Promise.resolve(null); // already capturing
  return new Promise((resolve) => {
    const pre = Math.min(filled, Math.round((opts.preRollMs ?? PREROLL_MS) * 16));
    capBuf = pre > 0 ? [audio.slice(BUF - pre)] : [];
    capLen = pre;
    capStart = performance.now();
    capHeard = false; capQuiet = 0;
    capWaitForSpeechMs = opts.waitForSpeechMs ?? CAP_NOSPEECH_MS;
    capOnLevel = opts.onLevel || null;
    capResolve = resolve;
    mode = "capture";
    // if the mic/worklet dies mid-capture, frames stop arriving and the VAD
    // above never runs again — this backstop guarantees the promise settles
    capSafety = setTimeout(() => finishCapture(capHeard), CAP_MAX_MS + 2000);
  });
}

// ---- mic plumbing ----

async function openMic() {
  // Build into LOCALS and only commit to the module globals at the end, gated
  // on micGen: if closeMic ran while we were awaiting (a stop during startup),
  // committing would leak a live mic.
  const g = micGen;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  });
  const c = new (window.AudioContext || window.webkitAudioContext)();
  let n = null;
  try {
    await c.audioWorklet.addModule("/oww/mic-worklet.js");
    if (g !== micGen) throw new Error("superseded"); // closed while opening — discard
    const src = c.createMediaStreamSource(stream);
    n = new AudioWorkletNode(c, "mic-downsampler");
    n.port.onmessage = (e) => pushFrame(e.data);
    src.connect(n);
    // Keep-alive: a worklet with nothing downstream can stop being pulled, so it
    // needs a destination. It must NOT be c.destination — that is the speakers,
    // and routing the mic there (even at zero gain) keeps the output device and
    // its DAC powered for as long as the wake word is listening, which on Apple
    // silicon is audible as a constant faint buzz. A MediaStreamDestination
    // pulls the graph just the same and never touches the speakers.
    const sink = c.createGain(); sink.gain.value = 0;
    keepAlive = c.createMediaStreamDestination();
    n.connect(sink).connect(keepAlive);
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
    try { if (c.state !== "closed") c.close(); } catch (e2) {}
    throw e;
  }
  micStream = stream; ctx = c; node = n;
  filled = 0; sinceInfer = 0;
}

async function closeMic() {
  micGen++; // any in-flight openMic is now stale and will self-discard
  // detach the globals SYNCHRONOUSLY, then tear down the captured locals —
  // nothing this function awaits can touch state a concurrent openMic commits
  const n = node, s = micStream, c = ctx;
  node = null; micStream = null; ctx = null; keepAlive = null; filled = 0;
  try { n && (n.port.onmessage = null); n && n.disconnect(); } catch (e) {}
  try { s && s.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { if (c && c.state !== "closed") await c.close(); } catch (e) {}
}

export async function startLocalWake(_cfg, onDetect) {
  if (running) return true;
  if (loading) return loading;
  onDetectCb = onDetect;
  loading = (async () => {
    try {
      await ensureModels();
      await openMic();
      mode = "detect"; running = true;
      return true;
    } catch (e) {
      console.warn("openWakeWord failed to start — falling back:", e && e.message);
      await stopLocalWake();
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export async function stopLocalWake() {
  running = false; mode = "idle";
  if (capResolve) finishCapture(false); // never leave a caller hanging
  await closeMic();
}

// During her speech: stop LISTENING but KEEP the mic + audio graph. Releasing
// and re-acquiring the device between every turn was the source of a whole
// family of handoff races; a held-open mic with detection gated off is inert
// (echoCancellation keeps her own voice from re-triggering the wake word).
export function pauseLocalWake() {
  if (mode === "capture") return; // never yank an in-flight command capture
  mode = "idle";
}
export function resumeLocalWake() {
  if (!running || mode === "capture") return;
  filled = 0; sinceInfer = 0; // refill the window before re-arming (no stale trigger)
  mode = "detect";
}
export function localWakeRunning() { return running; }
