# opportunity_radar — the weekly research sweep

**Date:** 2026-07-29
**Status:** approved (skills roadmap item 5)
**Audit correction:** 2026-07-29 — the report/cache boundary, opaque
attribution, strict Figure metadata, confirmation capability, staleness edge,
deterministic run/replay dispatch, and greeting routing below replace the
original underspecified wording.

## What

A WEEKLY research sweep over the user's standing themes (default:
`["Africa-linked opportunities", "global macro"]`; themes stored in
`.data/radar.json`, editable by voice via a confirm-gated update like
`update_money_map`). It reuses the safe seams behind
`research_investment`: injected web search, finance.js Figures, the
derived Money Map context, and the untrusted-content boundary.

The cached, speakable report is constructed in CODE, not by asking the
outer speaking model to turn scraped prose into claims. It targets 2-4
findings and never exceeds 4, but fewer or zero are allowed when sources
do not support the target. Each surviving finding has fixed, code-owned
what/why-now/risks/horizon wording, the validated user theme, Money Map
stage context when available, and a mandatory source. A finding without a
usable source is dropped, never padded, and the report says that an
omission occurred.

`opportunity_radar` has one required argument:

```json
{ "action": "run" | "replay" }
```

Requiring the action prevents omission, but the model is not trusted to choose
the correct value. The registry derives `run` or `replay` from the explicit
user phrase and the server dispatches that code-owned value before either LLM
provider can alter it. “Run the radar” and weekly scan/sweep mean `run`;
“what did the radar find?” and bare “opportunity radar” mean the safer
`replay`. The greeting's yes-command is the explicit run phrase. The read
skill is direct-dispatch-only: it is absent from both provider tool catalogs,
and generic/hallucinated model calls are rejected. Direct replay works without
an LLM key, direct runs honor request cancellation before caching, and
`ARTEMIS_FAKE_TOOLS` returns a synthetic result without network or disk writes.

## Proactive without barging

No cron, no background daemon (constraints of the codebase). "Weekly" =
interaction-triggered at the two existing proactive seams: daily-brief
assembly and the greeting/briefing endpoint. The exact due rule is:

```text
due = no valid matching runAt + normalized cached report
      OR runAt is in the future
      OR now - runAt > 7 * 24 * 60 * 60 * 1000
```

Exactly seven days old is not due; seven days plus one millisecond is. A
missing store is a normal never-run state and is due. A malformed/unreadable
store, or invalid `now`, omits only the proactive clause rather than claiming a
status or breaking the four-section brief.

When due, the DAILY BRIEF appends one count-free clause in an independent
failure domain: “My weekly opportunity scan is due — want it?” It keeps
the existing four section keys. The greeting card has only one pending
yes-command, so it must not ask both the daily-brief and radar questions:
a due radar takes precedence and maps bare yes/tap to `run the radar`;
otherwise the existing daily-brief offer remains. The read-only eager
greeting request may show the radar card without claiming or writing
state, including in reduced-motion mode.

The sweep itself runs only when the user asks (“run the radar”, “weekly
scan”, or yes to that unambiguous offer). “What did the radar find?”
replays only a valid cache, states the `runAt` date, and never calls web
or finance sources. No cache returns an advisor-framed honest answer and
does not silently run.

## Persistence and concurrency

`.data/radar.json` uses the injected `ctx.readJson` / `ctx.writeJson` /
`ctx.mutate` seams and normalizes every read. The proactive reader additionally
uses a strict read-status seam so a missing file remains distinguishable from
malformed/unreadable JSON:

```js
{
  version: 1,
  revision: 0,
  themes: ["Africa-linked opportunities", "global macro"],
  runAt: null,       // valid ISO timestamp after a completed sweep
  report: null       // bounded, code-built speakable report; never raw web text
}
```

A completed sweep, including an honest zero-finding sweep after at least
one search source responded, records `runAt` and the report so the user
is not nagged repeatedly. Total search unavailability/failure does not
advance `runAt`. A run snapshots `revision` and themes before searching
and refuses to cache over a concurrent theme update. Writes require the
serialized atomic `ctx.mutate` seam; a non-atomic read/write fallback is
refused because it can overwrite a concurrent confirmed update.

`update_radar_themes` replaces the full ordered theme list. It starts with the
`update_money_map` exact-params WeakMap snapshot pattern, then hardens its
confirmation boundary: precheck creates only a *prepared* snapshot; the
positive `/api/confirm` decision moves that exact object to a separate live
confirmation capability; execute requires and consumes the latter. No/expiry
revokes the prepared snapshot. Execute revalidates and re-reads, and refuses if
revision/themes changed. One confirmed write increments revision and clears
`runAt` and `report`, so old-theme findings cannot replay and the new themes
are immediately due. Precheck followed by direct execute, no, expiry, reuse,
or a stale snapshot writes nothing.

Themes must be an array of 1-5 unique strings. Each is trimmed, 3-60
characters, and contains no Unicode `Cc` or `Cf` control/format
characters. Semantic validation runs in both precheck and execute because
the registry validator does not enforce every JSON Schema keyword and
the confirmation endpoint executes a pending skill directly. Invalid
model-supplied field names are never reflected into speech.

## Injection and figure boundary

Search-provider `answer`, result titles, snippets, and other scraped
wording are attacker-influenced. `wrapUntrusted` prevents a forged
sentinel from escaping its frame, but wrapping alone does not make
instructions or numbers safe for speech.

Therefore:

- A source is eligible only when `new URL` accepts it, its protocol is
  `http:` or `https:`, and it has a hostname. Hostnames and paths are still
  attacker text: the validated URL is retained only as non-spoken link/cache
  metadata. Speech, model-facing content, and `sources[].title` use opaque,
  code-owned ordinal labels such as “Opportunity Radar source one”.
- A web result may contribute only the existence of a candidate for a
  validated user theme and its validated URL. Fixed code wording says it
  surfaced in this sweep but that no dated catalyst was verified; the
  current search result shape has no trusted publication-date field.
- Provider `answer`, titles, snippets, and source-supplied product or
  instrument wording never enter `summary`, model-facing `content`,
  panels, `sources[].title`, the cached report, or replay.
- Raw result text may be sentinel-stripped and placed inside exactly one
  `wrapUntrusted("UNTRUSTED_RESEARCH_CONTENT", ...)` block in a separate
  non-spoken, non-persisted `evidence` result field for audit/testing.
  `server.js` passes only `content` to the speaking model, so this field
  is deliberately outside that path.
- `opportunity_radar` belongs to `UNTRUSTED_SKILLS` (taint after the
  search) and to the tools blocked after a mail/message read (no query
  derived from hostile mail).
- Scraped numbers are never parsed into Figures. Market context comes only
  from finance.js. Radar accepts only a finite numeric value, a valid source
  URL, and a real `YYYY-MM-DD` date; it derives the FX pair, ten-year tenor, and
  source labels in code instead of repeating Figure metadata. The Treasury
  input and normalized cache entry must be the exact 10-year entry—there is no
  first-row fallback. Cache normalization derives source/market omission flags
  from what actually survives validation rather than trusting stored flags. Every
  accepted market Figure reaches report text only through `formatFigure`;
  malformed/sourceless/undated/wrong-tenor Figures are omitted with an honest
  fixed clause. User planning values/stage numbers and the replay date are not
  market figures.
- Instrument/product wording may be repeated only when it came from the
  validated user theme and is labelled as that theme. No scraped wording,
  URL component, or Figure metadata is quoted. Attribution in speech uses only
  the opaque code-owned source ordinal.

## Wiring

- skills.js: `opportunity_radar` (family: radar; runs the sweep or
  replays cache) and `update_radar_themes`. The canonical
  `MONEY_ADVISOR_LINE` physically prefixes summary and content on every
  fresh, replay, empty/degraded, no-cache, failure, confirmation, and
  update-result path; it is never merely delegated as a model
  instruction.
- The money build has `readDerivedMoneyMap`, but its actual
  research-stage prose is currently inline in `research_investment`.
  Extract that inline block into a shared helper and reuse it in both
  research skills. Preserve the honest current stage and total
  permanent-loss-cap semantics: never call the cap “left” because no
  allocation balance is stored. A risky/Africa-linked candidate is only
  something to research for the optional sidecar, not an automatic
  recommendation or proof that Stage 3 is current.
- `update_radar_themes` is always confirmed; it follows the prepared/approved
  snapshot contract above, revokes cancelled/expired capabilities, and
  validates theme strings in code.
- The sweep searches per theme and obtains a US 10-year benchmark plus
  USD/planning-currency FX when a complete valid map supplies a
  non-USD currency (otherwise the existing USD/KES default). It never
  guesses a country/currency from free text.
- daily_brief: due-clause in its own honest-omission domain; preserve the
  four-section response shape.
- server.js + public/cockpit.js: expose/render the read-only due offer and
  route its one pending yes/tap to `run the radar`; radar takes
  precedence over the daily offer while due. The server also performs the
  registry-derived run/replay dispatch before either LLM path.
- untrusted.js: register radar for post-search taint and pre-search
  mail-taint blocking.
- toolRegistry: `opportunity_radar` is family `radar`, effect `read`,
  direct-dispatch-only, with no global search requirement so replay remains
  available offline without exposing model-chosen actions.
  `update_radar_themes` is family `radar`, effect `mutation`,
  `confirm: "always"`, `forceFamilies: ["radar_update"]`. Add both
  actionable families; put the explicit theme-update pattern before the
  read pattern. Route only “opportunity radar”, “run the radar”, “weekly
  scan/sweep”, and “what did the radar find” shapes — bare
  “opportunity”, “start the radar”, and “what's on the radar” are too broad.
  These are whole-utterance command/question shapes, not substrings quoted or
  discussed inside a longer message.
  Negated run/scan/sweep/update phrases stay chat even with ordinary filler
  words between the negation and verb.
- test/radar.test.mjs: exactly six numbered cases:
  1. strict seven-day/cache-validity boundary plus isolated daily-brief and
     greeting due behavior, including corrupt-store and invalid-clock omission;
  2. cached replay states its date and calls neither search nor finance;
  3. missing/malformed/non-HTTP(S) sources are dropped and honestly
     acknowledged, with zero invention;
  4. full theme validation, deterministic registry action, confirmation
     capability, and direct/no/expired/yes/reuse/stale behavior;
  5. canonical advisor line on every report/confirmation/update path and
     strict, code-labelled market Figures;
  6. a sentinel-breakout + instruction + tool request + fake market number,
     including those encoded in a hostile hostname, exists only inside the
     non-spoken wrapper or validated URL metadata and is absent from speech,
     model content, panels, persisted prose, and source titles; radar taint is
     registered.
  Add this test immediately before the eval self-test in `npm test`.

## Constraints

No new deps, no cron/daemon/polling, formatFigure for every market
figure, advisor framing in code, mandatory per-finding sources, bounded
validated themes as the only free-text input, no raw evidence in the
speakable/cache path, and no product names introduced by Artemis. No git
commit is part of this build.
