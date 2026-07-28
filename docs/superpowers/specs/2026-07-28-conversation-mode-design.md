# Conversation mode — say "Hey Artemis" once, then just talk

**Date:** 2026-07-28
**Status:** approved ("can we implement something more intuitive?")

## Behaviour

- "Hey Artemis" (or mic tap) starts a **conversation**. While it is live,
  after each of her answers the mic re-opens automatically for a follow-up —
  no wake word needed. A soft, shorter earcon (distinct from the wake blip)
  marks each re-open; the orb shows listening.
- If the user says nothing for ~7 s, the conversation ends **silently** and
  she returns to normal wake-word listening. No "are you still there?".
- Closing phrases end it immediately with a one-word ack ("Done." / nothing
  if TTS is mid-flight): "that's all", "that's it", "thanks that's all",
  "thank you that's all", "go to sleep", "stop listening", "never mind".
- A pending confirmation is the BEST follow-up case: after "shall I move
  these to trash?" the window opens so a bare "yes" works — this must work.
- Barge-in, Escape, and the mic button keep their current behaviour.
- Dock toggle `FOLLOW-UP: ON/OFF`, persisted in localStorage
  (artemisFollowUp), default ON. OFF = exactly today's behaviour.

## Implementation

### public/wakeLocal.js — one additive option

`captureCommand(opts)` gains `opts.waitForSpeechMs` (default: current
behaviour): if no speech has STARTED within that window, resolve null
early — the follow-up listener must give up in ~7 s, not hold the turn
for CAP_MAX_MS. No other engine changes; detection/preroll/VAD untouched.

### public/wakeWords.js — pure closing-phrase matcher

`export function isClosingPhrase(text)` — the phrase list above,
whole-utterance match (trim, lowercase, strip trailing punctuation),
NOT substring ("that's all the emails" is not a close). Unit-testable.

### public/main.js — the conversation loop

- Module state `conversationLive` (bool). Set true when a wake capture or
  mic-tap dispatches a command; false on close/timeout/toggle-off.
- In `afterSpeak()`: when `wakeOn && conversationLive && followUpEnabled`
  and not recording/busy, instead of only `resumeWake()`, call a new
  `followUpListen()`:
  1. soft earcon, orb listening, status "Listening…" (or the pending-confirm
     prompt when one exists),
  2. `captureCommand({ waitForSpeechMs: 7000, onLevel: orb.feed })`,
  3. null → `conversationLive = false`, fall back to today's afterSpeak
     wake-arming path (silent),
  4. transcript → `isClosingPhrase` → end with brief ack; else route
     exactly like a wake command (confirm → open-intent → ask). Reuse the
     existing wake-capture pipeline — extract its body into one shared
     `dispatchUtterance(text)` used by both paths; do not duplicate it.
- Re-entrancy: `followUpListen` must not start while one is in flight
  (mirror the existing `wakeCapturing` guard) and must abort cleanly if
  the user taps the mic or she starts speaking again.
- The engine keeps running between turns (it already survives capture →
  resume cycles); follow-up capture only runs when `localWakeRunning()`.

### public/index.html + cockpit.css — dock toggle

Button next to WAKE WORD, same styling: `FOLLOW-UP: ON`. One line of CSS
at most; reuse dock button classes.

### test/followup.test.mjs

Pure-logic suite (no audio): isClosingPhrase accepts every listed phrase
with punctuation/case noise and rejects "that's all the emails",
"stop listening to the radio" (substring traps); and the settings key
round-trips. Add to npm test before the eval.

## Constraints

- No changes to detection thresholds, wakeProfile, STT, TTS, or server.
- The follow-up window NEVER opens when wake word is OFF, when the tab is
  hidden, or when followUpEnabled is off.
- One follow-up capture at a time; silence ends the conversation — no
  endless hot-mic. The mic indicator (orb + status) must be truthful the
  whole time the mic is open.
