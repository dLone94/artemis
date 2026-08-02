// Deepgram live-STT URL parameters for native PCM dictation.
// Run: node test/stt-params.test.mjs
import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Importing server.js starts its HTTP server. Give that short-lived helper
// probe an OS-selected port so it cannot collide with a running Artemis.
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

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitReady(port, child, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("test server exited before becoming ready");
    try {
      const response = await new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/api/status" }, resolve);
        req.on("error", reject);
      });
      response.resume();
      if (response.statusCode === 200) return;
    } catch (error) { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test server did not become ready");
}

function stopChild(child) {
  if (child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const hardStop = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(hardStop);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

{
  const port = await freePort();
  const probe = `
    import assert from "node:assert";
    let failed = false;
    try {
      const { deepgramLivePath } = await import(process.env.ARTEMIS_SERVER_MODULE);
      assert.equal(
        deepgramLivePath(),
        "/v1/listen?model=nova-2&interim_results=true&smart_format=true&punctuate=true",
        "absent native-audio options must preserve the browser WebM URL byte-for-byte"
      );
      assert.equal(
        deepgramLivePath({ encoding: "linear16", sampleRate: 16000, channels: 1 }),
        "/v1/listen?model=nova-2&interim_results=true&smart_format=true&punctuate=true&encoding=linear16&sample_rate=16000&channels=1",
        "native-audio options are appended using Deepgram's query names"
      );
    } catch (error) {
      failed = true;
      console.error(error && error.stack || error);
    }
    process.exit(failed ? 1 : 0);
  `;

  execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ARTEMIS_HOST: "127.0.0.1",
      ARTEMIS_HTTPS: "",
      ARTEMIS_STT_MODEL: "nova-2",
      ARTEMIS_SERVER_MODULE: pathToFileURL(join(ROOT, "server.js")).href,
      DEEPGRAM_API_KEY: "",
      STRIPE_SECRET_KEY: ""
    },
    stdio: ["ignore", "ignore", "inherit"]
  });
  console.log("  ✓ live STT URL preserves WebM defaults and appends native PCM parameters");
}

{
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "artemis-stt-params-test-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ARTEMIS_HOST: "127.0.0.1",
      ARTEMIS_HTTPS: "",
      ARTEMIS_DATA_DIR: dataDir,
      DEEPGRAM_API_KEY: "",
      STRIPE_SECRET_KEY: ""
    },
    stdio: ["ignore", "ignore", "inherit"]
  });

  try {
    await waitReady(port, child);
    const response = await request(port, "/api/stt/live/start?encoding=mp3");
    assert.equal(response.status, 400, "an unsupported live-STT encoding must be rejected");
    console.log("  ✓ live STT start rejects an unsupported encoding with 400");
  } finally {
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log("PASS ✅  live STT parameter contract holds");
