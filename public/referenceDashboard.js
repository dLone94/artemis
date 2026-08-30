// Reference-dashboard adapter: the visual state rail reads the SAME store as
// the main Core, context panels and native floating pill. It is presentation
// only; routing, tool lifecycle and approval ownership remain unchanged.

const rail = document.querySelector(".v4-state-rail");
const uiState = window.ArtemisUIState;

if (rail && uiState) {
  const cards = new Map(
    Array.from(rail.querySelectorAll("[data-v4-state]")).map((card) => [card.dataset.v4State, card])
  );
  const allow = rail.querySelector('[data-v4-confirm="yes"]');
  const deny = rail.querySelector('[data-v4-confirm="no"]');

  const compact = (value, fallback) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    return text.length > 54 ? `${text.slice(0, 51).trimEnd()}…` : text;
  };

  const displayState = (state) => {
    if (state.approvalState) return "approval";
    if (state.voiceState === "error") return "error";
    if (state.reasoningState === "executing" || state.activeCapability) return "executing";
    if (state.voiceState === "listening") return "listening";
    if (state.voiceState === "thinking" || state.interpreting || ["routing", "understanding"].includes(state.reasoningState)) return "thinking";
    if (state.voiceState === "speaking") return "speaking";
    return "idle";
  };

  const detailsFor = (state) => {
    const task = state.currentTask && state.currentTask.label;
    const tool = state.toolState && state.toolState.name
      ? String(state.toolState.name).replace(/[_-]+/g, " ")
      : state.activeCapability;
    const approval = state.approvalState && (state.approvalState.prompt || state.approvalState.tool);
    return {
      idle: "Ready.",
      listening: "Listening…",
      thinking: compact(task, state.interpreting ? "Understanding…" : "Processing…"),
      executing: compact(task || tool, "Working…"),
      speaking: "Responding…",
      approval: compact(approval, "Waiting for approval"),
      error: "Attention required."
    };
  };

  const render = (state) => {
    const current = displayState(state);
    const details = detailsFor(state);
    rail.dataset.currentState = current;
    for (const [name, card] of cards) {
      const active = name === current;
      card.dataset.current = active ? "1" : "0";
      card.setAttribute("aria-current", active ? "true" : "false");
      const detail = card.querySelector("[data-v4-state-detail]");
      if (detail) detail.textContent = active ? details[name] : "—";
    }
    const awaiting = current === "approval";
    if (allow) allow.disabled = !awaiting;
    if (deny) deny.disabled = !awaiting;
  };

  const confirm = (yes) => {
    if (typeof window.ArtemisConfirm === "function") window.ArtemisConfirm(yes);
  };
  if (allow) allow.addEventListener("click", () => confirm(true));
  if (deny) deny.addEventListener("click", () => confirm(false));

  uiState.subscribe(render);
  render(uiState.get());
}
