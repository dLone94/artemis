// Local computer-perception for macOS. Everything here runs on-device.
//
// Priority order, by design (screenshots are the LAST resort, never the base):
//   1. Structured Accessibility data (AXUIElement via System Events)
//   2. App-specific / native data (Terminal's own text via Apple Events)
//   3. Screen capture + local Vision OCR fallback
//
// Nothing leaves the machine. Screenshots are written to a temp file, OCR'd,
// and deleted immediately — perception is ephemeral (see PART F privacy).
//
// The rest of Artemis never sees a raw AXUIElement or a CGImage: it gets a
// plain ScreenContext object. Every native call is injectable (opts.run) so the
// logic is unit-testable with no permission dialogs.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// UI automation is disabled by env for tests and headless runs — but an
// injected runner (opts.run) is a fake used by unit tests, so it bypasses the
// gate (same convention as whatsapp.js / macContacts.js).
const AUTOMATION_DISABLED = (opts) => !((opts && opts.run)) && process.env.ARTEMIS_DISABLE_UI_AUTOMATION === "1";

function runFile(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 8000 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve(stdout);
    });
  });
}

// ---- foreground app + window (Accessibility, structured) -------------------

const FOREGROUND_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  set focusedRole to ""
  try
    set frontWin to first window of frontApp whose value of attribute "AXMain" is true
    set winTitle to (value of attribute "AXTitle" of frontWin) as text
  end try
  try
    set focusedEl to value of attribute "AXFocusedUIElement" of frontApp
    set focusedRole to (role of focusedEl) as text
  end try
end tell
return appName & "\\n" & winTitle & "\\n" & focusedRole
`;

/**
 * The focused application, its active window title, and focused element role.
 * @returns {Promise<{application, windowTitle, focusedRole, source, error?}>}
 */
export async function foregroundApp(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { application: null, windowTitle: null, focusedRole: null, source: "accessibility", error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    const raw = await run("/usr/bin/osascript", ["-e", FOREGROUND_SCRIPT]);
    const [application = "", windowTitle = "", focusedRole = ""] = String(raw).split("\n");
    return {
      application: application.trim() || null,
      windowTitle: windowTitle.trim() || null,
      focusedRole: focusedRole.trim() || null,
      source: "accessibility"
    };
  } catch (error) {
    return {
      application: null, windowTitle: null, focusedRole: null,
      source: "accessibility",
      error: accessibilityError(error)
    };
  }
}

function accessibilityError(error) {
  const msg = String((error && (error.stderr || error.message)) || "");
  if (/not allowed assistive|accessibility|-25211|1002/i.test(msg)) return "accessibility-denied";
  if (/timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  return msg.trim().split("\n")[0] || "unknown";
}

// ---- selected text (Accessibility) -----------------------------------------

const SELECTED_TEXT_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  try
    set focusedEl to value of attribute "AXFocusedUIElement" of frontApp
    set sel to (value of attribute "AXSelectedText" of focusedEl) as text
    return sel
  end try
end tell
return ""
`;

export async function selectedText(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { text: "", source: "accessibility", error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    const raw = await run("/usr/bin/osascript", ["-e", SELECTED_TEXT_SCRIPT]);
    return { text: String(raw || "").trim(), source: "accessibility" };
  } catch (error) {
    return { text: "", source: "accessibility", error: accessibilityError(error) };
  }
}

// ---- visible window text (Accessibility, generic) --------------------------
// Walks the focused window's AX tree and collects text-bearing values. Good
// enough for reading an error dialog, a form, or a document pane without OCR.

const VISIBLE_TEXT_SCRIPT = `
on collectText(el, depth, acc)
  if depth > 6 then return acc
  try
    set v to value of el
    if v is not missing value and (class of v is text) and (length of v) > 0 then
      set end of acc to v
    end if
  end try
  try
    set t to title of el
    if t is not missing value and (length of t) > 0 then set end of acc to t
  end try
  try
    set kids to UI elements of el
    repeat with k in kids
      collectText(k, depth + 1, acc)
    end repeat
  end try
  return acc
end collectText

tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set acc to {}
  try
    set frontWin to first window of frontApp whose value of attribute "AXMain" is true
    collectText(frontWin, 0, acc)
  end try
end tell
set AppleScript's text item delimiters to linefeed
return acc as text
`;

export async function visibleText(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { text: "", source: "accessibility", error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    const raw = await run("/usr/bin/osascript", ["-e", VISIBLE_TEXT_SCRIPT], { timeout: 12000 });
    return { text: dedupeLines(String(raw || "")), source: "accessibility" };
  } catch (error) {
    return { text: "", source: "accessibility", error: accessibilityError(error) };
  }
}

function dedupeLines(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join("\n").slice(0, 20000);
}

// ---- Terminal.app visible content (app-specific, native) -------------------
// Terminal exposes its buffer via Apple Events — real text, no OCR, no AX walk.

const TERMINAL_CONTENT_SCRIPT = `
tell application "Terminal"
  if (count of windows) is 0 then return ""
  set winId to id of front window
  set tabTty to tty of selected tab of front window
  set tabContents to contents of selected tab of front window
  set tabTitle to custom title of selected tab of front window
end tell
return (winId as text) & "|" & tabTty & "|" & tabTitle & "\\n---\\n" & tabContents
`;

/**
 * The visible text of the frontmost Terminal.app tab, straight from the app —
 * plus a stable target identity (window id + tty) so a contextual action can
 * detect that the tab it resolved against is no longer the tab in front.
 * @returns {Promise<{title, text, windowId, tabTty, source, error?}>}
 */
export async function terminalContent(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { title: null, text: "", windowId: null, tabTty: null, source: "terminal", error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    const raw = await run("/usr/bin/osascript", ["-e", TERMINAL_CONTENT_SCRIPT], { timeout: 8000 });
    const s = String(raw || "");
    const sep = s.indexOf("\n---\n");
    let header = sep >= 0 ? s.slice(0, sep) : "";
    const text = (sep >= 0 ? s.slice(sep + 5) : s).replace(/\n{3,}/g, "\n\n").trim();
    // Header is "winId|tty|title" from the current script — but stay tolerant
    // of the legacy "title"-only shape (injected test runners may use it).
    let windowId = null;
    let tabTty = null;
    let title = header.trim();
    const parts = header.split("|");
    if (parts.length >= 3 && /^\d+$/.test(parts[0].trim())) {
      windowId = parts[0].trim();
      tabTty = parts[1].trim() || null;
      title = parts.slice(2).join("|").trim();
    }
    return { title: title || null, text: text.slice(0, 20000), windowId, tabTty, source: "terminal" };
  } catch (error) {
    return { title: null, text: "", windowId: null, tabTty: null, source: "terminal", error: automationError(error) };
  }
}

function automationError(error) {
  const msg = String((error && (error.stderr || error.message)) || "");
  if (/not authorized|not allowed|-1743|1002/i.test(msg)) return "automation-denied";
  if (/timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  return msg.trim().split("\n")[0] || "unknown";
}

// ---- screen capture + Vision OCR (last-resort fallback, local) -------------
// screencapture -> temp PNG -> Vision OCR -> delete PNG. Nothing persists.

/** Capture the frontmost window (not the whole desktop) to a temp PNG. */
async function captureFrontWindow(opts = {}) {
  const run = opts.run || runFile;
  const path = join(tmpdir(), `artemis-cap-${process.pid}-${Date.now()}.png`);
  // -o no shadow, -x no sound; -l with the front window id, else interactive
  // window mode (-w) which we avoid; we use -o + main-display region capture as
  // a bounded fallback, capturing the frontmost window via -l when we can.
  const winId = await frontWindowId(opts).catch(() => null);
  const args = winId
    ? ["-x", "-o", "-l", String(winId), path]
    : ["-x", "-o", path]; // whole screen only if we truly cannot scope
  await run("/usr/sbin/screencapture", args, { timeout: 8000 });
  return path;
}

const WINDOW_ID_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  try
    set frontWin to first window of frontApp whose value of attribute "AXMain" is true
    return (value of attribute "AXWindowNumber" of frontWin) as text
  end try
end tell
return ""
`;

async function frontWindowId(opts = {}) {
  const run = opts.run || runFile;
  const raw = await run("/usr/bin/osascript", ["-e", WINDOW_ID_SCRIPT], { timeout: 6000 });
  const id = String(raw || "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Run local Vision OCR on an image via the bundled Swift helper.
 * Returns structured blocks; falls back cleanly if `swift` is unavailable.
 */
export async function ocrImage(imagePath, opts = {}) {
  const run = opts.run || runFile;
  const helper = join(__dirname, "scripts", "vision-ocr.swift");
  try {
    const raw = await run("/usr/bin/swift", [helper, imagePath], { timeout: 20000 });
    const parsed = JSON.parse(raw);
    return {
      text: parsed.text || "",
      blocks: parsed.blocks || [],
      confidence: parsed.confidence ?? null,
      source: "ocr"
    };
  } catch (error) {
    const msg = String((error && (error.stderr || error.message)) || "");
    return { text: "", blocks: [], confidence: null, source: "ocr", error: /swift/i.test(msg) && /not found|ENOENT/i.test(msg) ? "swift-unavailable" : msg.split("\n")[0] };
  }
}

/** Capture the active window and OCR it locally, then delete the capture. */
export async function captureAndOcr(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { text: "", blocks: [], source: "ocr", error: "UI automation disabled" };
  let path = null;
  try {
    path = await captureFrontWindow(opts);
    const result = await ocrImage(path, opts);
    return result;
  } catch (error) {
    return { text: "", blocks: [], source: "ocr", error: String(error.message || error) };
  } finally {
    if (path) fs.unlink(path).catch(() => {}); // ephemeral: never persist a screenshot
  }
}

// ---- the public capability: ScreenContextProvider --------------------------

/**
 * Read the current screen context, honouring the perception priority order.
 * The model asks for this via the `read_screen` skill; it never picks the
 * mechanism — this does, escalating only as far as needed.
 *
 * @param {{prefer?: "auto"|"terminal"|"selection"|"ocr", run?: Function}} opts
 * @returns {Promise<ScreenContext>}
 */
export async function readScreenContext(opts = {}) {
  const fg = await foregroundApp(opts);
  const app = (fg.application || "").toLowerCase();
  const ctx = {
    application: fg.application,
    windowTitle: fg.windowTitle,
    focusedRole: fg.focusedRole,
    visibleText: "",
    selectedText: "",
    elements: [],
    source: fg.source,
    errors: fg.error ? [`foreground:${fg.error}`] : []
  };

  if (opts.prefer === "selection") {
    const sel = await selectedText(opts);
    ctx.selectedText = sel.text;
    ctx.source = "accessibility";
    if (sel.error) ctx.errors.push(`selection:${sel.error}`);
    return ctx;
  }

  // 2. App-specific: a Terminal in front gets its real buffer.
  const isTerminal = /terminal|iterm/.test(app) || opts.prefer === "terminal";
  if (isTerminal) {
    const term = await terminalContent(opts);
    if (term.text) {
      ctx.visibleText = term.text;
      ctx.windowTitle = ctx.windowTitle || term.title;
      ctx.source = "terminal";
      return ctx;
    }
    if (term.error) ctx.errors.push(`terminal:${term.error}`);
  }

  // 1. Structured Accessibility text for everything else.
  if (opts.prefer !== "ocr") {
    const vis = await visibleText(opts);
    if (vis.text) {
      ctx.visibleText = vis.text;
      ctx.source = "accessibility";
      return ctx;
    }
    if (vis.error) ctx.errors.push(`accessibility:${vis.error}`);
  }

  // 3. Last resort: local screen capture + Vision OCR.
  const ocr = await captureAndOcr(opts);
  if (ocr.text) {
    ctx.visibleText = ocr.text;
    ctx.source = "ocr";
  } else if (ocr.error) {
    ctx.errors.push(`ocr:${ocr.error}`);
  }
  return ctx;
}

// ---- visible-Terminal UI control (Part B2) ---------------------------------
// When the user explicitly wants the Terminal app driven (not a PTY Artemis
// owns), we focus it and type via Apple Events — structured control, never
// blind coordinate clicking.

function escapeAppleScriptString(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// When a contextual action was resolved against a specific tab, the SAME
// AppleScript invocation that performs the keystroke first proves the front
// tab is still that tab (its tty). Two separate calls would leave a gap a
// user tab-switch could fall into (Codex inspection: verify-and-act must be
// atomic). Empty expectTty → no guard.
function terminalTargetGuard(expectTty) {
  if (!expectTty) return "";
  const tty = escapeAppleScriptString(expectTty);
  return `
tell application "Terminal"
  if (count of windows) is 0 then error "no-terminal-window"
  if (tty of selected tab of front window as text) is not equal to "${tty}" then error "target-changed"
end tell
`;
}

function targetError(error, fallback) {
  const msg = String((error && (error.stderr || error.message)) || "");
  if (/target-changed/.test(msg)) return "target-changed";
  if (/no-terminal-window/.test(msg)) return "no-terminal-window";
  return fallback(error);
}

/**
 * Launch a RESOLVED installed application bundle by its absolute .app path.
 * Only appResolver output belongs here: the path must be an absolute bundle
 * path, never arbitrary user text — `open -a <path>` with an args array means
 * nothing is ever interpreted by a shell.
 */
export async function openApplication(appPath, opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { ok: false, error: "UI automation disabled" };
  const path = String(appPath || "");
  if (!path.startsWith("/") || !path.endsWith(".app")) {
    return { ok: false, error: "not-an-app-bundle" };
  }
  const run = opts.run || runFile;
  try {
    await run("/usr/bin/open", ["-a", path], { timeout: 8000 });
    return { ok: true, path };
  } catch (error) {
    const msg = String((error && (error.stderr || error.message)) || "");
    if (/Unable to find application|does not exist/i.test(msg)) return { ok: false, error: "app-not-found" };
    return { ok: false, error: msg.trim().split("\n")[0] || "launch-failed" };
  }
}

/** Bring Terminal.app forward, opening it if needed. */
export async function openTerminal(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { ok: false, error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    await run("/usr/bin/osascript", ["-e", 'tell application "Terminal" to activate'], { timeout: 6000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: automationError(error) };
  }
}

// Terminal just launched may have no window yet. Poll briefly (bounded, no
// blind sleeps) so typing lands in a real front window instead of the void.
const TERMINAL_WINDOW_COUNT_SCRIPT = 'tell application "Terminal" to return (count of windows) as text';

export async function waitForTerminalWindow(opts = {}, timeoutMs = 3000) {
  const run = opts.run || runFile;
  const wait = typeof opts.wait === "function" ? opts.wait : (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await run("/usr/bin/osascript", ["-e", TERMINAL_WINDOW_COUNT_SCRIPT], { timeout: 4000 });
      if (parseInt(String(raw).trim(), 10) > 0) return { ok: true };
    } catch (error) {
      return { ok: false, error: automationError(error) };
    }
    if (Date.now() >= deadline) return { ok: false, error: "no-terminal-window" };
    await wait(150);
  }
}

/**
 * Type text into the focused Terminal WITHOUT pressing Enter.
 *
 * Terminal's own `do script` always executes, so type-only has to go through
 * System Events keystrokes — which needs Terminal frontmost, an existing
 * window, and the Accessibility permission (distinct from the Automation →
 * Terminal permission that `do script`/buffer reads use).
 */
export async function typeInTerminal(text, opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { ok: false, error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    await run("/usr/bin/osascript", ["-e", 'tell application "Terminal" to activate'], { timeout: 6000 });
  } catch (error) {
    return { ok: false, text, error: automationError(error) };
  }
  const ready = await waitForTerminalWindow(opts);
  if (!ready.ok) return { ok: false, text, error: ready.error };
  const script =
    terminalTargetGuard(opts.expectTty) +
    `tell application "System Events" to tell process "Terminal" to keystroke "${escapeAppleScriptString(text)}"`;
  try {
    await run("/usr/bin/osascript", ["-e", script], { timeout: 8000 });
    const after = await terminalContent(opts);
    return { ok: true, text, visibleAfter: after.text, source: "terminal" };
  } catch (error) {
    return { ok: false, text, error: targetError(error, accessibilityError) };
  }
}

/**
 * Press Enter in the frontmost Terminal window — submits whatever is already
 * typed or activates the highlighted TUI control. A distinct primitive (not
 * `do script`) because there is no text: this is one Return keystroke, scoped
 * to the Terminal process, behind the same permission vocabulary as typing.
 */
export async function pressEnterInTerminal(opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { ok: false, error: "UI automation disabled" };
  const run = opts.run || runFile;
  try {
    await run("/usr/bin/osascript", ["-e", 'tell application "Terminal" to activate'], { timeout: 6000 });
  } catch (error) {
    return { ok: false, error: automationError(error) };
  }
  const ready = await waitForTerminalWindow(opts);
  if (!ready.ok) return { ok: false, error: ready.error };
  const script =
    terminalTargetGuard(opts.expectTty) +
    'tell application "System Events" to tell process "Terminal" to key code 36';
  try {
    await run("/usr/bin/osascript", ["-e", script], { timeout: 8000 });
    const after = await terminalContent(opts);
    return { ok: true, visibleAfter: after.text, source: "terminal" };
  } catch (error) {
    return { ok: false, error: targetError(error, accessibilityError) };
  }
}

/**
 * Type a command into the frontmost Terminal tab and (optionally) run it.
 * Uses Terminal's `do script ... in front window`, which types the text into
 * the tab exactly and submits it — no keystroke synthesis, no coordinates.
 * The observation comes back by reading the buffer after a settle delay.
 */
export async function runInTerminal(command, opts = {}) {
  if (AUTOMATION_DISABLED(opts)) return { ok: false, error: "UI automation disabled" };
  const run = opts.run || runFile;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 1500;
  const cmd = escapeAppleScriptString(command);
  const guard = opts.expectTty
    ? `if (tty of selected tab of front window as text) is not equal to "${escapeAppleScriptString(opts.expectTty)}" then error "target-changed"\n    `
    : "";
  const script = `
tell application "Terminal"
  activate
  if (count of windows) is 0 then
    ${opts.expectTty ? 'error "target-changed"' : `do script "${cmd}"`}
  else
    ${guard}do script "${cmd}" in front window
  end if
end tell
`;
  try {
    await run("/usr/bin/osascript", ["-e", script], { timeout: 10000 });
    if (settleMs > 0 && typeof opts.wait === "function") await opts.wait(settleMs);
    const after = await terminalContent(opts);
    return { ok: true, command, visibleAfter: after.text, source: "terminal" };
  } catch (error) {
    return { ok: false, command, error: targetError(error, automationError) };
  }
}
