// The regression suite for "she says she's doing it and then doesn't".
//
// This drives the REAL Artemis server — real SSE parsing, real registry, real
// tool execution, real repair rounds — against a scripted fake brain. Every case
// below is a way the old code could tell the user something happened when it
// hadn't.  Run: node test/reliability.test.mjs
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
const DATA_DIR = mkdtempSync(join(tmpdir(), "artemis-test-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** POST a turn and collect the SSE events the client would have seen. */
function chat(port, text, { abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ messages: [{ role: "user", content: text }] });
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/chat/stream", headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } },
      (res) => {
        const events = [];
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
            let data = {};
            try { data = JSON.parse(dl.slice(5).trim()); } catch (e) {}
            events.push({ ev, data });
          }
        });
        res.on("end", () => resolve({ events, spoken: events.filter((e) => e.ev === "token").map((e) => e.data.t).join("") }));
      }
    );
    // A destroyed request may emit 'error', 'close', or neither in time —
    // resolve on whichever arrives so an aborted turn can't hang the suite.
    const bail = () => resolve({ events: [], spoken: "", aborted: true });
    req.on("error", (e) => (abortAfterMs ? bail() : reject(e)));
    req.on("close", () => { if (abortAfterMs) bail(); });
    req.write(payload);
    req.end();
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
  });
}

async function waitReady(port, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const r = http.request({ host: "127.0.0.1", port, path: "/api/status", headers: { host: `127.0.0.1:${port}` } }, (res) => resolve(res.statusCode === 200));
        r.on("error", () => resolve(false));
        r.end();
      });
      if (ok) return;
    } catch (e) {}
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
    LLM_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "test-key",
    NVIDIA_BASE_URL: brain.baseUrl,
    // Blank the search + gmail credentials so those capabilities stay OFF and
    // the registry has to prove it won't offer tools that cannot work. Set here
    // rather than omitted because the .env loader only fills keys that are
    // absent — this is also what keeps the suite off the real inbox.
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

  // 1) THE BUG: the model narrates an action and calls nothing.
  //    The narration must never be spoken, a real tool round must repair it,
  //    and what the user hears must describe what actually happened.
  {
    await brain.setScript([
      { text: "Sure! Opening YouTube for you right now." },        // round 0: all talk
      { toolCalls: [{ name: "open_url", arguments: { url: "https://youtube.com", label: "YouTube" } }] }, // forced repair
      { text: "YouTube is open." }                                  // post-tool completion
    ]);
    const { events, spoken } = await chat(PORT, "open youtube");
    assert.ok(!/Sure! Opening YouTube/.test(spoken), "the unearned narration must never reach the user");
    assert.match(spoken, /YouTube is open/, "the user hears the post-tool result");
    const done = events.find((e) => e.ev === "done");
    assert.ok(done.data.clientActions.some((a) => a.type === "open" && /youtube/.test(a.url)), "the tab actually opens");
    assert.deepEqual(done.data.toolsUsed, ["open_url"], "the tool really ran");
    ok("narration-only turn is repaired by a real tool round, and never spoken");
  }

  // 2) the client is told the intent BEFORE any token, so it knows to stay quiet
  {
    await brain.setScript([
      { toolCalls: [{ name: "open_url", arguments: { url: "https://example.com" } }] },
      { text: "Done." }
    ]);
    const { events } = await chat(PORT, "open example.com");
    assert.equal(events[0].ev, "intent_pending", "intent is the first thing the client hears");
    assert.equal(events[0].data.intent, "executable_action");
    assert.equal(events[0].data.family, "navigate");
    ok("intent_pending precedes every token");
  }

  // 3) forcing is narrowed to the right family — plain "required" was
  //    satisfiable with any unrelated tool
  {
    await brain.setScript([
      { toolCalls: [{ name: "open_url", arguments: { url: "https://example.com" } }] },
      { text: "Done." }
    ]);
    await chat(PORT, "open example.com");
    const [first] = await brain.requests();
    assert.deepEqual(first.toolNames, ["open_url"], "only the navigate family is offered on the forced round");
    assert.deepEqual(first.tool_choice, { type: "function", function: { name: "open_url" } }, "the exact function is pinned");
    ok("a forced round can only call the tool the request was about");
  }

  // 4) fragmented SSE: a tool call split across many deltas still executes
  {
    await brain.setScript([
      { fragment: true, toolCalls: [{ name: "open_url", arguments: { url: "https://fragmented.example", label: "Frag" } }] },
      { text: "Opened it.", fragment: true }
    ]);
    const { events, spoken } = await chat(PORT, "open fragmented.example");
    assert.match(spoken, /Opened it/);
    assert.ok(events.find((e) => e.ev === "done").data.clientActions.some((a) => a.url === "https://fragmented.example"),
      "a call assembled from fragments still runs");
    ok("tool calls fragmented across SSE deltas are assembled and executed");
  }

  // 5) a malformed call is rejected BEFORE it counts, and the model gets to retry
  {
    await brain.setScript([
      { toolCalls: [{ name: "open_url", arguments: {} }] },                                   // no url
      { toolCalls: [{ name: "open_url", arguments: { url: "https://retry.example" } }] },      // corrected
      { text: "Opened on the second try." }
    ]);
    const { events, spoken } = await chat(PORT, "open retry.example");
    assert.match(spoken, /second try/);
    const done = events.find((e) => e.ev === "done");
    assert.deepEqual(done.data.toolsUsed, ["open_url"], "the rejected call is not recorded as a run");
    assert.ok(done.data.clientActions.some((a) => a.url === "https://retry.example"));
    ok("a malformed call is refused before execution and the retry is what counts");
  }

  // 6) an unknown tool name cannot fake success
  {
    await brain.setScript([
      { toolCalls: [{ name: "definitely_not_a_tool", arguments: {} }] },
      { text: "All set!" },                                    // model claims success anyway
      { toolCalls: [{ name: "open_url", arguments: { url: "https://recovered.example" } }] },
      { text: "Opened it for real." }
    ]);
    const { spoken } = await chat(PORT, "open recovered.example");
    assert.ok(!/All set/.test(spoken), "a claim backed by an unknown tool is not spoken");
    assert.match(spoken, /for real/);
    ok("an unknown tool name never satisfies the turn");
  }

  // 7) the tool runs but FAILS — she must say so rather than report success.
  //    cancel_reminder with nothing listed returns ok:false, which is exactly the
  //    case the old code counted as "a tool ran, so the turn worked".
  {
    await brain.setScript([
      { toolCalls: [{ name: "cancel_reminder", arguments: { number: 3 } }] }, // returns ok:false
      { text: "All done, that reminder is cancelled!" },                      // model claims success
      { toolCalls: [{ name: "cancel_reminder", arguments: { number: 3 } }] }, // repair fails too
      { text: "Really, it's cancelled!" }
    ]);
    const { events, spoken } = await chat(PORT, "cancel my reminder");
    assert.ok(!/All done|Really, it's cancelled/.test(spoken), "a failed tool must not be narrated as success");
    assert.match(spoken, /couldn't/i, "the user is told the truth");
    const done = events.find((e) => e.ev === "done");
    assert.ok(done.data.toolsUsed.length >= 1, "the tool really was attempted");
    ok("a tool that returns an error produces an honest failure, not a false success");
  }

  // 8) conversation is NOT forced into tools — she still has to be able to talk
  {
    await brain.setScript([{ text: "I think jazz is wonderful, especially Mingus." }]);
    const { events, spoken } = await chat(PORT, "what do you think about jazz");
    assert.match(spoken, /Mingus/);
    assert.equal(events[0].data.intent, "chat");
    const [first] = await brain.requests();
    assert.equal(first.tool_choice, "auto", "a chat turn leaves tools optional");
    assert.equal(events.find((e) => e.ev === "done").data.toolsUsed.length, 0, "no tool was forced on a chat turn");
    ok("conversation stays tool-free and streams normally");
  }

  // 9) an unresolvable request asks instead of guessing
  {
    await brain.setScript([{ text: "Open what, exactly?" }]);
    const { events, spoken } = await chat(PORT, "open it");
    assert.equal(events[0].data.intent, "needs_clarification");
    const [first] = await brain.requests();
    assert.equal(first.tool_choice, "none", "an ambiguous turn is forbidden from acting");
    assert.match(spoken, /Open what/);
    ok("'open it' with no referent asks a question instead of forcing a tool");
  }

  // 10) a capability that isn't configured is never advertised
  {
    await brain.setScript([{ text: "Email isn't connected." }]);
    await chat(PORT, "check my email");
    const [first] = await brain.requests();
    assert.ok(!first.toolNames.includes("check_email"), "no gmail key → the tool is not offered at all");
    assert.ok(!first.toolNames.includes("web_search"), "no search key → not offered either");
    ok("unconfigured capabilities are never offered to the model");
  }

  // 11) multiple tool calls in one response all execute
  {
    await brain.setScript([
      { toolCalls: [
        { name: "open_url", arguments: { url: "https://one.example", label: "One" } },
        { name: "open_url", arguments: { url: "https://two.example", label: "Two" } }
      ] },
      { text: "Both are open." }
    ]);
    const { events, spoken } = await chat(PORT, "open one.example and two.example");
    assert.match(spoken, /Both are open/);
    const urls = events.find((e) => e.ev === "done").data.clientActions.map((a) => a.url);
    assert.deepEqual(urls.sort(), ["https://one.example", "https://two.example"]);
    ok("multiple tool calls in one response all run");
  }

  // 12) hanging up mid-turn actually stops the work
  {
    await brain.setScript([
      { toolCalls: [{ name: "open_url", arguments: { url: "https://cancel.example" } }] },
      { text: "This should never be generated.", delayMs: 5000 }
    ]);
    const before = (await brain.requests()).length;
    await chat(PORT, "open cancel.example", { abortAfterMs: 400 });
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await brain.requests()).length;
    assert.ok(after - before <= 2, "no further model rounds are started after the client disconnects");
    ok("client disconnect cancels the turn instead of running it to completion");
  }

  console.log("PASS ✅  reliability: a spoken claim now requires a tool that really ran and really worked");
} catch (e) {
  failed = true;
  console.error("FAIL ❌ ", e && e.stack ? e.stack : e);
} finally {
  child.kill("SIGTERM");
  await brain.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}
process.exit(failed ? 1 : 0);
