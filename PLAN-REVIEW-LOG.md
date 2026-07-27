# Plan Review Log: Fix narrate-don't-execute bug + custom "Hey Artemis" wake word
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

Reviewer model: config pinned `gpt-5.6-sol` was NOT supported on the ChatGPT account (400); overrode to `gpt-5.6-terra` (verified working via probe). Also cleared a stale `~/.codex/models_cache.json` (missing `supports_reasoning_summaries` field, incompatible with codex-cli 0.144.1).

## Round 1 — Codex (INCOMPLETE — usage limit)
Codex began the review (read-only, ~22 file-reading steps) and emitted two partial findings, then the turn FAILED with: "You've hit your usage limit. Upgrade to Plus to continue using Codex … try again at Aug 23rd, 2026." No `VERDICT:` line was reached.

Partial findings salvaged from the stream before it died:
1. **Plan targets only one of two NVIDIA loops** — it patched the streaming `streamNvidia` path but not the non-streaming `callNvidia`/`callBrain` fallback; the bug would survive there.
2. **The forced-tool retry can fire after streaming has already spoken the failed narration** — user hears "I'm on it", then also hears the real result (double-speak) or hears a wrong answer.

### Claude's response
Both findings judged valid and incorporated into `PLAN.md`:
- Part 1 step 5 now mandates extracting the intent/force/backstop logic into a shared helper applied to **both** NVIDIA loops, with a test for the non-streaming path.
- Part 1 step 4 now requires **suppressing narration TTS on actionable intents until the turn resolves** (buffer text; speak only the post-tool result or, for genuine chat, flush normally) — eliminating the double-speak / spoken-failure window.
- Added risks: buffering latency tradeoff; and an explicit note that Act 2 did NOT complete a full adversarial pass (wake-word training feasibility + model-eval remain unreviewed by Codex).

**Status after R1: Act 2 blocked by account usage limit; user chose self-review, then asked to retry Codex. Retried by RESUMING the same thread with model override `-m gpt-5.6-terra` — succeeded.**

## Round 2 — Codex (resume, COMPLETE) — VERDICT: REVISE
Codex finished the review it couldn't complete in R1. Verified anchors and found substantial issues. Key findings:
- **Root cause A (new):** `main.js:604` client-side ~1.2s timer speaks "On it"/"Let me check" independent of the backend — server fixes alone don't stop the false claim.
- **Backstop bug:** forced retry executes tools but never appends tool-call/result nor requests a post-tool completion → email/search results silently discarded.
- **Anchor corrections:** `callBrain` does not exist (1213 is `callLLM`); non-streaming has its own trigger (1154) + prompt assembly (1142); the 1790 Anthropic instruction is NOT dead (active when NVIDIA off); shared base prompt at 264. Confirmed correct: streamNvidia 1031, openish 1042, ACTION_PROMISE_RE 976-978, callNvidia 1141.
- **Safety:** generic `tool_choice:required` can fire wrong tool / unconfirmed mutators; "calendar" intent has no backing tool.
- **Robustness:** no AbortSignal/cancellation; one-retry under-specified vs multiple tool calls; fallback replays false-success prose; no test seam (`NVIDIA_BASE` hardcoded); no observability; client `handleOpenIntent` bypasses server policy.
- **Wake word:** my "3.14 no wheels" premise wrong; real blocker is openWakeWord's legacy TF/torchaudio pins + CUDA/CPU-not-MPS; shape-match ≠ contract equivalence (mel norm, backbone version, score orientation, ONNX ops); 9/10 + ≤1/hr bar statistically weak (needs offline ROC scorer); Part 4 phrase locations corrected to main.js 1070/1095/1116; ship hashed model manifest + rollback.
- **Part 2:** needs gold labels, repeated trials, red-team/prompt-injection corpus, wrong-tool/side-effect as release blockers.

### Claude's response — revised PLAN.md
Accepted nearly all findings. Rewrote: Part 0 (dedicated branch/worktree, don't grab-bag the audit commit); Part 1 now has 9 steps incl. kill the client filler + non-verbal pending (step 2), policy in shared base prompt 264 applied to both providers (3), registry-derived allowlisted forcing dropping calendar (4), backstop as a real tool round appending call+result+post-tool completion (5), mutator arg-validation via confirm-gate (6), execution budget + honest failure (7), AbortSignal (8), injectable endpoint + expanded tests (9), lightweight local observability (10). Part 2 given real eval criteria + red-team corpus (11). Part 3 leads with a pinned install/export **feasibility spike** (12), diverse data + CPU/remote budget (13), deployment-contract equivalence via Python-vs-browser fixture scoring (14), offline ROC validation (15). Part 4: hashed manifest, feature-flag rollback, corrected phrase anchors (16).
**Right-sized (not adopted verbatim):** full production telemetry → local structured logging only (single-user app).

## Round 3 — Codex (resume, COMPLETE) — VERDICT: REVISE
No longer finding *wrong* things — demanding tighter implementation specs and forcing 3 architectural decisions left as "either/or". Material findings incorporated:
- Streaming still could speak pre-repair narration (flush at 1131 before repair at 1133) → buffer ALL first-response tokens on executable turns until a valid tool call or final failure; discard on repair.
- "Both providers" was prompt-text only → **decision: scope the reliability guarantee to the NVIDIA path**; Anthropic legacy (shared prompt only).
- Client can't suppress filler without the server's decision → **`intent_pending` SSE event**, client silent when unknown; route `handleOpenIntent` through shared policy.
- Recall-biased forcing acts on unresolved references → **three-way intent** (chat / needs_clarification / executable_action); force only executable.
- No enforceable registry → **single `availableTools()`** driving advertised tools, capability, intent map, filtering, arg validation, auth (native tools inline in nvidiaTools 917; skills.js 428 static).
- `runNvidiaTool` (937) records before validation; mutators unconfirmed → validate-before-record, effect/confirmation metadata, confirm-gate.
- A valid tool call ≠ fulfilled action (error strings) → track **`requiredActionSatisfied`** separately.
- `fetchWithTimeout` (340) overwrites signal → request-scoped controller composed with timeout.
- `enqueueTts` (491) browser-only → extract pure TTS-policy module for tests.
- Part 0 needs explicit file allowlist + clean `git diff --cached`.
- Part 2 must be hermetic (fake tools + synthetic fixtures), versioned rubric, log effective config hash, canary = local opt-in flag.
- Wake: versioned **`wakeProfile`** (startLocalWake ignores cfg); immutable bundles + atomic manifest + corrupt-asset rollback + verified-Jarvis-before-browser-fallback; event-level FAR + UCB gate; more phrase sites (main.js 1727/1728, .env.example 61); remote-training pivot = data-governance gate → local-only spike, explicit approval before any remote/audio transfer.

### Claude's response — revised PLAN.md (implementation-ready)
Made all three decisions (scope→NVIDIA; route handleOpenIntent through shared policy; local-only spike) and folded in the architectural backbone: `availableTools()` registry, `intent_pending` SSE, three-way intent, buffer-until-resolved, `requiredActionSatisfied`, validate-before-record, AbortSignal composition, pure TTS-policy module, `wakeProfile` + hashed bundles + rollback, hermetic Part 2. 

**Arbiter judgment:** R1→R3 moved from structural bugs → deep implementation specs. The hard design decisions are now settled; remaining Codex asks are increasingly implementation-detail that TDD surfaces naturally. Pausing the loop at R3 (of MAX 5) to return to the user rather than spend more limited Codex quota chasing spec-completeness. Not faking APPROVED — this is a deliberate arbiter call to ship-review.

## Act 3 — Build (2026-07-26)

Codex built; Claude specified and verified. Thread `019f9b1f-378b-79d1-a695-2c50a46f014d`.

### Round 1 — Codex build
Implemented `docs/superpowers/specs/2026-07-26-whatsapp-unread-design.md` in full:
`macMessages.js`, `check_messages`, registry `messages` family, untrusted
wrapping, `test/messages.test.mjs`. Reported `npm test` fully green, no deviations.

### Claude's verdict — REJECTED
The report was accurate and the feature was broken. Every shell command sits
behind an injected runner, so the suite passed while `recentNotifications()`
failed on every input. Measured against the real Notification Centre DB:
`.backup` produced a 3,551,232-byte file that plain sqlite3 could not reopen
(`unable to open database file (14)`); `VACUUM INTO` produced 1,138,688 bytes
and queried fine. The `plutil` extraction had therefore never executed at all.
Dock badge reading was correct throughout, and honest degradation held — it
reported "count available, details unreadable" rather than "no messages".

### Round 2 — Codex fix
Switched the snapshot to `VACUUM INTO`, verified the plist extraction against
real rows, and added a live-system integration test that skips cleanly without
Full Disk Access and asserts the privacy boundary on the real database.

### Claude's verdict — ACCEPTED
Verified independently, not from the report: 7 Mail rows and 1 Viber row parse
with sender/preview/date; WhatsApp correctly reports 0; distinct bundle ids
return distinct results. Full suite 9/9, including
`live Notification Centre snapshot parsed 7 filtered row(s); 28 other-app
row(s) stayed private`. One deviation from the spec (`VACUUM INTO` rather than a
plain copy) is an improvement over what was specified.

Lesson recorded: a test suite that stubs every side effect proves the logic and
nothing about the integration. Real-system checks that skip cleanly are worth
their weight.

## Act 3 — Build (HUD completion, 2026-07-27)

### Round 1 — Codex build (thread 019fa491-6cca-7892-a887-65e87ddaee98, gpt-5.6-sol)
Implemented the spec's open items: full amber→cyan sweep with orbShared.PAL as
the single source of truth; tool orb (SSE `tool` event, additive onToolStart/
onToolEnd callbacks in the streaming loop); density styling; telemetry and
tool-events test suites wired into npm test.

### Claude's verdict
Diff read in full. server.js changes are additive as required — no-op default
callback, end event gated on state.calls advancing, family attached server-side
from the registry. Orb diffs are colour-only. Client tool ring is race-safe and
visibility-aware. Sweep grep clean. Two out-of-spec scaffolding files
(PRODUCT.md, .impeccable/) from Codex's UI plugin were removed. Proof re-run by
Claude: 11 suites + 19/19 eval, all green. PASSED — one round, no fixes needed.

### Round 2 — Codex build: arc-reactor orb (single file, voiceOrb.js)
Replaced the soft sphere with the user-chosen arc-reactor core: hard bright
disc + reticle, four precomputed segmented bands (two counter-rotating),
72-tick scale, thinking scanner, eased state mixes, frame-rate-independent
phases. Outer 3D rings/satellites and the public API untouched.

### Claude's verdict
Diff read in full: helper signatures match orbShared exports; no per-frame
allocations (bands precomputed at module scope); old equalizer/wireframe
globe removed with the blob as intended; one sensible deviation — the old
always-on flat scanner was removed in favour of the thinking-only scanner,
which matches the spec's state table better than keeping both. Proof re-run:
node --check clean, 11 suites + 19/19 eval green. Verified visually in the
app. PASSED — one round.

### Round 3 — Codex resume: continuous-motion pass (voiceOrb.js only)
All 8 Rev-3 motion systems: velocity-wave engines per band (band 2 reverses),
morphing segment endpoints, comet heads with trails, always-on radar +
thinking counter-sweep, 72-tick marquee, rotating hex reticle + plasma core,
idle sonar pings, eased state modulation + shockwaves. Ripples moved to a
fixed pool; central stroke calls DOWN vs Rev 2 (~89 vs ~116).

### Claude's verdict
Diff audited: all pools/typed arrays allocated in the constructor, hot loop
allocation-free; public API surface unchanged; node --check clean; 11 suites
+ 19/19 eval green. Motion empirically confirmed: orb-region hashes of three
frames 1.5 s apart all differ. Awaiting user verdict on the look before
commit.

### Round 4 — Codex build: The Artemis System (full hero redesign)
1,404-dot two-tone particle globe (7 lat / 11 long wires, 28 s tilted spin,
twinkle, halo pool), voice surface waves, thinking dissolve/reform, six
agent moons with idle orbits and tool-event-driven ignite/tether/settle.
Reactor and legacy rings/satellites removed. main.js: one forwarding line.

### Claude's verdict
main.js diff is exactly the one authorized line; orbShared adds V + moon
tones only; API surface intact with additive toolEvent() carrying full
input guards; hot loop allocation-free (verified by scan). Proof re-run:
both syntax checks + 11 suites + 19/19 eval green. Motion confirmed by
frame differencing. Visual verified in-app: globe + 6 labelled moons
(FINANCE gold, MESSAGES green, MEMORY ice, MEDIA lavender) all present.
Awaiting user verdict before commit.
