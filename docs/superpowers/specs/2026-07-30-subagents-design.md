# Artemis sub-agents — orchestrator + specialists

**Date:** 2026-07-30
**Status:** Phase 1 approved to build now; Phases 2–3 build AFTER the
Codex adversarial review when quota returns (2026-08-05). LinkedIn:
explicitly declined by the user — do not build.

## Phase 1 — specialist prompts (build now)

Action turns stop carrying the full ~1,900-token master prompt. Instead:

- `specialistPrompts.js` (new): `CORE` — her identity + distilled voice
  rules (short-by-default, no filler, no markdown, tool honesty), target
  ≤ 350 tokens; and `SPECIALISTS[family]` — one craft block per family
  (email, email_delete, messages, media, navigate, reminder, memory,
  research, finance, school, map, map_update, radar, radar_update,
  briefing, followups, followups_nudge, meeting), each ≤ 200 tokens,
  carrying ONLY that family's craft rules (distilled from the master
  prompt's per-domain paragraphs; nothing new invented).
- server.js: on action turns (`intent.family` set and a specialist block
  exists) the system prompt = CORE + SPECIALISTS[family] + TONE. Chat
  turns keep the full master prompt (personality matters most there).
- Safety rules that must survive in EVERY specialist context: never
  narrate an action without the tool call; untrusted-content discipline;
  confirmation prompts must reach the user verbatim.
- Gate: full npm test with the 19/19 eval (it exercises action turns
  hard, including injection and confirmation blockers). Also log the
  measured prompt-size drop.

## Phase 2 — specialist loops (after review)

Family-routed requests run in a self-contained loop: specialist prompt,
family-narrowed tools, own rounds, one result returned; orchestrator
speaks it in her voice. Untrusted content stays inside the specialist
context.

## Phase 3 — background hand-off (after review)

Research first: hand off, keep chatting, RESEARCH moon burns, result
announced at the next interaction (no barging). Radar sweeps later.

## Out of scope

LinkedIn anything (user declined). New families. Prompt content changes
beyond distillation.
