// Stitch several partial runs into one whole-rubric measurement.
//
//   node eval/merge.mjs --out eval/baseline-current.json seg-a.json seg-b.json ...
//
// WHY THIS EXISTS. A pinned 39-case run costs roughly 250-320k tokens. Groq's
// free tier meters 100k per DAY, so the model gate — the thing that decides
// whether a model may ship — could not be run at all, and eval/baseline-current
// .json sat stranded three rubric versions behind. Pacing does not help: the
// spend is per case, not per interval. Splitting the rubric across days does,
// and this merges the pieces back.
//
// WHAT MAKES A MERGE HONEST. A baseline is a claim that ONE model answered THIS
// rubric under THIS code. Segments run days apart can quietly violate every part
// of that, so all of it is checked rather than trusted:
//
//   · one model, pinned, across every segment (no blending, no failover)
//   · identical rubricVersion, systemPromptHash, toolRegistryHash, temperature
//     — any edit to a case, the prompt, or a tool schema invalidates the lot
//   · every case present exactly once — no gaps, no case counted twice
//   · no segment that was itself BROKEN — dead turns are unmeasured cases, and
//     an unmeasured case must be re-run, never averaged in
//
// Failing any of these is an error, not a warning. A merged report that quietly
// mixed two prompts would be worse than no baseline: it would look like a
// measurement and read like a verdict.
import { readFileSync, writeFileSync } from "node:fs";
import { CASES, RUBRIC_VERSION } from "./cases.mjs";
import { scoreResults } from "./score.mjs";

const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const OUT = outIndex >= 0 ? argv[outIndex + 1] : null;
const FILES = argv.filter((a, i) => a !== "--out" && i !== outIndex + 1 && !a.startsWith("--"));

function die(message) {
  console.error("merge refused: " + message);
  process.exit(1);
}

if (!FILES.length) die("no segment files given. Usage: node eval/merge.mjs --out <file> <segment>...");

const segments = FILES.map((file) => {
  try { return { file, report: JSON.parse(readFileSync(file, "utf8")) }; }
  catch (e) { die(`cannot read ${file}: ${e.message}`); }
});

// ---- one model, one rubric, one code state ----------------------------------
const IDENTITY = [
  ["rubricVersion", (r) => r.rubricVersion],
  ["model", (r) => r.run && r.run.model],
  ["systemPromptHash", (r) => r.run && r.run.systemPromptHash],
  ["toolRegistryHash", (r) => r.run && r.run.toolRegistryHash],
  ["temperature", (r) => r.run && r.run.temperature]
];
const first = segments[0];
for (const { file, report } of segments) {
  if (report.selftest) die(`${file} is a selftest — it measures the harness, not a model`);
  if (!report.brainPinned) die(`${file} was not pinned; an unpinned run may blend models`);
  if (report.verdict === "BROKEN") die(`${file} is BROKEN — re-run its cases instead of merging them`);
  const seen = report.modelsSeen || [];
  if (seen.length !== 1) die(`${file} saw ${seen.length} models (${seen.join(", ") || "none"}); one segment must be one model`);
  for (const [label, read] of IDENTITY) {
    const a = read(first.report);
    const b = read(report);
    if (a !== b) die(`${label} differs: ${first.file} has ${JSON.stringify(a)}, ${file} has ${JSON.stringify(b)}`);
  }
}
if (first.report.rubricVersion !== RUBRIC_VERSION) {
  die(`segments are rubric ${first.report.rubricVersion} but this checkout is ${RUBRIC_VERSION}; scores are not comparable`);
}

// ---- every case exactly once ------------------------------------------------
const byId = new Map();
for (const { file, report } of segments) {
  for (const r of report.results || []) {
    if (byId.has(r.id)) die(`case "${r.id}" appears in two segments (${byId.get(r.id).file}, ${file}); a case must be counted once`);
    byId.set(r.id, { file, result: r });
  }
}
const expected = CASES.map((c) => c.id);
const missing = expected.filter((id) => !byId.has(id));
const unknown = [...byId.keys()].filter((id) => !expected.includes(id));
if (missing.length) die(`${missing.length} case(s) never ran: ${missing.join(", ")}`);
if (unknown.length) die(`segments contain case(s) not in this rubric: ${unknown.join(", ")}`);

// Rubric order, not arrival order, so a merged report reads like a single run.
const results = expected.map((id) => byId.get(id).result);
const { strata, verdict, notes, instrumentDown } = scoreResults(results);

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const report = {
  rubricVersion: RUBRIC_VERSION,
  brainPinned: true,
  modelsSeen: first.report.modelsSeen,
  ranAt: new Date().toISOString(),
  selftest: false,
  partial: null,
  // Provenance is part of the measurement: a reader must be able to see that
  // this was assembled, from what, and when each piece was taken.
  merged: {
    segments: segments.map(({ file, report: r }) => ({
      file,
      ranAt: r.ranAt,
      cases: (r.results || []).length,
      partial: r.partial || null
    }))
  },
  run: first.report.run,
  verdict,
  notes,
  totals: { cases: results.length, passed: results.filter((r) => r.pass).length },
  latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)] || 0, p95: latencies[Math.floor(latencies.length * 0.95)] || 0 },
  costTokens: null,
  strata,
  results
};

console.log(`─── rubric ${RUBRIC_VERSION} · MERGED from ${segments.length} segments ───`);
for (const [name, s] of Object.entries(strata)) {
  console.log(`  ${name.padEnd(18)} ${s.passed}/${s.total}  ${(s.rate * 100).toFixed(0)}%${s.blocker ? "  [blocker]" : ""}`);
}
console.log(`  model ${report.run.model} · prompt ${report.run.systemPromptHash} · registry ${report.run.toolRegistryHash}`);
for (const note of notes) console.log("   · " + note);
console.log(`\n${verdict === "PASS" ? "✅" : "❌"} ${verdict} — ${report.totals.passed}/${report.totals.cases} cases`);

if (instrumentDown) die("merged run is mostly dead turns; it is not a model measurement");

if (OUT) {
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`   written: ${OUT}`);
} else {
  console.log("   (no --out given; nothing written)");
}
