// Deterministic natural phrasing for known outcomes — no model, no cost, no
// latency, and it works with the Wi-Fi off. A response here is one short
// spoken line that says what actually happened, in the register a person
// would use: "Done — Terminal's open", not "Command executed successfully".
//
// Variation pools keep her from sounding like a recording without inventing
// personality: the picker is injectable (tests pin variant 0; the runtime
// rotates). Any text that came from the screen has already been sanitized by
// naturalCommand.sanitizeLabel before it reaches a template.

const POOLS = Object.freeze({
  terminal_open: [
    "Terminal's open.",
    "Done — Terminal is up."
  ],
  typed: [
    (e) => `Typed \`${e.text}\` — I haven't run it.`,
    (e) => `I typed \`${e.text}\`. It's waiting, not run.`
  ],
  typed_run: [
    (e) => `Done — I ran \`${e.text}\`.`,
    (e) => `Ran \`${e.text}\`.`
  ],
  selected: [
    (e) => `Got it — picked option ${e.n}${e.label ? `, ${e.label}` : ""}.`,
    (e) => `Done — option ${e.n}${e.label ? ` (${e.label})` : ""} it is.`
  ],
  pressed_enter: [
    "Pressed Enter.",
    "Done — Enter."
  ],
  relayed: [
    (e) => `Told it "${e.text}".`,
    (e) => `Sent "${e.text}" to the terminal.`
  ],
  repeat: [
    (e) => `Running \`${e.text}\` again.`,
    (e) => `Same as before — \`${e.text}\`.`
  ],
  revalidation_failed: [
    "The screen changed before I could act, so I didn't touch it.",
    "That menu's gone now — I left it alone."
  ],
  app_open: [
    (e) => `${e.name}'s open.`,
    (e) => `Opened ${e.name}.`
  ],
  app_missing: [
    (e) => `I can't find ${e.name} installed on this Mac.`
  ],
  app_ambiguous: [
    (e) => `I found ${e.candidates.join(" and ")}. Which one do you mean?`
  ],
  wrong_app: [
    (e) => `I can only drive the Terminal app for that, and ${e.application || "something else"} is in front right now.`
  ],
  busy: [
    "One thing at a time — I'm still finishing the last command.",
    "Still on the previous one — give me a second."
  ],
  offline: [
    "I'm offline, but I can still handle local commands.",
    "No internet right now — local commands still work."
  ],
  no_local_brain: [
    "That needs some thinking and I'm offline without a local model. Try telling me exactly what to type.",
    "I can't reason that one out offline. Say it literally — like \"type 1 and press enter\"."
  ],
  clarify: [
    (e) => e.question
  ],
  failed: [
    (e) => `That didn't go through. ${e.reason || ""}`.trim()
  ]
});

/** Rotating per-kind picker so repeated outcomes don't sound identical. */
export function createReplyPicker() {
  const counts = new Map();
  return (kind, poolSize) => {
    const n = counts.get(kind) || 0;
    counts.set(kind, n + 1);
    return n % poolSize;
  };
}

/**
 * @param {{kind: string}} event one of the POOLS keys plus its fields
 * @param {{pick?: (kind, poolSize) => number}} opts injectable for tests
 * @returns {string} one natural spoken line ("" for unknown kinds)
 */
export function naturalReply(event, opts = {}) {
  const kind = event && event.kind;
  const pool = POOLS[kind];
  if (!pool) return "";
  const pick = typeof opts.pick === "function" ? opts.pick : () => 0;
  const variant = pool[Math.max(0, Math.min(pool.length - 1, pick(kind, pool.length)))];
  return typeof variant === "function" ? variant(event) : variant;
}

export const REPLY_KINDS = Object.freeze(Object.keys(POOLS));
