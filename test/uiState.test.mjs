// ArtemisUIState: one merged client state with ownership rules and stale-turn
// protection — a late tool-end from an old turn can never overwrite the new one.
//
// Run: node --test test/uiState.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createUIState } from "../public/uiState.js";

test("presence snapshots populate server-owned fields", () => {
  const ui = createUIState();
  ui.applyPresence({
    brain: { name: "ollama:qwen3.5:4b", model: "qwen3.5:4b", provider: "ollama", local: true, available: true },
    networkMode: "local-only",
    offline: true,
    approvalState: { prompt: "Run npm install?", tool: "run_command" },
    activeContext: { application: "Terminal", windowTitle: "zsh", promptLine: "Choose model:", at: 1 },
    currentTask: { turnId: "t1", label: "Terminal · Selecting option 1", state: "active" },
    interpreting: true,
    state: "listening",
    amplitude: 0.4,
    mode: "pill"
  });
  const s = ui.get();
  assert.equal(s.model, "qwen3.5:4b");
  assert.equal(s.provider, "ollama");
  assert.equal(s.networkMode, "local-only");
  assert.equal(s.activeApplication, "Terminal");
  assert.equal(s.approvalState.tool, "run_command");
  assert.equal(s.reasoningState, "understanding");
  assert.equal(s.voiceState, "listening");
  assert.equal(s.mode, "pill");
});

test("legacy pendingConfirm still surfaces as approvalState", () => {
  const ui = createUIState();
  ui.applyPresence({ pendingConfirm: { name: "delete_email", prompt: "Delete 2 emails?" } });
  assert.equal(ui.get().approvalState.tool, "delete_email");
  ui.applyPresence({ pendingConfirm: null });
  assert.equal(ui.get().approvalState, null);
});

test("chat events drive reasoning/capability state through a turn", () => {
  const ui = createUIState();
  const turn = ui.beginTurn();
  ui.applyChatEvent(turn, "intent_pending", { intent: "executable_action", family: "contextual" });
  ui.applyChatEvent(turn, "interpreting", {});
  assert.equal(ui.get().reasoningState, "understanding");
  ui.applyChatEvent(turn, "tool", { name: "computer_control", family: "contextual", phase: "start" });
  assert.equal(ui.get().reasoningState, "executing");
  assert.equal(ui.get().activeCapability, "contextual");
  ui.applyChatEvent(turn, "tool", { name: "computer_control", family: "contextual", phase: "end", ok: true });
  ui.applyChatEvent(turn, "done", {});
  assert.equal(ui.get().reasoningState, "idle");
  assert.equal(ui.get().activeCapability, null);
});

test("late events from an older turn are dropped", () => {
  const ui = createUIState();
  const oldTurn = ui.beginTurn();
  ui.applyChatEvent(oldTurn, "tool", { name: "web_search", family: "web", phase: "start" });
  const newTurn = ui.beginTurn();
  ui.applyChatEvent(newTurn, "tool", { name: "computer_control", family: "computer", phase: "start" });
  // the old turn's end arrives late — it must not clobber the new turn
  const changed = ui.applyChatEvent(oldTurn, "done", {});
  assert.deepEqual(changed, []);
  assert.equal(ui.get().activeCapability, "computer");
  assert.equal(ui.get().reasoningState, "executing");
});

test("subscribers hear changes with the changed keys", () => {
  const ui = createUIState();
  const seen = [];
  ui.subscribe((s, keys) => seen.push(keys));
  ui.applyPresence({ state: "speaking" });
  ui.applyPresence({ state: "speaking" }); // no change → no emit
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["voiceState"]);
});
