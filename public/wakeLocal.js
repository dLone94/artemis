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

let ort = null;
let melSess = null, embSess = null, wwSess = null;
let ctx = null, node = null, micStream = null;
let running = false, paused = false, loading = null;
let onDetectCb = null;
let lastFire = 0;

const THRESHOLD = 0.5;      // hey_jarvis fires reliably around here
const COOLDOWN_MS = 2000;   // one utterance = one trigger
const BUF = 32000;          // 2 s of 16 kHz audio (≥196 mel frames)
const audio = new Float32Array(BUF);
let filled = 0;
let sinceInfer = 0;

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
  ort = await loadOrt();
  ort.env.wasm.wasmPaths = "/oww/";
  ort.env.wasm.numThreads = 1;   // no threads → no COOP/COEP header requirement
  ort.env.wasm.simd = true;
  ort.env.logLevel = "error";
  const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  [melSess, embSess, wwSess] = await Promise.all([
    ort.InferenceSession.create("/oww/melspectrogram.onnx", opt),
    ort.InferenceSession.create("/oww/embedding_model.onnx", opt),
    ort.InferenceSession.create("/oww/hey_jarvis_v0.1.onnx", opt),
  ]);
}

async function infer() {
  // melspectrogram of the whole rolling buffer
  const melIn = new ort.Tensor("float32", audio, [1, BUF]);
  const melOut = (await melSess.run({ [melSess.inputNames[0]]: melIn }))[melSess.outputNames[0]];
  const md = melOut.dims;
  const frames = md[md.length - 2], bins = md[md.length - 2] === 32 ? md[md.length - 1] : 32; // 32 mel bins
  const nBins = 32;
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
  // slide the 1280-sample frame into the rolling 2 s buffer
  audio.copyWithin(0, f.length);
  audio.set(f, BUF - f.length);
  filled = Math.min(BUF, filled + f.length);
  if (paused || filled < BUF) return;
  // run inference every ~3 frames (~240 ms) to keep CPU modest
  if (++sinceInfer < 3) return;
  sinceInfer = 0;
  infer().then((score) => {
    if (!running || paused) return;
    if (score >= THRESHOLD && performance.now() - lastFire > COOLDOWN_MS) {
      lastFire = performance.now();
      onDetectCb && onDetectCb(score);
    }
  }).catch(() => {});
}

export async function startLocalWake(_cfg, onDetect) {
  if (running) return true;
  if (loading) return loading;
  onDetectCb = onDetect;
  loading = (async () => {
    try {
      await ensureModels();
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.audioWorklet.addModule("/oww/mic-worklet.js");
      const src = ctx.createMediaStreamSource(micStream);
      node = new AudioWorkletNode(ctx, "mic-downsampler");
      node.port.onmessage = (e) => pushFrame(e.data);
      src.connect(node);
      // keep the graph alive without audible output
      const sink = ctx.createGain(); sink.gain.value = 0; node.connect(sink).connect(ctx.destination);
      filled = 0; sinceInfer = 0; paused = false; running = true;
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
  running = false; paused = false;
  try { node && (node.port.onmessage = null); node && node.disconnect(); } catch (e) {}
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { ctx && ctx.state !== "closed" && (await ctx.close()); } catch (e) {}
  node = null; micStream = null; ctx = null; filled = 0;
}

// During her speech / command capture: stop analysing (and free the mic tap) so
// it can't hear her voice or fight the recorder; resume re-opens it.
export function pauseLocalWake() { paused = true; try { ctx && ctx.suspend(); } catch (e) {} }
export function resumeLocalWake() {
  if (!running) return;
  paused = false; filled = 0; sinceInfer = 0; // refill before re-arming (avoid stale trigger)
  try { ctx && ctx.resume(); } catch (e) {}
}
export function localWakeRunning() { return running; }
