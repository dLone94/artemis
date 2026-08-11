// Drive a segmented model-gate collection to completion, one stratum per run.
//
//   node eval/collect.mjs [--model <id>] [--out eval/baseline-current.json]
//
// A whole rubric costs ~250-320k tokens against a free tier that drains at
// ~4.3k/hour, so the collection takes days and cannot be babysat. Each
// invocation does the smallest useful unit of work and exits:
//
//   · works out which strata are already measured under the CURRENT code
//   · runs the smallest unmeasured one, or merges and mints when none are left
//   · exits quietly when the daily budget is gone, so a scheduler can simply
//     call it again later without accumulating failures
//
// WHAT COUNTS AS MEASURED is deliberately strict. A stratum counts only if a
// segment holds every one of its cases, none of them a dead turn, under the same
// model, rubric, prompt hash, registry hash and temperature as the newest
// segment. A dead turn is an unmeasured case wearing a failure's clothes; if it
// were allowed to count, the collection would finish early and mint a baseline
// asserting things nobody ever asked the model.
//
// CODE DRIFT DISCARDS WORK, LOUDLY. Segments are bound to the prompt and
// registry hashes. Editing the prompt, a tool schema, or a case mid-collection
// invalidates everything gathered before it — this reports how many segments it
// dropped and why, rather than merging across the change.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, RUBRIC_VERSION } from "./cases.mjs";
import { candidateSegments, partitionByCodeState, measuredStrata } from "./coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "eval", "results");

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };
const MODEL = opt("model") || "llama-3.3-70b-versatile";
const OUT = opt("out") || join(ROOT, "eval", "baseline-current.json");
const PACE = opt("pace") || "62000";

const STRATA = new Map();
for (const c of CASES) {
  if (!STRATA.has(c.stratum)) STRATA.set(c.stratum, []);
  STRATA.get(c.stratum).push(c.id);
}

// ---- what has already been measured, under THIS code ------------------------
const entries = [];
for (const f of readdirSync(RESULTS).filter((f) => f.endsWith(".json"))) {
  try { entries.push({ file: join(RESULTS, f), report: JSON.parse(readFileSync(join(RESULTS, f), "utf8")) }); }
  catch { /* a half-written report is not evidence of anything */ }
}
const candidates = candidateSegments(entries, { model: MODEL, rubricVersion: RUBRIC_VERSION });
const { usable, stale: staleSegments } = partitionByCodeState(candidates);
const stale = staleSegments.length;
const measured = measuredStrata(usable, STRATA);

const remaining = [...STRATA.keys()].filter((s) => !measured.has(s));
console.log(`rubric ${RUBRIC_VERSION} · model ${MODEL}`);
if (stale) console.log(`  ${stale} segment(s) ignored: taken under different prompt/registry/temperature`);
console.log(`  measured ${measured.size}/${STRATA.size} strata · remaining: ${remaining.join(", ") || "none"}`);

// ---- nothing left: merge and mint -------------------------------------------
if (!remaining.length) {
  console.log("\nall strata measured — merging");
  try {
    const out = execFileSync("node", [join(ROOT, "eval", "merge.mjs"), "--out", OUT, ...measured.values()], { encoding: "utf8" });
    console.log(out);
    console.log("DONE — baseline minted at " + OUT);
    process.exit(0);
  } catch (e) {
    console.error(e.stdout || "");
    console.error(e.stderr || "");
    console.error("MERGE REFUSED — see the reason above; the collection is not mintable as it stands.");
    process.exit(1);
  }
}

// ---- otherwise measure the smallest thing that might fit in what's left ------
const next = remaining.sort((a, b) => STRATA.get(a).length - STRATA.get(b).length)[0];
console.log(`\nrunning --only ${next} (${STRATA.get(next).length} cases)`);
let output = "";
try {
  output = execFileSync("node", [join(ROOT, "eval", "run.mjs"), "--model", MODEL, "--only", next, "--pace", PACE], { encoding: "utf8" });
} catch (e) {
  output = (e.stdout || "") + (e.stderr || "");
}
// A per-day limit is not a failure to fix, it is a budget to wait out. Exit 0 so
// a scheduler treats it as "nothing to do yet" rather than a broken job.
if (/tokens per day/.test(output)) {
  console.log("WAITING — daily budget exhausted; this stratum will be retried on the next run.");
  process.exit(0);
}
console.log(output.split("\n").slice(-16).join("\n"));
console.log(`PROGRESS — ${measured.size + 1}/${STRATA.size} strata may now be measured; run again for the next.`);
