# meeting_capture — "Artemis, take notes"

**Date:** 2026-07-29
**Status:** approved, corrected after code audit

## What

"Artemis, take notes" / "start taking notes" begins one client-owned
capture session. Artemis transcribes ongoing speech until the exact
whole utterance "stop taking notes" / "that's the meeting", a mic tap,
the page becoming hidden, or a 30-minute monotonic hard deadline.

Completion saves a dated entry in the existing `notes.json` store with a
summary, decisions, and action items. Action items that the structured
result identifies as clearly owned by the user and expressible through
the existing reminder contract are offered behind ONE spoken grouped
confirmation ("Two action items — set reminders for both?"). No reminder
is written before that confirmation.

## Client capture state machine

Session start/stop is client-owned. There is no model tool that can start
or stop recording. Only an exact user utterance reaching
`dispatchUtterance`, an exact stop utterance heard by the meeting loop,
the mic button, visibility loss, or the hard deadline can change capture
state.

Start is an atomic phase transition before any `await`:

- accept only an exact whole-utterance start phrase after the shared wake
  prefix scrub;
- mark the single session `starting`, end conversation mode, cancel (do
  not approve) any pending action, invalidate follow-up capture, stop
  queued/playing TTS, and defer the runner to a microtask;
- at that same atomic claim, arm the monotonic 30-minute deadline and
  switch the existing mic control/listening treatment to the visible
  meeting state. This intentionally includes engine handoff/model/worklet
  startup time, because `getUserMedia()` can make the mic live before
  `startLocalWake()` resolves;
- the deferral lets an originating `onLocalWake` or `followUpListen`
  unwind and clear `wakeCapturing` / `followUpInFlight` before the
  meeting takes the engine;
- ensure the existing local wake engine is running, remembering whether
  the meeting started it. Bound this meeting-only startup wait and make
  wake-engine startup generation-cancellable across both model loading
  and mic acquisition: a stop or visibility loss invalidates the
  generation before `openMic`, and an eventual stale completion must
  discard its stream instead of reopening an invisible mic. If the
  engine cannot start, fail honestly and do not fall back to
  `MediaRecorder` or any new audio path.

While capturing:

- reuse `captureCommand` only. Each call uses `preRollMs: 0` so the
  1.2-second command pre-roll neither re-ingests the start phrase nor
  duplicates the end of the previous utterance;
- use bounded wait windows (at most 20 seconds), not a 30-minute
  `waitForSpeechMs`. A null capture caused by ordinary silence reopens
  immediately while the engine and session are still live;
- as soon as a WAV is returned, launch its existing `/api/stt` request
  and immediately open the next `captureCommand`. Do not await STT before
  recapturing: `captureCommand` leaves `wakeLocal` in `idle`, so a
  sequential capture → STT → capture loop would drop everything said
  during the network request;
- number STT jobs and assemble their text in sequence even if requests
  finish out of order. Stop matching uses a comparison copy only. The
  exact stop chunk and every later chunk are discarded; captured meeting
  text is never sent to `dispatchUtterance` or normal conversation chat;
- enforce the independent monotonic 30-minute timer armed at the session
  claim. At the deadline,
  set the stopping phase first and call `stopLocalWake()` so the active
  capture settles and the mic closes. Mic-tap, visibility, and deadline
  stops retain and transcribe speech already buffered in that active
  capture; a transcribed spoken stop phrase deliberately discards its
  own chunk and every later chunk. The engine's existing
  `capCeiling = 12s + max(0, waitForSpeechMs - 4.5s)` (plus its safety
  backstop) is an utterance budget, not a session cap;
- keep only transient WAV blobs in memory until their STT requests
  settle. Persist no audio.

Mic visibility is persistent from the atomic claim through mic closure:
reuse the orb's existing `listening` visuals and amplitude feed, keep the
existing `micToggle.recording` treatment on, set its accessible label to
"Stop meeting notes", keep the dock expanded, show an explicit opening
message until capture is ready, then show "Recording meeting notes…"
plus one HUD line each minute
(`notes: 4 min, 312 words`). `VoiceOrb.setStatus` has no `recording`
state, so the design does not invent one.

Normal voice/conversation entry points are gated for every non-idle
meeting phase. In particular:

- local/browser wake callbacks and watchdog restarts cannot dispatch a
  command during capture;
- follow-up cannot start or restore itself;
- a mic tap requests meeting stop and never falls through to
  `startTalk` / `MediaRecorder`;
- wake/follow-up toggles are disabled while the meeting owns the mic;
- normal `ask`, typed commands, TTS pumps, public `ArtemisSpeak`,
  celebration audio, mail announcements, and reminder announcements
  cannot speak or start work into the capture;
- stale `afterSpeak`, engine-start, capture, STT, and summarisation
  completions check the session generation before changing UI or state;
- hiding the page stops and finalises the meeting rather than keeping an
  invisible live mic.

Finalisation closes the mic before showing `thinking` or making the
server request. Once the server replies, the previous wake preference is
restored. Conversation mode may reopen only for the existing spoken
yes/no confirmation flow.

## Server summarisation and storage

`POST /api/meeting` accepts one non-empty, meeting-bounded transcript.
It makes one zero-tool completion through the selected existing brain
provider; it must not call the ordinary agent loop, advertise tools, or
run a repair completion.

The transcript appears exactly once in model input, inside
`wrapUntrusted("UNTRUSTED_MEETING_TRANSCRIPT", "", transcript)`.
Instructions remain outside the wrapper and say that every wrapped byte
is data, never instructions. Sentinel break-out text is stripped by the
shared untrusted seam.

The only accepted completion is strict JSON with no extra fields:

```json
{
  "summary": "non-empty string",
  "decisions": ["non-empty string"],
  "actions": [
    {
      "text": "non-empty string",
      "owner": "user | other | unclear",
      "when": null
    }
  ]
}
```

For a representable reminder, `when` is instead exactly one of:

```json
{ "minutes": 20 }
```

```json
{ "time": "18:30" }
```

The dedicated validator checks the full nested shape, finite ranges,
`HH:MM`, counts, and string bounds. Generic tool-schema validation is
not sufficient for nested LLM output. Only `owner: "user"` plus a valid
non-null `when` becomes a reminder candidate; every action remains in
the saved note.

Invalid JSON, schema failure, provider failure, or no configured brain
causes no second LLM call. Artemis atomically appends a conventional note
entry containing the raw transcript and honestly says, "I saved the raw
notes but couldn't structure them."

Both structured and fallback records remain compatible with the existing
notes convention:

```js
{ text, at, kind: "meeting", date: "YYYY-MM-DD", raw, untrusted: true }
```

Structured records may add the validated `structured` object and do not
store the raw transcript. Writes use the existing per-file mutation
lock so a concurrent `remember_note` cannot be lost. Ordinary
`recall_notes` excludes `kind: "meeting"` records; they are retrieved
only through the safe meeting seam.

## Retrieval and untrusted provenance

`skills.js` defines a read-only `meeting_notes` skill with an optional
local `YYYY-MM-DD` date. With no date it replays the most recent meeting
date. It reads saved text directly, in chronological order, and never
calls a summariser. Replay is bounded to 20 records and 20,000 total
characters, distributed across the selected records so one long raw note
cannot crowd out every other meeting. If the date contains more, the
code-owned summary and spoken preface say that the replay is a bounded
excerpt.

The registry gives it a dedicated `meeting` read family and intent
phrases such as "what were my meeting notes". No model-visible meeting
recording or reminder-batch tool exists. Exact retrieval intents may be
direct-dispatched so replay does not incur another model paraphrase.
Explicit meeting-note retrieval takes routing precedence over topic words
inside the request (such as "portfolio" or "unread email"), while an
explicitly negated replay/recall/find request performs no retrieval.

All saved meeting prose is third-party-derived and remains untrusted:

- `meeting_notes` returns only code-owned count/date prose in `summary`;
- saved prose in model-facing `content` is inside exactly one
  `UNTRUSTED_MEETING_CONTENT` wrapper;
- `meeting_notes` carries the persistent-untrusted history bit. The
  replay is redacted before the next request is classified or sent to a
  model, so it cannot become a later browser/network payload or even the
  referent for an ambiguous "open it" request;
- the system prompt names meeting wrappers alongside web/email wrappers;
- meeting-derived reminders retain `source: "meeting"` and
  `untrusted: true`; model-facing reminder list/cancel results wrap and
  taint those values rather than laundering them into trusted text.

## One grouped reminder confirmation

`set_reminder` is not normally confirmation-gated and accepts only one
`{text, minutes|time}` item, so the grouped confirmation cannot be
implemented as several ordinary pending calls.

The server therefore creates one pending, model-hidden
`set_meeting_reminders` batch action after the note is safely stored.
Its parameters contain only the bounded, canonical reminder candidates,
never the transcript or unused model fields. It has a custom grouped
prompt capped below the existing 800-character TTS ceiling, so every
listed item and the final consent question remain audible, and a one-shot
approval token. It uses the existing
`createPending` → spoken/client yes/no → `/api/confirm` →
`consumePending` path. Only the approved execution delegates each
canonical item through the real `set_reminder` implementation. Those real
executions write into an in-memory staging context; one locked append
publishes the whole group only after every item succeeds, so an error
cannot leave a partially applied confirmed batch.

No, ambiguity, expiry, replay, or direct execution produces zero
reminder writes. One yes executes the bounded batch exactly once.

## Tests

`test/meeting.test.mjs` contains exactly five behavioral sections:

1. start/stop phrases are whole-utterance only and there is no
   model-visible recording tool;
2. malformed structured output is rejected after one completion and a
   conventional raw note is saved;
3. the summarise call contains exactly one break-out-safe untrusted
   transcript wrapper;
4. two eligible actions produce one grouped pending confirmation, zero
   writes before approval, and exactly two real `set_reminder` executions
   after one yes;
5. retrieval filters/replays by date, remains wrapped/tainted, is
   registered as the sole meeting retrieval capability, and never
   re-summarises.

`package.json` runs this test immediately before
`eval/run.mjs --selftest`.

## Constraints

No new dependencies. No new audio plumbing. No model-initiated recording.
Single session at a time. Thirty-minute hard mic cap. Mic state always
visible while open. Transcript-derived text untrusted at every
model-facing seam. No audio persisted. Text lives only in the existing
`.data` stores. No git commits.

## Audit corrections

- Replaced the lossy sequential capture/STT loop with concurrent,
  sequence-ordered STT and immediate recapture.
- Disabled command pre-roll for meeting chunks to prevent duplicated
  speech and start-phrase ingestion.
- Separated the 30-minute session deadline from `captureCommand`'s
  expanded per-utterance `capCeiling`.
- Added explicit engine ownership, conversation/follow-up/wake/TTS
  guards, mic-tap and visibility behavior, and stale-generation checks.
- Made local-engine startup bounded for a meeting and cancellable even
  while wake models are still loading, so stop/visibility loss cannot
  reopen the mic after the session has entered `stopping`.
- Moved the visible meeting-mic state and monotonic deadline to the
  atomic session claim, covering the interval after `getUserMedia()`
  succeeds but before worklet startup resolves.
- Preserved the already-buffered partial utterance for mic-tap,
  visibility, and deadline stops while continuing to discard the spoken
  stop chunk and all later audio.
- Corrected the nonexistent orb `recording` state to existing listening
  visuals plus persistent recording/status/accessibility UI.
- Corrected the LLM schema so owner and schedules can be checked against
  the real `set_reminder` contract.
- Replaced the nonexistent ordinary reminder confirmation with one
  model-hidden batch pending action through the existing confirm path.
- Preserved notes-store compatibility and added retrieval/reminder
  provenance so meeting text cannot bypass untrusted wrapping.
- Made meeting retrieval win over incidental topic words, honored
  negated replay requests, and bounded replay output.
- Bounded grouped confirmation speech below the TTS limit and made its
  persistent reminder write all-or-none.
