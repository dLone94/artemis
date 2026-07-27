// Mini animated 3D orbital nodes for the feature / team cards — a tiny version of
// the hero HUD: a glowing core with tilted orbiting satellites, in each card's
// --accent colour. One shared rAF; only visible orbs draw; reduced-motion → static.

import { PAL, prefersReducedMotion } from "./orbShared.js";

function hexToRgb(h) {
  h = (h || "").trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h || "22d3ee", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function initMiniOrbs(selector = ".card-orb, .agent-orb") {
  const reduced = prefersReducedMotion();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const orbs = [];

  document.querySelectorAll(selector).forEach((el, i) => {
    const sz = el.getBoundingClientRect().width || 48;
    const canvasS = Math.round(sz * 1.95);
    let accent = getComputedStyle(el).getPropertyValue("--accent").trim();
    const [r, g, b] = hexToRgb(accent || "#22d3ee");

    el.style.position = "relative";
    el.style.background = "transparent"; // the canvas is the orb now

    const cv = document.createElement("canvas");
    cv.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:1;width:" +
      canvasS + "px;height:" + canvasS + "px;";
    cv.width = canvasS * dpr;
    cv.height = canvasS * dpr;
    el.appendChild(cv);

    orbs.push({ el, ctx: cv.getContext("2d"), r, g, b, sz, S: canvasS, phase: i * 1.27, vis: true });
  });

  if (orbs.length && "IntersectionObserver" in window) {
    const byEl = new Map(orbs.map((o) => [o.el, o]));
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { const o = byEl.get(e.target); if (o) o.vis = e.isIntersecting; }),
      { rootMargin: "120px" }
    );
    orbs.forEach((o) => io.observe(o.el));
  }

  function draw(o, t) {
    const ctx = o.ctx, S = o.S, c = S / 2, R = o.sz * 0.36;
    const col = (a) => "rgba(" + o.r + "," + o.g + "," + o.b + "," + a + ")";
    const dim = "rgba(" + Math.round(o.r * 0.5) + "," + Math.round(o.g * 0.4) + "," + Math.round(o.b * 0.3) + ",";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(c, c);

    // outer glow (additive)
    ctx.globalCompositeOperation = "lighter";
    const pulse = 0.7 + 0.3 * Math.sin(t * 1.8 + o.phase);
    const gg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.6);
    gg.addColorStop(0, PAL.Hl + (0.4 * pulse) + ")");
    gg.addColorStop(0.38, col(0.3 * pulse));
    gg.addColorStop(1, col(0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(0, 0, R * 2.6, 0, Math.PI * 2); ctx.fill();

    // rotating tick ring — interface detail
    const tickN = 24, tr = R * 2.05, tl = R * 0.26;
    ctx.strokeStyle = col(0.5); ctx.lineWidth = 1;
    ctx.save(); ctx.rotate(t * 0.25);
    for (let i = 0; i < tickN; i++) {
      const a = (i / tickN) * Math.PI * 2, co = Math.cos(a), si = Math.sin(a);
      ctx.beginPath(); ctx.moveTo(co * tr, si * tr); ctx.lineTo(co * (tr - tl), si * (tr - tl)); ctx.stroke();
    }
    ctx.restore();
    // crisp outer ring
    ctx.lineWidth = 1; ctx.strokeStyle = col(0.5); ctx.shadowColor = col(0.7); ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;

    // core sphere (volume → fresnel rim → specular highlight)
    ctx.globalCompositeOperation = "source-over";
    const cs = ctx.createRadialGradient(-R * 0.3, -R * 0.34, R * 0.1, 0, 0, R);
    cs.addColorStop(0, PAL.Hl + "0.98)");
    cs.addColorStop(0.4, col(0.95));
    cs.addColorStop(0.82, dim + "0.95)");
    cs.addColorStop(1, "rgba(3,12,18,0.95)");
    ctx.fillStyle = cs; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.4; ctx.strokeStyle = col(0.55); // fresnel rim (bright arc)
    ctx.beginPath(); ctx.arc(0, 0, R * 0.95, 0.5, 0.5 + Math.PI * 1.35); ctx.stroke();
    const sp = ctx.createRadialGradient(-R * 0.34, -R * 0.38, 0, -R * 0.34, -R * 0.38, R * 0.5);
    sp.addColorStop(0, "rgba(255,255,255,0.85)"); sp.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sp; ctx.beginPath(); ctx.arc(-R * 0.34, -R * 0.38, R * 0.5, 0, Math.PI * 2); ctx.fill();

    // three tilted orbits — satellites with glowing trails
    const defs = [
      { rx: R * 2.0, ry: R * 0.7, tilt: 0.5, sp: 1.1 },
      { rx: R * 1.55, ry: R * 1.55, tilt: -0.8, sp: -0.8 },
      { rx: R * 2.3, ry: R * 1.1, tilt: 1.5, sp: 0.6 }
    ];
    for (let k = 0; k < defs.length; k++) {
      const d = defs[k];
      ctx.save(); ctx.rotate(d.tilt);
      ctx.lineWidth = 1; ctx.strokeStyle = col(0.2);
      ctx.beginPath(); ctx.ellipse(0, 0, d.rx, d.ry, 0, 0, Math.PI * 2); ctx.stroke();
      const ph = t * d.sp + o.phase + k * 2.1;
      ctx.lineWidth = 1.6; ctx.strokeStyle = col(0.38); // motion trail behind the satellite
      ctx.beginPath(); ctx.ellipse(0, 0, d.rx, d.ry, 0, ph - 0.75, ph); ctx.stroke();
      const px = Math.cos(ph) * d.rx, py = Math.sin(ph) * d.ry, depth = 0.5 + 0.5 * Math.sin(ph);
      ctx.fillStyle = PAL.Hl + (0.45 + 0.55 * depth) + ")";
      ctx.shadowColor = col(0.95); ctx.shadowBlur = 7 * depth;
      ctx.beginPath(); ctx.arc(px, py, 1.0 + 1.9 * depth, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
    ctx.restore();
  }

  if (reduced) { orbs.forEach((o) => draw(o, 0)); return; }
  const t0 = performance.now();
  function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    const t = (performance.now() - t0) / 1000;
    for (let i = 0; i < orbs.length; i++) if (orbs[i].vis) draw(orbs[i], t);
  }
  requestAnimationFrame(loop);
}
