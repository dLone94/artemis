// Direct shell execution with structured observation.
//
// This is the PREFERRED execution mode: Artemis owns the process, so she
// observes real stdout/stderr/exit status instead of reading pixels. The
// visible-Terminal path (macPerception.runInTerminal) exists only for when the
// user explicitly wants the Terminal app driven.
//
// Every result is a typed observation — command, cwd, stdout, stderr,
// exitCode, duration, status — so the reporting layer can tell the truth
// ("exit code 1, first error …") instead of saying "Done."
//
// Permission checks live in commandPolicy.js and are enforced by the skill
// BEFORE anything reaches runCommand. This module still refuses to run outside
// an approved workspace, so a future caller can't skip the boundary.

import { spawn } from "node:child_process";
import {
  approvedWorkspaces,
  resolveWorkingDirectory,
  redactSecrets
} from "./commandPolicy.js";

const MAX_CAPTURE = 256 * 1024; // per stream; enough to diagnose, bounded for the model
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Run one command line under the user's shell, inside an approved workspace.
 *
 * @param {string} command
 * @param {{workingDirectory?: string, timeoutMs?: number, env?: object, workspaces?: string[], signal?: AbortSignal}} opts
 * @returns {Promise<{command, workingDirectory, stdout, stderr, exitCode, durationMs, status, truncated}>}
 */
export async function runCommand(command, opts = {}) {
  const text = String(command || "").trim();
  const workspaces = opts.workspaces || approvedWorkspaces(opts.env || process.env, opts);
  const wd = resolveWorkingDirectory(opts.workingDirectory, { workspaces });
  if (!text) {
    return finished(text, null, "", "no command given", null, 0, "error");
  }
  if (!wd.ok) {
    return finished(text, opts.workingDirectory, "", wd.error, null, 0, "refused");
  }

  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1), 10 * 60 * 1000);
  const started = Date.now();

  return await new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;

    // -c (not -lc): login shells source the user's full profile, which can be
    // slow and side-effectful; the command still gets a real zsh with PATH from
    // our own environment.
    const child = spawn("/bin/zsh", ["-c", text], {
      cwd: wd.dir,
      env: { ...process.env, ...(opts.envVars || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch (e) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 3000).unref();
    }, timeoutMs);

    if (opts.signal) {
      const onAbort = () => { try { child.kill("SIGTERM"); } catch (e) {} };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const capture = (chunk, current) => {
      if (current.length >= MAX_CAPTURE) { truncated = true; return current; }
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_CAPTURE) { truncated = true; return next.slice(0, MAX_CAPTURE); }
      return next;
    };
    child.stdout.on("data", (c) => { stdout = capture(c, stdout); });
    child.stderr.on("data", (c) => { stderr = capture(c, stderr); });

    const settle = (exitCode, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(finished(text, wd.dir, stdout, stderr, exitCode, Date.now() - started, status, truncated));
    };

    child.on("error", (error) => settle(null, "error", (stderr = stderr || error.message)));
    child.on("close", (code) => {
      settle(code, timedOut ? "timeout" : code === 0 ? "ok" : "error");
    });
  });
}

function finished(command, workingDirectory, stdout, stderr, exitCode, durationMs, status, truncated = false) {
  return {
    command,
    workingDirectory,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    exitCode,
    durationMs,
    status, // ok | error | timeout | refused
    truncated
  };
}

/** First line that looks like the actual failure, for honest reporting. */
export function firstErrorLine(result) {
  const source = (result.stderr || "") + "\n" + (result.stdout || "");
  const lines = source.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    lines.find((l) => /error|failed|failing|exception|not found|cannot|denied|fatal/i.test(l)) ||
    lines[lines.length - 1] ||
    ""
  );
}

/**
 * The observation loop: inspect the evidence and report truthfully.
 * Never claims success without a zero exit code.
 */
export function summarizeResult(result) {
  if (result.status === "refused") return `I didn't run that: ${result.stderr}`;
  if (result.status === "timeout") {
    return `\`${result.command}\` was still running after ${Math.round(result.durationMs / 1000)}s, so I stopped it.`;
  }
  if (result.status === "ok") {
    const out = (result.stdout || "").trim();
    const tail = out ? out.split("\n").slice(-3).join(" ").slice(0, 220) : "";
    const passes = out.match(/(\d+)\s+(?:passing|passed|assertions? passed|tests? passed)/i);
    if (passes) return `That finished successfully — ${passes[0]}.`;
    return tail
      ? `That finished successfully. Last output: ${tail}`
      : "That finished successfully with no output.";
  }
  const firstError = firstErrorLine(result).slice(0, 220);
  const code = result.exitCode == null ? "" : ` with exit code ${result.exitCode}`;
  return firstError
    ? `The command failed${code}. First error: ${firstError}`
    : `The command failed${code} and printed nothing.`;
}

/** Bounded, redacted content block for the model. */
export function resultContent(result) {
  const clip = (s, n) => {
    const v = String(s || "").trim();
    return v.length > n ? v.slice(0, n) + `\n…[truncated ${v.length - n} chars]` : v;
  };
  return [
    `command: ${result.command}`,
    `cwd: ${result.workingDirectory || "?"}`,
    `status: ${result.status}  exit: ${result.exitCode == null ? "none" : result.exitCode}  duration: ${result.durationMs}ms`,
    result.stdout ? `stdout:\n${clip(result.stdout, 6000)}` : "stdout: (empty)",
    result.stderr ? `stderr:\n${clip(result.stderr, 3000)}` : "stderr: (empty)"
  ].join("\n");
}
