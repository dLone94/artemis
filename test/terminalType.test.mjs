// Literal terminal typing: deterministically parsed, safely executed.
//
// Regression: "Type ai inside the Terminal." classified as plain chat — no
// family, no tool — so Artemis said she couldn't do it. When the user DICTATES
// the exact text, no model is needed: terminalTypeForText parses it, the
// computer family routes it, and computer_control types it (type_text = no
// Enter; type_and_run = Enter). Ambiguous context commands stay with the brain.
//
// Run: node --test test/terminalType.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, terminalTypeForText, needsConfirmation } from "../toolRegistry.js";
import { typeInTerminal, waitForTerminalWindow, runInTerminal } from "../macPerception.js";
import { computerControlSkill } from "../computerSkills.js";

const CAPS = { search: true, gmail: true, vault: true };

// ---- the deterministic parser ----------------------------------------------

test("literal typing phrases parse to exact text + submit flag", () => {
  const cases = [
    ["type ai", "ai", false],
    ["type ai in Terminal", "ai", false],
    ["Type ai inside the Terminal.", "ai", false],
    ["type ai and run it", "ai", true],
    ["type 'npm test' and run it", "npm test", true],
    ["in Terminal type git status and run it", "git status", true],
    ["write ai in Terminal", "ai", false],
    ["type echo hello Artemis and run it", "echo hello Artemis", true],
    ["type ls and press enter", "ls", true],
    ["type ai in the terminal and run it", "ai", true]
  ];
  for (const [phrase, text, submit] of cases) {
    const parsed = terminalTypeForText(phrase);
    assert.ok(parsed, `"${phrase}" parses`);
    assert.equal(parsed.text, text, `"${phrase}" → text "${text}"`);
    assert.equal(parsed.submit, submit, `"${phrase}" → submit ${submit}`);
  }
});

test("ambiguous or context-dependent phrases are NOT deterministic typing", () => {
  for (const phrase of [
    "tell Claude to continue",
    "do whatever Claude asks",
    "type whatever it asks",
    "type it",
    "type what Claude wants",
    "write a note about the meeting",
    "Run whatever is needed",
    "Fix the terminal"
  ]) {
    assert.equal(terminalTypeForText(phrase), null, `"${phrase}" must not parse as literal typing`);
    const intent = classifyIntent(phrase, CAPS, []);
    assert.ok(!intent.terminalType, `"${phrase}" carries no terminalType intent`);
  }
});

test("classifyIntent routes literal typing to the computer family with terminalType", () => {
  const intent = classifyIntent("type ai and run it", CAPS, []);
  assert.equal(intent.family, "computer");
  assert.deepEqual(intent.terminalType, { text: "ai", submit: true, literal: false, deictic: false, singleKey: false });
  assert.deepEqual(intent.expected, ["computer_control"]);
});

// ---- confirmation policy ----------------------------------------------------

test("type_text never confirms; type_and_run confirms only approval-risk commands", () => {
  // typing without Enter is inert — even risky text just sits there visibly
  assert.equal(needsConfirmation("computer_control", { args: { action: "type_text", text: "sudo ls" } }), false);
  // safe/controlled commands run without a prompt
  assert.equal(needsConfirmation("computer_control", { args: { action: "type_and_run", text: "ls" } }), false);
  assert.equal(needsConfirmation("computer_control", { args: { action: "type_and_run", text: "ai" } }), false);
  // approval-risk commands still ask first
  assert.equal(needsConfirmation("computer_control", { args: { action: "type_and_run", text: "sudo ls" } }), true);
});

test("blocked text is refused by precheck even for type-only", () => {
  const pre = computerControlSkill.precheck({ action: "type_text", text: "rm -rf /" });
  assert.equal(pre.ok, false, "a destructive command must not sit one keystroke from running");
});

// ---- the native boundary, with an injected runner ---------------------------

function fakeOsascript(script) {
  // returns a runner that answers each osascript -e call via the given map
  return async (file, args) => {
    const src = args[args.length - 1];
    for (const [needle, answer] of script) {
      if (src.includes(needle)) {
        if (answer instanceof Error) throw answer;
        if (typeof answer === "function") return answer();
        return answer;
      }
    }
    return "";
  };
}
const err = (stderr) => Object.assign(new Error("osascript failed"), { stderr });

test("typeInTerminal: success path types without Enter and observes the buffer", async () => {
  const keystrokes = [];
  const run = fakeOsascript([
    ["activate", ""],
    ["(count of windows) as text", "1"],
    ["keystroke", () => { keystrokes.push(1); return ""; }],
    ["contents of selected tab", "shell\n---\n$ ai"]
  ]);
  const r = await typeInTerminal("ai", { run, wait: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(keystrokes.length, 1, "exactly one keystroke call");
  assert.match(r.visibleAfter, /\$ ai/, "the observation reads the real buffer");
});

test("typeInTerminal: missing Accessibility permission returns a structured code", async () => {
  const run = fakeOsascript([
    ["activate", ""],
    ["(count of windows) as text", "1"],
    ["keystroke", err("osascript is not allowed assistive access")]
  ]);
  const r = await typeInTerminal("ai", { run, wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, "accessibility-denied");
});

test("typeInTerminal: missing Automation permission returns a structured code", async () => {
  const run = fakeOsascript([
    ["activate", err("Not authorized to send Apple events to Terminal. (-1743)")]
  ]);
  const r = await typeInTerminal("ai", { run, wait: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, "automation-denied");
});

test("terminal readiness: polls briefly, then reports no-terminal-window", async () => {
  let polls = 0;
  const run = fakeOsascript([["count of windows", () => { polls++; return "0"; }]]);
  const r = await waitForTerminalWindow({ run, wait: async () => {} }, 300);
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-terminal-window");
  assert.ok(polls >= 2, "readiness actually polled rather than failing instantly");
});

test("terminal readiness: a window appearing during the poll succeeds", async () => {
  let polls = 0;
  const run = fakeOsascript([["count of windows", () => (++polls < 3 ? "0" : "1")]]);
  const r = await waitForTerminalWindow({ run, wait: async () => {} }, 3000);
  assert.equal(r.ok, true);
});

test("runInTerminal: executes via do script and reports the visible result", async () => {
  const scripts = [];
  const run = async (file, args) => {
    const src = args[args.length - 1];
    scripts.push(src);
    if (src.includes("contents of selected tab")) return "shell\n---\n$ ai\nartemis ready";
    return "";
  };
  const r = await runInTerminal("ai", { run, wait: async () => {} });
  assert.equal(r.ok, true);
  assert.ok(scripts.some((s) => s.includes('do script "ai"')), "uses Terminal's structured do script");
  assert.match(r.visibleAfter, /artemis ready/, "the reported result is the REAL buffer content");
});
