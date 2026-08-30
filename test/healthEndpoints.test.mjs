// The health system as the app actually exposes it: real server, real
// endpoints, real fault injection, real recovery loop.
//
// Run: node --test test/healthEndpoints.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});

function request(port, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, json: (() => { try { return JSON.parse(data); } catch (e) { return null; } })() }));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const PORT = await freePort();
// Fault injection is armed HERE and only here — the production default is off.
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "", STRIPE_SECRET_KEY: "", ARTEMIS_DEV_FAULTS: "1" },
  stdio: ["ignore", "ignore", "ignore"]
});
test.after(() => child.kill("SIGTERM"));

let up = false;
const deadline = Date.now() + 25000;
while (Date.now() < deadline && !up) {
  try { up = (await request(PORT, "/api/status")).status === 200; } catch (e) { /* booting */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}

const postJson = (path, obj) =>
  request(PORT, path, { method: "POST", body: JSON.stringify(obj), headers: { "Content-Type": "application/json" } });

test("the health endpoint answers with a real snapshot of this machine", async () => {
  assert.ok(up, "server did not boot");
  const r = await request(PORT, "/api/health");
  assert.equal(r.status, 200);
  const { snapshot, badge, reply } = r.json;

  // Every category is genuinely present and evaluated.
  for (const cat of ["voice", "ai", "runtime", "computer", "storage", "integrations", "network"]) {
    assert.ok(snapshot.subsystems[cat], `${cat} must be covered`);
  }
  assert.ok(["HEALTHY", "DEGRADED", "FAILED", "UNKNOWN", "RECOVERING"].includes(snapshot.overall));
  assert.ok(badge.label, "the UI badge is populated");
  assert.ok(reply.length > 0 && reply.length < 300, "the spoken reply stays short");
  // Real facts, not placeholders.
  assert.equal(snapshot.subsystems.runtime.components.server.status, "HEALTHY");
  assert.match(snapshot.subsystems.runtime.components.tools.summary, /\d+ tools registered/);
});

test("the startup self-check actually runs, and is fast enough to be free", async () => {
  // It is deliberately deferred a few seconds past listen() so core services
  // have settled — a check that ran first would report "not started yet" as a
  // fault. So wait for it rather than racing it.
  let startupMs = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && startupMs == null) {
    const r = await request(PORT, "/api/health");
    startupMs = r.json.startupMs;
    if (startupMs == null) await new Promise((res) => setTimeout(res, 500));
  }
  assert.ok(startupMs != null, "the startup self-check never ran");
  assert.ok(startupMs < 3000, `startup check took ${startupMs}ms — it must not be felt at launch`);

  const r = await request(PORT, "/api/health");
  assert.ok(r.json.durationMs < 3000, `quick scan took ${r.json.durationMs}ms`);
});

test("no credential, token or home path appears anywhere in the response", async () => {
  const r = await request(PORT, "/api/health?deep=1");
  const blob = r.body;
  for (const pattern of [/gsk_[A-Za-z0-9]/, /nvapi-/, /ya29\./, /sk-[A-Za-z0-9]{10}/, /\/Users\//, /Bearer /i]) {
    assert.ok(!pattern.test(blob), `${pattern} must not appear in health output`);
  }
});

test("injected faults change real health, and clearing them restores it", async () => {
  const clean = await request(PORT, "/api/health");
  const before = clean.json.snapshot.subsystems.storage.components.disk.status;

  const set = await postJson("/api/health/fault", { set: "diskCritical" });
  assert.equal(set.status, 200);
  assert.ok(set.json.faults.includes("diskCritical"));

  const broken = await request(PORT, "/api/health");
  const disk = broken.json.snapshot.subsystems.storage.components.disk;
  assert.equal(disk.status, "FAILED");
  assert.equal(disk.errorCode, "STORAGE_CRITICAL_SPACE");
  assert.match(broken.json.reply, /disk/i, "and she says so");

  await postJson("/api/health/fault", { clear: null });
  const healed = await request(PORT, "/api/health");
  assert.equal(healed.json.snapshot.subsystems.storage.components.disk.status, before);
});

test("a simulated network outage collapses into ONE reported issue", async () => {
  await postJson("/api/health/fault", { set: "network" });
  const r = await request(PORT, "/api/health");
  const snap = r.json.snapshot;

  const cloudDependents = ["ai.cloud", "integrations.gmail", "voice.sttCloud"]
    .map((id) => {
      const [cat, key] = id.split(".");
      return snap.subsystems[cat].components[key];
    })
    .filter((c) => c && c.status !== "DISABLED");

  // Whatever cloud services are configured must all point at the same root.
  for (const c of cloudDependents) {
    assert.equal(c.dependency, "network.link", `${c.label} must be attributed to the network, not counted alone`);
  }
  assert.equal(snap.issues.filter((i) => i.errorCode === "NETWORK_UNAVAILABLE").length, 1);
  assert.equal(snap.issueCount, snap.issues.length);
  assert.ok(snap.issueCount <= 2, `a single outage must not read as ${snap.issueCount} problems`);

  await postJson("/api/health/fault", { clear: null });
});

test("the client's report is what makes wake and audio knowable at all", async () => {
  // Before any report, browser-owned subsystems are honestly UNKNOWN.
  const cold = await request(PORT, "/api/health");
  assert.equal(cold.json.snapshot.subsystems.voice.components.wake.status, "UNKNOWN");

  const ok = await postJson("/api/health/report", {
    wake: { running: true, stalled: false, framesSeen: 1200, expected: true },
    audio: { contextState: "running", outputAvailable: true },
    presentationMode: "full"
  });
  assert.equal(ok.status, 204);

  const warm = await request(PORT, "/api/health");
  assert.equal(warm.json.snapshot.subsystems.voice.components.wake.status, "HEALTHY");

  // And a listener that is armed but deaf is caught, not trusted.
  await postJson("/api/health/report", {
    wake: { running: true, stalled: true, msSinceFrame: 12000, expected: true },
    audio: { contextState: "running", outputAvailable: true },
    presentationMode: "full"
  });
  const deaf = await request(PORT, "/api/health");
  const w = deaf.json.snapshot.subsystems.voice.components.wake;
  assert.equal(w.status, "FAILED");
  assert.equal(w.errorCode, "VOICE_WAKE_STALLED");
});

test("asking her in plain speech works, and works without any brain", async () => {
  // Straight through /api/chat — the deterministic tier means this answers
  // even with every provider down.
  const r = await postJson("/api/chat", { messages: [{ role: "user", content: "Artemis, run a self-check." }] });
  assert.equal(r.status, 200);
  assert.ok(r.json.reply, "she answers");
  assert.ok(r.json.health && r.json.health.label, "and the UI badge rides along");
  assert.ok(r.json.reply.length < 300, `the default answer must be concise, got: ${r.json.reply}`);
  assert.equal(r.json.toolsUsed.length, 0, "no tool call, no model round");
});

test("asking for the full diagnostic returns the detailed subsystem report", async () => {
  const r = await postJson("/api/chat", { messages: [{ role: "user", content: "Give me the full diagnostic." }] });
  assert.equal(r.status, 200);
  const reply = r.json.reply;
  for (const heading of ["VOICE", "AI", "RUNTIME", "COMPUTER", "STORAGE", "NETWORK"]) {
    assert.match(reply, new RegExp(`^${heading}$`, "m"), `the report must include ${heading}`);
  }
  assert.match(reply, /^Overall: /m);
});

test("health history is recorded and stays bounded", async () => {
  const r = await request(PORT, "/api/health/history");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.history));
  assert.ok(r.json.history.length <= 120, "the ring is capped");
  assert.ok(r.json.history.some((h) => h.kind === "transition"), "real transitions are recorded");
});
