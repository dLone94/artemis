// Working context: ephemeral recall with honest expiry, and the serial lease
// that keeps overlapping surfaces from interleaving contextual turns.
//
// Run: node --test test/workingContext.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkingContext, createSerialLease, WORKING_CONTEXT_TTL } from "../workingContext.js";

test("records validated calls exactly and expires them on TTL", () => {
  let t = 1_000_000;
  const wc = createWorkingContext({ now: () => t });
  wc.recordCommand({ tool: "run_command", args: { command: "npm test" }, risk: "safe", targetId: "w1:tty1", contextHash: "abc" });
  wc.recordOptionSet({ options: [{ n: 1, label: "Qwen" }, { n: 2, label: "GPT" }], evidence: { tailHash: "ff" } });

  let snap = wc.snapshot();
  assert.deepEqual(snap.lastCommand.args, { command: "npm test" });
  assert.equal(snap.lastCommand.targetId, "w1:tty1");
  assert.equal(snap.lastOptionSet.options.length, 2);

  t += WORKING_CONTEXT_TTL.optionSet + 1;
  snap = wc.snapshot();
  assert.equal(snap.lastOptionSet, null, "option sets go stale fast");
  assert.ok(snap.lastCommand, "commands live longer");

  t += WORKING_CONTEXT_TTL.command + 1;
  assert.equal(wc.snapshot().lastCommand, null, "commands expire too");
});

test("incomplete records are ignored — only validated calls are recallable", () => {
  const wc = createWorkingContext();
  wc.recordCommand({ tool: "run_command" }); // no args
  wc.recordOptionSet({ options: [] });
  assert.equal(wc.snapshot().lastCommand, null);
  assert.equal(wc.snapshot().lastOptionSet, null);
});

test("task lifecycle is turn-scoped and clears on end", () => {
  const wc = createWorkingContext();
  wc.beginTask("t1", "Selecting option 1");
  assert.equal(wc.snapshot().currentTask.label, "Selecting option 1");
  wc.endTask("t2"); // wrong turn — ignored
  assert.ok(wc.snapshot().currentTask);
  wc.endTask("t1", "done");
  assert.equal(wc.snapshot().currentTask, null);
});

test("the serial lease serializes and bounds its queue", async () => {
  const lease = createSerialLease({ maxQueue: 1 });
  const order = [];
  let release;
  const first = lease.run(async () => {
    order.push("a-start");
    await new Promise((r) => { release = r; });
    order.push("a-end");
  });
  const second = lease.run(async () => { order.push("b"); });
  // A third overlapping turn is refused, not queued forever.
  await assert.rejects(() => lease.run(async () => order.push("c")), /busy/);
  release();
  await first;
  await second;
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("an aborted waiter leaves the lease healthy", async () => {
  const lease = createSerialLease({ maxQueue: 1 });
  let release;
  const first = lease.run(async () => { await new Promise((r) => { release = r; }); });
  const ac = new AbortController();
  const waiting = lease.run(async () => "never", { signal: ac.signal });
  ac.abort();
  await assert.rejects(() => waiting, /aborted/);
  release();
  await first;
  const ok = await lease.run(async () => "fine");
  assert.equal(ok, "fine");
});

test("a throwing holder always releases (finally)", async () => {
  const lease = createSerialLease();
  await assert.rejects(() => lease.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lease.run(async () => 42), 42);
});
