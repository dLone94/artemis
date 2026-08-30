// The Artemis Core's view-model: REAL STATE -> UI ADAPTER -> CORE.
//
// This module is deliberately pure — no DOM, no canvas, no timers — so the
// mapping from what Artemis is actually doing to what the Core displays lives
// in exactly one place and can be unit-tested in node (test/coreState.test.mjs)
// without a browser. The renderer asks this what to draw; it never decides.
//
// It maps the state the app ALREADY has, rather than inventing a parallel
// machine:
//   orb.setStatus()   -> idle | listening | thinking | speaking | error
//   SSE `tool` event  -> { name, family, phase, ok }
//   SSE `intent_pending` -> { intent }
//   main.js           -> pendingConfirm (a yes/no gate is open)
//
// The labels match the app's existing STATE_LABEL vocabulary in cockpit.js
// (STANDBY / LISTENING / PROCESSING / EXECUTING / SPEAKING / FAULT) so the Core
// and the HUD caption never disagree about what Artemis is doing.

import { capabilityForFamily, CAPABILITIES } from "./coreCapabilities.js";

/**
 * Visual states the Core can render. `tone` drives colour; `energy` drives how
 * much the rings move (0 = calm, 1 = agitated). Adding a state here is all a
 * future coding-agent integration needs — see ACCEPTS_LATER below.
 */
export const CORE_STATES = Object.freeze({
  standby:    { label: "STANDBY",    tone: "calm",  energy: 0.12 },
  listening:  { label: "LISTENING",  tone: "live",  energy: 0.55 },
  processing: { label: "PROCESSING", tone: "work",  energy: 0.7 },
  researching:{ label: "RESEARCHING",tone: "work",  energy: 0.7 },
  executing:  { label: "EXECUTING",  tone: "work",  energy: 0.85 },
  speaking:   { label: "SPEAKING",   tone: "live",  energy: 0.5 },
  waiting:    { label: "WAITING",    tone: "hold",  energy: 0.3 },
  fault:      { label: "FAULT",      tone: "fault", energy: 0.25 },
  // Not emitted by anything today. The coding-agent workflow described in the
  // brief can drive these by passing `stage` without touching the renderer.
  analyzing:  { label: "ANALYZING",  tone: "work",  energy: 0.7 },
  testing:    { label: "RUNNING TESTS", tone: "work", energy: 0.8 },
  editing:    { label: "EDITING",    tone: "work",  energy: 0.75 },
  verifying:  { label: "VERIFYING",  tone: "work",  energy: 0.6 }
});

/** Stages a future coding agent may pass through `stage`; nothing emits these yet. */
export const ACCEPTS_LATER = Object.freeze(["analyzing", "testing", "editing", "verifying"]);

/** Families that read as research rather than generic tool execution. */
const RESEARCH_FAMILIES = Object.freeze(["research", "web", "radar", "radar_update"]);

/**
 * Human-readable activity for a tool. Deliberately a small, explicit table:
 * raw tool names are internal implementation detail and some of them
 * ("followups_nudge") would read as noise in the hero position.
 *
 * Unknown tools fall back to a de-underscored title, which is still honest —
 * we never claim an action we did not observe.
 */
const TOOL_ACTIVITY = Object.freeze({
  play_media: "Opening media",
  open_url: "Opening site",
  web_search: "Searching the web",
  check_email: "Checking mail",
  read_email: "Reading mail",
  delete_email: "Moving mail to trash",
  check_messages: "Checking messages",
  send_message: "Drafting a message",
  save_note: "Saving a note",
  read_notes: "Reading notes",
  set_reminder: "Setting a reminder",
  list_reminders: "Listing reminders",
  daily_brief: "Building your brief",
  money_map: "Opening your money map",
  opportunity_radar: "Running the radar",
  log_set: "Logging a set",
  meeting_notes: "Writing meeting notes"
});

/** Turn a raw tool name into concise human activity, never raw internals. */
export function activityForTool(name) {
  if (typeof name !== "string" || !name.trim()) return "";
  const key = name.trim().toLowerCase();
  if (TOOL_ACTIVITY[key]) return TOOL_ACTIVITY[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * Strip anything that should never reach the hero HUD. Error text can carry a
 * provider payload, a URL with a token, or a stack trace; the Core shows a
 * short human line or nothing at all.
 */
export function safeErrorLine(text) {
  if (typeof text !== "string") return "";
  const first = text.split("\n")[0].trim();
  if (!first) return "";
  if (/\b(at\s+\w+\s*\(|https?:\/\/|[A-Za-z0-9_-]{24,}|sk-|Bearer\s)/.test(first)) return "";
  return first.length > 80 ? first.slice(0, 77).trimEnd() + "…" : first;
}

/**
 * Derive everything the Core renders from real application state.
 *
 * @param {object} input
 * @param {string} input.status         orb status: idle|listening|thinking|speaking|error
 * @param {object|null} input.tool      last SSE tool event {name, family, phase, ok}
 * @param {boolean} input.pendingConfirm a spoken yes/no gate is open
 * @param {string} input.stage          optional future coding-agent stage
 * @param {string} input.errorText      optional human error description
 * @returns {{state:string,label:string,tone:string,energy:number,task:string,detail:string,capability:number}}
 */
export function deriveCoreState(rawInput = {}) {
  // A default parameter does NOT cover an explicit null, and this runs inside
  // the render loop — one throw here blanks the whole hero visualization.
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const status = typeof input.status === "string" ? input.status : "idle";
  const tool = input.tool && typeof input.tool === "object" ? input.tool : null;
  const running = tool && tool.phase === "start" ? tool : null;
  const capability = running ? capabilityForFamily(running.family) : -1;

  let key = "standby";
  let task = "No active task";
  let detail = "";

  // A future coding-agent stage wins when the app supplies one — it is more
  // specific than the generic voice status it would otherwise be riding on.
  if (typeof input.stage === "string" && ACCEPTS_LATER.includes(input.stage)) {
    key = input.stage;
    task = CORE_STATES[key].label;
  } else if (status === "error") {
    key = "fault";
    task = "Something went wrong";
    detail = safeErrorLine(input.errorText);
  } else if (input.pendingConfirm) {
    // The confirm gate outranks the mic state: the mic is open precisely
    // BECAUSE she is waiting on your yes or no, and that is the real activity.
    key = "waiting";
    task = "Waiting for your confirmation";
  } else if (running) {
    // A live tool is the most specific truth available about what she is doing.
    const isResearch = RESEARCH_FAMILIES.includes(String(running.family || "").toLowerCase());
    key = isResearch ? "researching" : "executing";
    task = activityForTool(running.name);
    detail = capability >= 0 ? CAPABILITIES[capability].title : "";
  } else if (status === "listening") {
    key = "listening";
    task = "Listening…";
  } else if (status === "thinking") {
    key = "processing";
    task = "Thinking…";
  } else if (status === "speaking") {
    key = "speaking";
    task = "Responding…";
  }

  const spec = CORE_STATES[key];
  return {
    state: key,
    label: spec.label,
    tone: spec.tone,
    energy: spec.energy,
    task,
    detail,
    capability
  };
}
