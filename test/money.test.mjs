// Money School + Money Map contract. Persistence, time, finance, and research
// boundaries are injected so this suite never touches the user's data or network.
// Run: node test/money.test.mjs
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-money-test-"));
process.env.ARTEMIS_DATA_DIR = DATA_DIR;

const { MONEY_SCHOOL_CURRICULUM } = await import("../moneySchool.js");
const {
  assembleDailyBrief,
  createPending,
  confirmPromptFor,
  dropPending,
  getPending,
  getSkill,
  precheckSkill,
  skillCtx
} = await import("../skills.js");
const {
  classifyIntent,
  needsConfirmation,
  toolByName,
  toolDefsForFamily,
  validateToolCall
} = await import("../toolRegistry.js");

const ADVISOR_LINE =
  "I'm a research assistant, not a licensed financial advisor. " +
  "This is education and planning, not a promise of returns or a recommendation to buy anything.";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function memoryCtx(initial = {}, now = "2026-07-28T12:00:00.000Z") {
  const files = new Map(Object.entries(clone(initial)));
  return {
    files,
    now: () => now,
    readJson: async (name, fallback) =>
      files.has(name) ? clone(files.get(name)) : clone(fallback),
    writeJson: async (name, value) => {
      files.set(name, clone(value));
    }
  };
}

function completeMapStore(overrides = {}) {
  const values = {
    contract_monthly_income: "5000",
    contract_months_per_year: "8",
    family_monthly_needs: "2000",
    liquid_savings: "4000",
    max_permanent_loss: "1000",
    horizon_years: "6",
    risk_comfort: "worry",
    ...overrides
  };
  return {
    version: 1,
    revision: 7,
    currency: "USD",
    answers: Object.fromEntries(
      Object.entries(values).map(([field, value]) => [
        field,
        {
          raw: `user said ${value}`,
          value,
          answeredAt: "2026-07-28T12:00:00.000Z"
        }
      ])
    ),
    updatedAt: "2026-07-28T12:00:00.000Z"
  };
}

// 1) The fixed curriculum is complete spoken teaching data, not a disguised
// product list, market feed, or promise about what the user's money will do.
{
  assert.equal(MONEY_SCHOOL_CURRICULUM.length, 12);
  assert.deepEqual(
    MONEY_SCHOOL_CURRICULUM.map((lesson) => lesson.id),
    Array.from({ length: 12 }, (_, index) => index + 1),
    "lesson ids are sequential"
  );

  const allProse = MONEY_SCHOOL_CURRICULUM
    .flatMap((lesson) => [lesson.title, ...lesson.beats, lesson.check])
    .join("\n");
  for (const lesson of MONEY_SCHOOL_CURRICULUM) {
    assert.ok(
      lesson.beats.length >= 4 && lesson.beats.length <= 6,
      `lesson ${lesson.id} has four to six beats`
    );
    assert.ok(
      lesson.beats.every(
        (beat) =>
          typeof beat === "string" &&
          beat.length >= 70 &&
          !/[\n•*_#]/.test(beat)
      ),
      `lesson ${lesson.id} beats are substantial, plain spoken prose`
    );
    assert.match(lesson.check, /\?$/, `lesson ${lesson.id} ends with one check question`);
    for (const beat of lesson.beats.filter((text) => /\d/.test(text))) {
      assert.match(
        beat,
        /suppose, purely as an example/i,
        `lesson ${lesson.id} labels every numeric example as hypothetical`
      );
    }
  }

  assert.doesNotMatch(
    allProse,
    /\b(?:NSE|JSE|MSCI|S&P|Nasdaq|Bitcoin|Apple|Vanguard|BlackRock|Robinhood|KES|NGN|USD)\b/i,
    "the curriculum names no product, issuer, platform, exchange, ticker, or hard-coded currency"
  );
  assert.doesNotMatch(
    allProse,
    /\b(?:guaranteed returns?|risk[- ]free returns?|you(?:'ll| will) earn|money will grow|will make you|current yield|as of \d{4})\b/i,
    "the curriculum contains no promised return or current market figure"
  );
  console.log("  ✓ curriculum is sequential, spoken, generic, and promise-free");
}

// 2) School progress uses the injected JSON seam, and resume/repeat/next retain
// their user-visible meaning across a fresh context backed by the same store.
{
  const school = getSkill("money_school");
  assert.ok(school, "money_school is registered");
  assert.equal(school.requiresConfirmation, false);
  const malformedCtx = memoryCtx();
  const malformed = await school.execute({ action: "resume", lesson: 2 }, malformedCtx);
  assert.equal(malformed.ok, false, "resume cannot smuggle a lesson selection");
  assert.equal(
    malformedCtx.files.has("money-school.json"),
    false,
    "a semantically malformed school call writes no progress"
  );
  const ctx = memoryCtx();

  const first = await school.execute({ action: "resume" }, ctx);
  assert.equal(first.lesson.id, 1);
  assert.match(first.content, new RegExp(ADVISOR_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((first.content.match(/\?/g) || []).length, 1, "the delivered lesson has one check question");
  assert.deepEqual(ctx.files.get("money-school.json"), { lesson: 1, completedAt: [] });

  const repeated = await school.execute({ action: "repeat" }, ctx);
  assert.equal(repeated.lesson.id, 1);
  assert.deepEqual(repeated.progress.completedAt, [], "repeat does not advance");

  const second = await school.execute({ action: "next" }, ctx);
  assert.equal(second.lesson.id, 2);
  assert.deepEqual(second.progress.completedAt, [
    { lesson: 1, at: "2026-07-28T12:00:00.000Z" }
  ]);

  const resumedCtx = memoryCtx({
    "money-school.json": ctx.files.get("money-school.json")
  });
  const resumed = await school.execute({ action: "resume" }, resumedCtx);
  assert.equal(resumed.lesson.id, 2, "progress round-trips through persisted JSON");

  for (let expected = 3; expected <= 12; expected++) {
    const lesson = await school.execute({ action: "next" }, resumedCtx);
    assert.equal(lesson.lesson.id, expected);
  }
  const finished = await school.execute({ action: "next" }, resumedCtx);
  assert.equal(finished.complete, true);
  assert.match(finished.content, /money map/i);
  assert.match(finished.content, /not a licensed financial advisor/i);
  assert.equal(finished.progress.completedAt.length, 12);
  const finishedAgain = await school.execute({ action: "next" }, resumedCtx);
  assert.equal(finishedAgain.progress.completedAt.length, 12, "completion is idempotent");
  console.log("  ✓ school progress persists, resumes, repeats, advances, and completes");
}

// 3) The interview owns one ordered question at a time, persists canonical
// first answers only, and routing cannot be stolen by broad navigate/research.
{
  const mapSkill = getSkill("money_map");
  assert.ok(mapSkill, "money_map is registered");
  assert.equal(mapSkill.requiresConfirmation, false);
  const ctx = memoryCtx();

  const opening = await mapSkill.execute({ action: "show" }, ctx);
  assert.equal(opening.nextField, "contract_monthly_income");
  assert.equal((opening.question.match(/\?/g) || []).length, 1);
  assert.match(opening.content, /not a licensed financial advisor/i);

  const missingRaw = await mapSkill.execute({
    action: "answer",
    field: "contract_monthly_income",
    integer_value: 5000,
    currency: "USD"
  }, ctx);
  assert.equal(missingRaw.ok, false, "an answer without the user's raw wording is refused");

  const incompatibleShape = await mapSkill.execute({
    action: "answer",
    field: "contract_monthly_income",
    integer_value: 5000,
    currency: "USD",
    choice: "worry",
    raw_answer: "about five thousand US dollars"
  }, ctx);
  assert.equal(incompatibleShape.ok, false, "a numeric answer cannot carry a sleep-test choice");

  const outOfOrder = await mapSkill.execute({
    action: "answer",
    field: "family_monthly_needs",
    integer_value: 2000,
    raw_answer: "two thousand"
  }, ctx);
  assert.equal(outOfOrder.ok, false);
  assert.equal(ctx.files.has("money-map.json"), false, "an out-of-order answer does not create a map");

  const answers = [
    {
      field: "contract_monthly_income",
      integer_value: 5000,
      currency: "USD",
      raw_answer: "about five thousand US dollars"
    },
    {
      field: "contract_months_per_year",
      integer_value: 8,
      raw_answer: "eight months"
    },
    {
      field: "family_monthly_needs",
      integer_value: 2000,
      raw_answer: "two thousand a month"
    },
    {
      field: "liquid_savings",
      integer_value: 4000,
      raw_answer: "four thousand accessible"
    },
    {
      field: "max_permanent_loss",
      integer_value: 1000,
      raw_answer: "one thousand at most"
    },
    {
      field: "horizon_years",
      integer_value: 6,
      raw_answer: "six years"
    },
    {
      field: "risk_comfort",
      choice: "worry",
      raw_answer: "I would worry but stay with the plan"
    }
  ];

  let result;
  for (const [index, answer] of answers.entries()) {
    result = await mapSkill.execute({ action: "answer", ...answer }, ctx);
    assert.equal(result.ok, true, `answer ${index + 1} is accepted`);
    if (index < answers.length - 1) {
      assert.equal(result.nextField, answers[index + 1].field);
      assert.equal((result.question.match(/\?/g) || []).length, 1, "exactly one next question is returned");
    }
  }
  assert.ok(result.map, "the final answer presents the completed map");

  const stored = ctx.files.get("money-map.json");
  assert.equal(stored.revision, 7);
  assert.equal(stored.currency, "USD");
  assert.equal(stored.answers.contract_monthly_income.value, "5000");
  assert.equal(stored.answers.risk_comfort.value, "worry");
  assert.equal(Object.keys(stored.answers).length, 7);

  const overwrite = await mapSkill.execute({
    action: "answer",
    field: "contract_monthly_income",
    integer_value: 6000,
    currency: "USD",
    raw_answer: "actually six thousand"
  }, ctx);
  assert.equal(overwrite.ok, false);
  assert.match(overwrite.content, /update_money_map/);
  assert.equal(ctx.files.get("money-map.json").answers.contract_monthly_income.value, "5000");

  for (const [phrase, family, expected] of [
    ["teach me investing", "school", "money_school"],
    ["show me my money map", "map", "money_map"],
    ["build my investment plan", "map", "money_map"],
    ["what's a bond?", "school", "money_school"],
    ["research Kenyan treasury bills", "research", "research_investment"]
  ]) {
    const intent = classifyIntent(phrase, { search: true });
    assert.equal(intent.family, family, phrase);
    assert.ok(intent.expected.includes(expected), phrase);
  }
  assert.notEqual(
    classifyIntent("what is a stock price today", { search: true }).family,
    "school",
    "a live-price question is not forced into the fixed curriculum"
  );
  assert.equal(classifyIntent("don't build my money map", { search: true }).intent, "chat");
  assert.equal(toolByName("money_school", {}).effect, "mutation");
  assert.equal(toolByName("money_map", {}).effect, "mutation");
  assert.deepEqual(
    toolDefsForFamily({}, "school").map((def) => def.function.name),
    ["money_school"]
  );
  console.log("  ✓ interview order, first-answer persistence, and routing are exact");
}

// 4) Every derived amount comes from stored digit strings through exact integer
// arithmetic, and the brief exposes only Stage 1 plus a whole percentage.
{
  const mapSkill = getSkill("money_map");
  const storedMap = completeMapStore();
  const ctx = memoryCtx({ "money-map.json": storedMap });
  const shown = await mapSkill.execute({ action: "show" }, ctx);
  assert.deepEqual(
    {
      annualIncome: shown.map.annualIncome,
      annualNeeds: shown.map.annualNeeds,
      headroom: shown.map.headroom,
      emergencyTarget: shown.map.emergencyTarget,
      emergencyFunded: shown.map.emergencyFunded,
      emergencyGap: shown.map.emergencyGap,
      postReservePool: shown.map.postReservePool,
      satelliteCap: shown.map.satelliteCap,
      coreTarget: shown.map.coreTarget,
      progressPercent: shown.map.progressPercent,
      currentStage: shown.map.currentStage
    },
    {
      annualIncome: "40000",
      annualNeeds: "24000",
      headroom: "16000",
      emergencyTarget: "12000",
      emergencyFunded: "4000",
      emergencyGap: "8000",
      postReservePool: "8000",
      satelliteCap: "1000",
      coreTarget: "7000",
      progressPercent: 33,
      currentStage: 1
    },
    "worked fixture literals are independent of the implementation"
  );
  assert.match(shown.content, /USD 12,000/);
  assert.match(shown.content, /USD 7,000/);
  assert.match(shown.content, /USD 1,000/);
  assert.match(shown.content, /year-one planning estimate/i);

  const figure = (value, unit) => ({
    value,
    unit,
    asOf: "2026-07-28",
    source: "Test source",
    url: "https://source.example/value",
    stale: false
  });
  const briefCtx = {
    ...ctx,
    gmailConfigured: () => false,
    listUnread: async () => [],
    readBriefReminders: async () => [],
    fxRate: async () => figure(1.25, "home units per contract unit"),
    usYieldCurve: async () => [figure(4.1, "% — US Treasury 10 Yr")],
    getNewsBriefing: async () => "A test headline."
  };
  const brief = await assembleDailyBrief(briefCtx);
  const money = brief.sections.find((section) => section.key === "money").spoken;
  assert.match(money, /Stage 1 sits at 33 percent/i);
  const stageClause = money.slice(money.indexOf("Stage 1"));
  assert.doesNotMatch(
    stageClause,
    /\b(?:USD|4000|4,000|8000|8,000|1000|1,000|12000|12,000)\b/,
    "the stage clause reveals no stored currency amount or risk cap"
  );

  const mapReadFailed = await assembleDailyBrief({
    ...briefCtx,
    readJson: async () => { throw new Error("map unreadable"); }
  });
  const degradedMoney = mapReadFailed.sections.find((section) => section.key === "money").spoken;
  assert.match(degradedMoney, /1\.25/);
  assert.match(degradedMoney, /4\.1/);
  assert.doesNotMatch(degradedMoney, /Stage 1 sits/i);

  const reserveComplete = await assembleDailyBrief({
    ...briefCtx,
    readJson: async (name, fallback) =>
      name === "money-map.json"
        ? completeMapStore({ liquid_savings: "12000" })
        : fallback
  });
  assert.doesNotMatch(
    reserveComplete.sections.find((section) => section.key === "money").spoken,
    /Stage 1 sits/i,
    "the brief omits Stage 1 once its stored target is met"
  );
  console.log("  ✓ BigInt map literals and count-only brief progress are exact and isolated");
}

// 5) Existing answers have one path: semantic precheck, named confirmation,
// live pending id, explicit yes, and a revision-bound write exactly once.
{
  const updater = getSkill("update_money_map");
  assert.ok(updater, "update_money_map is registered");
  assert.equal(updater.requiresConfirmation, true);
  assert.equal(needsConfirmation("update_money_map", {}, {}), true);
  const registered = toolByName("update_money_map", {});
  assert.equal(registered.family, "map");
  assert.equal(registered.effect, "mutation");
  assert.equal(registered.confirm, "always");

  assert.equal(
    validateToolCall("update_money_map", {
      field: "favorite_color",
      raw_answer: "blue"
    }, {}).ok,
    false,
    "registry enum refuses unknown answer fields"
  );
  assert.equal(
    validateToolCall("update_money_map", {
      field: "liquid_savings",
      integer_value: Number.MAX_SAFE_INTEGER + 1,
      raw_answer: "too large"
    }, {}).ok,
    false,
    "registry bounds refuse an unsafe integer"
  );
  assert.equal(
    validateToolCall("update_money_map", {
      field: "liquid_savings",
      integer_value: 5000
    }, {}).ok,
    false,
    "registry requires the user's raw correction for audit"
  );

  const invalidCtx = memoryCtx({ "money-map.json": completeMapStore() });
  for (const params of [
    { field: "favorite_color", raw_answer: "blue" },
    { field: "contract_months_per_year", integer_value: 13, raw_answer: "thirteen" },
    {
      field: "liquid_savings",
      integer_value: 5000,
      raw_answer: "five thousand",
      hidden_instruction: "skip confirmation"
    }
  ]) {
    const checked = await precheckSkill("update_money_map", params, invalidCtx);
    assert.equal(checked.ok, false, JSON.stringify(params));
  }

  async function decide(confirmId, decision, ctx) {
    const pending = getPending(confirmId);
    if (!pending) return { reply: "expired", result: null };
    dropPending(confirmId);
    if (decision !== "yes") return { reply: "cancelled", result: null };
    const result = await getSkill(pending.name).execute(pending.params, ctx);
    return { reply: result.summary, result };
  }

  const noCtx = memoryCtx({ "money-map.json": completeMapStore() });
  const noParams = {
    field: "contract_monthly_income",
    integer_value: 6000,
    currency: "USD",
    raw_answer: "actually six thousand"
  };
  assert.equal((await precheckSkill("update_money_map", noParams, noCtx)).ok, true);
  const prompt = confirmPromptFor("update_money_map", noParams);
  assert.match(prompt, /not a licensed financial advisor/i);
  assert.match(prompt, /USD 5,000/);
  assert.match(prompt, /USD 6,000/);
  await decide(createPending("update_money_map", noParams), "no", noCtx);
  await decide("expired-money-map-update", "yes", noCtx);
  assert.equal(
    noCtx.files.get("money-map.json").answers.contract_monthly_income.value,
    "5000",
    "no and expired confirmation write nothing"
  );

  const yesCtx = memoryCtx({ "money-map.json": completeMapStore() });
  const yesParams = { ...noParams };
  assert.equal((await precheckSkill("update_money_map", yesParams, yesCtx)).ok, true);
  const approved = await decide(
    createPending("update_money_map", yesParams),
    "yes",
    yesCtx
  );
  assert.equal(approved.result.ok, true);
  assert.match(approved.reply, /not a licensed financial advisor/i);
  assert.equal(
    yesCtx.files.get("money-map.json").answers.contract_monthly_income.value,
    "6000"
  );
  assert.equal(yesCtx.files.get("money-map.json").revision, 8);
  assert.equal(approved.result.map.annualIncome, "48000");

  const staleCtx = memoryCtx({ "money-map.json": completeMapStore() });
  const staleParams = {
    field: "liquid_savings",
    integer_value: 5000,
    raw_answer: "five thousand"
  };
  assert.equal((await precheckSkill("update_money_map", staleParams, staleCtx)).ok, true);
  const changed = clone(staleCtx.files.get("money-map.json"));
  changed.revision = 8;
  changed.answers.liquid_savings.value = "4500";
  staleCtx.files.set("money-map.json", changed);
  const stale = await decide(
    createPending("update_money_map", staleParams),
    "yes",
    staleCtx
  );
  assert.equal(stale.result.ok, false);
  assert.match(stale.reply, /changed before you confirmed/i);
  assert.equal(staleCtx.files.get("money-map.json").answers.liquid_savings.value, "4500");

  const partial = completeMapStore();
  delete partial.answers.risk_comfort;
  partial.revision = 6;
  const partialCtx = memoryCtx({ "money-map.json": partial });
  const partialParams = {
    field: "horizon_years",
    integer_value: 7,
    raw_answer: "seven years"
  };
  assert.equal((await precheckSkill("update_money_map", partialParams, partialCtx)).ok, true);
  const partialUpdate = await updater.execute(partialParams, partialCtx);
  assert.equal(partialUpdate.ok, true);
  assert.ok(
    partialUpdate.content.trim().endsWith("Nothing here moves money — it's a plan we refine."),
    "a successful update carries the canonical close even when the interview remains incomplete"
  );

  const updateIntent = classifyIntent("actually my income is six thousand", {});
  assert.equal(updateIntent.family, "map_update");
  assert.deepEqual(updateIntent.expected, ["update_money_map"]);
  assert.deepEqual(
    toolDefsForFamily({}, "map_update").map((def) => def.function.name),
    ["update_money_map"]
  );
  assert.equal(classifyIntent("don't update my money map", {}).intent, "chat");
  console.log("  ✓ update validation, no/expired/yes, and stale-state refusal hold");
}

// 6) Framing and content boundaries survive every map-facing mode, while
// investment research receives only an honest current stage and total cap.
{
  const school = getSkill("money_school");
  const mapSkill = getSkill("money_map");
  const updater = getSkill("update_money_map");
  const interview = await mapSkill.execute({ action: "show" }, memoryCtx());
  const invalid = await mapSkill.execute(
    { action: "answer", field: "not_a_field", integer_value: 1 },
    memoryCtx()
  );
  const completeCtx = memoryCtx({ "money-map.json": completeMapStore() });
  const presented = await mapSkill.execute({ action: "show" }, completeCtx);
  const lesson = await school.execute({ action: "resume" }, memoryCtx());
  const badUpdate = await precheckSkill(
    "update_money_map",
    { field: "unknown", raw_answer: "wrong" },
    completeCtx
  );
  const updateParams = {
    field: "horizon_years",
    integer_value: 7,
    raw_answer: "seven years"
  };
  assert.equal((await precheckSkill("update_money_map", updateParams, completeCtx)).ok, true);
  const updatePrompt = confirmPromptFor("update_money_map", updateParams);
  const updated = await updater.execute(updateParams, completeCtx);

  for (const [label, text] of [
    ["lesson summary", lesson.summary],
    ["lesson content", lesson.content],
    ["school conditional confirmation", confirmPromptFor("money_school", { action: "next" })],
    ["interview summary", interview.summary],
    ["interview content", interview.content],
    ["map conditional confirmation", confirmPromptFor("money_map", { action: "show" })],
    ["invalid summary", invalid.summary],
    ["invalid content", invalid.content],
    ["presented summary", presented.summary],
    ["presented content", presented.content],
    ["invalid update summary", badUpdate.summary],
    ["invalid update content", badUpdate.content],
    ["update confirmation", updatePrompt],
    ["updated summary", updated.summary],
    ["updated content", updated.content]
  ]) {
    assert.match(text, /I'm a research assistant, not a licensed financial advisor/i, label);
  }
  assert.ok(
    presented.content.trim().endsWith("Nothing here moves money — it's a plan we refine."),
    "the presented map carries the canonical close"
  );
  assert.ok(
    updated.content.trim().endsWith("Nothing here moves money — it's a plan we refine."),
    "the updated map carries the canonical close"
  );
  for (const text of [presented.content, updated.content]) {
    assert.doesNotMatch(
      text,
      /\b(?:NSE|JSE|MSCI|S&P|Nasdaq|Bitcoin|Apple|Vanguard|BlackRock|Robinhood)\b/i
    );
    assert.doesNotMatch(
      text,
      /\b(?:guaranteed return|risk-free return|you(?:'ll| will) earn|money will grow|assured income)\b/i
    );
  }

  const research = getSkill("research_investment");
  const marketFigure = (value, unit) => ({
    value,
    unit,
    asOf: "2026-07-28",
    source: "Test source",
    url: "https://source.example/value",
    stale: false
  });
  const researchResult = await research.execute(
    { topic: "African listed shares" },
    {
      ...memoryCtx({ "money-map.json": completeMapStore() }),
      fxRate: async () => null,
      worldBankIndicator: async () => null,
      usYieldCurve: async () => [marketFigure(4.1, "% — US Treasury 10 Yr")],
      webSearch: async () => ({ results: [] })
    }
  );
  assert.match(researchResult.content, /PERSONAL MONEY MAP CONTEXT/);
  assert.match(researchResult.content, /Current stage: Stage 1/);
  assert.match(researchResult.content, /stored total permanent-loss cap is USD 1,000/i);
  assert.match(researchResult.content, /not an amount Artemis recommends investing/i);
  const researchPolicy = researchResult.content.slice(
    researchResult.content.indexOf("</UNTRUSTED_RESEARCH_CONTENT>")
  );
  assert.match(
    researchPolicy,
    /never (?:repeat|speak)[^.]*market number[^.]*source text/i,
    "research may speak market figures only from the formatFigure-rendered verified list"
  );
  assert.doesNotMatch(
    researchPolicy,
    /\b8\.8\b/,
    "the fixed research prompt contains no hard-coded market example"
  );
  const contextStart = researchResult.content.indexOf("PERSONAL MONEY MAP CONTEXT");
  const contextEnd = researchResult.content.indexOf("END PERSONAL MONEY MAP CONTEXT");
  const researchContext = researchResult.content.slice(contextStart, contextEnd);
  assert.doesNotMatch(researchContext, /\b(?:left|remaining)\b/i);
  const untrustedStart = researchResult.content.indexOf("<UNTRUSTED_RESEARCH_CONTENT>");
  const untrustedEnd = researchResult.content.indexOf("</UNTRUSTED_RESEARCH_CONTENT>");
  assert.ok(
    contextEnd < untrustedStart || contextStart > untrustedEnd,
    "personal map context stays outside fetched, untrusted research text"
  );

  await skillCtx.writeJson("money-map.json", completeMapStore());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => ""
  });
  try {
    const defaultContextResearch = await research.execute({ topic: "generic asset class" });
    assert.match(
      defaultContextResearch.content,
      /PERSONAL MONEY MAP CONTEXT/,
      "the production research context reads the stored map without test-only injection"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("  ✓ advisor, no-product/no-promise, and honest research-context boundaries hold");
}

rmSync(DATA_DIR, { recursive: true, force: true });
console.log("PASS ✅  money: school, map, exact arithmetic, confirmation, and integrations hold");
