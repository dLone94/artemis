// ARTEMIS INTELLIGENCE CORE — the hero visualization.
//
// NAMING: the class, the module, window.__artemisAmp and every storage key stay
// ARTEMIS on purpose — they are technical contracts with main.js, cockpit.js,
// celebration.js and dashboardV2.js. The user-facing identity is ARTEMIS too.
// test/identity.test.mjs enforces that contract.
//
// It is a DROP-IN for the retired VoiceOrb: setStatus/feed/resize/ignite/
// moonInfoAt/toolEvent/_ensureAudio/connectMic/connectMediaElement/stopAudio/
// status/cur.amp/reduced all behave as before, so nothing else had to change.
//
// WHAT IT DRAWS IS NOT DECIDED HERE. coreState.js maps real application state
// (voice status, SSE tool lifecycle, the confirm gate) to a view model; this
// file renders that view model and holds no opinion about what Eve is doing.
//
// Five depth layers, back to front:
//   5. ambient field      sparse fragments, parallax drift
//   3. orbital system     independent computation tracks
//   4. intelligence traffic packets travelling Core <-> capability
//   2. neural iris        segmented aperture, amplitude-driven
//   1. nucleus            dark glass lens, filaments, perimeter energy
//
// Performance: geometry is precomputed; traffic and wave systems use fixed-size
// typed-array pools; the render loop does not grow collections under load.

import { PAL, prefersReducedMotion, ring, arcs, ticks } from "./orbShared.js";
import { CAPABILITIES, capabilityForFamily } from "./coreCapabilities.js";
import { deriveCoreState } from "./coreState.js";

const TAU = Math.PI * 2;
const N = CAPABILITIES.length;

// Radii as a fraction of the Core radius R. The mechanism (nucleus + iris)
// deliberately occupies far more of the frame than the previous version, where
// a small nucleus sat inside mostly-empty rings.
// Measured against the flat predecessor (R 0.42, nucleus 0.30R): this puts the
// nucleus at 1.45x its old radius (2.1x area) and the dense mechanism — the
// nucleus plus the iris, which is what the eye actually reads as "the Core" —
// at 2.4x. test/artemisCore.test.mjs pins the ratio so it cannot drift back.
export const CORE_GEOMETRY = Object.freeze({
  nucleus: 0.22,
  irisInner: 0.25,
  irisOuter: 0.34,
  trackA: 0.58,
  trackB: 0.70,
  trackC: 0.82,
  nodes: 0.96
});
const R_NUCLEUS = CORE_GEOMETRY.nucleus;
const R_IRIS_IN = CORE_GEOMETRY.irisInner;
const R_IRIS_OUT = CORE_GEOMETRY.irisOuter;
const R_TRACK_A = CORE_GEOMETRY.trackA;
const R_TRACK_B = CORE_GEOMETRY.trackB;
const R_TRACK_C = CORE_GEOMETRY.trackC;
const R_NODES = CORE_GEOMETRY.nodes;

// Capability labels live INSIDE the node ring. Outside, long labels
// ("FOLLOW-UPS") overflowed the stage on the horizontal axis, which is what
// forced the old Core to stay small. Inside, the Core can grow instead.
const LABEL_MIN_RADIUS = 150; // below this the ring is too small for text

// Track geometry: uneven on purpose. Evenly spaced segments read as decoration;
// uneven ones read as instrumentation.
const TRACK_A_SEGS = Object.freeze([[0.0, 1.05], [1.4, 2.0], [2.5, 3.7], [4.1, 4.6], [5.0, 6.0]]);
const TRACK_B_SEGS = Object.freeze([[0.3, 1.5], [1.9, 2.4], [3.1, 4.4], [4.9, 5.4]]);

const IRIS_SEGMENTS = 16;
const FILAMENTS = 7;
const NUCLEUS_MOTES = 9;
const FIELD_FRAGMENTS = 26;
const PACKET_POOL = 56;
const WAVE_POOL = 6;

const TONES = {
  calm:  { key: PAL.D,    accent: PAL.O,    node: PAL.O,    hot: PAL.B },
  live:  { key: PAL.B,    accent: PAL.Hl,   node: PAL.B,    hot: PAL.Hl },
  work:  { key: PAL.O,    accent: PAL.V,    node: PAL.B,    hot: PAL.V },
  hold:  { key: PAL.GOLD, accent: PAL.GOLD, node: PAL.GOLD, hot: PAL.GOLD },
  fault: { key: PAL.ERR,  accent: PAL.ERR,  node: PAL.ERR,  hot: PAL.ERR }
};

const IDLE_FPS = 12;
const REDUCED_VISUAL_INTERVAL = 400;

// Six legible presentation groups echo the approved reference while every
// real capability remains an individual, hit-testable activity node.
export const CORE_PRESENTATION_GROUPS = Object.freeze([
  Object.freeze({ title: "RESEARCH", nodes: Object.freeze([0, 10]), angle: -1.52, radius: 0.84, paint: PAL.B }),
  Object.freeze({ title: "COMMS", nodes: Object.freeze([1, 2, 7]), angle: -0.34, radius: 0.86, paint: PAL.MESSAGES }),
  Object.freeze({ title: "MEDIA", nodes: Object.freeze([3]), angle: 0.64, radius: 0.84, paint: PAL.GOLD }),
  Object.freeze({ title: "MEMORY", nodes: Object.freeze([4]), angle: 1.58, radius: 0.84, paint: PAL.V }),
  Object.freeze({ title: "FINANCE", nodes: Object.freeze([5, 8, 9]), angle: 2.48, radius: 0.86, paint: PAL.GOLD }),
  Object.freeze({ title: "BRIEF", nodes: Object.freeze([6]), angle: 3.42, radius: 0.84, paint: PAL.B })
]);

// The local material image owns the physical glass/metal chassis. Canvas adds
// only live state seams over it, avoiding a second superimposed mechanism.
const MECHANICAL_SEGS = Object.freeze([
  [0.03, 0.72], [0.82, 1.37], [1.49, 2.18], [2.28, 2.92],
  [3.05, 3.78], [3.9, 4.54], [4.67, 5.31], [5.43, 6.19]
]);

/** Deterministic hash-noise so precomputed geometry is stable across resizes. */
function noise(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class ArtemisCore {
  constructor(container, opts = {}) {
    this.container = container;
    this.reduced = prefersReducedMotion();
    this.status = "idle";
    this.cur = { amp: 0 };
    this.audioCtx = null;
    this.analyser = null;
    this.freq = null;

    this._disposed = false;
    this._raf = 0;
    this._elapsed = 0;
    this._lastFrame = 0;
    this._lastDraw = 0;
    this._manualAmp = 0;
    this._audioActive = false;
    this._synthSpeak = false;
    this._micStream = null;
    this.srcNode = null;

    // Real state feeding the view model.
    this._tool = null;
    this._activeTools = [];
    this._pendingConfirm = false;
    this._stage = "";
    this._errorText = "";
    this.view = deriveCoreState({ status: "idle" });

    // ---- eased visual mixes (inertia: nothing snaps) ----
    this._energy = 0.12;
    this._listenMix = 0;
    this._workMix = 0;
    this._holdMix = 0;
    this._faultMix = 0;
    this._irisOpen = 0.12;
    this._ampSlow = 0;      // slow follower, for breathing
    this._ampFast = 0;      // fast follower, for transients
    this._igniteAt = -1;

    // ---- capability nodes ----
    this._nodeLevel = new Float32Array(N);
    this._nodeTarget = new Float32Array(N);
    this._nodeResult = new Int8Array(N);
    this._nodeTimers = new Array(N).fill(0);
    this._nodeRuns = new Uint16Array(N);
    this._nodeOutcome = new Int8Array(N);
    this._nodeAngle = new Float32Array(N);
    this._nodeCos = new Float32Array(N);
    this._nodeSin = new Float32Array(N);
    this._nodeX = new Float32Array(N);
    this._nodeY = new Float32Array(N);
    this._activeNode = -1;
    this._lastReducedVisualAt = -Infinity;
    this._hitCenterX = null;
    this._hitCenterY = null;

    // ---- LAYER 4: intelligence traffic (fixed pool, zero per-frame alloc) ----
    this._pkNode = new Int8Array(PACKET_POOL).fill(-1);
    this._pkDir = new Int8Array(PACKET_POOL);
    this._pkT = new Float32Array(PACKET_POOL);
    this._pkSpeed = new Float32Array(PACKET_POOL);
    this._pkKind = new Int8Array(PACKET_POOL);
    this._emitAccum = 0;

    // ---- LISTENING wave propagation ----
    this._waveR = new Float32Array(WAVE_POOL);
    this._waveLife = new Float32Array(WAVE_POOL);
    this._waveArmed = true;

    this._buildGeometry();

    this.canvas = document.createElement("canvas");
    this.canvas.className = "core-canvas";
    this.ctx = this.canvas.getContext("2d");
    container.appendChild(this.canvas);

    this._boundLoop = this._loop.bind(this);
    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    this._onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      } else if (!this.reduced && !this._raf) {
        this._lastFrame = performance.now();
        this._loop();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    this.resize();
    if (!this.reduced) this._loop();
  }

  /** Geometry that never depends on pixel size — computed once, reused. */
  _buildGeometry() {
    for (let i = 0; i < N; i++) {
      const a = -Math.PI / 2 + (i / N) * TAU;
      this._nodeAngle[i] = a;
      this._nodeCos[i] = Math.cos(a);
      this._nodeSin[i] = Math.sin(a);
    }

    // LAYER 2 — iris segments: asymmetric gaps, varying radius, own speeds.
    this._irisBase = new Float32Array(IRIS_SEGMENTS);
    this._irisSpan = new Float32Array(IRIS_SEGMENTS);
    this._irisRad = new Float32Array(IRIS_SEGMENTS);
    this._irisSpeed = new Float32Array(IRIS_SEGMENTS);
    for (let i = 0; i < IRIS_SEGMENTS; i++) {
      const slot = (i / IRIS_SEGMENTS) * TAU;
      this._irisBase[i] = slot + noise(i, 1) * 0.16;
      // Asymmetric: each blade covers a different share of its slot.
      this._irisSpan[i] = (TAU / IRIS_SEGMENTS) * (0.42 + noise(i, 2) * 0.36);
      this._irisRad[i] = noise(i, 3);                      // 0..1 radius lerp
      this._irisSpeed[i] = 0.5 + noise(i, 4) * 1.4;        // own drift rate
    }

    // LAYER 1 — nucleus filaments + motes.
    this._filPhase = new Float32Array(FILAMENTS);
    this._filRad = new Float32Array(FILAMENTS);
    this._filSpeed = new Float32Array(FILAMENTS);
    for (let i = 0; i < FILAMENTS; i++) {
      this._filPhase[i] = noise(i, 5) * TAU;
      this._filRad[i] = 0.3 + noise(i, 6) * 0.62;
      this._filSpeed[i] = (0.1 + noise(i, 7) * 0.28) * (noise(i, 8) > 0.5 ? 1 : -1);
    }
    this._moteA = new Float32Array(NUCLEUS_MOTES);
    this._moteR = new Float32Array(NUCLEUS_MOTES);
    this._moteS = new Float32Array(NUCLEUS_MOTES);
    for (let i = 0; i < NUCLEUS_MOTES; i++) {
      this._moteA[i] = noise(i, 9) * TAU;
      this._moteR[i] = 0.2 + noise(i, 10) * 0.6;
      this._moteS[i] = (0.15 + noise(i, 11) * 0.5) * (noise(i, 12) > 0.5 ? 1 : -1);
    }

    // LAYER 5 — ambient field fragments.
    this._fragA = new Float32Array(FIELD_FRAGMENTS);
    this._fragR = new Float32Array(FIELD_FRAGMENTS);
    this._fragLen = new Float32Array(FIELD_FRAGMENTS);
    this._fragSpeed = new Float32Array(FIELD_FRAGMENTS);
    this._fragKind = new Int8Array(FIELD_FRAGMENTS);
    for (let i = 0; i < FIELD_FRAGMENTS; i++) {
      this._fragA[i] = noise(i, 13) * TAU;
      // Parallax: fragments live outside the mechanism, at varied depth.
      this._fragR[i] = 0.62 + noise(i, 14) * 0.5;
      this._fragLen[i] = 0.012 + noise(i, 15) * 0.045;
      this._fragSpeed[i] = (0.006 + noise(i, 16) * 0.03) * (noise(i, 17) > 0.5 ? 1 : -1);
      this._fragKind[i] = noise(i, 18) > 0.72 ? 1 : 0; // 1 = dot, 0 = dash
    }
  }

  // ---- public API (VoiceOrb-compatible) ------------------------------------

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w;
    this._h = h;
    // Bounded by the SHORTER axis, so a wide window makes margins rather than
    // letting the Core grow into the side panels. Larger than the previous
    // 0.42 because the labels moved inside the node ring.
    this._radius = Math.max(24, Math.min(w, h) * 0.48);
    this._gradKey = "";
    if (this.reduced) this._renderReducedSnapshot();
  }

  setStatus(status) {
    if (typeof status !== "string" || status === this.status) return;
    this.status = status;
    this._refreshView();
    if (this.reduced) this._renderReducedSnapshot();
  }

  feed(amplitude) {
    const a = Number(amplitude);
    if (!Number.isFinite(a)) return;
    this._manualAmp = Math.max(this._manualAmp, Math.min(1, Math.max(0, a)));
    if (this.reduced) {
      this.cur.amp = this._manualAmp;
      window.__artemisAmp = this.cur.amp;
      const now = performance.now();
      if (now - this._lastReducedVisualAt >= REDUCED_VISUAL_INTERVAL) {
        this._lastReducedVisualAt = now;
        this._renderReducedSnapshot();
      }
    }
  }

  ignite() {
    if (this.reduced) return;
    this._igniteAt = this._elapsed;
  }

  moonInfoAt(x, y) {
    if (this._hitCenterX == null) return null;
    let best = -1;
    let bestD = 22 * 22;
    for (let i = 0; i < N; i++) {
      const dx = x - (this._hitCenterX + this._nodeX[i]);
      const dy = y - (this._hitCenterY + this._nodeY[i]);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? { index: best, ...CAPABILITIES[best] } : null;
  }

  /**
   * Real tool lifecycle: {name, family, phase, ok}.
   * start -> opens an OUTBOUND relationship to the owning capability.
   * end   -> fires an INBOUND return burst tinted by the real result.
   * An unknown family opens nothing: traffic is never invented.
   */
  toolEvent(data = {}) {
    if (!data || typeof data !== "object") return;
    const phase = data.phase === "start" || data.phase === "end" ? data.phase : "";
    if (!phase) return;
    const family = typeof data.family === "string" ? data.family.trim().toLowerCase() : "";
    const name = typeof data.name === "string" ? data.name : "";
    const node = capabilityForFamily(family);

    if (phase === "start") {
      const run = { name, family, node, phase: "start" };
      this._activeTools.push(run);
      this._tool = run;
      if (node >= 0) {
        clearTimeout(this._nodeTimers[node]);
        this._nodeTimers[node] = 0;
        if (this._nodeRuns[node] === 0) this._nodeOutcome[node] = 1;
        if (this._nodeRuns[node] < 65535) this._nodeRuns[node]++;
        this._nodeTarget[node] = 1;
        this._nodeResult[node] = 0;
        this._activeNode = node;
        this._emitAccum = 0;
        this._spawnPacket(node, 1, 0); // immediate outbound: the query leaves
      }
    } else {
      let runIndex = -1;
      for (let i = this._activeTools.length - 1; i >= 0; i--) {
        const run = this._activeTools[i];
        if (run.name === name && run.family === family) { runIndex = i; break; }
      }
      const matched = runIndex >= 0 ? this._activeTools.splice(runIndex, 1)[0] : null;
      this._tool = this._activeTools.length ? this._activeTools[this._activeTools.length - 1] : null;
      if (matched && node >= 0 && this._nodeRuns[node] > 0) {
        this._nodeRuns[node]--;
        const kind = data.ok === true ? 1 : -1;
        if (kind < 0) this._nodeOutcome[node] = -1;
        // The return: information coming back from the capability.
        for (let k = 0; k < 5; k++) this._spawnPacket(node, -1, kind, k * 0.13);
        if (this._nodeRuns[node] === 0) {
          this._nodeResult[node] = this._nodeOutcome[node] < 0 ? -1 : 1;
          clearTimeout(this._nodeTimers[node]);
          this._nodeTimers[node] = setTimeout(() => {
            this._nodeTarget[node] = 0;
            this._nodeResult[node] = 0;
            this._nodeOutcome[node] = 0;
            this._nodeTimers[node] = 0;
            if (this.reduced) this._renderReducedSnapshot();
          }, 1600);
        } else {
          this._nodeResult[node] = 0;
        }
      }
      const latestKnown = [...this._activeTools].reverse().find((run) => run.node >= 0);
      this._activeNode = latestKnown ? latestKnown.node : -1;
    }
    this._refreshView();
    if (this.reduced) this._renderReducedSnapshot();
  }

  setPendingConfirm(on) {
    const next = !!on;
    if (next === this._pendingConfirm) return;
    this._pendingConfirm = next;
    this._refreshView();
    if (this.reduced) this._renderReducedSnapshot();
  }

  setStage(stage) {
    const next = typeof stage === "string" ? stage : "";
    if (next === this._stage) return;
    this._stage = next;
    this._refreshView();
    if (this.reduced) this._renderReducedSnapshot();
  }

  setError(text) {
    this._errorText = typeof text === "string" ? text : "";
    this._refreshView();
    if (this.reduced) this._renderReducedSnapshot();
  }

  onView(fn) {
    if (typeof fn === "function") {
      this._onView = fn;
      fn(this.view);
    }
  }

  // ---- audio (contract preserved verbatim from VoiceOrb) -------------------

  _ensureAudio() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = AudioContextClass ? new AudioContextClass() : null;
      if (this.audioCtx) {
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.6;
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
    return this.audioCtx;
  }

  connectMic(stream) {
    if (!this._ensureAudio()) return;
    this._disconnectSource();
    if (this._micStream && this._micStream !== stream) {
      try { this._micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    }
    this._synthSpeak = false;
    this.srcNode = this.audioCtx.createMediaStreamSource(stream);
    this.srcNode.connect(this.analyser);
    this._micStream = stream;
    this._audioActive = true;
  }

  // WebKit/Orion can break media playback after createMediaElementSource, so
  // TTS stays wired straight to the element and the visual uses a synthetic
  // speech envelope instead. Load-bearing, not an oversight.
  connectMediaElement(el) {
    this._ensureAudio();
    this._disconnectSource();
    this._audioActive = false;
    this._synthSpeak = true;
  }

  _disconnectSource() {
    if (this.srcNode) {
      try { this.srcNode.disconnect(); } catch (e) {}
    }
    this.srcNode = null;
  }

  stopAudio() {
    this._disconnectSource();
    this._audioActive = false;
    this._synthSpeak = false;
    if (this._micStream) {
      try { this._micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      this._micStream = null;
    }
  }

  _sampleAmp() {
    if (!this.analyser || !this._audioActive) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
    return Math.min(1, (sum / this.freq.length / 255) * 1.6);
  }

  destroy() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVisibility);
    for (let i = 0; i < N; i++) clearTimeout(this._nodeTimers[i]);
    this.stopAudio();
  }

  // ---- traffic pool --------------------------------------------------------

  /** dir: +1 Core->capability, -1 capability->Core. kind: 0 none, 1 ok, -1 err. */
  _spawnPacket(node, dir, kind, delay = 0) {
    for (let i = 0; i < PACKET_POOL; i++) {
      if (this._pkNode[i] !== -1) continue;
      this._pkNode[i] = node;
      this._pkDir[i] = dir;
      this._pkKind[i] = kind;
      this._pkSpeed[i] = 0.85 + noise(i, 19) * 0.5;
      // A negative start delays entry without a timer.
      this._pkT[i] = dir > 0 ? -delay : 1 + delay;
      return;
    }
  }

  _stepPackets(dt) {
    for (let i = 0; i < PACKET_POOL; i++) {
      if (this._pkNode[i] === -1) continue;
      this._pkT[i] += this._pkDir[i] * this._pkSpeed[i] * dt;
      if (this._pkT[i] > 1.05 || this._pkT[i] < -0.05) this._pkNode[i] = -1;
    }
  }

  _refreshView() {
    this.view = deriveCoreState({
      status: this.status,
      tool: this._tool,
      pendingConfirm: this._pendingConfirm,
      stage: this._stage,
      errorText: this._errorText
    });
    if (this._onView) {
      try { this._onView(this.view); } catch (e) {}
    }
  }

  /** Apply the same real semantics as the eased loop, as one static snapshot. */
  _renderReducedSnapshot() {
    let raw = this._manualAmp;
    if (this._audioActive) raw = Math.max(raw, this._sampleAmp());
    this._manualAmp = 0;
    this.cur.amp = raw;
    this._ampFast = raw;
    this._ampSlow = raw;
    window.__artemisAmp = raw;

    const tone = this.view.tone;
    this._energy = this.view.energy;
    this._listenMix = this.status === "listening" && !this._pendingConfirm ? 1 : 0;
    this._workMix = tone === "work" ? 1 : 0;
    this._holdMix = tone === "hold" ? 1 : 0;
    this._faultMix = tone === "fault" ? 1 : 0;
    this._irisOpen = Math.min(
      1,
      0.1 + this._listenMix * (0.25 + raw * 1.5) + this._workMix * 0.45
    ) * (1 - this._holdMix * 0.55);
    for (let i = 0; i < N; i++) this._nodeLevel[i] = this._nodeTarget[i];
    this._draw(0);
  }

  // ---- loop ----------------------------------------------------------------

  _loop() {
    if (this._disposed) return;
    if (!this.reduced) this._raf = requestAnimationFrame(this._boundLoop);

    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._lastFrame || now)) / 1000);
    this._lastFrame = now;
    this._elapsed += dt;

    // Amplitude: real mic, synthetic speech envelope, or decay. Published on
    // window.__artemisAmp — the waveform strip, the v2 aura and the brain orb
    // all read it, so it must keep flowing.
    let raw = this._manualAmp;
    if (this._audioActive) {
      raw = Math.max(raw, this._sampleAmp());
    } else if (this._synthSpeak && !this.reduced) {
      const t = this._elapsed;
      raw = Math.max(raw, 0.4 + 0.45 * Math.abs(Math.sin(t * 6.5)) * (0.55 + 0.45 * Math.sin(t * 2.1 + 0.7)));
    }
    this._manualAmp *= 0.9;
    this.cur.amp += (raw - this.cur.amp) * (raw > this.cur.amp ? 0.3 : 0.07);
    window.__artemisAmp = this.cur.amp;

    // Two followers at different rates give the iris body AND transient bite.
    this._ampFast += (this.cur.amp - this._ampFast) * (1 - Math.exp(-dt * 18));
    this._ampSlow += (this.cur.amp - this._ampSlow) * (1 - Math.exp(-dt * 3.2));

    // Inertia on every state mix: transitions glide over a few hundred ms.
    const ease = 1 - Math.exp(-dt * 4.5);
    const tone = this.view.tone;
    this._energy += (this.view.energy - this._energy) * ease;
    this._listenMix += ((this.status === "listening" && !this._pendingConfirm ? 1 : 0) - this._listenMix) * ease;
    this._workMix += ((tone === "work" ? 1 : 0) - this._workMix) * ease;
    this._holdMix += ((tone === "hold" ? 1 : 0) - this._holdMix) * ease;
    this._faultMix += ((tone === "fault" ? 1 : 0) - this._faultMix) * ease;

    // The iris opens with real amplitude while listening, with computation
    // while reasoning, and clamps shut when suspended.
    const irisTarget = Math.min(
      1,
      0.1 + this._listenMix * (0.25 + this._ampFast * 1.5) + this._workMix * 0.45
    ) * (1 - this._holdMix * 0.55);
    this._irisOpen += (irisTarget - this._irisOpen) * (1 - Math.exp(-dt * 7));

    for (let i = 0; i < N; i++) {
      this._nodeLevel[i] += (this._nodeTarget[i] - this._nodeLevel[i]) * ease;
    }

    if (!this.reduced) {
      this._stepPackets(dt);
      // Sustained outbound traffic while a tool is genuinely running.
      if (this._activeNode >= 0) {
        this._emitAccum += dt;
        const period = this.view.state === "researching" ? 0.28 : 0.42;
        if (this._emitAccum >= period) {
          this._emitAccum = 0;
          // RESEARCHING alternates out/in: query goes, information returns.
          const dir = this.view.state === "researching" && noise(Math.floor(this._elapsed * 7), 20) > 0.5 ? -1 : 1;
          this._spawnPacket(this._activeNode, dir, 0);
        }
      }
      // LISTENING: a wave leaves the nucleus on a real amplitude transient.
      if (this._listenMix > 0.3 && this._ampFast > 0.34 && this._waveArmed) {
        this._waveArmed = false;
        for (let i = 0; i < WAVE_POOL; i++) {
          if (this._waveLife[i] <= 0) { this._waveLife[i] = 1; this._waveR[i] = 0; break; }
        }
      }
      if (this._ampFast < 0.2) this._waveArmed = true;
      for (let i = 0; i < WAVE_POOL; i++) {
        if (this._waveLife[i] > 0) {
          this._waveLife[i] -= dt * 1.1;
          this._waveR[i] += dt * 0.75;
        }
      }
    }

    // Idle stays cheap: the rAF keeps ticking (it owns the amplitude publish)
    // but the expensive painting is throttled when nothing is happening.
    const busy = this._energy > 0.2 || this.cur.amp > 0.02 || this._igniteAt >= 0 || this._activeNode >= 0;
    if (!busy && now - this._lastDraw < 1000 / IDLE_FPS) return;
    this._lastDraw = now;
    this._draw(this._elapsed);
  }

  // ---- render --------------------------------------------------------------

  _draw(time) {
    const ctx = this.ctx;
    const w = this._w, h = this._h, R = this._radius;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    this._hitCenterX = cx;
    this._hitCenterY = cy;

    const tone = TONES[this.view.tone] || TONES.calm;
    const t = this.reduced ? 0 : time;
    const energy = this._energy;
    // Suspended states damp every motion rate rather than freezing outright.
    const rate = 1 - this._holdMix * 0.82;

    ctx.save();
    ctx.translate(cx, cy);

    this._drawField(ctx, R, tone, t, energy, rate);        // 5
    this._drawMechanicalFrame(ctx, R, tone, t, energy);    // 4.5
    this._drawOrbital(ctx, R, tone, t, energy, rate);      // 3
    this._drawTraffic(ctx, R, tone, t);                    // 4
    this._drawIris(ctx, R, tone, t, rate);                 // 2
    this._drawCrosshair(ctx, R, tone, t, energy);          // 1.5
    this._drawNucleus(ctx, R, tone, t, rate);              // 1
    this._drawNodes(ctx, R, tone, t);
    if (this._igniteAt >= 0) this._drawIgnite(ctx, R, tone, time);

    ctx.restore();

    // Text unscaled and last, so nothing overdraws the identity.
    this._drawLabel(ctx, cx, cy, R, tone);
  }

  /** LAYER 5 — ambient intelligence field: sparse, quiet, parallax. */
  _drawField(ctx, R, tone, t, energy, rate) {
    const alpha = 0.05 + energy * 0.16 + this._workMix * 0.08;
    ctx.lineWidth = 1;
    for (let i = 0; i < FIELD_FRAGMENTS; i++) {
      const a = this._fragA[i] + t * this._fragSpeed[i] * rate;
      const rr = R * this._fragR[i];
      const co = Math.cos(a), si = Math.sin(a);
      // Depth: distant fragments are fainter and drift slower (parallax).
      const depth = 1 - (this._fragR[i] - 0.62) / 0.5;
      const al = alpha * (0.35 + depth * 0.65);
      if (this._fragKind[i]) {
        ctx.beginPath();
        ctx.fillStyle = tone.key + al.toFixed(3) + ")";
        ctx.arc(co * rr, si * rr, 1, 0, TAU);
        ctx.fill();
      } else {
        const len = R * this._fragLen[i];
        ctx.beginPath();
        ctx.strokeStyle = tone.key + al.toFixed(3) + ")";
        ctx.moveTo(co * rr, si * rr);
        ctx.lineTo(co * (rr + len), si * (rr + len));
        ctx.stroke();
      }
    }
    // An occasional scan fragment sweeping the field — richer while reasoning.
    if (this._workMix > 0.05 && !this.reduced) {
      const sweep = (t * 0.22) % TAU;
      arcs(ctx, R * 1.02, [[sweep, sweep + 0.5]], 1, 0, tone.accent, this._workMix * 0.14, 6);
    }
  }

  /** Live energy seams over the physical chassis supplied by the local image. */
  _drawMechanicalFrame(ctx, R, tone, t, energy) {
    ctx.save();
    arcs(ctx, R * 0.39, MECHANICAL_SEGS, 0.9, t * 0.018,
      tone.accent, 0.22 + energy * 0.18, 5);
    arcs(ctx, R * 0.49, MECHANICAL_SEGS, 0.75, -t * 0.012,
      tone.key, 0.18 + energy * 0.16, 4);
    ring(ctx, R * 0.55, 0.7, tone.key, 0.12 + energy * 0.1, 3);
    ticks(ctx, R * 0.54, 48, R * 0.014, 0, tone.accent, 0.12 + energy * 0.08);
    ctx.restore();
  }

  /** LAYER 3 — orbital computation: independent tracks, different rates. */
  _drawOrbital(ctx, R, tone, t, energy, rate) {
    const e = energy * rate;

    // Track A — broken arcs, clockwise.
    arcs(ctx, R * R_TRACK_A, TRACK_A_SEGS, 1.5, t * (0.05 + e * 0.42) * rate,
      tone.accent, 0.24 + e * 0.3, 8);

    // Track B — counter-rotating, finer, faster under load.
    arcs(ctx, R * R_TRACK_B, TRACK_B_SEGS, 1, -t * (0.09 + e * 0.66) * rate,
      tone.key, 0.2 + e * 0.28, 5);

    // Track C — the calm instrument reference the moving parts read against.
    ring(ctx, R * R_TRACK_C, 0.8, tone.key, 0.12 + e * 0.06, 0);
    ticks(ctx, R * R_TRACK_C, 60, R * 0.018, t * 0.01 * rate, tone.key, 0.1 + e * 0.08);
    ticks(ctx, R * R_TRACK_C, 4, R * 0.05, t * 0.01 * rate, tone.accent, 0.24 + e * 0.2);

    // Reasoning adds a scanning radius that sweeps the computation band.
    if (this._workMix > 0.02 && !this.reduced) {
      const a = t * 0.85 * rate;
      ctx.beginPath();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = tone.hot + (this._workMix * 0.42).toFixed(3) + ")";
      ctx.shadowColor = PAL.GLOW;
      ctx.shadowBlur = 6;
      ctx.moveTo(Math.cos(a) * R * R_TRACK_A, Math.sin(a) * R * R_TRACK_A);
      ctx.lineTo(Math.cos(a) * R * R_TRACK_C, Math.sin(a) * R * R_TRACK_C);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Radial anchors: every capability owns a marker on the outer track, so the
      // nodes read as part of the mechanism rather than floating labels.
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const lvl = this._nodeLevel[i];
      const co = this._nodeCos[i], si = this._nodeSin[i];
      ctx.beginPath();
      ctx.strokeStyle = tone.key + (0.1 + lvl * 0.5).toFixed(3) + ")";
      ctx.moveTo(co * R * R_TRACK_C, si * R * R_TRACK_C);
      ctx.lineTo(co * R * (R_TRACK_C + 0.035 + lvl * 0.02), si * R * (R_TRACK_C + 0.035 + lvl * 0.02));
      ctx.stroke();
    }
  }

  /**
   * LAYER 4 — intelligence traffic. Every packet here corresponds to a REAL
   * tool lifecycle event; nothing is emitted speculatively.
   */
  _drawTraffic(ctx, R, tone, t) {
    const rIn = R * (R_NUCLEUS + 0.03);
    const rOut = R * R_NODES;

    // Active relationship: a live channel between Eve and the capability.
    if (this._activeNode >= 0) {
      const i = this._activeNode;
      const co = this._nodeCos[i], si = this._nodeSin[i];
      const pulse = 0.3 + 0.25 * Math.sin(t * 4);
      ctx.beginPath();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = tone.hot + pulse.toFixed(3) + ")";
      ctx.moveTo(co * rIn, si * rIn);
      ctx.lineTo(co * rOut, si * rOut);
      ctx.stroke();

      // EXECUTING locks on: a bracket clamps the target capability.
      if (this.view.state === "executing" || this.view.state === "researching") {
        const a = this._nodeAngle[i];
        const br = rOut - R * 0.045;
        arcs(ctx, br, [[a - 0.13, a - 0.05], [a + 0.05, a + 0.13]], 2, 0, tone.hot, 0.75, 8);
      }
    }

    // Packets in flight.
    for (let p = 0; p < PACKET_POOL; p++) {
      const node = this._pkNode[p];
      if (node === -1) continue;
      const tt = this._pkT[p];
      if (tt < 0 || tt > 1) continue;
      const co = this._nodeCos[node], si = this._nodeSin[node];
      const r = rIn + (rOut - rIn) * tt;
      const kind = this._pkKind[p];
      const paint = kind === 1 ? PAL.OK : kind === -1 ? PAL.ERR : tone.hot;

      // Tail trails behind travel direction — that is what makes it read as
      // movement with a direction rather than a blinking dot.
      const tail = 0.07 * this._pkDir[p];
      const rt = rIn + (rOut - rIn) * Math.max(0, Math.min(1, tt - tail));
      ctx.beginPath();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = paint + "0.35)";
      ctx.moveTo(co * rt, si * rt);
      ctx.lineTo(co * r, si * r);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = paint + "0.95)";
      ctx.shadowColor = PAL.GLOW;
      ctx.shadowBlur = 6;
      ctx.arc(co * r, si * r, 1.9, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  /** LAYER 2 — the neural iris: an intelligence aperture, not shutter blades. */
  _drawIris(ctx, R, tone, t, rate) {
    const open = this._irisOpen;
    // Opening pushes blades outward and widens the aperture gap.
    const inner = R * (R_IRIS_IN + open * 0.055);
    const outer = R * (R_IRIS_OUT + open * 0.075);
    ctx.lineCap = "round";

    for (let i = 0; i < IRIS_SEGMENTS; i++) {
      // Each blade drifts at its own rate and direction — the aperture never
      // reads as one rigid object rotating.
      const dir = i % 2 ? -1 : 1;
      const a0 = this._irisBase[i] + t * this._irisSpeed[i] * dir * (0.06 + this._energy * 0.3) * rate;
      // Blades separate as the iris opens (asymmetrically, per blade).
      const span = this._irisSpan[i] * (1 - open * 0.3);
      const rad = inner + (outer - inner) * this._irisRad[i];
      const width = (outer - inner) * (0.2 + this._irisRad[i] * 0.16) * (1 + open * 0.5);

      let alpha = 0.16 + open * 0.34 + this._energy * 0.12;

      // ERROR: one blade breaks out of formation and dims — controlled
      // disruption, not a red screen.
      let displaced = 0;
      if (this._faultMix > 0.02 && i === 4) {
        displaced = this._faultMix * R * 0.05 * (1 + Math.sin(t * 2.2));
        alpha *= 0.5;
      }

      ctx.beginPath();
      ctx.lineWidth = Math.max(1, width);
      ctx.strokeStyle = tone.accent + alpha.toFixed(3) + ")";
      ctx.shadowColor = PAL.GLOW;
      ctx.shadowBlur = 4 + open * 8;
      ctx.arc(0, 0, Math.max(1, rad + displaced), a0, a0 + span);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Blade tip marker: the aperture's leading edge.
      if (open > 0.25) {
        const tip = a0 + span;
        ctx.beginPath();
        ctx.fillStyle = tone.hot + (open * 0.5).toFixed(3) + ")";
        ctx.arc(Math.cos(tip) * (rad + displaced), Math.sin(tip) * (rad + displaced), 1.3, 0, TAU);
        ctx.fill();
      }
    }
    ctx.lineCap = "butt";

    // LISTENING waves: propagate out through the iris on real amplitude peaks.
    for (let i = 0; i < WAVE_POOL; i++) {
      if (this._waveLife[i] <= 0) continue;
      const life = this._waveLife[i];
      ring(ctx, R * (R_NUCLEUS + this._waveR[i]), 1.4 * life, PAL.B, life * 0.4, 10 * life);
    }
  }

  /** Four fixed optical axes from the reference, with state-tinted emitters. */
  _drawCrosshair(ctx, R, tone, t, energy) {
    const inner = R * 0.23;
    const outer = R * 0.57;
    const beacon = R * 0.41;
    const live = 0.42 + energy * 0.28 + this._ampFast * 0.24;
    const pulse = this.reduced ? 0.7 : 0.68 + Math.sin(t * 2.1) * 0.12;

    ctx.save();
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 2;
      const co = Math.cos(a), si = Math.sin(a);

      // Recessed rail + luminous center filament.
      ctx.beginPath();
      ctx.lineWidth = Math.max(1.5, R * 0.009);
      ctx.strokeStyle = "rgba(3,12,23,0.58)";
      ctx.moveTo(co * inner, si * inner);
      ctx.lineTo(co * outer, si * outer);
      ctx.stroke();

      ctx.beginPath();
      ctx.lineWidth = 1;
      ctx.strokeStyle = tone.hot + live.toFixed(3) + ")";
      ctx.shadowColor = PAL.GLOW;
      ctx.shadowBlur = 7 + energy * 7;
      ctx.moveTo(co * inner, si * inner);
      ctx.lineTo(co * outer, si * outer);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Cyan east/west, violet north/south — the approved visual's anchors.
      const beaconPaint = i % 2 ? tone.hot : PAL.V;
      ctx.beginPath();
      ctx.fillStyle = beaconPaint + Math.min(0.98, pulse + energy * 0.18).toFixed(3) + ")";
      ctx.shadowColor = i % 2 ? PAL.GLOW : "rgba(183,166,255,0.58)";
      ctx.shadowBlur = 11;
      ctx.arc(co * beacon, si * beacon, Math.max(2.2, R * 0.012), 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;

      ringAt(ctx, co * beacon, si * beacon, Math.max(4, R * 0.025), 0.8,
        beaconPaint, 0.42 + energy * 0.18);
    }
    ctx.restore();
  }

  /** LAYER 1 — nucleus: dense, alive, never a flat black disk. */
  _drawNucleus(ctx, R, tone, t, rate) {
    // Pulse distortion driven by real amplitude + breathing.
    const breathe = this.reduced ? 0 : Math.sin(t * 0.85) * 0.012;
    const r = R * R_NUCLEUS * (1 + breathe + this._ampSlow * 0.075 + this._ampFast * 0.035);

    // Body: deep navy with a cool lift, hot centre under load. Cached because
    // createRadialGradient every frame is the one real allocation here.
    const key = this.view.tone + "|" + Math.round(r) + "|" + Math.round(this._energy * 8);
    if (key !== this._gradKey) {
      const g = ctx.createRadialGradient(0, 0, r * 0.04, 0, 0, r);
      g.addColorStop(0, "rgba(38,86,140," + (0.5 + this._energy * 0.35).toFixed(2) + ")");
      g.addColorStop(0.42, "rgba(14,32,58,0.95)");
      g.addColorStop(1, "rgba(5,10,20,1)");
      this._grad = g;
      const lens = ctx.createRadialGradient(-r * 0.13, -r * 0.18, r * 0.02, 0, 0, r * 0.72);
      lens.addColorStop(0, "rgba(42,96,145,0.42)");
      lens.addColorStop(0.28, "rgba(9,25,43,0.94)");
      lens.addColorStop(0.72, "rgba(3,10,19,0.985)");
      lens.addColorStop(1, "rgba(1,5,11,1)");
      this._lensGrad = lens;
      this._gradKey = key;
    }
    ctx.beginPath();
    ctx.fillStyle = this._grad;
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // Glass lens stack: a deep center, beveled rims and restrained violet
    // interference. This is the visual identity in the supplied reference.
    ring(ctx, r * 0.94, Math.max(5, r * 0.055), "rgba(2,8,16,", 0.82, 0);
    ring(ctx, r * 0.93, 1.1, tone.key, 0.52 + this._energy * 0.14, 10);
    ring(ctx, r * 0.82, Math.max(2.4, r * 0.026), "rgba(18,42,67,", 0.72, 0);
    ring(ctx, r * 0.81, 0.9, PAL.Hl, 0.28, 5);
    ring(ctx, r * 0.68, 1, PAL.V, 0.24 + this._workMix * 0.22, 6);
    ring(ctx, r * 0.55, 0.75, tone.key, 0.3 + this._ampSlow * 0.2, 4);
    ring(ctx, r * 0.39, 0.7, PAL.Hl, 0.14 + this._energy * 0.1, 3);
    ring(ctx, r * 0.24, 0.8, tone.hot, 0.22 + this._ampFast * 0.25, 5);

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip(); // internals never bleed past the nucleus edge

    // Internal filaments: chords sweeping the interior at their own rates.
    ctx.lineWidth = 1;
    for (let i = 0; i < FILAMENTS; i++) {
      const a = this._filPhase[i] + t * this._filSpeed[i] * rate;
      const rr = r * this._filRad[i];
      ctx.beginPath();
      ctx.strokeStyle = tone.hot + (0.07 + this._energy * 0.12 + this._ampFast * 0.14).toFixed(3) + ")";
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a + 2.2) * rr, Math.sin(a + 2.2) * rr);
      ctx.stroke();
    }

    // Interference geometry: two off-centre arc families reading as moiré.
    const io = r * 0.22;
    for (let i = 1; i <= 3; i++) {
      const rr = r * (0.3 + i * 0.22);
      ctx.beginPath();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = tone.key + (0.1 + this._energy * 0.1).toFixed(3) + ")";
      ctx.arc(Math.cos(t * 0.15 * rate) * io * 0.3, Math.sin(t * 0.15 * rate) * io * 0.3, rr, 0, TAU);
      ctx.stroke();
    }

    // Controlled internal particles.
    for (let i = 0; i < NUCLEUS_MOTES; i++) {
      const a = this._moteA[i] + t * this._moteS[i] * rate;
      const rr = r * this._moteR[i];
      ctx.beginPath();
      ctx.fillStyle = tone.hot + (0.2 + this._ampFast * 0.5).toFixed(3) + ")";
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr, 0.9, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // A dark glass pupil sits over the moving internals. The reference's
    // depth comes from seeing activity through a lens, not from drawing every
    // internal line at equal contrast.
    const lensR = r * 0.71;
    ctx.beginPath();
    ctx.fillStyle = this._lensGrad;
    ctx.shadowColor = PAL.GLOW;
    ctx.shadowBlur = 10 + this._energy * 8;
    ctx.arc(0, 0, lensR, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ring(ctx, lensR, Math.max(2, r * 0.026), "rgba(2,9,17,", 0.95, 0);
    ring(ctx, lensR * 0.98, 1, tone.key, 0.58 + this._energy * 0.12, 10);
    ring(ctx, lensR * 0.81, 0.8, PAL.V, 0.22 + this._workMix * 0.2, 5);
    ring(ctx, lensR * 0.58, 0.65, tone.accent, 0.18 + this._ampSlow * 0.18, 4);

    // Specular crown arcs make the nucleus read as glass rather than a flat
    // gradient disk. They remain fixed to the object while inner data moves.
    arcs(ctx, r * 0.89, [[3.62, 4.64], [5.02, 5.46]], 1.35, 0,
      PAL.Hl, 0.3, 6);
    arcs(ctx, r * 0.76, [[3.72, 4.42]], 0.8, 0,
      tone.accent, 0.28, 4);

    // Perimeter energy: rim, plus a brighter arc that sweeps it.
    ring(ctx, r, 1.3, tone.key, 0.45 + this._ampSlow * 0.4, 12 + this._ampFast * 20);
    const sweepA = t * (0.35 + this._energy * 0.9) * rate;
    arcs(ctx, r, [[sweepA, sweepA + 0.7 + this._irisOpen * 0.5]], 1.8, 0,
      tone.hot, 0.3 + this._energy * 0.35, 10);

    // WAITING: a slow expectant pulse instead of activity.
    if (this._holdMix > 0.02) {
      const p = 0.5 + 0.5 * Math.sin(t * 1.15);
      ring(ctx, r * (1.1 + p * 0.12), 1, PAL.GOLD, this._holdMix * (0.35 - p * 0.2), 6);
    }
    // ERROR: a low-frequency disturbance ring.
    if (this._faultMix > 0.02) {
      const p = 0.5 + 0.5 * Math.sin(t * 0.9);
      ring(ctx, r * (1.06 + p * 0.06), 1.2, PAL.ERR, this._faultMix * 0.3, 8);
    }
  }

  /** Capability anchors. Quiet unless their tool is actually running. */
  _drawNodes(ctx, R, tone, t) {
    const rr = R * R_NODES;
    const showLabels = R >= LABEL_MIN_RADIUS;

    for (let i = 0; i < N; i++) {
      const co = this._nodeCos[i], si = this._nodeSin[i];
      const x = co * rr, y = si * rr;
      this._nodeX[i] = x;
      this._nodeY[i] = y;

      const lvl = this._nodeLevel[i];
      const result = this._nodeResult[i];
      const paint = result === 1 ? PAL.OK : result === -1 ? PAL.ERR : tone.node;

      ctx.beginPath();
      ctx.fillStyle = paint + (0.2 + lvl * 0.75).toFixed(3) + ")";
      if (lvl > 0.05) {
        ctx.shadowColor = PAL.GLOW;
        ctx.shadowBlur = 4 + lvl * 12;
      }
      ctx.arc(x, y, 2 + lvl * 2.4, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (lvl > 0.02) {
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = paint + (lvl * 0.5).toFixed(3) + ")";
        ctx.arc(x, y, 5 + lvl * 3, 0, TAU);
        ctx.stroke();
      }

    }

    if (showLabels) {
      ctx.font = '600 8.5px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const group of CORE_PRESENTATION_GROUPS) {
        let lvl = 0;
        let result = 0;
        for (const node of group.nodes) {
          lvl = Math.max(lvl, this._nodeLevel[node]);
          if (this._nodeResult[node] < 0) result = -1;
          else if (!result && this._nodeResult[node] > 0) result = 1;
        }
        const paint = result === 1 ? PAL.OK : result === -1 ? PAL.ERR : group.paint;
        const x = Math.cos(group.angle) * R * group.radius;
        const y = Math.sin(group.angle) * R * group.radius;
        const width = ctx.measureText(group.title).width + 14;
        const height = 17;

        ctx.beginPath();
        ctx.fillStyle = "rgba(4,13,23," + (0.7 + lvl * 0.16).toFixed(3) + ")";
        ctx.strokeStyle = paint + (0.26 + lvl * 0.62).toFixed(3) + ")";
        ctx.lineWidth = 0.8 + lvl * 0.5;
        ctx.rect(x - width / 2, y - height / 2, width, height);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = paint + (0.62 + lvl * 0.35).toFixed(3) + ")";
        if (lvl > 0.05) {
          ctx.shadowColor = PAL.GLOW;
          ctx.shadowBlur = 7;
        }
        ctx.fillText(group.title, x, y + 0.5);
        ctx.shadowBlur = 0;
      }
    }
  }

  /** Identity lockup from the approved reference. Live state and task remain
   * in their dedicated DOM readouts, where they are accessible and unclipped. */
  _drawLabel(ctx, cx, cy, R, tone) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const nameSize = Math.max(10, Math.round(R * 0.085));
    ctx.font = "700 " + nameSize + 'px "JetBrains Mono", monospace';
    ctx.fillStyle = PAL.B + "0.96)";
    ctx.shadowColor = PAL.GLOW;
    ctx.shadowBlur = 14;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "2px";
    ctx.fillText("ARTEMIS", 0, -nameSize * 0.18);
    ctx.shadowBlur = 0;

    const subSize = Math.max(6, Math.round(R * 0.034));
    ctx.font = "500 " + subSize + 'px "JetBrains Mono", monospace';
    if ("letterSpacing" in ctx) ctx.letterSpacing = "1.5px";
    ctx.fillStyle = PAL.Hl + "0.7)";
    ctx.fillText("INTELLIGENCE CORE", 0, nameSize * 0.58);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.restore();
  }

  /** Clip text to the nucleus width so it can never spill over the mechanism. */
  _fit(ctx, text, maxWidth) {
    const s = String(text || "");
    if (ctx.measureText(s).width <= maxWidth) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "…").width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo) + "…";
  }

  _drawIgnite(ctx, R, tone, time) {
    const age = time - this._igniteAt;
    const life = 1.2;
    if (age > life) { this._igniteAt = -1; return; }
    const p = age / life;
    ring(ctx, R * (R_NUCLEUS + p * 0.75), 2 * (1 - p), tone.key, (1 - p) * 0.55, 18 * (1 - p));
  }
}

/** A translated ring without allocating a transform or gradient. */
function ringAt(ctx, x, y, r, width, paint, alpha) {
  ctx.beginPath();
  ctx.lineWidth = width;
  ctx.strokeStyle = paint + alpha + ")";
  ctx.arc(x, y, Math.max(0, r), 0, TAU);
  ctx.stroke();
}

// Legacy alias so any stray reference keeps resolving.
export { CAPABILITIES as MOON_INFO } from "./coreCapabilities.js";
