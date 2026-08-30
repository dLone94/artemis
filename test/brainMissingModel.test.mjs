// A retired model (404 model_not_found) must not kill the turn.
//
// Regression: Groq removed `llama-3.3-70b-versatile` (the chain head) and
// `llama-3.1-8b-instant` (the fallback). A 404 was not benched, so every chat
// turn died at the dead model with "my brain isn't answering" instead of
// stepping to a model that still exists. This boots the REAL server against a
// two-model fake chain where the first returns 404 model_not_found and asserts
// the user still gets the answer from the second.
//
// Run: node test/brainMissingModel.test.mjs
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
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-missing-"));

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
        res.on("end", () => resolve({
          events,
          spoken: events.filter((e) => e.ev === "token").map((e) => e.data.t).join(""),
          errored: events.some((e) => e.ev === "error")
        }));
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
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "test-key",
    GROQ_BASE_URL: brain.baseUrl,
    GROQ_CHAIN: "dead-model,live-model",
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

  // The first model has been retired; the second still exists.
  await brain.setScript([
    { status: 404, code: "model_not_found", message: "The model `dead-model` does not exist or you do not have access to it." },
    { text: "Charles Mingus was a bassist and composer." }
  ]);
  const { spoken, errored } = await chat(PORT, "who was Charles Mingus?");
  const reqs = await brain.requests();

  assert.equal(errored, false, "a retired model must not surface as a chat error");
  assert.match(spoken, /Mingus/, "the turn is answered by the model that still exists");
  ok("a 404 model_not_found is absorbed — the user still gets the answer");

  assert.equal(reqs.length, 2, "exactly two attempts: the dead model and the live one");
  assert.equal(reqs[0].model, "dead-model", "the chain starts at the (now dead) preferred model");
  assert.equal(reqs[1].model, "live-model", "and steps down to the model that still exists");
  ok("the chain self-heals past a retired model instead of dying on it");

  // Bench is durable across turns. setScript resets the fake brain's request
  // log, so this new turn's requests stand alone — and none of them may touch
  // the retired model: it was benched for the process on the first turn.
  await brain.setScript([{ text: "Still here." }]);
  await chat(PORT, "who was Duke Ellington?");
  const later = await brain.requests();
  assert.ok(later.length >= 1, "a follow-up turn actually reached the brain");
  assert.ok(later.every((r) => r.model === "live-model"),
    "the retired model is never tried again. models seen: " + JSON.stringify(later.map((r) => r.model)));
  ok("the retired model stays benched — later turns go straight to the live one");

  console.log("PASS ✅  missing-model failover: a retired model costs a beat, not the turn");
} catch (e) {
  failed = true;
  console.error("FAIL ❌ ", e && e.message);
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  await brain.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
