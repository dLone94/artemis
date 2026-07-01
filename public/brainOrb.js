// BrainOrb — the EXPLANATORY orb for the #brain section. Same amber orbital-HUD
// visual language as the hero VoiceOrb (via ./orbShared.js), but instead of being
// audio-driven it's driven by a discrete pipeline STATE MACHINE:
//   wake → route → tool → respond
// and it renders the three real sub-agents (Research, Email triage, Messaging) as
// orbiting nodes, lighting up whichever one is handling the request.
//
// Public API: new BrainOrb(container); setStep(0..3); setAgent(0..2); .step / .agent;
// dispose(). It runs inline (sized to its container), pauses when off-screen or the
// tab is hidden, and renders a single static frame under prefers-reduced-motion.

import { PAL, prefersReducedMotion, arcs, ticks, poly } from "./orbShared.js";

// The real sub-agents, each on its own tilted orbit. rgb picked to match the team cards.
const AGENTS = [
  { name: "Research",     rgb: [255, 184, 107], tilt: 0.5,  rx: 0.74, ry: 0.30, phase: 0.0 },
  { name: "Email triage", rgb: [255, 201, 138], tilt: -0.9, rx: 0.66, ry: 0.66, phase: 2.1 },
  { name: "Messaging",    rgb: [255, 166, 77],  tilt: 1.4,  rx: 0.55, ry: 0.22, phase: 4.0 }
];

export const BRAIN_STEPS = ["wake", "route", "tool", "respond"];
export const BRAIN_AGENTS = AGENTS.map((a) => a.name);

export class BrainOrb {
  constructor(container) {
    this.container = container;
    this.reduced = prefersReducedMotion();
    this.step = 0;      // 0 wake · 1 route · 2 tool · 3 respond
    this.agent = 0;     // which sub-agent is handling the request
    this._stepStart = 0;
    this._stepF = 0;   // continuous (morphing) step position, eased toward .step
    this._lastT = 0;   // for delta-time easing
    this._elapsed = 0;
    this._raf = 0;
    this._vis = true;
    this._disposed = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.cv = document.createElement("canvas");
    this.cv.style.cssText = "display:block;width:100%;height:100%;";
    container.appendChild(this.cv);
    this.ctx = this.cv.getContext("2d");
    // frames render OFFSCREEN and blit on success — if a frame ever throws,
    // the visible canvas keeps the last good frame instead of going blank
    this.off = document.createElement("canvas");
    this.octx = this.off.getContext("2d");
    this._warned = false;

    this._resize();
    this._onResize = () => this._resize();
    if ("ResizeObserver" in window) {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(container);
    } else {
      window.addEventListener("resize", this._onResize);
    }

    // only animate while the section is on screen
    if ("IntersectionObserver" in window) {
      this._vis = false;
      this._io = new IntersectionObserver(
        (es) => es.forEach((e) => { this._vis = e.isIntersecting; }),
        { rootMargin: "80px" }
      );
      this._io.observe(container);
    }

    // mouse-parallax tilt (subtle: ≤6px translate, ≤3° rotate) — motion, so
    // it's fully disabled under prefers-reduced-motion
    this._px = 0; this._py = 0;   // smoothed parallax position (-1..1)
    this._tx = 0; this._ty = 0;   // raw target from the pointer
    if (!this.reduced) {
      this._onMove = (e) => {
        const r = this.cv.getBoundingClientRect();
        if (!r.width || !r.height) return;
        this._tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
        this._ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
      };
      window.addEventListener("pointermove", this._onMove, { passive: true });
    }

    this._t0 = performance.now();
    if (this.reduced) this._draw(0.6); // one static, representative frame
    else this._loop();
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.off.width = this.cv.width;
    this.off.height = this.cv.height;
    if (this.reduced) this._draw(0.6);
  }

  setStep(step) {
    step = Math.max(0, Math.min(3, step | 0));
    if (step !== this.step) { this.step = step; this._stepStart = this._elapsed; }
    if (this.reduced) this._draw(0.6);
  }

  setAgent(idx) {
    this.agent = Math.max(0, Math.min(AGENTS.length - 1, idx | 0));
    if (this.reduced) this._draw(0.6);
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (document.hidden || !this._vis) return;
    this._elapsed = (performance.now() - this._t0) / 1000;
    this._draw(this._elapsed);
  }

  // Crash-proof frame: render offscreen, blit only on success. A bad frame can
  // no longer blank the canvas — the last good frame stays up, and we warn ONCE
  // instead of spamming (or killing) the RAF loop.
  _draw(t) {
    // a 0/1px transient layout (hidden pane, pre-layout RO tick) has nothing
    // meaningful to draw — and tiny bases are what made derived radii negative
    if (this.W < 4 || this.H < 4) return;
    try {
      this._render(t);
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.cv.width, this.cv.height);
      c.drawImage(this.off, 0, 0);
    } catch (e) {
      if (!this._warned) {
        this._warned = true;
        console.warn("BrainOrb: frame error (keeping last good frame):", e);
      }
    }
  }

  _render(t) {
    const ctx = this.octx, dpr = this.dpr, W = this.W, H = this.H;

    // ease the parallax toward the pointer (0 when reduced — listeners never attach)
    this._px += (this._tx - this._px) * 0.06;
    this._py += (this._ty - this._py) * 0.06;
    const parX = this._px * 6, parY = this._py * 6; // ≤6px translate

    ctx.setTransform(dpr, 0, 0, dpr, parX * dpr, parY * dpr); // whole orb shifts together
    ctx.clearRect(-parX - 8, -parY - 8, W + 16, H + 16); // transparent — sits on the section background

    const cx = W / 2, cy = H / 2;
    const base = Math.min(W, H) * 0.42;
    const tt = this.reduced ? 0.6 : t; // frozen phase under reduced motion
    const step = this.step;

    // --- "4D" state morphing: _stepF eases toward the discrete step with
    // DELTA-TIME, and every state feature fades by its proximity weight, so
    // Wake→Route→Tool→Respond interpolate continuously instead of snapping.
    // Reduced motion: pinned to the exact step (one static frame, no tween).
    if (this.reduced) {
      this._stepF = step;
    } else {
      const dt = Math.min(0.1, Math.max(0, t - (this._lastT || t)));
      this._lastT = t;
      this._stepF += (step - this._stepF) * Math.min(1, dt * 6);
      if (Math.abs(step - this._stepF) < 0.001) this._stepF = step;
    }
    const wgt = (i) => Math.max(0, 1 - Math.abs(this._stepF - i)); // 0..1 per-step weight
    const routedF = Math.max(0, Math.min(1, this._stepF));         // 0→1 across wake→route
    const listening = step === 0, routed = step >= 1, tooling = step === 2, responding = step === 3;
    const ease = routedF; // continuous "routedness" drives link/node glow ramps

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this._px * 0.052); // ≤3° parallax tilt (0.052 rad), core-centered
    ctx.globalCompositeOperation = "lighter";

    // --- core (brightens while routing / working / responding) ---
    const flare = wgt(3); // fades in/out with proximity to "respond"
    const corePulse = 0.5 + 0.14 * Math.sin(tt * 1.6) + flare * 0.5 + wgt(2) * 0.15;
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.4);
    cg.addColorStop(0, "rgba(255,232,200," + (0.42 * corePulse) + ")");
    cg.addColorStop(0.4, "rgba(255,150,70," + (0.24 * corePulse) + ")");
    cg.addColorStop(1, "rgba(180,80,30,0)");
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, base * 0.4, 0, Math.PI * 2); ctx.fill();
    const cd = ctx.createRadialGradient(0, 0, 0, 0, 0, base * 0.13);
    cd.addColorStop(0, "rgba(255,242,216," + (0.7 + flare * 0.3) + ")");
    cd.addColorStop(1, "rgba(255,150,70,0)");
    ctx.fillStyle = cd; ctx.beginPath(); ctx.arc(0, 0, base * 0.13, 0, Math.PI * 2); ctx.fill();

    // --- HUD framing (shared primitives, same look as the hero) ---
    // Depth of field, the cheap Canvas-2D way: the OUTER rings are drawn in two
    // slightly-offset low-alpha passes with a wide glow (reads as defocused),
    // while the core + inner reticle stay sharp. No ctx.filter → works in WebKit.
    const spin = this.reduced ? 0 : tt;
    const SEGS = [[0.1, 1.5], [2.2, 3.0], [3.6, 5.2]];
    // defocus offset scales with base and can never exceed it — a fixed ±2px
    // underflowed to a NEGATIVE radius on tiny layouts (base 0.42 → -1.6) and
    // crashed every frame
    const dof = Math.min(2, base * 0.05);
    arcs(ctx, base * 0.94 + dof, SEGS, 3, spin * 0.1, PAL.O, 0.14, 14); // defocus halo
    arcs(ctx, base * 0.94 - dof, SEGS, 3, spin * 0.1, PAL.O, 0.14, 14);
    arcs(ctx, base * 0.94, SEGS, 2, spin * 0.1, PAL.O, 0.26, 8);        // soft main pass
    ticks(ctx, base * 0.86 + dof * 0.6, 42, base * 0.03, -spin * 0.05, PAL.D, 0.16);
    ticks(ctx, base * 0.86, 42, base * 0.03, -spin * 0.05, PAL.D, 0.3);
    // hex core as a tilted 3D plate: squash + slight shear, with a dim
    // "underside" echo a few px lower — reads as perspective, not a flat outline
    ctx.save();
    ctx.transform(1, 0.05, 0.16, 0.86, 0, 0);
    poly(ctx, base * 0.34, 6, spin * 0.15, 1.2, PAL.B, 0.5);  // top face (sharp)
    ctx.translate(0, base * 0.022);
    poly(ctx, base * 0.34, 6, spin * 0.15, 1, PAL.O, 0.18);   // underside edge
    ctx.restore();

    // --- wake: an expanding "listening" pulse (cross-fades with the wake weight) ---
    const wl = wgt(0);
    if (this.reduced) {
      if (listening) {
        ctx.strokeStyle = PAL.B + "0.4)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, base * 0.44, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (wl > 0.02) {
      const lp = (tt % 1.4) / 1.4;
      ctx.strokeStyle = "rgba(255,190,120," + (0.55 * (1 - lp) * wl) + ")"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, base * (0.16 + lp * 0.52), 0, Math.PI * 2); ctx.stroke();
    }

    // --- three agent orbits + nodes; the active one lights up when routed ---
    const nodePos = [];
    for (let i = 0; i < AGENTS.length; i++) {
      const a = AGENTS[i];
      const active = routed && i === this.agent;
      const [r, g, b] = a.rgb;
      ctx.save(); ctx.rotate(a.tilt);
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,158,72," + (active ? 0.55 * ease + 0.18 : 0.16) + ")";
      ctx.beginPath(); ctx.ellipse(0, 0, base * a.rx, base * a.ry, 0, 0, Math.PI * 2); ctx.stroke();

      const ph = a.phase + (this.reduced ? 0 : tt * (active ? 0.9 : 0.4));
      const px = Math.cos(ph) * base * a.rx, py = Math.sin(ph) * base * a.ry;
      const nodeR = (active ? 5.5 : 3) * (active && !this.reduced ? 1 + 0.25 * Math.sin(tt * 4) : 1);
      ctx.shadowColor = "rgba(" + r + "," + g + "," + b + ",0.9)"; ctx.shadowBlur = active ? 16 : 5;
      ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + (active ? 1 : 0.5) + ")";
      ctx.beginPath(); ctx.arc(px, py, nodeR, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;

      // tool call: a little spinner sweeps around the working node (fades with
      // the tool weight so it eases in/out instead of popping)
      const wt = wgt(2);
      if (wt > 0.05 && active && !this.reduced) {
        ctx.strokeStyle = "rgba(" + r + "," + g + "," + b + "," + (0.9 * wt) + ")"; ctx.lineWidth = 2; ctx.lineCap = "round";
        ctx.beginPath(); ctx.arc(px, py, nodeR + 4, tt * 6, tt * 6 + 1.6); ctx.stroke(); ctx.lineCap = "butt";
      }

      // undo the tilt to get the node's position in orb space (for the link + label)
      nodePos[i] = { x: Math.cos(a.tilt) * px - Math.sin(a.tilt) * py, y: Math.sin(a.tilt) * px + Math.cos(a.tilt) * py };
      ctx.restore();
    }

    // --- link from core to the active agent (glows while routing / working) ---
    if (routed && nodePos[this.agent]) {
      const np = nodePos[this.agent], [r, g, b] = AGENTS[this.agent].rgb;
      const shimmer = this.reduced ? 1 : 0.5 + 0.5 * Math.sin(tt * 3);
      ctx.strokeStyle = "rgba(" + r + "," + g + "," + b + "," + ((0.3 + 0.35 * shimmer) * ease) + ")";
      ctx.lineWidth = 1.5 + wgt(2); // thickens smoothly while the tool works
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(np.x, np.y); ctx.stroke();

      // glowing data packet: core → agent (request out), then back (answer home),
      // each cycle. Pure motion, so it's skipped entirely under reduced motion.
      if (!this.reduced) {
        const cyc = (tt % 1.6) / 1.6;                    // 1.6s round trip
        const k = cyc < 0.5 ? cyc * 2 : (1 - cyc) * 2;   // ping-pong 0→1→0
        const kk = k * k * (3 - 2 * k);                  // smoothstep glide
        ctx.fillStyle = "rgba(255,240,215," + (0.9 * ease) + ")";
        ctx.shadowColor = "rgba(" + r + "," + g + "," + b + ",0.95)";
        ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(np.x * kk, np.y * kk, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // --- respond: a speaking wave ripples outward (fades with the respond weight) ---
    const wr = wgt(3);
    if (wr > 0.02 && !this.reduced) {
      for (let k = 0; k < 2; k++) {
        const rp = (tt + k * 0.5) % 1.0;
        ctx.strokeStyle = "rgba(255,178,98," + (0.4 * (1 - rp) * wr) + ")"; ctx.lineWidth = 2 * (1 - rp) + 0.3;
        ctx.beginPath(); ctx.arc(0, 0, base * (0.16 + rp * 0.6), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();

    // --- crisp labels (not additive) ---
    ctx.globalCompositeOperation = "source-over";
    if (routed && nodePos[this.agent]) {
      const np = nodePos[this.agent];
      // nodePos lives in the parallax-rotated frame; rotate the label anchor by
      // the same angle so the label stays glued to its node
      const pa = this._px * 0.052, pc = Math.cos(pa), ps = Math.sin(pa);
      const nx = np.x * pc - np.y * ps, ny = np.x * ps + np.y * pc;
      ctx.font = "600 " + Math.max(10, Math.round(base * 0.07)) + 'px "JetBrains Mono", monospace';
      ctx.fillStyle = "rgba(255,236,208,0.95)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(255,170,90,0.8)"; ctx.shadowBlur = 8;
      const ly = Math.max(14, cy + ny - 14);
      ctx.fillText(AGENTS[this.agent].name.toUpperCase(), cx + nx, ly);
      ctx.shadowBlur = 0;
    }
    // step label under the orb
    ctx.font = "600 " + Math.max(9, Math.round(base * 0.055)) + 'px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(255,220,180,0.45)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(BRAIN_STEPS[step].toUpperCase(), cx, Math.min(H - 10, cy + base * 0.62));
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    else window.removeEventListener("resize", this._onResize);
    if (this._io) this._io.disconnect();
    if (this._onMove) window.removeEventListener("pointermove", this._onMove);
    if (this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
  }
}
