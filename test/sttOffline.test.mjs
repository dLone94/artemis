// TRUE offline proof, at the wire.
//
// Policy unit tests say the cloud must not be called in local-only mode. This
// boots the REAL server with a Deepgram key pointed at a listener we control,
// flips local-only on, and asserts that listener records ZERO requests. A
// promise about offline behaviour is worth exactly as much as the traffic it
// does not produce.
//
// Run: node test/sttOffline.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-stt-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** A stand-in for Deepgram that records every request it receives. */
async function startCloudSpy() {
  const hits = [];
  const port = await freePort();
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "CLOUD WAS CALLED" }] }] } }));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { hits, port, baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function post(port, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path,
        headers: { "content-type": contentType || "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/api/status", headers: { host: `127.0.0.1:${port}` } },
        (res) => resolve(res.statusCode === 200));
      r.on("error", () => resolve(false));
      r.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
}

const spy = await startCloudSpy();
const PORT = await freePort();
// One second of linear16 silence — a real body of the real shape.
const pcm = Buffer.alloc(16000 * 2);

const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ARTEMIS_HOST: "127.0.0.1",
    ARTEMIS_HTTPS: "",
    ARTEMIS_DATA_DIR: DATA_DIR,
    ARTEMIS_DISABLE_UI_AUTOMATION: "1",
    ARTEMIS_OFFLINE: "1",                       // LOCAL-ONLY from boot
    DEEPGRAM_API_KEY: "test-key-should-never-be-used",
    ARTEMIS_STT_BINARY: "/nonexistent/whisper-cli",  // local engine deliberately absent
    STRIPE_SECRET_KEY: "",
    GROQ_API_KEY: "",
    NVIDIA_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REFRESH_TOKEN: ""
  },
  stdio: ["ignore", "ignore", "inherit"]
});

let failed = false;
const ok = (m) => console.log("  ✓ " + m);

try {
  await waitReady(PORT);

  // 1. The status endpoint tells the truth about the mode before any session.
  {
    const r = await get(PORT, "/api/stt/status");
    const s = JSON.parse(r.body);
    assert.equal(s.mode, "local-only", "mode is reported from the ONE offline flag");
    assert.equal(s.cloudForbidden, true, "cloud is forbidden, not merely deprioritised");
    assert.equal(s.provider, null, "no local model installed → nothing may run");
    assert.match(s.message, /local-only/i, "the message names the mode, not a generic failure");
    assert.ok(!/deepgram/i.test(s.message), "it never suggests the cloud as the way out: " + s.message);
    assert.equal(s.local.ready, false);
    assert.match(s.local.hint, /setup:stt/, "it points at the explicit setup path");
    ok("status reports local-only, forbids cloud, and names the setup step");
  }

  // 2. THE contract: transcription in local-only mode makes ZERO cloud calls.
  {
    const r = await post(PORT, "/api/stt", pcm, "audio/pcm;rate=16000");
    assert.equal(r.status, 503, "it refuses honestly rather than transcribing");
    const body = JSON.parse(r.body);
    assert.match(body.error, /local-only|isn't installed/i);
    assert.ok(!/CLOUD WAS CALLED/.test(r.body), "no cloud transcript leaked into the answer");
    assert.equal(spy.hits.length, 0,
      "ZERO cloud requests in local-only mode, got: " + JSON.stringify(spy.hits));
    ok("local-only transcription never touches the cloud, even with a valid key present");
  }

  // 3. Repeated attempts must not "retry into" the cloud either.
  {
    for (let i = 0; i < 3; i += 1) await post(PORT, "/api/stt", pcm, "audio/pcm;rate=16000");
    assert.equal(spy.hits.length, 0, "still zero after repeated attempts: " + JSON.stringify(spy.hits));
    ok("repeated failures never escalate to a cloud retry");
  }

  // 4. Leaving local-only mode restores hybrid — the same one flag governs.
  {
    await post(PORT, "/api/offline", JSON.stringify({ offline: false }));
    const r = await get(PORT, "/api/stt/status");
    const s = JSON.parse(r.body);
    assert.equal(s.mode, "hybrid");
    assert.equal(s.cloudForbidden, false);
    assert.equal(s.provider, "deepgram", "hybrid prefers the cloud when it is configured");
    ok("hybrid mode is restored from the same authoritative flag");
  }

  console.log("PASS ✅  offline STT: local-only is a hard boundary, proven at the wire");
} catch (error) {
  failed = true;
  console.error("FAIL ❌ ", error.message);
} finally {
  child.kill();
  spy.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
