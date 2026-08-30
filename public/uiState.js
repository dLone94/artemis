// ArtemisUIState — ONE client-side merge of everything the interface reacts
// to. Views subscribe here instead of each panel scraping its own SSE events
// and inventing a private state machine.
//
// Ownership rules (plan Rev 5):
//   server-owned  — brain, networkMode, approvalState, activeContext,
//                   currentTask, interpreting, toolState (from chat SSE)
//   client-owned  — voiceState, amplitude, presentation mode
// Presence snapshots deliver the server-owned truth; chat SSE events carry the
// per-turn tool lifecycle. Late events from an older turn are DROPPED: every
// chat event is applied under a turn handle, and only the newest turn wins.
//
// Pure and DOM-free so test/uiState.test.mjs can drive it in node.

export function createUIState() {
  const state = {
    voiceState: "idle",        // idle | listening | thinking | speaking | error
    reasoningState: "idle",    // idle | routing | understanding | executing | answering
    interpreting: false,
    currentTask: null,         // { turnId, label, state } | null
    activeCapability: null,    // family string while a tool runs
    toolState: null,           // { name, family, phase, ok }
    activeContext: null,       // { application, windowTitle, promptLine, at }
    activeApplication: null,
    brain: null,               // { name, model, provider, local, available }
    model: null,
    provider: null,
    networkMode: "hybrid",     // hybrid | local-only
    offline: false,
    approvalState: null,       // { prompt, tool } | null
    mode: "full",              // full | pill | background
    amplitude: 0,
    updatedAt: 0
  };
  const listeners = new Set();
  let turnCounter = 0;
  let currentTurn = 0;

  function emit(changedKeys) {
    for (const listener of listeners) {
      try { listener(state, changedKeys); } catch (e) {}
    }
  }

  function setMany(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in state)) continue;
      if (state[key] !== value) { state[key] = value; changed.push(key); }
    }
    if (changed.length) { state.updatedAt = Date.now(); emit(changed); }
    return changed;
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** A presence snapshot (server-owned truth + client voice fields). */
    applyPresence(snap = {}) {
      const patch = {};
      if (snap.brain !== undefined) {
        patch.brain = snap.brain;
        patch.model = snap.brain ? snap.brain.model : null;
        patch.provider = snap.brain ? snap.brain.provider : null;
      }
      if (snap.networkMode !== undefined) patch.networkMode = snap.networkMode;
      if (snap.offline !== undefined) patch.offline = !!snap.offline;
      if (snap.approvalState !== undefined) patch.approvalState = snap.approvalState;
      if (snap.pendingConfirm !== undefined && snap.approvalState === undefined) {
        // migration shim: older publishers still send pendingConfirm
        patch.approvalState = snap.pendingConfirm
          ? { prompt: snap.pendingConfirm.prompt || "", tool: snap.pendingConfirm.name || null }
          : null;
      }
      if (snap.activeContext !== undefined) {
        patch.activeContext = snap.activeContext;
        patch.activeApplication = snap.activeContext ? snap.activeContext.application : null;
      }
      if (snap.currentTask !== undefined) patch.currentTask = snap.currentTask;
      if (snap.interpreting !== undefined) {
        patch.interpreting = !!snap.interpreting;
        if (snap.interpreting) patch.reasoningState = "understanding";
      }
      if (snap.state !== undefined) patch.voiceState = snap.state;
      if (snap.amplitude !== undefined) patch.amplitude = snap.amplitude;
      if (snap.mode !== undefined) patch.mode = snap.mode;
      return setMany(patch);
    },

    /** Start a chat turn; returns the handle chat events must be applied with. */
    beginTurn() {
      turnCounter += 1;
      currentTurn = turnCounter;
      setMany({ reasoningState: "routing", toolState: null });
      return currentTurn;
    },

    /** Apply one chat SSE event under a turn handle; stale turns are dropped. */
    applyChatEvent(turn, event, data = {}) {
      if (turn !== currentTurn) return []; // a late event from an older turn
      if (event === "intent_pending") return setMany({ reasoningState: "routing" });
      if (event === "interpreting") return setMany({ reasoningState: "understanding", interpreting: true });
      if (event === "tool") {
        const patch = { toolState: { name: data.name, family: data.family, phase: data.phase, ok: data.ok } };
        if (data.phase === "start") {
          patch.activeCapability = data.family || null;
          patch.reasoningState = "executing";
        } else if (data.phase === "end") {
          patch.reasoningState = "answering";
        }
        return setMany(patch);
      }
      if (event === "token") return setMany({ reasoningState: "answering" });
      if (event === "done" || event === "error") {
        return setMany({
          reasoningState: "idle",
          interpreting: false,
          activeCapability: null,
          toolState: null
        });
      }
      return [];
    },

    /** The voice loop's own state (client-owned; mirrors orb status). */
    setVoiceState(voiceState) {
      return setMany({ voiceState });
    }
  };
}
