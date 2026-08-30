// "Artemis, shut down" quits ARTEMIS — never the Mac, and never on an
// ambiguous sentence about some other thing the user wants stopped.
//
// Run: node --test test/shutdownIntent.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  shutdownIntentForText,
  shutdownNeedsConfirmation,
  shutdownReply,
  SHUTDOWN_ACTION
} from "../shutdownIntent.js";

test("explicit Artemis shutdown phrases map to the one action", () => {
  for (const phrase of [
    "Artemis, shut down.",
    "Artemis, quit.",
    "Artemis, exit.",
    "Artemis, close yourself.",
    "Hey Artemis, shut down",
    "quit Artemis",
    "shut down Artemis"
  ]) {
    const r = shutdownIntentForText(phrase);
    assert.ok(r, `"${phrase}" must be recognised`);
    assert.equal(r.action, SHUTDOWN_ACTION);
  }
});

test("reflexive self-reference works without naming her", () => {
  for (const phrase of ["shut yourself down", "quit yourself", "close yourself", "turn yourself off"]) {
    const r = shutdownIntentForText(phrase);
    assert.ok(r, `"${phrase}" must be recognised`);
    assert.equal(r.reason, "reflexive");
  }
});

test("generic stop-language is NOT an Artemis shutdown", () => {
  // These are how people talk about a dev server, a window, a Terminal
  // process, or the task she is running right now.
  for (const phrase of [
    "shut it down",
    "close it",
    "kill it",
    "quit",
    "stop it",
    "close the window",
    "shut down the server",
    "kill the process",
    "quit the app",
    "close that one"
  ]) {
    assert.equal(shutdownIntentForText(phrase), null, `"${phrase}" must NOT quit Artemis`);
  }
});

test("shutting down the MAC is never Artemis quitting itself", () => {
  // The critical distinction. Powering off macOS is a separate privileged
  // action; this classifier must decline, not answer with an app quit.
  for (const phrase of [
    "shut down the mac",
    "shut down the computer",
    "Artemis, shut down my MacBook",
    "shut down macOS",
    "power off the machine",
    "restart the computer",
    "Artemis, shut down the laptop"
  ]) {
    assert.equal(shutdownIntentForText(phrase), null, `"${phrase}" must not map to an app quit`);
  }
});

test("questions and negations never terminate her", () => {
  for (const phrase of [
    "how do I shut down Artemis?",
    "how to quit Artemis",
    "what happens if I shut down Artemis",
    "don't shut down",
    "no need to quit yourself",
    "explain how to close yourself"
  ]) {
    assert.equal(shutdownIntentForText(phrase), null, `"${phrase}" is not a command`);
  }
});

test("a busy Artemis asks before quitting — using the task state she already has", () => {
  const idle = shutdownNeedsConfirmation({ currentTask: null, approvalState: null, toolState: null });
  assert.equal(idle.confirm, false);
  assert.equal(shutdownReply(idle), "Shutting down.");

  const busy = shutdownNeedsConfirmation({ currentTask: { state: "active", label: "Running npm test" } });
  assert.equal(busy.confirm, true);
  assert.match(shutdownReply(busy), /Shut down anyway\?$/);
  assert.match(shutdownReply(busy), /npm test/);

  const gated = shutdownNeedsConfirmation({ approvalState: { prompt: "Run npm install?" } });
  assert.equal(gated.confirm, true);

  const running = shutdownNeedsConfirmation({ toolState: { name: "run_command", phase: "start" } });
  assert.equal(running.confirm, true);

  const finished = shutdownNeedsConfirmation({ toolState: { name: "run_command", phase: "end", ok: true } });
  assert.equal(finished.confirm, false, "a finished tool is not a reason to hesitate");
});
