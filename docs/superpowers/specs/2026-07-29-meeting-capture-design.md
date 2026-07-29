# meeting_capture — "Artemis, take notes"

**Date:** 2026-07-29
**Status:** approved (skills roadmap item 6, last before the triple-check)

## What

"Artemis, take notes" / "start taking notes" begins a capture session:
she transcribes ongoing speech until "stop taking notes" / "that's the
meeting" (or 30 min hard cap), then produces: a dated note (existing
notes store) with the transcript summary, decisions, and action items —
action items with a clear owner=user and a time become reminders
(existing store) after ONE spoken confirmation listing them ("Two action
items — set reminders for both?").

## How (reuse, don't invent)

- Client: a capture mode in main.js that loops the EXISTING
  captureCommand/STT path (same engine, waitForSpeechMs long, chunks
  accumulated) — no new audio plumbing, no MediaRecorder. Wake detection
  pauses during capture (mode already supports it). The orb shows a
  distinct "recording" state (existing setStatus + a log line each
  minute: "notes: 4 min, 312 words"). Closing phrase detection reuses
  isClosingPhrase-style whole-utterance matching for the stop phrases —
  "stop taking notes" must not trigger from "he said stop taking notes
  about that" mid-sentence... whole-utterance only.
- Summarisation: one LLM call server-side (existing brain chain) with
  the transcript wrapped as untrusted (it is third-party speech!);
  output schema-checked in code: {summary: string, decisions: string[],
  actions: [{text, when|null}]}; malformed → save raw transcript note +
  honest "I saved the raw notes but couldn't structure them".
- skills.js: meeting_notes skill for retrieval only ("what were my
  meeting notes", replays saved notes by date). Session start/stop is
  client-driven (voice pipeline), not a model tool — the model cannot
  start recording; only the user's explicit phrase can. Registry entry
  for retrieval only.
- Reminders creation goes through the existing set_reminder path with
  its confirmation (the ONE grouped confirm above).
- test/meeting.test.mjs: (1) stop phrases whole-utterance only;
  (2) schema-check rejects malformed LLM output and falls back to raw
  note; (3) transcript is wrapped untrusted in the summarise call;
  (4) action items require the grouped confirmation before any reminder
  writes; (5) retrieval replays by date without re-summarising. Chain in
  package.json before the eval.

## Constraints

No new deps. No model-initiated recording — user phrase only. Mic state
always visible (orb + status + minute lines). 30 min cap, single session
at a time. Transcript treated as untrusted everywhere. No audio stored —
text only, in .data via existing stores.
