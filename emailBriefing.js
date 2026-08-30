// Progressive email briefing: say the least that is useful, then go deeper
// only when asked.
//
// The old behaviour dumped everything at once — count, sender, subject, and an
// unrelated inspirational line — so an order confirmation you did not ask about
// was read aloud in full. The levels below are the fix:
//
//   LEVEL 0  notification  count + who the latest is from            (default)
//   LEVEL 1  summary       sender + short gist for each recent email ("what are they about?")
//   LEVEL 2  detail        one selected email, fuller                ("tell me about the first one")
//   LEVEL 3  read          the selected email's content              ("read that one")
//
// Nothing here escalates on its own, and nothing here fetches: it phrases and
// resolves against an already-fetched set. Pure and DOM/IO-free so the
// contracts are unit-testable (test/emailBriefing.test.mjs).
//
// Email text is UNTRUSTED. Every string that reaches a spoken line goes through
// cleanText(): tags, control characters and sentinel-ish markup are stripped and
// the result is hard-capped. A subject can therefore never smuggle instructions
// into a reply, and this module never returns a tool call.

/** A recent set is only worth referring to for a short while. */
export const EMAIL_CONTEXT_TTL_MS = 10 * 60 * 1000;

/** Strip markup/control characters from untrusted mail text and cap it. */
export function cleanText(value, cap = 60) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/** Human sender name: display name if present, else the local part. */
export function senderName(from) {
  const raw = String(from || "");
  const display = cleanText(raw.split("<")[0].replace(/["']/g, ""), 40);
  if (display && !display.includes("@")) return display;
  const address = (raw.match(/[\w.+-]+@[\w.-]+/) || [])[0] || display;
  if (!address) return "someone";
  return cleanText(String(address).split("@")[0].replace(/[._-]+/g, " "), 40) || "someone";
}

/**
 * LEVEL 0 — the default announcement. Count plus who the latest is from.
 * Never the subject, never a preview, never anything else.
 */
export function announceEmails(emails) {
  const list = Array.isArray(emails) ? emails : [];
  if (!list.length) return "You don't have any new emails.";
  const latest = senderName(list[0].from);
  if (list.length === 1) return `You have 1 new email. It's from ${latest}.`;
  return `You have ${list.length} new emails. The latest is from ${latest}.`;
}

/** LEVEL 1 — one short clause per email: who, and roughly what about. */
export function summarizeEmails(emails) {
  const list = Array.isArray(emails) ? emails : [];
  if (!list.length) return "You don't have any new emails.";
  const clause = (mail) => {
    const who = senderName(mail.from);
    const about = cleanText(mail.subject, 60);
    return about ? `${who} — ${about}` : `${who}`;
  };
  if (list.length === 1) return `It's from ${clause(list[0])}.`;
  const parts = list.slice(0, 5).map((mail, i) => `${i === 0 ? "The latest is" : "then"} ${clause(mail)}`);
  const more = list.length > 5 ? ` And ${list.length - 5} more.` : "";
  return parts.join("; ") + "." + more;
}

/** LEVEL 2 — one email, fuller: sender, subject, and the snippet if present. */
export function detailEmail(mail) {
  if (!mail) return "I don't have that email.";
  const who = senderName(mail.from);
  const about = cleanText(mail.subject, 90);
  const gist = cleanText(mail.snippet, 180);
  const head = about ? `${who} — ${about}.` : `${who}.`;
  return gist ? `${head} ${gist}` : head;
}

const ORDINALS = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  one: 1, two: 2, three: 3, four: 4, five: 5
});

// Phrases that ask ABOUT the already-announced set as a whole.
const ABOUT_SET_RE =
  /\b(?:what(?:'s| is| are)?\s+(?:they|those|these|the\s+emails?|it)\s+about|what\s+are\s+those\s+emails?\s+about|tell\s+me\s+about\s+(?:the\s+)?(?:emails?|them|those)|what\s+about\s+(?:them|those\s+emails?)|summar(?:ise|ize)\s+(?:them|those|the\s+emails?))\b/i;

// Phrases that select ONE email from the set.
const SELECT_RE = new RegExp(
  String.raw`\b(?:tell\s+me\s+(?:more\s+)?about|what\s+(?:does|did)|read|open|show(?:\s+me)?|summar(?:ise|ize))\b` +
    String.raw`[^.?!]{0,40}?` +
    String.raw`\b(?:(first|second|third|fourth|fifth|one|two|three|four|five|latest|last|newest)\s+(?:one|email|message)?|` +
    String.raw`(?:the\s+)?([\w.&'-]{2,30})\s+(?:one|email|message))\b`,
  "i"
);
const READ_VERB_RE = /\b(?:read|open)\b/i;
const DETAIL_VERB_RE = /\b(?:tell\s+me\s+(?:more\s+)?about|what\s+(?:does|did)|show(?:\s+me)?|summar(?:ise|ize))\b/i;

/**
 * Classify an email follow-up utterance.
 * @returns {{level:1}|{level:2|3, ref:{type:"position"|"sender", value}}|null}
 *   null when the turn is not an email follow-up at all.
 */
export function emailFollowupForText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const select = s.match(SELECT_RE);
  if (select) {
    // Either alternative can capture the token, and the sender branch can win
    // the race on "the first one" — so classify the token, not the branch.
    const token = String(select[1] || select[2] || "").trim();
    const key = token.toLowerCase();
    const level = READ_VERB_RE.test(s) ? 3 : DETAIL_VERB_RE.test(s) ? 2 : 2;
    if (key === "latest" || key === "last" || key === "newest") {
      return { level, ref: { type: "position", value: 1 } };
    }
    if (ORDINALS[key]) return { level, ref: { type: "position", value: ORDINALS[key] } };
    if (token && !/^(?:that|this|it|them|those|email|message|new|unread|the)$/i.test(key)) {
      return { level, ref: { type: "sender", value: token } };
    }
  }
  if (ABOUT_SET_RE.test(s)) return { level: 1 };
  return null;
}

/**
 * Resolve a reference against the recent set.
 * @returns {{ok:true, mail, index}|{ok:false, reason:"empty"|"missing"|"ambiguous", candidates?:string[]}}
 */
export function resolveEmailReference(ref, emails) {
  const list = Array.isArray(emails) ? emails : [];
  if (!list.length) return { ok: false, reason: "empty" };
  if (!ref) return { ok: false, reason: "missing" };
  if (ref.type === "position") {
    const index = Number(ref.value) - 1;
    if (index < 0 || index >= list.length) return { ok: false, reason: "missing" };
    return { ok: true, mail: list[index], index };
  }
  if (ref.type === "sender") {
    const needle = String(ref.value).toLowerCase();
    const hits = list
      .map((mail, index) => ({ mail, index }))
      .filter(({ mail }) =>
        senderName(mail.from).toLowerCase().includes(needle) ||
        String(mail.from || "").toLowerCase().includes(needle));
    if (!hits.length) return { ok: false, reason: "missing" };
    // Two emails from the same sender is a real ambiguity — ask, never guess.
    if (hits.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        candidates: hits.slice(0, 4).map(({ mail, index }) =>
          `${index + 1}. ${senderName(mail.from)}${cleanText(mail.subject, 40) ? " — " + cleanText(mail.subject, 40) : ""}`)
      };
    }
    return { ok: true, mail: hits[0].mail, index: hits[0].index };
  }
  return { ok: false, reason: "missing" };
}

/** The honest line when the recent set has expired or never existed. */
export function staleContextReply() {
  return "I don't have those emails in the current context anymore. Want me to check again?";
}

/** The line for an ambiguous sender reference. */
export function ambiguityReply(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.length
    ? `I have more than one of those — ${list.join("; ")}. Which one do you mean?`
    : "I have more than one email matching that. Which one do you mean?";
}
