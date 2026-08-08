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
