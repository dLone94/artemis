// Artemis VoiceOrb — the orange orbital-HUD (Canvas 2D), ported verbatim from the
// locked prototype: soft amber core, tilted orbital rings with depth-shaded
// satellites + constellation links, tick ring, hex/triangle reticle, ARTEMIS label.
// Backend-agnostic API kept identical to the old WebGL orb so main.js / celebration.js
// work unchanged: setStatus(), connectMic(), connectMediaElement(), feed(), _ensureAudio(),
// stopAudio(), dispose(), and `cur.amp` / `reduced`. Reacts to mic (LISTENING) and TTS
// (SPEAKING) amplitude — rings spin faster, core brightens, scanner accelerates.

import { prefersReducedMotion } from "./orbShared.js";

export class VoiceOrb {
  constructor(container, opts = {}) {
    this.container = container;
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

    const cx = this.narrow ? W * 0.5 : W * 0.64;
    const cy0 = this.narrow ? H * 0.46 : H * 0.5;
    const sp = this.reduced ? 0 : (this._scrollProg || 0);
    const cy = cy0 - sp * H * 0.32;     // orb rises + recedes as you scroll into the content
    const recede = 1 - sp * 0.28;
    const hudAlpha = 1 - sp * 0.45;

    // warm radial backdrop (follows the orb)
    const bgr = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.72);
    bgr.addColorStop(0, "#140d07");
    bgr.addColorStop(0.55, "#0b0805");
    bgr.addColorStop(1, "#070403");
    ctx.fillStyle = bgr;
    ctx.fillRect(0, 0, W, H);

    // faint grid
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(150,90,40,0.05)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 38) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += 38) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    const amp = this.cur.amp;
    const spin = 1; // steady rotation — her voice drives brightness + a gentle swell, not spin speed
    const base = Math.min(W, H) * 0.40 * recede;

    const O = "rgba(255,158,72,", B = "rgba(255,202,140,", Hl = "rgba(255,232,205,", D = "rgba(208,150,98,";
    const GLOW = "rgba(255,150,70,0.55)";

    const ring = (r, w, c, a, blur) => {
      ctx.beginPath(); ctx.lineWidth = w; ctx.strokeStyle = c + a + ")";
      ctx.shadowColor = GLOW; ctx.shadowBlur = blur || 0; ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
    };
    const arcs = (r, segs, w, rot, c, a, blur) => {
      ctx.lineWidth = w; ctx.strokeStyle = c + a + ")"; ctx.lineCap = "round";
      ctx.shadowColor = GLOW; ctx.shadowBlur = blur || 0;
      for (let i = 0; i < segs.length; i++) { ctx.beginPath(); ctx.arc(0, 0, r, rot + segs[i][0], rot + segs[i][1]); ctx.stroke(); }
      ctx.shadowBlur = 0; ctx.lineCap = "butt";
    };
    const ticks = (r, n, len, rot, c, a) => {
      ctx.strokeStyle = c + a + ")"; ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) { const ang = rot + (i / n) * Math.PI * 2, co = Math.cos(ang), si = Math.sin(ang);
        ctx.beginPath(); ctx.moveTo(co * r, si * r); ctx.lineTo(co * (r - len), si * (r - len)); ctx.stroke(); }
    };
    const poly = (r, sides, rot, w, c, a) => {
      ctx.beginPath(); ctx.lineWidth = w; ctx.strokeStyle = c + a + ")";
      for (let i = 0; i <= sides; i++) { const ang = rot + (i / sides) * Math.PI * 2, x = Math.cos(ang) * r, y = Math.sin(ang) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    };
    const orbit = (rx, ry, tilt, phase, a) => {
      ctx.save(); ctx.rotate(tilt);
      ctx.beginPath(); ctx.lineWidth = 1 + amp * 0.6; ctx.strokeStyle = O + (a * 0.4 + amp * 0.4) + ")";
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      const px = Math.cos(phase) * rx, py = Math.sin(phase) * ry, depth = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase));
      ctx.fillStyle = B + depth + ")"; ctx.shadowColor = "rgba(255,180,110,0.9)"; ctx.shadowBlur = (8 + amp * 16) * depth;
      ctx.beginPath(); ctx.arc(px, py, (2.4 + 2.8 * depth) * (1 + amp * 0.7), 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      const wx = Math.cos(tilt) * px - Math.sin(tilt) * py, wy = Math.sin(tilt) * px + Math.cos(tilt) * py;
      ctx.restore(); return [wx, wy, depth];
    };

    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = hudAlpha; // fade the orb out as you scroll into the content
    const vScale = 1 + amp * 0.11; // the whole orb breathes with her voice
    ctx.scale(vScale, vScale);
    ctx.transform(1, this._my * 0.05, this._mx * 0.05, 0.92 - Math.abs(this._my) * 0.05, 0, 0);
    ctx.globalCompositeOperation = "lighter";

    // soft amber core (low intensity → easy on the eyes); brightens with her voice
    const pulse = 0.55 + 0.16 * Math.sin(t * 1.5) + amp * 0.8;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.40);
    g.addColorStop(0, "rgba(255,228,195," + (0.42 * pulse) + ")");
    g.addColorStop(0.4, "rgba(255,150,70," + (0.24 * pulse) + ")");
    g.addColorStop(1, "rgba(180,80,30,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, base * 0.40, 0, Math.PI * 2); ctx.fill();

    // reactive "talking" core — bass/mid/treble drive travelling harmonic lobes so the
    // whole rim morphs all the way around (not one side), + a rotating equalizer corona
    {
      const NB = this.NB, q = Math.max(1, Math.floor(NB / 3));
      let bass = 0, mid = 0, treb = 0;
      for (let b = 0; b < q; b++) bass += this.bins[b];
      for (let b = q; b < 2 * q; b++) mid += this.bins[b];
      for (let b = 2 * q; b < NB; b++) treb += this.bins[b];
      bass /= q; mid /= q; treb /= (NB - 2 * q);
      const pts = 96, rb = base * 0.2;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const ang = (i / pts) * Math.PI * 2;
        const idle = 0.04 * Math.sin(ang * 3 + t * 1.2) + 0.03 * Math.sin(ang * 5 - t * 0.9);
        const voice =
          bass * 0.55 * Math.sin(2 * ang + t * 0.9) +
          mid * 0.45 * Math.sin(3 * ang - t * 1.3) +
          treb * 0.38 * Math.sin(5 * ang + t * 1.7) +
          bass * 0.3 * Math.sin(ang - t * 0.6);
        const rr = rb * (1 + idle + voice);
        const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, rb * 1.8);
      bg.addColorStop(0, "rgba(255,234,206," + (0.5 + amp * 0.45) + ")");
      bg.addColorStop(0.55, "rgba(255,150,70," + (0.3 + amp * 0.4) + ")");
      bg.addColorStop(1, "rgba(255,120,50,0)");
      ctx.fillStyle = bg; ctx.shadowColor = "rgba(255,150,70,0.7)"; ctx.shadowBlur = 20; ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(255,216,164," + (0.4 + amp * 0.5) + ")"; ctx.stroke();

      // travelling equalizer corona — the spectrum wraps the full circle and rotates
      const bars = NB * 2, r0 = base * 0.27, bl = base * 0.16;
      ctx.lineCap = "round"; ctx.lineWidth = 2;
      for (let j = 0; j < bars; j++) {
        const ang = (j / bars) * Math.PI * 2;
        const bidx = (((j / bars) * NB + t * 3.0) % NB + NB) % NB;
        const b0 = Math.floor(bidx) % NB, b1 = (b0 + 1) % NB, fr = bidx - Math.floor(bidx);
        const bv = this.bins[b0] * (1 - fr) + this.bins[b1] * fr;
        const co = Math.cos(ang), si = Math.sin(ang);
        const len = bl * (0.08 + bv * (1.0 + amp * 0.6));
        ctx.strokeStyle = "rgba(255,190,120," + (0.22 + 0.6 * bv) + ")";
        ctx.beginPath(); ctx.moveTo(co * r0, si * r0); ctx.lineTo(co * (r0 + len), si * (r0 + len)); ctx.stroke();
      }
      ctx.lineCap = "butt";
    }

    // outer broken ring + ticks (brighten + tick-length pulses with her voice)
    arcs(base * 0.96, [[0.1, 1.5], [2.2, 3.0], [3.6, 5.2]], 2, t * 0.09 * spin, O, 0.4 + amp * 0.45, 6 + amp * 10);
    ticks(base * 0.88, 42, base * 0.035 * (1 + amp * 0.6), -t * 0.05 * spin, D, 0.4 + amp * 0.45);
    ring(base * 0.82, 1, O, 0.3 + amp * 0.4, 4);

    // tilted orbital rings + satellites + constellation links
    const n1 = orbit(base * 0.74, base * 0.30, 0.5, t * 0.7 * spin, 0.9);
    const n2 = orbit(base * 0.66, base * 0.66, -0.9, -t * 0.55 * spin + 2.0, 0.9);
    const n3 = orbit(base * 0.52, base * 0.20, 1.4, t * 0.9 * spin + 1.0, 0.9);
    const links = [n1, n2, n3];
    for (let i = 0; i < links.length; i++) {
      const nd = links[i];
      ctx.beginPath(); ctx.lineWidth = 1 + amp * 0.5; ctx.strokeStyle = B + (0.1 + 0.18 * nd[2] + amp * 0.35) + ")";
      ctx.moveTo(0, 0); ctx.lineTo(nd[0], nd[1]); ctx.stroke();
    }

    // soft scanner arc + ring + reticle (react with her voice)
    arcs(base * 0.58, [[0.5, 2.4]], 4 + amp * 3, t * 0.5 * spin, B, 0.7 + amp * 0.4, 12);
    ring(base * 0.40, 1, O, 0.4 + amp * 0.4, 4);
    poly(base * (0.46 + amp * 0.05), 6, t * 0.18 * spin, 1.2, B, 0.5 + amp * 0.4); // hex reticle (frames the equalizer, breathes)

    // sound-wave ripples emanating outward on speech peaks
    for (let i = 0; i < this._ripples.length; i++) {
      const rp = this._ripples[i], age = t - rp.t0, life = 1 - age / 1.1;
      if (life <= 0) continue;
      ctx.lineWidth = 1.8 * life;
      ctx.strokeStyle = "rgba(255,178,98," + (0.42 * life * rp.e) + ")";
      ctx.beginPath(); ctx.arc(0, 0, base * 0.2 + age * base * 0.55, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // crisp ARTEMIS label
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(255,232,205," + ((0.82 + 0.18 * Math.sin(t * 2.6)) * hudAlpha) + ")";
    ctx.font = "600 " + Math.round(base * 0.082) + 'px "JetBrains Mono", monospace';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(255,170,90,0.85)"; ctx.shadowBlur = 14;
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
