// The living-interface reactor: REAL STATE → REAL VISUAL RESPONSE.
//
// One ArtemisUIState store (uiState.js) is fed by the presence bus
// (server-owned truth: brain, network mode, approval, active context, task,
// interpretation phase) and by the chat turn events main.js already emits
// from its validated SSE lifecycle. Panels then receive a single
// `data-activity` verdict — active / calm / dim — and a few live cards render
// from state. Nothing here animates on its own schedule: every visual change
// is caused by a state change, and idle costs nothing (no RAF, no timers
// except one 5s context-age fade check).
//
// All text lands via textContent — screen-derived strings (prompt lines,
// window titles) are untrusted and must never become markup.

import { createUIState } from "./uiState.js";
import { capabilitySegment } from "./presencePill.js";

export const uiState = createUIState();
// Presentation adapters loaded after this module can subscribe without
// importing (and therefore re-entering) the live reactor.
window.ArtemisUIState = uiState;
window.dispatchEvent(new CustomEvent("artemis-ui-state-ready", { detail: uiState }));

const CONTEXT_FRESH_MS = 45 * 1000;

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// ---- feed: presence bus (server-owned truth) --------------------------------

function connectPresence() {
  let source;
  const open = () => {
    source = new EventSource("/api/presence/events");
    source.addEventListener("state", (e) => {
      try { uiState.applyPresence(JSON.parse(e.data)); } catch (err) {}
    });
    source.onerror = () => { source.close(); setTimeout(open, 2000); };
  };
  open();
}

// ---- feed: chat turn events from main.js ------------------------------------

// Each stream's events carry its own key; only the newest key maps onto a
// live turn handle, so a late event from an aborted stream lands nowhere.
const turnHandles = new Map();
let latestKey = 0;
window.addEventListener("artemis-turn", (e) => {
  const d = e.detail || {};
  if (d.phase === "begin") {
    latestKey = d.key || latestKey + 1;
    turnHandles.set(latestKey, uiState.beginTurn());
    for (const key of turnHandles.keys()) if (turnHandles.size > 6 && key !== latestKey) turnHandles.delete(key);
  } else if (d.phase === "event") {
    const handle = turnHandles.get(d.key);
    if (handle != null) uiState.applyChatEvent(handle, d.event, d.data || {});
  }
});
window.addEventListener("artemis-tool", (e) => {
  const d = e.detail || {};
  const handle = turnHandles.get(d.turnKey) ?? turnHandles.get(latestKey);
  if (handle != null) uiState.applyChatEvent(handle, "tool", d);
});

// ---- render: panel activity + live cards ------------------------------------

function panel(name) {
  return document.querySelector(`.v2-panel--${name}`);
}

function setActivity(node, verdict) {
  if (node && node.dataset.activity !== verdict) node.dataset.activity = verdict;
}

/** Which panels matter for what Artemis is doing right now. */
function activityVerdicts(s) {
  const busyReasoning = s.reasoningState === "understanding" || s.reasoningState === "executing";
  const terminalWork =
    ["contextual", "terminal", "computer", "perception"].includes(s.activeCapability) ||
    (s.activeContext && Date.now() - (s.activeContext.at || 0) < CONTEXT_FRESH_MS);
  const research = ["web", "research", "radar"].includes(s.activeCapability);
  const talking = s.voiceState === "listening" || s.voiceState === "speaking";
  const anythingActive = busyReasoning || terminalWork || research || talking;
  return {
    system: anythingActive ? "dim" : "calm",
    neural: busyReasoning ? "active" : "calm",
    comms: talking ? "active" : anythingActive ? "dim" : "calm",
    context: terminalWork ? "active" : research ? "active" : "calm"
  };
}

// SYSTEM's network row: the mode the user chose and whether we are offline —
// straight from the presence bus, never probed twice.
let networkRow = null;
function renderNetwork(s) {
  const host = panel("system");
  if (!host) return;
  if (!networkRow) {
    const content = host.querySelector("[data-v2-slot=\"system\"]") || host.querySelector(".v2-panel-content") || host;
    networkRow = el("div", "alive-network", null);
    content.appendChild(networkRow);
    el("span", "alive-network-label", networkRow).textContent = "NETWORK";
    el("span", "alive-network-value", networkRow);
  }
  const value = networkRow.children[1];
  if (s.offline || s.networkMode === "local-only") {
    value.textContent = "LOCAL-ONLY · OFFLINE MODE";
    value.dataset.tone = "hold";
  } else {
    value.textContent = "HYBRID · CLOUD AVAILABLE";
    value.dataset.tone = "ok";
  }
  // Reference footer, from REAL subsystem status (the header dots' live
  // on/off classes set by /api/status) — never a decorative claim.
  let nominal = networkRow.parentNode.querySelector(".alive-nominal");
  if (!nominal) {
    nominal = el("div", "alive-nominal", networkRow.parentNode);
    el("i", "", nominal);
    el("span", "", nominal);
  }
  const dots = [...document.querySelectorAll(".hud-dot")];
  const known = dots.filter((d) => d.classList.contains("on") || d.classList.contains("off"));
  const down = known.filter((d) => d.classList.contains("off"));
  const label = nominal.children[1];
  if (!known.length) {
    nominal.dataset.tone = "";
    label.textContent = "CHECKING SUBSYSTEMS…";
  } else if (!down.length) {
    nominal.dataset.tone = "ok";
    label.textContent = "ALL SYSTEMS NOMINAL";
  } else {
    nominal.dataset.tone = "hold";
    label.textContent = down.map((d) => (d.dataset.sys || "?").toUpperCase()).join(" · ") + " OFFLINE";
  }
}

// The BRAIN card's chain nodes: rendered from the SAME real /api/telemetry
// poll statPanels already runs (via its artemis-brain-chain event) — discrete
// dots, one per model in the chain, the answering one lit.
let chainRow = null;
window.addEventListener("artemis-brain-chain", (e) => {
  const { chain = [], onFallback = false } = e.detail || {};
  if (!brainCard || !chain.length) return;
  if (!chainRow) {
    chainRow = el("div", "alive-chain", null);
    el("span", "alive-chain-label", chainRow).textContent = "CHAIN";
    el("span", "alive-chain-dots", chainRow);
    brainCard.appendChild(chainRow);
  }
  const dots = chainRow.lastChild;
  chainRow.dataset.fallback = onFallback ? "1" : "0";
  // rebuild only when the shape actually changed — this fires every poll
  const key = chain.map((c) => `${c.name}:${c.current ? 1 : 0}:${c.available ? 1 : 0}`).join("|");
  if (dots.dataset.key === key) return;
  dots.dataset.key = key;
  dots.textContent = "";
  for (const entry of chain) {
    const dot = el("i", "alive-chain-dot", dots);
    dot.title = entry.name + (entry.availableInSec ? ` · back in ${entry.availableInSec}s` : "");
    if (entry.current) dot.dataset.current = "1";
    if (!entry.available) dot.dataset.cooling = "1";
  }
});

// The brain card: real provider state, nothing fabricated. Reference layout —
// MODEL / PROVIDER on one row, LATENCY / STATUS on the next; the existing
// NEURAL CHAIN visualization below it stays the chain truth.
let brainCard = null;
let lastBrainName = null;
function brainField(parent, label) {
  const field = el("div", "alive-brain-field", parent);
  el("div", "alive-brain-label", field).textContent = label;
  return el("div", "alive-brain-value", field);
}
function renderBrain(s) {
  const host = panel("neural");
  if (!host) return;
  if (!brainCard) {
    const content = host.querySelector(".v2-panel-content") || host;
    brainCard = el("div", "alive-brain", null);
    content.prepend(brainCard);
    brainCard._model = brainField(brainCard, "MODEL");
    brainCard._provider = brainField(brainCard, "PROVIDER");
    brainCard._latency = brainField(brainCard, "LATENCY");
    brainCard._status = brainField(brainCard, "STATUS");
  }
  if (!s.brain) {
    brainCard._model.textContent = "—";
    brainCard._provider.textContent = s.networkMode === "local-only" ? "local-only" : "—";
    brainCard._latency.textContent = "—";
    brainCard._status.textContent = "no brain";
    brainCard._status.dataset.tone = "hold";
    return;
  }
  brainCard._model.textContent = s.brain.model || s.brain.name;
  brainCard._provider.textContent =
    `${s.brain.provider || "?"} (${s.brain.local ? "LOCAL" : "CLOUD"})`;
  brainCard._provider.dataset.local = s.brain.local ? "1" : "0";
  // Latency mirrors the HUD's measured time-to-first-word — real, this turn.
  const ttfw = document.getElementById("hudTtfw");
  const measured = ttfw && /\d/.test(ttfw.textContent) ? ttfw.textContent.replace(/^TTFW\s*/i, "") : "";
  brainCard._latency.textContent = measured || "—";
  brainCard._status.textContent = s.brain.available ? "Active" : "Cooling down";
  brainCard._status.dataset.tone = s.brain.available ? "ok" : "hold";
  if (lastBrainName && lastBrainName !== s.brain.name) {
    // a real failover just happened — one subtle transition, not a fireworks show
    brainCard.classList.remove("alive-brain--switched");
    void brainCard.offsetWidth; // restart the animation
    brainCard.classList.add("alive-brain--switched");
  }
  lastBrainName = s.brain.name;
}

// The live context card: what she is actually looking at. Reference layout —
// APPLICATION, a monospace VISIBLE PROMPT box, CURRENT TASK, and an honest
// context-age bar that drains as the perception goes stale.
let contextCard = null;
function contextField(parent, label, valueClass) {
  el("div", "alive-context-label", parent).textContent = label;
  return el("div", valueClass, parent);
}
function renderContext(s) {
  const host = panel("context");
  if (!host) return;
  if (!contextCard) {
    const content = host.querySelector(".v2-context-main") || host.querySelector(".v2-panel-content") || host;
    contextCard = el("div", "alive-context", null);
    content.prepend(contextCard);
    contextCard._app = contextField(contextCard, "APPLICATION", "alive-context-app");
    contextCard._prompt = contextField(contextCard, "VISIBLE PROMPT", "alive-context-prompt");
    contextCard._task = contextField(contextCard, "CURRENT TASK", "alive-context-task");
    const ageWrap = el("div", "alive-context-agewrap", contextCard);
    el("div", "alive-context-label", ageWrap).textContent = "CONTEXT AGE";
    contextCard._age = el("div", "alive-context-age", ageWrap);
    el("i", "", contextCard._age);
  }
  const ctx = s.activeContext;
  const ageMs = ctx ? Date.now() - (ctx.at || 0) : Infinity;
  const fresh = ageMs < CONTEXT_FRESH_MS;
  contextCard.dataset.live = fresh ? "1" : "0";
  contextCard._app.textContent = fresh ? (ctx.application || "—") : "—";
  contextCard._prompt.textContent = fresh
    ? (ctx.promptLine || ctx.windowTitle || "—")
    : "—";
  contextCard._task.textContent = s.currentTask && s.currentTask.label
    ? s.currentTask.label
    : s.approvalState
      ? "Waiting for your approval"
      : "—";
  if (fresh) {
    const remaining = Math.max(0, 1 - ageMs / CONTEXT_FRESH_MS);
    contextCard._age.firstChild.style.transform = `scaleX(${remaining.toFixed(3)})`;
    contextCard._age.dataset.seconds = `${Math.round(ageMs / 1000)}s`;
  } else {
    contextCard._age.firstChild.style.transform = "scaleX(0)";
    contextCard._age.dataset.seconds = "";
  }
}

// The hero task line: promote the current task without fighting main.js —
// we only fill it while main.js reports it empty.
function renderHeroTask(s) {
  const hero = document.getElementById("coreTask");
  if (!hero) return;
  // The interpretation stage is a real task moment: show the thought while the
  // contextual interpreter resolves, then let the real task label replace it.
  const label = s.currentTask && s.currentTask.label
    ? s.currentTask.label
    : s.interpreting
      ? "Understanding…"
      : null;
  if (label && hero.dataset.empty === "1") {
    hero.textContent = label;
    hero.dataset.alive = "1";
  } else if (!label && hero.dataset.alive === "1") {
    hero.textContent = "No active task";
    delete hero.dataset.alive;
  }
}

/** The full Core and the floating Core share one state grammar. The large
 * renderer keeps all of its existing geometry; this adds a lightweight outer
 * frame whose scale comes from real amplitude and whose highlighted sector
 * comes from the real active capability/context. */
function renderCoreFrame(s) {
  const hub = document.querySelector(".v2-hub");
  if (!hub) return;
  const signal = (s.voiceState === "listening" || s.voiceState === "speaking")
    ? Math.max(0, Math.min(1, Number(s.amplitude) || 0))
    : 0;
  const freshContext = s.activeContext
    && Date.now() - (s.activeContext.at || 0) < CONTEXT_FRESH_MS;
  const capability = s.activeCapability
    || (freshContext && s.activeContext.application)
    || "";
  const segment = capabilitySegment(capability);
  const motion = s.approvalState
    ? "hold"
    : s.voiceState === "error"
      ? "fault"
      : s.voiceState === "listening"
        ? "listen"
        : s.voiceState === "speaking"
          ? "speak"
          : s.interpreting || s.reasoningState === "understanding"
            ? "reason"
            : s.reasoningState === "executing"
              ? "work"
              : "drift";

  hub.style.setProperty("--core-signal", signal.toFixed(3));
  hub.style.setProperty("--core-scale", (1 + signal * 0.035).toFixed(4));
  hub.style.setProperty("--capability-angle", `${Math.max(0, segment) * 45}deg`);
  hub.dataset.coreMotion = motion;
  hub.dataset.capability = segment >= 0 ? "1" : "0";
}

function render(s, changedKeys) {
  // Amplitude only touches the composited Core frame; it still skips all
  // panel/card work below.
  renderCoreFrame(s);
  if (changedKeys.length === 1 && changedKeys[0] === "amplitude") return;
  const body = document.body;
  if (body.dataset.reasoning !== s.reasoningState) body.dataset.reasoning = s.reasoningState;
  if (body.dataset.network !== s.networkMode) body.dataset.network = s.networkMode;
  const interpreting = s.interpreting ? "1" : "0";
  if (body.dataset.interpreting !== interpreting) body.dataset.interpreting = interpreting;

  const verdicts = activityVerdicts(s);
  for (const name of ["system", "neural", "comms", "context"]) {
    setActivity(panel(name), verdicts[name]);
  }
  renderBrain(s);
  renderContext(s);
  renderHeroTask(s);
  renderNetwork(s);
}

function start() {
  if (!document.body.classList.contains("dashboard-v2")) return; // v1 rollback stays untouched
  connectPresence();
  uiState.subscribe(render);
  render(uiState.get(), ["boot"]);
  // Context freshness decays with no state change — one slow check, not a RAF.
  setInterval(() => render(uiState.get(), ["age"]), 5000);
}

if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => setTimeout(start, 0));
else setTimeout(start, 0);
