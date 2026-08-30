// The browser half of self-diagnostics.
//
// Three subsystems only exist in the page — the wake listener, the audio
// engine and the floating pill — so the server cannot check them directly. It
// would be easy (and wrong) to have the server assume they are fine. Instead
// the page posts what it actually observes, the server treats that as DATED
// evidence, and a report that stops arriving becomes UNKNOWN rather than
// silently staying HEALTHY.
//
// It also listens for repair requests. Recovery here is strictly Level 1: the
// page re-arms its own wake listener or resumes its own AudioContext. There is
// no path from this file to a permission, a package or a file.

import { wakeHealth, localWakeRunning } from "./wakeLocal.js";

const REPORT_MS = 15_000;

/** Everything the server cannot see from outside the page. */
function collect() {
  let wake = null;
  try {
    const h = wakeHealth();
    wake = {
      running: !!h.running,
      stalled: !!h.stalled,
      framesSeen: h.framesSeen,
      msSinceFrame: h.msSinceFrame,
      healRetries: h.healRetries,
      // "Should it be armed right now?" is a different question from "is it
      // armed" — a wake word the user switched off is DISABLED, not broken.
      expected: window.__wakeExpected !== false
    };
  } catch (e) {
    wake = null;
  }

  let audio = null;
  try {
    const ctx = (window.__orb && window.__orb.audioCtx) || null;
    audio = {
      contextState: ctx ? ctx.state : "none",
      // Only a suspended context that SHOULD be running is a fault.
      expectRunning: !!localWakeRunning(),
      outputAvailable: true
    };
  } catch (e) {
    audio = null;
  }

  return {
    wake,
    audio,
    microphone: window.__micDenied ? "unavailable" : "ok",
    presentationMode: document.body.dataset.presentation || "full",
    pillConnected: document.body.dataset.presentation === "pill" || !!window.__pillConnected,
    terminalBusySince: window.__terminalBusySince || null
  };
}

async function post() {
  try {
    await fetch("/api/health/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collect())
    });
  } catch (e) { /* the server is the thing that notices this */ }
}

/* ------------------------------------------------------------- recovery */

// Registered by main.js, which owns the wake lifecycle. Kept as an explicit
// allowlist so a "recover" instruction arriving over the wire can only ever
// reach these two, entirely local, actions.
const RECOVERIES = {
  wake: () => (window.__artemisRecover && window.__artemisRecover.wake ? window.__artemisRecover.wake() : false),
  audio: () => (window.__artemisRecover && window.__artemisRecover.audio ? window.__artemisRecover.audio() : false),
  presence: () => true   // the reconnect is the report that follows
};

async function handleRecover(target) {
  const fn = RECOVERIES[target];
  if (!fn) return;                       // anything else is ignored outright
  try { await fn(); } catch (e) { /* the next report tells the truth either way */ }
  // Report immediately so the server can VERIFY rather than assume.
  await post();
}

/* ----------------------------------------------------------------- UI */

function badgeEl() {
  let el = document.getElementById("hudHealth");
  if (el) return el;
  const host = document.querySelector(".v3-header-status") || document.querySelector(".hud-top");
  if (!host) return null;
  // One line in the SYSTEM status area the header already is. No new panel,
  // no graph, no layout change.
  el = document.createElement("span");
  el.id = "hudHealth";
  el.className = "hud-health";
  el.title = "System health — click for the full diagnostic";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  const act = () => { void showFullDiagnostic(); };
  el.addEventListener("click", act);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
  host.appendChild(el);
  return el;
}

function render(payload) {
  const el = badgeEl();
  if (!el || !payload || !payload.badge) return;
  el.textContent = `SYSTEM HEALTH ${payload.badge.label}`;
  el.dataset.tone = payload.badge.tone;
  if (payload.issues && payload.issues.length) {
    el.title = payload.issues.map((i) => `${i.label}: ${i.summary}`).join("\n");
  } else {
    el.title = "All core systems are healthy — click for the full diagnostic";
  }
}

async function showFullDiagnostic() {
  try {
    const r = await fetch("/api/health?deep=1", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    render({ badge: j.badge, issues: j.snapshot.issues });
    // Use whatever transcript surface this page already has rather than
    // inventing a panel for it.
    const line = window.__addLine || window.addLine;
    if (typeof line === "function") {
      for (const row of String(j.detail || "").split("\n")) line("status", row);
    } else {
      console.log(j.detail);
    }
  } catch (e) { /* nothing to show */ }
}

/* -------------------------------------------------------------- wiring */

export function startHealthClient() {
  if (window.__healthClientStarted) return;
  window.__healthClientStarted = true;

  void post();
  const timer = setInterval(post, REPORT_MS);
  if (typeof window !== "undefined") window.__healthReportTimer = timer;

  // A dedicated stream keeps this entirely out of main.js's event handling —
  // the server broadcasts health events to every presence client.
  try {
    const openHealthEvents = () => {
      const es = new EventSource("/api/presence/events");
      es.addEventListener("health", (e) => {
        try { render(JSON.parse(e.data)); } catch (err) { /* malformed frame */ }
      });
      es.addEventListener("health-recover", (e) => {
        try { void handleRecover(JSON.parse(e.data).target); } catch (err) { /* ignore */ }
      });
      es.addEventListener("health-say", (e) => {
        try {
          const { text } = JSON.parse(e.data);
          if (!text) return;
          if (typeof window.__artemisSay === "function") window.__artemisSay(text);
          else console.log("[health]", text);
        } catch (err) { /* ignore */ }
      });
      es.onerror = () => { es.close(); setTimeout(openHealthEvents, 2000); };
      window.__healthEvents = es;
    };
    openHealthEvents();
  } catch (e) { /* no SSE: the periodic POST still keeps the server informed */ }

  // Paint something immediately rather than waiting for the first broadcast.
  void fetch("/api/health", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j) render({ badge: j.badge, issues: j.snapshot.issues }); })
    .catch(() => {});
}

export { collect as collectHealthReport, handleRecover as applyHealthRecovery };
