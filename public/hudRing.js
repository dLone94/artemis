// The HUD ring — one component, instanced everywhere.
//
// This is what makes the cockpit read as a reactor console rather than a dark
// dashboard: a tick track, a value arc, and a sweep that never stops moving.
//
// Two decisions worth knowing:
//
// SVG, not canvas. A canvas ring means redrawing on every frame on the main
// thread, and a dozen of them would compete with the model, the mic and the
// wake engine. As SVG the browser composites it, and the sweep is a CSS
// `transform: rotate()` keyframe — those run on the compositor, off the main
// thread entirely. Always-on motion costs almost nothing done this way.
//
// A ring with no data shows "—", never 0. A gauge that reads zero when it means
// "I couldn't measure this" is the same lie the rest of this app spent a long
// night removing.

const NS = "http://www.w3.org/2000/svg";
let ringSeq = 0;

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {object} opts
 * @param {number} opts.size      px, the ring's box
 * @param {string} opts.label     small caps caption
 * @param {string} [opts.unit]    appended to the value, e.g. "%" or "ms"
 * @param {number} [opts.max]     full-scale value; omit for a label-only ring
 * @param {string} [opts.tone]    css colour; defaults to the cyan primary
 * @param {number} [opts.spin]    seconds per sweep revolution (default 8)
 * @param {boolean} [opts.reverse] sweep anticlockwise — used to desynchronise
 */
export function createRing(opts = {}) {
  const size = opts.size || 96;
  const tone = opts.tone || "var(--teal)";
  const r = size / 2 - 6;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const id = "hudgauge-" + ++ringSeq;

  const wrap = document.createElement("div");
  wrap.className = "hud-gauge";
  wrap.style.setProperty("--ring-size", size + "px");
  wrap.style.setProperty("--ring-tone", tone);
  wrap.style.setProperty("--ring-spin", (opts.spin || 8) + "s");
  if (opts.reverse) wrap.dataset.reverse = "1";

  const svg = el("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" });

  // tick track — the dashed outer ring that reads as an instrument
  // 24 explicit radial ticks — a dial, not a flat circle
  const tickCirc = 2 * Math.PI * (r + 4);
  const tickSeg = tickCirc / 24;
  const ticks = el("circle", {
    cx: c, cy: c, r: r + 4, fill: "none", stroke: "var(--ring-tick)",
    "stroke-width": 3, "stroke-dasharray": `2 ${(tickSeg - 2).toFixed(2)}`
  });

  const track = el("circle", {
    cx: c, cy: c, r, fill: "none", stroke: "var(--ring-track)", "stroke-width": 3
  });

  // the measured value
  const arc = el("circle", {
    cx: c, cy: c, r, fill: "none", stroke: tone, "stroke-width": 3,
    "stroke-linecap": "round", "stroke-dasharray": circ,
    "stroke-dashoffset": circ, transform: `rotate(-90 ${c} ${c})`
  });
  arc.setAttribute("class", "hud-gauge-arc");

  // the perpetual sweep — decorative, and the only always-moving part
  const sweep = el("circle", {
    cx: c, cy: c, r: r - 6, fill: "none", stroke: "var(--ring-sweep)",
    "stroke-width": 2, "stroke-linecap": "round",
    "stroke-dasharray": `${circ * 0.12} ${circ}`
  });
  sweep.setAttribute("class", "hud-gauge-sweep");
  sweep.style.transformOrigin = "center";

  svg.append(ticks, track, arc, sweep);

  const readout = document.createElement("div");
  readout.className = "hud-gauge-readout";
  const val = document.createElement("span");
  val.className = "hud-gauge-value";
  val.textContent = "—";
  const lab = document.createElement("span");
  lab.className = "hud-gauge-label";
  lab.textContent = opts.label || "";
  readout.append(val, lab);

  wrap.append(svg, readout);
  wrap.id = id;

  /**
   * @param {object} next
   * @param {number|null} [next.value] null/undefined renders "—" — see the note above
   * @param {number} [next.max]
   * @param {string} [next.text]  override the displayed text entirely
   * @param {string} [next.state] "" | "warn" | "bad" | "busy"
   */
  wrap.set = (next = {}) => {
    const max = next.max != null ? next.max : opts.max;
    const has = next.value != null && Number.isFinite(next.value);
    if (next.text != null) val.textContent = next.text;
    else if (!has) val.textContent = "—";
    else val.textContent = fmt(next.value) + (opts.unit || "");

    // Unknown must not look like empty: leave the arc unset rather than at zero.
    if (has && max) {
      const pct = Math.max(0, Math.min(1, next.value / max));
      arc.style.strokeDashoffset = String(circ * (1 - pct)); // style → CSS 600ms sweep
      arc.style.opacity = "1";
      delete wrap.dataset.empty;
    } else {
      arc.style.strokeDashoffset = String(circ);
      arc.style.opacity = "0";
      wrap.dataset.empty = "1";
    }
    if (next.state !== undefined) wrap.dataset.state = next.state || "";
    return wrap;
  };

  if (opts.value != null) wrap.set({ value: opts.value, max: opts.max });
  return wrap;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10000) return Math.round(n / 1000) + "k";
  if (Math.abs(n) >= 100) return String(Math.round(n));
  if (Math.abs(n) >= 10) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** Build a labelled row of rings — the usual way they appear in the cockpit. */
export function createRingRow(specs) {
  const row = document.createElement("div");
  row.className = "hud-gauge-row";
  const rings = {};
  specs.forEach((spec, i) => {
    const ring = createRing({ ...spec, reverse: i % 2 === 1, spin: 7 + (i % 4) });
    ring.dataset.key = spec.key;
    rings[spec.key] = ring;
    row.appendChild(ring);
  });
  row.rings = rings;
  return row;
}
