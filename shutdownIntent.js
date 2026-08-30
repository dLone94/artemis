// "Artemis, shut down." — quitting ARTEMIS, and nothing else.
//
// The whole difficulty is disambiguation. "shut it down", "close it", "kill
// it" are things people say about a dev server, a Terminal process, a window,
// or the task she is currently running. Treating those as "quit yourself"
// would make an ordinary sentence terminate the assistant mid-work. So the
// rule is deliberately strict: the utterance must name ARTEMIS, or refer to
// her reflexively ("yourself"). Everything else is left to the normal runtime.
//
// It is equally important that this never reads as a MACHINE shutdown. Powering
// off macOS is a separate privileged action; a match here only ever quits the
// app, and phrases that name the computer are explicitly refused.
//
// Pure — no process control lives here (test/shutdownIntent.test.mjs).

/** The one internal action id. */
export const SHUTDOWN_ACTION = "shutdown_artemis";

// Naming the machine means the OS, never the app. Refused outright so a
// mis-phrased request can never be answered by quitting Artemis instead.
const MACHINE_RE =
  /\b(?:the\s+)?(?:mac(?:book)?|computer|laptop|machine|system|imac|os)\b|\bmac\s?os\b|\bpower\s+off\b|\brestart\s+the\s+(?:mac|computer|laptop|machine)\b/i;

// The verbs that mean "stop running".
const QUIT_VERB = String.raw`(?:shut\s*(?:down|off)|shutdown|quit|exit|close|terminate|stop\s+running|turn\s+(?:yourself\s+)?off)`;

// Form 1 — she is named: "Artemis, shut down", "shut down Artemis", "quit Artemis".
const NAMED_RE = new RegExp(
  String.raw`^\s*(?:hey\s+)?artemis[\s,!.]+(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?` + QUIT_VERB + String.raw`\b` +
    "|" +
    String.raw`\b` + QUIT_VERB + String.raw`\s+(?:yourself\s+)?(?:down\s+)?artemis\b`,
  "i"
);

// Form 2 — reflexive: "shut yourself down", "quit yourself", "close yourself".
const REFLEXIVE_RE = new RegExp(
  String.raw`\b` + QUIT_VERB + String.raw`\s+yourself\b|\byourself\s+(?:down|off)\b`,
  "i"
);

// A question or a hypothetical is not a command.
const NOT_A_COMMAND_RE =
  /\b(?:how\s+do\s+i|how\s+to|can\s+you\s+tell\s+me|what\s+happens\s+(?:if|when)|why\s+(?:do|does|would)|explain)\b/i;

// Explicit negation: "don't shut down", "no need to quit".
const NEGATED_RE =
  /\b(?:don['’]?t|do\s+not|never|no\s+need\s+to|instead\s+of|rather\s+than|without)\b[^.?!]{0,30}\b(?:shut|quit|exit|close|terminate)\b/i;

/**
 * Does this utterance explicitly ask ARTEMIS to quit?
 * @returns {{action: string, reason: string}|null} null when it is not ours.
 */
export function shutdownIntentForText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (NEGATED_RE.test(s)) return null;
  if (NOT_A_COMMAND_RE.test(s)) return null;
  // The machine is never quit by this path — an OS shutdown is privileged and
  // separate. Refuse before matching so "shut down the mac" cannot slip in.
  if (MACHINE_RE.test(s)) return null;
  if (NAMED_RE.test(s)) return { action: SHUTDOWN_ACTION, reason: "named" };
  if (REFLEXIVE_RE.test(s)) return { action: SHUTDOWN_ACTION, reason: "reflexive" };
  return null;
}

/**
 * Work that should not simply be cut off. Uses the task state Artemis already
 * tracks — this invents no new safety system, it reads the existing one.
 * @param {{currentTask?: object|null, approvalState?: object|null, toolState?: object|null}} state
 */
export function shutdownNeedsConfirmation(state = {}) {
  const task = state.currentTask;
  const tool = state.toolState;
  if (state.approvalState) return { confirm: true, why: "an approval is waiting" };
  if (task && task.state === "active") {
    return { confirm: true, why: `I'm still running ${task.label ? `“${task.label}”` : "a task"}` };
  }
  if (tool && tool.phase === "start") {
    return { confirm: true, why: "a tool is still running" };
  }
  return { confirm: false, why: "" };
}

/** What she says on the way out. */
export function shutdownReply(check) {
  return check && check.confirm
    ? `${check.why}. Shut down anyway?`
    : "Shutting down.";
}


// ---- listening-profile override --------------------------------------------
// "Artemis, enable far-field listening." A deterministic, brain-free control
// for the moments AUTO gets it wrong — it pins the capture profile until the
// user releases it back to AUTO.
const FAR_RE = /\b(?:far[\s-]?field|listen\s+from\s+(?:farther|further|far)\s*(?:away)?|from\s+across\s+the\s+room|hear\s+me\s+from\s+(?:farther|further|across))\b/i;
const WHISPER_RE = /\bwhisper(?:ing)?\s+(?:mode|listening)\b|\blisten\s+for\s+whispers?\b/i;
const NORMAL_RE = /\b(?:normal|standard|regular|default)\s+listening\b|\bstop\s+(?:far[\s-]?field|whisper)\b/i;
const DISABLE_RE = /\b(?:disable|turn\s+off|stop|exit|cancel|end)\b/i;
const ENABLE_RE = /\b(?:enable|turn\s+on|use|switch\s+to|start|go)\b/i;

/**
 * @returns {{profile: "FAR_FIELD"|"WHISPER"|null}|null}
 *   profile null means "back to AUTO"; a null return means not our turn.
 */
export function listeningProfileForText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (NORMAL_RE.test(s)) return { profile: null };
  const far = FAR_RE.test(s);
  const whisper = WHISPER_RE.test(s);
  if (!far && !whisper) return null;
  // "disable far-field" releases the pin rather than setting it.
  if (DISABLE_RE.test(s)) return { profile: null };
  // FAR_RE/WHISPER_RE are already specific ("far-field", "listen from farther
  // away", "whisper mode"); requiring an enable verb on top of that rejected
  // the plainest way to ask for it.
  void ENABLE_RE;
  return { profile: far ? "FAR_FIELD" : "WHISPER" };
}
