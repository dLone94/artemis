// Asking her to check herself, and what she says back.
//
// Run: node --test test/healthIntent.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  healthIntentForText, healthReply, startupAnnouncement,
  fullDiagnosticText, healthBadge, recoveredAnnouncement
} from "../healthIntent.js";
import { HEALTHY, DEGRADED, FAILED, RECOVERING, DISABLED, UNKNOWN } from "../selfHealth.js";

/* ------------------------------------------------------------ the asking */

test("every phrasing in the brief is recognised as a quick self-check", () => {
  for (const phrase of [
    "Artemis, run a self-check.",
    "Check yourself.",
    "Run diagnostics.",
    "Run a diagnostic",
    "Are all your systems working?",
    "Is anything wrong?",
    "What's malfunctioning?",
    "what is broken",
    "Are you okay?",
    "system health",
    "health check",
    "self test",
    "diagnose yourself",
    "how are your systems"
  ]) {
    const r = healthIntentForText(phrase);
    assert.ok(r, `"${phrase}" must be recognised`);
    assert.equal(r.depth, "quick", `"${phrase}" should be the cheap check`);
  }
});

test("asking for depth gets the deep check, and is never mistaken for the quick one", () => {
  for (const phrase of [
    "Give me the full diagnostic.",
    "give me a full diagnostic",
    "run a complete diagnostic",
    "I want a detailed diagnostic",
    "run a deep check",
    "full health report",
    "run a thorough self-check"
  ]) {
    const r = healthIntentForText(phrase);
    assert.ok(r, `"${phrase}" must be recognised`);
    assert.equal(r.depth, "deep", `"${phrase}" must run the expensive checks`);
  }
});

test("questions about the idea, or about the Mac, are not requests to self-check", () => {
  for (const phrase of [
    "how do I run a diagnostic",
    "what is a self-check",
    "run my mac's diagnostic",
    "check the weather",
    "is anything on sale"
  ]) {
    assert.equal(healthIntentForText(phrase), null, `"${phrase}" must not trigger a self-check`);
  }
});

/* ------------------------------------------------------------ the answer */

const snapOf = (issues, overall = issues.length ? DEGRADED : HEALTHY) => ({
  overall, issueCount: issues.length, issues, checkedAt: 0, subsystems: {}
});

test("a healthy system gets exactly one short sentence", () => {
  const reply = healthReply(snapOf([]));
  assert.equal(reply, "All core systems are healthy.");
  assert.ok(reply.length < 60, "the default answer must stay short");
});

test("one degraded system is reported concisely, naming it", () => {
  // Wording follows the spoken-summary spec: "I found one issue. <what>." The
  // earlier "one degraded system" phrasing left the count and the thing itself
  // in separate clauses, which is what made longer lists fall apart.
  const reply = healthReply(snapOf([
    { id: "voice.sttLocal", label: "local speech recognition", status: DEGRADED, errorCode: "STT_LOCAL_MODEL_MISSING", summary: "the local speech model is not installed" }
  ]));
  assert.equal(reply, "I found one issue. The local speech model is not installed.");
  assert.ok(reply.split(".").length <= 3, `expected at most two sentences, got: ${reply}`);
});

test("a failure in flight says she is restoring it", () => {
  const reply = healthReply(snapOf([
    { id: "voice.wake", label: "wake listener", status: RECOVERING, recoveryState: "recovering", summary: "restoring wake listener" }
  ], DEGRADED));
  assert.match(reply, /wake listener stopped/i);
  assert.match(reply, /restoring it now/i);
});

test("two issues are both named, in one sentence", () => {
  const reply = healthReply(snapOf([
    { id: "voice.wake", label: "voice wake", status: DEGRADED, summary: "voice wake is degraded" },
    { id: "integrations.gmail", label: "Gmail", status: DEGRADED, summary: "Gmail sign-in has expired" }
  ]));
  assert.match(reply, /two issues/i);
  assert.match(reply, /wake/i);
  assert.match(reply, /Gmail/i);
});

test("many issues do not become a recital", () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `x.${i}`, label: `thing ${i}`, status: DEGRADED, summary: `thing ${i} is degraded` }));
  const reply = healthReply(snapOf(many));
  assert.match(reply, /six issues/i);
  assert.match(reply, /four other systems are degraded/i, "the tail is counted, not listed");
  assert.ok(reply.length < 200, `too long to speak: ${reply}`);
});

test("an unfinished first scan says so instead of claiming health", () => {
  assert.match(healthReply(snapOf([], UNKNOWN)), /haven't finished checking/i);
});

/* ---------------------------------------------------------- at startup */

test("a healthy startup says NOTHING", () => {
  assert.equal(startupAnnouncement(snapOf([])), null, "a spoken all-clear on every launch is noise");
});

test("a degraded startup is one calm sentence with the reassurance", () => {
  const said = startupAnnouncement(snapOf([
    { id: "voice.sttLocal", label: "local speech engine", status: DEGRADED, summary: "my local speech engine is unavailable" }
  ]));
  assert.match(said, /one issue/i);
  assert.match(said, /everything else is working/i);
});

test("a critical startup failure leads with the problem and the attempt", () => {
  const said = startupAnnouncement({
    ...snapOf([{ id: "voice.wake", label: "wake listener", status: FAILED, critical: true, recoveryState: "recovering", summary: "not armed" }], FAILED)
  });
  assert.match(said, /problem with my wake listener/i);
  assert.match(said, /trying to restore it/i);
});

test("a recovery the user should know about is announced plainly", () => {
  assert.equal(recoveredAnnouncement("wake listener"), "Wake listener restored.");
});

/* ----------------------------------------------------- full diagnostic */

test("the full diagnostic is readable, and says WHY a thing is disabled", () => {
  const text = fullDiagnosticText({
    overall: DEGRADED,
    issues: [],
    subsystems: {
      voice: {
        overall: HEALTHY,
        components: {
          wake: { status: HEALTHY, label: "wake listener" },
          sttLocal: { status: HEALTHY, label: "local speech recognition" }
        }
      },
      ai: {
        overall: HEALTHY,
        components: {
          local: { status: HEALTHY, label: "local model" },
          cloud: { status: DISABLED, label: "cloud models", details: { reason: "mode" } }
        }
      },
      integrations: {
        overall: DEGRADED,
        components: {
          gmail: { status: DEGRADED, label: "Gmail", summary: "Gmail sign-in has expired" }
        }
      }
    }
  });

  assert.match(text, /^VOICE$/m);
  assert.match(text, /Wake listener: Healthy/);
  assert.match(text, /Cloud models: Disabled by Local-Only mode/,
    "the brief's exact distinction: disabled by mode, not failed");
  assert.match(text, /Gmail: Degraded — Gmail sign-in has expired/);
  assert.match(text, /Overall: Degraded$/);
  assert.ok(!/FAILED/.test(text), "nothing disabled may be rendered as failed");
});

test("a dependent failure is shown with its cause, so the report is not misleading", () => {
  const text = fullDiagnosticText({
    overall: DEGRADED,
    subsystems: {
      integrations: { overall: DEGRADED, components: { gmail: { status: DEGRADED, label: "Gmail", summary: "unreachable", dependency: "network.link" } } }
    }
  });
  assert.match(text, /caused by network\.link/);
});

/* ------------------------------------------------------------- the badge */

test("the UI badge is the short truth the SYSTEM panel needs", () => {
  assert.deepEqual(healthBadge(snapOf([])), { label: "NOMINAL", tone: "ok" });
  assert.deepEqual(
    healthBadge(snapOf([{ id: "a", label: "a", status: DEGRADED }])),
    { label: "1 DEGRADED", tone: "warn" }
  );
  assert.deepEqual(
    healthBadge(snapOf([{ id: "a", label: "a", status: FAILED }], FAILED)),
    { label: "1 FAILED", tone: "critical" }
  );
  assert.deepEqual(healthBadge(snapOf([], UNKNOWN)), { label: "CHECKING", tone: "unknown" });
});

/* ------------------------------------------------------------------------ */
/* The spoken-summary bug, and the invariants that stop it coming back.      */
/*                                                                          */
/* Live report: "I found three issues. Screen Recording permission is       */
/* missing, and local speech recognition: local speech recognition is       */
/* unavailable. There is one more."                                        */
/*                                                                          */
/* Two faults in one sentence: the label was pasted onto a summary that     */
/* already began with it, and the count said three while the list named two.*/
/* ------------------------------------------------------------------------ */

/** The exact three issues the running app produced, verbatim from its snapshot. */
const LIVE_THREE = [
  { id: "computer.screenRecording", label: "Screen Recording", status: FAILED, errorCode: "PERMISSION_SCREEN_RECORDING_MISSING", summary: "Screen Recording permission is missing", recoveryState: "idle", repeatedFault: 0 },
  { id: "voice.sttLocal", label: "local speech recognition", status: DEGRADED, errorCode: "STT_LOCAL_BINARY_MISSING", summary: "local speech recognition is unavailable", recoveryState: "idle", repeatedFault: 0 },
  { id: "runtime.presence", label: "presence bus", status: DEGRADED, errorCode: "RUNTIME_PRESENCE_STALE", summary: "no presence update in 146 seconds", recoveryState: "idle", repeatedFault: 8 }
];

test("the exact broken sentence can never be produced again", () => {
  const reply = healthReply(snapOf(LIVE_THREE));

  assert.ok(!reply.includes("local speech recognition: local speech recognition"),
    `the duplicated label is back: ${reply}`);
  assert.ok(!/\b(\w[\w\s]{2,}?): \1/i.test(reply), `a label is duplicated across a colon: ${reply}`);
  assert.ok(!reply.includes(":"), `no colon belongs in a spoken summary: ${reply}`);
  assert.ok(!/There (is|are) \w+ more/.test(reply), "three issues must be named, not two plus a vague remainder");
});

test("1 issue — named, complete, no count/list mismatch", () => {
  const reply = healthReply(snapOf([LIVE_THREE[0]]));
  assert.equal(reply, "I found one issue. Screen Recording permission is missing.");
});

test("2 issues — both named, joined with a comma and 'and'", () => {
  const reply = healthReply(snapOf(LIVE_THREE.slice(0, 2)));
  assert.equal(reply,
    "I found two issues. Screen Recording permission is missing, and local speech recognition is unavailable.");
});

test("3 issues — all three named", () => {
  const reply = healthReply(snapOf(LIVE_THREE));
  assert.equal(reply,
    "I found three issues. Screen Recording permission is missing, local speech recognition is unavailable, " +
    "and my presence stream has gone quiet.");
});

test("more than 3 — first two named, the rest truthfully totalled", () => {
  const five = [
    LIVE_THREE[0], LIVE_THREE[1], LIVE_THREE[2],
    { id: "storage.disk", label: "disk space", status: DEGRADED, errorCode: "STORAGE_LOW_SPACE", summary: "disk space is low (1.2 GB free)" },
    { id: "voice.tts", label: "speech output", status: DEGRADED, errorCode: "TTS_UNAVAILABLE", summary: "no speech output provider is available" }
  ];
  const reply = healthReply(snapOf(five));
  assert.equal(reply,
    "I found five issues. Screen Recording permission is missing, local speech recognition is unavailable, " +
    "and three other systems are degraded.");
});

test("a remainder containing a real failure is not called merely 'degraded'", () => {
  const five = [
    LIVE_THREE[1], LIVE_THREE[2],
    LIVE_THREE[0],                                                   // FAILED, in the tail
    { id: "a", label: "a", status: DEGRADED, errorCode: "STORAGE_LOW_SPACE" },
    { id: "b", label: "b", status: DEGRADED, errorCode: "TTS_UNAVAILABLE" }
  ];
  assert.match(healthReply(snapOf(five)), /three other systems need attention/);
});

test("a label identical to its summary is spoken once, not twice", () => {
  // The degenerate case the brief calls out explicitly.
  const reply = healthReply(snapOf([
    { id: "voice.sttLocal", label: "Local speech recognition", status: DEGRADED, summary: "Local speech recognition" }
  ]));
  assert.ok(!/Local speech recognition.*Local speech recognition/i.test(reply), `spoken twice: ${reply}`);
  assert.ok(!reply.includes(":"), reply);
});

test("a summary with no subject of its own gets one, without a colon", () => {
  // "no presence update in 146 seconds" is an observation, not a sentence.
  const reply = healthReply(snapOf([
    { id: "runtime.presence", label: "presence bus", status: DEGRADED, summary: "no presence update in 146 seconds" }
  ]));
  assert.equal(reply, "I found one issue. Presence bus is degraded.");
  assert.ok(!reply.includes(":"), reply);
});

test("dev markers and remedies never reach speech", () => {
  const injected = healthReply(snapOf([
    { id: "voice.sttLocal", label: "local speech recognition", status: FAILED, summary: "local speech engine unavailable (injected)" }
  ]));
  assert.ok(!injected.includes("(injected)"), `dev marker spoken: ${injected}`);

  const remedy = healthReply(snapOf([
    { id: "voice.sttLocal", label: "local speech recognition", status: DEGRADED, summary: "whisper binary is missing — run npm run setup:stt" }
  ]));
  assert.ok(!remedy.includes("npm run"), `a shell command was spoken: ${remedy}`);
});

test("every spoken reply is a complete, well-formed sentence", () => {
  const cases = [
    snapOf([]), snapOf([LIVE_THREE[0]]), snapOf(LIVE_THREE.slice(0, 2)), snapOf(LIVE_THREE),
    snapOf([...LIVE_THREE, ...LIVE_THREE]), snapOf([], UNKNOWN)
  ];
  for (const snap of cases) {
    const reply = healthReply(snap);
    assert.ok(reply.length > 0, "never empty");
    assert.match(reply, /[.?!]$/, `must end in punctuation: ${reply}`);
    assert.ok(!/[,;:]\s*$/.test(reply), `must not trail off: ${reply}`);
    assert.ok(!reply.includes(":"), `no colons: ${reply}`);
    assert.ok(!/\band\s*$/.test(reply), `must not end on "and": ${reply}`);
    assert.ok(!/\{|\}|\[|\]|"/.test(reply), `no JSON punctuation: ${reply}`);
    assert.ok(!/[A-Z]{3,}_[A-Z_]+/.test(reply), `no error codes: ${reply}`);
    assert.ok(!/\bat\s+\S+:\d+/.test(reply), `no stack frames: ${reply}`);
  }
});

test("the spoken count ALWAYS equals the number of grouped issues", () => {
  // The invariant the bug violated. Checked across every length, including the
  // range where the tail is summarised rather than named.
  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  for (let n = 1; n <= 10; n += 1) {
    const issues = Array.from({ length: n }, (_, i) => ({
      id: `x.${i}`, label: `system ${i}`, status: DEGRADED, errorCode: "STORAGE_LOW_SPACE", summary: "disk space is low"
    }));
    const snap = snapOf(issues);
    assert.equal(snap.issueCount, snap.issues.length, "the snapshot must be self-consistent");
    const reply = healthReply(snap);
    if (n === 1) { assert.match(reply, /^I found one issue\./); continue; }
    assert.ok(reply.startsWith(`I found ${WORDS[n]} issues.`),
      `${n} grouped issues must be spoken as "${WORDS[n]}": ${reply}`);
  }
});

test("disabled and dependency-grouped components never reach the spoken list", () => {
  // issues[] is already the grouped, non-disabled set — the phrasing layer must
  // read it as-is and never count from anywhere else.
  const snap = {
    overall: DEGRADED,
    // Deliberately inconsistent: if the formatter ever counted subsystems
    // instead of issues, this would say four.
    issueCount: 1,
    issues: [{ id: "network.link", label: "network", status: FAILED, errorCode: "NETWORK_UNAVAILABLE", summary: "no network connection" }],
    subsystems: {
      ai: { overall: DEGRADED, components: {
        cloud: { status: DEGRADED, label: "cloud models", dependency: "network.link", summary: "unreachable" },
        local: { status: DISABLED, label: "local model", details: { reason: "unconfigured" } }
      } },
      integrations: { overall: DEGRADED, components: {
        gmail: { status: DEGRADED, label: "Gmail", dependency: "network.link", summary: "unreachable" }
      } }
    }
  };
  const reply = healthReply(snap);
  assert.equal(reply, "I found one issue. I have no network connection.");
  assert.ok(!/Gmail|cloud models|local model/.test(reply), "dependants and disabled parts are not separate issues");
});

test("a repeated fault is mentioned when there is room for it", () => {
  const reply = healthReply(snapOf([{ ...LIVE_THREE[2], repeatedFault: 8 }]));
  assert.match(reply, /keeps happening/);
  assert.match(reply, /[.]$/);
});

test("every error code a probe can emit has a phrase written for speech", async () => {
  // Without this, a new code silently falls back to "<label> is degraded" and
  // the summary quietly gets less useful over time.
  const { CODES } = await import("../selfHealth.js");
  const spokenSource = readFileSync(new URL("../healthIntent.js", import.meta.url), "utf8");
  const NEVER_AN_ISSUE = ["STT_CLOUD_UNCONFIGURED", "INTEGRATION_UNCONFIGURED"];
  for (const code of Object.keys(CODES)) {
    if (NEVER_AN_ISSUE.includes(code)) continue;      // these only ever mark DISABLED
    assert.ok(spokenSource.includes(`${code}:`), `${code} has no spoken phrase`);
  }
});

test("no health reply ever leaks an error code or a path at the user", () => {
  // Codes are for logs. Speech is for people.
  const reply = healthReply(snapOf([
    { id: "voice.sttLocal", label: "local speech recognition", status: DEGRADED, errorCode: "STT_LOCAL_MODEL_MISSING", summary: "the local speech model is not installed" }
  ]));
  assert.ok(!/STT_LOCAL_MODEL_MISSING/.test(reply), "an error code must never be spoken");
  assert.ok(!/\//.test(reply), "no filesystem paths in speech");
});
