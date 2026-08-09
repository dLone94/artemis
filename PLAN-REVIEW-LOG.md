# PLAN-REVIEW-LOG — Vault + Constellation + MiniMax TTS + Offline Brain

## Act 3 — Build

### Round 1 — Codex build (thread 019fe2b3-a6a7-7042-8bd0-3f57f0b6587f, gpt-5.6-sol/ultra)

Implemented all four PLAN.md tasks in one pass. Files: `obsidianVault.js` (new,
468 lines), `skills.js` (+134), `toolRegistry.js` (+12), `untrusted.js` (+2
taint entries), `server.js` (+450/−83), `public/voiceOrb.js` (+186),
`package.json` (test script), three new test files (510 lines). Codex-reported
deviations: no browser available for the screenshot proof; vault has 31
graph-visible notes (not 36); MiniMax current docs omit `?GroupId=` but the
frozen spec's contract was kept.

### Claude's verdict — APPROVED (no fix rounds needed)

- Full diff read. Quality above expectation. Highlights beyond spec:
  symlink-aware path confinement (realpath of nearest existing ancestor);
  `wx` create-only writes everywhere; usage.json migration backfill for the
  new `minimax` counter; `reasoning_effort: "none"` on the ollama tier
  (kills the local reasoning-channel trap at the source); network-error
  benching (`ECONNREFUSED` etc.) so an unreachable cloud brain fails over
  instead of killing the turn — with the retry counter not consumed.
- Two changes outside the plan's file list, both judged necessary and kept:
  `untrusted.js` (vault reads must taint), `package.json` (test wiring).
  One behavioral change flagged and accepted: Anthropic-path action turns now
  route to the tool-capable model instead of the no-tools fast path — without
  it, "note this down" could never fire `save_note` on that path.
- Proofs (run by Claude, not trusted from the report): new tests 15/15;
  full `npm test` + 19/19 eval selftest green; live `/api/vault/graph`
  against the real vault returns 31 nodes / 132 edges, degree-sorted and
  capped correctly.
- Visual proof: headless capture only caught the boot screen; constellation
  review deferred to the user on the live app (relaunched on this build).
- MiniMax remains untested against the real API (no credentials in env yet) —
  the provider is inert without `MINIMAX_API_KEY`+`MINIMAX_GROUP_ID` and its
  request/fallback contract is mock-tested.

Awaiting human diff sign-off before commit.

## Act 3 — Build: Financial Co-Pilot Stage 1 (2026-08-09)

### Round 1 — Codex build (gpt-5.6-sol/ultra, /tmp/codex-stage1.txt)

All three PLAN.md tasks in one pass: four income-path Money Map fields,
ranked radar findings (validated enums, code-owned rank + spoken rank-basis
sentence), finance_safety blocker stratum (rubric 1.2.0, 35 cases).
classifyIntent probes run as mandated — all four finance prompts classify
as chat, no family-narrowing conflicts. toolRegistry.js touched beyond the
plan's file list: map_update routing extended to the new field subjects —
reviewed, load-bearing, kept.

### Claude's verdict — APPROVED (no fix rounds)

Three reported deviations, all judged correct: (1) caught a genuine plan
bug — the mandated mock sentence contained "guarantees" against its own
notSay regex; (2) fresh radar findings get honest `unknown` categories
because the audited source boundary exposes only existence + URL —
inventing differentiation would violate the advisor boundary; (3) enum
table followed over loose prose. Proofs run by Claude: money+radar tests
pass, selftest 35/35, full npm test green. Awaiting human commit sign-off.

## Act 3 — Build: Financial Co-Pilot Stage 2 (2026-08-09)

### Round 1 — Codex build (/tmp/codex-stage2.txt)

moneyLedger.js (424 lines) + 600-line test file + two skills + registry
routing + brief integration, zero deviations. Registry patterns show real
care: "I spent forty minutes" excluded from expense routing by a time-unit
lookahead; "add a bill reminder" stays a reminder request. Math.* appears
only clamping the suggestion limit — all money arithmetic is BigInt.

### Claude's verdict — APPROVED (no fix rounds)

Proofs run by Claude: ledger tests (confirm-gated, revision-bound,
currency-refusal, BigInt discipline), brief tests (ordered, honest,
once-daily), full npm test, selftest 35/35. Awaiting commit sign-off.
