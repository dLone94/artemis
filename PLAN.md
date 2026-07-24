# Plan: Fix Artemis's "narrates but doesn't execute" bug + custom "Hey Artemis" wake word
_Locked via grill — by Claude + user. Hardened across Codex R1–R3 (see PLAN-REVIEW-LOG.md)._

## Goal
Restore Artemis's core reliability: today she replies "I'm on it" / "I'm checking" to a task and then does nothing. Two independent causes, both fixed here: (a) a **client-side filler timer** speaks a canned phrase ~1.2s into a turn regardless of the backend (`public/main.js:604`); (b) the server tool loop can return narration with **no tool call**, force the **wrong** tool, or run a tool but **never feed the result back / never check it succeeded**. Fix both so a genuine task reliably runs the *right* tool and speaks the *real* result — **while keeping conversation tool-free** (user: "both chatting and acting"). Then replace the wake word with a custom-trained on-device **"Hey Artemis"**, flipping from "Hey Jarvis" only behind a validated, hash-verified profile with rollback. macOS app packaging (Option A) is deferred.

**Scope decision (Codex R3):** the reliability guarantee is **scoped to the live NVIDIA path** (`streamNvidia` + non-streaming `callNvidia`). The Anthropic path (`callClaude`/stream) is legacy/secondary — it gets the shared prompt policy but is **not** in the forcing/backstop/test guarantee. If the user later makes Anthropic primary, extend the shared modules to it then.

## Approach

### Part 0 — Safety checkpoint (pre-req)
1. Commit the pre-existing audit work as its own reviewed checkpoint, then branch. **Codex R3:** the staged index currently mixes audit code with `.env.example`, local settings, and unrelated UI deletions — that is not an auditable checkpoint. Require: an **explicit file allowlist**, a review of `git diff --cached --name-status`, and a clean cached diff before committing; do this feature on a **dedicated branch/worktree** touching only its own files. **Git caveat:** if a commit fails via macOS TCC/EPERM tooling, run it in the user's terminal (`! git commit …`).

**Sequencing:** Parts 0–2 (code fix) are independently shippable and must NOT block on wake-word training. The plan is "complete" only when on-device "Hey Artemis" is validated, but the bug fix ships first.

### Part 1 — Tool-calling reliability (NVIDIA path)

2. **One `availableTools()` registry (backbone — Codex R3).** Today native web tools are inline in `nvidiaTools()` (`server.js:917`) and `skills.js:428` exposes only static schemas; neither carries availability, intent, effect, or confirmation metadata. Create a single `availableTools()` that is the source of truth for: which tools are advertised to the model, capability/availability checks, intent→tool mapping, exact-function/family filtering, argument validation, and execution authorization. Every control below reads from it.
3. **Kill the premature client filler + share the server's decision (root cause A).** Suppress the verbal filler at `main.js:604` and replace with a **non-verbal pending state** (orb thinking animation). The client must not run its own classifier (it would drift): the server emits an **early `intent_pending` SSE event before model invocation**, and the client **defaults to silence when the intent is unknown**. Route the client's direct `handleOpenIntent()` **through the shared server policy** (decision, per Codex R3 — not "either/or") and use truthful "popup blocked" wording instead of claiming success.
4. **Three-way intent classification (Codex R3).** Classify each turn as `chat`, `needs_clarification`, or `executable_action`. Force a tool **only** for `executable_action`; `needs_clarification` (e.g. "open it", "read the second one" with no referent) asks a question instead of forcing. Detection is registry-derived and recall-biased within the executable class. Genuine `chat` stays `tool_choice:"auto"`.
5. **No streaming double-speak — buffer until resolved (Codex R3).** `streamNvidia` flushes buffered text (~150 chars, `server.js:1090`→`:1131`) before the repair point (`:1133`). For an `executable_action` turn, **buffer every first-response token and emit no TTS** until either a valid allowlisted tool call is chosen or a final failure decision is reached; **discard that narration** when repair begins. Speak only the post-tool result.
6. **Backstop = a real, checked tool round (Codex R2/R3).** When an `executable_action` turn yields zero (or only rejected) tool calls, run a forced round that **appends the tool-call and tool-result to the conversation and requests one post-tool completion**. Track **`requiredActionSatisfied` separately from tool-call count** — search/skills often return error strings, so a call is not proof of success; permit success narration only after an **authorized, successful** result (or a client-action acknowledgement for browser opens). Handle **multiple tool calls** per response.
7. **Authorize + validate before recording (Codex R3 safety).** `runNvidiaTool()` (`server.js:937`) currently records a tool before validation, so a bad call can look completed and defeat repair. Centralize authorization for **every** call: validate name+args against the registry schema **before** any state mutation/counting; add explicit `effect`/`requiresConfirmation` metadata (reminders, cancellations, notes, contacts are currently unconfirmed) and route mutators through the existing confirm-gate; persist only validated pending confirmations.
8. **Deterministic termination + honest failure.** Per-turn execution budget + persistent `forceAttempted` state (not "retry once"). If no valid tool call results, speak an explicit "I couldn't do that / that's unavailable" — never replay withheld filler as success.
9. **Cancellation (Codex R3).** `fetchWithTimeout()` (`server.js:340`) creates/overwrites `opts.signal`, so threading a signal naïvely won't cancel. Build a **request-scoped controller from the client disconnect event, composed with the timeout signal**, pass it through model+tool APIs, and recheck it immediately before persistent writes or client actions.
10. **Testability (Codex R3).** Make the NVIDIA endpoint/client injectable (`NVIDIA_BASE` is hardcoded). Extract a **pure TTS-policy module** from `enqueueTts()` (`main.js:491`, browser-only) so "no early TTS on actionable turns" is unit-testable. Cover both streaming + non-streaming: narration-only→forced tool; fragmented SSE; malformed/wrong-tool rejected; multiple calls; tool-returns-error → honest failure (not false success); cancellation mid-turn; popup-blocked wording; and chat does-not-force.
11. **Lightweight local observability.** Structured logs/counters with a per-turn correlation id: intent class, forced retry, intended-vs-selected tool, schema rejection, `requiredActionSatisfied`, budget exhaustion, latency. (No production telemetry pipeline — single-user app.)

### Part 2 — Stronger tool-use model evaluation (non-blocking; hermetic)
12. Benchmark candidates via the **injectable real server loop with FAKE tools + synthetic email/web fixtures** on both paths (Codex R3 — never run red-team prompts against real Gmail/web/contacts). Keep `qwen/qwen3-next-80b-a3b-instruct` unless a candidate clears a **versioned rubric** with per-stratum pass/fail + baseline non-regression: exact tool choice, arg validity, unnecessary calls, confirmation compliance, malformed rate, retry/loop rate, completion, latency, cost — plus a red-team stratum (ambiguous, unavailable-tool, must-not-act, prompt-injection) with wrong-tool/side-effect as **blockers**. Log effective provider, model id, endpoint, temperature, system-prompt hash, tool-registry hash per run. "Canary" = a **local opt-in model flag + bounded synthetic smoke tests + immediate config rollback** (no live shadowing).

### Part 3 — Custom "Hey Artemis" wake model
13. **Local-only feasibility spike FIRST (Codex R2/R3).** My "3.14 has no wheels" premise was wrong; the real blocker is openWakeWord's **legacy TF/torchaudio pins** and **CUDA/CPU-not-MPS** training. Run a pinned install/export spike **on this machine only**. **No audio or generated data leaves the machine, and no remote GPU, without explicit user approval** (data-governance gate). If it won't build locally, stop and bring the remote/fork option to the user as a separate decision. This spike gates only Parts 3–4.
14. **Data + training.** piper-sample-generator positives with speaker diversity + augmentation; a serious near-miss/long-form negative corpus; licensed data; held-out speaker/environment splits; explicit CPU/remote time budget (not MPS).
15. **Deployment-contract equivalence on the real browser stack (Codex R3).** Shape `[1,16,96]` (`wakeLocal.js:87`) is necessary but not sufficient. Pin the ORT-Web build + frontend/backbone release; compare Python vs. **browser** scores on identical 16 kHz fixtures through the actual `wakeLocal.js` preprocessing, on held-out human speech and supported devices, with latency/inference-lag thresholds.
16. **Release gate = event-level FAR, not vibes (Codex R3).** Offline continuous scorer over many hours of unseen-speaker/device/environment negatives using **production cadence + cooldown semantics**; predeclare **recall-at-event-FAR** and an **upper-confidence-bound** gate. Tune `THRESHOLD` (`wakeLocal.js:28`) from the ROC. Mic testing (`wake-test.html`) is supplementary.

### Part 4 — Flip the phrase (only after Part 3 gate passes)
17. **Versioned `wakeProfile` drives everything (Codex R3).** Today `startLocalWake(_cfg,…)` ignores config and phrase/classifier are hardcoded, so status could show "Hey Artemis" while loading Jarvis. Define a `wakeProfile` {phrase, classifierUrl, threshold, runtime/frontend versions, hashes}; validate it server-side; consume it in `main.js` + `wakeLocal.js`. Ship **immutable versioned asset bundles**, publish the manifest **atomically last**, validate every asset by hash, test **clean-install + corrupt-asset rollback**, and fall back to the **verified Jarvis profile before** browser recognition. Update all hardcoded phrase sites — corrected inventory: `wakeLocal.js:77`,`:28`; `server.js:1670`,`:1672`; `main.js:1070`,`:1095`,`:1116`,`:1727`,`:1728`; `.env.example:61`; `wake-test.html`; `README.md` — deriving displayed values from `wakeProfile`.

## Key decisions & tradeoffs
- **Guarantee scoped to the NVIDIA path**; Anthropic is legacy (shared prompt only).
- **`availableTools()` registry is the backbone** — capability, intent, effect, allowlist, validation all flow from it.
- **Server owns intent; client obeys via `intent_pending` SSE and stays silent when unknown** — no drifting client classifier.
- **Success is `requiredActionSatisfied`, not a tool-call count** — error-string results don't count.
- **Wake feasibility spike is local-only**; remote compute/audio transfer needs explicit approval.
- **Flip behind `wakeProfile` + hashed bundles + Jarvis rollback.**

## Risks / open questions
- **openWakeWord stack may not build locally** (legacy TF/torchaudio, no MPS) — spike decides; remote pivot is a separate user decision with data-governance implications.
- **Registry refactor touches the hot path** — `availableTools()` must not regress current working tools; cover with tests.
- **Suppressing filler adds perceived latency** on actionable turns — pending animation must feel responsive.
- **Custom wake quality uncertain** — event-FAR gate on unseen speakers/devices before flip.
- **Part 2 must stay hermetic** — real integrations in eval risk data exposure and state change.

## Out of scope
- Option A macOS app packaging / Electron.
- `brain.js` extraction refactor.
- iPhone-native app.
- Anthropic-path reliability guarantee (until/unless it becomes primary).
- Production telemetry pipeline; live-traffic canary/shadowing.
