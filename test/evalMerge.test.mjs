// Merging partial eval runs into one baseline.
//
// The merge exists so a whole-rubric measurement can be paid for across several
// days of a free tier's budget. That only holds if a stitched report is
// indistinguishable from one sitting, and if every way of stitching a lie is
// refused. Both halves are tested here.
//
// Run: node --test test/evalMerge.test.mjs
import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "../eval/cases.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MERGE = join(ROOT, "eval", "merge.mjs");
const WHOLE = JSON.parse(readFileSync(join(ROOT, "eval", "baseline-refactor-local.json"), "utf8"));

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), "merge-test-")); });
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** A segment carrying `results`, otherwise identical to the whole run. */
function segment(name, results, overrides = {}) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({
    ...WHOLE,
    results,
    totals: { cases: results.length, passed: results.filter((r) => r.pass).length },
    ...overrides
  }));
  return file;
}

/** @returns {{ok: boolean, stdout: string, stderr: string}} */
function merge(args) {
  try {
    return { ok: true, stdout: execFileSync("node", [MERGE, ...args], { encoding: "utf8" }), stderr: "" };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

const half = Math.floor(WHOLE.results.length / 2);
const firstHalf = WHOLE.results.slice(0, half);
const secondHalf = WHOLE.results.slice(half);

test("a merged run is identical to the single run it was split from", () => {
  const out = join(dir, "merged.json");
  const res = merge(["--out", out, segment("a.json", firstHalf), segment("b.json", secondHalf)]);
  assert.ok(res.ok, "merge should succeed:\n" + res.stderr);

  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(merged.verdict, WHOLE.verdict, "same verdict");
  assert.equal(merged.totals.passed, WHOLE.totals.passed, "same pass count");
  assert.equal(merged.totals.cases, WHOLE.totals.cases, "same case count");
  assert.deepEqual(
    Object.fromEntries(Object.entries(merged.strata).map(([k, v]) => [k, v.rate])),
    Object.fromEntries(Object.entries(WHOLE.strata).map(([k, v]) => [k, v.rate])),
    "every stratum scores the same"
  );
  // run.mjs emits results grouped by boot configuration, so a merged report is
  // not expected to match that order — it is expected to hold the same cases and
  // to be ordered by the rubric, which is stable however the segments were cut.
  assert.deepEqual(
    merged.results.map((r) => r.id).slice().sort(),
    WHOLE.results.map((r) => r.id).slice().sort(),
    "the same cases, however they were split"
  );
  assert.deepEqual(
    merged.results.map((r) => r.id),
    CASES.map((c) => c.id),
    "a merged report reads in rubric order, not arrival order"
  );
  assert.equal(merged.merged.segments.length, 2, "provenance records both segments");
  assert.equal(merged.partial, null, "a complete merge is not partial");
});

test("a merge refuses anything that would make the baseline a lie", () => {
  const out = join(dir, "rejected.json");

  // Different code or rubric state across segments.
  for (const [label, overrides, expected] of [
    ["a different system prompt", { run: { ...WHOLE.run, systemPromptHash: "deadbeef0000" } }, /systemPromptHash differs/],
    ["a different tool registry", { run: { ...WHOLE.run, toolRegistryHash: "deadbeef0000" } }, /toolRegistryHash differs/],
    ["a different temperature", { run: { ...WHOLE.run, temperature: 0.3 } }, /temperature differs/],
    ["a different model", { run: { ...WHOLE.run, model: "some-other-model" } }, /model differs/],
    ["an older rubric", { rubricVersion: "1.0.0" }, /rubricVersion differs/],
    ["an unpinned segment", { brainPinned: false }, /not pinned/],
    ["a blended segment", { modelsSeen: ["a", "b"] }, /one segment must be one model/],
    ["a broken segment", { verdict: "BROKEN" }, /BROKEN/],
    ["a selftest", { selftest: true }, /selftest/]
  ]) {
    const res = merge(["--out", out, segment("good.json", firstHalf), segment("bad.json", secondHalf, overrides)]);
    assert.equal(res.ok, false, `must refuse ${label}`);
    assert.match(res.stderr, expected, `refusal for ${label} should say why`);
  }

  // A gap means a case was never asked. Averaging over it invents a score.
  const gap = merge(["--out", out, segment("only-a.json", firstHalf)]);
  assert.equal(gap.ok, false, "must refuse an incomplete rubric");
  assert.match(gap.stderr, /never ran/);

  // A case counted twice weights it double and silently shifts the rate.
  const dupe = merge(["--out", out, segment("a1.json", firstHalf), segment("a2.json", firstHalf), segment("b1.json", secondHalf)]);
  assert.equal(dupe.ok, false, "must refuse a duplicated case");
  assert.match(dupe.stderr, /appears in two segments/);

  // A case the rubric no longer contains means the segment predates an edit.
  const stray = merge([
    "--out", out,
    segment("a3.json", firstHalf),
    segment("b3.json", [...secondHalf, { ...secondHalf[0], id: "case-that-was-deleted" }])
  ]);
  assert.equal(stray.ok, false, "must refuse an unknown case");
  assert.match(stray.stderr, /not in this rubric/);
});

test("a merge that is mostly dead turns is not a measurement", () => {
  const dead = WHOLE.results.map((r) => ({ ...r, pass: false, fails: ["dead turn: no speech, no tool, no pending action"] }));
  const res = merge([
    "--out", join(dir, "dead.json"),
    segment("d1.json", dead.slice(0, half)),
    segment("d2.json", dead.slice(half))
  ]);
  assert.equal(res.ok, false, "a fully dead merge must not be written");
  assert.match(res.stdout + res.stderr, /INSTRUMENT FAILURE|dead turns/);
});
