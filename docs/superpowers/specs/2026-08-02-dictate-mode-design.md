# Dictate Mode v1 — system-wide hold-to-talk

**Date:** 2026-08-02 · **Origin:** Stage 1 of docs/research/2026-08-02-voiceos-competitive-teardown.md
**Goal:** Press and hold **fn** in any app on the Mac, speak, release — clean text lands at the cursor of whatever app has focus. The "press fn, speak, release, text lands" loop that VoiceOS/superwhisper/Resonant set as the baseline.

## UX

- **Hold-to-talk:** fn down (keyCode 63, observed via a global `NSEvent` flagsChanged monitor — Accessibility permission, already granted) starts capture; fn up stops it. Holds shorter than 250ms are ignored (accidental taps). Esc while holding cancels the dictation outright.
- **Floating indicator:** a small non-activating `NSPanel` appears near the mouse cursor while capturing — a pulsing cyan dot + "listening" in the HUD's mono style; switches to "…" while the final transcript flushes, then a brief "✓" as the text lands, then fades. Never steals focus.
- **Insertion:** transcript is inserted at the focused app's cursor via pasteboard swap — save current `NSPasteboard` contents, write the text, synthesize ⌘V with `CGEvent`, restore the previous pasteboard contents ~300ms later. (The standard reliable approach; pure CGEvent typing mangles non-ASCII — relevant for Bulgarian.)
- **Toggle:** app menu item "Dictation (hold fn)" with a checkmark, persisted in `UserDefaults` (`dictationEnabled`, default ON). Skipped entirely in compat-check mode.
- **Permissions:** first capture triggers the macOS microphone prompt for Artemis (`NSMicrophoneUsageDescription` added to Info.plist.in). Accessibility is already granted; if the paste synthesis fails, the indicator shows "⌘V to paste" and leaves the text on the pasteboard (no silent loss).

## Architecture

- **Audio:** `AVAudioEngine` in the Swift shell (dictation must work when the Artemis window isn't focused, so capture cannot live in the WKWebView). Tap converted to 16kHz mono PCM16, POSTed in ~250ms chunks.
- **STT:** reuse the server's existing Deepgram live-streaming endpoints (built for meeting capture):
  `POST /api/stt/live/start` → `{sid}` · `POST /api/stt/live/chunk?sid=` (raw audio body) · `GET /api/stt/live/events?sid=` (SSE transcript events) · `POST /api/stt/live/stop?sid=`.
  `startLiveSession` grows optional `encoding`/`sample_rate`/`channels` query params passed through to Deepgram (defaults preserve current browser-webm behavior) so the Swift client can send linear16.
- **Networking:** loopback HTTPS with the existing self-signed cert — reuse `LoopbackTrust`/`LoopbackSessionDelegate`. Loopback requests bypass the access-token gate, so no key handling is needed.
- **Transcript assembly:** concatenate final SSE segments (Deepgram `smart_format` output used as-is in v1 — no LLM cleanup pass yet); on fn-up, send `stop` and wait up to 1.5s for the final flush before inserting.

## Out of scope for v1 (explicitly)

Per-app tone formatting, filler-removal LLM pass, local WhisperKit engine, EN+BG code-switching pipeline, custom vocabulary. Each is staged later per the teardown; v1 is the loop itself.

## Verification

`bash app/build.sh` compiles clean; `npm test` stays green (server param passthrough covered by a unit test); live verification is interactive (mic prompt, real dictation into TextEdit) and owned by Claude/Theo after the build.
