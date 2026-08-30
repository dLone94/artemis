// The probes must produce the RIGHT diagnosis, with the right error code, from
// real-shaped subsystem state — and must not touch the network when the user
// has said local-only.
//
// Run: node --test test/healthProbes.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createSelfHealth, HEALTHY, DEGRADED, FAILED, DISABLED, UNKNOWN, CODES } from "../selfHealth.js";
import { registerProbes, DISK_LOW_BYTES, DISK_CRITICAL_BYTES, PRESENCE_STALE_MS } from "../healthProbes.js";

const GB = 1024 * 1024 * 1024;

/** Everything healthy, everything injected. Tests override one thing at a time. */
function makeDeps(over = {}) {
  const calls = { network: 0, cloudBrain: 0, gmail: 0, clientRecovery: [] };
  const base = {
    now: () => 1_000_000,
    offlineState: () => ({ offline: false }),
    localSttStatus: () => ({ ready: true, tier: "balanced", binaryExists: true, modelExists: true }),
    sttSelfTest: async () => ({ ok: true, msElapsed: 120 }),
    permissionSnapshot: async () => ({
      accessibility: "granted", screenRecording: "granted", automation: "granted", microphone: "granted"
    }),
    brainChainState: () => ({ current: "groq:a", chain: [{ name: "groq:a", available: true }, { name: "groq:b", available: true }] }),
    localBrainReachable: async () => ({ ok: true, model: "qwen3.5:4b" }),
    cloudBrainProbe: async () => { calls.cloudBrain += 1; return { ok: true }; },
    gmailConfigured: () => true,
    gmailAuthReady: () => true,
    gmailProbe: async () => { calls.gmail += 1; return { ok: true }; },
    diskFree: async () => ({ free: 200 * GB, total: 500 * GB }),
    pathWritable: async () => true,
    pathExists: async () => true,
    dirSize: async () => 1024,
    dataDir: "/data", logDir: "/logs", tmpDir: "/tmp",
    ocrHelperPath: "/helper/vision-ocr",
    presenceAge: () => 1000,
    clientHealth: () => ({
      at: 1_000_000,
      wake: { running: true, stalled: false, framesSeen: 5000, expected: true },
      audio: { contextState: "running", outputAvailable: true },
      presentationMode: "full",
      microphone: "ok"
    }),
    toolRegistryState: () => ({ loaded: true, count: 42, missing: [] }),
    skillsState: () => ({ loaded: true }),
    contextState: () => ({ available: true }),
    ttsState: () => ({ provider: "deepgram", available: true }),
    sttCloudConfigured: () => true,
    networkReachable: async () => { calls.network += 1; return true; },
    buildVersion: () => "test",
    requestClientRecovery: async () => { calls.clientRecovery.push("called"); return true; },
    faults: () => new Set()
  };
  return { deps: { ...base, ...over }, calls };
}

async function scanWith(over = {}, { deep = false } = {}) {
  const { deps, calls } = makeDeps(over);
  const health = createSelfHealth({ now: deps.now });
  registerProbes(health, deps);
  await health.scan({ deep });
  return { health, snap: health.snapshot(), calls, deps };
}

const comp = (snap, cat, name) => snap.subsystems[cat].components[name];

/* ------------------------------------------------------------- baseline */

test("a fully healthy machine reports HEALTHY with nothing to say", async () => {
  const { snap } = await scanWith();
  assert.equal(snap.overall, HEALTHY, JSON.stringify(snap.issues));
  assert.equal(snap.issueCount, 0);
});

/* ---------------------------------------------------- 9: local STT model */

test("9 — a missing whisper model is STT_LOCAL_MODEL_MISSING, and only degrades", async () => {
  const { snap } = await scanWith({
    localSttStatus: () => ({ ready: false, modelExists: false, tier: "balanced", binaryExists: true })
  });
  const c = comp(snap, "voice", "sttLocal");
  assert.equal(c.status, DEGRADED, "cloud speech still works, so this is not a total failure");
  assert.equal(c.errorCode, CODES.STT_LOCAL_MODEL_MISSING);
  assert.equal(snap.overall, DEGRADED);
});

test("a missing whisper BINARY is a different code from a missing model", async () => {
  const { snap } = await scanWith({
    localSttStatus: () => ({ ready: false, binaryExists: false, binary: "/x/whisper" })
  });
  assert.equal(comp(snap, "voice", "sttLocal").errorCode, CODES.STT_LOCAL_BINARY_MISSING);
});

test("a deep check catches an engine that is installed but cannot actually transcribe", async () => {
  const quick = await scanWith({ sttSelfTest: async () => ({ ok: false, error: "exit 1" }) });
  assert.equal(comp(quick.snap, "voice", "sttLocal").status, HEALTHY, "the lightweight check cannot know this");

  const deep = await scanWith({ sttSelfTest: async () => ({ ok: false, error: "exit 1" }) }, { deep: true });
  const c = comp(deep.snap, "voice", "sttLocal");
  assert.equal(c.status, FAILED);
  assert.equal(c.errorCode, CODES.STT_LOCAL_PROCESS_FAILURE);
});

/* ------------------------------------------------ 10, 11: permissions */

test("10 — a denied microphone permission is diagnosed and tells the user where to fix it", async () => {
  const { snap } = await scanWith({
    permissionSnapshot: async () => ({ accessibility: "granted", screenRecording: "granted", automation: "granted", microphone: "denied" })
  });
  const c = comp(snap, "voice", "microphone");
  assert.equal(c.status, FAILED);
  assert.equal(c.errorCode, CODES.VOICE_MIC_PERMISSION);
  // The remedy must exist, but in details rather than the summary: the summary
  // gets spoken, and a Settings path recited mid-sentence reads terribly.
  assert.match(c.details.fix, /System Settings/, "a permission fault must say where to fix it");
  assert.ok(c.summary.length < 50, `the spoken summary must stay short, got: ${c.summary}`);
  assert.equal(snap.overall, FAILED, "the microphone is critical to a voice assistant");
});

test("11 — missing Accessibility is diagnosed, and never repaired automatically", async () => {
  const { snap } = await scanWith({
    permissionSnapshot: async () => ({ accessibility: "denied", screenRecording: "granted", automation: "granted", microphone: "granted" })
  });
  const c = comp(snap, "computer", "accessibility");
  assert.equal(c.status, FAILED);
  assert.equal(c.errorCode, CODES.PERMISSION_ACCESSIBILITY_MISSING);
  assert.equal(c.recoverable, false, "a security permission must never be auto-repairable");
  assert.equal(c.details.userActionRequired, true);
});

test("an unknown permission is UNKNOWN, not assumed granted", async () => {
  const { snap } = await scanWith({
    permissionSnapshot: async () => ({ accessibility: "unknown", screenRecording: "granted", automation: "granted", microphone: "granted" })
  });
  assert.equal(comp(snap, "computer", "accessibility").status, UNKNOWN);
});

/* ------------------------------------------------------- 12, 13: disk */

test("12 — low disk degrades", async () => {
  const { snap } = await scanWith({ diskFree: async () => ({ free: DISK_LOW_BYTES - 1, total: 100 * GB }) });
  const c = comp(snap, "storage", "disk");
  assert.equal(c.status, DEGRADED);
  assert.equal(c.errorCode, CODES.STORAGE_LOW_SPACE);
  assert.equal(snap.overall, DEGRADED);
});

test("13 — critically low disk escalates to FAILED", async () => {
  const { snap } = await scanWith({ diskFree: async () => ({ free: DISK_CRITICAL_BYTES - 1, total: 100 * GB }) });
  const c = comp(snap, "storage", "disk");
  assert.equal(c.status, FAILED);
  assert.equal(c.errorCode, CODES.STORAGE_CRITICAL_SPACE);
  assert.match(c.summary, /recording and models will fail/);
});

test("an unwritable data directory is a critical failure", async () => {
  const { snap } = await scanWith({ pathWritable: async (p) => p !== "/data" });
  assert.equal(comp(snap, "storage", "data").status, FAILED);
  assert.equal(snap.overall, FAILED);
});

test("runaway logs are reported but never deleted automatically", async () => {
  const { snap } = await scanWith({ dirSize: async () => 900 * 1024 * 1024 });
  const c = comp(snap, "storage", "logs");
  assert.equal(c.status, DEGRADED);
  assert.equal(c.errorCode, CODES.STORAGE_LOG_GROWTH);
  assert.equal(c.details.userActionRequired, true);
  assert.equal(c.recoverable, false, "deleting the user's logs is not Artemis's decision");
});

/* --------------------------------------------------- 14: presence stale */

test("14 — a stale presence heartbeat degrades the runtime", async () => {
  const { snap } = await scanWith({ presenceAge: () => PRESENCE_STALE_MS + 5000 });
  const c = comp(snap, "runtime", "presence");
  assert.equal(c.status, DEGRADED);
  assert.equal(c.errorCode, CODES.RUNTIME_PRESENCE_STALE);
  assert.equal(c.recoverable, true, "a dropped stream is exactly the kind of thing she may reconnect herself");
});

/* ------------------------------------------------------- 15: gmail auth */

test("15 — expired Gmail auth degrades the integration and exposes no credential", async () => {
  const { snap } = await scanWith({ gmailAuthReady: () => false });
  const c = comp(snap, "integrations", "gmail");
  assert.equal(c.status, DEGRADED);
  assert.equal(c.errorCode, CODES.INTEGRATION_AUTH_EXPIRED);
  assert.equal(c.details.userActionRequired, true);

  const blob = JSON.stringify(snap);
  assert.ok(!/token|refresh_token|client_secret/i.test(blob), "no credential vocabulary may appear at all");
});

test("an integration the user never configured is DISABLED, not broken", async () => {
  const { snap } = await scanWith({ gmailConfigured: () => false });
  assert.equal(comp(snap, "integrations", "gmail").status, DISABLED);
  assert.equal(snap.overall, HEALTHY, "never-configured must not make the system look unhealthy");
});

/* ---------------------------------------------- 16: root-cause grouping */

test("16 — a real network outage produces ONE issue, not five", async () => {
  const { snap } = await scanWith({
    networkReachable: async () => false,
    gmailAuthReady: () => false,
    brainChainState: () => ({ current: "groq:a", chain: [{ name: "groq:a", available: false, availableInSec: 600 }] })
  });

  assert.equal(snap.issueCount, 1, `expected one root issue, got: ${snap.issues.map((i) => i.label).join(", ")}`);
  assert.equal(snap.issues[0].errorCode, CODES.NETWORK_UNAVAILABLE);
  assert.equal(comp(snap, "ai", "cloud").dependency, "network.link");
  assert.equal(comp(snap, "integrations", "gmail").dependency, "network.link");
});

/* ------------------------------------------- 20: LOCAL-ONLY, zero cloud */

test("20 — a LOCAL-ONLY diagnostic makes ZERO cloud calls, quick or deep", async () => {
  const offline = { offlineState: () => ({ offline: true }) };

  const quick = await scanWith(offline);
  assert.equal(quick.calls.network, 0, "reachability must not be probed in local-only");
  assert.equal(quick.calls.cloudBrain, 0);
  assert.equal(quick.calls.gmail, 0);

  const deep = await scanWith(offline, { deep: true });
  assert.equal(deep.calls.network, 0, "not even a full diagnostic may reach out in local-only");
  assert.equal(deep.calls.cloudBrain, 0);
  assert.equal(deep.calls.gmail, 0);
});

test("LOCAL-ONLY still diagnoses everything local, and marks cloud DISABLED BY MODE", async () => {
  const { snap } = await scanWith({ offlineState: () => ({ offline: true }) });

  // cloud: disabled by mode, not failed
  for (const [cat, name] of [["ai", "cloud"], ["voice", "sttCloud"], ["integrations", "gmail"], ["network", "link"]]) {
    const c = comp(snap, cat, name);
    assert.equal(c.status, DISABLED, `${cat}.${name} must be DISABLED in local-only, got ${c.status}`);
    assert.notEqual(c.status, FAILED);
  }
  // local: genuinely evaluated
  for (const [cat, name] of [["voice", "wake"], ["voice", "microphone"], ["voice", "sttLocal"], ["ai", "local"],
    ["computer", "accessibility"], ["computer", "perception"], ["storage", "disk"], ["runtime", "server"]]) {
    assert.equal(comp(snap, cat, name).status, HEALTHY, `${cat}.${name} must still be checked offline`);
  }
  assert.equal(snap.overall, HEALTHY, "an offline machine in good order is HEALTHY");
});

test("in LOCAL-ONLY an unreachable local model is a real failure, not a shrug", async () => {
  // Offline, the local model is the ONLY model. Losing it matters more.
  const on = await scanWith({ localBrainReachable: async () => ({ ok: false }) });
  assert.equal(comp(on.snap, "ai", "local").status, DEGRADED, "with cloud available this is a fallback situation");

  const off = await scanWith({ offlineState: () => ({ offline: true }), localBrainReachable: async () => ({ ok: false }) });
  assert.equal(comp(off.snap, "ai", "local").status, FAILED, "offline there is nothing to fall back to");
});

/* -------------------------------------------------------------- wake */

test("a wake listener that is running but deaf is FAILED, not healthy", async () => {
  // The exact real bug: running === true while no audio frames arrive.
  const { snap } = await scanWith({
    clientHealth: () => ({
      at: 1_000_000,
      wake: { running: true, stalled: true, msSinceFrame: 9000, healRetries: 2, expected: true },
      audio: { contextState: "running", outputAvailable: true },
      presentationMode: "full"
    })
  });
  const c = comp(snap, "voice", "wake");
  assert.equal(c.status, FAILED);
  assert.equal(c.errorCode, CODES.VOICE_WAKE_STALLED);
  assert.equal(c.recoverable, true);
});

test("a wake listener the user switched off is DISABLED, not broken", async () => {
  const { snap } = await scanWith({
    clientHealth: () => ({
      at: 1_000_000,
      wake: { running: false, expected: false },
      audio: { contextState: "running", outputAvailable: true },
      presentationMode: "full"
    })
  });
  assert.equal(comp(snap, "voice", "wake").status, DISABLED);
  assert.equal(snap.overall, HEALTHY);
});

test("with no dashboard running, wake is UNKNOWN rather than falsely FAILED", async () => {
  const { snap } = await scanWith({ clientHealth: () => null });
  assert.equal(comp(snap, "voice", "wake").status, UNKNOWN);
  assert.equal(comp(snap, "runtime", "webview").status, UNKNOWN);
});

/* --------------------------------------------------- provider degradation */

test("a partly rate-limited brain chain degrades and says which brain is answering", async () => {
  const { snap } = await scanWith({
    brainChainState: () => ({
      current: "groq:b",
      chain: [{ name: "groq:a", available: false, availableInSec: 1800 }, { name: "groq:b", available: true }]
    })
  });
  const c = comp(snap, "ai", "cloud");
  assert.equal(c.status, DEGRADED);
  assert.match(c.summary, /groq:b/);
  assert.equal(c.errorCode, CODES.MODEL_PROVIDER_BENCHED);
});

/* ------------------------------------------------------- fault injection */

test("fault injection can simulate each fault without breaking the machine", async () => {
  const cases = [
    ["wake", "voice", "wake", FAILED],
    ["sttLocal", "voice", "sttLocal", FAILED],
    ["presence", "runtime", "presence", DEGRADED],
    ["disk", "storage", "disk", DEGRADED],
    ["diskCritical", "storage", "disk", FAILED],
    ["gmail", "integrations", "gmail", DEGRADED],
    ["network", "network", "link", FAILED],
    ["accessibility", "computer", "accessibility", FAILED]
  ];
  for (const [fault, cat, name, expected] of cases) {
    const { snap } = await scanWith({ faults: () => new Set([fault]) });
    assert.equal(comp(snap, cat, name).status, expected, `injecting "${fault}" should make ${cat}.${name} ${expected}`);
  }
});

/* -------------------------------------------------------------- recovery */

test("only safe, owned subsystems are marked recoverable", async () => {
  const { snap } = await scanWith();
  const recoverable = [];
  const notRecoverable = [];
  for (const [cat, sub] of Object.entries(snap.subsystems)) {
    for (const [name, c] of Object.entries(sub.components)) {
      (c.recoverable ? recoverable : notRecoverable).push(`${cat}.${name}`);
    }
  }
  // Level 1 is re-arming things Artemis owns in her own process/page.
  assert.deepEqual(recoverable.sort(), ["runtime.presence", "voice.audio", "voice.wake"]);
  // Everything that would need a permission change, a package install or the
  // user's own files must NOT be auto-repairable.
  for (const must of ["computer.accessibility", "computer.screenRecording", "computer.automation",
    "storage.disk", "storage.logs", "storage.data", "integrations.gmail", "voice.sttLocal"]) {
    assert.ok(notRecoverable.includes(must), `${must} must never be auto-repaired`);
  }
});

test("recovering the wake listener asks the dashboard, and nothing else", async () => {
  const { deps, calls } = makeDeps({
    clientHealth: () => ({ at: 1_000_000, wake: { running: false, expected: true }, audio: {}, presentationMode: "full" })
  });
  const health = createSelfHealth({ now: deps.now });
  registerProbes(health, deps);
  await health.scan();
  assert.equal(health.get("voice.wake").status, FAILED);

  await health.recover("voice.wake", "watchdog");
  assert.deepEqual(calls.clientRecovery, ["called"], "recovery is one request to the page Artemis owns");
});
