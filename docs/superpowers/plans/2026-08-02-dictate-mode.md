# Dictate Mode v1 Implementation Plan

> **For agentic workers:** execute task-by-task; each task ends verifiable. Spec: `docs/superpowers/specs/2026-08-02-dictate-mode-design.md` — read it first, it is the contract.

**Goal:** Hold fn anywhere on the Mac → speak → release → the transcript lands at the focused app's cursor.

**Architecture:** New `DictationController` in the Swift shell (global fn monitor, AVAudioEngine capture, HTTP streaming to the server's existing Deepgram live-STT endpoints, pasteboard-swap insertion, floating NSPanel indicator). One small server change (encoding params for linear16). Zero new dependencies anywhere.

## Global Constraints

- Zero new dependencies (Swift: AppKit/AVFoundation/CoreGraphics only; server: none).
- Do not touch `public/` frontend files. Do not commit — leave all changes in the working tree.
- `npm test` stays green; `bash app/build.sh` must compile.
- Loopback HTTPS via the existing `LoopbackSessionDelegate`; port/config from `ArtemisConfig` exactly as `ServerController` reads it — never hardcode 4100.
- All UI-facing strings match the app's terse HUD voice (lowercase mono labels like "listening").

### Task 1: Server — encoding passthrough for the live-STT session

**Files:** `server.js` (the `startLiveSession` function and `/api/stt/live/start` handler), `test/messages.test.mjs` or a new `test/stt-params.test.mjs`.

- `startLiveSession(opts)` accepts `{ encoding, sampleRate, channels }`; when provided, append `encoding=…&sample_rate=…&channels=…` to the Deepgram live WebSocket URL. Absent → URL unchanged (browser webm path keeps working byte-identically).
- `/api/stt/live/start` reads them from query params (`?encoding=linear16&sample_rate=16000&channels=1`), validating `encoding` against an allowlist `["linear16", "opus", "flac"]` — anything else → 400.
- Unit test: URL construction with and without params, plus the 400 on a junk encoding (export a tiny pure helper if needed to keep it testable without a socket).

### Task 2: Swift — `DictationController`

**Files:** Create `app/Sources/DictationController.swift`; modify `app/Sources/AppDelegate.swift` (instantiate + menu item, skip in compat-check); modify `app/Info.plist.in` (`NSMicrophoneUsageDescription`).

Responsibilities, in one class plus a small panel type:

1. **Hotkey:** `NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged)`; fn = `keyCode 63` / `.function` flag. fn-down starts a hold timer; if released <250ms, do nothing. Esc (`addGlobalMonitorForEvents(matching: .keyDown)`, keyCode 53) during capture cancels. Also add a LOCAL monitor for the same events so dictation works while Artemis itself is frontmost.
2. **Capture:** `AVAudioEngine` input tap → `AVAudioConverter` to 16kHz mono Int16 → accumulate ~250ms buffers.
3. **Streaming:** on start, `POST {base}/api/stt/live/start?encoding=linear16&sample_rate=16000&channels=1` → `sid`; each buffer → `POST /api/stt/live/chunk?sid=` (body: raw bytes); subscribe `GET /api/stt/live/events?sid=` with a `URLSession` data task, parsing SSE lines (`data: {...}` JSON — collect final transcript segments; the existing meeting-capture client in `public/meetingCapture.js` shows the exact event shape — mirror its parsing).
4. **Finish:** fn-up → `POST /api/stt/live/stop?sid=` → wait ≤1.5s for remaining finals → assembled text.
5. **Insert:** save `NSPasteboard.general` string contents, write transcript, synthesize ⌘V via `CGEvent(keyboardEventSource:)` (keyDown+keyUp, `.maskCommand`), restore prior pasteboard after 300ms. On CGEvent failure: leave text on pasteboard, indicator shows "⌘V to paste".
6. **Indicator:** borderless non-activating `NSPanel` (`.nonactivatingPanel`, `level: .statusBar`, ignores mouse) ~120×28pt near `NSEvent.mouseLocation`: pulsing cyan dot + state label ("listening" / "…" / "✓" / "⌘V to paste"), auto-fade 600ms after finish.
7. **Toggle:** "Dictation (hold fn)" `NSMenuItem` with checkmark in the app menu, persisted `UserDefaults` key `dictationEnabled`, default true. All monitors torn down when disabled.

### Task 3: Build + proof

- Ensure `app/build.sh` picks up the new source file (it compiles `Sources/*.swift`; verify, adjust if the list is explicit).
- **Proof:** `bash app/build.sh` (compiles) and `npm test` (green) — run both and include output. Interactive mic/paste verification is explicitly NOT yours; Claude verifies live after review.

### Notes for the implementer

- The server may be running during your build; do not kill or restart it.
- `requestIsRemote` exempts loopback — no auth token needed from Swift.
- Deepgram live sessions idle-timeout server-side; always send `stop` on cancel too, so sessions don't leak.
- Match the existing Swift files' style (guard-let early exits, // comments explaining *why*).
