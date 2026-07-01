// Shared Canvas-2D orb primitives + a single reduced-motion helper.
// Used by BOTH the hero VoiceOrb and the explanatory BrainOrb so they speak one
// visual language (amber core, tilted orbital rings, ticks, hex reticle) without
// duplicating the drawing math. Every function is pure: it draws relative to the
// current transform origin (0,0), so callers translate/scale first.

// Amber-on-black palette shared across every orb.
export const PAL = {
  O: "rgba(255,158,72,",   // primary amber (rings, ticks base)
  B: "rgba(255,202,140,",  // bright amber (satellites, scanner)
  Hl: "rgba(255,232,205,", // highlight cream (labels, inner reticle)
  D: "rgba(208,150,98,",   // dim amber (background ticks)
  GLOW: "rgba(255,150,70,0.55)"
};

// One place to ask about reduced motion — every canvas honors this.
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// A negative radius throws IndexSizeError from ctx.arc and blanks the whole
// frame - every primitive clamps to 0 (and skips the degenerate draw) so a
// transient 0-sized layout can never crash the render loop.
// A stroked circle with an amber glow.
export function ring(ctx, r, w, c, a, blur, glow = PAL.GLOW) {
  r = Math.max(0, r);
  if (!r) return;

  ctx.beginPath();
  ctx.lineWidth = w;
  ctx.strokeStyle = c + a + ")";
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur || 0;
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// Arc segments (a "broken" ring). `segs` is an array of [startAngle, endAngle].
export function arcs(ctx, r, segs, w, rot, c, a, blur, glow = PAL.GLOW) {
  r = Math.max(0, r);
  if (!r) return;

  ctx.lineWidth = w;
  ctx.strokeStyle = c + a + ")";
  ctx.lineCap = "round";
  ctx.shadowColor = glow;
  ctx.shadowBlur = blur || 0;
  for (let i = 0; i < segs.length; i++) {
    ctx.beginPath();
    ctx.arc(0, 0, r, rot + segs[i][0], rot + segs[i][1]);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.lineCap = "butt";
}

// A ring of radial tick marks.
export function ticks(ctx, r, n, len, rot, c, a) {
  r = Math.max(0, r);
  if (!r) return;

  ctx.strokeStyle = c + a + ")";
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const ang = rot + (i / n) * Math.PI * 2, co = Math.cos(ang), si = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(co * r, si * r);
    ctx.lineTo(co * (r - len), si * (r - len));
    ctx.stroke();
  }
}

// A regular polygon outline (the hex/triangle reticle).
export function poly(ctx, r, sides, rot, w, c, a) {
  r = Math.max(0, r);
  if (!r) return;

  ctx.beginPath();
  ctx.lineWidth = w;
  ctx.strokeStyle = c + a + ")";
  for (let i = 0; i <= sides; i++) {
    const ang = rot + (i / sides) * Math.PI * 2, x = Math.cos(ang) * r, y = Math.sin(ang) * r;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}
