// The capability constellation — a DOM layer, never canvas pixels.
//
// Every capability is a real <a>: focusable, tab-ordered, Enter-activated,
// screen-reader legible. The canvas globe stays exactly as it was; this rides
// beside it. Anything a sighted user can learn from the map, a keyboard or
// screen-reader user can learn too — that is the whole reason it isn't drawn.
//
// Layout is two shallow elliptical shells in a full-width band directly under
// the orb. It is a band rather than a ring around the globe because the cockpit
// leaves only ~95px of clear margin beside the globe at 1280x800 — a ring there
// would collide with the side panels and the floating readouts. Calm > clever.

import { CAPABILITIES, STATE_LABEL } from "./capabilities.js";

// Two shells: the outer arc carries the load-bearing capabilities, the inner
// arc the rest. Angles are degrees on an ellipse whose centre sits below the
// band, so only the upper arc is used and the whole thing bows toward the orb.
// Points are spread EVENLY ACROSS X and their height comes from the ellipse,
// rather than evenly by angle — equal angles bunch the orbs together near the
// top of the arc, which is what made the labels collide. The two shells are
// offset by half a step so they interleave into one readable field.
const SHELLS = Object.freeze([
  Object.freeze({ name: "outer", halfWidth: 46, baseY: 74, bow: 16, count: 5 }),
  Object.freeze({ name: "inner", halfWidth: 34.5, baseY: 30, bow: 13, count: 4 })
]);
const CENTRE_X = 50; // % of the band box

// Nine labelled 44px targets on two shells need real room. Below this the
// cockpit's centre column is too narrow and the arcs collide with each other
// and with the live activity strip — so the constellation stays away entirely
// rather than shipping a cramped version. The About guide carries the same
// nine capabilities at every size, and the dock's CAPABILITIES button opens it.
const MIN_HOST_WIDTH = 620;
const MIN_BAND_HEIGHT = 150;

function pointsFor(shell) {
  const span = shell.halfWidth * 2;
  const step = shell.count > 1 ? span / (shell.count - 1) : 0;
  return Array.from({ length: shell.count }, (_, i) => {
    const x = CENTRE_X - shell.halfWidth + step * i;
    // ellipse bow: deepest at the centre, flat at the ends
    const t = shell.halfWidth === 0 ? 0 : (x - CENTRE_X) / shell.halfWidth;
    const y = shell.baseY - shell.bow * Math.sqrt(Math.max(0, 1 - t * t));
    return { x, y };
  });
}

/** Interleave so the arcs don't read as "important row / leftovers row". */
function assignSlots() {
  const outer = pointsFor(SHELLS[0]);
  const inner = pointsFor(SHELLS[1]);
  const order = [
    { shell: "outer", p: outer[0] }, { shell: "inner", p: inner[0] },
    { shell: "outer", p: outer[1] }, { shell: "inner", p: inner[1] },
    { shell: "outer", p: outer[2] },
    { shell: "inner", p: inner[2] }, { shell: "outer", p: outer[3] },
    { shell: "inner", p: inner[3] }, { shell: "outer", p: outer[4] }
  ];
  return order;
}

function orbMarkup(cap, slot, index) {
  const li = document.createElement("li");
  li.className = "cst-slot";
  li.style.setProperty("--cst-x", slot.p.x.toFixed(2) + "%");
  li.style.setProperty("--cst-y", slot.p.y.toFixed(2) + "%");
  li.style.setProperty("--cst-i", String(index));
  li.dataset.shell = slot.shell;

  const a = document.createElement("a");
  a.className = "cst-orb";
  a.href = cap.href;
  a.dataset.state = cap.state;
  a.dataset.cap = cap.id;
  // The blurb is the accessible description; the visible label is the short one,
  // so the meaning never lives in a hover state alone.
  a.setAttribute("aria-label", `${cap.label} — ${STATE_LABEL[cap.state]}. ${cap.blurb}`);
  a.title = cap.blurb;

  const disc = document.createElement("span");
  disc.className = "cst-disc";
  disc.setAttribute("aria-hidden", "true");
  disc.textContent = cap.icon;

  // Short label on the map so nine of them fit without colliding; the full
  // name and the blurb ride in aria-label/title, so nothing is hover-only.
  const label = document.createElement("span");
  label.className = "cst-label";
  label.textContent = cap.short || cap.label;

  a.append(disc, label);

  if (cap.state !== "live") {
    const tag = document.createElement("span");
    tag.className = "cst-tag";
    tag.textContent = STATE_LABEL[cap.state];
    a.appendChild(tag);
  }

  li.appendChild(a);
  return li;
}

export function buildConstellation() {
  const section = document.createElement("section");
  section.className = "cst";
  section.setAttribute("aria-labelledby", "cstHeading");

  const head = document.createElement("div");
  head.className = "cst-head";
  head.innerHTML =
    '<h2 id="cstHeading">WHAT SHE CAN DO</h2>' +
    '<a class="cst-more" href="about.html#skills">FULL GUIDE →</a>';

  const list = document.createElement("ul");
  list.className = "cst-field";

  const slots = assignSlots();
  CAPABILITIES.forEach((cap, i) => list.appendChild(orbMarkup(cap, slots[i], i)));

  section.append(head, list);
  return section;
}

function hostFor() {
  return (
    document.querySelector(".v2-center-column") ||
    document.querySelector("#sceneStage")?.parentElement ||
    null
  );
}

/** Is there honestly room, or would we be crowding the cockpit? */
export function hasRoomFor(host) {
  if (!host) return false;
  const width = host.clientWidth;
  if (width < MIN_HOST_WIDTH) return false;
  // what the column has left once the orb and the live activity strip are paid for
  const used = Array.from(host.children)
    .filter((el) => !el.classList.contains("cst"))
    .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
  return host.clientHeight - used >= MIN_BAND_HEIGHT;
}

/**
 * Mount next to the orb. The v2 dashboard owns a centre column; when it is
 * present we join it, otherwise we fall in after the stage. Either way the
 * constellation is a sibling of the orb, never drawn on top of it — and it
 * only appears when the column can hold it calmly.
 */
export function mountConstellation() {
  const host = hostFor();
  if (!host) return null;
  const existing = host.querySelector(":scope > .cst");

  if (!hasRoomFor(host)) {
    if (existing) existing.remove();
    return null;
  }
  if (existing) return existing;

  const node = buildConstellation();
  const skills = host.querySelector(".v2-skills");
  if (skills) host.insertBefore(node, skills);
  else host.appendChild(node);
  return node;
}

/** Re-evaluate on resize: the room available changes, so the answer can too. */
export function watchConstellation() {
  let t = 0;
  const run = () => { t = 0; mountConstellation(); };
  addEventListener("resize", () => {
    if (t) clearTimeout(t);
    t = setTimeout(run, 180);
  });
  return mountConstellation();
}
