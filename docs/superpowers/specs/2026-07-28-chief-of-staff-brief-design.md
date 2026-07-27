# daily_brief — the Chief-of-Staff morning brief

**Date:** 2026-07-28
**Status:** approved ("lets integrate it"), first of the skills roadmap

## What it is

The first time the user talks to Artemis on a given day (05:00–12:00
local), her greeting ends with an offer: "Want your brief?" On yes — and
only on yes — she speaks ONE flowing 30–45 second brief. It is also
available on demand any time via "give me my brief" / "what's my day".

## Content (assembled server-side, GET /api/brief, loopback-gated)

Sections in this order, each OMITTED (with one honest clause) when its
source is unavailable — never invented, never zeroed:

1. **Mail** — unread count + up to 3 that look personal/important.
   Heuristic: skip senders matching /no-?reply|newsletter|notification/i
   and messages with a List-Unsubscribe header; prefer plain senders.
   Uses the existing `listUnread` from gmail.js.
2. **Today** — reminders due today from the existing store, by time.
3. **Money minute** — from finance.js cached sources with their dates:
   one FX pair (default USD/KES until Money Map sets preferences) and the
   US 10-year yield. Every figure spoken with its source and as-of date
   (formatFigure already enforces this).
4. **World** — the existing news briefing summary (already cached 30 min).

Response shape: `{ sections: [{ key, spoken, items? }], generatedAt }` —
`spoken` is the sentence(s) she reads; the client concatenates in order.

## Behaviour rules

- **Offer, never barge.** The offer rides the existing greeting/briefing
  card mechanics (the BRIEFING READY card + window.__pendingBriefing yes
  path in cockpit.js/main.js). No unprompted speech.
- **Once per day.** Last-offered date persisted in the .data dir
  (brief.json). "Give me my brief" always works regardless.
- **Interruptible.** Barge-in already stops TTS; nothing special needed.
- **Fast.** Sources are fetched in parallel with a 4 s per-source timeout;
  a slow source is dropped with its honest clause, the brief never waits
  longer than ~5 s.

## Files

- server.js — /api/brief endpoint (parallel assembly, per-source
  try/catch, loopback-gated like /api/telemetry).
- skills.js — `daily_brief` skill (family: briefing or reuse an existing
  read-only family; effect: read-only; no confirmation) so "give me my
  brief" resolves as an executable action that fetches /api/brief
  server-side and returns the concatenated spoken text.
- toolRegistry.js — META entry (read-only, no confirm, available always).
- cockpit.js/main.js — extend the existing briefing offer to say "your
  brief" and route yes → daily_brief instead of news-only when the day's
  first interaction. Minimal diff: reuse the pending-briefing path.
- test/brief.test.mjs — (1) all sources present → 4 sections in order;
  (2) a dead source is omitted with honest clause, others intact; (3) a
  figure without source+date never reaches `spoken` (formatFigure throw
  path); (4) once-per-day offer flag flips and resets across dates;
  (5) endpoint loopback-gated. Fake sources, no network. Add to npm test.

## Out of scope

- Calendar (no integration exists), weather, configurable section order,
  scheduling/cron (the offer is interaction-triggered, not timed).
