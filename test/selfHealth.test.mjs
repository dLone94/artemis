// The health manager must be right about the things that matter most:
// disabled is not broken, one root cause is one problem, recovery is bounded,
// and no credential ever reaches a snapshot.
//
// Run: node --test test/selfHealth.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSelfHealth,
  sanitizeText,
  sanitizeDetails,
  CODES,
  HEALTHY, DEGRADED, FAILED, RECOVERING, DISABLED, UNKNOWN
} from "../selfHealth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A manager with a clock we drive by hand. */
function harness(opts = {}) {
  let t = 1_000_000;
  const logged = [];
  const h = createSelfHealth({ now: () => t, log: (e) => logged.push(e), ...opts });
  return { h, logged, advance: (ms) => { t += ms; }, at: () => t };
}

/** Register a component whose status the test sets directly. */
function fixed(h, id, category, status, extra = {}) {
  h.register(id, {
    category,
    label: extra.label || id,
    critical: extra.critical,
    dependsOn: extra.dependsOn,
    recovery: extra.recovery,
    probe: () => ({ status, summary: extra.summary || status, errorCode: extra.errorCode })
  });
}

/* ------------------------------------------------------------ aggregation */

test("1 — everything healthy rolls up to HEALTHY", async () => {
  const { h } = harness();
  fixed(h, "voice.wake", "voice", HEALTHY);
  fixed(h, "ai.local", "ai", HEALTHY);
  fixed(h, "runtime.server", "runtime", HEALTHY, { critical: true });
  await h.scan();

  const snap = h.snapshot();
  assert.equal(snap.overall, HEALTHY);
  assert.equal(snap.issueCount, 0);
});

test("2 — one degraded subsystem degrades the whole", async () => {
  const { h } = harness();
  fixed(h, "voice.wake", "voice", HEALTHY);
  fixed(h, "voice.sttLocal", "voice", DEGRADED, { summary: "model missing" });
  await h.scan();

  const snap = h.snapshot();
  assert.equal(snap.overall, DEGRADED);
  assert.equal(snap.issueCount, 1);
  assert.equal(snap.subsystems.voice.overall, DEGRADED);
  assert.equal(snap.subsystems.voice.components.wake.status, HEALTHY);
});

test("3 — a CRITICAL component failing fails the system; a non-critical one only degrades it", async () => {
  // The distinction that stops "my OCR helper is missing" reading like
  // "my server is down".
  const soft = harness();
  fixed(soft.h, "computer.ocr", "computer", FAILED, { critical: false });
  await soft.h.scan();
  assert.equal(soft.h.snapshot().overall, DEGRADED, "a non-critical failure must not read as total failure");

  const hard = harness();
  fixed(hard.h, "runtime.server", "runtime", FAILED, { critical: true });
  await hard.h.scan();
  assert.equal(hard.h.snapshot().overall, FAILED);
});

test("4 & 24 — DISABLED by mode is not a failure and never lowers overall health", async () => {
  const { h } = harness();
  fixed(h, "voice.wake", "voice", HEALTHY);
  fixed(h, "ai.groq", "ai", DISABLED, { summary: "disabled by local-only mode" });
  fixed(h, "voice.sttCloud", "voice", DISABLED, { summary: "disabled by local-only mode" });
  await h.scan();

  const snap = h.snapshot();
  assert.equal(snap.overall, HEALTHY, "intentionally-off cloud must not make Artemis look broken");
  assert.equal(snap.issueCount, 0, "a disabled subsystem is not an issue to report");
  assert.equal(snap.subsystems.ai.components.groq.status, DISABLED);
  assert.notEqual(snap.subsystems.ai.components.groq.status, FAILED);
});

test("an entirely unchecked system is UNKNOWN, not healthy", () => {
  const { h } = harness();
  fixed(h, "voice.wake", "voice", HEALTHY);
  assert.equal(h.snapshot().overall, UNKNOWN, "never-checked must not masquerade as fine");
});

/* -------------------------------------------------------------- recovery */

test("5, 6 — a dead wake listener is recovered, and comes back HEALTHY", async () => {
  const { h } = harness();
  let alive = false;
  let restarts = 0;
  h.register("voice.wake", {
    category: "voice",
    label: "wake listener",
    probe: () => (alive
      ? { status: HEALTHY, summary: "armed" }
      : { status: FAILED, summary: "not armed", errorCode: CODES.VOICE_WAKE_NOT_ARMED }),
    recovery: { attempt: () => { restarts += 1; alive = true; return true; }, maxAttempts: 3, cooldownMs: 30000 }
  });

  await h.scan();
  assert.equal(h.get("voice.wake").status, FAILED);

  const result = await h.recover("voice.wake", "wake listener stopped");
  assert.equal(result.ok, true);
  assert.equal(restarts, 1);
  assert.equal(h.get("voice.wake").status, HEALTHY);
  assert.equal(h.get("voice.wake").recoveryAttempts, 0, "a success returns the budget");

  // and the history tells the story the spec asked for
  const kinds = h.history().map((e) => e.kind);
  assert.ok(kinds.includes("recovery-attempt"));
  assert.ok(kinds.includes("recovery-result"));
});

test("7 — recovery is bounded: after the budget it stays FAILED instead of looping", async () => {
  const { h, advance } = harness();
  let attempts = 0;
  h.register("voice.wake", {
    category: "voice",
    label: "wake listener",
    probe: () => ({ status: FAILED, summary: "dead", errorCode: CODES.VOICE_WAKE_HELPER_DEAD }),
    recovery: { attempt: () => { attempts += 1; return false; }, maxAttempts: 3, cooldownMs: 30000 }
  });
  await h.scan();

  for (let i = 0; i < 10; i++) await h.recover("voice.wake", "watchdog");

  assert.equal(attempts, 3, `must stop at the budget, tried ${attempts} times`);
  assert.equal(h.get("voice.wake").status, FAILED);
  assert.equal(h.get("voice.wake").recoveryState, "exhausted");

  // the cooldown is what allows a later, legitimate retry — never a tight loop
  advance(31000);
  await h.recover("voice.wake", "watchdog");
  assert.equal(attempts, 4, "after the cooldown exactly one more attempt is allowed");
});

test("8 — a provider that fails temporarily degrades, then recovers on its own next scan", async () => {
  const { h } = harness();
  let failing = true;
  h.register("ai.groq", {
    category: "ai",
    label: "cloud model",
    probe: () => (failing
      ? { status: DEGRADED, summary: "provider benched", errorCode: CODES.MODEL_PROVIDER_BENCHED }
      : { status: HEALTHY, summary: "answering" })
  });

  await h.scan();
  assert.equal(h.snapshot().overall, DEGRADED);
  failing = false;
  await h.scan();
  assert.equal(h.snapshot().overall, HEALTHY);
});

test("19 — recovery can only ever call what a component registered for itself", () => {
  // The safety boundary, asserted structurally: the manager has no shell, no
  // process control and no filesystem access of its own to reach for.
  const src = readFileSync(join(ROOT, "selfHealth.js"), "utf8");
  for (const forbidden of ["child_process", "execFile", "exec(", "spawn(", "sudo", "node:fs", "unlink", "rm -"]) {
    assert.ok(!src.includes(forbidden), `selfHealth.js must not reference ${forbidden}`);
  }
});

/* ------------------------------------------------------ root-cause grouping */

test("16 — a network outage is ONE problem, not one per cloud service", async () => {
  const { h } = harness();
  h.register("network.link", { category: "network", label: "network", probe: () => ({ status: FAILED, summary: "no network", errorCode: CODES.NETWORK_UNAVAILABLE }) });
  for (const [id, label] of [["ai.groq", "Groq"], ["voice.sttCloud", "cloud speech"], ["integrations.gmail", "Gmail"], ["ai.nvidia", "NVIDIA"]]) {
    h.register(id, {
      category: id.split(".")[0] === "integrations" ? "integrations" : id.startsWith("ai") ? "ai" : "voice",
      label,
      dependsOn: "network.link",
      probe: () => ({ status: FAILED, summary: "unreachable" })
    });
  }
  await h.scan();

  const snap = h.snapshot();
  assert.equal(snap.issueCount, 1, `expected one root issue, got ${snap.issueCount}: ${snap.issues.map((i) => i.label)}`);
  assert.equal(snap.issues[0].id, "network.link");
  assert.equal(snap.subsystems.ai.components.groq.dependency, "network.link",
    "a dependent failure must be attributed, not counted separately");
});

test("a dependency chain blames the deepest cause once", async () => {
  const { h } = harness();
  h.register("network.link", { category: "network", probe: () => ({ status: FAILED, summary: "down" }) });
  h.register("ai.cloud", { category: "ai", dependsOn: "network.link", probe: () => ({ status: FAILED, summary: "unreachable" }) });
  h.register("voice.ttsCloud", { category: "voice", dependsOn: "ai.cloud", probe: () => ({ status: FAILED, summary: "no voice" }) });
  await h.scan();

  const snap = h.snapshot();
  assert.equal(snap.issueCount, 1);
  assert.equal(snap.subsystems.voice.components.ttsCloud.dependency, "network.link",
    "the chain must resolve to the ROOT, not the middle link");
});

test("a component whose dependency FAILED cannot be reported healthy", async () => {
  // The real case that exposed this: the OCR helper file is still on disk when
  // Screen Recording is denied, so its own probe passes — but screen reading
  // cannot work, and calling it Healthy would be a lie the user acts on.
  const { h } = harness();
  fixed(h, "computer.screenRecording", "computer", FAILED, { label: "Screen Recording" });
  fixed(h, "computer.perception", "computer", HEALTHY, { label: "screen reading", dependsOn: "computer.screenRecording" });
  await h.scan();

  const snap = h.snapshot();
  const perception = snap.subsystems.computer.components.perception;
  assert.equal(perception.status, DEGRADED, "it cannot do its job, so it is not healthy");
  assert.equal(perception.dependency, "computer.screenRecording");
  assert.equal(snap.issueCount, 1, "but it is still ONE problem, not two");
  assert.equal(snap.issues[0].id, "computer.screenRecording");
});

test("a DISABLED component is not dragged down by a failed dependency", async () => {
  // Local-only mode disables the cloud brain. If the network then also fails,
  // the brain must stay DISABLED — it was never going to be used.
  const { h } = harness();
  fixed(h, "network.link", "network", FAILED, { label: "network" });
  fixed(h, "ai.cloud", "ai", DISABLED, { label: "cloud models", dependsOn: "network.link" });
  await h.scan();

  assert.equal(h.snapshot().subsystems.ai.components.cloud.status, DISABLED);
});

/* -------------------------------------------------- quick vs deep checking */

test("17, 18 — a quick self-check runs only lightweight probes; a full diagnostic runs the deep ones", async () => {
  const { h } = harness();
  let light = 0;
  let deep = 0;
  h.register("voice.sttLocal", {
    category: "voice",
    probe: () => { light += 1; return { status: HEALTHY, summary: "model present" }; },
    deepProbe: () => { deep += 1; return { status: HEALTHY, summary: "transcribed a test clip" }; }
  });

  await h.scan();
  assert.equal(light, 1, "quick scan runs the lightweight probe");
  assert.equal(deep, 0, "quick scan must NOT run the expensive one");

  await h.scan({ deep: true });
  assert.equal(deep, 1, "full diagnostic runs the deep probe");
  assert.equal(light, 1, "and does not re-run the lightweight one for the same component");
});

test("a probe that throws becomes a reported fault, not a broken scan", async () => {
  const { h } = harness();
  h.register("voice.wake", { category: "voice", probe: () => { throw new Error("helper exploded"); } });
  h.register("ai.local", { category: "ai", probe: () => ({ status: HEALTHY, summary: "ok" }) });
  await h.scan();

  assert.equal(h.get("voice.wake").status, FAILED);
  assert.equal(h.get("voice.wake").errorCode, CODES.PROBE_ERROR);
  assert.equal(h.get("ai.local").status, HEALTHY, "one bad probe must not blind the rest of the scan");
});

/* --------------------------------------------------------------- history */

test("22 — health history is a bounded ring", async () => {
  const { h } = harness({ maxHistory: 10 });
  let flip = true;
  h.register("voice.wake", { category: "voice", probe: () => ({ status: (flip = !flip) ? HEALTHY : FAILED, summary: "x" }) });
  for (let i = 0; i < 200; i++) await h.scan();

  assert.ok(h.history().length <= 10, `history must stay bounded, got ${h.history().length}`);
});

test("23 — a component that keeps breaking is DEGRADED even while it is currently up", async () => {
  const { h, advance } = harness({ patternThreshold: 3, patternWindowMs: 3_600_000 });
  let up = true;
  h.register("voice.wake", {
    category: "voice",
    label: "wake listener",
    probe: () => (up ? { status: HEALTHY, summary: "armed" } : { status: FAILED, summary: "dropped" })
  });

  for (let i = 0; i < 3; i++) {
    up = false; await h.scan(); advance(60_000);
    up = true; await h.scan(); advance(60_000);
  }

  const snap = h.snapshot();
  assert.equal(h.get("voice.wake").status, HEALTHY, "the raw state really is healthy right now");
  assert.equal(snap.subsystems.voice.components.wake.status, DEGRADED,
    "but four drops in an hour is not a healthy wake listener");
  assert.ok(snap.subsystems.voice.components.wake.repeatedFault >= 3);
  assert.equal(snap.overall, DEGRADED);
});

test("an old fault falls out of the pattern window", async () => {
  const { h, advance } = harness({ patternThreshold: 2, patternWindowMs: 60_000 });
  let up = false;
  h.register("voice.wake", { category: "voice", probe: () => (up ? { status: HEALTHY, summary: "armed" } : { status: FAILED, summary: "dropped" }) });
  for (let i = 0; i < 3; i++) { up = false; await h.scan(); up = true; await h.scan(); }
  assert.equal(h.snapshot().subsystems.voice.components.wake.status, DEGRADED);

  advance(120_000); // past the window
  assert.equal(h.snapshot().subsystems.voice.components.wake.status, HEALTHY, "history must age out");
});

/* -------------------------------------------------- event-driven reporting */

test("a subsystem can report a failure immediately, without waiting for a scan", async () => {
  const { h } = harness();
  h.register("voice.sttLocal", { category: "voice", label: "local speech", probe: () => ({ status: HEALTHY, summary: "ready" }) });
  await h.scan();
  assert.equal(h.snapshot().overall, HEALTHY);

  h.report("voice.sttLocal", { status: FAILED, summary: "whisper timed out", errorCode: CODES.STT_LOCAL_PROCESS_FAILURE });
  assert.equal(h.snapshot().overall, DEGRADED, "the failure lands the moment it is known");
  assert.equal(h.snapshot().issues[0].errorCode, CODES.STT_LOCAL_PROCESS_FAILURE);
});

/* ------------------------------------------------------------ sanitisation */

test("21 — credentials never reach a snapshot, a summary or the log", async () => {
  const { h, logged } = harness();
  h.register("integrations.gmail", {
    category: "integrations",
    label: "Gmail",
    probe: () => ({
      status: FAILED,
      // Everything a careless probe author might leak, all at once.
      summary: "refresh failed for token ya29.averyLongLookingAccessTokenValue123456",
      details: {
        apiKey: "gsk_liveSecretKeyMaterial000111222333",
        access_token: "ya29.anotherOne",
        authorization: "Bearer abcdefghijklmnop",
        endpoint: "https://gmail.googleapis.com",
        credentialPath: "/Users/todortopalov/.artemis/creds.json"
      }
    })
  });
  await h.scan();

  const snap = h.snapshot();
  const blob = JSON.stringify(snap) + JSON.stringify(logged) + JSON.stringify(h.history());
  for (const secret of ["ya29.", "gsk_live", "abcdefghijklmnop", "averyLongLooking", "todortopalov"]) {
    assert.ok(!blob.includes(secret), `"${secret}" must never appear in health output`);
  }
  const details = snap.subsystems.integrations.components.gmail.details;
  assert.equal(details.apiKey, "[redacted]");
  assert.equal(details.access_token, "[redacted]");
  assert.equal(details.endpoint, "https://gmail.googleapis.com", "non-secret context is still useful and stays");
});

test("the redactor handles the shapes it claims to", () => {
  // The whole name=value pair goes, not just the value — leaving "key=" behind
  // would still tell a reader which field was present.
  assert.equal(sanitizeText("key=abc123def456"), "[redacted]");
  assert.equal(sanitizeText("monkey=fine"), "monkey=fine", "the word boundary keeps ordinary words intact");
  assert.match(sanitizeText("/Users/someone/Library/x"), /^~\/Library\/x$/);
  assert.equal(sanitizeDetails({ token: "" }).token, null, "an empty credential field is still not echoed");
  assert.equal(sanitizeDetails({ nested: { password: "hunter2" } }).nested.password, "[redacted]");
  assert.equal(sanitizeDetails({ count: 3, ok: true }).count, 3, "ordinary values survive");
});

test("sanitisation cannot be hung by a cyclic details object", () => {
  const a = { name: "a" };
  a.self = a;
  assert.doesNotThrow(() => sanitizeDetails(a));
});

/* ------------------------------------------------------------ status model */

test("RECOVERING is visible while a repair is in flight", async () => {
  const { h } = harness();
  let seen = null;
  h.register("voice.wake", {
    category: "voice",
    label: "wake listener",
    probe: () => ({ status: FAILED, summary: "dead" }),
    recovery: {
      attempt: () => { seen = h.get("voice.wake").status; return true; },
      maxAttempts: 2
    }
  });
  await h.scan();
  await h.recover("voice.wake");
  assert.equal(seen, RECOVERING, "the state must read RECOVERING while the attempt runs");
});
