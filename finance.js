// Market and macro figures, from free sources, with provenance attached.
//
// The point of this module is not that it fetches numbers — it is that a number
// cannot leave here without a source and a date stapled to it. The brain behind
// Artemis scored 15/19 on this repo's own tool-use benchmark and invents
// confident figures when it doesn't know one. So the architecture makes that
// impossible rather than asking it nicely: every value is a Figure carrying its
// origin, `formatFigure` throws on a Figure that has no source, and the model
// only ever writes prose around numbers it did not produce.
//
// Read-only by construction. Fixed host allowlist, no user-controlled URLs — the
// same rule research.js already follows, for the same reason (no SSRF surface).

import { assertNetwork } from "./networkPolicy.js";

/** Hosts this module may ever contact. Anything else is a bug, not a feature. */
export const ALLOWED_HOSTS = Object.freeze([
  "open.er-api.com",       // FX, 166 currencies, no key
  "api.worldbank.org",     // inflation, GDP, debt, reserves — no key
  "home.treasury.gov"      // US daily yield curve — the global benchmark
]);

// How old a figure may be before it must be announced as stale. These differ by
// source because the data cadence differs, and the threshold has to allow for
// each source's normal publication lag — a flag that fires on every call tells
// the user nothing. World Bank series are annual and land 12-18 months after the
// year they describe, so the newest available figure is routinely ~600 days old
// and is NOT stale; 800 days means a year is genuinely missing.
const STALE_AFTER_DAYS = { fx: 3, worldbank: 800, treasury: 7 };

const DAY_MS = 86400000;

function hostAllowed(url) {
  try { return ALLOWED_HOSTS.includes(new URL(url).host); } catch (e) { return false; }
}

/** Bounded fetch. Injectable so the test suite never touches the network. */
async function getText(url, opts = {}) {
  if (!hostAllowed(url)) throw new Error("host not on the finance allowlist: " + url);
  assertNetwork("web");
  const doFetch = opts.fetch || fetch;
  const res = await doFetch(url, {
    headers: { "User-Agent": "ArtemisBot/1.0 (+finance skill)", Accept: "application/json, text/csv, */*" },
    signal: AbortSignal.timeout(opts.timeoutMs || 12000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

function daysOld(asOf) {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / DAY_MS;
}

function makeFigure({ value, unit, asOf, source, url, kind }) {
  return {
    value,
    unit,
    asOf,
    source,
    url,
    // Computed here, not by the caller, so nobody can present an old number as
    // current by forgetting to check.
    stale: daysOld(asOf) > (STALE_AFTER_DAYS[kind] ?? 30)
  };
}

/**
 * Render a figure for a human, always with its provenance.
 *
 * Throws on a sourceless figure. That is the whole safety property of this
 * module expressed as code: if a number ever reaches the user without a source,
 * this function was bypassed, and a test asserts it cannot be.
 */
export function formatFigure(fig) {
  if (!fig || typeof fig !== "object") throw new Error("not a figure");
  if (!fig.source || !fig.url) throw new Error("figure has no source — refusing to render it");
  if (!fig.asOf) throw new Error("figure has no date — refusing to render it");
  const value = typeof fig.value === "number" ? fig.value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(fig.value);
  const unit = fig.unit ? " " + fig.unit : "";
  return `${value}${unit} (as of ${fig.asOf}, ${fig.source}${fig.stale ? " — STALE" : ""}) [${fig.url}]`;
}

/** Spot FX. Covers African currencies the ECB feed does not (KES, NGN, GHS…). */
export async function fxRate(base, quote, opts = {}) {
  const b = String(base || "").toUpperCase();
  const q = String(quote || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(b) || !/^[A-Z]{3}$/.test(q)) return null;
  const url = `https://open.er-api.com/v6/latest/${b}`;
  try {
    const data = JSON.parse(await getText(url, opts));
    const rate = data && data.rates && data.rates[q];
    if (typeof rate !== "number") return null;
    const asOf = data.time_last_update_utc
      ? new Date(data.time_last_update_utc).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    return makeFigure({
      value: rate, unit: `${q} per 1 ${b}`, asOf,
      source: "ExchangeRate-API (open endpoint)", url, kind: "fx"
    });
  } catch (e) {
    return null;   // a dead source degrades the brief; it never fabricates one
  }
}

/**
 * A World Bank indicator for a country, most recent non-null observation.
 * e.g. FP.CPI.TOTL.ZG = inflation %, NY.GDP.MKTP.KD.ZG = real GDP growth %.
 */
export async function worldBankIndicator(iso3, indicator, opts = {}) {
  const c = String(iso3 || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(c) || !/^[A-Z0-9.]+$/i.test(String(indicator || ""))) return null;
  const url = `https://api.worldbank.org/v2/country/${c}/indicator/${indicator}` +
              `?format=json&per_page=8&mrnev=1`;
  try {
    const parsed = JSON.parse(await getText(url, opts));
    const rows = Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
    const row = rows.find((r) => r && r.value != null);
    if (!row) return null;
    return makeFigure({
      value: row.value,
      unit: (row.indicator && row.indicator.value) || indicator,
      asOf: String(row.date),      // annual data: the year is the date
      source: `World Bank (${(row.country && row.country.value) || c})`,
      url, kind: "worldbank"
    });
  } catch (e) {
    return null;
  }
}

/**
 * The latest US Treasury yield curve — the benchmark everything else is priced
 * against. A Kenyan yield only means something next to the risk-free rate.
 * @returns {Array|null} one Figure per tenor, or null.
 */
export async function usYieldCurve(opts = {}) {
  const year = new Date().getUTCFullYear();
  const url = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/" +
              `daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve` +
              `&field_tdr_date_value=${year}&page&_format=csv`;
  try {
    const csv = await getText(url, opts);
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const headers = splitCsvLine(lines[0]);
    const row = splitCsvLine(lines[1]);      // most recent day is first
    const date = row[0];
    const asOf = normaliseUsDate(date);
    const out = [];
    for (let i = 1; i < headers.length; i += 1) {
      const v = Number(row[i]);
      if (!Number.isFinite(v)) continue;
      out.push(makeFigure({
        value: v, unit: `% — US Treasury ${headers[i]}`, asOf,
        source: "US Department of the Treasury", url, kind: "treasury"
      }));
    }
    return out.length ? out : null;
  } catch (e) {
    return null;
  }
}

// Minimal CSV field splitter — the Treasury file quotes headers like "1 Mo".
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of String(line)) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Treasury prints M/D/YYYY; ISO sorts and compares correctly.
function normaliseUsDate(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return String(s);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
