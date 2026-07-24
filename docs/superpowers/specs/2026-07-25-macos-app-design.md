# Artemis as a macOS app — design

**Date:** 2026-07-25
**Status:** approved, not yet implemented

## Goal

Make Artemis a real `Artemis.app` you double-click. It opens its own window on
the Command Center UI, with no terminal and no browser tab. Closing the window
quits the app.

This is explicitly *not* the distributable-to-other-Macs version and not the
menu-bar always-listening version. Both remain possible later; neither is built
now.

## Decisions

| Question | Decision |
|---|---|
| What kind of app | Windowed, one-click launch; closing the window quits |
| Shell | Swift + `WKWebView`, hand-assembled bundle |
| Server already on 4100 | Attach to it; never kill a server the app didn't start |
| Where links open | Always the default browser, via macOS |
| Node | Not bundled — the app finds the installed one |
| Source | App points at the working copy, so it runs current code |

## Why Swift/WKWebView

Artemis has no `node_modules` at all, and that is a feature. Electron would add
a dependency tree and ship a second Chromium — a ~150 MB app that is functionally
another Chrome, which is the wrong direction given the original complaint was
Chrome using ~18% CPU. A shell/AppleScript launcher is ten minutes of work but
leaves you in a browser tab, which is the thing being escaped.

Swift is already available (Swift 6.4 via Command Line Tools; no full Xcode, so
no `xcodebuild` — the bundle is assembled by hand, which is fine). Result is a
~300 KB app with no dependencies.

## Architecture

```
app/
  Artemis.swift        the whole app, one file
  Info.plist           bundle id, mic usage string, min OS, repo path
  build.sh             swiftc + assemble Artemis.app + ad-hoc sign
```

Four components, each with one job:

**`NodeLocator`** — finds a usable `node`. A GUI app launched from Finder
inherits none of the shell `PATH`, so `node` is not found unless explicitly
searched for. Order: `ARTEMIS_NODE`, `~/.local/bin/node`, `/opt/homebrew/bin`,
`/usr/local/bin`, then a login shell as last resort. On this machine it resolves
to `~/.local/bin/node` (v22.23.1).

**`ServerController`** — decides attach-vs-spawn, owns the child process if it
spawned one, and knows which case it is.

**`BrowserBridge`** — routes outbound links to macOS, answers the microphone
permission request.

**`AppDelegate`** — window, WKWebView, lifecycle.

The repo path is written into `Info.plist` by `build.sh` and overridable with
`ARTEMIS_ROOT`. The app therefore always runs the current working copy.

## Server lifecycle

On launch, probe `GET http://127.0.0.1:4100/api/status` with a 500 ms timeout:

- **Answers, and the JSON has the fields only Artemis serves** (`chatEnabled` and
  `localWake` both present) → attach, `ownsServer = false`
- **Connection refused** → spawn `node server.js` (cwd = repo, environment
  inherited so `server.js` loads `.env` itself), poll `/api/status` until ready,
  20 s cap, `ownsServer = true`
- **Answers but the shape doesn't match** → alert and quit, rather than guess

On quit, `SIGTERM` the child only if `ownsServer`. A server started by hand in a
terminal outlives the app.

Server stdout/stderr is captured to `~/Library/Logs/Artemis/server.log`. Without
this, a missing API key or a boot crash presents as a blank window with no
explanation.

## Link opening

`WKUIDelegate` interception alone is a trap. The delegate returns `nil`, so
`window.open()` evaluates to `null` in the page — and `openUrl()` in
`public/main.js:102` reads exactly that to decide whether the pop-up was blocked:

```js
let w = null;
try { w = window.open(url, "_blank"); } catch (e) {}
if (w) return true;
showOpenPill(url, label);   // would fire even though macOS opened it fine
```

The naive version therefore makes Artemis announce "pop-up blocked" every time
while the tab opens behind her.

Instead, inject a `WKUserScript` at document start that replaces `window.open`
with one that posts the URL to a native message handler and returns a truthy
stub object. `public/main.js` needs **no changes** and stays correct in both the
app and an ordinary browser. Navigations to any non-loopback host get the same
treatment, so an in-page link cannot strand the user inside the app window.

Consequence worth stating: in the app, pop-up blocking ceases to exist, so
hands-free opening always works. The "Pop-up blocked — tap Open" pill becomes
browser-only.

## Microphone

`NSMicrophoneUsageDescription` in `Info.plist`, plus
`webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)`
returning `.grant` — the only origin ever loaded is the app's own loopback
server.

**Known caveat:** macOS ties the TCC grant to the code signature, and ad-hoc
signing produces a fresh identity per build, so during development a rebuild can
re-prompt for microphone access. Annoying, not blocking, and it stops once the
app stops being rebuilt. A Developer ID certificate would fix it permanently.

## WKWebView compatibility

**Measured 2026-07-25** by the spike, against the real UI on macOS 27. All green:

| API | Used by | Result |
|---|---|---|
| `getUserMedia` | wake engine, STT, barge-in | ✅ present, permission granted |
| `AudioWorklet` | `wakeLocal.js:249` mic downsampler | ✅ |
| WASM + SIMD | ONNX Runtime Web | ✅ both |
| `crypto.subtle` | `wakeProfile.js:60` hash verification | ✅ (`isSecureContext` true) |
| SSE (`EventSource`) | `/api/chat/stream` | ✅ |
| `MediaRecorder` | `main.js` (3 sites), `wakeLocal.js` (2) | ✅ |
| `webkitSpeechRecognition` | browser wake fallback | ✅ **present** |

Two predictions in the original draft were wrong and are corrected here:

- `webkitSpeechRecognition` was expected to be **absent**. It is present on
  macOS 27, so the browser wake fallback works in the app as well. Nothing needs
  to handle its absence.
- The app was expected to load plain `http://127.0.0.1:4100`. This install runs
  `ARTEMIS_HOST=0.0.0.0` with `ARTEMIS_HTTPS=1` and an access token, so every
  request is treated as remote and answered with 401. See the next section.

## Transport and authentication

The app cannot assume `http://127.0.0.1:4100`. It reads the project's own `.env`
— the same file the server reads, so the two cannot disagree — and derives:

- **Scheme** from `ARTEMIS_HTTPS`.
- **Port** from `ARTEMIS_PORT`/`PORT`.
- **Token** from `ARTEMIS_ACCESS_TOKEN`. The first load carries `?key=<token>`;
  the server replies with a `Set-Cookie` and a 302, and every later request
  rides the `artemis_auth` cookie (`server.js:1700-1715`).

Artemis serves a **self-signed certificate** so phones can use the microphone
over the LAN, and both `WKWebView` and `URLSession` reject it by default. The app
supplies a credential for it, **pinned to loopback hosts only**
(`LoopbackTrust.isLoopback`), so it can never silently accept a bad certificate
from anywhere else.

## Error handling

Every failure produces a native alert stating what happened, never a white
window:

| Failure | Presented as |
|---|---|
| `node` not found | Alert listing the paths searched and the `ARTEMIS_NODE` override |
| Repo path missing | Alert naming the expected path |
| Server not ready in 20 s | Alert showing the last 30 lines of stderr |
| Port 4100 held by a stranger | Alert; quit rather than attach |
| WebView load failure | Retry button plus the log path |

## Testing

GUI testing here is largely manual; there is no headless harness for "did the
mic prompt appear." What is automated:

1. **Compatibility spike (a gate, run first).** A WKWebView harness that loads
   the real UI and reports pass/fail to stdout for `getUserMedia`,
   `AudioWorklet`, WASM+SIMD, `MediaRecorder`, `crypto.subtle`, and SSE. If
   `MediaRecorder` or `AudioWorklet` fail, stop and return to the user with
   options rather than building around it.
2. **Attach/spawn logic** exercised against a real server on a scratch port:
   attaches when one is present, spawns when not, and leaves a foreign server
   running on quit.
3. **Existing `boot-smoke`** already pins the `/api/status` contract the app
   depends on.

Manual smoke checklist: wake word fires; a spoken command executes; a link opens
in the default browser; quitting leaves a hand-started server alive.

## Out of scope

- Bundling `node` and the source for distribution to other Macs
- Menu-bar / always-listening background mode
- Developer ID signing and notarization
- Any change to the orb's rendering cost or the wake inference cadence — the
  CPU question is real but separate, and packaging alone does not address it

## Risks

- ~~**`MediaRecorder` unsupported in WKWebView**~~ — **resolved 2026-07-25**: the
  spike confirms it is supported. No rework needed.
- **TCC re-prompts on rebuild** — accepted, documented above.
- **`.env` drift** — the app reads `.env` at launch, so changing the port or
  token requires restarting the app, not just the server.
- **Hardcoded repo path** — moving the working copy breaks the app until
  rebuilt; mitigated by a clear alert and the `ARTEMIS_ROOT` override.
