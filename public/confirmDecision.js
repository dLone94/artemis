// Parse a confirmation utterance without touching browser state. Explicit
// refusal wins when speech recognition captures both polarities ("yes, no").
// Repeating a verb ("open it", "delete them") is consent ONLY for the pending
// tool that verb belongs to — "open it" must never approve a delete.
const PENDING_VERBS = {
  delete_email: /\b(delete|trash|remove)\b/,
  send_message: /\b(send)\b/,
  nudge_email: /\b(nudge|chase|send)\b/,
  open_url: /\b(open)\b/,
  open_application: /\b(open)\b/,
  computer_control: /\b(run|type)\b/,
  run_command: /\b(run)\b/
};

export function confirmationDecision(text, pendingName = "") {
  const normalized = String(text || "").toLowerCase().trim();
  const no =
    /\b(no|nope|nah|not|cancel|stop|don['’]?t|do not|never ?mind|abort|negative)\b/.test(normalized);
  if (no) return "no";
  const postponed = /\b(later|tomorrow|tonight)\b/.test(normalized);
  const explicitYes =
    /\b(yes|yeah|yep|yup|sure|confirm|do it|do that|go ahead|go for it|sounds good|please do|affirmative|correct|okay|ok)\b/.test(normalized);
  if (postponed && !/\b(yes|yeah|yep|yup|confirm)\b/.test(normalized)) return null;
  if (explicitYes) return "yes";
  const verbRepeat = /\b(delete|trash|send|remove|open|nudge|chase)\b.{0,24}\b(it|them|those|these|all|everything)\b/.test(normalized);
  if (!verbRepeat || !pendingName) return null;
  if (/\b(later|tomorrow|tonight)\b/.test(normalized)) return null;
  const allowed = PENDING_VERBS[pendingName];
  if (!allowed || !allowed.test(normalized)) return null;
  return "yes";
}
