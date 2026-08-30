// The Artemis Core's view-model contract.
//
// coreState.js is deliberately pure so this can run in node with no browser:
// the mapping from REAL application state to what the Core displays is the part
// that can silently start lying, and a canvas test would never catch it.
//
// The rules being defended:
//   - the Core never claims an action it did not observe
//   - raw internals and secrets never reach the hero HUD
//   - the capability lit by a tool is the one that actually owns it
//
// Run: node --test test/coreState.test.mjs
import assert from "node:assert";
import test from "node:test";

import {
  CAPABILITIES,
  FAMILY_NAMES,
  CAPABILITY_OF_FAMILY,
  capabilityForFamily
} from "../public/coreCapabilities.js";
import {
  deriveCoreState,
  activityForTool,
  safeErrorLine,
  CORE_STATES,
  ACCEPTS_LATER
} from "../public/coreState.js";

test("family table is index-aligned and in range", () => {
  // These two arrays are addressed by the same index. A mismatch would light
  // the wrong capability — MAIL glowing while she plays music.
  assert.strictEqual(
    FAMILY_NAMES.length,
    CAPABILITY_OF_FAMILY.length,
    "FAMILY_NAMES and CAPABILITY_OF_FAMILY must stay index-aligned"
  );
  for (let i = 0; i < CAPABILITY_OF_FAMILY.length; i++) {
    const node = CAPABILITY_OF_FAMILY[i];
    assert.ok(
      node >= 0 && node < CAPABILITIES.length,
      `family "${FAMILY_NAMES[i]}" maps to out-of-range capability ${node}`
    );
  }
});

test("a tool family lights the capability that owns it", () => {
  assert.strictEqual(CAPABILITIES[capabilityForFamily("email")].title, "MAIL");
  assert.strictEqual(CAPABILITIES[capabilityForFamily("media")].title, "MEDIA");
  assert.strictEqual(CAPABILITIES[capabilityForFamily("research")].title, "RESEARCH");
  assert.strictEqual(CAPABILITIES[capabilityForFamily("  EMAIL  ")].title, "MAIL", "tolerates case and padding");
});

test("an unknown family lights nothing rather than guessing", () => {
  assert.strictEqual(capabilityForFamily("teleportation"), -1);
  assert.strictEqual(capabilityForFamily(undefined), -1);
  assert.strictEqual(capabilityForFamily(null), -1);
  assert.strictEqual(capabilityForFamily(42), -1);
});

test("idle is STANDBY with no invented activity", () => {
  const v = deriveCoreState({ status: "idle" });
  assert.strictEqual(v.label, "STANDBY");
  assert.strictEqual(v.task, "No active task");
  assert.strictEqual(v.capability, -1);
  assert.ok(v.energy < 0.2, "standby must be calm");
});

test("listening and processing are distinguishable", () => {
  const listening = deriveCoreState({ status: "listening" });
  const thinking = deriveCoreState({ status: "thinking" });
  assert.strictEqual(listening.label, "LISTENING");
  assert.strictEqual(thinking.label, "PROCESSING");
  assert.notStrictEqual(listening.state, thinking.state);
  assert.notStrictEqual(listening.tone, thinking.tone);
});

test("a running tool becomes EXECUTING with real, human activity", () => {
  const v = deriveCoreState({
    status: "thinking",
    tool: { name: "play_media", family: "media", phase: "start" }
  });
  assert.strictEqual(v.label, "EXECUTING");
  assert.strictEqual(v.task, "Opening media");
  assert.strictEqual(CAPABILITIES[v.capability].title, "MEDIA");
  assert.strictEqual(v.detail, "MEDIA");
});

test("research families read as RESEARCHING, not generic execution", () => {
  const v = deriveCoreState({
    status: "thinking",
    tool: { name: "web_search", family: "research", phase: "start" }
  });
  assert.strictEqual(v.label, "RESEARCHING");
  assert.strictEqual(v.task, "Searching the web");
});

test("a finished tool stops claiming it is running", () => {
  const v = deriveCoreState({
    status: "thinking",
    tool: { name: "play_media", family: "media", phase: "end", ok: true }
  });
  assert.strictEqual(v.label, "PROCESSING", "phase:end must not read as EXECUTING");
  assert.strictEqual(v.capability, -1);
});

test("an open confirm gate outranks the mic and reads WAITING", () => {
  // The mic is open BECAUSE she is waiting on a yes/no — "LISTENING" would be
  // technically true and completely unhelpful.
  const v = deriveCoreState({ status: "listening", pendingConfirm: true });
  assert.strictEqual(v.label, "WAITING");
  assert.match(v.task, /confirmation/i);
});

test("errors are visible but never leak internals", () => {
  const v = deriveCoreState({ status: "error", errorText: "Gmail token expired" });
  assert.strictEqual(v.label, "FAULT");
  assert.strictEqual(v.detail, "Gmail token expired");
  assert.ok(v.energy < 0.4, "an error must not be visually catastrophic");
});

test("secrets, URLs and stack traces are stripped from the hero HUD", () => {
  const leaks = [
    "at handleRequest (/Users/me/server.js:412:19)",
    "GET https://api.example.com/v1?key=abc123 failed",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "sk-proj-0123456789abcdef0123456789",
    "token AKIAIOSFODNN7EXAMPLEKEYVALUE12"
  ];
  for (const leak of leaks) {
    assert.strictEqual(safeErrorLine(leak), "", `must not surface: ${leak}`);
  }
  assert.strictEqual(safeErrorLine("Could not reach Gmail"), "Could not reach Gmail");
});

test("long error lines are truncated rather than overflowing the Core", () => {
  const long = "The mail provider refused the request and did not say why, " +
    "so nothing was changed and you should try that again in a moment.";
  const out = safeErrorLine(long);
  assert.ok(out.length <= 80, `expected <=80 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("an unbroken 24+ character run is suppressed, not truncated", () => {
  // Fail closed: a long opaque token is far more likely to be a credential
  // than a real word, and a truncated secret is still a leaked secret prefix.
  assert.strictEqual(safeErrorLine("x".repeat(200)), "");
});

test("tool activity is human, never raw internals", () => {
  assert.strictEqual(activityForTool("delete_email"), "Moving mail to trash");
  // Unknown tools still must not show snake_case at the focal point.
  assert.strictEqual(activityForTool("some_new_tool"), "Some new tool");
  assert.doesNotMatch(activityForTool("some_new_tool"), /_/);
  assert.strictEqual(activityForTool(""), "");
  assert.strictEqual(activityForTool(undefined), "");
});

test("future coding-agent stages are accepted without being emitted", () => {
  // The brief asks for the API to support these later. Nothing in the app
  // produces them today; the adapter must be ready anyway.
  for (const stage of ACCEPTS_LATER) {
    const v = deriveCoreState({ status: "idle", stage });
    assert.strictEqual(v.state, stage);
    assert.strictEqual(v.label, CORE_STATES[stage].label);
  }
});

test("an unknown stage is ignored rather than displayed raw", () => {
  const v = deriveCoreState({ status: "idle", stage: "rm -rf /" });
  assert.strictEqual(v.label, "STANDBY");
});

test("every core state declares a label, tone and energy", () => {
  for (const [key, spec] of Object.entries(CORE_STATES)) {
    assert.ok(spec.label, `${key} needs a label`);
    assert.ok(spec.tone, `${key} needs a tone`);
    assert.ok(spec.energy >= 0 && spec.energy <= 1, `${key} energy out of range`);
  }
});

test("derive never throws on junk input", () => {
  // This runs inside a render loop; a throw here would blank the hero.
  for (const junk of [undefined, null, {}, { status: 7 }, { tool: "nope" }, { tool: {} }]) {
    assert.doesNotThrow(() => deriveCoreState(junk));
  }
});
