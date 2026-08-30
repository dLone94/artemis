// Presentation vs. runtime: hiding the dashboard must not silence Artemis.
//
// Regression: FULL → PILL ordered the dashboard window out, document.hidden
// went true, and the page's visibility policy tore the whole voice stack down —
// the user was left with no pill (separate TLS bug) and no way to talk to her.
// The policy now lives in public/presentationPolicy.js; this covers the policy
// matrix and, against the REAL server, that the presence bus keeps flowing to a
// pill subscriber across presentation-mode changes.
//
// Run: node test/presentationPolicy.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceSuspended } from "../public/presentationPolicy.js";

// ---- 1. the policy matrix (pure) -------------------------------------------

// Visible page: never suspended, in any mode, shell or browser.
for (const mode of ["full", "pill", "background"]) {
  for (const shell of [true, false]) {
    assert.equal(voiceSuspended(false, mode, shell), false, `visible/${mode}/shell=${shell} keeps voice`);
  }
}
// PILL in the native shell: the window is hidden BY DESIGN and the pill is the
// visible open-mic indicator — voice stays alive. This is the fixed bug.
assert.equal(voiceSuspended(true, "pill", true), false, "hidden+pill+shell keeps the voice runtime alive");
// FULL hidden (user left: another Space, minimized) — old rule holds.
assert.equal(voiceSuspended(true, "full", true), true, "hidden+full suspends voice");
// BACKGROUND: no visible surface may vouch for an open mic.
assert.equal(voiceSuspended(true, "background", true), true, "hidden+background suspends voice (pill ≠ background)");
// A plain browser has no pill window: hidden is hidden.
assert.equal(voiceSuspended(true, "pill", false), true, "a browser tab in 'pill' mode still suspends when hidden");
console.log("  ✓ policy matrix: pill keeps voice alive, background/full/browser suspend");

// ---- 2. the real presence bus survives presentation changes ----------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-presence-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf); } catch (e) { return null; } })() }));
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await req(port, "GET", "/api/presence").then((r) => r.status === 200).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
}

// A minimal SSE client: collect events from /api/presence/events like the pill.
function subscribe(port) {
  const events = [];
  let resRef = null;
  const done = new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api/presence/events", headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        resRef = res;
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = (chunk.split("\n").find((l) => l.startsWith("event:")) || "").slice(6).trim();
            const dl = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!ev || !dl) continue;
            try { events.push({ ev, data: JSON.parse(dl.slice(5).trim()) }); } catch (e) {}
          }
        });
        resolve();
      }
    );
    r.on("error", reject);
    r.end();
  });
  return { events, ready: done, close: () => { try { resRef && resRef.destroy(); } catch (e) {} } };
}
async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

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
    ARTEMIS_DISABLE_UI_AUTOMATION: "1",
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "test-key",
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
  const pill = subscribe(PORT); // the pill's view of the bus
  await pill.ready;

  // FULL → PILL: the dashboard publishes the mode; the pill subscriber sees it.
  await req(PORT, "POST", "/api/presence", { mode: "pill" });
  assert.ok(await until(() => pill.events.some((e) => e.ev === "state" && e.data.mode === "pill")),
    "the pill subscriber receives the FULL → PILL transition");
  ok("FULL → PILL reaches the pill over the live bus");

  // Voice state keeps flowing WHILE mode is pill (the dashboard window is hidden).
  await req(PORT, "POST", "/api/presence", { mode: "pill", state: "listening", listening: true, amplitude: 0.8 });
  assert.ok(await until(() => pill.events.some((e) =>
    e.ev === "state" && e.data.state === "listening" && e.data.mode === "pill" && e.data.amplitude > 0.5)),
    "listening + real amplitude reach the pill while the dashboard is hidden");
  ok("pill receives LISTENING with real amplitude in pill mode");

  await req(PORT, "POST", "/api/presence", {
    mode: "pill",
    state: "executing",
    task: "Terminal · Running tests",
    capability: "Terminal"
  });
  assert.ok(await until(() => pill.events.some((e) =>
    e.ev === "state" && e.data.state === "executing"
      && e.data.task === "Terminal · Running tests" && e.data.capability === "Terminal")),
    "executing + task/capability reach the pill");
  ok("pill receives EXECUTING with the real task and capability");

  // Presence is not reset by a mode change: the task survives PILL → FULL.
  await req(PORT, "POST", "/api/presence", { mode: "full" });
  const snap = await req(PORT, "GET", "/api/presence");
  assert.equal(snap.json.mode, "full", "mode restored to full");
  assert.equal(snap.json.state, "executing", "activity state survives the presentation change");
  assert.equal(snap.json.task, "Terminal · Running tests", "task survives the presentation change");
  ok("presence state survives presentation-mode changes");

  // The pill's restore button posts a command; the dashboard hears it on the bus.
  await req(PORT, "POST", "/api/presence/command", { command: "restore" });
  assert.ok(await until(() => pill.events.some((e) => e.ev === "command" && e.data.command === "restore")),
    "the restore command is broadcast to bus subscribers");
  ok("PILL → FULL restore command travels the bus");

  pill.close();
  console.log("PASS ✅  presentation policy: the pill is a view, never a mute button");
} catch (e) {
  failed = true;
  console.error("FAIL ❌ ", e && e.message);
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}
