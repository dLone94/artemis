// Artemis animated orb — a living canvas presence.
// Idle: gentle breathing + orbiting particles. Speaking: pulses and moves with
// the voice's amplitude. Exposes window.artemisOrb { feed, setState, fromAnalyser }.

(function () {
  "use strict";

  const canvas = document.getElementById("celebrationOrb");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const BASE = Math.min(W, H) * 0.24;

  let t = 0;
  let level = 0; // smoothed reactive energy 0..1
  let target = 0; // fed by callers, decays
  let state = "idle";

  const palette = {
    idle: { glow: [110, 231, 200], hi: [205, 255, 240], core: [67, 211, 169], edge: [10, 120, 98] },
    listening: { glow: [86, 200, 255], hi: [205, 245, 255], core: [56, 180, 230], edge: [18, 80, 130] },
    thinking: { glow: [167, 139, 250], hi: [232, 222, 255], core: [140, 110, 235], edge: [64, 46, 140] },
    speaking: { glow: [110, 231, 200], hi: [214, 255, 246], core: [67, 211, 169], edge: [10, 120, 98] }
  };
  const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";

  // orbiting particles
  const particles = [];
  for (let i = 0; i < 22; i++) {
    particles.push({
      a: Math.random() * Math.PI * 2,
      r: Math.random(),
      ph: Math.random() * Math.PI * 2,
      dir: Math.random() < 0.5 ? 1 : -1,
      size: 1 + Math.random() * 1.6,
      tilt: 0.4 + Math.random() * 0.25
    });
  }

  // expanding wave rings
  const rings = [];
  let ringClock = 0;

  function spawnRing() {
    rings.push({ r: BASE * 1.05, a: 0.4 });
  }

  function render() {
    const col = palette[state] || palette.idle;
    const breathe = Math.sin(t * 1.6) * 0.05;
    const energy = level;
    const R = BASE * (1 + breathe + energy * 0.4);

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    // outer glow
    const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 3.4);
    g.addColorStop(0, rgba(col.glow, 0.42 + energy * 0.4));
    g.addColorStop(0.4, rgba(col.glow, 0.14));
    g.addColorStop(1, rgba(col.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 3.4, 0, Math.PI * 2);
    ctx.fill();

    // wave rings
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += 1.4 + energy * 4;
      ring.a *= 0.95;
      if (ring.a < 0.02) {
        rings.splice(i, 1);
        continue;
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(col.glow, ring.a);
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // orbiting particles (elliptical orbits behind + in front)
    for (const p of particles) {
      const ang = p.a + t * (0.35 + energy * 2.2) * p.dir;
      const rr = R * (1.35 + p.r * 0.55 + Math.sin(t * 2 + p.ph) * 0.08);
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr * p.tilt;
      const s = p.size * (1 + energy * 1.2);
      const pg = ctx.createRadialGradient(x, y, 0, x, y, s * 3);
      pg.addColorStop(0, rgba(col.hi, 0.9));
      pg.addColorStop(1, rgba(col.hi, 0));
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(x, y, s * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // core sphere
    ctx.globalCompositeOperation = "source-over";
    const cg = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    cg.addColorStop(0, rgba(col.hi, 0.97));
    cg.addColorStop(0.55, rgba(col.core, 0.96));
    cg.addColorStop(1, rgba(col.edge, 0.92));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // rotating rim rings
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(col.hi, 0.35 + energy * 0.45);
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 1.22, R * 0.46, t * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 1.22, R * 0.46, -t * 0.4 + 1.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  function loop() {
    requestAnimationFrame(loop);
    t += 0.016;
    level += (target - level) * 0.18;
    target *= 0.9;

    // ambient ring cadence; faster/livelier when listening or energetic
    ringClock += 1;
    const cadence = state === "listening" ? 70 : 150;
    if (ringClock % cadence === 0 || (level > 0.25 && ringClock % 10 === 0)) spawnRing();

    render();
  }
  requestAnimationFrame(loop);

  // ---- public API --------------------------------------------------------
  window.artemisOrb = {
    feed(a) {
      const v = Math.max(0, Math.min(1, Number(a) || 0));
      if (v > target) target = v;
    },
    setState(s) {
      if (palette[s]) state = s;
    },
    // Drive the orb from a live AnalyserNode until the sound goes silent.
    fromAnalyser(analyser) {
      if (!analyser) return;
      this.setState("speaking");
      const data = new Uint8Array(analyser.frequencyBinCount);
      let idle = 0;
      const self = this;
      function sample() {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        self.feed(avg);
        if (avg < 0.01) idle++;
        else idle = 0;
        if (idle < 30) requestAnimationFrame(sample);
        else self.setState(window.__artemisWakeOn ? "listening" : "idle");
      }
      requestAnimationFrame(sample);
    }
  };
})();
