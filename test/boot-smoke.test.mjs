// Boot smoke + request-guard test: spawns the REAL server on an ephemeral port,
// waits until it answers, then proves the security guards added in the audit
// hold. Catches "server won't start" regressions and locks in the auth/CSRF/
// DNS-rebinding fixes.  Run: node test/boot-smoke.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ask the OS for a free port so the test never collides with a running Artemis
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// one raw HTTP request with full control over Host / Origin / X-Forwarded-For
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await request(port, { path: "/api/status" })).status === 200) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not become ready within " + ms / 1000 + "s");
}

const PORT = await freePort();
const HOST_HDR = `127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  // loopback + HTTP so no cert generation; blank Stripe key so no polling
  env: { ...process.env, PORT: String(PORT), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "", STRIPE_SECRET_KEY: "" },
  stdio: ["ignore", "ignore", "inherit"]
});

let failed = false;
try {
  await waitReady(PORT);

  // 1) it boots and /api/status returns 200 with valid JSON
  const status = await request(PORT, { path: "/api/status", headers: { host: HOST_HDR } });
  assert.equal(status.status, 200, "/api/status should be 200");
  JSON.parse(status.body); // throws if not valid JSON
  console.log("  ✓ boots; /api/status → 200 JSON");

  // 2) a plain loopback request needs NO token
  assert.equal(
    (await request(PORT, { path: "/api/status", headers: { host: HOST_HDR } })).status,
    200, "loopback request should not require a token");
  console.log("  ✓ loopback request needs no token");

  // 3) a tunneled/proxied request (X-Forwarded-For present) MUST require the token
  //    — this is the auth-bypass the audit found: gating on bind host left it open
  const fwd = await request(PORT, { path: "/api/status", headers: { host: HOST_HDR, "x-forwarded-for": "203.0.113.7" } });
  assert.equal(fwd.status, 401, "a forwarded (tunneled) request must require the token");
  console.log("  ✓ tunneled request (X-Forwarded-For) → 401");

  // 4) DNS-rebinding: an unexpected Host header is refused outright
  const badHost = await request(PORT, { path: "/api/status", headers: { host: "evil.example.com" } });
  assert.equal(badHost.status, 403, "unexpected Host must be 403");
  console.log("  ✓ unexpected Host header → 403 (DNS-rebinding guard)");

  // 5) CSRF: a cross-origin state-changing POST to /api is refused
  const csrf = await request(PORT, {
    method: "POST", path: "/api/chat",
    headers: { host: HOST_HDR, origin: "http://evil.example.com", "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(csrf.status, 403, "cross-origin POST must be 403");
  console.log("  ✓ cross-origin POST /api/chat → 403 (CSRF guard)");

  console.log("PASS ✅  boot-smoke: server boots and all request guards hold");
} catch (e) {
  failed = true;
  console.error("FAIL ❌ ", e.message);
} finally {
  child.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
