import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function spawnArtemis(overrides) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      STRIPE_SECRET_KEY: "",
      GROQ_API_KEY: "",
      NVIDIA_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      DEEPGRAM_API_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      ARTEMIS_DISABLE_UI_AUTOMATION: "1",
      ...overrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function requestUntilReady({ port, secure, timeoutMs = 15000 }) {
  const client = secure ? https : http;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const req = client.request({
        host: "127.0.0.1",
        port,
        path: "/api/status",
        rejectUnauthorized: false,
        headers: { host: `127.0.0.1:${port}` }
      }, (res) => { res.resume(); resolve({ connected: true, status: res.statusCode }); });
      req.on("error", () => resolve({ connected: false }));
      req.end();
    });
    if (result.connected) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { connected: false };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function exitCode(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

test("loopback mode may serve HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-loopback-"));
  const port = await freePort();
  const run = spawnArtemis({ PORT: String(port), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "", ARTEMIS_DATA_DIR: dir });
  try {
    const response = await requestUntilReady({ port, secure: false });
    assert.equal(response.connected, true, run.output());
    assert.equal(response.status, 200);
  } finally {
    await stop(run.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAN exposure with valid TLS serves HTTPS and not plaintext HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-lan-tls-"));
  const port = await freePort();
  const run = spawnArtemis({
    PORT: String(port), ARTEMIS_HOST: "0.0.0.0", ARTEMIS_HTTPS: "1",
    ARTEMIS_ACCESS_TOKEN: "transport-test-token", ARTEMIS_DATA_DIR: dir
  });
  try {
    const secure = await requestUntilReady({ port, secure: true });
    assert.equal(secure.connected, true, run.output());
    assert.equal(secure.status, 401, "LAN APIs remain authenticated over TLS");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(run.output(), /transport-test-token/, "startup output must never contain the access token");
    assert.doesNotMatch(run.output(), /[?&]key=/, "startup output must never contain a token-bearing URL");
    assert.match(run.output(), /Access token configured: yes/);
    const plain = await requestUntilReady({ port, secure: false, timeoutMs: 1000 });
    assert.equal(plain.connected, false, "the TLS listener must not answer plaintext HTTP");
  } finally {
    await stop(run.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAN exposure without TLS refuses startup", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-lan-http-"));
  const port = await freePort();
  const run = spawnArtemis({
    PORT: String(port), ARTEMIS_HOST: "0.0.0.0", ARTEMIS_HTTPS: "",
    ARTEMIS_ACCESS_TOKEN: "transport-test-token", ARTEMIS_DATA_DIR: dir
  });
  try {
    const response = await requestUntilReady({ port, secure: false, timeoutMs: 1500 });
    assert.equal(response.connected, false, "plaintext non-loopback listener must never start");
    const code = await exitCode(run.child);
    assert.notEqual(code, 0, "insecure LAN configuration must fail startup");
  } finally {
    await stop(run.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAN TLS initialization failure never downgrades to HTTP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-lan-fail-"));
  const invalidDataPath = path.join(dir, "not-a-directory");
  writeFileSync(invalidDataPath, "occupied");
  const port = await freePort();
  const run = spawnArtemis({
    PORT: String(port), ARTEMIS_HOST: "0.0.0.0", ARTEMIS_HTTPS: "1",
    ARTEMIS_ACCESS_TOKEN: "transport-test-token", ARTEMIS_DATA_DIR: invalidDataPath
  });
  try {
    const response = await requestUntilReady({ port, secure: false, timeoutMs: 1500 });
    assert.equal(response.connected, false, "TLS failure must not create a plaintext listener");
    const code = await exitCode(run.child);
    assert.notEqual(code, 0, "TLS initialization failure must fail startup");
  } finally {
    await stop(run.child);
    rmSync(dir, { recursive: true, force: true });
  }
});
