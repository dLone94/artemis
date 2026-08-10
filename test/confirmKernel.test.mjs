// The confirmation KERNEL — the invariants every confirm-gated skill inherits,
// tested once here instead of implicitly per skill.
//
// Individual skills already prove their own gate (confirm-gate, email-delete,
// money, radar, meeting, ledger, gym). What none of them prove is the store
// underneath: that an approval is single-use, that it expires, that a decision
// other than "yes" never approves, and that a skill's own snapshot check can
// veto an otherwise-valid approval. Those are the properties that make the
// gate a permission boundary rather than a prompt.
//
// Run: node --test test/confirmKernel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const {
  createPending,
  getPending,
  dropPending,
  consumePending,
  getSkill
} = await import("../skills.js");

const TTL_MS = 300000; // skills.js pending TTL

/** Run fn with Date.now() advanced by ms, always restoring the real clock. */
function atClockOffset(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test("an approval is single-use: the second yes finds nothing", () => {
  const params = { to: "Mom", body: "test" };
  const id = createPending("send_message", params);
  assert.match(id, /^cf_/);
  assert.equal(getPending(id).name, "send_message");

  const first = consumePending(id, "yes");
  assert.equal(first.status, "approved");
  assert.equal(first.pending.name, "send_message");

  // The id is spent. A replayed confirm — a double-tap, a retried request,
  // a stale client — must not execute the action a second time.
  assert.equal(consumePending(id, "yes").status, "missing");
  assert.equal(getPending(id), null);
});

test("only an explicit yes approves", () => {
  for (const decision of ["no", "cancel", "", null, undefined, "YES ", "yeah", "y"]) {
    const id = createPending("send_message", { to: "Mom", body: "x" });
    const outcome = consumePending(id, decision);
    assert.equal(outcome.status, "cancelled", `decision ${JSON.stringify(decision)} must not approve`);
    assert.equal(getPending(id), null, "a cancelled pending is still consumed");
  }
});

test("a pending expires on its own, and expiry is not an approval", () => {
  const id = createPending("delete_email", { number: 1 });
  assert.ok(getPending(id), "live before the TTL");

  atClockOffset(TTL_MS + 1000, () => {
    assert.equal(getPending(id), null, "getPending refuses an expired action");
  });

  // getPending already dropped it; a late yes therefore finds nothing rather
  // than executing a five-minute-old destructive instruction.
  assert.equal(consumePending(id, "yes").status, "missing");

  // And when consume is the FIRST thing to notice the expiry, it reports it.
  const late = createPending("delete_email", { number: 2 });
  atClockOffset(TTL_MS + 1000, () => {
    const outcome = consumePending(late, "yes");
    assert.equal(outcome.status, "expired");
    assert.equal(outcome.pending.name, "delete_email");
  });
});

test("dropPending cancels without executing, and unknown ids are inert", () => {
  const id = createPending("send_message", { to: "Mom", body: "x" });
  dropPending(id);
  assert.equal(getPending(id), null);
  assert.equal(consumePending(id, "yes").status, "missing");

  assert.equal(consumePending("cf_never_existed", "yes").status, "missing");
  assert.equal(getPending("cf_never_existed"), null);
  assert.doesNotThrow(() => dropPending("cf_never_existed"));
});

test("a skill's snapshot check can veto an approval the store would allow", () => {
  // update_radar_themes binds its confirmation to a prepared snapshot keyed on
  // the exact params object. A params object that never went through precheck
  // has no snapshot, so approveSkillConfirmation returns false and the kernel
  // reports "expired" rather than executing an unvetted mutation.
  const skill = getSkill("update_radar_themes");
  assert.equal(typeof skill.approveConfirmation, "function", "precondition: the skill binds a snapshot");

  const unvetted = { themes: ["something the user never confirmed"], raw_answer: "…" };
  const id = createPending("update_radar_themes", unvetted);
  const outcome = consumePending(id, "yes");

  assert.equal(outcome.status, "expired", "no snapshot means no approval, even on an explicit yes");
  assert.equal(getPending(id), null, "and the pending is consumed either way");
});

test("pendings are independent: consuming one never disturbs another", () => {
  const a = createPending("send_message", { to: "Mom", body: "a" });
  const b = createPending("delete_email", { number: 3 });

  assert.equal(consumePending(a, "no").status, "cancelled");
  const still = getPending(b);
  assert.ok(still, "an unrelated pending survives");
  assert.equal(still.name, "delete_email");
  assert.equal(consumePending(b, "yes").status, "approved");
});
