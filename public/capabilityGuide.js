// The About guide — one entry per capability, generated from the SAME array the
// index.html constellation renders (public/capabilities.js).
//
// The section used to be eight hand-written cards. Hand-written marketing copy
// is exactly where a product starts claiming things it doesn't do, because
// nothing forces it to change when the code does. Now there is one array, one
// generator, and a test that fails if a capability claims "live" without the
// tool family that would make it true.

import { CAPABILITIES, STATE_LABEL } from "./capabilities.js";

const ACCENTS = [
  "#22d3ee", "#38bdf8", "#06b6d4", "#67e8f9", "#0ea5e9",
  "#7dd3fc", "#4096aa", "#8cecff", "#5eead4"
];

function line(cls, label, value) {
  const p = document.createElement("p");
  p.className = cls;
  const strong = document.createElement("strong");
  strong.textContent = label;
  p.append(strong, document.createTextNode(" " + value));
  return p;
}

function cardFor(cap, index) {
  const card = document.createElement("article");
  card.className = "card reveal cap-card";
  card.id = "cap-" + cap.id;
  card.style.setProperty("--accent", ACCENTS[index % ACCENTS.length]);
  card.dataset.state = cap.state;

  const orb = document.createElement("span");
  orb.className = "card-orb";
  orb.setAttribute("aria-hidden", "true");

  const title = document.createElement("h3");
  title.className = "card-title";
  const dot = document.createElement("span");
  dot.className = "card-dot";
  dot.setAttribute("aria-hidden", "true");
  const chip = document.createElement("span");
  chip.className = "cap-chip";
  chip.dataset.state = cap.state;
  chip.textContent = STATE_LABEL[cap.state];
  title.append(dot, document.createTextNode(" " + cap.label + " "), chip);

  const desc = document.createElement("p");
  desc.className = "card-desc";
  desc.textContent = cap.blurb;

  // "You can say" — the fastest way to learn a voice product is to be told
  // the exact words. Planned entries carry their own honest placeholders.
  const sayWrap = document.createElement("div");
  sayWrap.className = "cap-say";
  const sayHead = document.createElement("span");
  sayHead.className = "cap-say-head";
  sayHead.textContent = cap.state === "planned" ? "Nothing to say yet" : "You can say";
  sayWrap.appendChild(sayHead);
  const ul = document.createElement("ul");
  cap.sayExamples.forEach((phrase) => {
    const li = document.createElement("li");
    li.textContent = phrase;
    ul.appendChild(li);
  });
  sayWrap.appendChild(ul);

  const facts = document.createElement("div");
  facts.className = "cap-facts";
  facts.append(
    line("cap-local", "Stays local:", cap.local),
    line("cap-connected", "Connected service:", cap.connected),
    line("cap-safety", "Boundary:", cap.safety)
  );

  const tag = document.createElement("div");
  tag.className = "card-tag";
  tag.textContent = [
    STATE_LABEL[cap.state],
    cap.connected.toLowerCase().startsWith("none") ? "FULLY LOCAL" : "USES A CONNECTED SERVICE"
  ].join(" · ");

  card.append(orb, title, desc, sayWrap, facts, tag);
  return card;
}

/**
 * Render every capability into `mount`, replacing whatever is there.
 * Cards carry `.reveal`; main.js wires its observer before this module runs,
 * so we observe our own nodes rather than relying on that ordering.
 */
export function renderCapabilityGuide(mount) {
  if (!mount) return null;
  mount.textContent = "";
  const frag = document.createDocumentFragment();
  CAPABILITIES.forEach((cap, i) => frag.appendChild(cardFor(cap, i)));
  mount.appendChild(frag);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cards = Array.from(mount.querySelectorAll(".reveal"));
  if (reduce || typeof IntersectionObserver !== "function") {
    cards.forEach((c) => c.classList.add("in"));
    return mount;
  }
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }),
    { rootMargin: "0px 0px -10% 0px" }
  );
  cards.forEach((c) => io.observe(c));
  return mount;
}

/** Jump to #cap-x on load, now that the cards exist. */
export function honourCapabilityHash() {
  const id = location.hash.slice(1);
  if (!id.startsWith("cap-")) return;
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
}
