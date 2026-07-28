// Parse a confirmation utterance without touching browser state. Explicit
// refusal wins when speech recognition captures both polarities ("yes, no").
export function confirmationDecision(text) {
  const normalized = String(text || "").toLowerCase().trim();
  const yes =
    /\b(yes|yeah|yep|yup|sure|confirm|send it|do it|do that|go ahead|go for it|sounds good|please do|affirmative|correct|okay|ok)\b/.test(normalized) ||
    /\b(delete|trash|send|remove|open|nudge|chase)\b.{0,24}\b(it|them|those|these|all|everything)\b/.test(normalized);
  const no =
    /\b(no|nope|nah|not|cancel|stop|don['’]?t|do not|never ?mind|abort|negative)\b/.test(normalized);
  if (no) return "no";
  if (yes) return "yes";
  return null;
}
