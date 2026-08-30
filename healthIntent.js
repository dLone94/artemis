// "Artemis, run a self-check." — recognising the ask, and answering it briefly.
//
// Deterministic on both sides. The classifier is a pattern match, and the
// phrasing is assembled from the health snapshot's own fields, so a model is
// never in a position to invent a subsystem, a status or a reassurance. The
// health manager is the only source of truth about health; this file just
// chooses words for it.
//
// The default answer is SHORT on purpose. A health report that recites twenty
// green lines every time is one the user stops listening to, and then the one
// time it matters they miss it.
//
// Pure (test/healthIntent.test.mjs).

import { HEALTHY, DEGRADED, FAILED, RECOVERING, DISABLED, UNKNOWN } from "./selfHealth.js";

/* --------------------------------------------------------- recognising it */

// Depth first: "give me a FULL diagnostic" must not be swallowed by the plain
// diagnostic pattern, so the deep test runs before the quick one.
const DEEP_RE = new RegExp(
  [
    String.raw`\b(?:full|complete|deep|detailed|thorough|proper|extended)\s+(?:system\s+)?(?:diagnostic|diagnostics|self[\s-]?check|check[\s-]?up|health\s+check|report)\b`,
    String.raw`\bdiagnos(?:e|tics?)\b[^.?!]{0,20}\bin\s+(?:full|detail)\b`,
    String.raw`\b(?:everything|all)\s+in\s+detail\b`,
    String.raw`\bdeep\s+(?:scan|check)\b`,
    String.raw`\bfull\s+(?:health\s+)?report\b`
  ].join("|"),
  "i"
);

const QUICK_RE = new RegExp(
  [
    String.raw`\b(?:run|do|perform|start)\s+(?:a\s+|the\s+)?(?:self[\s-]?check|self[\s-]?test|diagnostic|diagnostics|health\s+check|system\s+check)\b`,
    String.raw`\bcheck\s+yourself\b`,
    String.raw`\bself[\s-]?(?:check|test|diagnos(?:e|tic|tics))\b`,
    String.raw`\bdiagnose\s+yourself\b`,
    String.raw`\bare\s+(?:all\s+)?(?:your|the)\s+systems?\s+(?:working|ok|okay|healthy|fine|alright)\b`,
    String.raw`\bis\s+(?:anything|something)\s+(?:wrong|broken|failing|down|malfunctioning)\b`,
    String.raw`\bwhat(?:['’]s|\s+is)\s+(?:wrong|broken|malfunctioning|failing|not\s+working)\b`,
    String.raw`\bare\s+you\s+(?:ok|okay|working|healthy|alright|functioning)\b`,
    String.raw`\bhow\s+are\s+(?:your|the)\s+systems?\b`,
    String.raw`\b(?:system|systems)\s+(?:health|status)\b`,
    String.raw`\bhealth\s+(?:check|status|report)\b`,
    String.raw`\banything\s+(?:wrong|broken|failing)\b`
  ].join("|"),
  "i"
);

// A question about the concept, or somebody else's systems, is not a request.
const NOT_OURS_RE =
  /\bhow\s+(?:do|would)\s+i\b|\bwhat\s+(?:does|is)\s+a\s+(?:self[\s-]?check|diagnostic)\b|\bmy\s+(?:mac|computer|laptop)['’]?s?\s+(?:health|diagnostic)\b/i;

/**
 * Does this utterance ask Artemis to check herself?
 * @returns {{depth: "quick"|"deep"}|null}
 */
export function healthIntentForText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (NOT_OURS_RE.test(s)) return null;
  if (DEEP_RE.test(s)) return { depth: "deep" };
  if (QUICK_RE.test(s)) return { depth: "quick" };
  return null;
}

/* ------------------------------------------------------------- phrasing */

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n) => (n <= 10 ? NUMBER[n] : String(n));

/** Lowercase label, used mid-sentence. */
function name(issue) {
  return String(issue.label || issue.id || "a subsystem");
}

/**
 * The spoken phrase for a known fault.
 *
 * A probe summary is written to be READ — it can carry a remedy, a measurement
 * or a dev marker. These are written to be HEARD: one clause, no jargon, no
 * numbers the ear cannot hold. Keyed by error code because the code is the
 * stable thing; labels and summaries are free to be rewritten.
 */
const SPOKEN = {
  PERMISSION_SCREEN_RECORDING_MISSING: "Screen Recording permission is missing",
  PERMISSION_ACCESSIBILITY_MISSING: "Accessibility permission is missing",
  PERMISSION_AUTOMATION_MISSING: "Automation permission is missing",
  VOICE_MIC_PERMISSION: "the microphone permission is denied",
  VOICE_MIC_UNAVAILABLE: "the microphone is unavailable",
  VOICE_WAKE_NOT_ARMED: "the wake listener is not armed",
  VOICE_WAKE_STALLED: "the wake listener is not hearing anything",
  VOICE_WAKE_HELPER_DEAD: "the wake listener has stopped",
  VOICE_AUDIO_STUCK: "the audio engine is stuck",
  STT_LOCAL_MODEL_MISSING: "the local speech model is not installed",
  STT_LOCAL_BINARY_MISSING: "local speech recognition is unavailable",
  STT_LOCAL_PROCESS_FAILURE: "local speech recognition is failing",
  TTS_UNAVAILABLE: "I have no speech output",
  MODEL_LOCAL_UNREACHABLE: "the local AI model is unavailable",
  MODEL_MISSING: "the local AI model is not installed",
  MODEL_PROVIDER_BENCHED: "the cloud models are rate-limited",
  RUNTIME_SERVER_DOWN: "my server is not responding",
  RUNTIME_PRESENCE_STALE: "my presence stream has gone quiet",
  RUNTIME_WEBVIEW_DISCONNECTED: "the dashboard has disconnected",
  RUNTIME_TOOLS_INCOMPLETE: "some of my tools did not load",
  RUNTIME_SKILLS_ERROR: "my skills did not load",
  RUNTIME_CONTEXT_UNAVAILABLE: "my working context is unavailable",
  RUNTIME_PILL_DISCONNECTED: "the floating pill is not responding",
  PERCEPTION_OCR_MISSING: "screen reading is unavailable",
  TERMINAL_UNAVAILABLE: "Terminal control is unavailable",
  STORAGE_LOW_SPACE: "disk space is low",
  STORAGE_CRITICAL_SPACE: "disk space is critically low",
  STORAGE_NOT_WRITABLE: "I cannot write to my data folder",
  STORAGE_LOG_GROWTH: "my logs have grown large",
  INTEGRATION_AUTH_EXPIRED: "Gmail authentication has expired",
  NETWORK_UNAVAILABLE: "I have no network connection",
  POLICY_VIOLATION_CLOUD_IN_LOCAL_ONLY: "something tried to reach the cloud while local-only is on",
  PROBE_ERROR: "one of my checks could not complete"
};

/**
 * Make a probe summary safe to say out loud.
 *
 * Probe summaries are display strings, not speech: they carry remedies after an
 * em-dash, dev markers in parentheses, and occasionally a trailing colon. All
 * of that reads as broken when spoken.
 */
function cleanPhrase(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.split(" — ")[0].split(" - ")[0];      // the remedy belongs in the report
  t = t.replace(/\s*\([^)]*\)\s*$/, "");      // "(injected)" and friends
  t = t.replace(/[\s:;,]+$/, "");             // never end on a dangling colon
  return t.replace(/\s+/g, " ").trim();
}

/**
 * One issue as a single spoken clause.
 *
 * The bug this replaces: the old version pasted "<label>: <summary>" together
 * whenever the summary started lowercase, which produced
 * "local speech recognition: local speech recognition is unavailable" — the
 * label was already the first words of the summary. A label is now only ever
 * used when the phrase does not already name the thing.
 */
function describe(issue) {
  if (!issue) return "";
  const label = name(issue);

  if (issue.recoveryState === "recovering" || issue.status === RECOVERING) {
    return `${label} stopped, and I am restoring it`;
  }

  // A curated phrase is written for speech and already names its subject, so it
  // is used verbatim. Second-guessing it is how "my presence stream has gone
  // quiet" got thrown away for "presence bus is not working".
  const canned = issue.errorCode && SPOKEN[issue.errorCode];
  if (canned) return canned;

  // Otherwise fall back to the probe's own words, which were written to be READ.
  const phrase = cleanPhrase(issue.summary);
  const stateWord = issue.status === FAILED ? "is not responding" : "is degraded";
  if (!phrase) return `${label} ${stateWord}`;

  // Use the summary only if it actually names the subsystem — a bare
  // observation like "no presence update in 146 seconds" has no subject, and
  // gluing the label on with a colon is exactly the bug being fixed.
  return phrase.toLowerCase().includes(label.toLowerCase()) ? phrase : `${label} ${stateWord}`;
}

/** "a, b, and c" — with the last two joined by "and" at every length. */
function listPhrases(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** How many issues get named before the rest are totalled. */
const NAMED_LIMIT = 3;

/**
 * The list half of the sentence: every issue named up to the limit, then a
 * truthful total for the remainder.
 *
 * Built from the SAME array the count comes from, which is the invariant the
 * old version broke — it counted all the issues and then listed two of them.
 */
function issueList(issues) {
  const phrases = issues.map(describe);
  if (phrases.length <= NAMED_LIMIT) return listPhrases(phrases);

  const rest = issues.slice(2);
  // "Degraded" would be wrong if any of the remainder has actually failed.
  const verb = rest.some((i) => i.status === FAILED) ? "need attention" : "are degraded";
  const tail = `${count(rest.length)} other system${rest.length === 1 ? "" : "s"} ${verb}`;
  return listPhrases([...phrases.slice(0, 2), tail]);
}

/**
 * The default spoken answer — one or two sentences, never a recital.
 *
 * @param {object} snap  a snapshot from SelfHealthManager
 */
export function healthReply(snap) {
  if (!snap) return "I couldn't establish my own status.";
  const issues = snap.issues || [];

  if (!issues.length) {
    if (snap.overall === UNKNOWN) return "I haven't finished checking myself yet.";
    return "All core systems are healthy.";
  }

  const recovering = issues.filter((i) => i.recoveryState === "recovering" || i.status === RECOVERING);
  if (recovering.length === 1 && issues.length === 1) {
    return `My ${name(recovering[0])} stopped. I'm restoring it now.`;
  }

  if (issues.length === 1) {
    // A fault that keeps coming back is worth one extra clause — but only here,
    // where there is room for it.
    const repeat = issues[0].repeatedFault >= 3 ? ", and it keeps happening" : "";
    return `I found one issue. ${sentence(describe(issues[0]) + repeat)}`;
  }

  return `I found ${count(issues.length)} issues. ${sentence(issueList(issues))}`;
}

function sentence(text) {
  const t = String(text).trim();
  if (!t) return "";
  const capped = t[0].toUpperCase() + t.slice(1);
  return /[.?!]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * What to say at startup — or nothing at all.
 *
 * Silence is the correct output for a healthy machine: the UI already shows
 * NOMINAL, and a spoken all-clear on every launch is noise.
 * @returns {string|null}
 */
export function startupAnnouncement(snap) {
  if (!snap || !snap.issues || !snap.issues.length) return null;
  const critical = snap.issues.filter((i) => i.critical && i.status === FAILED);
  if (critical.length) {
    const first = critical[0];
    return first.recoveryState === "recovering" || snap.recovering
      ? `I found a problem with my ${name(first)}. I'm trying to restore it.`
      : `I found a problem with my ${name(first)}. ${sentence(describe(first))}`;
  }
  // Degraded-only at startup gets one calm sentence, with the reassurance the
  // brief explicitly asked for.
  if (snap.issues.length === 1) {
    return `I found one issue. ${sentence(describe(snap.issues[0]))} Everything else is working.`;
  }
  // Same list/count discipline as healthReply — never a count that outruns the
  // things actually named.
  return `I found ${count(snap.issues.length)} issues. ${sentence(issueList(snap.issues))}`;
}

/** Said when a silent recovery actually worked and the user should know. */
export function recoveredAnnouncement(label) {
  return `${String(label || "That subsystem").replace(/^./, (c) => c.toUpperCase())} restored.`;
}

/* ------------------------------------------------------ full diagnostic */

const CATEGORY_TITLES = {
  voice: "VOICE",
  ai: "AI",
  runtime: "RUNTIME",
  computer: "COMPUTER",
  storage: "STORAGE",
  integrations: "INTEGRATIONS",
  network: "NETWORK"
};

const STATUS_WORDS = {
  [HEALTHY]: "Healthy",
  [DEGRADED]: "Degraded",
  [FAILED]: "Failed",
  [RECOVERING]: "Recovering",
  [DISABLED]: "Disabled",
  [UNKNOWN]: "Unknown"
};

/** Turn a component id fragment into something a person reads comfortably. */
function pretty(label, key) {
  if (label && label !== key) return label[0].toUpperCase() + label.slice(1);
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The detailed report, only when asked for. Readable rather than exhaustive:
 * a status word per component, the reason when there is one, and the overall
 * verdict at the bottom.
 */
export function fullDiagnosticText(snap) {
  if (!snap || !snap.subsystems) return "I couldn't establish my own status.";
  const lines = [];
  for (const [category, data] of Object.entries(snap.subsystems)) {
    lines.push(CATEGORY_TITLES[category] || category.toUpperCase());
    for (const [key, c] of Object.entries(data.components)) {
      let line = `${pretty(c.label, key)}: ${STATUS_WORDS[c.status] || c.status}`;
      // Say WHY, but only when the status alone is not the whole story.
      if (c.status === DISABLED && c.details && c.details.reason === "mode") line += " by Local-Only mode";
      else if (c.status === DISABLED && c.details && c.details.reason === "unconfigured") line += " — not configured";
      else if (c.status !== HEALTHY && c.summary) line += ` — ${c.summary}`;
      if (c.dependency) line += ` (caused by ${c.dependency})`;
      lines.push(line);
      // The remedy is kept out of the spoken summary but belongs here, where
      // the user is actually asking what to do about it.
      if (c.details && c.details.fix && c.status !== HEALTHY) lines.push(`  → ${c.details.fix}`);
    }
    lines.push("");
  }
  lines.push(`Overall: ${STATUS_WORDS[snap.overall] || snap.overall}`);
  return lines.join("\n");
}

/** The one-line UI summary: "NOMINAL" or "1 DEGRADED". */
export function healthBadge(snap) {
  if (!snap) return { label: "UNKNOWN", tone: "unknown" };
  const issues = snap.issues || [];
  if (!issues.length) {
    return snap.overall === UNKNOWN
      ? { label: "CHECKING", tone: "unknown" }
      : { label: "NOMINAL", tone: "ok" };
  }
  const failed = issues.filter((i) => i.status === FAILED).length;
  if (failed) return { label: `${failed} FAILED`, tone: "critical" };
  const recovering = issues.filter((i) => i.status === RECOVERING).length;
  if (recovering === issues.length) return { label: `${recovering} RECOVERING`, tone: "warn" };
  return { label: `${issues.length} DEGRADED`, tone: "warn" };
}
