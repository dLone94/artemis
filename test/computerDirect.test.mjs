// Deterministic computer-agent commands must not require a brain.
//
// Regression: with every Groq model decommissioned, "Open Terminal" died with
// "my brain isn't answering" — a fully deterministic local action was gated on
// cloud model availability. The registry already classified the phrase
// (family "computer", action open_terminal); the streaming endpoint just never
// had a code-owned dispatch path for it the way gym/radar/meeting do.
//
// This boots the REAL server against a fake brain that refuses every request
// and asserts:
//   1. "Open Terminal" (and launch/focus/show variants) executes computer_control
//      directly — zero brain requests, honest deterministic reply.
//   2. Presentation commands ("minimize yourself") execute set_presentation
//      directly and carry the presentation clientAction.
//   3. Tool lifecycle events (intent_pending, tool start/end) still emit.
//   4. An ambiguous computer command ("tell claude to continue") is NOT
//      auto-executed — it falls through to the (dead) brain and fails honestly.
//   5. A command genuinely requiring reasoning still needs the brain.
//   6. Offline/local-only mode still routes the deterministic tools.
//   7. Screen perception with no working brain returns the raw local read
//      instead of "my brain isn't answering".
//
// Tools are synthetic (ARTEMIS_FAKE_TOOLS=1): routing, prechecks and events are
// real; only the native macOS side effect is replaced.
//
// Run: node test/computerDirect.test.mjs
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
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-direct-"));
// Installed-app fixtures: the resolver scans THESE roots, not the real Mac.
import { mkdirSync } from "node:fs";
const APP_FIXTURES = join(DATA_DIR, "apps");
for (const app of ["WhatsApp.app", "Onyx Scribe.app", "Onyx Control.app", "System Settings.app"]) {
  mkdirSync(join(APP_FIXTURES, app), { recursive: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
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
          status: res.statusCode,
          events,
          spoken: events.filter((e) => e.ev === "token").map((e) => e.data.t).join(""),
          done: (events.find((e) => e.ev === "done") || {}).data,
          errored: events.some((e) => e.ev === "error"),
          toolEvents: events.filter((e) => e.ev === "tool").map((e) => e.data),
          intentEvent: (events.find((e) => e.ev === "intent_pending") || {}).data
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
    ARTEMIS_FAKE_TOOLS: "1",
    ARTEMIS_APP_DIRS: APP_FIXTURES,
    ARTEMIS_DISABLE_UI_AUTOMATION: "1",
    LLM_PROVIDER: "groq",
    GROQ_API_KEY: "test-key",
    GROQ_BASE_URL: brain.baseUrl,
    GROQ_CHAIN: "only-model",
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

// Every brain request is refused — the provider is completely down. retryAfter
// is long so a benched model stays benched for the whole test run.
const DEAD = Array.from({ length: 20 }, () => ({ status: 429, retryAfter: "600" }));

try {
  await waitReady(PORT);
  await brain.setScript(DEAD);

  // 1. Open Terminal — and its launch/focus/show/bring-up phrasings — never
  // needs a brain, and never turns into browser navigation or a web search.
  for (const phrase of [
    "Open Terminal.",
    "Launch the terminal",
    "Focus Terminal",
    "Show the terminal",
    "Bring up Terminal",
    "Open Terminal.app"
  ]) {
    const r = await chat(PORT, phrase);
    assert.equal(r.errored, false, `"${phrase}" must not surface a brain error`);
    assert.match(r.spoken, /terminal is open/i, `"${phrase}" reports the terminal result, got: ${r.spoken}`);
    assert.equal(r.done && r.done.model, "local-code", `"${phrase}" is answered by code, not a model`);
    assert.deepEqual(r.done && r.done.toolsUsed, ["computer_control"], `"${phrase}" used the real registry tool`);
    const actions = (r.done && r.done.clientActions) || [];
    assert.ok(!actions.some((a) => a && a.type === "open"),
      `"${phrase}" must not open a browser tab, got ` + JSON.stringify(actions));
    assert.ok(!r.toolEvents.some((t) => t.name === "open_url" || t.name === "web_search"),
      `"${phrase}" must not touch navigation or search tools`);
  }
  assert.equal((await brain.requests()).length, 0, "no brain request was made for any open-terminal phrasing");
  ok("open/launch/focus/show/bring-up Terminal execute computer_control with zero brain and zero web calls");

  // 1b. Literal terminal typing is deterministic: type-only vs type+run, no brain.
  {
    const r = await chat(PORT, "Type ai inside the Terminal.");
    assert.equal(r.errored, false, "literal typing must not need the brain");
    assert.match(r.spoken, /typed .*without running/i, "type-only reports typed-not-run: " + r.spoken);
    assert.deepEqual(r.done && r.done.toolsUsed, ["computer_control"], "typing used the registry tool");
    assert.equal(r.done && r.done.model, "local-code", "typing is answered by code");
  }
  {
    const r = await chat(PORT, "type echo hello Artemis and run it");
    assert.equal(r.errored, false, "type-and-run must not need the brain");
    assert.match(r.spoken, /ran `echo hello Artemis`/i, "the exact dictated text is executed: " + r.spoken);
  }
  assert.equal((await brain.requests()).length, 0, "no brain request for literal typing commands");
  ok("literal typing (type-only and type+run) executes deterministically with zero brain calls");

  // 1c. An approval-risk command is NOT silently executed — it raises the
  // confirm gate itself, with zero brain involvement.
  {
    const r = await chat(PORT, "type sudo ls and run it");
    assert.ok(!r.toolEvents.some((t) => t.phase === "end" && t.ok),
      "an approval-risk command must not run without a spoken yes: " + JSON.stringify(r.toolEvents));
    assert.ok(r.done && r.done.pendingAction && r.done.pendingAction.confirmId,
      "the deterministic path must raise the confirm gate, not fall into the brain: " + JSON.stringify(r.done));
    assert.equal(r.done.model, "local-code");
    ok("approval-risk typing raises a pending confirmation with zero brain calls");
  }
  assert.equal((await brain.requests()).length, 0, "approval-risk typing must not touch the brain");

  // 1d. The JSON chat endpoint shares the same deterministic computer path.
  {
    const r = await post(PORT, "/api/chat", { messages: [{ role: "user", content: "Open Terminal." }] });
    assert.equal(r.status, 200, "/api/chat open-terminal must not 503 when the brain is down");
    const body = JSON.parse(r.body);
    assert.match(body.reply || "", /terminal is open/i, "JSON chat reports the terminal result, got: " + r.body);
    assert.deepEqual(body.toolsUsed, ["computer_control"]);
    ok("/api/chat open Terminal is code-owned, same as the stream");
  }

  // 2. Lifecycle events still emit on the deterministic path.
  {
    const r = await chat(PORT, "open the terminal");
    assert.ok(r.intentEvent && r.intentEvent.family === "computer", "intent_pending announces the computer family");
    const phases = r.toolEvents.filter((t) => t.name === "computer_control").map((t) => t.phase);
    assert.deepEqual(phases, ["start", "end"], "computer_control emits start and end tool events");
    const end = r.toolEvents.find((t) => t.name === "computer_control" && t.phase === "end");
    assert.equal(end.ok, true, "the end event reports success");
    ok("intent_pending and tool start/end events still emit");
  }

  // 3. Presentation commands are deterministic and carry the client action.
  {
    const r = await chat(PORT, "Minimize yourself.");
    assert.equal(r.errored, false, "minimize must not surface a brain error");
    assert.equal(r.done && r.done.model, "local-code", "presentation is answered by code");
    const actions = (r.done && r.done.clientActions) || [];
    assert.ok(actions.some((a) => a.type === "presentation" && a.mode === "pill"),
      "minimize carries a presentation:pill client action, got " + JSON.stringify(actions));
  }
  {
    const r = await chat(PORT, "go to the background");
    assert.equal(r.errored, false, "background must not surface a brain error");
    const actions = (r.done && r.done.clientActions) || [];
    assert.ok(actions.some((a) => a.type === "presentation" && a.mode === "background"), "background maps to mode background");
  }
  {
    const r = await chat(PORT, "Show yourself");
    assert.equal(r.errored, false, "show yourself must not surface a brain error");
    const actions = (r.done && r.done.clientActions) || [];
    assert.ok(actions.some((a) => a.type === "presentation" && a.mode === "full"), "show yourself maps to mode full");
  }
  assert.equal((await brain.requests()).length, 0, "no brain request was made for any presentation command");
  ok("minimize / background / show yourself run set_presentation with zero brain calls");

  // 4. Offline/local-only mode still routes the deterministic tools.
  {
    const off = await post(PORT, "/api/offline", { offline: true });
    assert.equal(off.status, 200, "offline mode toggles on");
    const r = await chat(PORT, "open terminal");
    assert.equal(r.errored, false, "open terminal works in local-only mode with no local brain");
    assert.match(r.spoken, /terminal is open/i, "the deterministic reply survives offline mode");
    const p = await chat(PORT, "minimize yourself");
    assert.equal(p.errored, false, "presentation works in local-only mode");
    const t = await chat(PORT, "type ai and run it");
    assert.equal(t.errored, false, "terminal typing works in local-only mode");
    assert.match(t.spoken, /ran `ai`/i, "the typed command executes offline: " + t.spoken);
    const app = await chat(PORT, "open whatsapp");
    assert.equal(app.errored, false, "app launch works in local-only mode");
    assert.match(app.spoken, /whatsapp/i, "the app opens offline: " + app.spoken);
    const offMissing = await chat(PORT, "Open SomeAppThatDoesNotExist");
    assert.doesNotMatch(offMissing.spoken, /online|search/i, "offline: no web offer for a missing app");
    await post(PORT, "/api/offline", { offline: false });
    ok("local-only mode with no local brain still runs deterministic tools (apps included)");
  }

  // 4c. Generic installed-app launch: resolved from disk, launched through
  // computer_control, zero brain, zero browser, zero search. Misses are
  // honest; ambiguity asks instead of guessing.
  {
    const r = await chat(PORT, "Open WhatsApp");
    assert.equal(r.errored, false, "app launch must not need a brain: " + r.spoken);
    assert.ok(r.toolEvents.some((t) => t.name === "computer_control" && t.phase === "end" && t.ok),
      "computer_control executed: " + JSON.stringify(r.toolEvents));
    assert.match(r.spoken, /whatsapp'?s open|opened whatsapp/i, "natural launch reply: " + r.spoken);
    assert.equal(r.done && r.done.model, "local-code", "the launch is code-owned");
    assert.doesNotMatch(r.spoken, /google|search/i, "never a search");

    const settings = await chat(PORT, "open settings");
    assert.match(settings.spoken, /system settings/i, "'settings' resolves the OS alias: " + settings.spoken);

    const onyx = await chat(PORT, "open ONYX Scribe");
    assert.match(onyx.spoken, /onyx scribe/i, "third-party apps resolve generically: " + onyx.spoken);

    const missing = await chat(PORT, "Open SomeAppThatDoesNotExist");
    assert.equal(missing.errored, false, "a missing app is not an error turn");
    assert.ok(!missing.toolEvents.some((t) => t.phase === "end" && t.ok), "nothing launched for a missing app");
    assert.match(missing.spoken, /can'?t find .* installed/i, "honest not-installed reply: " + missing.spoken);
    assert.doesNotMatch(missing.spoken, /google/i, "a missing app is never silently searched");

    const ambiguous = await chat(PORT, "open onyx");
    assert.ok(!ambiguous.toolEvents.some((t) => t.phase === "end" && t.ok), "no launch on ambiguity");
    assert.match(ambiguous.spoken, /which one/i, "two credible candidates ask: " + ambiguous.spoken);
    ok("installed apps launch generically — zero brain, honest misses, ambiguity asks");
  }

  // 5. Screen perception with a dead brain returns the raw local read.
  {
    const r = await chat(PORT, "What is happening in Terminal?");
    assert.equal(r.errored, false, "a screen read must not die with the brain, got: " + r.spoken);
    assert.match(r.spoken, /151 assertions passed/, "the raw screen content reaches the user: " + r.spoken);
    assert.match(r.spoken, /reasoning model/i, "she is honest that interpretation is unavailable");
    assert.equal(r.done && r.done.model, "local-code", "the fallback is code-owned");
    ok("screen read with no working brain returns the raw local read, honestly framed");
  }

  // 6. An ambiguous computer command is NOT auto-executed on brain failure.
  // Since the contextual tier landed, "tell claude to continue" no longer dies
  // with the brain: with no visible prompt to answer, it fails SAFELY as a
  // concise clarification — still with zero tools executed and zero typing.
  {
    const r = await chat(PORT, "tell claude to continue");
    assert.ok(!r.toolEvents.some((t) => t.phase === "end" && t.ok),
      "no tool executed for the ambiguous command: " + JSON.stringify(r.toolEvents));
    if (!r.errored) {
      assert.match(r.spoken, /don't see|what should I|say it again|clarif/i,
        "without a visible prompt she asks instead of typing: " + r.spoken);
    }
    ok("ambiguous computer commands are not recklessly auto-executed");
  }

  // 6b. A question ABOUT opening Terminal is not the action: nothing executes.
  {
    const r = await chat(PORT, "Tell me how to open Terminal");
    assert.ok(!r.toolEvents.some((t) => t.name === "computer_control"),
      "an instructional question must not launch Terminal: " + JSON.stringify(r.toolEvents));
    assert.doesNotMatch(r.spoken, /terminal is open/i, "no launch is reported for a how-to question");
    ok("how-to questions about Terminal do not auto-execute");
  }

  // 7. A command genuinely requiring reasoning still falls through to the brain.
  {
    const r = await chat(PORT, "who was Charles Mingus?");
    assert.equal(r.errored, true, "a reasoning question needs the brain, and the brain is down");
    assert.equal(r.toolEvents.length, 0, "no tool was invented for a chat question");
    ok("reasoning questions still require the brain (and fail honestly when it is down)");
  }

  console.log("PASS ✅  deterministic computer-agent commands survive a total brain outage");
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
