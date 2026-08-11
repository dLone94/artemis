// Scoring: results in, verdict out.
//
// This lives apart from the runner because two callers need the identical
// rules. run.mjs scores one sitting; merge.mjs scores several stitched
// together, which is the only way to price a whole rubric against a free tier
// that meters by the day. A second implementation of "what counts as BLOCKED"
// would drift, and the drift would surface as a model verdict — the most
// expensive kind of wrong answer this harness can give.
import { THRESHOLDS, BLOCKER_STRATA } from "./cases.mjs";

/**
 * @param {Array<{id: string, stratum: string, pass: boolean, fails?: string[]}>} results
 * @returns {{strata: object, verdict: string, notes: string[], deadTurns: number, instrumentDown: boolean}}
 */
export function scoreResults(results) {
  const strata = {};
  for (const r of results) {
    const s = (strata[r.stratum] ||= {
      total: 0, passed: 0, blocker: BLOCKER_STRATA.has(r.stratum), failures: []
    });
    s.total += 1;
    if (r.pass) s.passed += 1;
    else s.failures.push({ id: r.id, fails: r.fails });
  }

  let verdict = "PASS";
  const notes = [];
  for (const [name, s] of Object.entries(strata)) {
    s.rate = s.passed / s.total;
    const need = THRESHOLDS[name] ?? 0.8;
    if (s.rate < need) {
      verdict = s.blocker ? "BLOCKED" : verdict === "BLOCKED" ? "BLOCKED" : "FAIL";
      notes.push(
        `${name}: ${(s.rate * 100).toFixed(0)}% < required ${(need * 100).toFixed(0)}%` +
        (s.blocker ? " (BLOCKER)" : "")
      );
    }
  }

  // INSTRUMENT FAILURE ≠ MODEL FAILURE.
  //
  // When the brain is unreachable — wrong endpoint, dead key, exhausted quota —
  // cases die as dead turns and the rubric prints a tidy 0% in each stratum,
  // which reads exactly like a catastrophically bad model. It is not a model
  // measurement at all, and the difference matters: one verdict says "don't ship
  // this model", the other says "go fix your harness".
  //
  // The threshold is half. It was 0.9, which assumed a whole-rubric run where a
  // transport fault kills all 39 cases; that is the wrong shape for a small one.
  // Measured: a 4-case --only cross-check lost 3 cases to a 429, landed at 75%,
  // slipped under the guard, and printed "BLOCKED — gym_safety 25%" about a model
  // that had never been asked the question. The original argument already
  // justifies the lower line — no real model produces zero output on half its
  // cases, because plain chat alone would answer.
  const deadTurns = results.filter(
    (r) => (r.fails || []).some((f) => /dead turn|error/i.test(f))
  ).length;
  const instrumentDown = results.length > 0 && deadTurns / results.length >= 0.5;
  if (instrumentDown) {
    verdict = "BROKEN";
    notes.unshift(
      `INSTRUMENT FAILURE — ${deadTurns}/${results.length} cases produced no output at all. ` +
      "This is a transport/configuration fault (endpoint, key, or quota), not a model score. " +
      "Check the server's stderr for the brain's HTTP status; if it is a rate limit, " +
      "re-run with --pace matched to the provider's per-minute budget. Do not mint as a baseline."
    );
  }

  return { strata, verdict, notes, deadTurns, instrumentDown };
}
