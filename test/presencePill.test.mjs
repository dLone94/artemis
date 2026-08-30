// The pill view-model: real state in, correct pill view out. Pure — no DOM.

import assert from "node:assert/strict";
import {
  pillView,
  pillCaption,
  shortTask,
  capabilityOf,
  capabilitySegment,
  PILL_SIZES
} from "../public/presencePill.js";

// state text for each activity
assert.equal(pillView({ state: "idle" }).label, "Idle");
assert.equal(pillView({ state: "listening" }).label, "Listening");
assert.equal(pillView({ state: "thinking" }).label, "Thinking");
assert.equal(pillView({ state: "executing" }).label, "Executing");
assert.equal(pillView({ state: "speaking" }).label, "Speaking");
assert.equal(pillView({ state: "error" }).label, "Error");
assert.equal(pillView({ state: "completed" }).label, "Done");

// active task text is surfaced, raw tool names are not
assert.equal(pillView({ state: "executing", task: "Terminal · Running tests" }).task, "Terminal · Running tests");
assert.equal(pillView({ state: "executing", task: "run_command" }).task, "", "a bare tool name is dropped");
{
  const long = shortTask("Files · Searching Documents and more and more and more text");
  assert.ok(long.endsWith("…") && long.length === 42, "long task is trimmed to 42 chars with an ellipsis");
}
assert.equal(pillCaption(pillView({ state: "listening" })), "ARTEMIS · Listening");
assert.equal(pillCaption(pillView({ state: "executing", task: "Terminal · Running tests" })), "Terminal · Running tests");

// listening energy tracks real amplitude, not a random waveform
{
  const quiet = pillView({ state: "listening", amplitude: 0.05 });
  const loud = pillView({ state: "listening", amplitude: 0.9 });
  assert.ok(loud.energy > quiet.energy, "louder input → more energy");
  assert.equal(quiet.signal, 0.05, "the view exposes the real quiet signal separately");
  assert.equal(loud.signal, 0.9, "the view exposes the real loud signal separately");
}
// amplitude is ignored when not listening/speaking
assert.equal(pillView({ state: "thinking", amplitude: 0.9 }).energy, 0.7);
assert.equal(pillView({ state: "thinking", amplitude: 0.9 }).signal, 0);

// model/provider truth is carried through without inventing availability
{
  const local = pillView({
    state: "thinking",
    networkMode: "local-only",
    brain: { model: "qwen3.5:4b", provider: "ollama", local: true }
  });
  assert.equal(local.brainLabel, "qwen3.5:4b");
  assert.equal(local.brainStatus, "LOCAL");
  assert.equal(pillView({ state: "idle", offline: true }).brainStatus, "OFFLINE");
  assert.equal(pillView({ state: "idle" }).brainLabel, "", "missing brain stays visually honest");
}

// approval state overrides everything and carries the prompt
{
  const v = pillView({ state: "thinking", pendingConfirm: { name: "run_command", prompt: "Run `sudo x`?" } });
  assert.equal(v.showApproval, true);
  assert.equal(v.label, "Waiting for approval");
  assert.equal(v.approval.prompt, "Run `sudo x`?");
}

// mode passes through for full/pill/background transitions
assert.equal(pillView({ mode: "pill", state: "idle" }).mode, "pill");
assert.equal(pillView({ mode: "background", state: "idle" }).mode, "background");

// tone drives colour per state
assert.equal(pillView({ state: "listening" }).tone, "live");
assert.equal(pillView({ state: "executing" }).tone, "work");
assert.equal(pillView({ state: "error" }).tone, "fault");
assert.equal(pillView({ state: "completed" }).tone, "ok");

// ---- Pill 2.0: size classes, interpretation state, capability line ----------
{
  // idle becomes a real orb-only presence; live states earn the status wing
  assert.equal(pillView({ state: "idle" }).sizeClass, "compact");
  assert.equal(pillView({ state: "listening" }).sizeClass, "wide");
  assert.equal(pillView({ state: "executing" }).sizeClass, "wide");
  assert.equal(pillView({ state: "error" }).sizeClass, "wide", "fault copy remains visible");
  assert.equal(pillView({ state: "completed" }).sizeClass, "compact", "done settles back down");

  // the server-owned approvalState drives the tall approval expansion
  const approval = pillView({ state: "idle", approvalState: { prompt: "Run `npm install`?", tool: "run_command" } });
  assert.equal(approval.showApproval, true);
  assert.equal(approval.sizeClass, "approval");
  assert.equal(approval.approval.prompt, "Run `npm install`?");

  // the interpreter resolving an utterance shows as Understanding
  const understanding = pillView({ state: "listening", interpreting: true });
  assert.equal(understanding.label, "Understanding");
  assert.equal(understanding.tone, "work");

  // the current task carries its capability ("Terminal · …")
  const busy = pillView({ state: "executing", currentTask: { label: "Terminal · Selecting option 1" } });
  assert.equal(busy.task, "Terminal · Selecting option 1");
  assert.equal(busy.capability, "Terminal");
  assert.ok(busy.activeSegment >= 0, "a real capability selects one core segment");
  assert.equal(capabilityOf("just a task"), "");
  assert.equal(capabilityOf("Opening site · RESEARCH"), "RESEARCH", "Core suffix labels are understood");
  assert.equal(pillView({ state: "executing", capability: "computer" }).capability, "Computer");
  assert.equal(capabilitySegment("Terminal"), capabilitySegment("terminal"), "segment routing is stable");
  assert.equal(capabilitySegment(""), -1, "no capability lights no segment");

  // size table is complete and sane
  for (const cls of ["compact", "wide", "approval"]) {
    assert.ok(PILL_SIZES[cls].width > 0 && PILL_SIZES[cls].height > 0, cls);
  }
  assert.ok(PILL_SIZES.compact.width < 90, "compact is an orb, not a horizontal pill");
  assert.equal(PILL_SIZES.compact.width, PILL_SIZES.compact.height, "compact core stays circular");
  assert.ok(PILL_SIZES.wide.width > PILL_SIZES.compact.width * 3, "active copy expands into a wing");
  assert.ok(PILL_SIZES.approval.height > PILL_SIZES.wide.height, "approval expands vertically");
}

console.log("✓ presencePill: state labels, real amplitude, approval override, task text, modes, Pill 2.0 sizes");
