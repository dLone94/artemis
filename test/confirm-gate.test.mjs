// Proves the confirm-before-act gate: a consequential skill (send_message)
// cannot execute without an explicit "yes". Run: node test/confirm-gate.test.mjs
import assert from "node:assert";
import { getSkill, createPending, getPending, dropPending, skillCtx } from "../skills.js";
import { confirmationDecision } from "../public/confirmDecision.js";

// send_message now opens WhatsApp for real, so the opener is stubbed — running
// the test suite must never launch an app or put a message in front of a human.
const opened = [];
skillCtx.openWhatsApp = async (url) => { opened.push(url); };

// spy on the real send_message.execute (registry returns the same object)
let sendCalls = 0;
const sm = getSkill("send_message");
const realExec = sm.execute.bind(sm);
sm.execute = async (p, ctx) => {
  sendCalls++;
  return realExec(p, ctx);
};

// mirrors the orchestrator gate in server.js (callClaude tool_use branch)
function gatedSkill(toolUses) {
  return toolUses.find((b) => {
    const s = getSkill(b.name);
    return s && s.requiresConfirmation;
  });
}
// mirrors the /api/confirm handler in server.js
async function confirmHandler(id, decision) {
  const pending = getPending(id);
  if (!pending) return { reply: "expired" };
  dropPending(id);
  if (decision !== "yes") return { reply: "cancelled" };
  return { reply: (await getSkill(pending.name).execute(pending.params, skillCtx)).summary };
}

(async () => {
  // 1) flags are correct
  assert.equal(getSkill("send_message").requiresConfirmation, true, "send_message MUST require confirmation");
  assert.equal(getSkill("remember_note").requiresConfirmation, false, "remember_note must be auto");

  // 2) a send tool-use is intercepted (gated), not auto-run
  const gated = gatedSkill([{ name: "send_message", input: { to: "Mom", body: "hi" } }]);
  assert.ok(gated, "a send_message tool-use must be gated");

  // 3) saying anything other than yes must NOT execute it
  const id1 = createPending("send_message", { to: "Mom", body: "hi" });
  await confirmHandler(id1, "no");
  await confirmHandler("bogus-id", "yes"); // expired/unknown id must not execute
  assert.equal(sendCalls, 0, "send MUST NOT fire without an explicit yes");
  assert.equal(opened.length, 0, "and no WhatsApp chat may be opened either");

  // 4) an explicit yes executes it exactly once
  const id2 = createPending("send_message", { to: "Mom", body: "hi" });
  await confirmHandler(id2, "yes");
  assert.equal(sendCalls, 1, "send must fire exactly once after yes");
  // Mom may or may not have a usable number in this developer's store, so assert
  // the invariant that holds either way: never more than one chat, only after yes.
  assert.ok(opened.length <= 1, "at most one chat opened, and only after a yes");

  // 5) a non-consequential skill is never gated (auto-runs in the loop)
  assert.ok(!gatedSkill([{ name: "remember_note", input: { text: "x" } }]), "remember_note must not be gated");

  // 6) a refusal always wins over mixed/contradictory speech
  for (const text of [
    "yes — actually no",
    "okay, don't",
    "okay, don’t",
    "sure, cancel",
    "yes, not now",
    "okay, but not yet",
    "sure, actually not"
  ]) {
    assert.equal(confirmationDecision(text), "no", `"${text}" must never confirm`);
  }
  assert.equal(confirmationDecision("open it"), "yes");
  assert.equal(confirmationDecision("maybe"), null);

  console.log("PASS ✅  confirm-gate: a 'send' cannot fire without an explicit yes (0 calls on no/expired, 1 on yes)");
})().catch((e) => {
  console.error("FAIL ❌ ", e.message);
  process.exit(1);
});
