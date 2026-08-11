import { MOON_INFO } from "./voiceOrb.js";

const ABOUT_HASH = "#about";
const REFRESH_MS = 12000;
const REQUEST_TIMEOUT_MS = 10000;

const ICON_PATHS = Object.freeze({
  arrowLeft: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  brief: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 11h6M9 15h6"/>',
  radar: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 12l5-5M4 12h2M18 12h2M12 4v2"/>',
  plan: '<path d="M5 18c2-5 4-8 8-11l3-2 3 3-2 3c-3 4-6 6-11 8z"/><path d="M8 16l-3 3M14 8l3 3"/>',
  research: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5M8 10.5h5M10.5 8v5"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  messages: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  school: '<path d="M4 5.5c3-1 5-.5 8 1.5v12c-3-2-5-2.5-8-1.5z"/><path d="M20 5.5c-3-1-5-.5-8 1.5v12c3-2 5-2.5 8-1.5z"/>',
  finance: '<path d="M4 19h16M6 16v-4M11 16V8M16 16v-6M20 6l-4 4-4-2-5 4"/>',
  followups: '<path d="M9 8 5 12l4 4"/><path d="M6 12h7a5 5 0 0 1 5 5v1"/><path d="m15 5 4 3-4 3"/>',
  voice: '<path d="M5 9v6M8 6v12M11 10v4M14 4v16M17 8v8M20 10v4"/>',
  brain: '<path d="M9 5a3 3 0 0 0-4 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 4 3M15 5a3 3 0 0 1 4 3v1a3 3 0 0 1 0 6v1a3 3 0 0 1-4 3M12 4v16M8 9h4M12 15h4"/>',
  skills: '<path d="m12 3 2.2 4.5L19 8.2l-3.5 3.4.8 4.8-4.3-2.3-4.3 2.3.8-4.8L5 8.2l4.8-.7z"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'
});

const SKILL_ICONS = Object.freeze({
  BRIEF: "brief",
  RADAR: "radar",
  PLAN: "plan",
  RESEARCH: "research",
  MEDIA: "media",
  MESSAGES: "messages",
  SCHOOL: "school",
  FINANCE: "finance",
  "FOLLOW-UPS": "followups"
});

const SKILL_ORDER = Object.freeze(Object.keys(SKILL_ICONS));

function icon(name, className = "about-icon") {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.skills}</svg>`;
}

function panelVisual(kind) {
  if (kind === "brain") {
    return `<svg viewBox="0 0 96 82" aria-hidden="true">
      <g class="about-visual-lines"><path d="M18 19 44 11l27 17-8 30-31 9-19-22z"/><path d="m18 19 14 48m12-56 19 47M13 45l58-17M32 67l39-39"/></g>
      <g class="about-visual-nodes"><circle cx="18" cy="19" r="4"/><circle cx="44" cy="11" r="3"/><circle cx="71" cy="28" r="4"/><circle cx="63" cy="58" r="3"/><circle cx="32" cy="67" r="4"/><circle cx="13" cy="45" r="3"/><circle cx="44" cy="39" r="6"/></g>
    </svg>`;
  }
  if (kind === "voice") {
    return `<svg viewBox="0 0 96 82" aria-hidden="true">
      <path class="about-visual-guide" d="M8 41h80"/>
      <path class="about-visual-signal" d="M8 41h8l5-13 7 29 8-41 8 50 8-39 7 28 7-20 6 12h16"/>
      <circle class="about-visual-node" cx="48" cy="41" r="25"/>
    </svg>`;
  }
  if (kind === "watch") {
    return `<svg viewBox="0 0 96 82" aria-hidden="true">
      <g class="about-visual-lines"><circle cx="48" cy="41" r="29"/><circle cx="48" cy="41" r="20"/><circle cx="48" cy="41" r="9"/><path d="M48 12v58M19 41h58"/></g>
      <path class="about-radar-beam" d="M48 41 72 20a29 29 0 0 1 5 21z"/>
      <circle class="about-visual-node" cx="64" cy="29" r="3"/><circle class="about-visual-node" cx="33" cy="50" r="2.5"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 96 82" aria-hidden="true">
    <g class="about-visual-bars"><rect x="16" y="53" width="10" height="17"/><rect x="32" y="42" width="10" height="28"/><rect x="48" y="29" width="10" height="41"/><rect x="64" y="17" width="10" height="53"/></g>
    <path class="about-visual-signal" d="M12 49 29 38l17 3 17-19 19-9"/>
    <path class="about-visual-guide" d="M12 70h70"/>
  </svg>`;
}

function row(key, label) {
  return `<li class="about-row" data-about-row="${key}" data-state="unknown">
    <span class="about-row-dot" aria-hidden="true"></span>
    <span class="about-row-label">${label}</span>
    <span class="about-row-value">—</span>
    <span class="about-row-state">WAITING</span>
  </li>`;
}

function panel(key, title, subtitle, visual, rows) {
  return `<section class="about-panel about-panel--${key}" data-about-panel="${key}" data-state="partial" aria-labelledby="about-${key}-title">
    <div class="about-panel-visual">${panelVisual(visual)}</div>
    <div class="about-panel-copy">
      <header class="about-panel-header">
        <div>
          <h2 id="about-${key}-title">${title}</h2>
          <p>${subtitle}</p>
        </div>
        <span class="about-panel-feed" data-about-feed="${key}"><i aria-hidden="true"></i> CONNECTING</span>
      </header>
      <ul class="about-panel-rows">${rows.join("")}</ul>
    </div>
  </section>`;
}

function connectorSvg() {
  const routes = [
    { d: "M516 156H480V87H462", delay: "0s", nodes: [[480, 156], [480, 87], [462, 87]] },
    { d: "M684 156H720V87H738", delay: "-1.5s", nodes: [[720, 156], [720, 87], [738, 87]] },
    { d: "M516 204H480V273H462", delay: "-3s", nodes: [[480, 204], [480, 273], [462, 273]] },
    { d: "M684 204H720V273H738", delay: "-4.5s", nodes: [[720, 204], [720, 273], [738, 273]] }
  ];
  return `<svg class="about-connectors" viewBox="0 0 1200 360" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <marker id="aboutArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M1 1 7 4 1 7z" fill="currentColor"/></marker>
    </defs>
    ${routes.map((route) => `<g class="about-route" style="--about-route-delay:${route.delay}">
      <path class="about-route-base" d="${route.d}" marker-end="url(#aboutArrow)"/>
      <path class="about-route-pulse" d="${route.d}"/>
      ${route.nodes.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4"/>`).join("")}
    </g>`).join("")}
  </svg>`;
}

function hubMarkup() {
  return `<div class="about-hub" data-about-hub="offline">
    <svg class="about-hub-rings" viewBox="0 0 200 200" aria-hidden="true">
      <circle class="about-hub-ring about-hub-ring--outer" cx="100" cy="100" r="92"/>
      <circle class="about-hub-ring about-hub-ring--dash" cx="100" cy="100" r="82" pathLength="100"/>
      <path class="about-hub-ticks" d="M100 2v10M100 188v10M2 100h10M188 100h10M31 31l8 8M161 161l8 8M31 169l8-8M161 39l8-8"/>
    </svg>
    <div class="about-hub-core">
      <svg class="about-hub-plexus" viewBox="0 0 120 82" aria-hidden="true">
        <g><path d="m18 48 17-27 30-8 30 22-8 29-30 7-26-9z"/><path d="m35 21 22 50m8-58-8 58m38-36-78 13m70 16-69-16M35 21l52 43m8-29-64 27"/></g>
        <g><circle cx="18" cy="48" r="3"/><circle cx="35" cy="21" r="3"/><circle cx="65" cy="13" r="3"/><circle cx="95" cy="35" r="3"/><circle cx="87" cy="64" r="3"/><circle cx="57" cy="71" r="3"/><circle cx="31" cy="62" r="3"/><circle cx="58" cy="43" r="5"/></g>
      </svg>
      <strong>EVIE</strong>
      <span>ORCHESTRATION CORE</span>
      <em data-about-hub-state>STATUS UNAVAILABLE</em>
    </div>
  </div>`;
}

function flowStage(iconName, title, action) {
  return `<li class="about-flow-stage">
    <span class="about-flow-icon">${icon(iconName)}</span>
    <span class="about-flow-copy"><strong>${title}</strong><span>${action}</span></span>
  </li>`;
}

function pageMarkup() {
  return `<div class="about-shell">
    <header class="about-header">
      <a class="about-back" id="aboutBack" href="#" aria-label="Back to Evie dashboard">${icon("arrowLeft")}<span>DASHBOARD</span></a>
      <div class="about-wordmark">
        <h1 id="aboutTitle">EVIE <span>OS</span></h1>
        <p>Personal Voice Agent</p>
      </div>
      <div class="about-data-state" id="aboutDataState" data-state="pending" aria-live="polite"><i aria-hidden="true"></i><span>CONNECTING LIVE DATA</span></div>
    </header>

    <section class="about-architecture" aria-label="Evie subsystem architecture">
      ${connectorSvg()}
      ${hubMarkup()}
      ${panel("brain", "BRAIN", "Reasoning Core", "brain", [
        row("brain-model", "ACTIVE MODEL"), row("brain-chain", "FALLBACK CHAIN"), row("brain-context", "CONTEXT MEMORY"), row("brain-routing", "TOOL ROUTING")
      ])}
      ${panel("voice", "VOICE", "Speech Pipeline", "voice", [
        row("voice-tts", "TTS PROVIDER"), row("voice-stt", "SPEECH TO TEXT"), row("voice-wake", "WAKE WORD"), row("voice-talk", "TALK OVER")
      ])}
      ${panel("watch", "MAIL & SIGNALS", "Watchers", "watch", [
        row("watch-mail", "MAIL WATCH"), row("watch-web", "WEB SIGNALS"), row("watch-followups", "FOLLOW-UPS"), row("watch-brief", "DAILY BRIEF")
      ])}
      ${panel("memory", "MEMORY", "Persistence", "memory", [
        row("memory-notes", "NOTES"), row("memory-budget", "TOKEN BUDGET"), row("memory-session", "SESSION LOG"), row("memory-usage", "USAGE TRACKING")
      ])}
    </section>

    <section class="about-skills" aria-labelledby="aboutSkillsSummary">
      <div class="about-skills-heading">
        <h2 id="aboutSkillsSummary" aria-live="polite">${MOON_INFO.length} SKILLS ONLINE · CONNECTING SPECIALISTS</h2>
        <span>SELECTED CAPABILITY DOMAINS</span>
      </div>
      <ul class="about-skill-list" data-about-skills></ul>
    </section>

    <section class="about-flow" aria-label="Evie operating flow">
      <ol>
        ${flowStage("voice", "VOICE", "hears it")}
        ${flowStage("brain", "BRAIN", "reasons")}
        ${flowStage("skills", "SKILLS", "act")}
        ${flowStage("globe", "MAIL & WEB", "reach out")}
        ${flowStage("memory", "MEMORY", "remembers")}
      </ol>
    </section>
  </div>`;
}

let root = null;
let aboutOpen = false;
let returnFocus = null;
let refreshTimer = 0;
let refreshGeneration = 0;
let dashboardObserver = null;
const pendingControllers = new Set();
const inertState = new Map();
const liveState = {
  status: { phase: "pending", data: null },
  telemetry: { phase: "pending", data: null },
  agents: { phase: "pending", data: null }
};

const aboutToggle = document.getElementById("aboutToggle");

function buildSkillBand() {
  const host = root.querySelector("[data-about-skills]");
  const byTitle = new Map(MOON_INFO.map((entry) => [entry.title, entry]));
  SKILL_ORDER.forEach((title, index) => {
    const entry = byTitle.get(title);
    const item = document.createElement("li");
    const tooltipId = `about-skill-tip-${index}`;
    item.className = "about-skill";
    item.tabIndex = 0;
    item.setAttribute("aria-describedby", tooltipId);
    item.innerHTML = `<span class="about-skill-ring">${icon(SKILL_ICONS[title])}</span><strong>${title}</strong>`;
    const tooltip = document.createElement("span");
    tooltip.className = "about-skill-tooltip";
    tooltip.id = tooltipId;
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = entry?.what || "Capability details unavailable.";
    item.appendChild(tooltip);
    host.appendChild(item);
  });
}

function buildAboutView() {
  if (root) return root;
  root = document.createElement("main");
  root.id = "aboutView";
  root.className = "about-view";
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "aboutTitle");
  root.innerHTML = pageMarkup();
  document.body.appendChild(root);
  buildSkillBand();
  root.querySelector("#aboutBack").addEventListener("click", (event) => {
    event.preventDefault();
    requestClose();
  });
  return root;
}

function setRow(key, value, state = "unknown", stateText = "UNAVAILABLE") {
  if (!root) return;
  const item = root.querySelector(`[data-about-row="${key}"]`);
  if (!item) return;
  item.dataset.state = state;
  const displayValue = value == null || value === "" ? "—" : String(value);
  const valueEl = item.querySelector(".about-row-value");
  valueEl.textContent = displayValue;
  valueEl.title = displayValue === "—" ? "" : displayValue;
  item.querySelector(".about-row-state").textContent = stateText;
}

function setPanel(key, state, feedText) {
  const panelEl = root?.querySelector(`[data-about-panel="${key}"]`);
  const feed = root?.querySelector(`[data-about-feed="${key}"]`);
  if (panelEl) panelEl.dataset.state = state;
  if (feed) {
    feed.dataset.state = state;
    feed.lastChild.textContent = ` ${feedText}`;
  }
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

function toggleState(id, prefix) {
  const button = document.getElementById(id);
  if (!button) return { value: "UNAVAILABLE", active: null };
  const raw = button.textContent.trim();
  const value = raw.replace(new RegExp(`^${prefix}\\s*:\\s*`, "i"), "") || "UNAVAILABLE";
  return { value, active: /\bON\b/i.test(value) ? true : /\b(OFF|N\/A)\b/i.test(value) ? false : null };
}

function renderBrain() {
  const statusSource = liveState.status;
  const telemetrySource = liveState.telemetry;
  const agentsSource = liveState.agents;
  const status = statusSource.data;
  const telemetry = telemetrySource.data;
  const brain = telemetry?.brain;
  const connected = statusSource.phase === "ok" ? Boolean(status.chatEnabled) : null;
  const providerName = String(status?.llmProvider || "");
  const openAiCompat = /^(groq|nvidia):/i.test(providerName);
  const activeName = statusSource.phase === "ok"
    ? openAiCompat ? brain?.name || status.llmModel || providerName : status.llmModel || providerName
    : null;

  setRow("brain-model", activeName ? String(activeName).split("/").pop().toUpperCase() : "—", connected === true ? "online" : connected === false ? "offline" : "unknown", connected === true ? "ONLINE" : connected === false ? "OFFLINE" : "UNVERIFIED");

  if (Array.isArray(brain?.chain)) {
    setRow("brain-chain", `${brain.chain.length} MODEL${brain.chain.length === 1 ? "" : "S"}`, connected ? "online" : "configured", connected ? "LIVE" : "CONFIGURED");
    const chainRow = root.querySelector('[data-about-row="brain-chain"]');
    chainRow.title = brain.chain.map((b) => (typeof b === "string" ? b : b.name)).join(" → ") || "No configured fallback models";
  } else {
    setRow("brain-chain", "—", "unknown", telemetrySource.phase === "pending" ? "WAITING" : "UNAVAILABLE");
  }

  setRow("brain-context", connected == null ? "—" : "SESSION", connected ? "online" : "offline", connected ? "ACTIVE" : connected === false ? "OFFLINE" : "UNAVAILABLE");
  if (agentsSource.phase === "ok" && Array.isArray(agentsSource.data?.agents)) {
    setRow("brain-routing", `${agentsSource.data.agents.length} SPECIALISTS`, "configured", "CONFIGURED");
  } else {
    setRow("brain-routing", "—", "unknown", agentsSource.phase === "pending" ? "WAITING" : "UNAVAILABLE");
  }

  const bothFailed = statusSource.phase === "error" && telemetrySource.phase === "error";
  const telemetryComplete = telemetrySource.phase === "ok" && Array.isArray(brain?.chain);
  const frameState = bothFailed ? "offline" : connected === true && telemetryComplete ? "online" : "partial";
  setPanel("brain", frameState, bothFailed ? "DATA UNAVAILABLE" : connected === false ? "BRAIN OFFLINE" : frameState === "online" ? "LIVE DATA" : "PARTIAL DATA");
}

function renderVoice() {
  const source = liveState.status;
  const status = source.data;
  if (source.phase !== "ok") {
    ["voice-tts", "voice-stt", "voice-wake"].forEach((key) => setRow(key, "—", "unknown", source.phase === "error" ? "UNAVAILABLE" : "WAITING"));
    const talk = toggleState("bargeToggle", "TALK OVER");
    setRow("voice-talk", talk.value, talk.active ? "online" : talk.active === false ? "offline" : "unknown", talk.active ? "ON" : talk.active === false ? "OFF" : "UNAVAILABLE");
    setPanel("voice", "offline", source.phase === "error" ? "DATA UNAVAILABLE" : "CONNECTING");
    return;
  }

  const selectedVoice = document.getElementById("voiceSelect")?.value || "";
  const tts = selectedVoice.startsWith("eleven:") || selectedVoice === "elevenlabs"
    ? "ELEVENLABS"
    : selectedVoice.startsWith("edge:") ? "EDGE" : "DEEPGRAM";
  const ttsOn = tts === "ELEVENLABS" ? Boolean(status.elevenEnabled)
    : tts === "DEEPGRAM" ? Boolean(status.sttEnabled)
      : Boolean(status.voiceEnabled);
  const ttsState = tts === "EDGE" && ttsOn ? "configured" : ttsOn ? "online" : "offline";
  setRow("voice-tts", tts, ttsState, tts === "EDGE" && ttsOn ? "SELECTED" : ttsOn ? "ONLINE" : "OFFLINE");
  setRow("voice-stt", status.sttEnabled ? "DEEPGRAM" : "NONE", status.sttEnabled ? "online" : "offline", status.sttEnabled ? "ONLINE" : "OFFLINE");
  const wake = status.localWake || {};
  const wakeControl = toggleState("wakeToggle", "WAKE WORD");
  const wakeButton = document.getElementById("wakeToggle");
  const wakeAvailable = Boolean(wake.ready) || Boolean(wakeButton && !wakeButton.disabled);
  const wakeOn = wakeAvailable && wakeControl.active === true;
  const wakeLabel = String(wake.phrase || window.__wakePhrase || "WAKE WORD").toUpperCase();
  setRow("voice-wake", wakeLabel, wakeOn ? "online" : "offline", wakeOn ? "ON" : wakeAvailable ? "OFF" : "UNAVAILABLE");
  const talk = toggleState("bargeToggle", "TALK OVER");
  setRow("voice-talk", talk.value, talk.active ? "online" : talk.active === false ? "offline" : "unknown", talk.active ? "ON" : talk.active === false ? "OFF" : "UNAVAILABLE");

  const everyUnavailable = !ttsOn && !status.sttEnabled && !wakeAvailable;
  setPanel("voice", everyUnavailable ? "offline" : "online", everyUnavailable ? "PIPELINE OFFLINE" : "LIVE CLIENT STATE");
}

function renderWatchers() {
  const source = liveState.status;
  const status = source.data;
  const byTitle = new Map(MOON_INFO.map((entry) => [entry.title, entry]));
  const followups = byTitle.has("FOLLOW-UPS");
  const brief = byTitle.has("BRIEF");

  if (source.phase === "ok") {
    const mail = toggleState("mailWatchToggle", "MAIL WATCH");
    const mailValue = status.gmailEnabled ? mail.value : "AWAITING KEY";
    const mailOn = status.gmailEnabled && mail.active === true;
    setRow("watch-mail", mailValue, mailOn ? "online" : "offline", mailOn ? "ON" : status.gmailEnabled ? "OFF" : "OFFLINE");
    setRow("watch-web", status.webEnabled ? "WEB SEARCH" : "NONE", status.webEnabled ? "online" : "offline", status.webEnabled ? "ONLINE" : "OFFLINE");
    setPanel("watch", status.gmailEnabled || status.webEnabled ? "online" : "partial", status.gmailEnabled || status.webEnabled ? "LIVE STATUS" : "CAPABILITIES AVAILABLE");
  } else {
    setRow("watch-mail", "—", "unknown", source.phase === "error" ? "UNAVAILABLE" : "WAITING");
    setRow("watch-web", "—", "unknown", source.phase === "error" ? "UNAVAILABLE" : "WAITING");
    setPanel("watch", "offline", source.phase === "error" ? "DATA UNAVAILABLE" : "CONNECTING");
  }
  setRow("watch-followups", followups ? "TRACKER" : "—", followups ? "available" : "unknown", followups ? "AVAILABLE" : "UNAVAILABLE");
  setRow("watch-brief", brief ? "MORNING RUN" : "—", brief ? "available" : "unknown", brief ? "AVAILABLE" : "UNAVAILABLE");
}

function renderMemory() {
  const statusSource = liveState.status;
  const telemetrySource = liveState.telemetry;
  const status = statusSource.data;
  const telemetry = telemetrySource.data;

  if (statusSource.phase === "ok" && Number.isFinite(status.notesCount)) {
    setRow("memory-notes", `${status.notesCount} NOTE${status.notesCount === 1 ? "" : "S"}`, "online", status.notesCount ? "LIVE" : "EMPTY");
  } else {
    setRow("memory-notes", "—", "unknown", statusSource.phase === "pending" ? "WAITING" : "UNAVAILABLE");
  }

  const budget = telemetry?.budget;
  if (budget && Number.isFinite(budget.limitTokens)) {
    const remaining = Number.isFinite(budget.remainingTokens) ? compactNumber(budget.remainingTokens) : "—";
    setRow("memory-budget", `${remaining} / ${compactNumber(budget.limitTokens)}`, "online", "LIVE");
  } else {
    setRow("memory-budget", "—", "unknown", telemetrySource.phase === "error" ? "UNAVAILABLE" : telemetrySource.phase === "ok" ? "NOT MEASURED" : "WAITING");
  }

  const sessionEntries = document.querySelectorAll("#cmdLog .hud-line").length;
  setRow("memory-session", `${sessionEntries} EVENT${sessionEntries === 1 ? "" : "S"}`, "online", "LIVE");

  const usage = status?.usage;
  if (statusSource.phase === "ok" && usage && Number.isFinite(usage.llm) && Number.isFinite(usage.search)) {
    setRow("memory-usage", `${compactNumber(usage.llm)} CHAT · ${compactNumber(usage.search)} SEARCH`, "online", "TODAY");
  } else {
    setRow("memory-usage", "—", "unknown", statusSource.phase === "pending" ? "WAITING" : "UNAVAILABLE");
  }

  const bothFailed = statusSource.phase === "error" && telemetrySource.phase === "error";
  const eitherOk = statusSource.phase === "ok" || telemetrySource.phase === "ok";
  setPanel("memory", bothFailed ? "offline" : eitherOk ? "online" : "partial", bothFailed ? "DATA UNAVAILABLE" : eitherOk ? "LIVE DATA" : "CONNECTING");
}

function renderSummary() {
  const agentsSource = liveState.agents;
  const summary = root.querySelector("#aboutSkillsSummary");
  const specialists = agentsSource.phase === "ok" && Array.isArray(agentsSource.data?.agents)
    ? String(agentsSource.data.agents.length)
    : agentsSource.phase === "pending" ? "CONNECTING" : "—";
  summary.textContent = `${MOON_INFO.length} SKILLS ONLINE · ${specialists} SPECIALISTS`;
  summary.dataset.state = agentsSource.phase;

  const phases = Object.values(liveState).map((source) => source.phase);
  const dataState = root.querySelector("#aboutDataState");
  const allOk = phases.every((phase) => phase === "ok");
  const allFailed = phases.every((phase) => phase === "error");
  const anyPending = phases.some((phase) => phase === "pending");
  dataState.dataset.state = allOk ? "online" : allFailed ? "offline" : "partial";
  dataState.querySelector("span").textContent = allOk ? "LIVE SYSTEM MAP" : allFailed ? "LIVE DATA UNAVAILABLE" : anyPending ? "CONNECTING LIVE DATA" : "PARTIAL LIVE DATA";

  const statusSource = liveState.status;
  const hub = root.querySelector(".about-hub");
  const hubState = root.querySelector("[data-about-hub-state]");
  if (statusSource.phase === "ok") {
    hub.dataset.aboutHub = statusSource.data.chatEnabled ? "online" : "offline";
    hubState.textContent = statusSource.data.chatEnabled ? "CORE ONLINE" : "BRAIN OFFLINE";
  } else {
    hub.dataset.aboutHub = "offline";
    hubState.textContent = statusSource.phase === "error" ? "STATUS UNAVAILABLE" : "CONNECTING";
  }
}

function renderAll() {
  if (!root) return;
  renderBrain();
  renderVoice();
  renderWatchers();
  renderMemory();
  renderSummary();
}

async function fetchJson(path) {
  const controller = new AbortController();
  pendingControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    pendingControllers.delete(controller);
  }
}

function loadSource(name, path, generation) {
  fetchJson(path).then((data) => {
    if (!aboutOpen || generation !== refreshGeneration) return;
    liveState[name] = { phase: "ok", data };
    renderAll();
  }).catch(() => {
    if (!aboutOpen || generation !== refreshGeneration) return;
    liveState[name] = { phase: "error", data: null };
    renderAll();
  });
}

function refreshLiveData() {
  if (!aboutOpen || document.hidden) return;
  const generation = ++refreshGeneration;
  loadSource("status", "/api/status", generation);
  loadSource("telemetry", "/api/telemetry", generation);
  loadSource("agents", "/api/agents", generation);
}

function stopLiveUpdates() {
  clearInterval(refreshTimer);
  refreshTimer = 0;
  refreshGeneration += 1;
  for (const controller of pendingControllers) controller.abort();
  pendingControllers.clear();
}

function startLiveUpdates() {
  if (!aboutOpen || document.hidden) return;
  stopLiveUpdates();
  refreshLiveData();
  refreshTimer = window.setInterval(refreshLiveData, REFRESH_MS);
}

function makeSiblingInert(element) {
  if (!(element instanceof HTMLElement) || element === root || inertState.has(element)) return;
  inertState.set(element, element.inert);
  element.inert = true;
}

function setDashboardInert(enabled) {
  if (enabled) {
    Array.from(document.body.children).forEach(makeSiblingInert);
    if (!dashboardObserver) {
      dashboardObserver = new MutationObserver((records) => {
        if (!aboutOpen) return;
        for (const record of records) {
          record.addedNodes.forEach((node) => makeSiblingInert(node));
        }
      });
      dashboardObserver.observe(document.body, { childList: true });
    }
    return;
  }
  dashboardObserver?.disconnect();
  dashboardObserver = null;
  for (const [element, wasInert] of inertState) element.inert = wasInert;
  inertState.clear();
}

function focusableElements() {
  if (!root) return [];
  return Array.from(root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((element) => element.getClientRects().length && !element.hidden);
}

function openAbout() {
  buildAboutView();
  if (aboutOpen) return;
  aboutOpen = true;
  for (const source of Object.values(liveState)) {
    source.phase = "pending";
    source.data = null;
  }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : aboutToggle;
  root.hidden = false;
  root.classList.toggle("is-paused", document.hidden);
  aboutToggle?.setAttribute("aria-expanded", "true");
  setDashboardInert(true);
  renderAll();
  startLiveUpdates();
  requestAnimationFrame(() => root.querySelector("#aboutBack")?.focus({ preventScroll: true }));
}

function closeAbout({ restoreFocus = true } = {}) {
  if (!aboutOpen) return;
  aboutOpen = false;
  stopLiveUpdates();
  setDashboardInert(false);
  root.hidden = true;
  root.classList.remove("is-paused");
  aboutToggle?.setAttribute("aria-expanded", "false");
  if (restoreFocus) (aboutToggle || returnFocus)?.focus?.({ preventScroll: true });
  returnFocus = null;
}

function urlWithHash(hash) {
  const url = new URL(window.location.href);
  url.hash = hash;
  return `${url.pathname}${url.search}${url.hash}`;
}

function requestClose() {
  if (window.location.hash === ABOUT_HASH && window.history.state?.artemisAbout) {
    window.history.back();
    return;
  }
  window.history.replaceState(window.history.state, "", urlWithHash(""));
  closeAbout();
}

function syncToLocation() {
  if (window.location.hash === ABOUT_HASH) openAbout();
  else closeAbout();
}

function initializeLocation() {
  if (window.location.hash === ABOUT_HASH && !window.history.state?.artemisAbout) {
    const baseState = { ...(window.history.state || {}), artemisAboutBase: true };
    window.history.replaceState(baseState, "", urlWithHash(""));
    window.history.pushState({ ...baseState, artemisAbout: true }, "", urlWithHash(ABOUT_HASH));
  }
  syncToLocation();
}

aboutToggle?.addEventListener("click", (event) => {
  event.preventDefault();
  if (aboutOpen) {
    requestClose();
    return;
  }
  const nextState = { ...(window.history.state || {}), artemisAbout: true };
  window.history.pushState(nextState, "", urlWithHash(ABOUT_HASH));
  openAbout();
});

document.addEventListener("keydown", (event) => {
  if (!aboutOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    requestClose();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements();
  if (!focusable.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

window.addEventListener("popstate", syncToLocation);
window.addEventListener("hashchange", syncToLocation);
document.addEventListener("visibilitychange", () => {
  if (!aboutOpen) return;
  root.classList.toggle("is-paused", document.hidden);
  if (document.hidden) stopLiveUpdates();
  else startLiveUpdates();
});

initializeLocation();
