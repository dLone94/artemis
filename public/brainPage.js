// The Brain — standalone page controller (brain.html).
// One shared state object drives the CinematicOrb (the unchanged BrainOrb
// renderer), the EngineerGraph rail, the StepControls/RouteChips, the
// TransportBar and the TracePanel. Timeline is an 8s presentation loop:
//   wake [0–2s) → route [2–4s) → tool [4–6s) → respond [6–8s)
// Gated agents (Email triage / Messaging — awaiting API keys) honestly STOP
// at route: the rail marks the Agent node gated and the loop holds there.

import { BrainOrb } from "./brainOrb.js";
import { prefersReducedMotion } from "./orbShared.js";

const $ = (id) => document.getElementById(id);
const reduced = prefersReducedMotion();

const LOOP_MS = 8000;
const PHASE_MS = 2000;
const PHASES = ["wake", "route", "tool", "respond"];
const AGENTS = ["research", "email", "messaging"];
const AGENT_LABELS = { research: "Research", email: "Email triage", messaging: "Messaging" };

// ---- single shared state ---------------------------------------------------
const state = {
  phase: "wake",
  agent: "research",
  mode: "auto",           // the home section's `is-manual` flag, defaulted OFF here
  view: "cinematic",
  playing: !reduced,      // reduced motion: static, user steps manually
  speed: 1,
  t: 0,                   // ms into the presentation loop
  trace: [],              // TraceEvent[] = {t, stage, status, label, latencyMs?}
  source: "demo",
};

// ---- demo traces ------------------------------------------------------------
// `label` is the terse (redacted) line; `full` is the verbose variant shown when
// the redact toggle is OFF. Keys are ALWAYS masked (maskKeys) either way.
const TRACE_RESEARCH = [
  { t: 200,  stage: "wake",   status: "done",  label: '"artemis" detected · conf 0.94', latencyMs: 40 },
  { t: 700,  stage: "listen", status: "run",   label: 'deepgram interim "whats trending on…"' },
  { t: 1400, stage: "listen", status: "done",  label: 'transcript final "what\'s trending on Hacker News"', latencyMs: 570 },
  { t: 2300, stage: "route",  status: "done",  label: "intent: research · conf 0.88 → Research agent", latencyMs: 120 },
  { t: 2900, stage: "tool",   status: "run",   label: 'web.search({ q:"…" })',
    full: 'web.search({ q:"hacker news trending", max_results: 5, api_key:"tvly-••••" })' },
  { t: 4300, stage: "tool",   status: "done",  label: "→ news.ycombinator.com · 3 results", latencyMs: 890,
    full: "→ news.ycombinator.com · 3 results · top: “Show HN: local-first sync engine”" },
  { t: 5400, stage: "model",  status: "done",  label: "nvidia-nim generating… 142 tok · 61 tok/s", latencyMs: 410,
    full: "nvidia-nim qwen3-next-80b stream · 142 tok · 61 tok/s · temp 0.3" },
  { t: 6400, stage: "tts",    status: "done",  label: "aura-2-thalia-en · 4.2s audio", latencyMs: 180 },
  { t: 7300, stage: "totals", status: "done",  label: "end-to-end 2210ms [wake40·asr570·route120·tool890·llm410·tts180]" },
];
// gated path — the agent has no API key, so the pipeline honestly blocks
const gatedTrace = (agent) => [
  TRACE_RESEARCH[0],
  TRACE_RESEARCH[1],
  TRACE_RESEARCH[2],
  { t: 2300, stage: "route", status: "done",
    label: `intent: ${agent} · conf 0.91 → ${AGENT_LABELS[agent]}`, latencyMs: 120 },
  { t: 2900, stage: "gated", status: "gated",
    label: `${AGENT_LABELS[agent]} · awaiting API key — action blocked` },
];
const TRACES = {
  research: TRACE_RESEARCH,
  email: gatedTrace("email"),
  messaging: gatedTrace("messaging"),
};
const isGated = () => state.agent !== "research";

// never print anything key-shaped, in demo or live traces
function maskKeys(s) {
  return String(s).replace(/\b(sk|tvly|key|token|Bearer)[-_ ]?[A-Za-z0-9_-]{8,}/gi, (m) => m.slice(0, 6) + "••••");
}

// ---- captions (extends the home #brainCaption pattern; aria-live reads them) ----
const CAPTIONS = {
  wake:    "You say <strong>“Artemis.”</strong> The outer ring pulses as she wakes and starts listening.",
  route:   "She reads your intent and <strong>routes</strong> it to {a} — that node lights up and links back to the core.",
  tool:    "{a} runs its <strong>tool</strong> — a web search, a draft, a lookup. Its node spins while the work runs.",
  respond: "She composes the answer and <strong>speaks</strong> it — the core flares and a voice wave ripples outward.",
  gated:   "{a} is <strong>gated</strong> — no API key configured, so the action is blocked until you add one. Nothing happens without your say-so.",
};

// ---- CinematicOrb: reuse the existing renderer unchanged --------------------
const orb = new BrainOrb($("brainOrb"));

// ---- EngineerGraph ----------------------------------------------------------
const RAIL_NODES = [
  { key: "mic",    icon: "🎙", name: "MIC",    tip: "Microphone capture — raw audio frames stream in." },
  { key: "wake",   icon: "👂", name: "WAKE",   tip: "Wake-word spotter — listens only for “Artemis”, nothing is sent until it fires." },
  { key: "router", icon: "🧭", name: "ROUTER", tip: "Intent router — classifies the request and picks the sub-agent." },
  { key: "agent",  icon: "🤖", name: "AGENT",  tip: "The chosen sub-agent (Research / Email triage / Messaging) takes the request." },
  { key: "tool",   icon: "🛠", name: "TOOL",   tip: "Tool call — web search, draft, lookup. Gated actions stop here without a key." },
  { key: "llm",    icon: "🧠", name: "LLM",    tip: "The language model composes the answer from the tool results." },
  { key: "tts",    icon: "🔊", name: "TTS",    tip: "Text-to-speech — the answer is spoken aloud in her voice." },
];
// latency badge per node (from the demo trace timings)
const NODE_LATENCY = { mic: null, wake: 40, router: 120, agent: null, tool: 890, llm: 410, tts: 180 };
// which node is ACTIVE during each half-phase of the 8s loop (2 per phase)
const ACTIVE_BY_HALF = ["mic", "wake", "router", "agent", "tool", "tool", "llm", "tts"];

const rail = $("bpRail");
const packet = $("bpPacket");
RAIL_NODES.forEach((n) => {
  const el = document.createElement("div");
  el.className = "bp-node";
  el.dataset.node = n.key;
  el.dataset.tip = n.tip;
  el.tabIndex = 0; // keyboard users can focus a node to read its tooltip
  el.innerHTML =
    '<span class="bp-node-dot" aria-hidden="true">' + n.icon + "</span>" +
    "<span>" + n.name + "</span>" +
    '<span class="bp-lat-badge">' + (NODE_LATENCY[n.key] ? NODE_LATENCY[n.key] + "ms" : "") + "</span>";
  rail.appendChild(el);
});
const nodeEls = Array.from(rail.querySelectorAll(".bp-node"));

function renderRail() {
  const half = Math.min(7, Math.floor(state.t / (PHASE_MS / 2)));
  // gated agents never get past the Agent node
  const gatedStop = isGated() && state.t >= PHASE_MS * 1.5;
  const activeKey = gatedStop ? "agent" : ACTIVE_BY_HALF[half];
  const activeIdx = RAIL_NODES.findIndex((n) => n.key === activeKey);
  nodeEls.forEach((el, i) => {
    el.classList.toggle("is-active", i === activeIdx && !(gatedStop && i === 3));
    el.classList.toggle("is-done", i < activeIdx);
    el.classList.toggle("is-gated", gatedStop && i === 3);
  });
  // the data packet glides along the track toward the active node
  const trackW = rail.clientWidth - 56; // matches .bp-track inset (28px each side)
  const frac = gatedStop ? 3 / 6 : Math.min(6, (state.t / LOOP_MS) * 7) / 6;
  packet.style.transform = "translateX(" + Math.round(frac * trackW) + "px)";
  packet.style.opacity = reduced ? 0 : 1; // reduced motion: no traveling dot
}

// ---- StepControls / RouteChips (same behavior as the home section) ----------
const stepBtns = Array.from(document.querySelectorAll(".brain-step"));
const agentBtns = Array.from(document.querySelectorAll(".brain-agent"));
const caption = $("brainCaption");

function renderControls() {
  const stepIdx = PHASES.indexOf(state.phase);
  stepBtns.forEach((b, i) => b.classList.toggle("is-active", i === stepIdx));
  agentBtns.forEach((b, i) => b.classList.toggle("is-active", AGENTS[i] === state.agent));
  const gatedNow = isGated() && state.t >= PHASE_MS * 1.5;
  const key = gatedNow ? "gated" : state.phase;
  caption.innerHTML = CAPTIONS[key].replace(/\{a\}/g, "<strong>" + AGENT_LABELS[state.agent] + "</strong>");
}

stepBtns.forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = "manual";
    state.playing = false;
    seek((+b.dataset.step || 0) * PHASE_MS + 50); // jump to that phase's start
    updatePlayBtn();
  })
);
agentBtns.forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = "manual";
    state.agent = AGENTS[+b.dataset.agent];
    orb.setAgent(+b.dataset.agent);
    state.trace = [];
    logEl.innerHTML = "";
    renderAll(true);
  })
);

// ---- TransportBar -----------------------------------------------------------
const playBtn = $("bpPlay");
const scrub = $("bpScrub");
const speedBtns = Array.from(document.querySelectorAll(".bp-speed"));

function updatePlayBtn() {
  playBtn.textContent = state.playing ? "⏸" : "▶";
  playBtn.setAttribute("aria-pressed", String(state.playing));
  playBtn.setAttribute("aria-label", state.playing ? "Pause the pipeline loop" : "Play the pipeline loop");
}
playBtn.addEventListener("click", () => {
  state.playing = !state.playing;
  if (state.playing) state.mode = "auto";
  updatePlayBtn();
});
scrub.addEventListener("input", () => seek(+scrub.value));
speedBtns.forEach((b) =>
  b.addEventListener("click", () => {
    state.speed = +b.dataset.speed;
    speedBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  })
);

// ---- ViewToggle (swaps the LEFT pane only; state/position preserved) --------
const viewBtns = { cinematic: $("viewCinematic"), engineer: $("viewEngineer") };
function setView(v) {
  state.view = v;
  viewBtns.cinematic.setAttribute("aria-pressed", String(v === "cinematic"));
  viewBtns.engineer.setAttribute("aria-pressed", String(v === "engineer"));
  $("cinematicPane").hidden = v !== "cinematic";
  $("engineerPane").hidden = v !== "engineer";
  if (v === "engineer") renderRail(); // rail width is 0 while hidden; re-measure
}
viewBtns.cinematic.addEventListener("click", () => setView("cinematic"));
viewBtns.engineer.addEventListener("click", () => setView("engineer"));

// ---- TracePanel ---------------------------------------------------------
const logEl = $("bpLog");
const totalsBar = $("bpTotalsBar");
const totalsCaption = $("bpTotalsCaption");
let redactOn = true;

const SEG_COLORS = ["#8a5a2b", "#b3762f", "#d18f38", "#ff9e48", "#ffb24d", "#ffcf6a"];
function eventLabel(e) {
  return maskKeys(!redactOn && e.full ? e.full : e.label);
}
function lineFor(e) {
  const div = document.createElement("div");
  div.className = "bp-line";
  div.dataset.status = e.status;
  div.innerHTML =
    '<span class="bp-dot" aria-hidden="true"></span>' +
    '<span class="bp-stage">' + e.stage + "</span>" +
    '<span class="bp-label"></span>' +
    '<span class="bp-lat">' + (e.latencyMs ? e.latencyMs + "ms" : "—") + "</span>";
  div.querySelector(".bp-label").textContent = eventLabel(e);
  return div;
}
function renderTrace(rebuild) {
  const demo = TRACES[state.agent];
  const due = demo.filter((e) => e.t <= state.t);
  if (rebuild || due.length < state.trace.length) {
    state.trace = [];
    logEl.innerHTML = "";
  }
  for (let i = state.trace.length; i < due.length; i++) {
    state.trace.push(due[i]);
    const line = lineFor(due[i]);
    logEl.appendChild(line);
    requestAnimationFrame(() => line.classList.add("shown"));
    logEl.scrollTop = logEl.scrollHeight;
  }
  renderTotals();
}
function renderTotals() {
  const lat = state.trace.filter((e) => e.latencyMs).map((e) => ({ stage: e.stage, ms: e.latencyMs }));
  const total = lat.reduce((s, x) => s + x.ms, 0);
  totalsBar.innerHTML = "";
  lat.forEach((x, i) => {
    const seg = document.createElement("span");
    seg.className = "bp-seg";
    seg.style.width = (total ? (x.ms / total) * 100 : 0) + "%";
    seg.style.background = SEG_COLORS[i % SEG_COLORS.length];
    seg.title = x.stage + " " + x.ms + "ms";
    totalsBar.appendChild(seg);
  });
  totalsCaption.textContent = total
    ? "totals · " + total + "ms  " + lat.map((x) => x.stage + " " + x.ms).join(" · ")
    : "totals · —";
}

$("bpRedact").addEventListener("click", (e) => {
  redactOn = !redactOn;
  e.currentTarget.setAttribute("aria-pressed", String(redactOn));
  // re-render existing lines at the new verbosity (keys stay masked either way)
  Array.from(logEl.querySelectorAll(".bp-line .bp-label")).forEach((el, i) => {
    if (state.trace[i]) el.textContent = eventLabel(state.trace[i]);
  });
});
$("bpCopy").addEventListener("click", async (e) => {
  const json = JSON.stringify(
    state.trace.map((ev) => ({ ...ev, label: maskKeys(ev.label) })), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    e.currentTarget.textContent = "copied ✓";
  } catch {
    e.currentTarget.textContent = "copy failed";
  }
  setTimeout(() => { $("bpCopy").textContent = "copy trace"; }, 1400);
});

// live integration hook: real voice pushes TraceEvents into the SAME panel
window.ArtemisBrainTrace = {
  push(evt) {
    state.source = "live";
    $("bpSource").textContent = "· live";
    state.trace.push(evt);
    const line = lineFor(evt);
    logEl.appendChild(line);
    requestAnimationFrame(() => line.classList.add("shown"));
    logEl.scrollTop = logEl.scrollHeight;
    renderTotals();
  },
};

// ---- timeline engine --------------------------------------------------------
function phaseAt(t) {
  // gated agents hold at "route" — the pipeline honestly stops at the gate
  if (isGated() && t >= PHASE_MS * 1.5) return "route";
  return PHASES[Math.min(3, Math.floor(t / PHASE_MS))];
}
function seek(t) {
  state.t = Math.max(0, Math.min(LOOP_MS, t));
  renderAll(state.t < (state.trace[state.trace.length - 1]?.t ?? -1));
}
function renderAll(rebuildTrace) {
  const ph = phaseAt(state.t);
  if (ph !== state.phase) state.phase = ph;
  orb.setStep(PHASES.indexOf(state.phase));
  scrub.value = String(Math.round(state.t));
  renderControls();
  if (state.view === "engineer") renderRail();
  renderTrace(rebuildTrace);
}

let last = performance.now();
(function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(100, now - (last || now));
  last = now;
  if (!state.playing || document.hidden) return;
  const next = state.t + dt * state.speed;
  if (next >= LOOP_MS) {
    state.t = 0;
    state.trace = [];
    logEl.innerHTML = "";
  } else {
    state.t = next;
  }
  renderAll(false);
})(performance.now());

// initial paint (also the reduced-motion static state: playing=false, t=0)
orb.setAgent(AGENTS.indexOf(state.agent));
updatePlayBtn();
renderAll(true);
if (reduced) {
  // static frame at the route step so the page still explains itself
  seek(PHASE_MS + 50);
}
