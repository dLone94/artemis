// The browser half, driven as the shipped file.
//
// Runs the REAL public/healthClient.js in a vm sandbox with a fake DOM — the
// same approach the music suite uses — because the two things worth proving
// here are exactly the two a screenshot cannot show: that the SYSTEM HEALTH
// readout is written from real data, and that a "recover" instruction arriving
// over the wire can only ever reach the two local repairs.
//
// Run: node --test test/healthClient.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Minimal DOM: enough for the module's real code paths, nothing more. */
function fakeDom() {
  const made = [];
  function element(tag) {
    const el = {
      tagName: tag, id: "", className: "", textContent: "", title: "", tabIndex: 0,
      dataset: {}, children: [], listeners: {},
      setAttribute(k, v) { this[k] = v; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      appendChild(c) { this.children.push(c); return c; }
    };
    made.push(el);
    return el;
  }
  const header = element("header");
  header.className = "v3-header-status";
  const doc = {
    body: { dataset: {} },
    createElement: element,
    getElementById: (id) => made.find((e) => e.id === id) || null,
    querySelector: (sel) => (sel.includes("v3-header-status") || sel.includes("hud-top") ? header : null),
    addEventListener() {}
  };
  return { doc, header, made };
}

/** Boot the shipped module with fakes; returns handles to drive it. */
function boot({ wake = { running: true, stalled: false, framesSeen: 10 }, health = null } = {}) {
  const posted = [];
  const recovered = [];
  const esListeners = new Map();
  const { doc, header } = fakeDom();

  const sandbox = {
    console,
    document: doc,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; },
    fetch: (url, opts) => {
      posted.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      // Both the initial paint ("/api/health") and the deep read
      // ("/api/health?deep=1") come back as a snapshot; only the report POST
      // does not.
      if (String(url).startsWith("/api/health") && !String(url).includes("/report")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(health || { badge: { label: "NOMINAL", tone: "ok" }, snapshot: { issues: [] }, detail: "VOICE\nWake listener: Healthy" }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
    EventSource: function () {
      return { addEventListener: (t, fn) => esListeners.set(t, fn) };
    },
    // The wake module's real surface, faked.
    wakeHealth: () => wake,
    localWakeRunning: () => true
  };
  sandbox.window = sandbox;
  sandbox.__artemisRecover = {
    wake: () => { recovered.push("wake"); return true; },
    audio: () => { recovered.push("audio"); return true; }
  };
  sandbox.__orb = { audioCtx: { state: "running" } };

  vm.createContext(sandbox);
  const src = read("public/healthClient.js")
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/^export\s+(function|const|let)\b/gm, "$1")
    // `export { collect as collectHealthReport }` becomes a real binding rather
    // than being deleted, so the test drives the module's PUBLIC names.
    .replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_m, inner) =>
      inner.split(",").map((part) => {
        const [from, to] = part.split(/\s+as\s+/).map((x) => x.trim());
        return to ? `var ${to} = ${from};` : "";
      }).join("\n"));
  assert.ok(!/^\s*(import|export)\b/m.test(src), "module syntax must be fully stripped");
  vm.runInContext(src, sandbox);

  return {
    sandbox, posted, recovered, header,
    fire: (type, data) => {
      const fn = esListeners.get(type);
      if (fn) return fn({ data: JSON.stringify(data) });
      return null;
    },
    start: () => sandbox.startHealthClient()
  };
}

test("the page reports what only IT can see about wake and audio", () => {
  const h = boot({ wake: { running: true, stalled: false, framesSeen: 4242, msSinceFrame: 20, healRetries: 0 } });
  const report = h.sandbox.collectHealthReport();

  assert.equal(report.wake.running, true);
  assert.equal(report.wake.framesSeen, 4242);
  assert.equal(report.audio.contextState, "running");
  assert.equal(report.presentationMode, "full");
  // No audio, no transcripts, nothing private — metadata only.
  assert.ok(!JSON.stringify(report).includes("audioData"));
});

test("a stalled listener is reported as stalled, not quietly as running", () => {
  const h = boot({ wake: { running: true, stalled: true, msSinceFrame: 9000, healRetries: 2 } });
  const report = h.sandbox.collectHealthReport();
  assert.equal(report.wake.stalled, true, "the deaf-but-running case must reach the server");
});

test("SYSTEM HEALTH is rendered into the existing header from real data", async () => {
  const h = boot();
  h.start();
  await new Promise((r) => setImmediate(r));   // let the initial fetch chain settle
  const badge = h.sandbox.document.getElementById("hudHealth");
  assert.ok(badge, "the readout must be created in the header that already exists");
  assert.equal(badge.textContent, "SYSTEM HEALTH NOMINAL");
  assert.equal(badge.dataset.tone, "ok");
  assert.ok(h.header.children.includes(badge), "it goes in the SYSTEM status area, not a new panel");
});

test("a degraded snapshot shows the count and explains itself on hover", () => {
  const h = boot();
  h.start();
  h.fire("health", {
    badge: { label: "1 DEGRADED", tone: "warn" },
    issues: [{ label: "local speech recognition", status: "DEGRADED", summary: "the local speech model is not installed" }]
  });
  const badge = h.sandbox.document.getElementById("hudHealth");
  assert.equal(badge.textContent, "SYSTEM HEALTH 1 DEGRADED");
  assert.equal(badge.dataset.tone, "warn");
  assert.match(badge.title, /local speech model is not installed/);
});

test("a recover instruction can ONLY reach the two local repairs", () => {
  const h = boot();
  h.start();

  h.fire("health-recover", { target: "wake" });
  assert.deepEqual(h.recovered, ["wake"]);

  h.fire("health-recover", { target: "audio" });
  assert.deepEqual(h.recovered, ["wake", "audio"]);

  // Anything else is ignored outright — the allowlist is the security boundary.
  for (const evil of ["eval", "exec", "sudo", "reinstall", "__proto__", "constructor", "delete", "permissions"]) {
    h.fire("health-recover", { target: evil });
  }
  assert.deepEqual(h.recovered, ["wake", "audio"], "no instruction outside the allowlist may execute anything");
});

test("recovery reports back immediately so the server can VERIFY, not assume", async () => {
  const h = boot();
  h.start();
  const before = h.posted.filter((p) => p.url === "/api/health/report").length;
  await h.fire("health-recover", { target: "wake" });
  const after = h.posted.filter((p) => p.url === "/api/health/report").length;
  assert.ok(after > before, "a repair must be followed by fresh evidence");
});

test("the health announcement uses the ONE existing voice path", () => {
  const h = boot();
  const said = [];
  h.sandbox.__artemisSay = (t) => said.push(t);
  h.start();
  h.fire("health-say", { text: "Wake listener restored." });
  assert.deepEqual(said, ["Wake listener restored."], "no second way for Artemis to talk");
});

test("the client never fabricates health when the wake module throws", () => {
  const h = boot();
  h.sandbox.wakeHealth = () => { throw new Error("module gone"); };
  const report = h.sandbox.collectHealthReport();
  assert.equal(report.wake, null, "unknown must be reported as nothing, never as healthy");
});
