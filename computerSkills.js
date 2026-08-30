// Screen perception, terminal control, and presentation as Artemis skills.
//
// These translate model intent into local macOS action, but the RUNTIME — not
// the model — decides what is allowed: every terminal action is classified by
// commandPolicy.js, and the confirm gate is raised by the server before an
// approval-risk command runs. A blocked command is refused here with a reason,
// never executed.
//
// Skills follow the repo's shape: { name, description, requiresConfirmation,
// paramSchema, precheck?, confirmPrompt?, execute(params, ctx) }. They are pure
// of wire format and depend only on the leaf perception/terminal/policy modules
// (no cycle back into skills.js).

import { readScreenContext, openTerminal, runInTerminal, typeInTerminal, pressEnterInTerminal, openApplication } from "./macPerception.js";
import { resolveInstalledApplication } from "./appResolver.js";
import { naturalReply } from "./naturalReply.js";
import { runCommand, summarizeResult, resultContent } from "./terminalTool.js";
import {
  classifyCommand,
  resolveWorkingDirectory,
  approvedWorkspaces
} from "./commandPolicy.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- read_screen -----------------------------------------------------------

export const readScreenSkill = {
  name: "read_screen",
  description:
    "Look at what's currently on the user's Mac screen and report it. Use for " +
    "'look at my screen', 'what am I looking at', 'read this', 'what does this error mean', " +
    "'what is Terminal saying', 'what is Claude Code asking me', 'read the selected text', " +
    "'summarize what's open'. Reads locally via Accessibility first, the app's own text for " +
    "Terminal, and on-device OCR only as a last resort. Never leaves the machine.",
  requiresConfirmation: false,
  paramSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["auto", "terminal", "selection", "screen"],
        description:
          "auto = whatever is in front; terminal = the Terminal buffer; selection = the highlighted text; screen = force a capture+OCR read."
      }
    },
    additionalProperties: false
  },
  async execute(params = {}) {
    const prefer =
      params.target === "terminal" ? "terminal" :
      params.target === "selection" ? "selection" :
      params.target === "screen" ? "ocr" : "auto";
    let ctx;
    try {
      ctx = await readScreenContext({ prefer, wait });
    } catch (error) {
      return { ok: false, summary: "I couldn't read the screen.", content: `Screen read failed: ${error.message}` };
    }
    const body = ctx.selectedText || ctx.visibleText || "";
    if (!body) {
      const why = (ctx.errors || []).join("; ") || "no readable text found";
      const denied = (ctx.errors || []).some((e) => /denied|disabled/.test(e));
      return {
        ok: false,
        summary: denied
          ? "I can't read the screen yet — Accessibility/Screen Recording permission is needed."
          : "There's nothing readable on screen right now.",
        content: `application=${ctx.application || "?"} window=${ctx.windowTitle || "?"} source=${ctx.source}\n(${why})`
      };
    }
    const header =
      `Foreground app: ${ctx.application || "unknown"}\n` +
      (ctx.windowTitle ? `Window: ${ctx.windowTitle}\n` : "") +
      `Source: ${ctx.source}\n`;
    // Screen content is attacker-influenceable (a page/terminal can show
    // anything), so it is untrusted input to the model.
    return {
      ok: true,
      summary: `Reading ${ctx.application || "the screen"} (${ctx.source}).`,
      content: header + "---\n" + body.slice(0, 12000)
    };
  }
};

// ---- run_command (direct shell, PREFERRED execution) -----------------------

function refuseBlocked(verdict) {
  return {
    ok: false,
    summary: `I won't run that — ${verdict.reason}.`,
    content: `Refused (blocked): ${verdict.reason}`
  };
}

// One honest sentence per structured failure code from macPerception — never a
// generic "nothing happened". The codes are the module's error vocabulary:
// automation-denied / accessibility-denied / no-terminal-window / timeout.
function terminalFailureLine(code, doing) {
  switch (code) {
    case "automation-denied":
      return "I need Automation permission for Terminal — System Settings → Privacy & Security → Automation → Artemis → Terminal.";
    case "accessibility-denied":
      return "I need Accessibility permission to type keystrokes — System Settings → Privacy & Security → Accessibility → add Artemis.";
    case "no-terminal-window":
      return "Terminal has no open window to type into — I waited, but none appeared.";
    case "timeout":
      return `Terminal didn't respond in time when I tried to ${doing}.`;
    case "target-changed":
      return "The Terminal tab changed before I could act, so I didn't touch it.";
    case "UI automation disabled":
      return `UI automation is disabled in this environment, so I can't ${doing}.`;
    default:
      return `I couldn't ${doing}: ${code || "unknown error"}.`;
  }
}

export const runCommandSkill = {
  name: "run_command",
  description:
    "Run a shell command locally and report the real result (stdout, stderr, exit code). " +
    "Use for 'run the tests', 'what's the git status', 'build the project', 'go to my project and run X'. " +
    "Prefer this over driving the visible Terminal. Safe read-only commands run immediately; " +
    "commands that modify files, install, or are risky are checked and may need your confirmation; " +
    "destructive/system-damaging commands are refused.",
  requiresConfirmation: false, // dynamic — see toolRegistry needsConfirmation
  paramSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact command line to run." },
      working_directory: {
        type: "string",
        description: "Optional directory to run in; must be inside an approved workspace."
      }
    },
    required: ["command"],
    additionalProperties: false
  },
  precheck(params = {}) {
    const command = String(params.command || "").trim();
    if (!command) return { ok: false, summary: "There's no command to run." };
    const wd = resolveWorkingDirectory(params.working_directory);
    if (!wd.ok) return { ok: false, summary: `I can only run commands inside your approved workspace. ${wd.error}` };
    const verdict = classifyCommand(command, { workingDirectory: wd.dir });
    if (verdict.risk === "blocked") return refuseBlocked(verdict);
    return { ok: true };
  },
  confirmPrompt(params = {}) {
    const command = String(params.command || "").trim();
    const verdict = classifyCommand(command);
    return `I'd like to run \`${command}\` — ${verdict.reason}. Go ahead?`;
  },
  async execute(params = {}) {
    const command = String(params.command || "").trim();
    if (!command) return { ok: false, summary: "There's no command to run." };
    const wd = resolveWorkingDirectory(params.working_directory);
    if (!wd.ok) return { ok: false, summary: `That's outside your approved workspace.`, content: wd.error };
    // Defense in depth: re-classify at execution. A blocked command must never
    // run even if it reached here.
    const verdict = classifyCommand(command, { workingDirectory: wd.dir });
    if (verdict.risk === "blocked") return refuseBlocked(verdict);

    const result = await runCommand(command, { workingDirectory: wd.dir });
    return {
      ok: result.status === "ok",
      summary: summarizeResult(result),
      content: resultContent(result)
    };
  }
};

// ---- computer_control (drive the visible Terminal app) ---------------------

export const computerControlSkill = {
  name: "computer_control",
  description:
    "Control the local Mac: open/focus Terminal, launch any INSTALLED macOS application by " +
    "name (open_application — 'open WhatsApp', 'open System Settings', 'open Spotify'), type a " +
    "command into Terminal and run it, or type text WITHOUT pressing Enter. Use for 'open " +
    "Terminal', 'open <app>', 'type ai and run it' (type_and_run), 'type ai' with no run " +
    "request (type_text), 'tell Claude to continue'. Websites are NOT applications — use " +
    "open_url for those. For running a command and reading its result cleanly, prefer " +
    "run_command instead.",
  requiresConfirmation: false, // dynamic for type_and_run
  paramSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["open_terminal", "open_application", "type_and_run", "type_text", "press_enter"],
        description:
          "open_terminal focuses Terminal; open_application launches an installed macOS app " +
          "by natural name (resolved against what is actually installed — never a shell " +
          "command); type_and_run types text and presses Enter; type_text types the text and " +
          "does NOT press Enter; press_enter presses Enter on its own (submits what's already " +
          "typed / activates the highlighted control)."
      },
      name: {
        type: "string",
        description: "For open_application: the application's natural name, e.g. \"WhatsApp\", \"System Settings\"."
      },
      text: { type: "string", description: "The exact text to type for type_and_run / type_text." },
      expect_tty: {
        type: "string",
        description:
          "Optional target binding: the tty of the Terminal tab this action was resolved " +
          "against. The keystroke aborts atomically if the front tab's tty differs."
      }
    },
    required: ["action"],
    additionalProperties: false
  },
  precheck(params = {}) {
    if (params.action === "open_application") {
      const name = String(params.name || "").trim();
      if (!name) return { ok: false, summary: "Tell me which app to open." };
      if (name.length > 60 || !/^[\w .&'’+-]+$/.test(name)) {
        return { ok: false, summary: "That doesn't look like an application name." };
      }
    }
    if (params.action === "type_and_run" || params.action === "type_text") {
      const text = String(params.text || "").trim();
      if (!text) return { ok: false, summary: "Tell me what to type." };
      // Blocked commands are refused even for type-only: a destructive command
      // must never sit one keystroke away from running.
      const verdict = classifyCommand(text);
      if (verdict.risk === "blocked") return refuseBlocked(verdict);
    }
    return { ok: true };
  },
  confirmPrompt(params = {}) {
    const text = String(params.text || "").trim();
    const verdict = classifyCommand(text);
    return `I'd like to type \`${text}\` into Terminal and run it — ${verdict.reason}. Go ahead?`;
  },
  async execute(params = {}) {
    if (params.action === "open_terminal") {
      const r = await openTerminal();
      return r.ok
        ? { ok: true, summary: "Terminal is open." }
        : { ok: false, summary: terminalFailureLine(r.error, "open Terminal"), content: r.error };
    }
    if (params.action === "open_application") {
      const name = String(params.name || "").trim();
      if (!name) return { ok: false, summary: "Tell me which app to open." };
      // The skill resolves for itself — a caller-supplied path is never
      // trusted, so this can only ever launch a discovered installed bundle.
      const resolved = await resolveInstalledApplication(name);
      if (!resolved.found) {
        return resolved.candidates.length
          ? {
              ok: false,
              summary: naturalReply({ kind: "app_ambiguous", candidates: resolved.candidates }),
              content: `ambiguous: ${resolved.candidates.join(", ")}`
            }
          : {
              ok: false,
              summary: naturalReply({ kind: "app_missing", name }),
              content: "not-installed"
            };
      }
      const r = await openApplication(resolved.path);
      return r.ok
        ? {
            ok: true,
            summary: naturalReply({ kind: "app_open", name: resolved.displayName }),
            content: `launched ${resolved.displayName} (${resolved.path}) [${resolved.matchType}]`
          }
        : { ok: false, summary: terminalFailureLine(r.error, `open ${resolved.displayName}`), content: r.error };
    }
    if (params.action === "type_and_run") {
      const text = String(params.text || "").trim();
      if (!text) return { ok: false, summary: "Tell me what to type." };
      const verdict = classifyCommand(text);
      if (verdict.risk === "blocked") return refuseBlocked(verdict);
      const r = await runInTerminal(text, { wait, expectTty: params.expect_tty });
      if (!r.ok) {
        return { ok: false, summary: terminalFailureLine(r.error, "type into Terminal"), content: r.error };
      }
      const tail = (r.visibleAfter || "").split("\n").slice(-6).join("\n");
      return {
        ok: true,
        summary: `I ran \`${text}\` in Terminal.`,
        content: `Typed and ran: ${text}\n\nTerminal now shows:\n${tail}`
      };
    }
    if (params.action === "press_enter") {
      const r = await pressEnterInTerminal({ wait, expectTty: params.expect_tty });
      if (!r.ok) {
        return { ok: false, summary: terminalFailureLine(r.error, "press Enter in Terminal"), content: r.error };
      }
      const tail = (r.visibleAfter || "").split("\n").slice(-4).join("\n");
      return {
        ok: true,
        summary: "Pressed Enter.",
        content: `Pressed Enter.\n\nTerminal now shows:\n${tail}`
      };
    }
    if (params.action === "type_text") {
      const text = String(params.text || "").trim();
      if (!text) return { ok: false, summary: "Tell me what to type." };
      const verdict = classifyCommand(text);
      if (verdict.risk === "blocked") return refuseBlocked(verdict);
      const r = await typeInTerminal(text, { wait, expectTty: params.expect_tty });
      if (!r.ok) {
        return { ok: false, summary: terminalFailureLine(r.error, "type into Terminal"), content: r.error };
      }
      const tail = (r.visibleAfter || "").split("\n").slice(-4).join("\n");
      return {
        ok: true,
        summary: `I typed \`${text}\` in Terminal — it's waiting, not run.`,
        content: `Typed (without Enter): ${text}\n\nTerminal now shows:\n${tail}`
      };
    }
    return { ok: false, summary: "Unknown computer action.", content: "invalid-action" };
  }
};

// ---- set_presentation (full / pill / background) ---------------------------

export const setPresentationSkill = {
  name: "set_presentation",
  description:
    "Change how Artemis is shown: full dashboard, a small floating pill, or background. " +
    "Use for 'minimize yourself', 'show yourself', 'go to background', 'shrink down', 'come back'.",
  requiresConfirmation: false,
  paramSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["full", "pill", "background"] }
    },
    required: ["mode"],
    additionalProperties: false
  },
  async execute(params = {}) {
    const mode = params.mode;
    const label = { full: "the full dashboard", pill: "the floating pill", background: "the background" }[mode];
    if (!label) return { ok: false, summary: "I can show the full dashboard, the pill, or go to background." };
    return {
      ok: true,
      summary: `Switching to ${label}.`,
      content: `presentation mode set to ${mode}`,
      presentation: mode // server turns this into a clientAction
    };
  }
};

export const COMPUTER_SKILLS = [
  readScreenSkill,
  runCommandSkill,
  computerControlSkill,
  setPresentationSkill
];
