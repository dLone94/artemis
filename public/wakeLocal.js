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
let inferBusy = false; // one inference at a time — overlap spirals CPU on slow devices
let micGen = 0;        // bumped by closeMic so an in-flight openMic knows it went stale

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
  // slide the 1280-sample frame into the rolling 2 s buffer
  audio.copyWithin(0, f.length);
  audio.set(f, BUF - f.length);
  filled = Math.min(BUF, filled + f.length);
  if (paused || filled < BUF) return;
  // run inference every ~3 frames (~240 ms) to keep CPU modest; never overlap
  // runs — if the device is slower than the cadence, piled-up inferences would
  // starve the CPU and lag the whole tab (iPhone especially)
  if (++sinceInfer < 3 || inferBusy) return;
  sinceInfer = 0;
  inferBusy = true;
  infer().then((score) => {
    if (!running || paused) return;
    if (score >= THRESHOLD && performance.now() - lastFire > COOLDOWN_MS) {
      lastFire = performance.now();
      onDetectCb && onDetectCb(score);
    }
  }).catch(() => {}).finally(() => { inferBusy = false; });
}

// Build the mic → worklet → analyser graph. Shared by start AND resume so the
// mic is always opened exactly one way. The (expensive) ONNX sessions are kept
// loaded across pauses — only the audio graph is torn down and rebuilt.
async function openMic() {
  // Build into LOCALS and only commit to the module globals at the end, gated
  // on micGen: if closeMic ran while we were awaiting (pause during a resume),
  // committing would leak a live mic that then fights the command recorder.
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
    const sink = c.createGain(); sink.gain.value = 0; n.connect(sink).connect(c.destination); // silent keep-alive
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
    try { if (c.state !== "closed") c.close(); } catch (e2) {}
    throw e;
  }
  micStream = stream; ctx = c; node = n;
  filled = 0; sinceInfer = 0;
}

// Fully release the mic + audio graph. track.stop() runs synchronously (before
// the awaited ctx.close()), so the device is freed for the command recorder the
// instant this is called — no two-streams-on-one-mic contention.
async function closeMic() {
  micGen++; // any in-flight openMic is now stale and will self-discard
  // detach the globals SYNCHRONOUSLY, then tear down the captured locals —
  // nothing this function awaits can touch state a concurrent openMic commits
  const n = node, s = micStream, c = ctx;
  node = null; micStream = null; ctx = null; filled = 0;
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
      paused = false; running = true;
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
  await closeMic();
}

// During her speech / command capture: FULLY release the mic (not just suspend)
// so the command recorder gets exclusive access to the device — two live
// getUserMedia streams on one mic can silence each other on some browsers.
export async function pauseLocalWake() {
  if (paused) return;
  paused = true;
  await closeMic();
}
export async function resumeLocalWake() {
  if (!running || !paused) return;
  paused = false;
  try { await ensureModels(); await openMic(); }         // reacquire mic + rebuild graph (sessions stay loaded)
  catch (e) { console.warn("openWakeWord resume failed:", e && e.message); }
}
export function localWakeRunning() { return running; }
