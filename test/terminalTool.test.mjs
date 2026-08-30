// The terminal tool's observation logic: structured result, honest summaries,
// bounded output, workspace refusal, real execution. Uses harmless real
// commands (echo/false/pwd) — no macOS permissions involved.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runCommand, summarizeResult, firstErrorLine, resultContent } from "../terminalTool.js";

const WS = { workspaces: [tmpdir()], workingDirectory: tmpdir() };

// success: real stdout, zero exit, ok status
{
  const r = await runCommand("echo hello", WS);
  assert.equal(r.status, "ok");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello/);
  assert.ok(r.durationMs >= 0);
  assert.match(summarizeResult(r), /finished successfully/i);
}

// failure: non-zero exit is reported truthfully, never as success
{
  const r = await runCommand("false", WS);
  assert.equal(r.status, "error");
  assert.notEqual(r.exitCode, 0);
  assert.match(summarizeResult(r), /failed/i);
}

// stderr surfaces as the first error line
{
  const r = await runCommand("ls /nonexistent-path-xyz-123", WS);
  assert.equal(r.status, "error");
  const line = firstErrorLine(r);
  assert.match(line, /No such file|not found|cannot/i);
}

// working directory is honoured and reported
{
  const r = await runCommand("pwd", WS);
  assert.equal(r.status, "ok");
  assert.match(r.stdout.trim(), new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(r.workingDirectory, tmpdir());
}

// workspace escape is refused before execution
{
  const r = await runCommand("echo x", { workspaces: [tmpdir()], workingDirectory: "/etc" });
  assert.equal(r.status, "refused");
  assert.match(r.stderr, /outside the approved workspace/i);
}

// secrets in output are redacted
{
  const r = await runCommand("echo token=sk-abcdefghijklmnopqrstuvwx", WS);
  assert.match(r.stdout, /\[redacted\]/);
}

// timeout is a distinct, honest status
{
  const r = await runCommand("sleep 5", { ...WS, timeoutMs: 200 });
  assert.equal(r.status, "timeout");
  assert.match(summarizeResult(r), /still running/i);
}

// test-count parsing produces a useful summary
{
  const r = await runCommand("echo '151 assertions passed'", WS);
  assert.match(summarizeResult(r), /151 assertions passed/);
}

// resultContent is bounded and structured
{
  const r = await runCommand("echo hi", WS);
  const c = resultContent(r);
  assert.match(c, /command: echo hi/);
  assert.match(c, /status: ok/);
  assert.match(c, /exit: 0/);
}

console.log("✓ terminalTool: structured observation, honest summaries, workspace boundary, timeout");
