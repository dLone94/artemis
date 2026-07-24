// When Artemis is allowed to open her mouth.
//
// Extracted from main.js so it can be tested in Node: the old rule lived inside
// a browser-only timer and was the direct cause of the worst bug in the app —
// 1.2 seconds into every turn she said "Let me check" whether or not anything
// was actually running, so a turn that executed nothing still *sounded* like it
// had. The fix is a policy, not a timer, and a policy can be asserted on.
//
// Pure functions. No DOM, no audio, no timers, no imports.

/** The three classes the server assigns a turn. Anything else is "unknown". */
export const INTENT = {
  CHAT: "chat",
  CLARIFY: "needs_clarification",
  ACTION: "executable_action"
};

/**
 * May the client speak a filler ("let me check") while waiting for the first token?
 *
 * No. Never. This exists as a function so the rule is testable and so nobody
 * reintroduces one by accident.
 *
 * It used to fire at 1.2s on every turn, and it was the single most robotic
 * thing about her: a canned phrase from a fixed list of four, delivered whether
 * or not anything was actually happening. On an action turn it was worse than
 * annoying — the client has no idea whether a tool ran, so "let me check" was a
 * promise it had no standing to make.
 *
 * The reason it existed was dead air during tool rounds. That reason is gone:
 * chat turns now reach the first real word in about a second, so the filler
 * mostly arrived on top of the actual answer. A person who is thinking simply
 * pauses; they don't announce that they're about to speak.
 */
export function shouldSpeakFiller() {
  return false;
}

/**
 * Server-side twin: may streamed narration be forwarded to the client as speech
 * yet? On an action turn the first response is withheld until a real tool call
 * has succeeded, so she can never narrate an action that didn't happen. Once the
 * action is satisfied the post-tool answer streams normally.
 */
export function mayStreamNarration({ intentClass, actionSatisfied = false } = {}) {
  if (intentClass === INTENT.ACTION) return actionSatisfied;
  return true;
}

/**
 * What the user hears when an action turn ends with nothing accomplished.
 * Honest failure, never the withheld narration replayed as success.
 */
export function failureLine(family) {
  const byFamily = {
    navigate: "I couldn't open that.",
    media: "I couldn't start that.",
    email: "I couldn't reach your email.",
    reminder: "I couldn't update your reminders.",
    memory: "I couldn't save that.",
    contacts: "I couldn't save that contact.",
    message: "I couldn't send that."
  };
  return (byFamily[family] || "I couldn't do that.") + " Nothing happened on my end.";
}
