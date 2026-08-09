// Money-ledger domain contract. Pure module tests use literal fixtures and
// never touch the user's persisted data.
// Run: node test/ledger.test.mjs
import assert from "node:assert";

const {
  applyLedgerChange,
  billsDueWithin,
  goalPace,
  normalizeLedger,
  suggestedActions,
  validateLedgerChange
} = await import("../moneyLedger.js");
const {
  confirmPromptFor,
  getSkill,
  precheckSkill
} = await import("../skills.js");
const {
  classifyIntent,
  needsConfirmation,
  toolByName,
  toolDefsForFamily,
  validateToolCall
} = await import("../toolRegistry.js");

function ledgerFixture(overrides = {}) {
  return {
    version: 1,
    revision: 0,
    currency: "EUR",
    entries: {
      incomes: [],
      expenses: [],
      bills: [],
      debts: [],
      goals: []
    },
    history: [],
    updatedAt: null,
    ...overrides
  };
}

function clone(value) {
  return structuredClone(value);
}

function moneyMapCurrencyStore(currency = "EUR") {
  return {
    version: 1,
    revision: 1,
    currency,
    answers: {
      contract_monthly_income: {
        raw: `five thousand ${currency}`,
        value: "5000",
        answeredAt: "2026-08-01T08:00:00.000Z"
      }
    },
    updatedAt: "2026-08-01T08:00:00.000Z"
  };
}

function memoryCtx(initial = {}, now = "2026-08-01T08:00:00.000Z") {
  const files = new Map(
    Object.entries(initial).map(([name, value]) => [name, clone(value)])
  );
  let writes = 0;
  return {
    files,
    now: () => new Date(now),
    readJson: async (name, fallback) =>
      files.has(name) ? clone(files.get(name)) : clone(fallback),
    writeJson: async (name, value) => {
      writes += 1;
      files.set(name, clone(value));
    },
    get writeCount() {
      return writes;
    }
  };
}

// 1) A ledger write cannot relabel or silently convert an amount.
{
  const result = validateLedgerChange({
    kind: "expense",
    name: "Harbor fees",
    integer_value: 40,
    currency: "USD",
    raw_answer: "I spent forty dollars on harbor fees"
  }, ledgerFixture(), "EUR");

  assert.equal(result.ok, false);
  assert.equal(result.message, "All ledger amounts must stay in EUR.");
  console.log("  ✓ ledger currency mismatches are refused without conversion");
}

// 2) V1 bills are monthly and use a deliberately safe day-of-month range.
{
  const result = validateLedgerChange({
    kind: "bill",
    name: "Rent",
    integer_value: 900,
    due_day: 29,
    raw_answer: "Rent is nine hundred on day twenty-nine"
  }, ledgerFixture(), "EUR");

  assert.equal(result.ok, false);
  assert.match(result.message, /1–28/);
  const unsupportedCadence = validateLedgerChange({
    kind: "bill",
    name: "Rent",
    integer_value: 900,
    due_day: 25,
    cadence: "weekly",
    raw_answer: "Rent is weekly"
  }, ledgerFixture(), "EUR");
  assert.deepEqual(unsupportedCadence, {
    ok: false,
    message: "Bills support monthly cadence only."
  });
  console.log("  ✓ bill validation names the supported due-day range");
}

// 3) Every supported write becomes one exact canonical entry shape. Money is
// represented only by integer digit strings after validation.
{
  const ledger = ledgerFixture();
  const changes = [
    validateLedgerChange({
      kind: "income",
      name: "Contract pay",
      integer_value: 5000,
      raw_answer: "Five thousand in contract pay"
    }, ledger, "EUR"),
    validateLedgerChange({
      kind: "expense",
      name: "Groceries",
      integer_value: 125,
      raw_answer: "One hundred twenty-five for groceries"
    }, ledger, "EUR"),
    validateLedgerChange({
      kind: "bill",
      name: "Rent",
      integer_value: 900,
      due_day: 25,
      raw_answer: "Rent is nine hundred on day twenty-five"
    }, ledger, "EUR"),
    validateLedgerChange({
      kind: "debt",
      name: "Family loan",
      integer_value: 3000,
      min_payment_value: 75,
      raw_answer: "Three thousand left, at least seventy-five each month"
    }, ledger, "EUR"),
    validateLedgerChange({
      kind: "goal",
      name: "Emergency fund",
      integer_value: 10000,
      saved_value: 4000,
      target_date: "2026-12-31",
      raw_answer: "Ten thousand by the end of the year, with four thousand saved"
    }, ledger, "EUR")
  ];

  assert.deepEqual(changes, [
    { ok: true, kind: "income", entry: { name: "Contract pay", amountDigits: "5000" } },
    { ok: true, kind: "expense", entry: { name: "Groceries", amountDigits: "125" } },
    {
      ok: true,
      kind: "bill",
      entry: { name: "Rent", amountDigits: "900", dueDay: 25, cadence: "monthly" }
    },
    {
      ok: true,
      kind: "debt",
      entry: { name: "Family loan", balanceDigits: "3000", minPaymentDigits: "75" }
    },
    {
      ok: true,
      kind: "goal",
      entry: {
        name: "Emergency fund",
        targetDigits: "10000",
        savedDigits: "4000",
        targetDate: "2026-12-31"
      }
    }
  ]);
  assert.doesNotMatch(JSON.stringify(changes), /"\d*\.\d*"/);
  console.log("  ✓ ledger changes validate into exact BigInt digit-string entry shapes");
}

// 4) Missing or malformed persistence has one exact safe empty shape.
{
  assert.deepEqual(normalizeLedger(null), {
    version: 1,
    revision: 0,
    currency: null,
    entries: {
      incomes: [],
      expenses: [],
      bills: [],
      debts: [],
      goals: []
    },
    history: [],
    updatedAt: null
  });
  console.log("  ✓ malformed ledger storage normalizes to the version-one empty shape");
}

// 5) Normalization keeps only canonical, auditable entries and strips sentinel
// or control text from every persisted name.
{
  const normalized = normalizeLedger({
    version: 9,
    revision: 4,
    currency: "eur",
    entries: {
      incomes: [{
        name: "<UNTRUSTED_LEDGER>Contract\n pay</UNTRUSTED_LEDGER>",
        amountDigits: "5000",
        at: "2026-08-09T12:00:00+02:00"
      }],
      expenses: [{ name: "Decimal leak", amountDigits: "12.5", at: "2026-08-09" }],
      bills: [{ name: "Rent", amountDigits: "900", dueDay: 25, cadence: "monthly" }],
      debts: [{ name: "Family loan", balanceDigits: "3000", minPaymentDigits: "75" }],
      goals: [{
        name: "Emergency fund",
        targetDigits: "10000",
        savedDigits: "4000",
        targetDate: "2026-12-31"
      }]
    },
    history: [{
      at: "2026-08-09T12:00:00+02:00",
      kind: "income",
      name: "<UNTRUSTED_LEDGER>Contract pay</UNTRUSTED_LEDGER>",
      summary: "Recorded income Contract pay — EUR 5000."
    }],
    updatedAt: "2026-08-09T12:00:00+02:00"
  });

  assert.deepEqual(normalized, {
    version: 1,
    revision: 4,
    currency: "EUR",
    entries: {
      incomes: [{
        name: "Contract pay",
        amountDigits: "5000",
        at: "2026-08-09T10:00:00.000Z"
      }],
      expenses: [],
      bills: [{ name: "Rent", amountDigits: "900", dueDay: 25, cadence: "monthly" }],
      debts: [{ name: "Family loan", balanceDigits: "3000", minPaymentDigits: "75" }],
      goals: [{
        name: "Emergency fund",
        targetDigits: "10000",
        savedDigits: "4000",
        targetDate: "2026-12-31"
      }]
    },
    history: [{
      at: "2026-08-09T10:00:00.000Z",
      kind: "income",
      name: "Contract pay",
      summary: "Recorded income Contract pay — EUR 5000."
    }],
    updatedAt: "2026-08-09T10:00:00.000Z"
  });
  assert.ok(normalized.history.every((event) => [...event.name].length <= 60));
  assert.doesNotMatch(JSON.stringify(normalized.entries), /"\d*\.\d*"/);
  console.log("  ✓ ledger normalization preserves only canonical sanitized audit data");
}

// 6) Applying a validated write appends one audit event, bumps the revision,
// timestamps dated entries, and leaves the caller's snapshot untouched.
{
  const before = ledgerFixture({ revision: 3 });
  const validated = validateLedgerChange({
    kind: "expense",
    name: "Harbor fees",
    integer_value: 40,
    raw_answer: "I spent forty euro on harbor fees"
  }, before, "EUR");
  const after = applyLedgerChange(before, validated, "2026-08-09T10:15:00.000Z");

  assert.deepEqual(before, ledgerFixture({ revision: 3 }), "apply is non-mutating");
  assert.deepEqual(after.entries.expenses, [{
    name: "Harbor fees",
    amountDigits: "40",
    at: "2026-08-09T10:15:00.000Z"
  }]);
  assert.equal(after.revision, 4);
  assert.equal(after.updatedAt, "2026-08-09T10:15:00.000Z");
  assert.deepEqual(after.history, [{
    at: "2026-08-09T10:15:00.000Z",
    kind: "expense",
    name: "Harbor fees",
    summary: "Recorded expense Harbor fees — EUR 40."
  }]);
  console.log("  ✓ applying a change appends history and bumps the revision exactly once");
}

// 7) Monthly due dates wrap into the next month with exact integer-day math.
{
  const ledger = ledgerFixture({
    entries: {
      incomes: [],
      expenses: [],
      bills: [
        { name: "Rent", amountDigits: "900", dueDay: 2, cadence: "monthly" },
        { name: "Later bill", amountDigits: "50", dueDay: 10, cadence: "monthly" }
      ],
      debts: [],
      goals: []
    }
  });

  assert.deepEqual(billsDueWithin(ledger, 7, "2026-01-28"), [
    { name: "Rent", amountDigits: "900", dueInDays: 5 }
  ]);
  console.log("  ✓ monthly bill windows cross month boundaries with integer day counts");
}

// 8) Goal pace uses BigInt ceil-division even beyond Number's safe range.
{
  const pace = goalPace({
    name: "Long-term reserve",
    targetDigits: "9007199254740995",
    savedDigits: "0",
    targetDate: "2026-08-29"
  }, "2026-08-01");

  assert.deepEqual(pace, {
    onPace: false,
    weeklyNeedDigits: "2251799813685249"
  });
  assert.doesNotMatch(pace.weeklyNeedDigits, /\./);
  assert.deepEqual(goalPace({
    name: "Undated reserve",
    targetDigits: "1000",
    savedDigits: "100"
  }, "2026-08-01"), { onPace: null, weeklyNeedDigits: null });
  console.log("  ✓ goal pace is exact BigInt ceil-division with no decimal money");
}

// 9) Suggestions are code-templated, currency-qualified, bill-first, and
// capped at two regardless of the caller's requested limit.
{
  const ledger = ledgerFixture({
    entries: {
      incomes: [],
      expenses: [],
      bills: [
        { name: "Utilities", amountDigits: "120", dueDay: 3, cadence: "monthly" },
        { name: "Rent", amountDigits: "900", dueDay: 2, cadence: "monthly" }
      ],
      debts: [],
      goals: [{
        name: "Emergency fund",
        targetDigits: "1000",
        savedDigits: "140",
        targetDate: "2026-08-29"
      }]
    }
  });

  assert.deepEqual(suggestedActions(ledger, "2026-08-01", 10), [
    "Rent is due in 1 days — EUR 900.",
    "Utilities is due in 2 days — EUR 120."
  ]);

  const goalOnly = ledgerFixture({
    entries: { ...ledger.entries, bills: [] }
  });
  assert.deepEqual(suggestedActions(goalOnly, "2026-08-01"), [
    "Setting aside EUR 215 this week keeps Emergency fund on pace."
  ]);
  assert.deepEqual(suggestedActions(ledgerFixture(), "2026-08-01"), []);
  console.log("  ✓ suggested actions are deterministic, bill-first, and hard-capped at two");
}

// 10) update_ledger is an always-confirmed append. Its precheck binds the
// canonical entry and revision, names the consent details, and refuses stale
// state instead of overwriting a newer ledger.
{
  const update = getSkill("update_ledger");
  assert.ok(update, "update_ledger is registered");
  assert.equal(update.requiresConfirmation, true);
  assert.equal(needsConfirmation("update_ledger", {}, {}), true);

  const noMap = memoryCtx();
  const params = {
    kind: "expense",
    name: "Harbor fees",
    integer_value: 40,
    currency: "EUR",
    raw_answer: "I spent forty euro on harbor fees"
  };
  const missingCurrency = await precheckSkill("update_ledger", { ...params }, noMap);
  assert.equal(missingCurrency.ok, false);
  assert.equal(missingCurrency.summary, "Set the Money Map planning currency first.");
  assert.equal(noMap.writeCount, 0);

  const mismatchCtx = memoryCtx({ "money-map.json": moneyMapCurrencyStore() });
  const mismatch = await precheckSkill(
    "update_ledger",
    { ...params, currency: "USD" },
    mismatchCtx
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.summary, "All ledger amounts must stay in EUR.");
  assert.equal(mismatchCtx.writeCount, 0);

  const cadence = await precheckSkill("update_ledger", {
    kind: "bill",
    name: "Marina",
    integer_value: 100,
    due_day: 10,
    cadence: "weekly",
    raw_answer: "The marina bill is weekly"
  }, mismatchCtx);
  assert.equal(cadence.ok, false);
  assert.equal(cadence.summary, "Bills support monthly cadence only.");

  const malformedCtx = memoryCtx({
    "money-map.json": moneyMapCurrencyStore(),
    "money-ledger.json": ledgerFixture({
      entries: {
        incomes: [],
        expenses: [{
          name: "Damaged entry",
          amountDigits: "12.5",
          at: "2026-07-31T08:00:00.000Z"
        }],
        bills: [],
        debts: [],
        goals: []
      }
    })
  });
  const malformed = await precheckSkill("update_ledger", { ...params }, malformedCtx);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.summary, "The money ledger is malformed, so I will not change it.");
  assert.equal(malformedCtx.writeCount, 0, "a damaged audit ledger is never normalized over");

  const ctx = memoryCtx({ "money-map.json": moneyMapCurrencyStore() });
  assert.equal((await precheckSkill("update_ledger", params, ctx)).ok, true);
  assert.equal(
    confirmPromptFor("update_ledger", params),
    "Record the expense Harbor fees, forty euro?"
  );
  assert.equal(ctx.files.has("money-ledger.json"), false, "precheck never writes");

  const recorded = await update.execute(params, ctx);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.summary, "Recorded the expense Harbor fees for EUR 40.");
  assert.match(recorded.content, /^Recorded the expense Harbor fees for EUR 40\./);
  assert.match(recorded.content, /Read this code-built ledger result exactly/);
  assert.equal(recorded.ledger.revision, 1);
  assert.deepEqual(recorded.ledger.entries.expenses, [{
    name: "Harbor fees",
    amountDigits: "40",
    at: "2026-08-01T08:00:00.000Z"
  }]);
  assert.equal(recorded.ledger.history.length, 1);
  assert.equal(ctx.writeCount, 1);

  const secondExecution = await update.execute(params, ctx);
  assert.equal(secondExecution.ok, false, "one confirmation cannot be replayed");
  assert.equal(ctx.writeCount, 1);

  const staleParams = {
    kind: "income",
    name: "Contract bonus",
    integer_value: 500,
    raw_answer: "A five hundred euro contract bonus"
  };
  assert.equal((await precheckSkill("update_ledger", staleParams, ctx)).ok, true);
  const changed = clone(ctx.files.get("money-ledger.json"));
  changed.revision += 1;
  ctx.files.set("money-ledger.json", changed);
  const stale = await update.execute(staleParams, ctx);
  assert.equal(stale.ok, false);
  assert.equal(stale.summary, "The money ledger changed before you confirmed, so nothing changed.");
  assert.equal(ctx.writeCount, 1);
  assert.equal(ctx.files.get("money-ledger.json").entries.incomes.length, 0);
  console.log("  ✓ update_ledger is named, confirm-gated, one-shot, and revision-bound");
}

// 11) money_status is a read-only code template: bills first, every dated goal
// pace line next, then at most two verbatim suggestions and no trailing prose.
{
  const status = getSkill("money_status");
  assert.ok(status, "money_status is registered");
  assert.equal(status.requiresConfirmation, false);

  const empty = await status.execute({}, memoryCtx());
  assert.equal(
    empty.summary,
    "Your money ledger is empty — tell me the first income, expense, bill, debt, or goal you want to record."
  );

  const stored = ledgerFixture({
    revision: 5,
    entries: {
      incomes: [],
      expenses: [],
      bills: [
        { name: "School fees", amountDigits: "400", dueDay: 28, cadence: "monthly" },
        { name: "Boat insurance", amountDigits: "250", dueDay: 28, cadence: "monthly" },
        { name: "Rent", amountDigits: "900", dueDay: 25, cadence: "monthly" }
      ],
      debts: [],
      goals: [
        {
          name: "Home leave",
          targetDigits: "1200",
          savedDigits: "1000",
          targetDate: "2026-08-20"
        },
        {
          name: "Emergency fund",
          targetDigits: "1860",
          savedDigits: "1000",
          targetDate: "2026-08-20"
        }
      ]
    },
    updatedAt: "2026-07-22T12:00:00.000Z"
  });
  const ctx = memoryCtx(
    { "money-ledger.json": stored },
    "2026-07-23T07:30:00.000Z"
  );
  const result = await status.execute({}, ctx);
  assert.equal(
    result.summary,
    "Bills due in the next seven days: Rent in 2 days — EUR 900; " +
      "School fees in 5 days — EUR 400; Boat insurance in 5 days — EUR 250. " +
      "Goal pace as of 2026-07-23: Home leave needs EUR 50 a week to stay on pace. " +
      "Goal pace as of 2026-07-23: Emergency fund needs EUR 215 a week to stay on pace. " +
      "Rent is due in 2 days — EUR 900. School fees is due in 5 days — EUR 400."
  );
  assert.ok(result.content.startsWith(result.summary), "the code-owned wording leads the tool result");
  assert.match(result.content, /Read this code-built money status exactly/);
  assert.match(result.content, /End after the final sentence above\.$/);
  assert.equal(ctx.writeCount, 0, "status never creates a ledger entry or reminder");
  assert.ok(result.summary.endsWith("School fees is due in 5 days — EUR 400."));
  console.log("  ✓ money_status is currency-qualified, dated, bounded, and read-only");
}

// 12) The public registry routes each mandated ledger phrase to exactly the
// relevant read or write tool without stealing Money Map/research/reminders.
{
  const expected = [
    ["I spent forty euro on harbor fees", "update_ledger"],
    ["log a bill for the marina", "update_ledger"],
    ["add a monthly bill", "update_ledger"],
    ["track a savings goal", "update_ledger"],
    ["how's my money?", "money_status"],
    ["money status", "money_status"]
  ];
  for (const [phrase, tool] of expected) {
    const intent = classifyIntent(phrase, { search: true });
    assert.equal(intent.intent, "executable_action", phrase);
    assert.equal(intent.family, "ledger", phrase);
    assert.deepEqual(intent.expected, [tool], phrase);
  }
  assert.equal(classifyIntent("show me my money map", {}).family, "map");
  assert.equal(classifyIntent("research Kenyan treasury bills", { search: true }).family, "research");
  assert.equal(classifyIntent("remind me to pay the electricity bill", {}).family, "reminder");
  assert.equal(classifyIntent("don't add a bill", {}).intent, "chat");

  const writeTool = toolByName("update_ledger", {});
  const readTool = toolByName("money_status", {});
  assert.deepEqual(
    { family: writeTool.family, effect: writeTool.effect, confirm: writeTool.confirm },
    { family: "ledger", effect: "mutation", confirm: "always" }
  );
  assert.deepEqual(
    { family: readTool.family, effect: readTool.effect, confirm: readTool.confirm },
    { family: "ledger", effect: "read", confirm: null }
  );
  assert.deepEqual(
    toolDefsForFamily({}, "ledger").map((definition) => definition.function.name),
    ["update_ledger", "money_status"]
  );
  assert.equal(validateToolCall("update_ledger", {
    kind: "expense",
    name: "Harbor fees",
    integer_value: 40
  }, {}).ok, false, "registry requires raw_answer for the audit boundary");
  console.log("  ✓ ledger phrases route to the exact read/write capability without collisions");
}
