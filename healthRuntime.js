// Wiring: the health manager, the real readers it needs, the startup check and
// the watchdog — assembled in one place so server.js stays a thin integration
// and this whole layer can be driven by tests.
//
// The watchdog's shape is the important part. Polling everything on one fast
// timer would make health monitoring itself a performance problem, so each
// component is scheduled at the rate its failure mode actually warrants: a
// wake listener that has gone deaf should be caught in seconds, while disk
// space has not meaningfully changed since a quarter of an hour ago.

import { promises as fs, constants as FS } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSelfHealth, HEALTHY, FAILED, DEGRADED, RECOVERING } from "./selfHealth.js";
import { registerProbes } from "./healthProbes.js";
import { recoveredAnnouncement } from "./healthIntent.js";

/**
 * How often each component is re-checked by the background watchdog.
 * Everything here is a LIGHTWEIGHT probe; deep checks never run on a timer.
 */
export const SCHEDULE = [
  // Fast: the failures that silently cost the user a working assistant.
  { everyMs: 20_000, ids: ["voice.wake", "voice.audio", "runtime.presence", "runtime.webview"] },
  // Medium: cheap in-process facts.
  { everyMs: 60_000, ids: ["network.mode", "runtime.server", "runtime.tools", "runtime.skills", "runtime.context", "runtime.pill", "voice.microphone"] },
  // Slow: anything that shells out or reaches a service.
  { everyMs: 300_000, ids: ["voice.sttLocal", "voice.sttCloud", "voice.tts", "ai.local", "ai.cloud", "network.link", "integrations.gmail",
    "computer.accessibility", "computer.screenRecording", "computer.automation", "computer.terminal", "computer.perception"] },
  // Rare: disk does not change quickly, and statfs is not free.
  { everyMs: 900_000, ids: ["storage.data", "storage.disk", "storage.logs", "storage.temp"] }
];

const RECOVERY_VERIFY_MS = 8000;   // how long a client recovery gets to prove itself
const RECOVERY_POLL_MS = 250;

/**
 * @param {object} hooks  everything this layer needs FROM the server, injected
 *   so no server internals are imported here.
 */
export function createHealthRuntime(hooks) {
  const {
    now = () => Date.now(),
    log = () => {},
    broadcast,                 // (event, data) => void — presence bus
    dataDir,
    logDir = join(dataDir, "logs"),
    ocrHelperPath,
    offlineState,
    localSttStatus,
    transcribeLocal,           // for the deep STT selftest
    permissionSnapshot,
    brainChainState,
    localBrainConfig,          // () => { model, base } | null
    cloudBrainProbe,
    gmailConfigured,
    gmailAuthReady,
    gmailProbe,
    presenceUpdatedAt,         // () => epoch ms of last presence change
    toolNames,                 // () => string[] of registered tool names
    skillsLoaded,              // () => boolean
    contextAvailable,          // () => boolean
    ttsState,
    sttCloudConfigured,
    buildVersion,
    fetchImpl = globalThis.fetch,
    devFaultsEnabled = false
  } = hooks;

  /* --------------------------------------------------- injected fault set */

  // Development only. Gated at construction AND at every mutation, so a
  // production build has no way to reach it even if a request arrives.
  const faultSet = new Set();
  const faults = () => faultSet;

  /* ------------------------------------------------ what the browser knows */

  // The wake listener, audio engine and pill live in the page, not here. The
  // dashboard posts its own state and the server treats it as evidence with an
  // age — never as something to be assumed still true.
  let clientReport = null;
  function reportClient(payload) {
    if (!payload || typeof payload !== "object") return false;
    clientReport = {
      at: now(),
      wake: payload.wake || null,
      audio: payload.audio || null,
      microphone: payload.microphone || null,
      presentationMode: payload.presentationMode || null,
      pillConnected: !!payload.pillConnected,
      terminalBusySince: payload.terminalBusySince || null
    };
    return true;
  }
  const clientHealth = () => clientReport;

  /* --------------------------------------------------- filesystem readers */

  async function pathExists(p) {
    if (!p) return false;
    try { await fs.access(p, FS.F_OK); return true; } catch (e) { return false; }
  }
  async function pathWritable(p) {
    if (!p) return false;
    try { await fs.access(p, FS.W_OK); return true; } catch (e) { return false; }
  }
  async function diskFree(p) {
    try {
      const s = await fs.statfs(p);
      return { free: s.bsize * s.bavail, total: s.bsize * s.blocks };
    } catch (e) {
      return null;
    }
  }
  async function dirSize(p) {
    try {
      const entries = await fs.readdir(p, { withFileTypes: true });
      let total = 0;
      // Shallow and capped: measuring log growth must not itself become an
      // expensive recursive walk of a large directory.
      for (const e of entries.slice(0, 500)) {
        if (!e.isFile()) continue;
        try { total += (await fs.stat(join(p, e.name))).size; } catch (err) { /* vanished mid-scan */ }
      }
      return total;
    } catch (e) {
      return NaN;
    }
  }

  /* ------------------------------------------------------- model readers */

  async function localBrainReachable() {
    const cfg = localBrainConfig();
    if (!cfg || !cfg.model) return { notConfigured: true };
    try {
      // Loopback only. This is allowed in every mode INCLUDING local-only —
      // a local endpoint is not a cloud call, which is the whole point of it.
      const base = String(cfg.base || "").replace(/\/v1\/?$/, "");
      const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { ok: false };
      const body = await res.json().catch(() => null);
      const models = (body && body.models ? body.models : []).map((m) => String(m.name || m.model || ""));
      const wanted = String(cfg.model);
      const present = models.some((m) => m === wanted || m.split(":")[0] === wanted.split(":")[0]);
      return { ok: true, model: wanted, modelMissing: models.length > 0 && !present };
    } catch (e) {
      return { ok: false };
    }
  }

  async function networkReachable() {
    try {
      // A HEAD to a stable endpoint, short timeout. Only ever reached when the
      // mode permits it — healthProbes checks the policy before calling this.
      const res = await fetchImpl("https://www.gstatic.com/generate_204", {
        method: "HEAD",
        signal: AbortSignal.timeout(3000)
      });
      return res.status >= 200 && res.status < 400;
    } catch (e) {
      return false;
    }
  }

  /** Deep STT check: transcribe a short generated clip end to end. */
  async function sttSelfTest() {
    const started = now();
    try {
      // A second of near-silence is enough to prove the binary runs, loads the
      // model and returns — without needing an audio fixture in the repo.
      const samples = 16000;
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 40) * 600), i * 2);
      const r = await transcribeLocal(pcm, { language: "en" });
      return { ok: !!r && typeof r.transcript === "string", msElapsed: now() - started };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  }

  /* ----------------------------------------------------- client recovery */

  /**
   * Ask the dashboard to repair something it owns, then VERIFY it worked.
   *
   * Fire-and-forget would let the manager mark a subsystem healthy on the
   * strength of having asked, which is exactly the fake-health failure this
   * whole system exists to avoid. Recovery counts only if the next client
   * report actually shows the subsystem alive.
   */
  async function requestClientRecovery(target) {
    if (typeof broadcast !== "function") return false;
    const before = clientReport ? clientReport.at : 0;
    broadcast("health-recover", { target, at: now() });

    const deadline = Date.now() + RECOVERY_VERIFY_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RECOVERY_POLL_MS));
      const c = clientReport;
      if (!c || c.at <= before) continue;          // no fresh evidence yet
      if (target === "wake") {
        if (c.wake && c.wake.running && !c.wake.stalled) return true;
      } else if (target === "audio") {
        if (c.audio && c.audio.contextState === "running") return true;
      } else if (target === "presence") {
        return true;                                // a fresh report IS the reconnection
      }
    }
    return false;
  }

  /* ----------------------------------------------------------- assembly */

  const health = createSelfHealth({ now, log, maxHistory: 120 });

  registerProbes(health, {
    now,
    offlineState,
    localSttStatus,
    sttSelfTest,
    permissionSnapshot,
    brainChainState,
    localBrainReachable,
    cloudBrainProbe,
    gmailConfigured,
    gmailAuthReady,
    gmailProbe,
    diskFree,
    pathWritable,
    pathExists,
    dirSize,
    dataDir,
    logDir,
    tmpDir: tmpdir(),
    ocrHelperPath,
    presenceAge: () => {
      const at = presenceUpdatedAt();
      return at ? now() - at : null;
    },
    clientHealth,
    toolRegistryState: () => {
      try {
        const names = toolNames();
        // A registry that loaded but lost a critical tool is a silent disaster:
        // the model simply stops being able to do that thing and says something
        // plausible instead.
        const REQUIRED = ["run_command", "read_email", "send_message", "computer_control"];
        const missing = REQUIRED.filter((r) => !names.includes(r));
        return { loaded: true, count: names.length, missing };
      } catch (e) {
        return { loaded: false, error: String(e && e.message) };
      }
    },
    skillsState: () => ({ loaded: skillsLoaded() }),
    contextState: () => ({ available: contextAvailable() }),
    ttsState,
    sttCloudConfigured,
    networkReachable,
    buildVersion,
    faults,
    requestClientRecovery
  });

  /* ------------------------------------------------------- startup check */

  let startupMs = null;

  /** Lightweight scan at boot. Must not meaningfully delay startup. */
  async function startupCheck() {
    const t0 = now();
    await health.scan();                      // quick probes only
    startupMs = now() - t0;
    const snap = health.snapshot();
    log({ kind: "startup-check", durationMs: startupMs, overall: snap.overall, issues: snap.issueCount });
    // Try to fix what she can before saying anything, so a transient fault
    // never becomes a spoken complaint about a problem already gone.
    if (snap.issues.some((i) => i.status === FAILED || i.status === DEGRADED)) {
      await health.recoverAll("startup");
    }
    return { snapshot: health.snapshot(), durationMs: startupMs };
  }

  /* ----------------------------------------------------------- watchdog */

  let timer = null;
  const lastRun = new Map();
  /** Components recovered since the last time anyone asked. */
  const recovered = [];

  async function tick() {
    const t = now();
    const due = [];
    for (const tier of SCHEDULE) {
      for (const id of tier.ids) {
        const last = lastRun.get(id) || 0;
        if (t - last >= tier.everyMs) { due.push(id); lastRun.set(id, t); }
      }
    }
    if (!due.length) return;
    const before = health.snapshot().overall;
    await health.scan({ only: due });

    // Level 1 recovery, silent by design: a wake listener that drops and comes
    // straight back is not worth interrupting the user for.
    for (const id of due) {
      const state = health.get(id);
      if (!state || (state.status !== FAILED && state.status !== DEGRADED)) continue;
      const before = state.status;
      const result = await health.recover(id, "watchdog");
      if (result.attempted && result.ok) {
        recovered.push({ id, at: now(), from: state.status });
      }
    }

    // Push a fresh summary to the UI only when the headline actually moved.
    // Broadcasting an unchanged badge every tick is the "fake telemetry" this
    // system is supposed to avoid.
    const after = health.snapshot();
    if (after.overall !== before && typeof hooks.onHealthChange === "function") {
      hooks.onHealthChange(after);
    }
  }

  function startWatchdog(intervalMs = 10_000) {
    stopWatchdog();
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();   // never hold the process open
    return timer;
  }
  function stopWatchdog() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Recoveries worth telling the user about, drained on read. */
  function drainRecovered() {
    const out = recovered.splice(0, recovered.length);
    return out.map((r) => ({ ...r, message: recoveredAnnouncement(labelOf(r.id)) }));
  }
  function labelOf(id) {
    const snap = health.snapshot();
    for (const sub of Object.values(snap.subsystems)) {
      for (const [, c] of Object.entries(sub.components)) {
        if (c.label && id.endsWith(c.label.replace(/\s+/g, ""))) return c.label;
      }
    }
    return id.split(".").pop();
  }

  return {
    health,
    startupCheck,
    startWatchdog,
    stopWatchdog,
    tick,
    reportClient,
    clientHealth,
    drainRecovered,
    snapshot: () => health.snapshot(),
    runQuick: async () => { await health.scan(); return health.snapshot(); },
    runDeep: async () => { await health.scan({ deep: true }); return health.snapshot(); },
    startupDurationMs: () => startupMs,
    // Dev-only fault injection.
    faultsEnabled: devFaultsEnabled,
    setFault(name) { if (!devFaultsEnabled) return false; faultSet.add(String(name)); return true; },
    clearFault(name) {
      if (!devFaultsEnabled) return false;
      if (name) faultSet.delete(String(name)); else faultSet.clear();
      return true;
    },
    activeFaults: () => [...faultSet]
  };
}
