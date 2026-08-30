// macOS permission-status layer.
//
// Artemis needs to know, without triggering prompts, whether she can perceive
// and control the machine. Each permission resolves to one of:
//   granted | denied | not-determined | unavailable
//
// We DETECT rather than request: probing must never repeatedly pop the OS
// permission dialog. Detection uses cheap, side-effect-free reads (a tiny AX
// query, a TCC db read where possible) and treats any ambiguity as
// not-determined so the UI can explain what to enable and why.

import { execFile } from "node:child_process";
import { platform } from "node:os";

const STATUS = Object.freeze({
  granted: "granted",
  denied: "denied",
  notDetermined: "not-determined",
  unavailable: "unavailable"
});

function runFile(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const IS_MAC = platform() === "darwin";

/**
 * Accessibility: can we read/drive other apps' UI?
 * A one-shot AX query that returns cleanly means granted; the specific
 * "not allowed assistive access" error means denied; anything else is unknown.
 */
export async function accessibilityStatus(opts = {}) {
  if (!IS_MAC) return STATUS.unavailable;
  if (process.env.ARTEMIS_DISABLE_UI_AUTOMATION === "1") return STATUS.unavailable;
  const run = opts.run || runFile;
  const { error, stdout, stderr } = await run("/usr/bin/osascript",
    ["-e", 'tell application "System Events" to return name of first application process whose frontmost is true']);
  if (!error && stdout.trim()) return STATUS.granted;
  const msg = (stderr || (error && error.message) || "").toLowerCase();
  if (/not allowed assistive|accessibility|-25211|1002/.test(msg)) return STATUS.denied;
  return STATUS.notDetermined;
}

/**
 * Screen Recording: required for screencapture to return real pixels.
 * We do NOT capture to test — that could prompt. We read the TCC decision.
 */
export async function screenRecordingStatus(opts = {}) {
  if (!IS_MAC) return STATUS.unavailable;
  const run = opts.run || runFile;
  // CGPreflightScreenCaptureAccess would be ideal but needs native code; the
  // TCC db records the decision for services we can read without prompting.
  const { error, stdout } = await run("/usr/bin/sqlite3", [
    `${process.env.HOME}/Library/Application Support/com.apple.TCC/TCC.db`,
    "SELECT auth_value FROM access WHERE service='kTCCServiceScreenCapture' LIMIT 1;"
  ]);
  if (error) return STATUS.notDetermined; // db is usually SIP-protected; unknown, not denied
  const v = stdout.trim();
  if (v === "2") return STATUS.granted;
  if (v === "0") return STATUS.denied;
  if (v === "") return STATUS.notDetermined;
  return STATUS.notDetermined;
}

/** Automation (Apple Events) toward Terminal specifically. */
export async function automationStatus(opts = {}) {
  if (!IS_MAC) return STATUS.unavailable;
  if (process.env.ARTEMIS_DISABLE_UI_AUTOMATION === "1") return STATUS.unavailable;
  const run = opts.run || runFile;
  const { error, stderr } = await run("/usr/bin/osascript",
    ["-e", 'tell application "System Events" to return count of processes'], 4000);
  if (!error) return STATUS.granted;
  const msg = (stderr || (error && error.message) || "").toLowerCase();
  if (/not authorized|-1743|1002/.test(msg)) return STATUS.denied;
  return STATUS.notDetermined;
}

/**
 * Microphone status is owned by the WebKit shell (getUserMedia), not Node.
 * We report unavailable here so the caller knows to ask the browser layer.
 */
export function microphoneStatus() {
  return STATUS.unavailable; // determined in the page via navigator.permissions
}

/** Aggregate snapshot for /api/permissions and the dashboard. */
export async function permissionSnapshot(opts = {}) {
  if (!IS_MAC) {
    return {
      platform: platform(),
      accessibility: STATUS.unavailable,
      screenRecording: STATUS.unavailable,
      automation: STATUS.unavailable,
      microphone: STATUS.unavailable
    };
  }
  const [accessibility, screenRecording, automation] = await Promise.all([
    accessibilityStatus(opts),
    screenRecordingStatus(opts),
    automationStatus(opts)
  ]);
  return {
    platform: "darwin",
    accessibility,
    screenRecording,
    automation,
    microphone: microphoneStatus()
  };
}

/** Human-readable "what and why" for a permission that is not granted. */
export function permissionGuidance(name) {
  const guide = {
    accessibility: {
      why: "read what's on screen and type into other apps",
      how: "System Settings → Privacy & Security → Accessibility → enable Artemis"
    },
    screenRecording: {
      why: "capture a window when Accessibility text isn't available (OCR fallback)",
      how: "System Settings → Privacy & Security → Screen Recording → enable Artemis"
    },
    automation: {
      why: "open Terminal and read its visible output",
      how: "System Settings → Privacy & Security → Automation → allow Artemis to control Terminal"
    },
    microphone: {
      why: "hear your voice",
      how: "System Settings → Privacy & Security → Microphone → enable Artemis"
    }
  };
  return guide[name] || null;
}

export { STATUS as PERMISSION_STATUS };
