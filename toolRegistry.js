// The tool registry — one source of truth for what Artemis can actually do.
//
// Before this existed, the same knowledge was spread across four places that
// drifted apart: nvidiaTools() built the schemas inline, skills.js exported a
// separate static list, an ad-hoc "openish" regex decided when to force a tool,
// and nothing validated a call before it was recorded as done. That drift is
// what let her say "opening it now" while calling nothing.
//
// Everything downstream now reads from here: which tools are advertised, which
// are actually available right now, what a user's turn is asking for, whether a
// call is well-formed, whether it needs a spoken yes, and whether the action can
// be reported as done.
//
// Pure and dependency-light on purpose — server.js passes in the capability
// flags, so this module is unit-testable with no network and no env.

import { skillToolDefs, getSkill } from "./skills.js";

// Tools implemented directly in server.js rather than as skills.
const NATIVE_DEFS = [
  {
    name: "web_search",
    description:
      "Search the web for current/live information — news, weather, prices, places, restaurants, anything time-sensitive. Returns top results with snippets (and sometimes a direct answer).",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] }
  },
  {
    name: "fetch_page",
    description: "Fetch and read the readable text of a specific web page URL.",
    parameters: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer" } }, required: ["url"] }
  }
];

// Per-tool metadata the schemas never carried.
//   family   — the capability group a user request maps onto
//   effect   — read (no side effects) | client (browser does something) |
//              mutate/mutation (writes state; mutation is the current spelling)
//   requires — capability flag that must be true for this tool to be offered
//   external — the effect leaves this machine and can't be undone (always confirmed)
//   confirm  — "always" for an action that must never execute without a spoken yes
//   forceFamilies — routing keys that may force-select the tool; defaults to family
const META = {
  web_search:      { family: "web",      effect: "read",   requires: "search" },
  fetch_page:      { family: "web",      effect: "read",   requires: "search" },
  web_research:    { family: "web",      effect: "read",   requires: "search" },
  open_url:        { family: "navigate", effect: "client" },
  play_media:      { family: "media",    effect: "client" },
  check_email:     { family: "email",    effect: "read",   requires: "gmail" },
  read_email:      { family: "email",    effect: "read",   requires: "gmail" },
  delete_email:    {
    family: "email",
    effect: "mutation",
    requires: "gmail",
    confirm: "always",
    forceFamilies: ["email_delete"]
  },
  check_messages:  { family: "messages", effect: "read" },
  research_investment: { family: "research", effect: "read", requires: "search" },
  set_reminder:    { family: "reminder", effect: "mutate" },
  cancel_reminder: { family: "reminder", effect: "mutate" },
  list_reminders:  { family: "reminder", effect: "read" },
  remember_note:   { family: "memory",   effect: "mutate" },
  recall_notes:    { family: "memory",   effect: "read" },
  add_contact:     { family: "contacts", effect: "mutate" },
  send_message:    { family: "message",  effect: "mutate", external: true }
};

// Families where "she said she'd do it" is a promise a user can watch fail.
// A request in one of these families must produce a real tool call. Plain
// information questions (family "web") stay conversational — forcing a search on
// every "what do you think about…" would break normal talking.
export const ACTIONABLE_FAMILIES = new Set([
  "navigate",
  "media",
  "email",
  "email_delete",
  "messages",
  "reminder",
  "memory",
  "contacts",
  "message",
  "research"
]);

const EMAIL_LIST_POSITION =
  String.raw`(?:\d+|numbers?\s+(?:one|two|three|four|five|six|seven|eight|nine|ten)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)`;
const EMAIL_DELETE_PATTERN = new RegExp(
  String.raw`\b(?:delete|trash)\b(?=[^.?!]{0,60}\b(?:e-?mails?|mail)\b)(?=[^.?!]{0,60}\b${EMAIL_LIST_POSITION}\b)[^.?!]{0,60}` +
    "|" +
    String.raw`\bmove\b(?=[^.?!]{0,60}\b(?:e-?mails?|mail)\b)(?=[^.?!]{0,60}\b${EMAIL_LIST_POSITION}\b)[^.?!]{0,60}\b(?:to\s+)?trash\b`,
  "i"
);

// Phrases that map a user's words onto a family. Recall-biased: it is much worse
// to miss a real request (she narrates and does nothing — the bug) than to force
// a tool on a borderline turn (she does the thing).
const FAMILY_PATTERNS = {
  navigate: /\b(open|pull\s+up|show\s+me|take\s+me\s+to|navigate\s+to|launch|bring\s+up|go\s+to|visit)\b/i,
  media:    /\b(play|put\s+on|queue\s+up|youtube|spotify|some\s+music|a\s+song|the\s+video)\b/i,
  messages: /\b(any(?:\s+(?:new|unread))?\s+(?:whatsapp\s+)?messages?|unread\s+(?:whatsapp\s+)?messages?|new\s+whatsapp\s+messages?|check\s+(?:my\s+)?whatsapp|any\s+whatsapp|did\s+anyone\s+message\s+me)\b/i,
  // Deliberately NOT bare "research" or "look into". Those are how people ask
  // about anything at all — "research what's on Hacker News" was being routed to
  // the investment brief, which is a worse answer than no answer. The request has
  // to be finance-shaped: either an explicit money verb, or a research verb whose
  // object is a financial instrument.
  research: /\b(invest(?:ing|ment)?s?\s+in|worth\s+investing|good\s+investment|should\s+i\s+(?:buy|invest)|portfolio|asset\s+class)\b|\b(?:research|look\s+into|dig\s+into|analy[sz]e)\b[^.?!]{0,60}\b(bond|bonds|t-?bill|t-?bills|treasury|treasuries|equit(?:y|ies)|stock|stocks|share|shares|etfs?|fund|funds|yield|yields|currency|forex|fx|inflation|interest\s+rate|eurobonds?|sovereign|reits?|commodit(?:y|ies)|gold|crypto|bitcoin|savings|pension|annuit(?:y|ies))\b/i,
  // Deletion gets a narrower force route than ordinary email reads. It must
  // include a spoken list position; query-shaped "delete mail from X" stays out.
  email_delete: EMAIL_DELETE_PATTERN,
  email:    /\b(e-?mails?|inbox|unread|my\s+mail|check\s+my\s+mail)\b/i,
  reminder: /\b(remind\s+me|set\s+a\s+reminder|cancel\s+(the|my)\s+reminder|my\s+reminders|wake\s+me)\b/i,
  memory:   /\b(remember\s+that|note\s+that|make\s+a\s+note|my\s+notes|what\s+did\s+i\s+(save|note))\b/i,
  contacts: /\b(save\s+(this\s+)?contact|add\s+(a\s+)?contact|new\s+contact)\b/i,
  message:  /\b(text|message|sms)\s+(\w+)|send\s+(a\s+)?(text|message|sms)\b/i
};

// A request whose object is only a pronoun ("open it", "play that") carries no
// referent of its own. If nothing earlier in the conversation supplies one,
// forcing a tool would make her guess — she should ask instead.
const PRONOUN_ONLY_RE =
  /\b(open|play|read|show|pull\s+up|put\s+on)\s+((it|that|this|them|those|these)(\s+one)?|the\s+(first|second|third|fourth|last|next|one))\b[\s.!?]*$/i;

// Detection is deliberately recall-biased — missing a real request is the bug we
// are fixing, so borderline turns lean toward acting. That bias has one sharp
// edge: "don't open anything" contains "open". An explicitly negated action is
// conversation, and forcing a tool there would be acting against instruction.
const NEGATED_ACTION_RE =
  /\b(don'?t|do not|never|no need to|rather than|instead of|without)\s+(\w+\s+){0,2}(open|play|read|show|send|text|message|remind|remember|check|save|add|cancel|delete|trash|move)\w*\b/i;

function capOk(entry, caps) {
  return !entry.requires || !!caps[entry.requires];
}

// Every tool Artemis could ever call, with its metadata merged in.
function allEntries() {
  const skills = skillToolDefs().map((s) => ({ name: s.name, description: s.description, parameters: s.input_schema }));
  return [...NATIVE_DEFS, ...skills].map((def) => {
    const meta = META[def.name] || { family: "other", effect: "read" };
    const skill = getSkill(def.name);
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters || { type: "object", properties: {} },
      family: meta.family,
      effect: meta.effect,
      requires: meta.requires || null,
      external: !!meta.external,
      confirm: meta.confirm || null,
      forceFamilies: Array.isArray(meta.forceFamilies) ? meta.forceFamilies : [meta.family],
      // a skill's own requiresConfirmation is a floor, never lowered here
      alwaysConfirm: !!(skill && skill.requiresConfirmation) || !!meta.external || meta.confirm === "always",
      isSkill: !!skill
    };
  });
}

/** Every tool that is usable right now, given the configured capabilities. */
export function availableTools(caps = {}) {
  return allEntries().filter((e) => capOk(e, caps));
}

export function toolByName(name, caps = {}) {
  return availableTools(caps).find((e) => e.name === name) || null;
}

/** Tool schemas in OpenAI/NVIDIA function-calling format. */
export function openaiToolDefs(caps = {}, filter) {
  return availableTools(caps)
    .filter((e) => (filter ? filter(e) : true))
    .map((e) => ({ type: "function", function: { name: e.name, description: e.description, parameters: e.parameters } }));
}

/** Tool schemas in Anthropic format (shared prompt policy; legacy path). */
export function anthropicToolDefs(caps = {}) {
  return availableTools(caps).map((e) => ({ name: e.name, description: e.description, input_schema: e.parameters }));
}

/** The tools that could satisfy a given family, as OpenAI defs. */
export function toolDefsForFamily(caps, family) {
  return openaiToolDefs(caps, (e) => e.forceFamilies.includes(family));
}

// ---- argument validation ----------------------------------------------------
// Enough JSON Schema for the shapes our tools actually declare. The point is to
// reject a malformed call BEFORE it is executed or recorded, so a bad call can
// never look like a completed action.
function typeOk(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
  return true; // unconstrained
}

function constraintError(value, spec, path) {
  if (typeof value === "number") {
    if (spec.minimum !== undefined && value < spec.minimum) return `${path} must be at least ${spec.minimum}`;
    if (spec.maximum !== undefined && value > spec.maximum) return `${path} must be at most ${spec.maximum}`;
  }
  if (Array.isArray(value)) {
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      return `${path} must contain at least ${spec.minItems} item${spec.minItems === 1 ? "" : "s"}`;
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      return `${path} must contain at most ${spec.maxItems} items`;
    }
    if (spec.items) {
      for (const [index, item] of value.entries()) {
        const itemPath = `${path}[${index}]`;
        if (!typeOk(item, spec.items.type)) return `${itemPath} should be ${spec.items.type}`;
        const nested = constraintError(item, spec.items, itemPath);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Validate a proposed tool call against the registry.
 * @returns {{ok: boolean, error?: string, tool?: object, args?: object}}
 */
export function validateToolCall(name, rawArgs, caps = {}) {
  if (!name || typeof name !== "string") return { ok: false, error: "missing tool name" };
  const tool = toolByName(name, caps);
  if (!tool) {
    // distinguish "doesn't exist" from "not configured" — the model deserves a
    // usable error, and the user deserves an honest "that's not connected"
    const known = allEntries().find((e) => e.name === name);
    return { ok: false, error: known ? `${name} is not available (missing ${known.requires} configuration)` : `unknown tool "${name}"` };
  }

  let args = rawArgs;
  if (typeof args === "string") {
    try { args = JSON.parse(args || "{}"); } catch (e) { return { ok: false, error: `arguments for ${name} are not valid JSON`, tool }; }
  }
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return { ok: false, error: `arguments for ${name} must be an object`, tool };
  args = { ...args };

  const schema = tool.parameters || {};
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    const v = args[key];
    if (v === undefined || v === null) return { ok: false, error: `${name} is missing required argument "${key}"`, tool };
    if (typeof v === "string" && !v.trim()) return { ok: false, error: `${name} argument "${key}" is empty`, tool };
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) continue; // tolerate extra keys; models add stray ones harmlessly
    if (value === undefined || value === null) continue;
    if (!typeOk(value, spec.type)) return { ok: false, error: `${name} argument "${key}" should be ${spec.type}`, tool };
    if (spec.enum && !spec.enum.includes(value)) return { ok: false, error: `${name} argument "${key}" must be one of ${spec.enum.join(", ")}`, tool };
    const constrained = constraintError(value, spec, `${name} argument "${key}"`);
    if (constrained) return { ok: false, error: constrained, tool };
    // Speech recognition can repeat a list number. Normalize it here so one
    // validated request can never invoke the same mutation twice.
    if (spec.uniqueItems && Array.isArray(value)) args[key] = [...new Set(value)];
  }
  return { ok: true, tool, args };
}

// ---- confirmation policy ----------------------------------------------------
/**
 * Does this call need an explicit spoken yes before it runs?
 *
 * Anything a skill marks consequential, and anything whose effect leaves this
 * machine, always confirms. Beyond that: a mutation is confirmed when the turn
 * has read attacker-influenced text, because at that point the request may not
 * be coming from the user at all. Local reversible writes the user asked for
 * directly (a reminder, a note) still run without a prompt — gating those would
 * make her tedious without closing a real hole.
 */
export function needsConfirmation(name, { tainted = false } = {}, caps = {}) {
  const tool = toolByName(name, caps);
  if (!tool) return false;
  if (tool.alwaysConfirm) return true;
  return (tool.effect === "mutate" || tool.effect === "mutation") && tainted;
}

// ---- intent classification --------------------------------------------------
/** Does the conversation so far offer anything a bare "it"/"that" could mean? */
function historyHasReferent(history = []) {
  return history.some((m) => {
    const c = String((m && m.content) || "");
    return /https?:\/\//i.test(c) || /^\s*\d+[.)]\s+/m.test(c);
  });
}

/**
 * Classify a turn three ways, from the registry rather than a hardcoded regex.
 *
 *   executable_action — the user asked for something that must produce a tool call
 *   needs_clarification — an action request with no resolvable referent; ask, don't guess
 *   chat — conversation; tools stay optional
 *
 * @returns {{intent: string, family: string|null, expected: string[], reason: string}}
 */
export function classifyIntent(text, caps = {}, history = []) {
  const s = String(text || "").trim();
  if (!s) return { intent: "chat", family: null, expected: [], reason: "empty" };
  if (NEGATED_ACTION_RE.test(s)) return { intent: "chat", family: null, expected: [], reason: "action is negated" };

  const tools = availableTools(caps);
  const families = new Set(tools.flatMap((t) => t.forceFamilies));

  let matched = null;
  for (const family of Object.keys(FAMILY_PATTERNS)) {
    if (!families.has(family)) continue; // nothing in that family is configured
    if (!ACTIONABLE_FAMILIES.has(family)) continue;
    if (FAMILY_PATTERNS[family].test(s)) { matched = family; break; }
  }

  if (!matched) return { intent: "chat", family: null, expected: [], reason: "no actionable family matched" };

  const expected = tools.filter((t) => t.forceFamilies.includes(matched)).map((t) => t.name);

  if (PRONOUN_ONLY_RE.test(s) && !historyHasReferent(history)) {
    return { intent: "needs_clarification", family: matched, expected, reason: "pronoun with no referent in context" };
  }
  return { intent: "executable_action", family: matched, expected, reason: `matched ${matched} family` };
}
