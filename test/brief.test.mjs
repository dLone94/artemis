// Chief-of-Staff daily brief contract. Sources are injected so the suite never
// touches Gmail, finance providers, or the news service.
// Run: node test/brief.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-brief-test-"));
process.env.ARTEMIS_DATA_DIR = DATA_DIR;

const { assembleDailyBrief, claimDailyBriefOffer, getSkill } = await import("../skills.js");
const { classifyIntent, needsConfirmation, toolByName } = await import("../toolRegistry.js");

const NOW = new Date(2026, 6, 28, 7, 30, 0);
const figure = (value, unit, source) => ({
  value,
  unit,
  asOf: "2026-07-27",
  source,
  url: "https://source.example/figure",
  stale: false
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function request(port, { path = "/api/brief", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await request(port, { path: "/api/telemetry" })).status === 200) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

const allSources = {
  now: () => NOW,
  listUnread: async () => [
    { id: "m0", from: "billing@example.com", subject: "Invoice question" },
    { id: "m1", from: "Alice Jones <alice@example.com>", subject: "Contract review" },
    { id: "m2", from: "no-reply@example.com", subject: "Automated receipt" },
    { id: "m3", from: "Daily Digest <digest@example.com>", subject: "Headlines", listUnsubscribe: "<https://example.com/unsubscribe>" }
  ],
  readBriefReminders: async () => [
    { id: "r2", text: "Send the report", at: new Date(2026, 6, 28, 14, 0).getTime(), fired: false },
    { id: "r1", text: "Call Maya", at: new Date(2026, 6, 28, 9, 0).getTime(), fired: false },
    { id: "r3", text: "Tomorrow task", at: new Date(2026, 6, 29, 9, 0).getTime(), fired: false }
  ],
  fxRate: async () => figure(130.25, "KES per 1 USD", "Exchange Test"),
  usYieldCurve: async () => [figure(4.35, "% — US Treasury 10 Yr", "Treasury Test")],
  getNewsBriefing: async () => "Leaders meet today while markets watch the talks."
};

// 1) All sources present: four flowing sections, in the frozen order.
{
  const brief = await assembleDailyBrief(allSources);
  assert.deepEqual(brief.sections.map((section) => section.key), ["mail", "today", "money", "world"]);
  assert.equal(brief.generatedAt, NOW.toISOString());
  assert.match(brief.sections[0].spoken, /4 unread/i);
  assert.deepEqual(brief.sections[0].items.map((item) => item.id), ["m1", "m0"],
    "named personal senders are preferred; automated and List-Unsubscribe mail is excluded");
  assert.deepEqual(brief.sections[1].items.map((item) => item.id), ["r1", "r2"],
    "today's pending reminders are ordered by local time");
  assert.match(brief.sections[2].spoken, /130\.25/);
  assert.match(brief.sections[2].spoken, /Exchange Test/);
  assert.match(brief.sections[2].spoken, /2026-07-27/);
  assert.match(brief.sections[2].spoken, /4\.35/);
  assert.match(brief.sections[2].spoken, /Treasury Test/);
  assert.match(brief.sections[3].spoken, /Leaders meet today/);

  const skill = getSkill("daily_brief");
  assert.ok(skill, "daily_brief is registered");
  assert.equal(skill.requiresConfirmation, false, "daily_brief is read-only");
  const skillResult = await skill.execute({}, allSources);
  const spoken = brief.sections.map((section) => section.spoken).join(" ");
  assert.equal(skillResult.summary, spoken);
  assert.equal(skillResult.content, spoken);

  const registered = toolByName("daily_brief", {});
  assert.equal(registered.family, "briefing");
  assert.equal(registered.effect, "read");
  assert.equal(needsConfirmation("daily_brief", { tainted: true }, {}), false);
  for (const phrase of ["give me my brief", "my brief", "what's my day", "morning brief"]) {
    const intent = classifyIntent(phrase, {});
    assert.equal(intent.intent, "executable_action", `"${phrase}" executes the brief`);
    assert.equal(intent.family, "briefing");
    assert.deepEqual(intent.expected, ["daily_brief"]);
  }
  console.log("  ✓ all sources produce four ordered, sourced sections");
}

// 2) One dead source becomes one honest clause; the other sections survive.
{
  const brief = await assembleDailyBrief({
    ...allSources,
    listUnread: async () => { throw new Error("gmail offline"); }
  });
  assert.deepEqual(brief.sections.map((section) => section.key), ["mail", "today", "money", "world"]);
  assert.match(brief.sections[0].spoken, /^Mail is unreachable right now\.$/i);
  assert.doesNotMatch(brief.sections[0].spoken, /\b0\b|zero/i,
    "an unavailable inbox is not reported as empty");
  assert.match(brief.sections[1].spoken, /Call Maya/);
  assert.match(brief.sections[2].spoken, /130\.25/);
  assert.match(brief.sections[3].spoken, /Leaders meet today/);
  console.log("  ✓ one dead source yields one honest clause and leaves the rest intact");
}

// 3) A Figure without source or date is refused by formatFigure and never spoken.
{
  const invalidFigures = [
    { value: 999, unit: "KES per 1 USD", asOf: "2026-07-27", url: "https://source.example/figure", stale: false },
    { value: 888, unit: "KES per 1 USD", source: "Exchange Test", url: "https://source.example/figure", stale: false }
  ];
  for (const invalid of invalidFigures) {
    const brief = await assembleDailyBrief({ ...allSources, fxRate: async () => invalid });
    const money = brief.sections.find((section) => section.key === "money").spoken;
    assert.doesNotMatch(money, new RegExp(`\\b${invalid.value}\\b`),
      "a figure without source or date must not reach speech");
    assert.match(money, /exchange rate is unreachable right now/i);
    assert.match(money, /4\.35/, "the independently sourced Treasury figure remains intact");
    assert.match(money, /Treasury Test/);
  }
  console.log("  ✓ money figures without source or date are refused without hiding valid figures");
}

// 4) The persisted offer flips once per local date and resets on the next one.
{
  const firstMorning = new Date(2026, 6, 28, 5, 0, 0);
  assert.equal(await claimDailyBriefOffer(firstMorning), true);
  assert.equal(await claimDailyBriefOffer(new Date(2026, 6, 28, 11, 59, 59)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(DATA_DIR, "brief.json"), "utf8")),
    { lastOffered: "2026-07-28" });
  assert.equal(await claimDailyBriefOffer(new Date(2026, 6, 29, 4, 59, 59)), false,
    "before 05:00 local is outside the offer window");
  assert.equal(await claimDailyBriefOffer(new Date(2026, 6, 29, 5, 0, 0)), true,
    "the next local date becomes eligible at 05:00");
  assert.deepEqual(JSON.parse(readFileSync(join(DATA_DIR, "brief.json"), "utf8")),
    { lastOffered: "2026-07-29" });
  console.log("  ✓ the morning offer persists once per local date and resets");
}

// 5) The real endpoint exists on loopback and rejects a proxied remote request.
{
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    "globalThis.fetch = async () => { throw new Error('network disabled in brief test'); }; await import('./server.js');"
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ARTEMIS_HOST: "127.0.0.1",
      ARTEMIS_HTTPS: "",
      ARTEMIS_ACCESS_TOKEN: "brief-test-token",
      ARTEMIS_DATA_DIR: DATA_DIR,
      STRIPE_SECRET_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      GROQ_API_KEY: "",
      NVIDIA_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      TAVILY_API_KEY: "",
      BRAVE_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      DEEPGRAM_API_KEY: ""
    },
    stdio: ["ignore", "ignore", "inherit"]
  });
  try {
    await waitReady(port);
    const loopback = await request(port);
    assert.equal(loopback.status, 200, "loopback brief request should succeed without a token");
    assert.match(loopback.headers["content-type"] || "", /^application\/json/);
    assert.equal(loopback.headers["cache-control"], "no-store");
    assert.deepEqual(JSON.parse(loopback.body).sections.map((section) => section.key),
      ["mail", "today", "money", "world"]);

    const proxied = await request(port, { headers: { "x-forwarded-for": "203.0.113.7" } });
    assert.equal(proxied.status, 401, "a proxied brief request must pass the access gate");
    console.log("  ✓ /api/brief is available on loopback and remote-gated");
  } finally {
    child.kill("SIGTERM");
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

console.log("PASS ✅  brief: ordered, honest, sourced, once-daily, and loopback-gated");
