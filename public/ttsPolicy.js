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
 * May the client speak a filler ("one moment") while waiting for the first token?
 *
 * The rule that matters: never on a turn that is supposed to *do* something.
 * A filler on an action turn is a promise the client is in no position to make —
 * it has no idea whether the tool ran. Silence costs a moment of dead air; a
 * false promise costs the user's trust that anything works.
 *
 * Unknown intent is treated as an action turn. The server sends `intent_pending`
 * before it invokes the model, so "unknown" means something went wrong, and the
 * safe answer when we don't know is to say nothing.
 */
export function shouldSpeakFiller({ intentClass, gotToken = false, busy = true } = {}) {
  if (!busy || gotToken) return false;
  return intentClass === INTENT.CHAT;
}

/** Pick a filler phrase. `rand` is injectable so tests aren't random. */
const FILLERS = ["Let me check.", "One moment.", "Looking into it.", "Give me a second."];
export function fillerFor(intentClass, rand = Math.random) {
  if (!shouldSpeakFiller({ intentClass, gotToken: false, busy: true })) return null;
  return FILLERS[Math.floor(rand() * FILLERS.length)];
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
