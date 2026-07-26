// Tests for the investment research path.
//
// One property matters more than all the others here: a number must never reach
// the user without a source and a date. The brain scored 15/19 on this repo's
// own benchmark and invents figures confidently, so that rule is enforced in
// code rather than asked for in a prompt — and these tests are what keep it
// enforced.  Run: node test/finance.test.mjs
import assert from "node:assert";
import { fxRate, worldBankIndicator, usYieldCurve, formatFigure, ALLOWED_HOSTS } from "../finance.js";
import { getSkill } from "../skills.js";
import { UNTRUSTED_SKILLS } from "../untrusted.js";

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// A fetch stand-in: never touches the network, so the suite is deterministic.
const stubFetch = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 503, text: async () => body });

// ---- the sourcing rule ------------------------------------------------------
{
  const good = { value: 129.4, unit: "KES per 1 USD", asOf: today(), source: "ExchangeRate-API", url: "https://open.er-api.com/x", stale: false };
  assert.match(formatFigure(good), /129\.4/);
  assert.match(formatFigure(good), /as of/, "always carries its date");
  assert.match(formatFigure(good), /ExchangeRate-API/, "always names its source");
  assert.match(formatFigure(good), /open\.er-api\.com/, "always carries the URL");

  // These are the assertions the whole design exists for.
  assert.throws(() => formatFigure({ ...good, source: null }), /no source/i, "a sourceless figure must not render");
  assert.throws(() => formatFigure({ ...good, url: null }), /no source/i, "a figure with no URL must not render");
  assert.throws(() => formatFigure({ ...good, asOf: null }), /no date/i, "an undated figure must not render");
  assert.throws(() => formatFigure(null), /not a figure/i);
  assert.throws(() => formatFigure("129.4"), /not a figure/i, "a bare number can never be rendered");

  assert.match(formatFigure({ ...good, stale: true }), /STALE/, "stale figures are labelled, not silently passed off as current");
  console.log("  ✓ a number cannot be rendered without a source and a date");
}

// ---- staleness thresholds respect each source's publication lag -------------
{
  const fxBody = (d) => JSON.stringify({ rates: { KES: 129.4 }, time_last_update_utc: new Date(d).toUTCString() });
  const fresh = await fxRate("USD", "KES", { fetch: stubFetch(fxBody(daysAgo(1))) });
  assert.equal(fresh.stale, false, "yesterday's FX is current");
  const old = await fxRate("USD", "KES", { fetch: stubFetch(fxBody(daysAgo(5))) });
  assert.equal(old.stale, true, "five-day-old FX is stale");

  // World Bank data is annual and lands 12-18 months late; the newest available
  // figure is routinely ~600 days old and must NOT be flagged, or the flag is noise.
  const wbBody = (year) => JSON.stringify([{ page: 1 }, [{ value: 4.07, date: String(year), indicator: { value: "Inflation" }, country: { value: "Kenya" } }]]);
  const lastYear = new Date().getUTCFullYear() - 1;
  const recentWb = await worldBankIndicator("KEN", "FP.CPI.TOTL.ZG", { fetch: stubFetch(wbBody(lastYear)) });
  assert.equal(recentWb.stale, false, "the newest annual figure is not stale");
  const ancientWb = await worldBankIndicator("KEN", "FP.CPI.TOTL.ZG", { fetch: stubFetch(wbBody(lastYear - 3)) });
  assert.equal(ancientWb.stale, true, "a figure three years behind is stale");
  console.log("  ✓ staleness thresholds match each source's real publication lag");
}

// ---- parsing real response shapes -------------------------------------------
{
  const fx = await fxRate("USD", "NGN", {
    fetch: stubFetch(JSON.stringify({ rates: { NGN: 1364.49 }, time_last_update_utc: new Date().toUTCString() }))
  });
  assert.equal(fx.value, 1364.49);
  assert.match(fx.unit, /NGN per 1 USD/);

  const wb = await worldBankIndicator("NGA", "NY.GDP.MKTP.KD.ZG", {
    fetch: stubFetch(JSON.stringify([{ page: 1 }, [
      { value: null, date: "2026" },                                                  // nulls skipped
      { value: 4.01, date: "2025", indicator: { value: "GDP growth (annual %)" }, country: { value: "Nigeria" } }
    ]]))
  });
  assert.equal(wb.value, 4.01, "takes the most recent non-null observation");
  assert.match(wb.source, /Nigeria/);

  const csv = 'Date,"1 Mo","3 Mo","10 Yr"\n07/24/2026,4.10,3.96,4.35\n07/23/2026,4.11,3.97,4.36';
  const curve = await usYieldCurve({ fetch: stubFetch(csv) });
  assert.equal(curve.length, 3, "one figure per tenor");
  assert.equal(curve[0].asOf, "2026-07-24", "US M/D/Y normalised to ISO");
  assert.ok(curve.some((f) => /10 Yr/.test(f.unit) && f.value === 4.35), "quoted headers parsed");
  console.log("  ✓ each source's real response shape parses correctly");
}

// ---- a dead source degrades, never fabricates -------------------------------
{
  assert.equal(await fxRate("USD", "KES", { fetch: stubFetch("", false) }), null, "HTTP error yields null");
  assert.equal(await fxRate("USD", "KES", { fetch: async () => { throw new Error("network down"); } }), null, "a throw yields null");
  assert.equal(await worldBankIndicator("KEN", "FP.CPI.TOTL.ZG", { fetch: stubFetch("not json") }), null);
  assert.equal(await usYieldCurve({ fetch: stubFetch("") }), null);
  assert.equal(await fxRate("USD", "KES", { fetch: stubFetch(JSON.stringify({ rates: {} })) }), null, "missing currency is null, never 0");
  assert.equal(await fxRate("BADCODE", "KES", {}), null, "a malformed code never reaches the network");
  console.log("  ✓ a dead source yields null — never a zero, never an invented number");
}

// ---- the host allowlist -----------------------------------------------------
{
  assert.ok(ALLOWED_HOSTS.includes("open.er-api.com") && ALLOWED_HOSTS.includes("api.worldbank.org"));
  assert.ok(!ALLOWED_HOSTS.includes("evil.example"), "the allowlist is a closed set");
  assert.ok(Object.isFrozen(ALLOWED_HOSTS), "and cannot be extended at runtime");
  console.log("  ✓ only allowlisted hosts are reachable");
}

// ---- the skill --------------------------------------------------------------
{
  const skill = getSkill("research_investment");
  assert.ok(skill, "the skill is registered");
  assert.equal(skill.requiresConfirmation, false, "research is read-only, so it needs no spoken yes");
  assert.ok(UNTRUSTED_SKILLS.has("research_investment"),
    "fetched articles are attacker-controlled — the turn must be tainted");

  const fig = (v, u) => ({ value: v, unit: u, asOf: today(), source: "Test Source", url: "https://open.er-api.com/x", stale: false });
  const ctx = (over = {}) => ({
    fxRate: async () => fig(129.4, "KES per 1 USD"),
    worldBankIndicator: async () => fig(4.07, "Inflation, consumer prices (annual %)"),
    usYieldCurve: async () => [fig(4.35, "% — US Treasury 10 Yr")],
    webSearch: async (q) => ({
      results: /risk|criticism|avoid/i.test(q)
        ? [{ title: "Why this is risky", url: "https://example.test/bear", content: "currency risk is severe" }]
        : [{ title: "Overview", url: "https://example.test/bull", content: "yields are high" }]
    }),
    ...over
  });

  const r = await skill.execute({ topic: "Kenyan treasury bills", country: "KEN", currency: "KES" }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /129\.4/, "the figure is present");
  assert.match(r.content, /Test Source/, "with its source");
  assert.match(r.content, /only numbers you may state as fact/i, "verified figures are the only statable facts");
  assert.match(r.content, /UNTRUSTED_RESEARCH_CONTENT/, "fetched text is sentinel-wrapped");
  assert.match(r.content, /THE CASE AGAINST/, "the bear case is a required section, not an afterthought");
  assert.match(r.content, /structural case rather than a timing one/i, "no dated catalyst means no manufactured urgency");
  assert.match(r.content, /research, not advice/i, "the boundary is stated");
  for (const section of [/HOW IT WORKS/, /WHY NOW/, /RISKS/, /COSTS/, /HORIZON/, /BEST AND WORST CASE/]) {
    assert.match(r.content, section, `brief requires section ${section}`);
  }
  assert.ok(r.sources.some((s) => /bear/.test(s.url)), "the against-case sources are surfaced too");

  // a separate query really is issued for the bear case
  const queries = [];
  await skill.execute({ topic: "X", country: "KEN", currency: "KES" },
    ctx({ webSearch: async (q) => { queries.push(q); return { results: [] }; } }));
  assert.equal(queries.length, 2, "two searches: the case for and the case against");
  assert.ok(queries.some((q) => /risk|avoid|criticism/i.test(q)), "one of them hunts for the bear case");

  // sources down: says so, does not invent, does not call it zero
  const dead = await skill.execute({ topic: "Kenyan treasury bills", country: "KEN", currency: "KES" },
    ctx({ fxRate: async () => null, worldBankIndicator: async () => null, usYieldCurve: async () => null }));
  assert.equal(dead.ok, true, "a brief is still produced");
  assert.match(dead.content, /UNAVAILABLE/, "missing figures are declared");
  assert.match(dead.content, /never call it zero/i);
  assert.doesNotMatch(dead.summary, /\b0\b/, "the spoken summary never reports a missing figure as zero");

  // stale figures are announced in speech, not just buried in the brief
  const staleCtx = ctx({ fxRate: async () => ({ ...fig(129.4, "KES per 1 USD"), stale: true }) });
  const stale = await skill.execute({ topic: "T-bills", country: "KEN", currency: "KES" }, staleCtx);
  assert.match(stale.summary, /older than I'd like/i, "staleness reaches the spoken summary");
  assert.match(stale.content, /STALE/);

  const empty = await skill.execute({ topic: "  " }, ctx());
  assert.equal(empty.ok, false, "an empty topic asks rather than guesses");
  console.log("  ✓ the brief is sourced, balanced, honest about gaps, and never invents");
}

console.log("PASS ✅  finance: every number carries a source, or it is not said");

// ---- unverified numbers must carry their provenance -------------------------
// Found in live testing: she quoted "the 91-day bill is yielding around 8.8%"
// with the same confidence as World Bank data. That figure came from a scraped
// article, not from a data provider. A blanket ban failed because the number was
// sitting in the source text; requiring attribution is what actually holds.
{
  const skill = getSkill("research_investment");
  const fig = (v, u) => ({ value: v, unit: u, asOf: today(), source: "Test Source", url: "https://open.er-api.com/x", stale: false });
  const r = await skill.execute({ topic: "Kenyan treasury bills", country: "KEN", currency: "KES" }, {
    fxRate: async () => fig(129.4, "KES per 1 USD"),
    worldBankIndicator: async () => fig(4.07, "Inflation (annual %)"),
    usYieldCurve: async () => [fig(4.69, "% — US Treasury 10 Yr")],
    webSearch: async () => ({ results: [{ title: "Auction", url: "https://example.test/a", content: "91-day yields were approximately 8.7986%" }] })
  });
  assert.match(r.content, /NOT VERIFIED/, "source numbers are marked unverified");
  assert.match(r.content, /where it came from/i, "attribution is required, not silence");
  assert.match(r.content, /cannot confirm how current/i, "and the date caveat is required");
  assert.match(r.content, /NEVER in the verified list/i, "local instrument yields are named as always-unverified");
  assert.match(r.content, /only numbers you may state as fact/i, "verified figures keep their privileged status");
  console.log("  ✓ a number scraped from an article must be attributed, never spoken bare");
}
