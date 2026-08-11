// Telemetry endpoint contract: drive the real server over HTTP and verify that
// every gauge reports measured data (or is omitted when its source fails).
// Run: node test/telemetry.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-telemetry-test-"));

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

function request(port, { path = "/api/telemetry", headers = {} } = {}) {
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
      if ((await request(port, { path: "/api/status" })).status === 200) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, "reminders.json"), JSON.stringify([{ text: "one" }, { text: "two" }]));

const PORT = await freePort();
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ARTEMIS_HOST: "127.0.0.1",
    ARTEMIS_HTTPS: "",
    ARTEMIS_ACCESS_TOKEN: "telemetry-test-token",
    STRIPE_SECRET_KEY: "",
    ARTEMIS_DATA_DIR: DATA_DIR,
    GROQ_API_KEY: "",
    NVIDIA_API_KEY: "",
    ANTHROPIC_API_KEY: ""
  },
  stdio: ["ignore", "ignore", "inherit"]
});

let failed = false;
const ok = (message) => console.log("  ✓ " + message);

try {
  await waitReady(PORT);

  const loopback = await request(PORT);
  assert.equal(loopback.status, 200, "loopback telemetry request should succeed without a token");
  assert.match(loopback.headers["content-type"] || "", /^application\/json/);
  assert.equal(loopback.headers["cache-control"], "no-store");
  const telemetry = JSON.parse(loopback.body);
  assert.ok(Number.isFinite(telemetry.cpu.load1) && telemetry.cpu.load1 >= 0);
  assert.ok(Number.isInteger(telemetry.cpu.cores) && telemetry.cpu.cores > 0);
  assert.ok(Number.isFinite(telemetry.memory.usedBytes) && telemetry.memory.usedBytes >= 0);
  assert.ok(Number.isFinite(telemetry.memory.totalBytes) && telemetry.memory.totalBytes > 0);
  assert.ok(telemetry.memory.usedBytes <= telemetry.memory.totalBytes);
  assert.equal(typeof telemetry.brain.name, "string");
  assert.equal(typeof telemetry.brain.benched, "boolean");
  assert.ok(Array.isArray(telemetry.brain.chain));

  // Which brain is answering, and when the preferred ones return. Being served
  // by a fallback used to be invisible: the only signal was a dimmed token ring,
  // and the user found out by watching her get worse at things.
  assert.equal(typeof telemetry.brain.current, "string");
  assert.ok(telemetry.brain.current.length > 0, "the answering brain is named");
  for (const entry of telemetry.brain.chain) {
    assert.equal(typeof entry.name, "string", "each chain entry names its model");
    assert.equal(typeof entry.available, "boolean");
    assert.equal(typeof entry.current, "boolean");
    // availableInSec is OMITTED when nothing is throttled — "back in 0s" and
    // "I have no idea when" are different facts, and only one may be shown.
    if (Object.hasOwn(entry, "availableInSec")) {
      assert.ok(Number.isFinite(entry.availableInSec) && entry.availableInSec > 0);
    }
  }
  assert.equal(
    telemetry.brain.chain.filter((e) => e.current).length, 1,
    "exactly one brain is current"
  );
  assert.equal(
    telemetry.brain.chain.find((e) => e.current).name, telemetry.brain.current,
    "the flagged entry and the reported current brain agree"
  );
  assert.deepEqual(telemetry.counts, { reminders: 2 });
  ok("loopback endpoint returns the documented measured shape");

  writeFileSync(join(DATA_DIR, "reminders.json"), "{not valid json");
  const failedSource = JSON.parse((await request(PORT)).body);
  assert.ok(!Object.hasOwn(failedSource.counts, "reminders"),
    "an unreadable reminders source must be omitted, not reported as zero");
  ok("a failing source is omitted instead of becoming zero");

  const proxied = await request(PORT, { headers: { "x-forwarded-for": "203.0.113.7" } });
  assert.equal(proxied.status, 401, "a proxied telemetry request must pass the access gate");
  ok("proxied telemetry request is access-gated");

  console.log("PASS ✅  telemetry: measured shape, honest omissions, and loopback gate");
} catch (error) {
  failed = true;
  console.error("FAIL ❌ ", error && error.stack ? error.stack : error);
} finally {
  child.kill("SIGTERM");
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

process.exit(failed ? 1 : 0);
