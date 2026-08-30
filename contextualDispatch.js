// The contextual dispatcher — one owner for every deictic turn ("pick the
// second one", "tell Claude yes", "type one and press enter", "run that
// again"). Fully dependency-injected: perception, brains, execution, and the
// pending gate all arrive from outside, so the whole tier is testable with
// fakes while /api/chat and /api/chat/stream share the exact same behaviour.
//
// Resolution ladder (each rung cheaper and safer than the next):
//   1. deterministic resolvers      — no model at all
//   2. local candidate chooser      — Ollama picks among derived candidates
//   3. cloud candidate chooser      — hybrid mode only, same closed set
//   4. clarification                — never a guess, never the generative loop
//
// Security invariants (Codex-reviewed, plan Rev 5):
//   - screen text narrows, never authors: every executable action is a member
//     of the deterministically derived candidate set
//   - every action passes needsConfirmation with interactive/contextDerived
//     evidence; the interactive-input policy is allowlist-shaped
//   - evidence {windowId, tabTty, tailHash} is revalidated under the
//     Terminal-UI lease immediately before any keystroke, and again when a
//     confirmation gate is answered
//   - offline/local-only mode never touches a cloud brain

import {
  parseTerminalTail,
  deicticCommandForText,
  resolveDeictic,
  candidateActions,
  interpretWithBrain
} from "./naturalCommand.js";
import { naturalReply, createReplyPicker } from "./naturalReply.js";

const KEYSTROKE_ACTIONS = new Set(["type_and_run", "type_text", "press_enter"]);

/** Is this turn ours? Returns a trigger descriptor or null. */
export function contextualTrigger(intent, text) {
  if (!intent || intent.intent !== "executable_action") return null;
  if (intent.family === "contextual") {
    return { kind: "deictic", deictic: deicticCommandForText(text) };
  }
  if (intent.family === "computer" && intent.terminalType) {
    const tt = intent.terminalType;
    if (tt.deictic) {
      if (/^(?:enter|return)$/i.test(tt.text)) return { kind: "deictic", deictic: { kind: "submit" } };
      return { kind: "deictic", deictic: { kind: "type_deictic", value: numberOf(tt.text), submit: tt.submit } };
    }
    if (tt.singleKey) return { kind: "single_key", terminalType: tt };
    return null;
  }
  if (intent.family === "computer" && intent.computerRelay) {
    const deictic = deicticCommandForText(text);
    if (deictic && deictic.kind === "relay") return { kind: "deictic", deictic };
    return { kind: "unparsed_relay" };
  }
  return null;
}

function numberOf(word) {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const w = String(word || "").toLowerCase();
  return WORDS[w] ?? (/^\d{1,2}$/.test(w) ? parseInt(w, 10) : null);
}

function candidateToDeictic(candidate) {
  if (candidate.kind === "select") return { kind: "select", ref: candidate.ref };
  if (candidate.kind === "relay") return { kind: "relay", answer: candidate.answer, dictated: candidate.dictated };
  if (candidate.kind === "submit") return { kind: "submit" };
  if (candidate.kind === "repeat") return { kind: "repeat" };
  return null;
}

export function createContextualDispatcher(deps) {
  const {
    perception,          // { foregroundApp(opts), terminalContent(opts) }
    working,             // workingContext instance
    contextLease,        // serializes whole contextual turns
    terminalLease,       // guards revalidate→keystroke critical sections
    callLocalBrain,      // async (messages) => string; null when no local brain
    callCloudBrain,      // async (messages) => string; null in offline mode
    runSkill,            // async (name, params) => {ok, reply, content, clientActions}
    pend,                // (name, params, prompt, envelope) => {confirmId, prompt}
    needsConfirmation,   // (name, {args, tainted, contextDerived, interactive}, caps) => bool
    confirmPromptFor,    // (name, params) => string
    isOffline = () => false,
    caps = () => ({}),
    validate = () => ({ ok: true }),  // canonical validateToolCall, injected
    log = () => {},
    publish = () => {},   // presence patches: interpreting / activeContext / currentTask
    pick = createReplyPicker()
  } = deps;

  const say = (event) => naturalReply(event, { pick });

  /** Compare stored evidence against a fresh terminal read. */
  function evidenceMatches(envelope, freshTerm, freshTail) {
    if (!envelope || !envelope.evidence) return { ok: true, reason: "no evidence bound" };
    const e = envelope.evidence;
    // Fail CLOSED: when the resolution bound a target identity and the fresh
    // read can't produce one, that is a mismatch, not a pass (Codex inspection).
    if (e.windowId) {
      if (!freshTerm.windowId) return { ok: false, reason: "target identity unreadable" };
      if (e.windowId !== freshTerm.windowId) return { ok: false, reason: "target window changed" };
    }
    if (e.tabTty) {
      if (!freshTerm.tabTty) return { ok: false, reason: "target identity unreadable" };
      if (e.tabTty !== freshTerm.tabTty) return { ok: false, reason: "target tab changed" };
    }
    if (e.tailHash && envelope.boundToTail && freshTail.tailHash !== e.tailHash) {
      return { ok: false, reason: "the screen content changed" };
    }
    return { ok: true, reason: "evidence fresh" };
  }

  /**
   * Re-read the terminal and check an authorization envelope is still valid.
   * Used immediately before keystrokes and again at confirm time.
   */
  async function revalidate(envelope) {
    if (!envelope || !envelope.evidence) return { ok: true, reason: "nothing to revalidate" };
    const term = await perception.terminalContent();
    if (!term.text && term.error) return { ok: false, reason: `terminal unreadable (${term.error})` };
    const tail = parseTerminalTail(term.text);
    return evidenceMatches(envelope, term, tail);
  }

  /** Execute one keystroke action under the Terminal-UI lease with revalidation. */
  async function executeGuarded(tool, params, envelope, { signal } = {}) {
    const isKeystroke = tool === "computer_control" && KEYSTROKE_ACTIONS.has(params.action);
    if (!isKeystroke) return runSkill(tool, params);
    return terminalLease.run(async () => {
      const check = await revalidate(envelope);
      if (!check.ok) {
        return { ok: false, reply: say({ kind: "revalidation_failed" }), revalidationFailed: true, reason: check.reason, clientActions: [] };
      }
      if (signal && signal.aborted) {
        return { ok: false, reply: say({ kind: "revalidation_failed" }), revalidationFailed: true, reason: "cancelled", clientActions: [] };
      }
      return runSkill(tool, params);
    }, { signal });
  }

  /**
   * The whole contextual turn. Returns null when the turn is not contextual
   * (caller continues down the ordinary pipeline), else a handled result:
   * {reply, clientActions, toolsUsed, screenUntrusted, pendingAction?, tier}
   */
  async function maybeDispatch({ text, intent, turnId = null, tainted = false, signal = null }) {
    const trigger = contextualTrigger(intent, text);
    if (!trigger) return null;

    const t0 = Date.now();
    const logAndReturn = (result, fields) => {
      log({ turnId, ms: Date.now() - t0, family: intent.family, ...fields });
      return result;
    };

    let run;
    publish({ interpreting: true });
    try {
      run = await contextLease.run(() => dispatchInner({ text, trigger, turnId, tainted, signal }), { signal });
    } catch (error) {
      publish({ interpreting: false });
      if (error && (error.code === "lease-busy" || error.code === "lease-aborted")) {
        return logAndReturn(
          { reply: say({ kind: "busy" }), clientActions: [], toolsUsed: [], screenUntrusted: false, tier: "lease" },
          { tier: "lease", verdict: "busy" }
        );
      }
      throw error;
    }
    publish({ interpreting: false, currentTask: working.snapshot().currentTask });
    return logAndReturn(run.result, run.logFields);
  }

  async function dispatchInner({ text, trigger, turnId, tainted, signal }) {
    const handled = (result, logFields) => ({ result: { screenUntrusted: false, clientActions: [], toolsUsed: [], ...result }, logFields });

    if (trigger.kind === "unparsed_relay") {
      return handled(
        { reply: say({ kind: "clarify", question: "Which prompt should I answer in Terminal?" }) },
        { tier: "guard", verdict: "clarify" }
      );
    }

    // ---- context collection (local, minimal, no OCR) ------------------------
    const fg = await perception.foregroundApp();
    const app = String(fg.application || "");
    // Confused-deputy guard: we only ever drive Terminal.app. iTerm or any
    // other terminal frontmost means our keystrokes would land somewhere the
    // user isn't looking at.
    if (/iterm|alacritty|kitty|warp|wezterm|hyper/i.test(app)) {
      return handled(
        { reply: say({ kind: "wrong_app", application: fg.application }) },
        { tier: "guard", verdict: "wrong-app" }
      );
    }

    const needsTerminal = trigger.kind !== "deictic" || trigger.deictic == null || trigger.deictic.kind !== "repeat";
    let term = { text: "", windowId: null, tabTty: null };
    let tail = { menu: null, prompt: null, tailHash: null };
    if (needsTerminal) {
      term = await perception.terminalContent();
      tail = parseTerminalTail(term.text || "");
    }
    const evidence = { windowId: term.windowId, tabTty: term.tabTty, tailHash: tail.tailHash };
    const snapshot = working.snapshot();

    // Real perception ran — the dashboard's context panel can show it.
    if (needsTerminal && (term.text || fg.application)) {
      publish({
        activeContext: {
          application: fg.application || "Terminal",
          windowTitle: fg.windowTitle || term.title || null,
          promptLine: tail.prompt ? tail.prompt.line : (tail.menu ? tail.menu.header : null),
          at: Date.now()
        }
      });
    }

    // Record what we saw — a later "pick the second one" can lean on it.
    if (tail.menu) working.recordOptionSet({ options: tail.menu.options, promptKind: tail.prompt ? tail.prompt.kind : null, evidence });
    if (tail.prompt) working.recordPrompt({ promptKind: tail.prompt.kind, line: tail.prompt.line, evidence });

    // ---- tier 1: deterministic resolution ----------------------------------
    let resolution = null;
    let tier = "deterministic";
    if (trigger.kind === "single_key") {
      const tt = trigger.terminalType;
      resolution = {
        outcome: "action",
        tool: "computer_control",
        params: { action: tt.submit ? "type_and_run" : "type_text", text: tt.text },
        evidence,
        interactive: {
          payload: tt.text,
          optionLabel: "",
          promptHeader: tail.prompt ? tail.prompt.line : (tail.menu ? tail.menu.header : ""),
          promptKind: tail.prompt ? tail.prompt.kind : (tail.menu ? "menu" : null),
          userNamed: true
        },
        contextDerived: false,
        say: tt.submit ? { kind: "typed_run", text: tt.text } : { kind: "typed", text: tt.text }
      };
    } else {
      resolution = resolveDeictic(trigger.deictic, { tail, working: snapshot, evidence });
    }

    // ---- tier 2/3: candidate chooser (local first, cloud only in hybrid) ---
    if (resolution.outcome === "clarify") {
      const candidates = candidateActions(text, { tail, working: snapshot });
      const actionable = candidates.filter((c) => c.kind !== "clarify");
      if (actionable.length) {
        let chosen = null;
        let brainMs = 0;
        if (callLocalBrain) {
          const b0 = Date.now();
          const local = await interpretWithBrain({ utterance: text, candidates, ctx: { tail, application: app }, callBrain: callLocalBrain });
          brainMs = Date.now() - b0;
          if (local.candidate.kind !== "clarify") { chosen = local; tier = "local-brain"; }
        }
        if (!chosen && !isOffline() && callCloudBrain) {
          const cloud = await interpretWithBrain({ utterance: text, candidates, ctx: { tail, application: app }, callBrain: callCloudBrain });
          if (cloud.candidate.kind !== "clarify") { chosen = cloud; tier = "cloud-brain"; }
        }
        if (chosen) {
          const asDeictic = candidateToDeictic(chosen.candidate);
          const resolved = resolveDeictic(asDeictic, { tail, working: snapshot, evidence });
          if (resolved.outcome === "action") {
            // A model-chosen action is context-derived by definition — the
            // user did not name it — so it faces full confirmation pressure.
            resolved.contextDerived = true;
            if (resolved.interactive) resolved.interactive.userNamed = false;
            resolution = resolved;
            resolution.brainMs = brainMs;
          }
        }
      }
    }

    if (resolution.outcome === "clarify") {
      return handled(
        { reply: say({ kind: "clarify", question: resolution.question }), screenUntrusted: !!(tail.menu || tail.prompt) },
        { tier, verdict: "clarify", tailHash: tail.tailHash }
      );
    }

    // ---- policy: validation, risk, confirmation ----------------------------
    // Bind the keystroke to the exact tab it was resolved against: the
    // perception primitive re-checks this tty INSIDE the same AppleScript as
    // the keystroke, closing the gap between revalidation and action.
    if (
      resolution.tool === "computer_control" &&
      KEYSTROKE_ACTIONS.has(resolution.params.action) &&
      evidence.tabTty
    ) {
      resolution.params = { ...resolution.params, expect_tty: evidence.tabTty };
    }
    const validated = validate(resolution.tool, resolution.params);
    if (validated && validated.ok === false) {
      return handled(
        { reply: say({ kind: "failed", reason: validated.error || "that didn't validate" }) },
        { tier, verdict: "invalid", policyReason: validated.error }
      );
    }
    if (validated && validated.args) resolution.params = validated.args; // normalized
    const envelope = {
      turnId,
      evidence: resolution.evidence,
      // Menu selections and prompt answers are only valid against the exact
      // screen they were resolved on; repeats/typing bind to the target only.
      boundToTail: !!(resolution.interactive && resolution.interactive.promptKind),
      contextDerived: !!resolution.contextDerived,
      interactive: resolution.interactive || null,
      revalidate: true
    };
    const confirmNeeded = needsConfirmation(
      resolution.tool,
      { args: resolution.params, tainted, contextDerived: envelope.contextDerived, interactive: resolution.interactive },
      caps()
    );
    if (confirmNeeded) {
      const prompt = describeForConfirmation(resolution);
      const pended = pend(resolution.tool, resolution.params, prompt, envelope);
      working.beginTask(turnId, "Waiting for your confirmation");
      return handled(
        {
          reply: prompt,
          pendingAction: pended,
          screenUntrusted: !!(resolution.interactive && (resolution.interactive.optionLabel || resolution.interactive.promptHeader))
        },
        { tier, verdict: "confirm", tailHash: tail.tailHash, policyReason: "confirmation required" }
      );
    }

    // ---- execute (revalidated, under the Terminal-UI lease) ----------------
    working.beginTask(turnId, taskLabel(resolution));
    const run = await executeGuarded(resolution.tool, resolution.params, envelope, { signal });
    working.endTask(turnId, run.ok ? "done" : "error");
    if (run.ok) {
      working.recordCommand({
        tool: resolution.tool,
        args: resolution.params,
        risk: resolution.interactive ? "interactive" : "shell",
        targetId: [evidence.windowId, evidence.tabTty].filter(Boolean).join(":") || null,
        contextHash: tail.tailHash
      });
      working.recordToolRun({ name: resolution.tool, family: "contextual", ok: true });
    }
    const reply = run.revalidationFailed
      ? run.reply
      : run.ok
        ? (resolution.say ? say(resolution.say) : run.reply)
        : run.reply;
    return handled(
      {
        reply,
        clientActions: run.clientActions || [],
        toolsUsed: [resolution.tool],
        ok: run.ok !== false,
        screenUntrusted: !!(resolution.interactive && (resolution.interactive.optionLabel || resolution.interactive.promptHeader))
      },
      { tier, verdict: run.revalidationFailed ? "revalidation-failed" : run.ok ? "executed" : "failed", tailHash: tail.tailHash, brainMs: resolution.brainMs }
    );
  }

  function describeForConfirmation(resolution) {
    const i = resolution.interactive;
    if (i && i.optionLabel) {
      return `That option says "${i.optionLabel}" — want me to pick it?`;
    }
    if (resolution.params && resolution.params.action === "press_enter") {
      return "Press Enter on whatever is highlighted in Terminal?";
    }
    if (resolution.params && resolution.params.text) {
      return confirmPromptFor
        ? confirmPromptFor(resolution.tool, resolution.params)
        : `Type \`${resolution.params.text}\` into Terminal and run it?`;
    }
    return confirmPromptFor ? confirmPromptFor(resolution.tool, resolution.params) : "Go ahead?";
  }

  function taskLabel(resolution) {
    if (resolution.say && resolution.say.kind === "selected") return `Terminal · Selecting option ${resolution.say.n}`;
    if (resolution.say && resolution.say.kind === "repeat") return `Terminal · Running ${resolution.say.text}`;
    if (resolution.params && resolution.params.text) return `Terminal · Typing ${String(resolution.params.text).slice(0, 24)}`;
    return "Terminal";
  }

  return { maybeDispatch, revalidate, contextualTrigger };
}
