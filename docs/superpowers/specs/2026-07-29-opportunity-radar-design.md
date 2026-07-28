# opportunity_radar — the weekly research sweep

**Date:** 2026-07-29
**Status:** approved (skills roadmap item 5)

## What

A WEEKLY research sweep over the user's standing themes (default:
Africa-linked opportunities + global macro; themes stored in
`.data/radar.json`, editable by voice via a confirm-gated update like
update_money_map). It reuses the existing research_investment machinery
(web search + finance.js sourced figures) to produce a spoken-prose
report: 2-4 findings, each with what/why-now/risks/horizon and SOURCES —
formatFigure discipline for every number; a finding without a source is
dropped, never padded.

## Proactive without barging

No cron, no background daemon (constraints of the codebase). "Weekly" =
staleness-triggered: when any interaction happens and the last sweep is
>7 days old, the DAILY BRIEF (and the greeting card) gains one clause:
"my weekly opportunity scan is due — want it?". The sweep itself runs
only when the user asks ("run the radar", "weekly scan", yes to the
offer). Results cache in `.data/radar.json` with runAt; "what did the
radar find" replays the cached report with its date stated.

## Wiring

- skills.js: `opportunity_radar` (family: radar; runs the sweep or
  replays cache; content instructs spoken delivery with the advisor
  framing line reused from money skills — in CODE, not model-delegated),
  `update_radar_themes` (confirm always; validated theme strings, max 5,
  each 3-60 chars, control-char-free).
- The sweep composes existing pieces: webSearch (already in skillCtx) per
  theme + fx/yield via finance.js; it must run inside the same untrusted
  wrapping used by research_investment for scraped text. When a map
  exists (money-map.json), the report notes which stage a finding would
  belong to (satellite, almost always) — reusing the stage-context helper
  from the money build.
- daily_brief: due-clause (count-free, "scan is due") when stale; reuse
  the brief's honest-omission pattern.
- toolRegistry: radar patterns (/opportunit(y|ies)|weekly (scan|sweep)|
  run the radar|what did the radar/i), map_update-style confirm for theme
  updates.
- test/radar.test.mjs: (1) staleness math (7d boundary) drives the
  due-flag; (2) cached replay states its date and never re-fetches;
  (3) a finding lacking a source is dropped and the report says so;
  (4) theme updates validate + confirm; (5) advisor line present in every
  report path; (6) scraped text stays inside untrusted wrapping. Add to
  npm test.

## Constraints

No new deps, no cron/daemon/polling, formatFigure for every market
number, advisor framing in code, sources mandatory, themes are the only
free-text input and they are validated. No product names in Artemis's own
voice — quoting a SOURCE's name for an instrument is allowed only inside
the wrapped evidence with attribution spoken ("according to <source>").
