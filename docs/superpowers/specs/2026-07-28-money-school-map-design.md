# Money School + Money Map — investing from zero, for buying back time

**Date:** 2026-07-28
**Status:** approved (skills roadmap items 3–4)

## Who this is for (drives every choice)

The user works on ships and wants investment income so they can be home
with their wife and daughter. Complete beginner ("I have no ideas how to
invest"). Africa-focused, open globally. Standing rule: never take
irreversible actions without explicit approval — Artemis TEACHES and
PLANS; she never executes trades, holds no brokerage links, moves no
money. She always says she's a research assistant, not a licensed advisor,
when presenting the plan or a recommendation-shaped answer.

## Skill A — money_school (the tutor)

- Trigger: "teach me investing", "money lesson", "next lesson",
  "what's a bond" etc. Family: school (read-only, no confirm).
- A fixed curriculum lives in a new `moneySchool.js` as DATA (title +
  4-6 spoken-prose beats + a one-question check), ~12 lessons:
  1 why invest at all (inflation eats cash) · 2 emergency fund first ·
  3 risk vs return, nothing pays more without more risk · 4 compounding ·
  5 fees and why index funds exist · 6 bonds and T-bills · 7 stocks and
  ETFs · 8 diversification · 9 currency risk (KES/NGN/USD — maritime
  income angle) · 10 African markets: eurobonds, NSE/JSE, mobile-money
  fintech, and their real risks · 11 scams and too-good-to-be-true ·
  12 putting it together: the staged plan shape.
- The skill returns the lesson content; the MODEL delivers it in her
  voice (content field instructs: conversational, one beat at a time is
  fine, end with the check question, keep her personality).
- Progress (`lesson`, `completedAt` list) persists in
  `.data/money-school.json` via the existing readJson/writeJson ctx.
  "next lesson" resumes; "repeat" re-teaches; finishing says what's next.
- Numbers inside lessons are illustrative and dated ("as of the lesson's
  writing") — live figures come from the finance family, not lessons.

## Skill B — money_map (the personal plan)

- Trigger: "my money map", "build my plan", "investment plan". Family:
  map. Two modes in one skill:
  - **interview**: if no map exists (`.data/money-map.json`), she asks
    ONE question per turn (the skill returns the next unanswered
    question): monthly income ballpark · months of contract per year ·
    family's monthly needs · existing savings · amount that could be lost
    without harming the family · horizon (years until "home") · risk
    comfort (sleep test). Answers stored verbatim with dates.
  - **present/update**: with all answers, she builds the staged map:
    Stage 1 emergency fund (target = 6× family monthly needs, gap shown)
    → Stage 2 boring core (global index + short-term government paper,
    the LARGEST slice) → Stage 3 satellite (Africa-linked opportunities,
    capped at the "could lose without harm" number, explicitly labelled
    the risky slice). Each stage: what, why, target amount from THEIR
    numbers, and "graduate when X". No named products in v1 — asset
    CLASSES only; research_investment covers specifics on demand.
- Mutating stored answers ("actually my income is…") is a confirm-gated
  update (effect: mutation — it changes the plan everything else quotes).
  Reading/presenting is free.
- The presented map always opens with the not-an-advisor line and closes
  with "nothing here moves money — it's a plan we refine."

## Wiring

- toolRegistry: `money_school` (school family), `money_map` (map family)
  patterns; both read-only except money_map's answer-update path
  (validation: known field names, numeric where numeric, confirm always).
- daily_brief: money minute gains one clause when a map exists and a
  stage target is unmet ("Stage 1 sits at 40% — say 'my money map' for
  the picture") — count-only, no amounts spoken in the brief.
- research_investment (existing) gains context: when a map exists, its
  skill content notes the user's stage and risk cap so research answers
  can say "this belongs in your satellite slice, which has N left".
- test/money.test.mjs: (1) curriculum data is well-formed (every lesson
  has beats + check; ids sequential); (2) school progress round-trips and
  resumes; (3) interview asks exactly the next unanswered question, one
  at a time; (4) map math from fixture answers (emergency target, slice
  caps, gap arithmetic) is exact; (5) answer updates require confirmation
  and refuse unknown fields; (6) the presented map contains the
  not-an-advisor line and never a product ticker. Add to npm test.

## Constraints

No new deps. No live-market calls inside lessons or the map (finance.js
stays the only price source, on demand). All stored data stays in
`.data/`. No background jobs. Money figures she speaks from the map are
the USER'S OWN numbers (not market claims) and need no source tag; any
market figure still goes through formatFigure.
