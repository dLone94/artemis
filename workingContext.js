// Ephemeral interaction context — what Artemis and the user were JUST doing.
//
// This is deliberately not memory: nothing here is persisted, everything
// expires on its own, and the store records only successful VALIDATED calls,
// exactly as validated — never raw utterances, never screen dumps. It exists
// so "run that again" and "pick the second one" have something real and
// recent to resolve against.
//
// Pure module with an injectable clock (opts.now) so TTL behaviour is
// unit-testable without waiting. server.js holds one instance; concurrent
// surfaces (dashboard, pill, phone) are serialized by the lease below, so two
// overlapping turns can never interleave recall state.

const TTL = Object.freeze({
  optionSet: 90 * 1000,      // a visible menu goes stale fast — screens change
  prompt: 90 * 1000,
  command: 15 * 60 * 1000,
  toolRun: 30 * 60 * 1000
});

export function createWorkingContext(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  let lastCommand = null;   // {tool, args, risk, targetId, contextHash, at}
  let lastToolRun = null;   // {name, family, ok, at}
  let lastOptionSet = null; // {options:[{n,label}], promptKind, evidence, at}
  let lastPrompt = null;    // {promptKind, line, evidence, at}
  let currentTask = null;   // {turnId, label, state, at}

  const fresh = (entry, ttl) => (entry && now() - entry.at <= ttl ? entry : null);

  return {
    /** Record a successful validated effectful call, exactly as validated. */
    recordCommand({ tool, args, risk, targetId = null, contextHash = null }) {
      if (!tool || !args) return;
      lastCommand = { tool, args: { ...args }, risk: risk || null, targetId, contextHash, at: now() };
    },
    recordToolRun({ name, family = null, ok = true }) {
      if (!name) return;
      lastToolRun = { name, family, ok: ok !== false, at: now() };
    },
    /** Options parsed from a successful terminal read (already sanitized). */
    recordOptionSet({ options, promptKind = null, evidence = null }) {
      if (!Array.isArray(options) || !options.length) return;
      lastOptionSet = { options, promptKind, evidence, at: now() };
    },
    recordPrompt({ promptKind, line = "", evidence = null }) {
      if (!promptKind) return;
      lastPrompt = { promptKind, line, evidence, at: now() };
    },
    /** Turn-scoped task lifecycle: begin on dispatch, end on done/error/cancel. */
    beginTask(turnId, label) {
      currentTask = { turnId, label: String(label || ""), state: "active", at: now() };
    },
    endTask(turnId, state = "done") {
      if (currentTask && (turnId == null || currentTask.turnId === turnId)) {
        currentTask = null;
        return state;
      }
      return null;
    },
    /** Everything still alive right now; expired entries are simply absent. */
    snapshot() {
      return {
        lastCommand: fresh(lastCommand, TTL.command),
        lastToolRun: fresh(lastToolRun, TTL.toolRun),
        lastOptionSet: fresh(lastOptionSet, TTL.optionSet),
        lastPrompt: fresh(lastPrompt, TTL.prompt),
        currentTask
      };
    },
    clear() {
      lastCommand = lastToolRun = lastOptionSet = lastPrompt = currentTask = null;
    }
  };
}

export const WORKING_CONTEXT_TTL = TTL;

/**
 * A serial lease: at most one holder, at most `maxQueue` waiters. Contextual
 * turns and Terminal-UI read-modify-act sequences run through one of these so
 * a second surface can't change the terminal between look and act. The signal
 * aborts a WAITER cleanly; the holder always releases via finally.
 */
export function createSerialLease({ maxQueue = 1 } = {}) {
  let busy = false;
  const waiters = [];

  const next = () => {
    const w = waiters.shift();
    if (w) w.resolve();
    else busy = false;
  };

  return {
    get pending() { return waiters.length; },
    get held() { return busy; },
    async run(fn, { signal } = {}) {
      if (signal && signal.aborted) {
        const err = new Error("aborted before acquiring the lease");
        err.code = "lease-aborted";
        throw err;
      }
      if (busy) {
        if (waiters.length >= maxQueue) {
          const err = new Error("busy");
          err.code = "lease-busy";
          throw err;
        }
        await new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          waiters.push(waiter);
          if (signal) {
            const onAbort = () => {
              const i = waiters.indexOf(waiter);
              if (i >= 0) {
                waiters.splice(i, 1);
                const err = new Error("aborted while waiting");
                err.code = "lease-aborted";
                reject(err);
              }
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      } else {
        busy = true;
      }
      try {
        return await fn();
      } finally {
        next();
      }
    }
  };
}
