// SelfHealthManager — the one authoritative owner of "is Artemis working?"
//
// The point of this file is that health state lives in ONE place with ONE
// vocabulary. Before it, the honest answer to "is your wake listener alive?"
// was scattered across a browser module, a server cooldown map and a Swift
// controller, and nothing could combine them into a single truth.
//
// Three rules shape the whole design:
//
//   1. It is DETERMINISTIC. Probes read real state — a file exists, a process
//      answered, a permission is granted, a heartbeat is N seconds old. No
//      model is ever asked whether a subsystem works, because a model would
//      happily invent an answer and this is the one place that must not.
//
//   2. DISABLED is not FAILED. Cloud providers turned off by LOCAL-ONLY mode
//      are working exactly as intended, and reporting them as broken would
//      train the user to ignore the health summary entirely.
//
//   3. One root cause is ONE issue. A dropped network in hybrid mode must not
//      surface as five independent failures; dependants are attributed to the
//      dependency and excluded from the user-facing count.
//
// Pure and dependency-free: every clock, probe and log sink is injected, so
// the whole thing is exercisable without touching a real machine
// (test/selfHealth.test.mjs).

import { redactSecrets } from "./redaction.js";

/* ------------------------------------------------------------------ states */

export const HEALTHY = "HEALTHY";
export const DEGRADED = "DEGRADED";
export const FAILED = "FAILED";
export const RECOVERING = "RECOVERING";
export const DISABLED = "DISABLED";
export const UNKNOWN = "UNKNOWN";

export const STATUSES = Object.freeze([HEALTHY, DEGRADED, FAILED, RECOVERING, DISABLED, UNKNOWN]);

/**
 * How bad each state is, for rolling components up into an overall verdict.
 *
 * DISABLED and UNKNOWN deliberately sit at -1: they are excluded from the roll
 * up rather than ranked within it. A subsystem that is off by configuration is
 * not evidence of ill health, and "not checked yet" is not evidence either.
 */
const SEVERITY = { [HEALTHY]: 0, [RECOVERING]: 1, [DEGRADED]: 2, [FAILED]: 3, [DISABLED]: -1, [UNKNOWN]: -1 };

/** Does this state count as something actually wrong? */
export function isProblem(status) {
  return status === DEGRADED || status === FAILED || status === RECOVERING;
}

/* ------------------------------------------------------------- error codes */

// Stable identifiers, so a log line from six months ago still means something
// and support questions can be answered by grep rather than by memory.
export const CODES = Object.freeze({
  VOICE_MIC_PERMISSION: "VOICE_MIC_PERMISSION",
  VOICE_MIC_UNAVAILABLE: "VOICE_MIC_UNAVAILABLE",
  VOICE_WAKE_NOT_ARMED: "VOICE_WAKE_NOT_ARMED",
  VOICE_WAKE_STALLED: "VOICE_WAKE_STALLED",
  VOICE_WAKE_HELPER_DEAD: "VOICE_WAKE_HELPER_DEAD",
  VOICE_AUDIO_STUCK: "VOICE_AUDIO_STUCK",
  STT_LOCAL_MODEL_MISSING: "STT_LOCAL_MODEL_MISSING",
  STT_LOCAL_BINARY_MISSING: "STT_LOCAL_BINARY_MISSING",
  STT_LOCAL_PROCESS_FAILURE: "STT_LOCAL_PROCESS_FAILURE",
  STT_CLOUD_UNCONFIGURED: "STT_CLOUD_UNCONFIGURED",
  TTS_UNAVAILABLE: "TTS_UNAVAILABLE",
  MODEL_LOCAL_UNREACHABLE: "MODEL_LOCAL_UNREACHABLE",
  MODEL_MISSING: "MODEL_MISSING",
  MODEL_PROVIDER_BENCHED: "MODEL_PROVIDER_BENCHED",
  RUNTIME_SERVER_DOWN: "RUNTIME_SERVER_DOWN",
  RUNTIME_PRESENCE_STALE: "RUNTIME_PRESENCE_STALE",
  RUNTIME_WEBVIEW_DISCONNECTED: "RUNTIME_WEBVIEW_DISCONNECTED",
  RUNTIME_TOOLS_INCOMPLETE: "RUNTIME_TOOLS_INCOMPLETE",
  RUNTIME_SKILLS_ERROR: "RUNTIME_SKILLS_ERROR",
  RUNTIME_CONTEXT_UNAVAILABLE: "RUNTIME_CONTEXT_UNAVAILABLE",
  RUNTIME_PILL_DISCONNECTED: "RUNTIME_PILL_DISCONNECTED",
  PERMISSION_ACCESSIBILITY_MISSING: "PERMISSION_ACCESSIBILITY_MISSING",
  PERMISSION_SCREEN_RECORDING_MISSING: "PERMISSION_SCREEN_RECORDING_MISSING",
  PERMISSION_AUTOMATION_MISSING: "PERMISSION_AUTOMATION_MISSING",
  PERCEPTION_OCR_MISSING: "PERCEPTION_OCR_MISSING",
  TERMINAL_UNAVAILABLE: "TERMINAL_UNAVAILABLE",
  STORAGE_LOW_SPACE: "STORAGE_LOW_SPACE",
  STORAGE_CRITICAL_SPACE: "STORAGE_CRITICAL_SPACE",
  STORAGE_NOT_WRITABLE: "STORAGE_NOT_WRITABLE",
  STORAGE_LOG_GROWTH: "STORAGE_LOG_GROWTH",
  INTEGRATION_AUTH_EXPIRED: "INTEGRATION_AUTH_EXPIRED",
  INTEGRATION_UNCONFIGURED: "INTEGRATION_UNCONFIGURED",
  NETWORK_UNAVAILABLE: "NETWORK_UNAVAILABLE",
  POLICY_VIOLATION_CLOUD_IN_LOCAL_ONLY: "POLICY_VIOLATION_CLOUD_IN_LOCAL_ONLY",
  PROBE_ERROR: "PROBE_ERROR"
});

/* -------------------------------------------------------------- categories */

export const CATEGORIES = Object.freeze([
  "voice", "ai", "runtime", "computer", "storage", "integrations", "network"
]);

/* ------------------------------------------------------------ sanitisation */

// Diagnostics get spoken, logged and rendered. Anything that looks like a
// secret is removed HERE rather than trusted not to appear, because a probe
// author only has to slip once for a token to end up in a log file forever.
/** Strip anything credential-shaped from a diagnostic string. */
export function sanitizeText(value) {
  if (value == null) return value;
  let out = redactSecrets(value).replace(
    /\b(?:api[_-]?key|key|token|secret|password|passwd|credential|authorization)\s*[=:]\s*\[redacted\]/gi,
    "[redacted]"
  );
  // Home directories leak the account name; the path shape is what matters.
  out = out.replace(/\/Users\/[^/\s]+/g, "~");
  return out;
}

/** Deep-sanitise a details object. Depth-capped so a cyclic probe cannot hang. */
export function sanitizeDetails(value, depth = 0) {
  if (depth > 4 || value == null) return typeof value === "string" ? sanitizeText(value) : value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeDetails(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Never emit a field whose NAME says it holds a credential, whatever the
      // value looks like — an empty-looking token is still a token field.
      if (/key|token|secret|password|credential|auth(?!_?state)/i.test(k)) {
        out[k] = v == null || v === "" ? null : "[redacted]";
        continue;
      }
      out[k] = sanitizeDetails(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

/* ------------------------------------------------------------------ manager */

const DEFAULT_HISTORY = 100;
const DEFAULT_PATTERN_WINDOW_MS = 60 * 60 * 1000; // one hour
const DEFAULT_PATTERN_THRESHOLD = 3;

/**
 * @param {object} opts
 * @param {() => number} [opts.now]      injectable clock
 * @param {(entry: object) => void} [opts.log]  structured log sink
 * @param {number} [opts.maxHistory]
 */
export function createSelfHealth(opts = {}) {
  const now = opts.now || (() => Date.now());
  const logSink = opts.log || (() => {});
  const maxHistory = opts.maxHistory || DEFAULT_HISTORY;
  const patternWindowMs = opts.patternWindowMs || DEFAULT_PATTERN_WINDOW_MS;
  const patternThreshold = opts.patternThreshold || DEFAULT_PATTERN_THRESHOLD;

  /** @type {Map<string, object>} id -> registration */
  const components = new Map();
  /** @type {Array<object>} bounded ring of meaningful events */
  const history = [];

  function push(entry) {
    const record = { at: now(), ...entry };
    record.summary = sanitizeText(record.summary);
    history.push(record);
    // Bounded by construction: a health log that can grow without limit is a
    // disk fault waiting to happen, which is a thing this file also reports on.
    while (history.length > maxHistory) history.shift();
    logSink(record);
  }

  /**
   * Register one component.
   *
   * @param {string} id                     e.g. "voice.wake"
   * @param {object} cfg
   * @param {string} cfg.category           one of CATEGORIES
   * @param {string} [cfg.label]            human name for speech
   * @param {boolean} [cfg.critical]        a FAILED critical component fails the whole system
   * @param {string} [cfg.dependsOn]        id of the component this needs
   * @param {(ctx) => object|Promise<object>} [cfg.probe]      lightweight
   * @param {(ctx) => object|Promise<object>} [cfg.deepProbe]  expensive
   * @param {object} [cfg.recovery]         { attempt, maxAttempts, cooldownMs, description }
   */
  function register(id, cfg) {
    if (!CATEGORIES.includes(cfg.category)) throw new Error(`unknown category: ${cfg.category}`);
    components.set(id, {
      id,
      label: cfg.label || id,
      category: cfg.category,
      critical: !!cfg.critical,
      dependsOn: cfg.dependsOn || null,
      probe: cfg.probe || null,
      deepProbe: cfg.deepProbe || null,
      recovery: cfg.recovery || null,
      state: {
        status: UNKNOWN,
        summary: "not checked yet",
        lastChecked: null,
        lastSuccess: null,
        lastFailure: null,
        errorCode: null,
        details: null,
        // recovery bookkeeping — a budget, so a broken helper cannot be
        // restarted in a tight loop forever
        recoveryState: "idle",   // idle | recovering | exhausted
        recoveryAttempts: 0,
        lastRecoveryAt: null,
        recoveryReason: null
      }
    });
    return api;
  }

  /** Apply a probe/report result to a component, recording transitions. */
  function apply(id, result, source) {
    const c = components.get(id);
    if (!c) return null;
    const prev = c.state.status;
    const at = now();

    const status = STATUSES.includes(result.status) ? result.status : UNKNOWN;
    c.state.status = status;
    c.state.summary = sanitizeText(result.summary || "");
    c.state.errorCode = result.errorCode || null;
    c.state.details = result.details === undefined ? null : sanitizeDetails(result.details);
    c.state.lastChecked = at;
    if (status === HEALTHY) {
      c.state.lastSuccess = at;
      // A clean result is what earns back the recovery budget. Without this a
      // subsystem that failed twice at breakfast would arrive at lunch with one
      // attempt left for an unrelated fault.
      if (c.state.recoveryState !== "recovering") {
        c.state.recoveryAttempts = 0;
        c.state.recoveryState = "idle";
        c.state.recoveryReason = null;
      }
    }
    if (status === FAILED || status === DEGRADED) c.state.lastFailure = at;

    if (prev !== status) {
      push({
        kind: "transition",
        component: id,
        from: prev,
        to: status,
        errorCode: c.state.errorCode,
        summary: c.state.summary,
        source
      });
    }
    return c;
  }

  /**
   * Report a failure the moment a subsystem hits it, rather than waiting for
   * the next scan. This is what makes the health picture current instead of
   * up-to-a-minute-old.
   */
  function report(id, result, source = "event") {
    return apply(id, result, source);
  }

  /** Run one component's probe, converting a thrown probe into a real result. */
  async function runOne(c, { deep, ctx }) {
    const probe = deep && c.deepProbe ? c.deepProbe : c.probe;
    if (!probe) return;
    try {
      const result = await probe(ctx);
      if (result) apply(c.id, result, deep ? "deep" : "quick");
    } catch (error) {
      // A probe that throws is itself a fault, but it must never take the scan
      // down with it — one broken probe would otherwise blind every other check.
      apply(c.id, {
        status: FAILED,
        summary: sanitizeText(error && error.message ? error.message : "probe failed"),
        errorCode: CODES.PROBE_ERROR
      }, "probe-error");
    }
  }

  /**
   * Scan. `deep` opts into the expensive probes; without it only lightweight
   * checks run, which is what makes this safe at startup and on a timer.
   */
  async function scan({ deep = false, only = null, ctx = {} } = {}) {
    const started = now();
    const list = [...components.values()].filter((c) => !only || only.includes(c.id));
    // Sequential on purpose: several probes shell out, and a burst of parallel
    // subprocesses at startup is exactly the cost this system must not add.
    for (const c of list) await runOne(c, { deep, ctx });
    const finished = now();
    return { startedAt: started, durationMs: finished - started, deep };
  }

  /* ---------------------------------------------------------- dependencies */

  /**
   * Attribute dependent failures to their root cause.
   *
   * Returns a map id -> root id for every component whose own trouble is
   * explained by something it depends on. Those are still reported, but they
   * are not counted as separate problems and they are never the thing Artemis
   * reads out.
   */
  function dependencyRoots() {
    const roots = new Map();
    for (const c of components.values()) {
      // A component whose dependency has FAILED cannot be doing its job, even
      // if its own probe passed: the OCR helper is still on disk when Screen
      // Recording is denied, and reporting it healthy would be a lie. It is
      // attributed to the dependency rather than counted as its own problem.
      if (!isProblem(c.state.status) && c.state.status !== DISABLED && !dependencyBroken(c)) continue;
      if (!isProblem(c.state.status) && c.state.status === DISABLED) continue;
      // Walk up the chain: a component may depend on something that is itself
      // explained by a deeper dependency.
      let cursor = c.dependsOn;
      const guard = new Set([c.id]);
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const dep = components.get(cursor);
        if (!dep) break;
        if (dep.state.status === FAILED || dep.state.status === DEGRADED) {
          roots.set(c.id, cursor);
        }
        cursor = dep.dependsOn;
      }
    }
    // Keep only the DEEPEST attribution, so a chain a→b→c blames c once.
    for (const [id, root] of roots) {
      let cursor = root;
      while (roots.has(cursor) && roots.get(cursor) !== cursor) cursor = roots.get(cursor);
      roots.set(id, cursor);
    }
    return roots;
  }

  /* ------------------------------------------------------ pattern detection */

  /**
   * A component that keeps breaking is not healthy just because it happens to
   * be up right now. Counts failure transitions in a rolling window; simple
   * counters, deliberately not an anomaly model.
   */
  function faultPattern(id) {
    const since = now() - patternWindowMs;
    const failures = history.filter(
      (h) => h.component === id && h.at >= since && h.kind === "transition" && (h.to === FAILED || h.to === DEGRADED)
    );
    return failures.length >= patternThreshold
      ? { repeated: true, count: failures.length, windowMs: patternWindowMs }
      : { repeated: false, count: failures.length, windowMs: patternWindowMs };
  }

  /* ----------------------------------------------------------- aggregation */

  /** Is anything this component needs currently broken? */
  function dependencyBroken(c) {
    let cursor = c.dependsOn;
    const guard = new Set([c.id]);
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const dep = components.get(cursor);
      if (!dep) return false;
      if (dep.state.status === FAILED) return true;
      cursor = dep.dependsOn;
    }
    return false;
  }

  function effectiveStatus(c) {
    // A currently-healthy component that has failed repeatedly this hour is
    // reported DEGRADED — the user should hear about a flapping wake listener
    // even in the moment it happens to be working.
    if (c.state.status === HEALTHY) {
      const pattern = faultPattern(c.id);
      if (pattern.repeated) return DEGRADED;
    }
    return c.state.status;
  }

  function rollUp(statuses) {
    const ranked = statuses.map((s) => SEVERITY[s]).filter((v) => v >= 0);
    if (!ranked.length) {
      // Everything here is DISABLED or UNKNOWN. Disabled-by-choice is healthy
      // from the system's point of view; never-checked is honestly unknown.
      return statuses.some((s) => s === DISABLED) && !statuses.some((s) => s === UNKNOWN)
        ? DISABLED
        : UNKNOWN;
    }
    const worst = Math.max(...ranked);
    return Object.keys(SEVERITY).find((k) => SEVERITY[k] === worst) || UNKNOWN;
  }

  /* -------------------------------------------------------------- snapshot */

  function snapshot() {
    const roots = dependencyRoots();
    const subsystems = {};
    const issues = [];

    for (const category of CATEGORIES) {
      const inCategory = [...components.values()].filter((c) => c.category === category);
      if (!inCategory.length) continue;
      const comps = {};
      for (const c of inCategory) {
        // Dependency-blocked components read DEGRADED rather than HEALTHY, and
        // carry the attribution so the report explains itself.
        const own = effectiveStatus(c);
        const status = roots.has(c.id) && own === HEALTHY ? DEGRADED : own;
        const pattern = faultPattern(c.id);
        const dependency = roots.get(c.id) || null;
        comps[shortId(c.id)] = {
          status,
          label: c.label,
          summary: c.state.summary,
          lastChecked: c.state.lastChecked,
          lastSuccess: c.state.lastSuccess,
          lastFailure: c.state.lastFailure,
          errorCode: c.state.errorCode,
          critical: c.critical,
          recoverable: !!c.recovery,
          recoveryState: c.state.recoveryState,
          recoveryAttempts: c.state.recoveryAttempts,
          dependency,
          repeatedFault: pattern.repeated ? pattern.count : 0,
          details: c.state.details
        };
        // A dependent failure is real, but it is not a SEPARATE problem: the
        // network being down is one issue, not one per cloud service.
        if (isProblem(status) && !dependency) {
          issues.push({
            id: c.id,
            label: c.label,
            status,
            errorCode: c.state.errorCode,
            summary: c.state.summary,
            critical: c.critical,
            recoveryState: c.state.recoveryState,
            repeatedFault: pattern.repeated ? pattern.count : 0
          });
        }
      }
      subsystems[category] = {
        overall: rollUp(Object.values(comps).map((x) => x.status)),
        components: comps
      };
    }

    // A non-critical component failing degrades the system; a critical one
    // fails it. That distinction is why "my OCR helper is missing" and "my
    // server is down" do not produce the same headline.
    const all = [...components.values()];
    const worstNonDisabled = rollUp(all.map((c) => (roots.has(c.id) ? DEGRADED : effectiveStatus(c))));
    let overall = worstNonDisabled;
    if (overall === FAILED) {
      const criticalFailed = all.some((c) => c.critical && effectiveStatus(c) === FAILED && !roots.has(c.id));
      if (!criticalFailed) overall = DEGRADED;
    }

    issues.sort((a, b) => (SEVERITY[b.status] - SEVERITY[a.status]) || (b.critical - a.critical));

    return {
      overall,
      checkedAt: now(),
      issueCount: issues.length,
      issues,
      subsystems
    };
  }

  /* -------------------------------------------------------------- recovery */

  /**
   * Attempt a bounded Level-1 recovery.
   *
   * The budget is the whole point: a helper that cannot come back must end up
   * FAILED and stay there until something changes, not be restarted forever.
   * Nothing privileged is reachable from here — the manager only ever calls the
   * `attempt` a component registered for itself.
   */
  async function recover(id, reason = "health check") {
    const c = components.get(id);
    if (!c || !c.recovery) return { attempted: false, why: "not recoverable" };

    const { maxAttempts = 3, cooldownMs = 30000 } = c.recovery;
    const at = now();

    if (c.state.recoveryState === "exhausted") {
      // The cooldown is what lets a genuinely-fixed subsystem be retried later
      // without ever allowing a tight loop.
      if (c.state.lastRecoveryAt && at - c.state.lastRecoveryAt < cooldownMs) {
        return { attempted: false, why: "recovery budget exhausted, cooling down" };
      }
      c.state.recoveryState = "idle";
      c.state.recoveryAttempts = 0;
    }
    if (c.state.recoveryAttempts >= maxAttempts) {
      c.state.recoveryState = "exhausted";
      apply(id, {
        status: FAILED,
        summary: `${c.label} did not recover after ${maxAttempts} attempts`,
        errorCode: c.state.errorCode
      }, "recovery");
      return { attempted: false, why: "max attempts reached" };
    }

    c.state.recoveryAttempts += 1;
    c.state.recoveryState = "recovering";
    c.state.lastRecoveryAt = at;
    c.state.recoveryReason = sanitizeText(reason);
    apply(id, { status: RECOVERING, summary: `restoring ${c.label}`, errorCode: c.state.errorCode }, "recovery");
    push({ kind: "recovery-attempt", component: id, attempt: c.state.recoveryAttempts, summary: reason });

    let ok = false;
    let error = null;
    try {
      ok = (await c.recovery.attempt()) !== false;
    } catch (e) {
      ok = false;
      error = e;
    }

    if (ok) {
      c.state.recoveryState = "idle";
      c.state.recoveryAttempts = 0;
      apply(id, { status: HEALTHY, summary: `${c.label} restored` }, "recovery");
      push({ kind: "recovery-result", component: id, ok: true, summary: `${c.label} restored` });
      return { attempted: true, ok: true };
    }

    const exhausted = c.state.recoveryAttempts >= maxAttempts;
    c.state.recoveryState = exhausted ? "exhausted" : "idle";
    apply(id, {
      status: FAILED,
      summary: exhausted
        ? `${c.label} did not recover after ${maxAttempts} attempts`
        : `${c.label} recovery attempt ${c.state.recoveryAttempts} failed`,
      errorCode: c.state.errorCode
    }, "recovery");
    push({
      kind: "recovery-result",
      component: id,
      ok: false,
      attempt: c.state.recoveryAttempts,
      summary: sanitizeText(error && error.message ? error.message : "recovery failed")
    });
    return { attempted: true, ok: false, exhausted };
  }

  /** Recover everything currently broken that knows how to fix itself. */
  async function recoverAll(reason = "watchdog") {
    const results = [];
    for (const c of components.values()) {
      if (!c.recovery) continue;
      if (c.state.status !== FAILED && c.state.status !== DEGRADED) continue;
      results.push({ id: c.id, ...(await recover(c.id, reason)) });
    }
    return results;
  }

  const api = {
    register,
    report,
    scan,
    snapshot,
    recover,
    recoverAll,
    history: () => history.slice(),
    get: (id) => (components.get(id) ? { ...components.get(id).state } : null),
    ids: () => [...components.keys()],
    faultPattern,
    STATUSES
  };
  return api;
}

/** "voice.wake" -> "wake" — categories already namespace the snapshot. */
function shortId(id) {
  const i = id.indexOf(".");
  return i === -1 ? id : id.slice(i + 1);
}
