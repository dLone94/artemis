// Artemis VoiceOrb — the cyan orbital-HUD (Canvas 2D), ported verbatim from the
// locked prototype: arc-reactor core, tilted orbital rings with depth-shaded
// satellites + constellation links, tick ring, inner reticle, ARTEMIS label.
// Backend-agnostic API kept identical to the old WebGL orb so main.js / celebration.js
// work unchanged: setStatus(), connectMic(), connectMediaElement(), feed(), _ensureAudio(),
// stopAudio(), dispose(), and `cur.amp` / `reduced`. Reacts to mic (LISTENING) and TTS
// (SPEAKING) amplitude — rings spin faster, core brightens, scanner accelerates.

import {
  PAL,
  arcs as drawHudArcs,
  poly as drawHudPoly,
  prefersReducedMotion,
  ring as drawHudRing,
  ticks as drawHudTicks
} from "./orbShared.js";

// Reactor geometry is immutable and shared by every frame. Keeping the segment
// tables here avoids rebuilding dash arrays in the render loop.
const TAU = Math.PI * 2;
const TICK_COUNT = 72;
const COMET_TRAIL_STEPS = 4;
const RIPPLE_POOL_SIZE = 16;
const REACTOR_BANDS = [
  {
    radius: 0.32, width: 0.032, phase: 0.08, alpha: 0.72, blur: 5, color: PAL.B,
    velocity: 0.42, waveAmp1: 0.16, waveFreq1: 0.43, wavePhase1: 0.2,
    waveAmp2: 0.08, waveFreq2: 0.71, wavePhase2: 1.1,
    morphRate: 0.34, morphAmp: 0.035, morphPhase: 0.4,
    cometCount: 3, cometRate: 1.45, cometPhase: 0.3,
    segments: [[0.02, 0.54], [0.72, 1.48], [1.72, 2.28], [2.52, 3.34], [3.56, 4.12], [4.38, 5.14], [5.4, 6.12]]
  },
  {
    radius: 0.44, width: 0.022, phase: 0.86, alpha: 0.54, blur: 3, color: PAL.O,
    velocity: -0.08, waveAmp1: 0.32, waveFreq1: 0.37, wavePhase1: 1.4,
    waveAmp2: 0.14, waveFreq2: 0.83, wavePhase2: 0.2,
    morphRate: 0.27, morphAmp: 0.045, morphPhase: 1.3,
    cometCount: 2, cometRate: -1.35, cometPhase: 1.1,
    segments: [[0.1, 0.84], [1.04, 1.3], [1.5, 2.44], [2.68, 3.08], [3.28, 4.2], [4.44, 5.02], [5.26, 6.02]]
  },
  {
    radius: 0.57, width: 0.027, phase: 1.72, alpha: 0.62, blur: 4, color: PAL.B,
    velocity: 0.53, waveAmp1: 0.2, waveFreq1: 0.51, wavePhase1: 2.2,
    waveAmp2: 0.09, waveFreq2: 0.77, wavePhase2: 0.5,
    morphRate: 0.39, morphAmp: 0.032, morphPhase: 2.4,
    cometCount: 3, cometRate: 1.7, cometPhase: 2,
    segments: [[0, 0.3], [0.46, 0.92], [1.08, 1.72], [1.9, 2.2], [2.4, 3.04], [3.2, 3.66], [3.84, 4.54], [4.74, 5.08], [5.3, 5.94], [6.1, 6.24]]
  },
  {
    radius: 0.7, width: 0.018, phase: 2.56, alpha: 0.48, blur: 2, color: PAL.O,
    velocity: -0.31, waveAmp1: 0.13, waveFreq1: 0.33, wavePhase1: 0.9,
    waveAmp2: 0.07, waveFreq2: 0.67, wavePhase2: 2.7,
    morphRate: 0.22, morphAmp: 0.04, morphPhase: 3.1,
    cometCount: 2, cometRate: -1.25, cometPhase: 2.8,
    segments: [[0.06, 0.62], [0.8, 1.1], [1.28, 1.94], [2.14, 2.72], [2.92, 3.54], [3.72, 4.04], [4.24, 4.84], [5.04, 5.54], [5.76, 6.18]]
  }
];
const SCANNER_SEGMENTS = [
  [0, 0.12], [0.23, 0.38], [0.5, 0.68], [0.81, 1.02], [1.16, 1.4], [1.55, 1.82]
];
const OUTER_BEZEL_SEGMENTS = [[0.1, 1.5], [2.2, 3], [3.6, 5.2]];

// Morphing bands need frame-varying endpoints, while orbShared.arcs strokes
// every segment separately. Batching the same geometry into one path preserves
// its appearance and keeps the continuous-motion pass below the old draw cost.
function strokeArcSegments(ctx, r, segments, width, rotation, color, alpha, blur) {
  r = Math.max(0, r);
  if (!r) return;
  ctx.beginPath();
  ctx.lineWidth = width;
  ctx.strokeStyle = color + alpha + ")";
  ctx.lineCap = "round";
  ctx.shadowColor = PAL.GLOW;
  ctx.shadowBlur = blur || 0;
  for (let i = 0; i < segments.length; i++) {
    const start = rotation + segments[i][0];
    ctx.moveTo(Math.cos(start) * r, Math.sin(start) * r);
    ctx.arc(0, 0, r, start, rotation + segments[i][1]);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineCap = "butt";
}

export class VoiceOrb {
  constructor(container, opts = {}) {
    this.container = container;
    this.center = !!opts.center; // cockpit: orb dead-center (landing offsets right for hero copy)
    this.reduced = prefersReducedMotion();
    this.status = "idle";
    this.cur = { amp: 0 };
    this._manualAmp = 0;
    this.NB = 28;                       // spectrum bands driving the talking waveform
    this.bins = new Float32Array(this.NB);
    this._ripples = new Array(RIPPLE_POOL_SIZE);
    for (let i = 0; i < RIPPLE_POOL_SIZE; i++) this._ripples[i] = { t0: 0, e: 0 };
    this._rippleCount = 0;
    this._prevAmp = 0;
    this._lastRipple = -1;
    this._audioActive = false;
    this._raf = 0;
    this._disposed = false;
    this._listeningMix = 0;
    this._thinkingMix = 0;
    this._speakingMix = 0;
    this._bandAngles = new Float64Array(REACTOR_BANDS.length);
    this._bandVelocities = new Float64Array(REACTOR_BANDS.length);
    this._bandWavePhase1 = new Float64Array(REACTOR_BANDS.length);
    this._bandWavePhase2 = new Float64Array(REACTOR_BANDS.length);
    this._bandMorphPhase = new Float64Array(REACTOR_BANDS.length);
    this._bandCometPhase = new Float64Array(REACTOR_BANDS.length);
    this._bandSegments = new Array(REACTOR_BANDS.length);
    for (let i = 0; i < REACTOR_BANDS.length; i++) {
      const band = REACTOR_BANDS[i];
      this._bandAngles[i] = band.phase;
      this._bandWavePhase1[i] = band.wavePhase1;
      this._bandWavePhase2[i] = band.wavePhase2;
      this._bandMorphPhase[i] = band.morphPhase;
      this._bandCometPhase[i] = band.cometPhase;
      this._bandSegments[i] = new Array(band.segments.length);
      for (let j = 0; j < band.segments.length; j++) {
        this._bandSegments[i][j] = [band.segments[j][0], band.segments[j][1]];
      }
    }
    this._scannerPhase = 0;
    this._counterScannerPhase = 0;
    this._scannerWavePhase1 = 0.4;
    this._scannerWavePhase2 = 1.7;
    this._tickRotation = 0;
    this._tickMarqueePhase = 0;
    this._tickWavePhase1 = 0.8;
    this._tickWavePhase2 = 2.1;
    this._reticlePhase = 0;
    this._nextSonarAt = 4.8;
    this._lastFrameAt = 0;

    // ---- 3D geometry (unit sphere; projected each frame in _draw) ----
    // Particle shell — a Fibonacci sphere so points are evenly scattered, each
    // with a twinkle phase. Rotated + perspective-projected per frame for a
    // volumetric dust that reads as genuinely three-dimensional.
    this._particles = [];
    const NP = 140;
    for (let i = 0; i < NP; i++) {
      const y = 1 - (i / (NP - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * 2.399963229728653; // golden angle
      this._particles.push({ x: Math.cos(phi) * r, y, z: Math.sin(phi) * r, tw: (i * 37 % 100) / 100 });
    }
    // Orbital rings — real 3D circles, each in its own tilted plane (tl = tilt
    // about X, roll = spin about Y) so they cross the sphere at different angles.
    this._rings = [
      { rr: 1.62, tl: 0.42, roll: 0.0, spd: 0.55, ph: 0.0 },
      { rr: 1.30, tl: -1.05, roll: 1.1, spd: -0.42, ph: 2.0 },
      { rr: 1.12, tl: 1.25, roll: 2.3, spd: 0.72, ph: 1.0 }
    ];

    this.cv = document.createElement("canvas");
    this.cv.style.display = "block";
    this.cv.style.width = "100%";
    this.cv.style.height = "100%";
    container.appendChild(this.cv);
    this.ctx = this.cv.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._mouse = { x: 0, y: 0 };
    this._mx = 0;
    this._my = 0;

    this._onResize = () => {
      this.resize();
      if (this.reduced) this._loop(); // repaint the single static frame
    };
    window.addEventListener("resize", this._onResize);
    this._onMouse = (e) => {
      this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this._mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    if (!this.reduced) window.addEventListener("pointermove", this._onMouse);
    this._onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      } else if (!this._disposed) {
        const resumedAt = performance.now();
        this._t0 = resumedAt - this._elapsed * 1000;
        this._lastFrameAt = resumedAt;
        this._loop();
      }
    };
    document.addEventListener("visibilitychange", this._onVis);

    this._scrollProg = 0;
    this._onScroll = () => {
      const h = window.innerHeight || 1;
      this._scrollProg = Math.max(0, Math.min(1, window.scrollY / (h * 0.85)));
    };
    window.addEventListener("scroll", this._onScroll, { passive: true });

    this.resize();
    this._t0 = performance.now();
    this._lastFrameAt = this._t0;
    this._elapsed = 0;
    this._loop();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.W = w;
    this.H = h;
    this.cv.width = Math.max(1, w * this.dpr);
    this.cv.height = Math.max(1, h * this.dpr);
    this.narrow = w < 820;
  }

  setStatus(s) {
    if (s === "idle" || s === "listening" || s === "thinking" || s === "speaking") {
      if (s !== this.status) {
        this.status = s;
        const t = this.reduced ? 0 : (this._elapsed || 0);
        if (this.reduced) this._rippleCount = 0;
        this._emitRipple(t, 1);
        if (!this.reduced && s === "idle") this._nextSonarAt = t + 4.8;
      }
    }
    if (this.reduced) this._loop(); // reduced motion: repaint one frame for the new state
  }

  feed(a) {
    const v = Math.max(0, Math.min(1, Number(a) || 0));
    if (v > this._manualAmp) this._manualAmp = v;
  }

  _emitRipple(t, energy) {
    let slot = this._rippleCount;
    if (slot < this._ripples.length) {
      this._rippleCount++;
    } else {
      slot = 0;
      for (let i = 1; i < this._ripples.length; i++) {
        if (this._ripples[i].t0 < this._ripples[slot].t0) slot = i;
      }
    }
    this._ripples[slot].t0 = t;
    this._ripples[slot].e = Math.max(0, Math.min(1, energy));
  }

  // ---- audio ----
  _ensureAudio() {
    if (!this.audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = C ? new C() : null;
      if (this.audioCtx) {
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.6; // snappier → tracks speech
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") this.audioCtx.resume();
    return this.audioCtx;
  }

  connectMic(stream) {
    if (!this._ensureAudio()) return;
    this._disconnectSource();
    // release the previous stream's tracks — replacing without stopping leaks
    // a live mic (the browser's "mic in use" dot never clears)
    if (this._micStream && this._micStream !== stream) {
      try { this._micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    }
    this._synthSpeak = false;
    this.srcNode = this.audioCtx.createMediaStreamSource(stream);
    this.srcNode.connect(this.analyser); // analyse only, never route mic to output
    this._micStream = stream;
    this._audioActive = true;
  }

  // WebKit/Orion breaks <audio> playback after the first turn if it's routed through
  // createMediaElementSource. So we DON'T route TTS through Web Audio — the element
  // plays straight to the speakers (reliable everywhere) and the orb animates from a
  // synthetic speech envelope instead of the real waveform.
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
      this._micStream.getTracks().forEach((t) => t.stop());
      this._micStream = null;
    }
  }

  _sampleAmp() {
    if (!this.analyser || !this._audioActive) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    let s = 0;
    for (let i = 0; i < this.freq.length; i++) s += this.freq[i];
    return Math.min(1, (s / this.freq.length / 255) * 1.6);
  }

  // ---- loop ----
  _loop() {
    // reduced motion: no rAF loop — each call renders exactly one static frame
    // (t is pinned to 0 below); resize/status changes re-invoke it once.
    if (!this.reduced) this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = this.reduced ? 0 : Math.max(0, Math.min(0.05, (now - this._lastFrameAt) / 1000));
    this._lastFrameAt = now;
    this._elapsed = (now - this._t0) / 1000;
    const t = this.reduced ? 0 : this._elapsed;

    // State visuals are blended independently so status changes ease instead
    // of snapping. Reduced motion resolves directly to one deterministic frame.
    const stateEase = this.reduced ? 1 : 1 - Math.exp(-dt * 7);
    const listeningTarget = this.status === "listening" ? 1 : 0;
    const thinkingTarget = this.status === "thinking" ? 1 : 0;
    const speakingTarget = this.status === "speaking" ? 1 : 0;
    this._listeningMix += (listeningTarget - this._listeningMix) * stateEase;
    this._thinkingMix += (thinkingTarget - this._thinkingMix) * stateEase;
    this._speakingMix += (speakingTarget - this._speakingMix) * stateEase;
    if (!this.reduced) {
      const velocityBoost = 1 + this._listeningMix * 1.25;
      const morphBoost = 1 + this._thinkingMix * 1.4;
      for (let i = 0; i < REACTOR_BANDS.length; i++) {
        const band = REACTOR_BANDS[i];
        this._bandWavePhase1[i] += dt * band.waveFreq1;
        this._bandWavePhase2[i] += dt * band.waveFreq2;
        this._bandMorphPhase[i] += dt * band.morphRate * morphBoost;
        const velocity = (
          band.velocity +
          band.waveAmp1 * Math.sin(this._bandWavePhase1[i]) +
          band.waveAmp2 * Math.sin(this._bandWavePhase2[i])
        ) * velocityBoost;
        const cometVelocity = band.cometRate * (
          1 +
          0.14 * Math.sin(this._bandWavePhase2[i] * 1.17 + i * 0.61) +
          0.07 * Math.sin(this._bandWavePhase1[i] * 0.73 + i * 1.13)
        ) * (1 + this._listeningMix * 0.65);
        this._bandVelocities[i] = velocity;
        this._bandAngles[i] += dt * velocity;
        this._bandCometPhase[i] += dt * cometVelocity;
      }

      this._scannerWavePhase1 += dt * 0.47;
      this._scannerWavePhase2 += dt * 0.79;
      const sweepBoost = 1 + this._thinkingMix;
      const scannerVelocity = (
        1.15 +
        0.22 * Math.sin(this._scannerWavePhase1) +
        0.11 * Math.sin(this._scannerWavePhase2)
      ) * sweepBoost;
      const counterVelocity = (
        -0.92 +
        0.18 * Math.sin(this._scannerWavePhase2 + 1.2) +
        0.09 * Math.sin(this._scannerWavePhase1 + 2.4)
      ) * sweepBoost;
      this._scannerPhase += dt * scannerVelocity;
      this._counterScannerPhase += dt * counterVelocity;

      this._tickWavePhase1 += dt * 0.41;
      this._tickWavePhase2 += dt * 0.73;
      this._tickMarqueePhase += dt * (
        1.28 +
        0.26 * Math.sin(this._tickWavePhase1) +
        0.13 * Math.sin(this._tickWavePhase2)
      );
      this._tickRotation += dt * (
        -0.08 +
        0.024 * Math.sin(this._tickWavePhase2 + 0.6) +
        0.012 * Math.sin(this._tickWavePhase1 + 1.8)
      );
      this._reticlePhase -= dt * (0.06 + Math.abs(this._bandVelocities[0]) * 0.15);
    }

    // spectrum: peak-per-band → drives the talking waveform; also overall amplitude
    let raw = this._manualAmp;
    if (this.analyser && this._audioActive) {
      this.analyser.getByteFrequencyData(this.freq);
      let s = 0;
      for (let i = 0; i < this.freq.length; i++) s += this.freq[i];
      raw = Math.max(raw, Math.min(1, (s / this.freq.length / 255) * 1.6));
      const usable = Math.floor(this.freq.length * 0.72); // voice energy sits low/mid
      for (let b = 0; b < this.NB; b++) {
        const i0 = Math.floor((b / this.NB) * usable);
        const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / this.NB) * usable));
        let m = 0;
        for (let i = i0; i < i1; i++) if (this.freq[i] > m) m = this.freq[i];
        const v = m / 255;
        this.bins[b] += (v - this.bins[b]) * (v > this.bins[b] ? 0.6 : 0.28); // snappy attack/release per band
      }
    } else if (this._synthSpeak && !this.reduced) {
      // speaking: TTS plays direct (WebKit-safe), so synthesize a lively speech
      // envelope to drive the talking waveform + equalizer.
      const env = 0.4 + 0.45 * Math.abs(Math.sin(t * 6.5)) * (0.55 + 0.45 * Math.sin(t * 2.1 + 0.7));
      raw = Math.max(raw, env);
      for (let b = 0; b < this.NB; b++) {
        const v = env * (0.35 + 0.65 * Math.abs(Math.sin(t * (3.2 + b * 0.45) + b * 1.3)));
        this.bins[b] += (v - this.bins[b]) * 0.4;
      }
    } else {
      for (let b = 0; b < this.NB; b++) this.bins[b] *= 0.88; // decay to calm when silent
    }
    this._manualAmp *= 0.9;
    // envelope follower for the overall swell/glow (smooth, not per-syllable jitter)
    const k = raw > this.cur.amp ? 0.3 : 0.07;
    this.cur.amp += (raw - this.cur.amp) * k;
    const amp = this.cur.amp;
    // publish the live voice amplitude so OTHER canvases (the BrainOrb's
    // "listening shimmer") can react to the user's real voice too
    window.__artemisAmp = amp;

    // Even silent idle has a 4–6 second sonar cadence. Speaking adds faster
    // peak ripples; both reuse the preallocated ripple pool.
    if (!this.reduced && this.status === "idle" && t >= this._nextSonarAt) {
      this._emitRipple(t, 0.68);
      this._nextSonarAt = t + 5 + Math.sin(t * 0.73) * 0.85;
    }
    if (!this.reduced && this.status === "speaking" &&
        amp > 0.16 && amp - this._prevAmp > 0.035 && t - this._lastRipple > 0.16) {
      this._emitRipple(t, amp);
      this._lastRipple = t;
    }
    this._prevAmp = amp;
    if (this._rippleCount) {
      let write = 0;
      for (let read = 0; read < this._rippleCount; read++) {
        const ripple = this._ripples[read];
        if (t - ripple.t0 >= 1.1) continue;
        if (write !== read) {
          this._ripples[write].t0 = ripple.t0;
          this._ripples[write].e = ripple.e;
        }
        write++;
      }
      this._rippleCount = write;
    }

    this._mx += (this._mouse.x - this._mx) * 0.06;
    this._my += (this._mouse.y - this._my) * 0.06;

    this._draw(t);
  }

  _draw(t) {
    const ctx = this.ctx, dpr = this.dpr, W = this.W, H = this.H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = this.center || this.narrow ? W * 0.5 : W * 0.64;
    const cy0 = this.narrow ? H * 0.46 : H * 0.5;
    const sp = this.reduced ? 0 : (this._scrollProg || 0);
    const cy = cy0 - sp * H * 0.32;     // orb rises + recedes as you scroll into the content
    const recede = 1 - sp * 0.28;
    const hudAlpha = 1 - sp * 0.45;

    // cool blue-black radial backdrop (follows the orb)
    const bgr = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.72);
    bgr.addColorStop(0, "#061923");
    bgr.addColorStop(0.55, "#040b11");
    bgr.addColorStop(1, "#020509");
    ctx.fillStyle = bgr;
    ctx.fillRect(0, 0, W, H);

    // faint grid
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = PAL.D + "0.05)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 38) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += 38) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    const amp = this.cur.amp;
    const spin = 1;
    const base = Math.min(W, H) * 0.40 * recede;
    const R = base * 0.52;              // sphere radius in px; rings extend to ~1.6 R
    // ---- 3D camera: rotate the scene (auto-spin + look toward the cursor),
    // then perspective-project. P() maps unit-sphere coords → screen offset
    // from the orb centre, returning depth z (+ = toward you) and scale s. ----
    const yaw = (this.reduced ? 0 : t * 0.16 * spin) + this._mx * 0.7;
    const pitch = 0.42 + this._my * 0.42;
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), cp = Math.cos(pitch), sp_ = Math.sin(pitch);
    const CAM = 3.2;                    // camera distance in radius units
    const P = (px, py, pz) => {
      const x1 = px * cy_ + pz * sy_;
      const z1 = -px * sy_ + pz * cy_;
      const y2 = py * cp - z1 * sp_;
      const z2 = py * sp_ + z1 * cp;
      const s = CAM / (CAM - z2);
      return { x: x1 * R * s, y: y2 * R * s, z: z2, s };
    };
    const dA = (z, lo, hi) => lo + (hi - lo) * Math.max(0, Math.min(1, (z + 1.6) / 3.2)); // depth→alpha

    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = hudAlpha;         // fade the orb as you scroll into content
    ctx.globalCompositeOperation = "lighter";

    // ---- (1) far-hemisphere particles (drawn first, behind the core) ----
    const drawParticles = (front) => {
      for (const p of this._particles) {
        const sh = 1.16 + 0.05 * Math.sin(t * 1.4 + p.tw * 6.28); // gently breathing shell
        const q = P(p.x * sh, p.y * sh, p.z * sh);
        if (front ? q.z < 0 : q.z >= 0) continue;
        const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + p.tw * 6.28);
        const a = dA(q.z, 0.05, 0.5) * (0.5 + 0.5 * tw) * (0.7 + amp * 0.6);
        ctx.fillStyle = PAL.B + a.toFixed(3) + ")";
        ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(0.4, 1.4 * q.s * (0.8 + amp * 0.5)), 0, Math.PI * 2); ctx.fill();
      }
    };
    drawParticles(false);

    // ---- (2) orbital rings behind the core (far halves) + satellites ----
    const drawRing = (cfg, front) => {
      const ct = Math.cos(cfg.tl), st = Math.sin(cfg.tl), cr = Math.cos(cfg.roll), sr = Math.sin(cfg.roll);
      const rp = (a) => {
        // circle in its plane → local tilt (X) → local roll (Y) → global P
        let x = Math.cos(a) * cfg.rr, z = Math.sin(a) * cfg.rr, y = 0;
        let y1 = y * ct - z * st, z1 = y * st + z * ct;         // tilt about X
        let x2 = x * cr + z1 * sr, z2 = -x * sr + z1 * cr;      // roll about Y
        return P(x2, y1, z2);
      };
      const SEG = 72;
      ctx.lineWidth = 1 + amp * 0.6;
      for (let i = 0; i < SEG; i++) {
        const q0 = rp((i / SEG) * Math.PI * 2), q1 = rp(((i + 1) / SEG) * Math.PI * 2);
        const zc = (q0.z + q1.z) / 2;
        if (front ? zc < 0 : zc >= 0) continue;
        ctx.strokeStyle = PAL.O + (dA(zc, 0.05, 0.34 + amp * 0.3)).toFixed(3) + ")";
        ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
      }
      // satellite riding the ring + constellation link back to the core
      const sat = rp(t * cfg.spd * spin + cfg.ph);
      if ((front ? sat.z >= 0 : sat.z < 0)) {
        ctx.strokeStyle = PAL.B + (dA(sat.z, 0.05, 0.3) + amp * 0.3).toFixed(3) + ")";
        ctx.lineWidth = 1 + amp * 0.5;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(sat.x, sat.y); ctx.stroke();
        ctx.fillStyle = PAL.B + Math.min(1, dA(sat.z, 0.4, 1)).toFixed(3) + ")";
        ctx.shadowColor = PAL.B + "0.9)"; ctx.shadowBlur = (6 + amp * 14) * sat.s;
        ctx.beginPath(); ctx.arc(sat.x, sat.y, (2 + 2.6 * sat.s) * (1 + amp * 0.6), 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    };
    for (const cfg of this._rings) drawRing(cfg, false); // far halves

    // ---- (3) continuously moving arc-reactor core ----
    const activeMix = Math.min(1, this._listeningMix + this._thinkingMix + this._speakingMix);
    const idleMix = 1 - activeMix;
    const slowPlasma = 0.68 * Math.sin(t * 0.92) + 0.32 * Math.sin(t * 0.37 + 1.1);
    const microPlasma = 0.62 * Math.sin(t * 11.7 + 0.4) + 0.38 * Math.sin(t * 17.3 + 1.9);
    const speakingPulse = this._speakingMix * amp;
    const coreR = R * 0.16 * (
      1 +
      slowPlasma * (0.018 + idleMix * 0.012) +
      microPlasma * 0.012 +
      speakingPulse * 0.48
    );
    const contraction = 1 - this._listeningMix * 0.11;
    const bandBoost = this._listeningMix * 0.28;
    const bandBrightness = 1 + this._listeningMix * 0.42;

    // One 72-tick pass carries both the base scale and its moving marquee.
    const tickR = R * 0.86, tickLen = R * 0.034;
    ctx.lineWidth = 1.2;
    ctx.shadowColor = PAL.GLOW;
    ctx.shadowBlur = 3;
    for (let i = 0; i < TICK_COUNT; i++) {
      const ang = this._tickRotation + (i / TICK_COUNT) * TAU;
      const co = Math.cos(ang), si = Math.sin(ang);
      const wave = 0.5 + 0.5 * Math.cos(ang - this._tickMarqueePhase);
      const crest = wave * wave * wave * wave * wave * wave;
      ctx.strokeStyle = (crest > 0.08 ? PAL.B : PAL.D) +
        Math.min(1, 0.2 + bandBoost * 0.45 + crest * 0.72) + ")";
      ctx.beginPath();
      ctx.moveTo(co * tickR, si * tickR);
      ctx.lineTo(co * (tickR - tickLen * (1 + crest * 0.55)), si * (tickR - tickLen * (1 + crest * 0.55)));
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Segment endpoints morph in preallocated pairs while each band's velocity
    // waves independently. Comets advance faster than their host band.
    ctx.shadowColor = PAL.GLOW;
    for (let i = 0; i < REACTOR_BANDS.length; i++) {
      const band = REACTOR_BANDS[i];
      const segments = this._bandSegments[i];
      for (let j = 0; j < segments.length; j++) {
        const morph = band.morphAmp * Math.sin(this._bandMorphPhase[i] + j * 1.61803398875);
        const drift = band.morphAmp * 0.32 * Math.sin(this._bandMorphPhase[i] * 0.61 + j * 0.87);
        segments[j][0] = band.segments[j][0] + morph + drift;
        segments[j][1] = band.segments[j][1] - morph * 0.82 + drift;
      }
      const bandR = R * band.radius * contraction;
      strokeArcSegments(
        ctx,
        bandR,
        segments,
        Math.max(1, R * band.width),
        this._bandAngles[i],
        band.color,
        Math.min(1, band.alpha * bandBrightness),
        band.blur + this._listeningMix * 5
      );
    }

    // Trail levels share a path: five fills render every comet on all bands.
    ctx.shadowColor = PAL.GLOW;
    for (let trail = COMET_TRAIL_STEPS; trail >= 0; trail--) {
      const fade = 1 - trail / (COMET_TRAIL_STEPS + 1);
      const dotR = Math.max(0.7, R * (0.006 + fade * 0.009));
      const alpha = Math.min(1, (0.1 + 0.8 * fade * fade) * (1 + bandBoost * 0.35));
      ctx.fillStyle = (trail ? PAL.B : PAL.Hl) + alpha + ")";
      ctx.shadowBlur = trail ? 0 : 8 + this._listeningMix * 5;
      ctx.beginPath();
      for (let i = 0; i < REACTOR_BANDS.length; i++) {
        const band = REACTOR_BANDS[i];
        const bandR = R * band.radius * contraction;
        const cometDirection = band.cometRate < 0 ? -1 : 1;
        const cometBase = this._bandAngles[i] + this._bandCometPhase[i];
        for (let comet = 0; comet < band.cometCount; comet++) {
          const headAngle = cometBase + (comet / band.cometCount) * TAU;
          const trailAngle = headAngle - cometDirection * trail * (
            0.032 + 0.008 * Math.abs(Math.sin(this._bandWavePhase1[i] + comet))
          );
          const x = Math.cos(trailAngle) * bandR, y = Math.sin(trailAngle) * bandR;
          ctx.moveTo(x + dotR, y);
          ctx.arc(x, y, dotR, 0, TAU);
        }
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // The primary radar is always live. Thinking eases in a second sweep in
    // the opposite direction; both clocks are velocity-modulated in _loop.
    strokeArcSegments(
      ctx,
      R * 0.78,
      SCANNER_SEGMENTS,
      Math.max(2, R * 0.024),
      this._scannerPhase,
      PAL.B,
      0.62 + bandBoost * 0.35,
      8 + this._thinkingMix * 4
    );
    strokeArcSegments(
      ctx,
      R * 0.75,
      SCANNER_SEGMENTS,
      Math.max(1.5, R * 0.018),
      this._counterScannerPhase,
      PAL.O,
      0.72 * this._thinkingMix,
      8 * this._thinkingMix
    );

    drawHudRing(ctx, coreR * 1.52, Math.max(1, R * 0.009), PAL.Hl, 0.78, 4);
    drawHudPoly(ctx, coreR * 1.38, 6, this._reticlePhase, Math.max(1, R * 0.008), PAL.B, 0.72);
    const coreBrightness = Math.max(0.7, Math.min(
      1,
      0.86 + slowPlasma * 0.045 + microPlasma * 0.065 + speakingPulse * 0.12
    ));
    ctx.shadowColor = PAL.GLOW;
    ctx.shadowBlur = R * (
      0.1 +
      (slowPlasma + 1) * 0.018 +
      Math.abs(microPlasma) * 0.025 +
      speakingPulse * 0.4
    );
    ctx.fillStyle = PAL.B + coreBrightness + ")";
    ctx.beginPath(); ctx.arc(0, 0, coreR, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = PAL.B + Math.min(1, coreBrightness + 0.08) + ")";
    ctx.beginPath(); ctx.arc(0, 0, coreR * 0.76, 0, TAU); ctx.fill();
    ctx.fillStyle = PAL.Hl + Math.min(1, 0.9 + microPlasma * 0.055 + speakingPulse * 0.08) + ")";
    ctx.beginPath(); ctx.arc(0, 0, coreR * 0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = PAL.Hl + Math.min(1, 0.96 + microPlasma * 0.03 + speakingPulse * 0.04) + ")";
    ctx.beginPath(); ctx.arc(0, 0, coreR * 0.24, 0, TAU); ctx.fill();

    // ---- (5) front-hemisphere rings + particles (drawn last → in front) ----
    for (const cfg of this._rings) drawRing(cfg, true);
    drawParticles(true);

    // ---- (6) outer flat HUD bezel (the instrument frame around the 3D orb) ----
    drawHudArcs(ctx, base * 0.98, OUTER_BEZEL_SEGMENTS, 2, t * 0.09 * spin, PAL.O, 0.4 + amp * 0.45, 6 + amp * 10);
    drawHudTicks(ctx, base * 0.9, 42, base * 0.035 * (1 + amp * 0.6), -t * 0.05 * spin, PAL.D, 0.4 + amp * 0.45);

    // Sonar, state-shockwave, and speaking ripples ease outward from the core.
    for (let i = 0; i < this._rippleCount; i++) {
      const rp = this._ripples[i], age = t - rp.t0;
      const progress = Math.max(0, Math.min(1, age / 1.1));
      const life = 1 - progress;
      if (life <= 0) continue;
      const expansion = 1 - (1 - progress) * (1 - progress);
      ctx.lineWidth = 1.8 * life;
      ctx.strokeStyle = PAL.O + (0.42 * life * rp.e) + ")";
      ctx.beginPath(); ctx.arc(0, 0, R * 0.18 + expansion * base * 0.62, 0, TAU); ctx.stroke();
    }
    ctx.restore();

    // crisp ARTEMIS label
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = PAL.Hl + ((0.82 + 0.18 * Math.sin(t * 2.6)) * hudAlpha) + ")";
    ctx.font = "600 " + Math.round(base * 0.082) + 'px "JetBrains Mono", monospace';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = PAL.O + "0.85)"; ctx.shadowBlur = 14;
    ctx.fillText("A R T E M I S", cx, cy);
    ctx.shadowBlur = 0;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("pointermove", this._onMouse);
    window.removeEventListener("scroll", this._onScroll);
    document.removeEventListener("visibilitychange", this._onVis);
    this.stopAudio();
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) {}
    }
    if (this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
  }
}
