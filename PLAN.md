# Financial Co-Pilot — Stage 2: ledger, bills in the brief, suggested weekly actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Artemis can track income, spending, recurring bills, debts, and goals in a confirm-gated append-audit ledger; the daily brief's money minute speaks bills due soon and goal pace; goal math yields at most two SUGGESTED weekly actions — spoken, never auto-created as reminders.

**Architecture:** New zero-dep `moneyLedger.js` module (BigInt digit-string money, same discipline as the Money Map) + two skills (`update_ledger` always-confirm write, `money_status` read) + a brief section extension in `skills.js` `assembleDailyBrief`. Persistence in `.data/money-ledger.json` via the existing ctx.readJson/writeJson seam so tests use memory ctx.

**Reference:** Money Map patterns in `skills.js` (validation, confirmPrompt, stale-state refusal in `update_money_map`) and `docs/superpowers/specs/2026-07-28-money-school-map-design.md` audit rules. Brief structure in `assembleDailyBrief` (~L2290).

## Global Constraints

- All money = BigInt digit strings in the Money Map's planning currency; a ledger write with a different currency is refused with a spoken message (no silent conversion, ever).
- EVERY ledger mutation is `requiresConfirmation: true` — the user said "ask before saving financial information"; the confirmation prompt names kind, name, and amount.
- Reminders are NEVER auto-created. Suggested actions are spoken sentences; creating one as a reminder happens only if the user then asks, through the normal set_reminder flow.
- Spoken summaries are code-templated (like radar findings) — the model never composes figures into prose; `formatFigure`-style "as of" phrasing for anything dated.
- No real account data, no bank connections, no credentials; the ledger stores only what the user says out loud.
- `npm test` + `npm run eval:selftest` green after every task. No eval case changes this stage (rubric stays 1.2.0; unit tests carry Stage 2).

---

### Task 1: `moneyLedger.js` module

**Files:** Create `moneyLedger.js`; Test: create `test/ledger.test.mjs` (memory-ctx pattern copied from `test/money.test.mjs`).

**Exports (exact signatures — later tasks rely on these):**
```js
normalizeLedger(stored) -> {version:1, revision, currency, entries:{incomes:[],expenses:[],bills:[],debts:[],goals:[]}, history:[], updatedAt}
validateLedgerChange(params, ledger, mapCurrency) -> {ok, message?} | {ok:true, kind, entry}
applyLedgerChange(ledger, validated, isoNow) -> new ledger   // pushes history event, bumps revision
billsDueWithin(ledger, days, today) -> [{name, amountDigits, dueInDays}]  // from dueDay + cadence, exact integer day math
goalPace(goal, today) -> {onPace: boolean|null, weeklyNeedDigits: string|null}  // null when no targetDate; BigInt ceil-division
suggestedActions(ledger, today, limit = 2) -> [string]  // code-templated sentences, hard cap 2
```
- Entry shapes: income/expense `{name, amountDigits, at}`; bill `{name, amountDigits, dueDay 1-28, cadence: "monthly"}` (v1 monthly only — reject others with a spoken message); debt `{name, balanceDigits, minPaymentDigits?}`; goal `{name, targetDigits, savedDigits, targetDate?: "YYYY-MM-DD"}`.
- `suggestedActions` sources, in priority order: bill due ≤ 7 days ("<name> is due in <n> days — <amount>."), goal behind pace ("Setting aside <weeklyNeed> this week keeps <goal> on pace."). Cap 2, deterministic order, empty array is normal.
- history events store `{at, kind, name, summary}` — no raw model text; sentinel-sanitized names ≤ 60 chars.
- [ ] Failing tests: currency mismatch refused; dueDay 29 refused with message naming 1–28; BigInt pace math exact on a crafted goal (no floats anywhere — assert no `.` in digit strings); billsDueWithin month-wrap (dueDay 2, today the 28th → ≤ 7); suggestedActions cap and order; history append + revision bump.
- [ ] Implement; tests green. Commit `feat(ledger): money ledger module`.

### Task 2: `update_ledger` + `money_status` skills

**Files:** Modify `skills.js` (two skill defs near the money_map skills; import from `./moneyLedger.js`), `toolRegistry.js` (family `"ledger"`: `update_ledger` effect mutation confirm always; `money_status` effect read; family patterns for "I spent", "log/add a bill", "track a goal", "how's my money / money status"); Test: extend `test/ledger.test.mjs` for skill-level behavior + registry routing (classifyIntent assertions like money.test.mjs's).

- `update_ledger` paramSchema: `{kind: enum[income,expense,bill,debt,goal], name, integer_value, currency?, due_day?, target_date?, saved_value?, min_payment_value?, raw_answer}` — validation delegates to `validateLedgerChange`; `confirmPrompt(params)` speaks kind + name + amount ("Record the expense harbor fees, forty euro?"). Stale-state refusal on revision mismatch, same as `update_money_map`.
- `money_status` (no params): code-templated spoken summary — bills due in the next 7 days, goal pace lines, then AT MOST two `suggestedActions` sentences verbatim, ending with nothing else. Empty ledger → one honest sentence inviting a first entry.
- The Money Map's planning currency is the ledger currency; no map currency yet → `update_ledger` refuses money kinds with "set the Money Map planning currency first" (goal without amounts still allowed? NO — keep v1 uniform: refuse until currency exists).
- [ ] Failing tests first (skill + routing), implement, green. Commit `feat(ledger): confirm-gated update_ledger and code-templated money_status`.

### Task 3: bills and goal pace join the daily brief

**Files:** Modify `skills.js` `assembleDailyBrief` (money-minute section ~L2290); Test: extend `test/brief.test.mjs` fixture style already present.

- After the existing FX/yield sentences: if the ledger has bills due ≤ 7 days → one sentence naming at most two nearest ("Money next: <bill> in <n> days<, and <bill> in <m> days>."). If any goal has pace data → one sentence for the FURTHEST-behind goal only. Then at most ONE suggestedActions sentence (the brief is calmer than money_status: cap 1 here). Ledger absent/empty → section contributes nothing (existing honest-omission style, no filler).
- [ ] Failing test: fixture ledger yields exactly the expected sentences; empty ledger leaves the brief byte-identical to today's output.
- [ ] Implement, `npm test` green, `npm run eval:selftest` 35/35. Commit `feat(brief): bills due and goal pace in the money minute`.

## Out of scope

Watchlist and research-honesty template (Stage 3); auto-created reminders (never); eval rubric changes (baseline re-mint happens after this stage lands, since the registry hash changes).
