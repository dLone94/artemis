// The probes: where health stops being a data structure and starts being facts
// about this machine.
//
// Every probe here reads something real — a file on disk, a permission the OS
// reports, a heartbeat timestamp, a cooldown map the router already maintains.
// Nothing is inferred and nothing is asked of a model. If a probe cannot
// establish an answer it returns UNKNOWN rather than guessing HEALTHY, because
// a health system that guesses optimistically is worse than none.
//
// Everything is injected (`deps`) so the whole surface can be tested against
// fakes without a Mac, a microphone or a network
// (test/healthProbes.test.mjs).

import {
  HEALTHY, DEGRADED, FAILED, DISABLED, UNKNOWN, CODES
} from "./selfHealth.js";

/* ------------------------------------------------------------- thresholds */

// Deliberately generous: Artemis writes models, logs and audio scratch files.
// Below LOW she still works but the user should know; below CRITICAL the
// operations that need disk genuinely cannot be relied on.
export const DISK_LOW_BYTES = 2 * 1024 * 1024 * 1024;       // 2 GB  -> DEGRADED
export const DISK_CRITICAL_BYTES = 500 * 1024 * 1024;       // 500 MB -> FAILED
export const LOG_GROWTH_BYTES = 256 * 1024 * 1024;          // 256 MB of logs is a fault, not a feature
export const PRESENCE_STALE_MS = 90 * 1000;                 // no heartbeat in 90s = stale
export const WAKE_REPORT_STALE_MS = 120 * 1000;             // the browser stopped reporting at all

const gb = (n) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;

/**
 * Register every Artemis subsystem against the health manager.
 *
 * @param {ReturnType<import("./selfHealth.js").createSelfHealth>} health
 * @param {object} deps  injected readers; see defaultDeps() in server.js
 */
export function registerProbes(health, deps) {
  const {
    now = () => Date.now(),
    offlineState,                 // () => { offline }
    localSttStatus,               // () => { ready, binary, model, ... }
    sttSelfTest,                  // async () => { ok, error }   (deep)
    permissionSnapshot,           // async () => { accessibility, screenRecording, automation, microphone }
    brainChainState,              // () => { current, chain: [{name, available, availableInSec}] }
    localBrainReachable,          // async () => { ok, model, error }
    cloudBrainProbe,              // async () => { ok, error }   (deep, cloud only)
    gmailConfigured,              // () => boolean
    gmailAuthReady,               // () => boolean
    gmailProbe,                   // async () => { ok, authExpired, error }  (deep, cloud only)
    diskFree,                     // async (path) => { free, total }
    pathWritable,                 // async (path) => boolean
    pathExists,                   // async (path) => boolean
    dirSize,                      // async (path) => bytes
    dataDir, logDir, tmpDir,
    presenceAge,                  // () => ms since last presence update
    clientHealth,                 // () => last report from the browser (see /api/health/report)
    toolRegistryState,            // () => { loaded, names: [], missing: [] }
    skillsState,                  // () => { loaded, error }
    contextState,                 // () => { available }
    ttsState,                     // () => { provider, available }
    sttCloudConfigured,           // () => boolean
    networkReachable,             // async () => boolean   (NEVER called in local-only)
    buildVersion,                 // () => string
    faults = () => new Set()      // dev-only fault injection
  } = deps;

  /** Dev-only fault injection. Returns a forced result, or null. */
  const injected = (name, result) => (faults().has(name) ? result : null);

  const offline = () => {
    try { return !!offlineState().offline; } catch (e) { return false; }
  };

  /* ------------------------------------------------------------- network */

  // Registered FIRST so everything else can depend on it and be attributed to
  // it. This is what turns "five cloud services are down" into "the network
  // is down".
  health.register("network.mode", {
    category: "network",
    label: "network mode",
    probe: () => {
      const off = offline();
      return {
        status: HEALTHY,
        summary: off ? "local-only: cloud is intentionally unavailable" : "hybrid: cloud permitted",
        details: { mode: off ? "local-only" : "hybrid" }
      };
    }
  });

  health.register("network.link", {
    category: "network",
    label: "network",
    probe: async () => {
      const forced = injected("network", { status: FAILED, summary: "network unreachable (injected)", errorCode: CODES.NETWORK_UNAVAILABLE });
      if (forced) return forced;
      // THE offline invariant: in local-only mode Artemis must make zero cloud
      // attempts, and that includes her own diagnostics. Reachability is not
      // probed at all here — it is declared out of scope by policy.
      if (offline()) {
        return { status: DISABLED, summary: "not checked in local-only mode", details: { reason: "mode" } };
      }
      const ok = await networkReachable();
      return ok
        ? { status: HEALTHY, summary: "reachable" }
        : { status: FAILED, summary: "no network connection", errorCode: CODES.NETWORK_UNAVAILABLE };
    }
  });

  /* --------------------------------------------------------------- voice */

  health.register("voice.microphone", {
    category: "voice",
    label: "microphone",
    critical: true,
    probe: async () => {
      const forced = injected("mic", { status: FAILED, summary: "microphone permission missing (injected)", errorCode: CODES.VOICE_MIC_PERMISSION });
      if (forced) return forced;
      const perms = await permissionSnapshot();
      if (perms && perms.microphone === "denied") {
        return {
          status: FAILED,
          summary: "microphone permission is denied",
          errorCode: CODES.VOICE_MIC_PERMISSION,
          details: {
            userActionRequired: true,
            fix: "Grant it in System Settings › Privacy & Security › Microphone"
          }
        };
      }
      const client = clientHealth();
      if (client && client.microphone === "unavailable") {
        return { status: FAILED, summary: "no microphone device available", errorCode: CODES.VOICE_MIC_UNAVAILABLE };
      }
      if (!perms || perms.microphone === "unknown") {
        return { status: UNKNOWN, summary: "microphone permission not established" };
      }
      return { status: HEALTHY, summary: "granted" };
    }
  });

  health.register("voice.wake", {
    category: "voice",
    label: "wake listener",
    critical: true,
    dependsOn: "voice.microphone",
    probe: () => {
      const forced = injected("wake", { status: FAILED, summary: "wake listener stopped (injected)", errorCode: CODES.VOICE_WAKE_HELPER_DEAD });
      if (forced) return forced;
      const client = clientHealth();
      // The wake listener lives in the browser. No report at all means the
      // dashboard is not running, which is a runtime question, not a wake one.
      if (!client) return { status: UNKNOWN, summary: "no report from the dashboard yet" };
      if (now() - client.at > WAKE_REPORT_STALE_MS) {
        return { status: UNKNOWN, summary: "the dashboard has stopped reporting" };
      }
      const w = client.wake || {};
      if (w.expected === false) {
        return { status: DISABLED, summary: "wake word intentionally off", details: { reason: "user" } };
      }
      if (!w.running) {
        return { status: FAILED, summary: "wake listener is not armed", errorCode: CODES.VOICE_WAKE_NOT_ARMED };
      }
      if (w.stalled) {
        // The exact fault the AudioContext bug produced: running, but deaf.
        return {
          status: FAILED,
          summary: "wake listener is armed but no audio is reaching it",
          errorCode: CODES.VOICE_WAKE_STALLED,
          details: { msSinceFrame: w.msSinceFrame, healRetries: w.healRetries }
        };
      }
      return { status: HEALTHY, summary: "armed and hearing audio", details: { framesSeen: w.framesSeen } };
    },
    recovery: {
      description: "re-arm the wake listener in the dashboard",
      maxAttempts: 3,
      cooldownMs: 60_000,
      // Level 1: the manager only ever asks the browser to re-arm its own
      // listener. It cannot reach a shell, a permission or a package manager.
      attempt: async () => deps.requestClientRecovery("wake")
    }
  });

  health.register("voice.sttLocal", {
    category: "voice",
    label: "local speech recognition",
    probe: () => {
      const forced = injected("sttLocal", { status: FAILED, summary: "local speech engine unavailable (injected)", errorCode: CODES.STT_LOCAL_MODEL_MISSING });
      if (forced) return forced;
      const s = localSttStatus();
      if (!s || s.binaryReady === false || (s.binary && s.binaryExists === false)) {
        return { status: DEGRADED, summary: "whisper binary is missing — run npm run setup:stt", errorCode: CODES.STT_LOCAL_BINARY_MISSING };
      }
      if (!s.ready) {
        // Distinguish the two ways "not ready" happens, because the fix differs.
        const missingModel = s.modelExists === false || /model/i.test(String(s.reason || ""));
        return missingModel
          ? { status: DEGRADED, summary: "the local speech model is not installed", errorCode: CODES.STT_LOCAL_MODEL_MISSING, details: { tier: s.tier } }
          : { status: DEGRADED, summary: "local speech recognition is unavailable", errorCode: CODES.STT_LOCAL_BINARY_MISSING };
      }
      return { status: HEALTHY, summary: `ready (${s.tier || "balanced"})`, details: { tier: s.tier } };
    },
    // DEEP: actually transcribe. Real work, so it only runs on a full diagnostic.
    deepProbe: async () => {
      const s = localSttStatus();
      if (!s || !s.ready) {
        return { status: DEGRADED, summary: "the local speech model is not installed", errorCode: CODES.STT_LOCAL_MODEL_MISSING };
      }
      const r = await sttSelfTest();
      return r && r.ok
        ? { status: HEALTHY, summary: "transcribed a test clip", details: { msElapsed: r.msElapsed } }
        : { status: FAILED, summary: "the local speech engine failed a test transcription", errorCode: CODES.STT_LOCAL_PROCESS_FAILURE };
    }
  });

  health.register("voice.sttCloud", {
    category: "voice",
    label: "cloud speech recognition",
    dependsOn: "network.link",
    probe: () => {
      if (offline()) return { status: DISABLED, summary: "disabled by local-only mode", details: { reason: "mode" } };
      if (!sttCloudConfigured()) return { status: DISABLED, summary: "not configured", details: { reason: "unconfigured" } };
      return { status: HEALTHY, summary: "configured" };
    }
  });

  health.register("voice.tts", {
    category: "voice",
    label: "speech output",
    dependsOn: "network.link",
    probe: () => {
      const forced = injected("tts", { status: DEGRADED, summary: "speech output unavailable (injected)", errorCode: CODES.TTS_UNAVAILABLE });
      if (forced) return forced;
      const t = ttsState();
      if (!t || !t.available) {
        return { status: DEGRADED, summary: "no speech output provider is available", errorCode: CODES.TTS_UNAVAILABLE };
      }
      return { status: HEALTHY, summary: `using ${t.provider}`, details: { provider: t.provider } };
    }
  });

  health.register("voice.audio", {
    category: "voice",
    label: "audio engine",
    probe: () => {
      const client = clientHealth();
      if (!client) return { status: UNKNOWN, summary: "no report from the dashboard yet" };
      const a = client.audio || {};
      if (a.contextState === "suspended" && a.expectRunning) {
        // Exactly the class of fault that made the wake word silently deaf.
        return { status: DEGRADED, summary: "the audio engine is suspended", errorCode: CODES.VOICE_AUDIO_STUCK };
      }
      if (a.outputAvailable === false) {
        return { status: DEGRADED, summary: "no audio output device", errorCode: CODES.VOICE_AUDIO_STUCK };
      }
      return { status: HEALTHY, summary: "running" };
    },
    recovery: {
      description: "resume the audio context",
      maxAttempts: 3,
      cooldownMs: 60_000,
      attempt: async () => deps.requestClientRecovery("audio")
    }
  });

  /* ------------------------------------------------------------------ ai */

  health.register("ai.local", {
    category: "ai",
    label: "local model",
    probe: async () => {
      const forced = injected("localModel", { status: FAILED, summary: "local model unreachable (injected)", errorCode: CODES.MODEL_LOCAL_UNREACHABLE });
      if (forced) return forced;
      // A loopback endpoint is allowed in every mode, including local-only —
      // that is the entire point of having one.
      const r = await localBrainReachable();
      if (!r) return { status: UNKNOWN, summary: "not established" };
      if (r.notConfigured) return { status: DISABLED, summary: "no local model configured", details: { reason: "unconfigured" } };
      if (!r.ok) {
        return { status: offline() ? FAILED : DEGRADED,
          summary: "the local model service is not responding",
          errorCode: CODES.MODEL_LOCAL_UNREACHABLE };
      }
      if (r.modelMissing) {
        return { status: DEGRADED, summary: `the configured local model is not installed`, errorCode: CODES.MODEL_MISSING, details: { model: r.model } };
      }
      return { status: HEALTHY, summary: `${r.model} responding`, details: { model: r.model } };
    }
  });

  health.register("ai.cloud", {
    category: "ai",
    label: "cloud models",
    dependsOn: "network.link",
    probe: () => {
      const forced = injected("cloudModel", { status: DEGRADED, summary: "all cloud brains benched (injected)", errorCode: CODES.MODEL_PROVIDER_BENCHED });
      if (forced) return forced;
      if (offline()) return { status: DISABLED, summary: "disabled by local-only mode", details: { reason: "mode" } };
      const s = brainChainState();
      if (!s || !s.chain || !s.chain.length) return { status: DISABLED, summary: "no cloud models configured", details: { reason: "unconfigured" } };
      const up = s.chain.filter((b) => b.available);
      if (!up.length) {
        const soonest = Math.min(...s.chain.map((b) => (b.availableInSec == null ? Infinity : b.availableInSec)));
        return {
          status: DEGRADED,
          summary: Number.isFinite(soonest)
            ? `every cloud model is rate-limited; the next returns in about ${Math.round(soonest / 60)} minutes`
            : "every cloud model is currently unavailable",
          errorCode: CODES.MODEL_PROVIDER_BENCHED,
          details: { benched: s.chain.length }
        };
      }
      if (up.length < s.chain.length) {
        return {
          status: DEGRADED,
          summary: `answering on ${s.current}; ${s.chain.length - up.length} of ${s.chain.length} models are rate-limited`,
          errorCode: CODES.MODEL_PROVIDER_BENCHED,
          details: { current: s.current, available: up.length, total: s.chain.length }
        };
      }
      return { status: HEALTHY, summary: `${s.current} answering`, details: { current: s.current } };
    },
    deepProbe: async () => {
      if (offline()) return { status: DISABLED, summary: "disabled by local-only mode", details: { reason: "mode" } };
      const r = await cloudBrainProbe();
      return r && r.ok
        ? { status: HEALTHY, summary: "answered a test prompt" }
        : { status: DEGRADED, summary: "the cloud model did not answer a test prompt", errorCode: CODES.MODEL_PROVIDER_BENCHED };
    }
  });

  /* ------------------------------------------------------------- runtime */

  health.register("runtime.server", {
    category: "runtime",
    label: "server",
    critical: true,
    // If this code is running, the server is up. What is worth checking is that
    // it is the build we think it is.
    probe: () => ({ status: HEALTHY, summary: "running", details: { build: buildVersion() } })
  });

  health.register("runtime.presence", {
    category: "runtime",
    label: "presence bus",
    probe: () => {
      const forced = injected("presence", { status: DEGRADED, summary: "presence heartbeat stale (injected)", errorCode: CODES.RUNTIME_PRESENCE_STALE });
      if (forced) return forced;
      const age = presenceAge();
      if (age == null) return { status: UNKNOWN, summary: "no presence activity yet" };
      if (age > PRESENCE_STALE_MS) {
        return {
          status: DEGRADED,
          summary: `no presence update in ${Math.round(age / 1000)} seconds`,
          errorCode: CODES.RUNTIME_PRESENCE_STALE,
          details: { ageMs: age }
        };
      }
      return { status: HEALTHY, summary: "live" };
    },
    recovery: {
      description: "ask the dashboard to reconnect its presence stream",
      maxAttempts: 3,
      cooldownMs: 60_000,
      attempt: async () => deps.requestClientRecovery("presence")
    }
  });

  health.register("runtime.webview", {
    category: "runtime",
    label: "dashboard",
    probe: () => {
      const client = clientHealth();
      if (!client) return { status: UNKNOWN, summary: "the dashboard has not reported in" };
      const age = now() - client.at;
      if (age > WAKE_REPORT_STALE_MS) {
        return { status: DEGRADED, summary: "the dashboard stopped reporting", errorCode: CODES.RUNTIME_WEBVIEW_DISCONNECTED, details: { ageMs: age } };
      }
      return { status: HEALTHY, summary: "connected" };
    }
  });

  health.register("runtime.tools", {
    category: "runtime",
    label: "tool registry",
    critical: true,
    probe: () => {
      const t = toolRegistryState();
      if (!t || !t.loaded) return { status: FAILED, summary: "the tool registry did not load", errorCode: CODES.RUNTIME_TOOLS_INCOMPLETE };
      if (t.missing && t.missing.length) {
        return {
          status: FAILED,
          summary: `${t.missing.length} critical tools are not registered`,
          errorCode: CODES.RUNTIME_TOOLS_INCOMPLETE,
          details: { missing: t.missing }
        };
      }
      return { status: HEALTHY, summary: `${t.count} tools registered` };
    }
  });

  health.register("runtime.skills", {
    category: "runtime",
    label: "skills",
    probe: () => {
      const s = skillsState();
      if (!s || !s.loaded) {
        return { status: FAILED, summary: "the skills registry did not load", errorCode: CODES.RUNTIME_SKILLS_ERROR, details: { error: s && s.error } };
      }
      return { status: HEALTHY, summary: "loaded" };
    }
  });

  health.register("runtime.context", {
    category: "runtime",
    label: "working context",
    probe: () => {
      const c = contextState();
      return c && c.available
        ? { status: HEALTHY, summary: "available" }
        : { status: DEGRADED, summary: "the working context is unavailable", errorCode: CODES.RUNTIME_CONTEXT_UNAVAILABLE };
    }
  });

  health.register("runtime.pill", {
    category: "runtime",
    label: "floating pill",
    probe: () => {
      const client = clientHealth();
      if (!client) return { status: UNKNOWN, summary: "no report yet" };
      // Only meaningful when the current presentation actually uses it.
      if (client.presentationMode !== "pill") {
        return { status: DISABLED, summary: "not in pill mode", details: { reason: "mode" } };
      }
      return client.pillConnected
        ? { status: HEALTHY, summary: "connected" }
        : { status: DEGRADED, summary: "the floating pill is not responding", errorCode: CODES.RUNTIME_PILL_DISCONNECTED };
    }
  });

  /* ------------------------------------------------------------ computer */

  const permissionProbe = (key, code, label) => async () => {
    const forced = injected(key, { status: FAILED, summary: `${label} permission missing (injected)`, errorCode: code });
    if (forced) return forced;
    const perms = await permissionSnapshot();
    if (!perms || perms[key] === "unknown" || perms[key] == null) {
      return { status: UNKNOWN, summary: `${label} permission not established` };
    }
    if (perms[key] === "granted") return { status: HEALTHY, summary: "granted" };
    // Reported, never repaired. Changing a security permission is a Level 3
    // action and belongs to the user alone.
    //
    // The summary stays short because it gets SPOKEN; the remedy lives in
    // details, where the full diagnostic and the UI tooltip can show it. A
    // sentence long enough to include the whole Settings path reads terribly
    // in a two-issue spoken summary.
    return {
      status: FAILED,
      summary: `${label} permission is missing`,
      errorCode: code,
      details: {
        userActionRequired: true,
        fix: `Grant it in System Settings › Privacy & Security › ${label}`
      }
    };
  };

  health.register("computer.accessibility", {
    category: "computer",
    label: "Accessibility",
    probe: permissionProbe("accessibility", CODES.PERMISSION_ACCESSIBILITY_MISSING, "Accessibility")
  });
  health.register("computer.screenRecording", {
    category: "computer",
    label: "Screen Recording",
    probe: permissionProbe("screenRecording", CODES.PERMISSION_SCREEN_RECORDING_MISSING, "Screen Recording")
  });
  health.register("computer.automation", {
    category: "computer",
    label: "Automation",
    probe: permissionProbe("automation", CODES.PERMISSION_AUTOMATION_MISSING, "Automation")
  });

  health.register("computer.terminal", {
    category: "computer",
    label: "Terminal control",
    dependsOn: "computer.automation",
    probe: () => {
      const client = clientHealth();
      const stuck = client && client.terminalBusySince && now() - client.terminalBusySince > 5 * 60 * 1000;
      if (stuck) {
        return { status: DEGRADED, summary: "a Terminal session has been held open for over five minutes", errorCode: CODES.TERMINAL_UNAVAILABLE };
      }
      return { status: HEALTHY, summary: "available" };
    }
  });

  health.register("computer.perception", {
    category: "computer",
    label: "screen reading",
    dependsOn: "computer.screenRecording",
    probe: async () => {
      const ok = await pathExists(deps.ocrHelperPath);
      return ok
        ? { status: HEALTHY, summary: "OCR helper present" }
        : { status: DEGRADED, summary: "the screen-reading helper is missing", errorCode: CODES.PERCEPTION_OCR_MISSING };
    }
  });

  /* ------------------------------------------------------------- storage */

  health.register("storage.data", {
    category: "storage",
    label: "data directory",
    critical: true,
    probe: async () => {
      const ok = await pathWritable(dataDir);
      return ok
        ? { status: HEALTHY, summary: "writable" }
        : { status: FAILED, summary: "the data directory is not writable", errorCode: CODES.STORAGE_NOT_WRITABLE };
    }
  });

  health.register("storage.disk", {
    category: "storage",
    label: "disk space",
    probe: async () => {
      const forced = injected("disk", { status: DEGRADED, summary: "low disk space (injected)", errorCode: CODES.STORAGE_LOW_SPACE });
      if (forced) return forced;
      const injectedCritical = injected("diskCritical", {
        status: FAILED, summary: "critically low disk space (injected)", errorCode: CODES.STORAGE_CRITICAL_SPACE
      });
      if (injectedCritical) return injectedCritical;

      const d = await diskFree(dataDir);
      if (!d || !Number.isFinite(d.free)) return { status: UNKNOWN, summary: "disk space could not be established" };
      if (d.free < DISK_CRITICAL_BYTES) {
        return {
          status: FAILED,
          summary: `only ${gb(d.free)} of disk space left — recording and models will fail`,
          errorCode: CODES.STORAGE_CRITICAL_SPACE,
          details: { freeBytes: d.free }
        };
      }
      if (d.free < DISK_LOW_BYTES) {
        return {
          status: DEGRADED,
          summary: `disk space is low (${gb(d.free)} free)`,
          errorCode: CODES.STORAGE_LOW_SPACE,
          details: { freeBytes: d.free }
        };
      }
      return { status: HEALTHY, summary: `${gb(d.free)} free`, details: { freeBytes: d.free } };
    }
  });

  health.register("storage.logs", {
    category: "storage",
    label: "logs",
    probe: async () => {
      // No log directory is not a fault. Logs are written by the native shell;
      // running headless there may simply be none, and reporting that as
      // "degraded" would be inventing a requirement Artemis does not have.
      if (!(await pathExists(logDir))) {
        return { status: DISABLED, summary: "no log directory in use", details: { reason: "unconfigured" } };
      }
      const writable = await pathWritable(logDir);
      if (!writable) return { status: DEGRADED, summary: "the log directory is not writable", errorCode: CODES.STORAGE_NOT_WRITABLE };
      const size = await dirSize(logDir);
      if (Number.isFinite(size) && size > LOG_GROWTH_BYTES) {
        // Reported, never auto-deleted: these are the user's files.
        return {
          status: DEGRADED,
          summary: `logs have grown to ${gb(size)}`,
          errorCode: CODES.STORAGE_LOG_GROWTH,
          details: { bytes: size, userActionRequired: true }
        };
      }
      return { status: HEALTHY, summary: "writable" };
    }
  });

  health.register("storage.temp", {
    category: "storage",
    label: "temp directory",
    probe: async () => {
      const ok = await pathWritable(tmpDir);
      return ok
        ? { status: HEALTHY, summary: "writable" }
        : { status: DEGRADED, summary: "the temp directory is not writable", errorCode: CODES.STORAGE_NOT_WRITABLE };
    }
  });

  /* -------------------------------------------------------- integrations */

  health.register("integrations.gmail", {
    category: "integrations",
    label: "Gmail",
    dependsOn: "network.link",
    probe: () => {
      const forced = injected("gmail", { status: DEGRADED, summary: "Gmail sign-in has expired (injected)", errorCode: CODES.INTEGRATION_AUTH_EXPIRED });
      if (forced) return forced;
      // Something the user never set up is not a fault. Reporting it as one is
      // how a health summary becomes noise the user learns to ignore.
      if (!gmailConfigured()) return { status: DISABLED, summary: "not configured", details: { reason: "unconfigured" } };
      if (offline()) return { status: DISABLED, summary: "disabled by local-only mode", details: { reason: "mode" } };
      if (!gmailAuthReady()) {
        return {
          status: DEGRADED,
          summary: "Gmail sign-in has expired — reconnect it from the dashboard",
          errorCode: CODES.INTEGRATION_AUTH_EXPIRED,
          details: { userActionRequired: true }
        };
      }
      return { status: HEALTHY, summary: "connected" };
    },
    deepProbe: async () => {
      if (!gmailConfigured()) return { status: DISABLED, summary: "not configured", details: { reason: "unconfigured" } };
      if (offline()) return { status: DISABLED, summary: "disabled by local-only mode", details: { reason: "mode" } };
      const r = await gmailProbe();
      if (r && r.ok) return { status: HEALTHY, summary: "connected" };
      return {
        status: DEGRADED,
        summary: r && r.authExpired
          ? "Gmail sign-in has expired — reconnect it from the dashboard"
          : "Gmail did not respond",
        errorCode: CODES.INTEGRATION_AUTH_EXPIRED,
        details: { userActionRequired: true }
      };
    }
  });

  return health;
}
