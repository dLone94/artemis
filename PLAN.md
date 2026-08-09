# Gym Coach — Stage 2: live workout mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hands-free live workout: `start workout` walks the template exercise by exercise, sets logged by voice (existing `log_set` confirm flow), client-side rest countdowns that announce over TTS, short commands (next / skip / add a set / how long left / repeat that / finish), and a big phone-readable workout view at `/gym`.

**Architecture:** Server-side session state in `gymLog.js` + a `gym_session` skill family verb set with CODE-OWNED action dispatch (radar-style: the registry derives the action from the user's phrase; the model never picks). The view is `public/gym.html` + `public/gymPage.js` in the house HUD language, embedding the standard voice stack (same script set as `index.html`) plus a session panel driven by 1s-local countdown + `GET /api/gym/session` sync. Rest announcements are CLIENT-side through the existing `/api/tts` (the 30s reminder poll is too coarse — decided in Stage 1 review).

## Global Constraints

- Session state lives in `.data/gym-log.json` under `session` (survives an app restart mid-workout); all writes go through the existing revision-bound pattern. Sets are stored ONLY via the existing confirmed `log_set` — the session never writes a set itself.
- `finish_workout` is `confirm: "always"` ("Finish workout — four exercises, eleven sets logged, forty minutes?"). `start_workout`, `skip_exercise`, `add_extra_set`, and reads are frictionless (they mutate only session bookkeeping, not history; effect `mutation` without always-confirm is the existing house policy for that class — same as money_school progress).
- Rest timers NEVER block logging ("log a set early" cancels the countdown). Timer announcements are short and fixed: "Rest's up — <exercise>, set <n>."
- Safety rules from Stage 1 are inherited unchanged (pain stops coaching; no shame; the GYM COACH prompt paragraph is not modified).
- Phone-first view: minimum touch target 44px, dark HUD palette from `orbShared.js` PAL, readable at arm's length (current exercise ≥ 40px type), works over LAN https on iPhone (the existing `?key=` cookie flow — nothing new).
- No eval rubric changes (stays 1.3.0). Unit tests carry this stage. `npm test` + `npm run eval:selftest` (39/39) green after every task.

---

### Task 1: session model in `gymLog.js`

**Files:** Modify `gymLog.js`; Test: extend `test/gym.test.mjs`.

**Exports added (exact):**
```js
startSession(log, templateId, isoNow) -> new log | {ok:false, message}   // error when a session is already open
sessionState(log, now) -> null | {
  templateId, startedAt, exerciseIndex,
  exercise: {slug, name, targetSets, targetReps, restSeconds},
  setsLoggedThisExercise, setsLoggedTotal,
  restUntil: iso|null, restRemainingSeconds: int|null,
  upNext: {slug, name}|null, done: boolean }
noteSetLogged(log, exerciseSlug, isoNow) -> new log      // called by log_set's post-save hook when a session is open and slug matches the current exercise; sets restUntil = now + restSeconds; auto-advances exerciseIndex when targetSets reached (extra sets don't retreat)
advanceExercise(log, {skip}) -> new log | {ok:false, message}            // next/skip; done:true after last
addExtraSet(log) -> new log                                              // bumps this exercise's target by one for THIS session only
finishSession(log, isoNow) -> {log, summary: {exercises, sets, minutes}} // clears session, stamps workout finishedAt
```
- All time math on epoch-second integers derived from ISO strings; no Date arithmetic on floats.
- [ ] Failing tests: double-start refused; set logging advances after target sets but not after extra sets added; rest window computed and cleared by early logging; skip vs next equivalence at target; finish summary integer math (minutes floor); session survives normalize round-trip; done state after last exercise.
- [ ] Implement, green. Commit `feat(gym): session model`.

### Task 2: session skills + code-owned dispatch + log_set hook

**Files:** Modify `skills.js`, `toolRegistry.js`; Test: extend `test/gym.test.mjs`.

- ONE skill `gym_session` (family `"gym"`, effect mutation) with `action` enum `[start, next, skip, add_set, status, finish]` — but the ACTION IS DERIVED IN THE REGISTRY like the radar's run/replay: "start( my)? workout|let's train|begin (the )?workout" → start; "next exercise|done with (this|these)" → next; "skip (this|that|the)? ?(one|exercise)" → skip; "add (another|an extra|one more) set" → add_set; "how long left|how much (rest|longer)|where are we" → status; "finish( the)? workout|we're done|end (the )?workout" → finish. Dispatch the derived action server-side before any provider can alter it (copy the radar mechanism). `finish` routes through the always-confirm gate with the summary prompt.
- `status` speaks code-templated: rest remaining if resting ("Forty seconds of rest left, then squat set three"), else current exercise/set position and up-next.
- "repeat that" is CLIENT-side: gymPage re-speaks the last TTS line it played (no server round-trip, no new skill).
- `log_set` gains a post-save hook: after a confirmed save, if a session is open and the exercise matches the current one, call `noteSetLogged`; the confirm prompt is unchanged.
- `start_workout` with no open session and no template argument uses the log's first template; a second template later is addressed by name.
- [ ] Failing tests: every dispatch phrase → derived action (classifyIntent probes mandatory, including that "skip this one" does NOT fire outside gym family context — scope the patterns with a gym noun OR require session-open precheck: precheck rejects session verbs with "no workout running — say start workout" when no session is open, which also keeps bare phrases safe); finish confirm prompt contains counts; log_set hook advances session.
- [ ] Implement, green. Commit `feat(gym): session skills with code-owned dispatch`.

### Task 3: `/gym` live view + session endpoint

**Files:** Modify `server.js` (GET `/api/gym/session` — auth-gated position AFTER the access gate, returns `sessionState` or `{}`; route `/gym` serves the page); Create `public/gym.html`, `public/gymPage.js`; Test: extend `test/gym.test.mjs` for the endpoint shape (boot-smoke style if an HTTP test exists to copy — see `test/boot-smoke.test.mjs`).

- Page composition: standard voice stack scripts exactly as `index.html` includes them (so wake word, hold-to-talk, TTS, tool events all work), plus `gymPage.js` rendering: current exercise name (≥40px), "set 2 of 3 · target 8 reps", last-time numbers for this exercise (from `gym_status` data embedded in the session payload — add `lastTime: {weightGrams, reps}|null` to `sessionState`), a rest countdown ring (client 1s tick seeded from `restRemainingSeconds`, resync on each poll), logged-set ticks, up-next line, and a finish button (44px+) that speaks "finish workout" into the normal voice pipeline (button triggers the same text path as speech — find how cockpit submits typed commands and reuse).
- Poll `GET /api/gym/session` every 5s + immediately after any tool event with family "gym"; countdown runs locally between polls. At zero: play the fixed announcement through the same TTS path main.js uses, once.
- Reduced-motion: no ring animation, numeric countdown only. No session → a single "say start workout" card.
- [ ] Tests: endpoint returns `{}` with no session and the full shape with one (drive via skills in a booted test server if boot-smoke pattern allows; otherwise unit-test `sessionState` shape and register the route in the CODE_FILES list check).
- [ ] Visual proof: screenshot at iPhone width (390px) and desktop; attach paths.
- [ ] `npm test` + selftest green. Commit `feat(gym): live workout view at /gym`.

## Out of scope

Pounds, exercise videos/anything external, auto-created reminders, nutrition (never), eval rubric changes, changing Stage 1 confirm flows.
