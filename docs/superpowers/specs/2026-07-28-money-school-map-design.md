# Money School + Money Map — investing from zero, for buying back time

**Date:** 2026-07-28
**Status:** approved (skills roadmap items 3–4), corrected after code/content audit

## Audit corrections that change the design

- Registry confirmation is tool-wide, not parameter-dependent. Keep
  `money_map` free for showing the map and recording a first answer, and
  add a separate always-confirmed `update_money_map` skill for overwrites.
  It uses the same precheck, named confirmation, snapshot, and stale-state
  refusal pattern as `delete_email`.
- School progress and first map answers are local persistence mutations,
  not genuinely read-only operations. They have registry effect
  `mutation`, but no always-confirm flag; a direct, untainted user request
  remains frictionless under the existing policy.
- Verbatim answers alone cannot be used for exact arithmetic. Persist the
  raw answer for audit plus canonical integer digit strings in one planning
  currency. All derived arithmetic uses `BigInt`; no floating-point money,
  hidden exchange-rate conversion, `parseFloat`, or arithmetic on raw text.
- The original Stage 2 target, "largest slice" rule, later-stage progress,
  and "satellite amount left" claim were not computable. Exact year-one
  formulas and honest v1 stage semantics are defined below.
- Fixed lessons contain no actual market rate, yield, price, inflation
  reading, or historical return. Small round numbers are explicitly
  hypothetical arithmetic, not dated market claims. Every actual market
  figure elsewhere still goes through `formatFigure`; scraped source-text
  numbers may remain in a wrapped evidence pack but must never be repeated
  into speech.
- Each map answer or correction requires one non-empty `raw_answer` string
  as well as exactly one compatible typed value. The stored audit copy is
  sentinel/control-character sanitized without silently synthesizing raw
  wording from the canonical value.
- Every user-facing school/map path carries the advisor boundary in code;
  it is not delegated to the model. Curriculum and map prose name no
  issuer, fund, security, platform, brand, product, exchange, or ticker and
  never promise an outcome or a return.

## Who this is for (drives every choice)

The user works months-long ship contracts and wants more time at home with
his wife and daughter. He is a complete beginner and wants an
Africa-aware, globally open education. "Buying back time" is his goal, not
an outcome Artemis claims investing will deliver.

Artemis teaches, records answers, and plans. She never executes trades,
links a brokerage, moves money, recommends a product, or implies that risk
creates a guaranteed reward. Every `money_school`, `money_map`, and
`update_money_map` result — including a lesson, repeat, completion,
interview question, invalid/incomplete state, update confirmation, and
update result — opens with this canonical framing:

> I'm a research assistant, not a licensed financial advisor. This is
> education and planning, not a promise of returns or a recommendation to
> buy anything.

The completed map also closes with:

> Nothing here moves money — it's a plan we refine.

## Skill A — money_school (the tutor)

- Triggers include "teach me investing", "money lesson", "next lesson",
  "repeat the lesson", and definition-shaped questions such as "what's a
  bond?". Registry family: `school`; effect: `mutation` because progress is
  persisted; no always-confirm flag.
- A fixed curriculum lives in `moneySchool.js` as data. Every lesson has a
  sequential integer `id`, a title, 4–6 spoken-prose beats, and one check
  question:
  1. why invest at all: inflation can reduce cash's purchasing power while
     emergency cash still has an important job;
  2. an emergency reserve comes first;
  3. risk and potential return: greater expected return generally involves
     greater risk, but taking more risk never guarantees a higher return;
  4. compounding gains, fees, and losses;
  5. fees and why broad index-style pooled funds exist;
  6. bonds and short-term government debt;
  7. company shares and pooled exchange-traded funds;
  8. diversification;
  9. currency risk when contract pay and family spending use different
     currencies;
  10. African market categories — sovereign foreign-currency debt, listed
      shares, and financial-technology businesses — plus currency,
      liquidity, governance, default, and capital-control risks;
  11. scams and too-good-to-be-true claims;
  12. putting the staged-plan shape together.
- A beat is one to three natural spoken sentences about one idea. It uses
  no markdown-like fragments or forced nautical metaphor. Small round
  examples start with language such as "Suppose, purely as an example".
  Maritime-income details appear only where natural: uneven paid months,
  family costs continuing between contracts, and keeping a reserve before
  sailing. Lessons never say money "will grow", never promise income or a
  timeline, and name only generic concepts and asset classes.
- Parameters are `action: "resume"|"next"|"repeat"|"lesson"` plus a lesson
  id only for `"lesson"`; other action/lesson combinations and extra keys
  are rejected without writing. `"next"` records the current lesson as
  completed and advances; `"repeat"` does not advance; `"resume"` returns
  the persisted current lesson. Finishing lesson 12 says the curriculum is
  complete and offers the Money Map as a planning exercise.
- Progress is normalized on every read and stored as
  `{ lesson, completedAt: [{ lesson, at }] }` in
  `.data/money-school.json` through the injected `ctx.readJson` /
  `ctx.writeJson` persistence seam. No direct filesystem access, market
  call, or background job belongs in the skill.
- Skill content includes the canonical framing, conversational delivery
  guidance, the beats in order, and exactly one check question at the end.

## Skill B — money_map (the interview and plan)

`money_map` has two free paths: show/resume and record the next first-time
answer. Registry family: `map`; effect: `mutation` because a first answer
is persisted; no always-confirm flag. It never overwrites an existing
answer — that is exclusively `update_money_map`.

If no complete map exists, the skill asks exactly the next unanswered
question, one per turn, in this order:

1. net income in a paid contract month, after tax and personal shipboard
   costs, in whole units, plus the single three-letter planning currency;
2. whole contract months worked in a typical year, from 0 through 12;
3. the family's positive average monthly needs in that same currency,
   including averaged irregular obligations;
4. liquid, uncommitted savings available to the plan in that currency,
   excluding pensions, property, and illiquid holdings;
5. the maximum total satellite principal that could be lost permanently
   without harming the family — not an annual allowance;
6. whole years until the user's "home more" horizon, from 1 through 80;
7. the sleep test: `sleep_normally`, `worry`, or `want_out` if the risky
   slice fell by half.

The first answer establishes the planning currency. Every later monetary
answer must use that same unit; Artemis performs no hidden FX conversion.
If ship income and family spending start in different currencies, the map
stays incomplete until the user supplies both as ballparks in the chosen
planning currency.

The skill accepts only the expected field and one value shape: numeric
fields reject a sleep-test choice, while the sleep-test field rejects
numeric/currency arguments. Every answer requires a non-empty
`raw_answer`. Numeric tool arguments are non-negative safe integers within
their field ranges; skill validation runs again because gated paths can
bypass registry validation. Persistence keeps a sanitized copy of the
user's supplied `raw_answer`, an ISO `answeredAt`, and a canonical decimal
digit string for each numeric value; it never fabricates the raw audit
answer from that digit string. The store is normalized on every read and
versioned:

```text
{
  version: 1,
  revision: integer,
  currency: three-letter code,
  answers: {
    field: { raw, value: canonical digit string or sleep-test enum, answeredAt }
  },
  updatedAt
}
```

It lives at `.data/money-map.json` through injected
`ctx.readJson`/`ctx.writeJson`. Derived values are never persisted; every
presentation recomputes them from validated stored answers.

### Exact map arithmetic

Let all monetary values be non-negative `BigInt` whole units in the
planning currency:

```text
income = contractMonthlyIncome × contractMonthsPerYear
annualNeeds = familyMonthlyNeeds × 12
headroom = max(0, income − annualNeeds)

emergencyTarget = familyMonthlyNeeds × 6
emergencyFunded = min(liquidSavings, emergencyTarget)
emergencyGap = max(0, emergencyTarget − liquidSavings)

postReservePool =
  max(0, liquidSavings − emergencyTarget)
  + max(0, headroom − emergencyGap)

satelliteCap =
  min(maxPermanentLoss, floor(postReservePool ÷ 5))
coreTarget = postReservePool − satelliteCap
```

No `Number` money arithmetic, floating percentage, or unchecked
multiplication is allowed. `postReservePool` is described as a year-one
planning estimate from stored ballparks — not disposable cash, a forecast,
or promised income. The fifth-of-pool ceiling makes the core at least 80%
of this calculated pool, while the risky slice can never exceed the
user's permanent-loss cap.

The presented map opens with the canonical framing and contains:

- **Stage 1 — reserve:** six months of family needs, the funded amount, and
  the exact gap. It is a rule of thumb, not a guarantee of safety.
  Graduate when liquid savings meet the target.
- **Stage 2 — boring core:** generic broad diversified company ownership
  and short-term government debt are candidates to research, not products
  or recommendations. The year-one target is `coreTarget`, always the
  largest calculated slice; it can still lose value. Graduate to
  considering the sidecar only after Stage 1 is covered and this target is
  deliberately allocated.
- **Stage 3 — optional risky sidecar:** Africa-linked asset classes may be
  researched, but the displayed number is a hard maximum of
  `satelliteCap`, not a recommendation to invest it. The full principal can
  be lost. No leverage or borrowing belongs in the map.

V1 can truthfully call Stage 1 current while `emergencyGap > 0`. Once the
gap is zero, Stage 2 is current and ongoing. Stage 3 is an optional
sidecar, not a later observed stage: no core or satellite balance is
stored, so Artemis never claims those stages are funded or says how much
satellite capacity is "left". Risk comfort changes warning language only;
it never increases the cap.

## Skill C — update_money_map (confirmed overwrites)

`update_money_map` accepts one known answer field plus the same typed value
shape as the interview. Registry metadata is family `map`, effect
`mutation`, `confirm: "always"`, with the force-only routing key
`map_update`; the skill also sets `requiresConfirmation: true`.

Its precheck rejects unknown/derived fields, extra action data, missing or
malformed values, unsafe integers, range violations, mixed currencies,
missing current answers, and no-op updates. It snapshots the current
revision and old/new normalized answer against the exact params object.
The confirmation carries the canonical advisor framing, names the old and
new value, and says every derived stage will be recalculated.

Only an explicit, live "yes" executes the write. On no or expiry, nothing
changes. Execute independently revalidates and re-reads the map; a changed
revision refuses as stale instead of overwriting newer data. A successful
write increments the revision, preserves the new raw answer and date,
recomputes the map, and carries the canonical closing line. The planning
currency itself is fixed in v1; changing it requires rebuilding all
monetary answers rather than relabelling amounts.

## Wiring

- `toolRegistry.js`
  - Add `money_school` family `school`, effect `mutation`.
  - Add `money_map` family `map`, effect `mutation`.
  - Add `update_money_map` family `map`, effect `mutation`,
    `confirm: "always"`, `forceFamilies: ["map_update"]`.
  - Add `school`, `map`, and `map_update` to actionable routing. Put
    `map_update` before `map`, and put school/map patterns before the broad
    `navigate` "show me" pattern. Keep school definition patterns narrow so
    explicit investment research still routes to `research_investment`.
    Negated teach/build/update/change requests are chat.
  - Registry schemas enumerate known fields and require integer types where
    numeric. Skill precheck/execute repeat semantic and safe-integer
    validation because registry validation tolerates extra keys and the
    confirmation endpoint executes a pending skill directly.
- `daily_brief`
  - Read and derive map status in a separate failure domain, like the
    follow-up clause, so a missing/corrupt map cannot make sourced money
    figures unreachable.
  - Only for a complete valid map with unmet Stage 1, append:
    `"Stage 1 sits at P percent — say 'my money map' for the picture."`
    `P = min(100, floor(emergencyFunded × 100 ÷ emergencyTarget))`, computed
    with `BigInt`. This is count-only: stage number and whole percentage,
    never currency amounts, income, savings, raw answers, or risk cap.
    Omit it for an absent/incomplete/corrupt map and once Stage 1 is met.
- `research_investment`
  - With an injected/readable valid map, append a trusted planning-context
    note outside the untrusted research-source wrapper. It states the
    honest current stage and the user's stored total permanent-loss cap,
    explicitly calling that a maximum rather than an amount Artemis
    recommends investing.
  - Never say the cap is "left" because no existing satellite allocation is
    stored. Do not write personal map data into the evidence pack.
    User-supplied map amounts may be spoken without a source; every market
    number still goes through `formatFigure`.

## Tests

`test/money.test.mjs` follows the repository's zero-dependency
`node:assert` style, sets a temporary `ARTEMIS_DATA_DIR` before dynamic
imports, injects persistence/time, performs no network call, and contains
exactly six numbered cases:

1. Curriculum ids are sequential; every lesson has 4–6 good spoken beats
   plus one check; curriculum prose has no named product/ticker, actual
   market figure, or return promise.
2. School progress persists, round-trips, resumes, repeats without
   advancing, and advances/completes correctly with advisor framing.
3. The map interview persists only the next unanswered field, asks exactly
   one next question, refuses an overwrite, and routes school/map phrases
   without research/navigate collisions.
4. Fixture answers produce exact literal emergency, headroom,
   post-reserve, core, satellite-cap, gap, and integer progress results;
   the daily brief adds only the count-only Stage 1 clause and isolates map
   failure.
5. Unknown fields and unsafe/invalid values are refused; the updater
   follows precheck → named confirmation → pending action; no/expired/stale
   confirmation writes nothing and one explicit yes writes once.
6. Every presented/interview/update path carries the advisor framing; the
   completed map closes correctly and contains no named product/ticker or
   promised return; research context says current stage and total cap,
   never an invented amount "left".

Add `node test/money.test.mjs` to `package.json` immediately before the
eval self-test.

## Constraints

No new dependencies. No live-market calls inside lessons or the map. No
background jobs. All stored data stays in `.data/`. No named product,
issuer, platform, brand, exchange, or ticker in curriculum/map output.
No promised return, income, outcome, or timeline. Market figures can reach
speech only through `formatFigure`; the user's own stored whole-unit
numbers and exact ratios are planning inputs, not market claims, and may
be spoken without a source tag.
