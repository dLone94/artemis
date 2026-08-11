// Which parts of the rubric are already measured, under the current code?
//
// Pure functions, separated from the collector that drives them, because this is
// the judgement that decides when a days-long collection is finished — and a
// collection that finishes early mints a baseline asserting things nobody ever
// asked the model.

/**
 * Segments worth considering at all: one pinned model, this rubric, not a
 * selftest, not itself broken, and produced by --only.
 */
export function candidateSegments(entries, { model, rubricVersion }) {
  return entries
    .filter(({ report: r }) =>
      r && !r.selftest && r.brainPinned && r.partial &&
      r.verdict !== "BROKEN" &&
      (r.modelsSeen || []).length === 1 && r.modelsSeen[0] === model &&
      r.rubricVersion === rubricVersion)
    .sort((a, b) => String(a.report.ranAt).localeCompare(String(b.report.ranAt)));
}

/**
 * Split candidates by whether they share the newest segment's code state.
 * The newest defines what is current; anything taken under a different prompt,
 * registry or temperature is stale and must not be merged across.
 */
export function partitionByCodeState(candidates) {
  const newest = candidates[candidates.length - 1];
  if (!newest) return { ref: null, usable: [], stale: [] };
  const ref = newest.report.run;
  const same = ({ report: r }) =>
    r.run &&
    r.run.systemPromptHash === ref.systemPromptHash &&
    r.run.toolRegistryHash === ref.toolRegistryHash &&
    r.run.temperature === ref.temperature;
  return { ref, usable: candidates.filter(same), stale: candidates.filter((c) => !same(c)) };
}

/**
 * A stratum counts as measured only when one segment holds every case in it and
 * none of those cases died. A dead turn is an unmeasured case wearing a
 * failure's clothes: it was never asked, so it cannot be scored, and letting it
 * count would end the collection early.
 *
 * @returns {Map<string, string>} stratum -> the file that measured it
 */
export function measuredStrata(usable, strata) {
  const measured = new Map();
  for (const { file, report } of usable) {
    const ids = strata.get(report.partial);
    if (!ids) continue;
    const have = new Map((report.results || []).map((r) => [r.id, r]));
    const complete = ids.every((id) => have.has(id));
    const alive = ids.every((id) =>
      !((have.get(id) || {}).fails || []).some((f) => /dead turn|error/i.test(f)));
    if (complete && alive) measured.set(report.partial, file);
  }
  return measured;
}
