// Regression: a recoverable precheck failure must CONTINUE the turn, not end it.
//
// Field bug (2026-07-28): "check my emails and delete them" → the model called
// delete_email before any listing existed, the precheck failed, and the turn
// finished right there — she spoke "I'll check first" while nothing happened.
// The fix hands the model the precheck's instruction as a tool result and lets
// the loop run another round (once per turn).
//
// Run: node test/precheck-recovery.test.mjs
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
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-precheck-recovery-test-"));

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
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let buf = "";
        const events = [];
        res.on("data", (chunk) => {
          buf += chunk;
          let index;
          while ((index = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, index);
            buf = buf.slice(index + 2);
            const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
            const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
            if (!eventLine || !dataLine) continue;
            try {
              events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
            } catch (e) {}
          }
        });
        res.on("end", () => resolve(events));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const PORT = await freePort();
const brain = await startFakeBrain();

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
    // dummy Gmail creds: makes the email family AVAILABLE while
    // ARTEMIS_FAKE_TOOLS keeps every execution synthetic and offline
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh"
  },
  stdio: ["ignore", "ignore", "inherit"]
});

let failed = false;

try {
  await waitReady(PORT);

  // Round 1: the model jumps straight to delete_email with no listing —
  // exactly what the field log showed. The precheck must fail, and the loop
  // must CONTINUE with the instruction, not finish the turn.
  // Round 2+: the model obeys and checks; the script then just talks.
  await brain.setScript([
    { toolCalls: [{ name: "delete_email", arguments: { numbers: [1, 2] } }] },
    { toolCalls: [{ name: "check_email", arguments: {} }] },
    { text: "Here is what I found." },
    { text: "(spare round)" }
  ]);

  const events = await chat(PORT, "check my emails and delete them");
  assert.ok(events.find((entry) => entry.event === "done"), "the turn should complete");

  const requests = await brain.requests();
  assert.ok(
    requests.length >= 2,
    `the turn must continue past the precheck failure (saw ${requests.length} brain round(s))`
  );

  const followUp = requests[1];
  const toolMsg = followUp.messages.find(
    (message) => message.role === "tool" && /call check_email now/i.test(String(message.content))
  );
  assert.ok(
    toolMsg,
    "round 2 must carry the precheck's model-directed instruction as a tool result"
  );

  const assistantWithCall = followUp.messages.find(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length
  );
  assert.ok(assistantWithCall, "the rejected call itself must appear in the transcript the model sees");

  console.log("  ✓ a failed precheck hands the model its instruction and the turn continues");
  console.log("  ✓ the second round sees both the rejected call and the recovery instruction");

  // Mixed round: the model emits check_email AND delete_email together.
  // The reads must actually run before the confirm gate is raised — otherwise
  // we confirm against a stale listing (or confirm nothing, because there is
  // no listing yet).
  {
    await brain.setScript([
      {
        toolCalls: [
          { name: "check_email", arguments: { max: 10 } },
          { name: "delete_email", arguments: { numbers: [1, 2, 3] } }
        ]
      },
      { text: "Here is what I found." },
      { text: "(spare round)" }
    ]);
    const events = await chat(PORT, "check my emails and delete them");
    const done = events.find((entry) => entry.event === "done");
    assert.ok(done, "the mixed turn should complete");
    const tools = (done.data && done.data.toolsUsed) || [];
    assert.ok(
      tools.includes("check_email"),
      `mixed batch must run the read before asking to confirm (toolsUsed=${JSON.stringify(tools)})`
    );
    console.log("  ✓ a mixed read+delete round runs check_email before the confirm gate");
  }

  console.log("PASS ✅  precheck-recovery: a recoverable precondition keeps the turn alive");
} catch (error) {
  failed = true;
  console.error("FAIL ❌ ", error && error.stack ? error.stack : error);
} finally {
  child.kill("SIGTERM");
  await brain.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

process.exit(failed ? 1 : 0);
