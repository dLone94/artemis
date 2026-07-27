// Live tool-event contract: drive the real Artemis loop against the scripted
// fake brain and inspect exactly what an SSE client receives.
// Run: node test/toolevents.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeBrain } from "./fakeBrain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-tool-events-test-"));

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
    const req = http.request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
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
      if ((await request(port, "/api/status")) === 200) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start");
}

function chat(port, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: text }] });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/chat/stream",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json"
        }
      },
      (res) => {
        const events = [];
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = (frame.split("\n").find((line) => line.startsWith("event:")) || "").slice(6).trim();
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (!event || !dataLine) continue;
            events.push({ event, data: JSON.parse(dataLine.slice(5).trim()) });
          }
        });
        res.on("end", () => resolve(events));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const brain = await startFakeBrain();
const PORT = await freePort();
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    ARTEMIS_HOST: "127.0.0.1",
    ARTEMIS_HTTPS: "",
    STRIPE_SECRET_KEY: "",
    ARTEMIS_DATA_DIR: DATA_DIR,
    ARTEMIS_FAKE_TOOLS: "1",
    LLM_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "test-key",
    NVIDIA_BASE_URL: brain.baseUrl,
    GROQ_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    TAVILY_API_KEY: "",
    BRAVE_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REFRESH_TOKEN: ""
  },
  stdio: ["ignore", "ignore", "inherit"]
});

let failed = false;

try {
  await waitReady(PORT);
  await brain.setScript([
    {
      fragment: true,
      toolCalls: [
        { name: "open_url", arguments: {} }, // rejected: missing required url
        { name: "open_url", arguments: { url: "https://example.test" } },
        { name: "play_media", arguments: { query: "test track" } },
        { name: "cancel_reminder", arguments: { number: 99 } } // executes, returns ok:false
      ]
    },
    { text: "Finished the tool run.", fragment: true }
  ]);

  const events = await chat(PORT, "Show me a tool lifecycle demonstration.");
  const toolEvents = events.filter((entry) => entry.event === "tool").map((entry) => entry.data);
  assert.deepEqual(toolEvents, [
    { name: "open_url", family: "navigate", phase: "start" },
    { name: "open_url", family: "navigate", phase: "end", ok: true },
    { name: "play_media", family: "media", phase: "start" },
    { name: "play_media", family: "media", phase: "end", ok: true },
    { name: "cancel_reminder", family: "reminder", phase: "start" },
    { name: "cancel_reminder", family: "reminder", phase: "end", ok: false }
  ], "tool events must bracket only real executions, once each and in order");

  const done = events.find((entry) => entry.event === "done");
  assert.ok(done, "the streamed turn should complete");
  assert.deepEqual(done.data.toolsUsed, ["open_url", "play_media", "cancel_reminder"],
    "the rejected open_url call must not count as executed");

  console.log("  ✓ tool starts fire once per executed tool, in execution order");
  console.log("  ✓ rejected calls emit no tool event");
  console.log("  ✓ tool ends carry registry family and runtime success");
  console.log("PASS ✅  tool-events: live SSE lifecycle matches real execution");
} catch (error) {
  failed = true;
  console.error("FAIL ❌ ", error && error.stack ? error.stack : error);
} finally {
  child.kill("SIGTERM");
  await brain.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

process.exit(failed ? 1 : 0);
