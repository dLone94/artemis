// Chain failover, end to end through the real server.
//
// Phase 1c unified three hand-rolled copies of "walk past a brain that is
// throttled or unreachable" into brainFetch(). Until now nothing tested that
// walk at all — the behaviour existed only as inline code in whichever call
// site happened to have it, which is exactly how composeBriefing ended up with
// no failover for months without anyone noticing.
//
// The test boots the REAL server against a two-model chain on a fake endpoint,
// makes the first model refuse with a 429, and asserts the user still gets an
// answer — from the second model.  Run: node test/brainFailover.test.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeBrain } from "./fakeBrain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-failover-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function chat(port, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: text }] });
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/chat/stream", headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        let buf = "";
        const events = [];
        res.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = (chunk.split("\n").find((l) => l.startsWith("event:")) || "").slice(6).trim();
            const dl = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!ev || !dl) continue;
            let data = {};
            try { data = JSON.parse(dl.slice(5).trim()); } catch (e) {}
            events.push({ ev, data });
          }
        });
        res.on("end", () => resolve({ events, spoken: events.filter((e) => e.ev === "token").map((e) => e.data.t).join("") }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/api/status", headers: { host: `127.0.0.1:${port}` } }, (res) => resolve(res.statusCode === 200));
      r.on("error", () => resolve(false));
      r.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
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
    // A two-entry Groq chain against the fake endpoint: same base URL, two
    // model names, which is exactly the real shape (Groq's free-tier limits are
    // per MODEL, so the useful fallback is a sibling model, not another host).
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "test-key",
    GROQ_BASE_URL: brain.baseUrl,
    GROQ_CHAIN: "first-model,second-model",
    OLLAMA_BRAIN_MODEL: "",
    NVIDIA_API_KEY: "",
    TAVILY_API_KEY: "",
    BRAVE_API_KEY: "",
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

  // The first model is throttled; the second answers. The user must never see
  // the 429 — they see the answer, a beat later, from the sibling model.
  await brain.setScript([
    { status: 429, retryAfter: "0.05" },
    { text: "Charles Mingus was a bassist and composer." }
  ]);
  const { spoken } = await chat(PORT, "who was Charles Mingus?");
  const reqs = await brain.requests();

  assert.match(spoken, /Mingus/, "a throttled first brain must not cost the user the turn");
  ok("a 429 from the first brain is absorbed — the user still gets the answer");

  assert.equal(reqs.length, 2, "exactly two attempts: the refusal and the failover");
  assert.equal(reqs[0].model, "first-model", "the chain starts at the preferred model");
  assert.equal(reqs[1].model, "second-model", "and steps down to the sibling on a 429");
  ok("the failover walked the chain in order, first-model → second-model");

  // The retried request is the SAME request, not a degraded one: the second
  // model must see the same conversation and the same tool offer, or a
  // failover would silently change what she is capable of mid-turn.
  assert.deepEqual(reqs[1].toolNames, reqs[0].toolNames, "the fallback brain is offered the same tools");
  assert.deepEqual(reqs[1].messages, reqs[0].messages, "the fallback brain sees the same conversation");
  assert.equal(reqs[1].stream, reqs[0].stream, "the fallback round streams exactly like the first");
  ok("the retried request is identical — failover changes the model, nothing else");

  console.log("PASS ✅  brain failover: a throttled brain costs a beat, not the turn");
} catch (e) {
  failed = true;
  console.error("FAIL ❌ ", e && e.message);
} finally {
  // Wait for the server to actually be gone before clearing its data dir —
  // killing it and deleting immediately races with its last write and turns a
  // green run into an ENOTEMPTY traceback.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  await brain.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
