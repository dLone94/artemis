// Injection defenses for attacker-influenced text (fetched web pages, email
// bodies). Kept in one place so server.js and skills.js share a single source of
// truth — the audit had to patch the same logic in four spots because it was
// copy-pasted. Pure functions, no side effects → unit-testable in isolation.

// Matches an UNTRUSTED_* sentinel tag (opening or closing, any spacing/attrs).
const SENTINEL_RE = /<\/?\s*UNTRUSTED_[A-Z_]*[^>]*>/gi;

// Remove any UNTRUSTED_* sentinel the text itself contains. Without this a
// malicious page/email could emit a closing tag to "break out" of the wrapper
// frame and have its following text read as trusted instructions.
export function stripSentinels(s) {
  return String(s == null ? "" : s).replace(SENTINEL_RE, "");
}

// Wrap fetched/email text as DATA. The body is sentinel-stripped (above) and the
// attribute string is stripped of angle brackets (a page <title> could otherwise
// smuggle a closing tag through the attributes).
export function wrapUntrusted(tag, attrs, body) {
  const safeAttrs = String(attrs || "").replace(/[<>]/g, "");
  return `<${tag}${safeAttrs ? " " + safeAttrs : ""}>\n` + stripSentinels(body) + `\n</${tag}>`;
}

// Skills whose output feeds attacker-influenced text (email bodies) into the
// model context. A turn that ran fetch_page or one of these is "tainted".
export const UNTRUSTED_SKILLS = new Set(["check_email", "read_email"]);

// Browser-open actions produced in a tainted turn are a prompt-injection
// exfiltration risk (a poisoned page/email telling the model to open
// attacker.com/?leak=<secrets>). We never auto-open in that case; panels stay.
export function dropTaintedOpens(clientActions, tainted) {
  if (!tainted) return clientActions;
  const kept = clientActions.filter((a) => a && a.type !== "open");
  if (kept.length !== clientActions.length) {
    console.warn("blocked auto browser-open in a turn that read untrusted content (injection guard)");
  }
  return kept;
}
