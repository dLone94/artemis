// Artemis VoiceOrb — the cyan orbital-HUD (Canvas 2D), ported verbatim from the
// locked prototype: soft cyan core, tilted orbital rings with depth-shaded
// satellites + constellation links, tick ring, hex/triangle reticle, ARTEMIS label.
// Backend-agnostic API kept identical to the old WebGL orb so main.js / celebration.js
// work unchanged: setStatus(), connectMic(), connectMediaElement(), feed(), _ensureAudio(),
// stopAudio(), dispose(), and `cur.amp` / `reduced`. Reacts to mic (LISTENING) and TTS
// (SPEAKING) amplitude — rings spin faster, core brightens, scanner accelerates.

import { PAL, prefersReducedMotion } from "./orbShared.js";

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
    this._ripples = [];                 // expanding sound-waves on speech peaks
    this._prevAmp = 0;
    this._lastRipple = -1;
    this._audioActive = false;
    this._raf = 0;
    this._disposed = false;

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
        this._t0 = performance.now() - this._elapsed * 1000;
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
    if (s === "idle" || s === "listening" || s === "thinking" || s === "speaking") this.status = s;
    if (this.reduced) this._loop(); // reduced motion: repaint one frame for the new state
  }

  feed(a) {
    const v = Math.max(0, Math.min(1, Number(a) || 0));
    if (v > this._manualAmp) this._manualAmp = v;
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
    this._elapsed = (now - this._t0) / 1000;
    const t = this.reduced ? 0 : this._elapsed;

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

    // emit an expanding ripple on a speech peak (with cooldown so it's not spammy)
    if (!this.reduced && amp > 0.16 && amp - this._prevAmp > 0.035 && t - this._lastRipple > 0.16) {
      this._ripples.push({ t0: t, e: Math.min(1, amp) });
      this._lastRipple = t;
    }
    this._prevAmp = amp;
    if (this._ripples.length) this._ripples = this._ripples.filter((rp) => t - rp.t0 < 1.1);

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

    // ---- (3) the glowing core: soft body + voice-reactive corona + equalizer ----
    const pulse = 0.55 + 0.16 * Math.sin(t * 1.5) + amp * 0.8;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.85);
    g.addColorStop(0, PAL.Hl + (0.42 * pulse) + ")");
    g.addColorStop(0.4, PAL.O + (0.24 * pulse) + ")");
    g.addColorStop(1, PAL.D + "0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * 0.85, 0, Math.PI * 2); ctx.fill();
    {
      const NB = this.NB, q3 = Math.max(1, Math.floor(NB / 3));
      let bass = 0, mid = 0, treb = 0;
      for (let b = 0; b < q3; b++) bass += this.bins[b];
      for (let b = q3; b < 2 * q3; b++) mid += this.bins[b];
      for (let b = 2 * q3; b < NB; b++) treb += this.bins[b];
      bass /= q3; mid /= q3; treb /= (NB - 2 * q3);
      const pts = 96, rb = R * 0.42;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const ang = (i / pts) * Math.PI * 2;
        const idle = 0.04 * Math.sin(ang * 3 + t * 1.2) + 0.03 * Math.sin(ang * 5 - t * 0.9);
        const voice = bass * 0.55 * Math.sin(2 * ang + t * 0.9) + mid * 0.45 * Math.sin(3 * ang - t * 1.3) +
          treb * 0.38 * Math.sin(5 * ang + t * 1.7) + bass * 0.3 * Math.sin(ang - t * 0.6);
        const rr = rb * (1 + idle + voice), x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, rb * 1.8);
      bg.addColorStop(0, PAL.Hl + (0.5 + amp * 0.45) + ")");
      bg.addColorStop(0.55, PAL.O + (0.3 + amp * 0.4) + ")");
      bg.addColorStop(1, PAL.O + "0)");
      ctx.fillStyle = bg; ctx.shadowColor = PAL.O + "0.7)"; ctx.shadowBlur = 20; ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = 1.4; ctx.strokeStyle = PAL.B + (0.4 + amp * 0.5) + ")"; ctx.stroke();

      const bars = NB * 2, r0 = R * 0.56, bl = R * 0.34;
      ctx.lineCap = "round"; ctx.lineWidth = 2;
      for (let j = 0; j < bars; j++) {
        const ang = (j / bars) * Math.PI * 2;
        const bidx = (((j / bars) * NB + t * 3.0) % NB + NB) % NB;
        const b0 = Math.floor(bidx) % NB, b1 = (b0 + 1) % NB, fr = bidx - Math.floor(bidx);
        const bv = this.bins[b0] * (1 - fr) + this.bins[b1] * fr, co = Math.cos(ang), si = Math.sin(ang);
        const len = bl * (0.08 + bv * (1.0 + amp * 0.6));
        ctx.strokeStyle = PAL.B + (0.22 + 0.6 * bv) + ")";
        ctx.beginPath(); ctx.moveTo(co * r0, si * r0); ctx.lineTo(co * (r0 + len), si * (r0 + len)); ctx.stroke();
      }
      ctx.lineCap = "butt";
    }

    // ---- (4) wireframe sphere over the core — the 3D globe (self-shading by
    // depth: near segments bright, far segments dim, so rotation reads) ----
    const drawLine = (pfn, seg) => {
      let prev = pfn(0);
      for (let i = 1; i <= seg; i++) {
        const q = pfn(i / seg);
        const zc = (prev.z + q.z) / 2;
        ctx.strokeStyle = PAL.O + dA(zc, 0.04, 0.28 + amp * 0.22).toFixed(3) + ")";
        ctx.lineWidth = (0.5 + 0.7 * q.s);
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        prev = q;
      }
    };
    const globe = 1 + amp * 0.1;        // breathes with her voice
    for (let li = 0; li < 5; li++) {    // latitude circles
      const lat = (li / 4 - 0.5) * Math.PI * 0.82, cyl = Math.cos(lat) * globe, yl = Math.sin(lat) * globe;
      drawLine((u) => { const a = u * Math.PI * 2; return P(Math.cos(a) * cyl, yl, Math.sin(a) * cyl); }, 44);
    }
    for (let mi = 0; mi < 6; mi++) {    // longitude half-circles
      const lon = (mi / 6) * Math.PI;
      drawLine((u) => { const a = (u - 0.5) * Math.PI; const r2 = Math.cos(a) * globe, yy = Math.sin(a) * globe;
        return P(r2 * Math.cos(lon), yy, r2 * Math.sin(lon)); }, 40);
    }

    // ---- (5) front-hemisphere rings + particles (drawn last → in front) ----
    for (const cfg of this._rings) drawRing(cfg, true);
    drawParticles(true);

    // ---- (6) outer flat HUD bezel (the instrument frame around the 3D orb) ----
    const arcs = (r, segs, w, rot, c, a, blur) => {
      ctx.lineWidth = w; ctx.strokeStyle = c + a + ")"; ctx.lineCap = "round";
      ctx.shadowColor = PAL.GLOW; ctx.shadowBlur = blur || 0;
      for (let i = 0; i < segs.length; i++) { ctx.beginPath(); ctx.arc(0, 0, r, rot + segs[i][0], rot + segs[i][1]); ctx.stroke(); }
      ctx.shadowBlur = 0; ctx.lineCap = "butt";
    };
    arcs(base * 0.98, [[0.1, 1.5], [2.2, 3.0], [3.6, 5.2]], 2, t * 0.09 * spin, PAL.O, 0.4 + amp * 0.45, 6 + amp * 10);
    ctx.strokeStyle = PAL.D + (0.4 + amp * 0.45) + ")"; ctx.lineWidth = 1; // tick ring
    for (let i = 0; i < 42; i++) {
      const ang = -t * 0.05 * spin + (i / 42) * Math.PI * 2, co = Math.cos(ang), si = Math.sin(ang);
      const rr = base * 0.90, len = base * 0.035 * (1 + amp * 0.6);
      ctx.beginPath(); ctx.moveTo(co * rr, si * rr); ctx.lineTo(co * (rr - len), si * (rr - len)); ctx.stroke();
    }
    arcs(base * 0.6, [[0.5, 2.4]], 4 + amp * 3, t * 0.5 * spin, PAL.B, 0.7 + amp * 0.4, 12); // scanner sweep

    // sound-wave ripples on speech peaks
    for (let i = 0; i < this._ripples.length; i++) {
      const rp = this._ripples[i], age = t - rp.t0, life = 1 - age / 1.1;
      if (life <= 0) continue;
      ctx.lineWidth = 1.8 * life;
      ctx.strokeStyle = PAL.O + (0.42 * life * rp.e) + ")";
      ctx.beginPath(); ctx.arc(0, 0, R * 0.5 + age * base * 0.55, 0, Math.PI * 2); ctx.stroke();
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
