// The floating pill's view-model: PRESENCE SNAPSHOT -> PILL VIEW.
//
// Pure, DOM-free, and unit-tested (test/presencePill.test.mjs) so the mapping
// from what Artemis is really doing to what the pill shows lives in one place.
// It consumes the SAME presence state the dashboard publishes — there is no
// second, invented state machine (Part D1).
//
// A pill view is: { state, label, task, tone, energy, signal, motion,
//                   showApproval, approval, sizeClass, capability,
//                   activeSegment }.
//   label     — the short status word shown after "ARTEMIS ·"
//   task      — a short human-readable activity, or "" (never a raw tool name)
//   tone      — drives colour: calm | live | work | hold | fault | ok
//   energy    — 0..1, how much the pill's ring should move
//   signal    — 0..1 real mic/output amplitude (zero outside voice states)
//   motion    — named, state-owned motion grammar; never random telemetry
//   sizeClass — compact | wide | approval; the native panel animates between
//   capability— the leading context of the task ("Terminal"), or ""
//   activeSegment — stable 0..7 segment for a real capability, or -1
//   showApproval — the compact approval state is open
//   approval  — { prompt } when showApproval

const STATE_VIEW = Object.freeze({
  idle:       { label: "Idle",       tone: "calm", energy: 0.12, motion: "drift" },
  listening:  { label: "Listening",  tone: "live", energy: 0.6,  motion: "listen" },
  thinking:   { label: "Thinking",   tone: "work", energy: 0.7,  motion: "reason" },
  processing: { label: "Thinking",   tone: "work", energy: 0.7,  motion: "reason" },
  understanding: { label: "Understanding", tone: "work", energy: 0.65, motion: "reason" },
  researching:{ label: "Researching",tone: "work", energy: 0.7,  motion: "reason" },
  executing:  { label: "Executing",  tone: "work", energy: 0.85, motion: "work" },
  speaking:   { label: "Speaking",   tone: "live", energy: 0.5,  motion: "speak" },
  waiting:    { label: "Waiting for approval", tone: "hold", energy: 0.3, motion: "hold" },
  success:    { label: "Done",       tone: "ok",   energy: 0.2,  motion: "settle" },
  completed:  { label: "Done",       tone: "ok",   energy: 0.2,  motion: "settle" },
  error:      { label: "Error",      tone: "fault",energy: 0.25, motion: "fault" },
  fault:      { label: "Error",      tone: "fault",energy: 0.25, motion: "fault" }
});

/** States that earn the wider pill; idle/done settle back to compact. */
const WIDE_STATES = new Set([
  "listening", "thinking", "processing", "understanding",
  "researching", "executing", "speaking", "waiting", "error", "fault"
]);

const CAPABILITY_LABELS = Object.freeze({
  computer: "Computer",
  contextual: "Context",
  perception: "Perception",
  terminal: "Terminal",
  research: "Research",
  web: "Web",
  radar: "Radar",
  radar_update: "Radar",
  mail: "Mail",
  email: "Mail",
  messages: "Messages",
  meeting: "Meetings",
  gym: "Gym",
  finance: "Finance",
  money: "Finance",
  memory: "Memory",
  media: "Media"
});

/**
 * @param {object} presence - snapshot from /api/presence
 * @returns {{label,task,tone,energy,showApproval,approval,sizeClass,capability,mode}}
 */
export function pillView(presence = {}) {
  const p = presence || {};
  // A pending approval always wins the display — the user must see it.
  const approval = p.approvalState || p.pendingConfirm;
  if (approval) {
    return {
      mode: p.mode || "pill",
      label: "Waiting for approval",
      task: "",
      tone: "hold",
      energy: 0.3,
      signal: 0,
      motion: "hold",
      state: "waiting",
      sizeClass: "approval",
      capability: capabilityLabel(p.capability || approval.tool),
      activeSegment: capabilitySegment(p.capability || approval.tool),
      brainLabel: brainLabel(p),
      brainStatus: brainStatus(p),
      showApproval: true,
      approval: { prompt: approval.prompt || approval.name || "Confirm?", confirmId: approval.confirmId || null },
      muted: !!p.muted
    };
  }
  // The interpreter resolving an utterance outranks the generic mic state —
  // "Understanding…" is the honest activity while it runs.
  const state = p.interpreting ? "understanding" : String(p.state || "idle");
  const base = STATE_VIEW[state] || STATE_VIEW.idle;
  // Live amplitude modulates ring energy while listening/speaking; otherwise the
  // state's own energy governs. Never fabricate motion when there is no signal.
  let signal = 0;
  let energy = base.energy;
  if ((state === "listening" || state === "speaking") && typeof p.amplitude === "number") {
    signal = Math.max(0, Math.min(1, p.amplitude));
    // State keeps the core legible at silence; real signal supplies most of
    // the movement. This prevents a fake waveform while avoiding a dead dot.
    energy = Math.min(1, base.energy * 0.35 + signal * 0.65);
  }
  const task = shortTask((p.currentTask && p.currentTask.label) || p.task);
  const capability = capabilityLabel(
    p.capability || p.activeCapability || (p.currentTask && p.currentTask.capability)
  ) || capabilityOf(task);
  return {
    mode: p.mode || "full",
    state,
    label: base.label,
    task,
    tone: base.tone,
    energy,
    signal,
    motion: base.motion,
    sizeClass: WIDE_STATES.has(state) || task ? "wide" : "compact",
    capability,
    activeSegment: capabilitySegment(capability),
    brainLabel: brainLabel(p),
    brainStatus: brainStatus(p),
    showApproval: false,
    approval: null,
    muted: !!p.muted
  };
}

/** Trim a task label; never surface a raw tool function name. */
export function shortTask(task) {
  const t = String(task || "").trim();
  if (!t) return "";
  if (/^[a-z_]+$/.test(t)) return ""; // looks like a bare tool name — drop it
  return t.length > 42 ? t.slice(0, 41) + "…" : t;
}

/** "Terminal · Running npm test" → "Terminal"; plain tasks have no capability. */
export function capabilityOf(task) {
  const t = String(task || "");
  const parts = t.split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  // Contextual tasks lead with their target ("Terminal · Selecting option").
  // The main Core's tool view appends an uppercase domain
  // ("Opening site · RESEARCH"). Support both existing contracts.
  const last = parts.at(-1);
  if (/^[A-Z][A-Z\s-]{2,}$/.test(last)) return last;
  return parts[0];
}

/** Turn a presence family/tool label into concise display copy. */
export function capabilityLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (CAPABILITY_LABELS[key]) return CAPABILITY_LABELS[key];
  const clean = raw.replace(/_/g, " ").replace(/\s+/g, " ");
  if (!clean || clean.length > 24) return "";
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

/** Stable visual routing: a real capability lights one of eight core arcs. */
export function capabilitySegment(capability) {
  const key = String(capability || "").trim().toLowerCase();
  if (!key) return -1;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 8;
}

function brainLabel(presence) {
  const brain = presence && presence.brain;
  const label = String((brain && (brain.model || brain.name)) || presence.model || "").trim();
  if (!label) return "";
  return label.length > 22 ? label.slice(0, 21) + "…" : label;
}

function brainStatus(presence) {
  if (presence && presence.offline) return "OFFLINE";
  if (presence && presence.networkMode === "local-only") return "LOCAL";
  if (presence && presence.brain) return presence.brain.local ? "LOCAL" : "CLOUD";
  return "";
}

/** One-line caption for the pill, e.g. "ARTEMIS · Listening" or "Terminal · Running tests". */
export function pillCaption(view) {
  if (view.task) return view.task;
  return `ARTEMIS · ${view.label}`;
}

/** Native panel sizes per class — one place, shared with the shell. */
export const PILL_SIZES = Object.freeze({
  compact:  { width: 68,  height: 68 },
  wide:     { width: 300, height: 76 },
  approval: { width: 328, height: 166 }
});

export const PILL_STATES = STATE_VIEW;
