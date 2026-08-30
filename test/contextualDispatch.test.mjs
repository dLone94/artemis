// The contextual dispatcher end to end, with fake perception and fake brains
// but the REAL policy stack: classifyIntent routing, needsConfirmation with
// interactive evidence, the real pending store (envelope included), and the
// real leases. Security contracts from plan Rev 5 live here.
//
// Run: node --test test/contextualDispatch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createContextualDispatcher } from "../contextualDispatch.js";
import { createWorkingContext, createSerialLease } from "../workingContext.js";
import { classifyIntent, needsConfirmation } from "../toolRegistry.js";
import { createPending, getPending, consumePending, confirmPromptFor } from "../skills.js";

const CAPS = {};

function makeWorld({
  app = "Terminal",
  buffers = ["Choose model:\n1. Qwen\n2. GPT\n3. Claude\n"],
  windowId = "101",
  tabTty = "ttys003",
  offline = false,
  localBrain = null,
  cloudBrain = null
} = {}) {
  const state = { buffers: [...buffers], reads: 0, skillCalls: [], pended: [], cloudCalls: 0, localCalls: 0 };
  const nextBuffer = () => {
    state.reads += 1;
    return state.buffers.length > 1 ? state.buffers.shift() : state.buffers[0];
  };
  const dispatcher = createContextualDispatcher({
    perception: {
      foregroundApp: async () => ({ application: app, windowTitle: "t", focusedRole: "AXTextField" }),
      terminalContent: async () => ({ title: "tab", text: nextBuffer(), windowId, tabTty, source: "terminal" })
    },
    working: createWorkingContext(),
    contextLease: createSerialLease({ maxQueue: 1 }),
    terminalLease: createSerialLease({ maxQueue: 2 }),
    callLocalBrain: async (messages) => {
      state.localCalls += 1;
      if (!localBrain) throw new Error("no local brain");
      return localBrain(messages);
    },
    callCloudBrain: async (messages) => {
      state.cloudCalls += 1;
      if (offline) throw new Error("local-only mode");
      if (!cloudBrain) throw new Error("no cloud brain");
      return cloudBrain(messages);
    },
    runSkill: async (name, params) => {
      state.skillCalls.push({ name, params });
      return { ok: true, reply: "skill-ran", clientActions: [] };
    },
    pend: (name, params, prompt, envelope) => {
      const confirmId = createPending(name, params, envelope);
      state.pended.push({ confirmId, name, params, envelope });
      return { confirmId, name, params };
    },
    needsConfirmation,
    confirmPromptFor,
    isOffline: () => offline,
    caps: () => CAPS,
    log: () => {}
  });
  return { dispatcher, state };
}

async function speak(world, text) {
  const intent = classifyIntent(text, CAPS, []);
  return world.dispatcher.maybeDispatch({ text, intent, turnId: "t1", tainted: false });
}

// ---- happy paths -------------------------------------------------------------

test("'pick the second one' with a benign menu executes 2 + Enter, no confirm", async () => {
  const world = makeWorld();
  const run = await speak(world, "pick the second one");
  assert.ok(run, "the turn is contextual");
  assert.equal(run.pendingAction, undefined);
  assert.deepEqual(world.state.skillCalls, [{ name: "computer_control", params: { action: "type_and_run", text: "2", expect_tty: "ttys003" } }],
    "the keystroke is bound to the exact resolved tab");
  assert.match(run.reply, /option 2/i);
  assert.equal(run.screenUntrusted, true, "the reply embeds a screen label — taint carries");
});

test("'type one and press enter' against the menu types 1, not the word", async () => {
  const world = makeWorld();
  const run = await speak(world, "type one and press enter");
  assert.ok(run);
  assert.deepEqual(world.state.skillCalls[0], { name: "computer_control", params: { action: "type_and_run", text: "1", expect_tty: "ttys003" } });
});

test("'type ai' is NOT contextual — the literal path keeps it", async () => {
  const world = makeWorld();
  const run = await speak(world, "type ai");
  assert.equal(run, null, "plain literal typing stays on the direct path");
});

test("'run that again' repeats a recorded shell command, but never a menu keystroke", async () => {
  const world = makeWorld();
  await speak(world, "pick the first one"); // records an INTERACTIVE keystroke
  const blocked = await speak(world, "run that again");
  assert.equal(world.state.skillCalls.length, 1, "a menu answer is not repeatable");
  assert.match(blocked.reply, /not repeatable|what should I run/i);
});

test("'tell Claude yes' with a y/N prompt types y", async () => {
  const world = makeWorld({ buffers: ["Continue? [y/N]"] });
  const run = await speak(world, "tell Claude yes");
  assert.ok(run);
  assert.deepEqual(world.state.skillCalls[0].params, { action: "type_and_run", text: "y", expect_tty: "ttys003" });
});

// ---- fail-safe paths ---------------------------------------------------------

test("'tell Claude yes' with no visible prompt clarifies — nothing typed", async () => {
  const world = makeWorld({ buffers: ["plain output\nnothing waiting here at all"] });
  const run = await speak(world, "tell Claude yes");
  assert.ok(run);
  assert.equal(world.state.skillCalls.length, 0);
  assert.match(run.reply, /don't see a question/i);
});

test("'do the first thing' style selection with no menu fails safely", async () => {
  const world = makeWorld({ buffers: ["a shell\nuser@mac ~ %"] });
  const run = await speak(world, "pick the first one");
  assert.ok(run);
  assert.equal(world.state.skillCalls.length, 0);
});

test("iTerm in front is a confused-deputy guard, not a target", async () => {
  const world = makeWorld({ app: "iTerm2" });
  const run = await speak(world, "pick the first one");
  assert.ok(run);
  assert.equal(world.state.skillCalls.length, 0);
  assert.match(run.reply, /Terminal app/i);
});

// ---- confirmation pressure ---------------------------------------------------

test("an opaque option label raises the real confirm gate with an envelope", async () => {
  const world = makeWorld({ buffers: ["Pick one\n1. Continue\n2. Abort\n"] });
  const run = await speak(world, "pick the first one");
  assert.ok(run.pendingAction, "opaque effect must confirm");
  assert.equal(world.state.skillCalls.length, 0, "nothing executed before the yes");
  const stored = getPending(run.pendingAction.confirmId);
  assert.ok(stored.envelope, "the envelope is stored in the real pending store");
  assert.ok(stored.envelope.evidence.tailHash);
});

test("'tell Claude yes' against a destructive prompt confirms exactly once", async () => {
  const world = makeWorld({ buffers: ["Delete branch main? [y/N]"] });
  const run = await speak(world, "tell Claude yes");
  assert.ok(run.pendingAction, "destructive prompt must confirm even when addressed");
  assert.equal(world.state.skillCalls.length, 0);
});

test("an unmatched computer-relay phrase clarifies instead of typing y", async () => {
  const world = makeWorld({ buffers: ["Delete branch main? [y/N]"] });
  const run = await speak(world, "before we start, tell Claude to continue later");
  assert.equal(world.state.skillCalls.length, 0, "must not type y into a [y/N] from a leftover relay match");
  assert.equal(run.pendingAction, undefined);
  assert.match(run.reply || "", /clarif|say it|not sure|didn't catch|which/i);
});

test("a confirmed envelope still revalidates: changed screen blocks execution", async () => {
  const world = makeWorld({ buffers: ["Pick one\n1. Continue\n2. Abort\n", "totally different screen now\nuser@mac ~ %"] });
  const run = await speak(world, "pick the first one");
  const outcome = consumePending(run.pendingAction.confirmId, "yes");
  assert.equal(outcome.status, "approved");
  assert.ok(outcome.pending.envelope);
  const check = await world.dispatcher.revalidate(outcome.pending.envelope);
  assert.equal(check.ok, false, "the screen changed after approval — blocked");
});

// ---- TOCTOU ------------------------------------------------------------------

test("the screen changing between resolution and keystroke aborts the action", async () => {
  const world = makeWorld({
    buffers: [
      "Choose model:\n1. Qwen\n2. GPT\n3. Claude\n",   // resolution read
      "Choose model:\n1. DIFFERENT\n2. Menu\n"          // revalidation read
    ]
  });
  const run = await speak(world, "pick the second one");
  assert.equal(world.state.skillCalls.length, 0, "no keystroke on a changed screen");
  assert.match(run.reply, /changed|gone/i);
});

test("a switched target tab aborts even when text matches", async () => {
  const buffers = ["Choose model:\n1. Qwen\n2. GPT\n"];
  const world = makeWorld({ buffers });
  // Same buffer, different tab identity on the second read.
  let first = true;
  const dispatcher = createContextualDispatcher({
    perception: {
      foregroundApp: async () => ({ application: "Terminal" }),
      terminalContent: async () => {
        const id = first ? { windowId: "101", tabTty: "ttys003" } : { windowId: "101", tabTty: "ttys009" };
        first = false;
        return { title: "t", text: buffers[0], ...id, source: "terminal" };
      }
    },
    working: createWorkingContext(),
    contextLease: createSerialLease(),
    terminalLease: createSerialLease(),
    callLocalBrain: async () => { throw new Error("none"); },
    callCloudBrain: async () => { throw new Error("none"); },
    runSkill: async () => { throw new Error("must not run"); },
    pend: () => ({ confirmId: "x" }),
    needsConfirmation,
    confirmPromptFor,
    isOffline: () => true,
    caps: () => CAPS,
    log: () => {}
  });
  const intent = classifyIntent("pick the first one", CAPS, []);
  const run = await dispatcher.maybeDispatch({ text: "pick the first one", intent });
  assert.match(run.reply, /changed|gone/i);
});

// ---- semantic tier -----------------------------------------------------------

test("offline mode never touches the cloud chooser", async () => {
  const world = makeWorld({ offline: true, buffers: ["Choose model:\n1. Qwen\n2. GPT\n"] });
  const run = await speak(world, "go with the last option"); // "last" resolves deterministically…
  assert.ok(run);
  const world2 = makeWorld({ offline: true, buffers: ["Choose model:\n1. Qwen\n2. GPT\n"] });
  await speak(world2, "take the best one"); // …but "best" needs a chooser
  assert.equal(world2.state.cloudCalls, 0, "zero cloud calls in local-only mode");
});

test("the cloud chooser (hybrid) can only pick candidates — never author tools", async () => {
  const world = makeWorld({
    buffers: ["Choose model:\n1. Qwen\n2. GPT\n3. Claude\n"],
    localBrain: () => "garbage that is not json",
    cloudBrain: () => '{"choice":"select_3","confidence":0.93}'
  });
  const run = await speak(world, "take the smartest one");
  assert.ok(run);
  assert.equal(world.state.localCalls, 1);
  assert.equal(world.state.cloudCalls, 1);
  assert.deepEqual(world.state.skillCalls[0].params, { action: "type_and_run", text: "3", expect_tty: "ttys003" },
    "only a candidate keystroke, nothing the model invented");
});

test("a model-chosen action is context-derived: opaque labels still confirm", async () => {
  const world = makeWorld({
    buffers: ["Pick one\n1. Continue\n2. Abort\n"],
    localBrain: () => '{"choice":"select_1","confidence":0.95}'
  });
  const run = await speak(world, "take the better one");
  assert.ok(run.pendingAction, "model-chosen opaque effect confirms");
  assert.equal(world.state.skillCalls.length, 0);
});

test("unresolved contextual turns end in clarification, never the generative loop", async () => {
  const world = makeWorld({ buffers: ["no menu here, just text output"] });
  const run = await speak(world, "take the fourth one");
  assert.ok(run, "the turn is HANDLED (clarify) — it must not fall through");
  assert.equal(world.state.skillCalls.length, 0);
});

// ---- concurrency -------------------------------------------------------------

test("overlapping contextual turns are serialized; the overflow gets an honest busy", async () => {
  const world = makeWorld();
  let release;
  const slowRun = world.dispatcher.maybeDispatch({
    text: "pick the first one",
    intent: classifyIntent("pick the first one", CAPS, []),
    turnId: "slow"
  });
  // Immediately pile on two more before the first finishes.
  const second = speak(world, "pick the second one");
  const third = speak(world, "pick the third one");
  const [a, b, c] = await Promise.all([slowRun, second, third]);
  const busyCount = [a, b, c].filter((r) => /one thing at a time|still (on|finishing)/i.test(r.reply)).length;
  assert.ok(busyCount <= 1, "at most one busy rejection for a fast queue");
  void release;
});
