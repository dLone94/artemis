// The app must outlive its windows, and its server must not outlive the app.
//
// Artemis.app was terminating seconds after launch. The lifecycle log proved
// the path exactly:
//
//   window.shouldClose (eventType=2 leftMouseUp, clicks=1, loc=13,874 — the
//   close button) → window.willClose → shouldTerminateAfterLastWindowClosed
//   answering TRUE → app.shouldTerminate → app.willTerminate intentional=false
//
// One click on a traffic light killed an always-on voice assistant AND the
// server it owned. Worse, the server sometimes survived, so the next launch
// probed the port, found "a healthy Artemis" and attached — which made "the
// app is running" and "a server is running" indistinguishable while debugging.
//
// The Swift half cannot be unit-tested here (no XCTest without Xcode), so its
// invariants are asserted against the SOURCE — the same approach the music
// suite uses for cockpit.js. The JS half is tested by actually running it.
//
// Run: node --test test/appLifecycle.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const appDelegate = read("app/Sources/AppDelegate.swift");
const serverController = read("app/Sources/ServerController.swift");
const serverJS = read("server.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/* ---------------------------------------------- 1, 2, 8: window ≠ lifetime */

test("1, 2 — a hidden dashboard NEVER terminates the app, in any mode", () => {
  const fn = appDelegate.match(/func applicationShouldTerminateAfterLastWindowClosed[^{]*\{([\s\S]*?)\n    \}/);
  assert.ok(fn, "the policy hook must exist");
  const body = fn[1];
  // The regression: this returned `presentationMode == "full"`, so a close in
  // full mode killed everything. A borderless NSPanel does not count as a
  // window, so ANY window-count-based policy is wrong for this app.
  assert.match(body, /let answer = false/, "the answer must be unconditionally false");
  assert.ok(!/presentationMode == "full"/.test(body),
    "app lifetime must not depend on which presentation mode is active");
});

test("8 — a close request becomes a presentation change, not a termination", () => {
  const fn = appDelegate.match(/func windowShouldClose[^{]*\{([\s\S]*?)\n    \}/);
  assert.ok(fn, "windowShouldClose must be implemented");
  const body = fn[1];
  assert.match(body, /applyPresentation\("pill"\)/, "closing the dashboard drops to the pill");
  assert.match(body, /return false/, "and the close itself is refused");
  assert.match(body, /guard !intentionalQuit else \{ return true \}/,
    "an intentional quit must still be allowed to close windows");
});

test("dock reopen restores the dashboard from pill or background", () => {
  assert.match(appDelegate, /func applicationShouldHandleReopen/,
    "a Dock click must have a reopen hook");
  assert.match(appDelegate, /applyPresentation\("full"\)/,
    "reopen restores full presentation");
});

test("the spawned server listens on the app's configured port", () => {
  assert.match(serverController, /env\["PORT"\] = config\.port/,
    "ARTEMIS_PORT must reach the Node child as PORT");
});

test("pill restore is handled on the pill webview", () => {
  const pill = read("app/Sources/PillController.swift");
  assert.match(pill, /action == "restore"/, "the pill webview accepts a restore message");
  assert.match(pill, /onRestore/, "and forwards it to AppDelegate");
});

test("an owned Node crash surfaces Restart/Quit, not a frozen UI", () => {
  assert.match(serverController, /onUnexpectedExit/, "ServerController must expose a crash callback");
  assert.match(serverController, /stopping/, "intentional stop must not look like a crash");
  assert.match(appDelegate, /onUnexpectedExit/, "AppDelegate must listen for an owned-server death");
  assert.match(appDelegate, /Restart/, "the alert must offer a restart");
});

test("dictation asks for paste permission and polls fn-up", () => {
  const dictation = read("app/Sources/DictationController.swift");
  assert.match(dictation, /AXIsProcessTrustedWithOptions/, "must prompt Accessibility, not fail silently");
  assert.match(dictation, /CGRequestPostEventAccess/, "must request post-event so ⌘V can insert");
  assert.match(dictation, /NSEvent\.modifierFlags/, "must poll fn so a missed key-up cannot leave capture running");
});

test("the app is a window delegate at all, or none of the above can fire", () => {
  assert.match(appDelegate, /NSWindowDelegate/, "must conform");
  assert.match(appDelegate, /window\.delegate = self/, "and must actually be assigned");
});

/* ------------------------------------------------- 3, 10: intentional quit */

test("3, 10 — an intentional quit tears down the owned server, bounded", () => {
  const willTerminate = appDelegate.match(/func applicationWillTerminate[^{]*\{([\s\S]*?)\n    \}/);
  assert.ok(willTerminate);
  assert.match(willTerminate[1], /server\?\.stop\(\)/, "the owned server is stopped on the way out");

  const stop = serverController.match(/func stop\(\)[^{]*\{([\s\S]*?)\n    \}/);
  assert.ok(stop, "stop() must exist");
  const body = stop[1];
  assert.match(body, /guard ownsServer/, "only ever OUR server");
  assert.match(body, /p\.terminate\(\)/, "SIGTERM first");
  assert.match(body, /SIGKILL/, "and a bounded last resort");
  assert.match(body, /addingTimeInterval\(3\)/, "with a deadline, not an unbounded wait");
});

test("the voice shutdown marks itself intentional BEFORE terminating", () => {
  // Otherwise the log cannot distinguish "the user asked" from the bug.
  const idx = appDelegate.indexOf('body == "quit"');
  assert.ok(idx > 0);
  const block = appDelegate.slice(idx, idx + 500);
  assert.ok(block.indexOf("intentionalQuit = true") < block.indexOf("NSApp.terminate(nil)"),
    "the flag must be set before the terminate call, or the record is wrong");
});

/* ------------------------------------- 4, 5, 6: ownership and stale servers */

test("6 — the server declares who owns it, and whether that owner still lives", async () => {
  const port = await freePort();
  const owner = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  owner.unref();
  const srv = spawn("node", ["server.js"], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: { ...process.env, PORT: String(port), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "",
           STRIPE_SECRET_KEY: "", ARTEMIS_OWNER_PID: String(owner.pid), ARTEMIS_OWNER_TOKEN: "abc123secret" }
  });
  srv.unref();
  try {
    let status = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !status) {
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json()).catch(() => null);
      if (!status) await sleep(300);
    }
    assert.ok(status, "server did not boot");
    assert.equal(status.owner.ownerPid, owner.pid);
    assert.equal(status.owner.ownerAlive, true);
    assert.equal(status.owner.standalone, false);
    assert.equal(status.owner.pid, srv.pid, "the server reports its own PID so it can be reclaimed precisely");
    // The token identifies a process, not a user — but it is still truncated.
    assert.ok(!JSON.stringify(status.owner).includes("abc123secret"), "the full token is never echoed");
  } finally {
    try { process.kill(srv.pid, "SIGKILL"); } catch (e) {}
    try { process.kill(owner.pid, "SIGKILL"); } catch (e) {}
  }
});

test("4 — an orphaned server exits on its own when its owner dies", async () => {
  // Detached on purpose: its own session and process group, so nothing but the
  // ownership watchdog can be responsible for it stopping.
  const port = await freePort();
  const owner = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  owner.unref();
  const srv = spawn("node", ["server.js"], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: { ...process.env, PORT: String(port), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "",
           STRIPE_SECRET_KEY: "", ARTEMIS_OWNER_PID: String(owner.pid) }
  });
  srv.unref();
  try {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.ok).catch(() => false);
      if (!up) await sleep(300);
    }
    assert.ok(up, "server did not boot");

    process.kill(owner.pid, "SIGKILL");
    let gone = false;
    for (let i = 0; i < 12 && !gone; i += 1) { await sleep(1000); gone = !alive(srv.pid); }
    assert.ok(gone, "an orphaned server must not linger — it would masquerade as a running app");
  } finally {
    try { process.kill(srv.pid, "SIGKILL"); } catch (e) {}
    try { process.kill(owner.pid, "SIGKILL"); } catch (e) {}
  }
});

test("5 — a server nobody owns is standalone and is NEVER reclaimed", async () => {
  // The user runs `node server.js` in a terminal all the time. Killing that
  // would be a nasty surprise, so it must identify itself as unowned.
  const port = await freePort();
  const srv = spawn("node", ["server.js"], {
    cwd: ROOT, detached: true, stdio: "ignore",
    env: { ...process.env, PORT: String(port), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "", STRIPE_SECRET_KEY: "" }
  });
  srv.unref();
  try {
    let status = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !status) {
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json()).catch(() => null);
      if (!status) await sleep(300);
    }
    assert.ok(status, "server did not boot");
    assert.equal(status.owner.standalone, true, "no owner declared = standalone");
    assert.equal(status.owner.ownerPid, null);
    await sleep(7000);
    assert.ok(alive(srv.pid), "a standalone server must keep running — nobody owns it to kill it");
  } finally {
    try { process.kill(srv.pid, "SIGKILL"); } catch (e) {}
  }
});

test("5 — reclaim targets ONE identified PID, never 'some node process'", () => {
  const fn = serverController.match(/private static func reclaim[^{]*\{([\s\S]*?)\n    \}/);
  assert.ok(fn, "reclaim must exist");
  const body = fn[1];
  assert.match(body, /guard let pid = detail\.serverPID/, "it acts only on a PID the server itself reported");
  assert.match(body, /kill\(pid, SIGTERM\)/);
  assert.match(body, /kill\(pid, SIGKILL\)/);
  // The things that would make this dangerous.
  for (const forbidden of ["pkill", "killall", "-9 node", "NSRunningApplication"]) {
    assert.ok(!body.includes(forbidden), `reclaim must not use ${forbidden}`);
  }
  assert.ok(!serverController.includes("pkill") && !serverController.includes("killall"),
    "nothing in the controller may broad-kill processes");
});

test("a standalone server is never classified as an orphan", () => {
  const probe = serverController.match(/static func probeDetail[\s\S]*?\n    \}/);
  assert.ok(probe);
  assert.match(probe[0], /!detail\.standalone/, "standalone short-circuits the orphan verdict");
});

/* --------------------------------------------------- 9: duplicate launch */

test("9 — a second launch attaches to a live Artemis instead of racing it", () => {
  const start = serverController.match(/func start\([\s\S]*?\n    \}/);
  assert.ok(start);
  const body = start[0];
  assert.match(body, /case \.artemis: ownsServer = false; return false/,
    "a healthy owned server is attached to, not duplicated");
  assert.match(body, /case \.orphan:/, "an orphan is reclaimed first");
  assert.match(body, /case \.foreign: throw ServerError\.foreignServer/,
    "someone else's server on the port is an explicit error, never a takeover");
});

/* ------------------------------------------------------ 7: load failures */

test("7 — a page load failure is reported, not silently fatal", () => {
  const fn = appDelegate.match(/private func presentLoadFailure[\s\S]*?\n    \}/);
  assert.ok(fn);
  const body = fn[0];
  assert.match(body, /webview\.loadFailed/, "the failure is recorded before anything else");
  assert.match(body, /addButton\(withTitle: "Retry"\)/, "the user can retry");
  assert.match(body, /NSApp\.terminate\(nil\)/, "quitting is a CHOICE the user makes in the alert");
});

/* ------------------------------------------- lifecycle evidence integrity */

test("every termination decision point is instrumented", () => {
  for (const hook of ["applicationShouldTerminateAfterLastWindowClosed", "applicationShouldTerminate",
                      "applicationWillTerminate", "windowShouldClose", "windowWillClose"]) {
    const idx = appDelegate.indexOf(`func ${hook}`);
    assert.ok(idx > 0, `${hook} must be implemented`);
    const block = appDelegate.slice(idx, idx + 900);
    assert.match(block, /ShellLog\.lifecycle\(/, `${hook} must log its decision`);
  }
});

test("the lifecycle record carries what is needed to read a termination", () => {
  const shellLog = read("app/Sources/ShellLog.swift");
  for (const field of ["pid=", "mode=", "mainWindowVisible=", "pillVisible=", "serverPID=",
                       "intentional=", "windows=", "visibleWindows=", "frontmost="]) {
    assert.ok(shellLog.includes(field), `the lifecycle line must carry ${field}`);
  }
});

test("shutdown closes its own SSE streams so SIGTERM is honoured", () => {
  // Measured: server.close() waited on presence streams that never end, so every
  // quit sat out the 3s deadline and had to be SIGKILLed.
  const fn = serverJS.match(/function shutdown\(signal[\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn[0], /presenceClients/, "the streams we own are closed before draining");
  assert.match(fn[0], /setTimeout\(\(\) => process\.exit\(code\), 4000\)/, "and a hard ceiling remains");
});
