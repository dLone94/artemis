// Coverage judgement for a segmented collection.
//
// This decides when a days-long collection is finished. Getting it wrong in the
// permissive direction is the dangerous one: the collection stops early and
// mints a baseline asserting scores for cases nobody ever asked the model.
//
// Run: node --test test/evalCoverage.test.mjs
import test from "node:test";
import assert from "node:assert";
import { candidateSegments, partitionByCodeState, measuredStrata } from "../eval/coverage.mjs";

const MODEL = "llama-3.3-70b-versatile";
const RUBRIC = "1.3.3";
const RUN = { model: MODEL, systemPromptHash: "aaaa1111", toolRegistryHash: "bbbb2222", temperature: 0 };

const STRATA = new Map([
  ["confirmation", ["confirm-send"]],
  ["chat", ["chat-a", "chat-b"]]
]);

function seg(partial, results, overrides = {}) {
  return {
    file: `${partial}.json`,
    report: {
      selftest: false, brainPinned: true, partial, verdict: "PASS",
      modelsSeen: [MODEL], rubricVersion: RUBRIC, ranAt: "2026-08-11T10:00:00.000Z",
      run: RUN, results, ...overrides
    }
  };
}
const ok = (id) => ({ id, pass: true, fails: [] });
const dead = (id) => ({ id, pass: false, fails: ["dead turn: no speech, no tool, no pending action"] });

test("only pinned, single-model, current-rubric partial runs are candidates", () => {
  const entries = [
    seg("chat", [ok("chat-a"), ok("chat-b")]),
    seg("chat", [ok("chat-a")], { selftest: true }),
    seg("chat", [ok("chat-a")], { brainPinned: false }),
    seg("chat", [ok("chat-a")], { verdict: "BROKEN" }),
    seg("chat", [ok("chat-a")], { modelsSeen: [MODEL, "other"] }),
    seg("chat", [ok("chat-a")], { modelsSeen: ["some-other-model"] }),
    seg("chat", [ok("chat-a")], { rubricVersion: "1.2.1" }),
    seg("chat", [ok("chat-a")], { partial: null })
  ];
  const got = candidateSegments(entries, { model: MODEL, rubricVersion: RUBRIC });
  assert.equal(got.length, 1, "every disqualifying shape is excluded");
});

test("the newest segment defines the code state; earlier ones can go stale", () => {
  const older = seg("chat", [ok("chat-a"), ok("chat-b")]);
  older.report.ranAt = "2026-08-10T10:00:00.000Z";
  older.report.run = { ...RUN, systemPromptHash: "old00000" };
  const newer = seg("confirmation", [ok("confirm-send")]);

  const candidates = candidateSegments([older, newer], { model: MODEL, rubricVersion: RUBRIC });
  const { usable, stale, ref } = partitionByCodeState(candidates);
  assert.equal(ref.systemPromptHash, "aaaa1111", "newest wins");
  assert.equal(usable.length, 1);
  assert.equal(stale.length, 1, "a segment from before a prompt edit is discarded");

  // Same for a registry change and a temperature change.
  for (const drift of [{ toolRegistryHash: "old00000" }, { temperature: 0.3 }]) {
    const drifted = seg("chat", [ok("chat-a"), ok("chat-b")]);
    drifted.report.ranAt = "2026-08-10T10:00:00.000Z";
    drifted.report.run = { ...RUN, ...drift };
    const part = partitionByCodeState(candidateSegments([drifted, newer], { model: MODEL, rubricVersion: RUBRIC }));
    assert.equal(part.stale.length, 1, `drift in ${Object.keys(drift)[0]} is stale`);
  }
});

test("a stratum is measured only when every case in it actually answered", () => {
  const whole = partitionByCodeState(candidateSegments([seg("chat", [ok("chat-a"), ok("chat-b")])], { model: MODEL, rubricVersion: RUBRIC })).usable;
  assert.equal(measuredStrata(whole, STRATA).size, 1, "a complete, alive stratum counts");

  // A failure is a measurement. A dead turn is not — it was never asked.
  const failed = partitionByCodeState(candidateSegments([seg("chat", [ok("chat-a"), { id: "chat-b", pass: false, fails: ["reply did not match /x/"] }])], { model: MODEL, rubricVersion: RUBRIC })).usable;
  assert.equal(measuredStrata(failed, STRATA).size, 1, "a real failure still counts as measured");

  const withDead = partitionByCodeState(candidateSegments([seg("chat", [ok("chat-a"), dead("chat-b")])], { model: MODEL, rubricVersion: RUBRIC })).usable;
  assert.equal(measuredStrata(withDead, STRATA).size, 0, "a dead turn leaves the stratum unmeasured");

  const partial = partitionByCodeState(candidateSegments([seg("chat", [ok("chat-a")])], { model: MODEL, rubricVersion: RUBRIC })).usable;
  assert.equal(measuredStrata(partial, STRATA).size, 0, "a missing case leaves the stratum unmeasured");

  const unknown = partitionByCodeState(candidateSegments([seg("no_such_stratum", [ok("x")])], { model: MODEL, rubricVersion: RUBRIC })).usable;
  assert.equal(measuredStrata(unknown, STRATA).size, 0, "a stratum the rubric no longer has counts for nothing");
});
