# Plan Review Log: natural understanding + contextual Terminal + living UI + Pill 2.0
Phases 0-1 (recon + interrogation) complete — plan locked with the user (ledger confirmed, Q1-Q3 decided, escape hatch on cosmetic tier). MAX_ROUNDS=5. Reviewer model: gpt-5.6-sol (~/.codex/config.toml) — codex-cli 0.144.1. inspect=on.

## Round 1 — Codex
The plan is not safe enough to implement. Material flaws:

1. **`contextual` is unroutable.** `classifyIntent()` only considers families present in a tool’s `forceFamilies`; merely adding a pattern and `ACTIONABLE_FAMILIES` entry does nothing because neither terminal tool exposes `contextual`. [toolRegistry.js](/Users/todortopalov/Documents/Artemis/toolRegistry.js:848)  
   Fix: Add an explicit virtual-family routing mechanism or map `contextual` to narrowly selected tools without widening model-visible tools.

2. **Deictic text executes before the proposed interpreter.** The existing direct-local block accepts every `terminalType`, so `"type one and press enter"` would run `"one"` before a contextual tier placed afterward can inspect `deictic`. [server.js](/Users/todortopalov/Documents/Artemis/server.js:3937)  
   Fix: Exclude `terminalType.deictic` from `computerControlIntent()` or place contextual resolution before direct dispatch.

3. **Relay phrases miss the new tier.** `"tell Claude yes"` already matches the `computer` family, has no `terminalType`, and therefore fails the proposed trigger of `contextual || computer+deictic`. [toolRegistry.js](/Users/todortopalov/Documents/Artemis/toolRegistry.js:421)  
   Fix: Route relay-shaped computer intents explicitly or give contextual routing precedence over the old relay pattern.

4. **“Press Enter” cannot be implemented through the existing schema.** `computer_control` has only `open_terminal`, `type_text`, and `type_and_run`; the latter requires non-empty text and uses `do script`, not an Enter keystroke. [computerSkills.js](/Users/todortopalov/Documents/Artemis/computerSkills.js:168)  
   Fix: Add a validated `press_enter` action and a dedicated native keystroke primitive with target verification.

5. **The semantic tier is prompt-injection-authoritative.** Fencing terminal content as “UNTRUSTED” is not a security boundary; poisoned screen text can induce valid JSON for `curl`, `run_command`, or `type_and_run`, and “target exists + schema validates” merely corroborates attacker-controlled evidence.  
   Fix: Restrict the model to choosing among action candidates derived from the user’s utterance; never let screen/model text originate capabilities, commands, URLs, paths, or arbitrary parameters.

6. **The claimed taint protection does not exist for terminal tools.** `needsConfirmation()` ignores `tainted` when `dynamicConfirm === "command"` and auto-runs `safe`/`controlled` text. [toolRegistry.js](/Users/todortopalov/Documents/Artemis/toolRegistry.js:789)  
   Fix: Introduce a `contextDerived` policy input that forces confirmation unless the complete effectful payload came directly and unambiguously from the user.

7. **Shell risk is the wrong policy for TUI input.** A digit or `y` may approve deletion, permanent permission, or an external action inside Claude Code; in raw-mode TUIs even `type_text` is not inert, contrary to the current policy assumption.  
   Fix: Classify interactive keystrokes by prompt/option semantics and default unknown interactive effects to confirmation, not by treating `"1"` as a shell command.

8. **`dispatchDirectSkill()` has no confirmation path.** It assumes the caller already proved confirmation unnecessary; the plan says it will “confirm if approval-risk” without specifying `precheck → createPending → pendingAction`. [server.js](/Users/todortopalov/Documents/Artemis/server.js:2608)  
   Fix: Create one `dispatchOrPendValidatedCall()` helper shared by direct, contextual, model, and repeat paths.

9. **There is a target-switch TOCTOU race.** Perception reads one front tab, then separate AppleScript calls activate Terminal and act on whichever front window/tab exists later; delayed confirmation makes this substantially worse. [macPerception.js](/Users/todortopalov/Documents/Artemis/macPerception.js:427)  
   Fix: Capture a stable Terminal window/tab identifier and context fingerprint, revalidate immediately before execution and again after confirmation, then act on that exact tab.

10. **“Visible options” are not actually visible-only.** `terminalContent()` returns up to 20KB of selected-tab contents, potentially including stale scrollback and multiple old menus; a five-minute TTL magnifies stale selection risk. [macPerception.js](/Users/todortopalov/Documents/Artemis/macPerception.js:177)  
    Fix: Parse only the newest contiguous menu/prompt at the buffer end, strip ANSI/control sequences, use a short TTL, and bind it to a tab plus tail hash.

11. **iTerm is falsely treated as Terminal.app.** Foreground detection accepts `iterm`, but context retrieval and all control still target Apple Terminal, creating a wrong-app confused-deputy path. [macPerception.js](/Users/todortopalov/Documents/Artemis/macPerception.js:317)  
    Fix: Reject contextual control unless the foreground app is supported Terminal.app, or implement a separate iTerm adapter.

12. **Working context is both global and underspecified.** One server-wide instance lets concurrent tabs/remote clients consume each other’s commands, while `lastCommand` omits tool name, working directory, target tab, and validated arguments.  
    Fix: Scope context per authenticated client/session and record only successful exact validated calls, including tool, args, directory, target fingerprint, and outcome.

13. **Stale task state has no lifecycle.** `currentTask` has no TTL or defined clear-on-done/error/cancel behavior, so the dashboard can display completed work indefinitely.  
    Fix: Give tasks turn IDs and terminal lifecycle states, clearing them on every done/error/cancel/disconnect path.

14. **`brainFetch` cannot provide the promised Ollama-only call.** It starts from `currentBrain()` and performs chain failover, which can select cloud providers in hybrid mode. [server.js](/Users/todortopalov/Documents/Artemis/server.js:1792)  
    Fix: Add a single-candidate fetch path with an asserted loopback endpoint, no cooldown mutation, and no provider failover.

15. **The interpreter schema is not actually strict.** `validateToolCall()` tolerates unknown parameters despite registry schemas declaring `additionalProperties: false`, and the proposed `{capability, action, parameters}` translation is undefined. [toolRegistry.js](/Users/todortopalov/Documents/Artemis/toolRegistry.js:731)  
    Fix: Define a discriminated union of permitted interpreter outcomes and reject every unknown field before mapping it to a concrete tool call.

16. **Only `/api/chat/stream` gets the behavior.** `/api/chat` remains a separate path, producing inconsistent routing and safety semantics.  
    Fix: Extract one contextual dispatcher used by both endpoints, with transport-specific response adapters only.

17. **The UI merge is race-prone.** Global presence and per-request chat SSE have no `turnId`, sequence, or ownership rules, so a late tool-end/done from an older turn can overwrite a newer state; client POSTs can also race server-owned fields.  
    Fix: Add monotonic turn/sequence metadata and separate server-owned reasoning/tool fields from client-owned voice/amplitude fields.

18. **The proposed presence schema does not match reality.** `brainChainState()` returns `{current, chain}` rather than `{model, provider, local}`, `networkPolicy` has only a Boolean offline state, and `permissionState` has no stated input despite requiring `/api/permissions`. [server.js](/Users/todortopalov/Documents/Artemis/server.js:499)  
    Fix: Specify and test canonical brain/network/permission schemas before writing `uiState.js`.

19. **The Pill native bridge assumption is wrong.** The `artemisPill` handler is installed only in the main WKWebView; `PillController` creates a separate configuration with no script message handler, so a pill-originated resize message cannot arrive. [PillController.swift](/Users/todortopalov/Documents/Artemis/app/Sources/PillController.swift:82)  
    Fix: Register a dedicated weak message handler on the pill WKWebView or carry size class through the existing presence-command channel.

20. **“Fully offline” is overstated and the smoke test will miss it.** Voice transcription still calls Deepgram, several TTS paths remain cloud-backed, and those endpoints do not consistently enforce `networkPolicy`. [server.js](/Users/todortopalov/Documents/Artemis/server.js:4266)  
    Fix: Either narrow the goal to offline interpretation after transcription or add local STT/TTS plus endpoint-level offline-denial tests.

21. **The proposed integration-test seam does not exist.** `fakeBrain` can fake HTTP and `FAKE_TOOLS` can fake execution, but server perception is statically imported and cannot receive the proposed fake perception dependency.  
    Fix: Extract a dependency-injected contextual dispatcher and test hostile content, stale menus, target switching, confirmation, concurrency, and cloud-fallback denial through it.

22. **Observability covers UI animation, not security decisions.** There is no plan to log resolver tier, context age/hash, candidate rejection, taint status, policy verdict, confirmation reason, target mismatch, or local-model timeout.  
    Fix: Emit structured redacted decision logs and counters keyed by turn ID, never raw terminal content.

23. **A substantially simpler and safer first release exists.** Nearly every stated example is deterministic; the local semantic tier, generic capability schema, and two-stream state merge add most of the attack and race surface.  
    Fix: Ship deterministic contextual resolution plus clarify-only fallback first, centralize lifecycle events on the presence bus, and defer semantic interpretation until adversarial evals demonstrate a safe need.

VERDICT: REVISE
### Claude's response
Accepted (plan-changing): #1 contextual now wired into forceFamilies of computer_control/run_command; #2 deictic parses excluded from direct literal dispatch; #3 relay shapes routed to the contextual tier; #4 press_enter action + native keystroke primitive added; #5+#15 semantic tier redesigned as a candidate-CHOOSER over a deterministically derived closed set (screen text can never originate an action; strict unknown-field rejection); #6 contextDerived input added to needsConfirmation; #7 new classifyInteractiveInput policy for TUI keystrokes (destructive-label screen, unknown interactive effects confirm); #8 shared dispatchOrPend helper using the existing createPending flow; #9 tailHash evidence + revalidation before keystroke and after confirm; #10 tail-only ANSI-stripped parsing, 90s TTL, tailHash binding; #11 contextual control requires foreground Terminal.app; #13 currentTask turn-scoped lifecycle; #14 localBrainFetch single-candidate loopback path; #16+#21 one DI'd contextualDispatch.js shared by /api/chat and /api/chat/stream, testable with fake perception/brain; #17 turnId+seq and ownership rules on the presence merge; #18 canonical brain/network/permission schemas specified before uiState.js; #19 dedicated message handler on the pill webview; #22 structured redacted decision logs.

Rejected with reasons (kept in PLAN.md): #12 per-client context scoping (single-user product); #20 local STT/TTS (out of scope; offline goal narrowed instead); #23 full semantic-tier deferral (DoD requires it; adopted its authority-narrowing instead).

## Round 2 — Codex
Rev 2 resolves most prior routing, injection-authority, DI, observability, native-handler, and offline-scope findings. The narrowed rejection of #20 is reasonable, and retaining #23 is defensible in principle. Material issues remain:

1. **Critical — cloud fallback defeats the candidate-only security boundary.** An unresolved contextual turn falls into the existing generative action loop, where adding `contextual` to both terminal tools forces the cloud model to choose `run_command` or `computer_control`; that loop neither receives the collected terminal context nor enforces the closed candidate set. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:27) [server.js](/Users/todortopalov/Documents/Artemis/server.js:2189)  
   Fix: Use the same closed-candidate chooser with the cloud fallback, or clarify; never send unresolved contextual turns into the ordinary forced-tool loop.

2. **Critical — the interactive policy remains a denylist-based confirmation bypass.** “No destructive word found” does not imply harmless: labels such as “Continue,” “Proceed,” or “Yes” can authorize an opaque destructive or external operation, contradicting “unknown effects confirm.” [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:21)  
   Fix: Default opaque positive/selection effects to confirmation and auto-run only a narrow allowlist of known-safe prompt types or fully explicit user-described effects.

3. **High — confirmation-time revalidation is asserted but not designed into the pending kernel.** `createPending()` currently stores only `{name, params, at}`, and `/api/confirm` consumes it then calls `skill.execute()` directly; `evidence`, target identity, `contextDerived`, and the revalidator would be lost. [skills.js](/Users/todortopalov/Documents/Artemis/skills.js:5889) [server.js](/Users/todortopalov/Documents/Artemis/server.js:3828)  
   Fix: Extend pending actions with an immutable authorization envelope and require validation, policy, precheck, and contextual revalidation immediately before confirmed execution.

4. **High — the proposed evidence cannot detect a changed tab.** The resolver’s evidence contains `tailHash` but no window/tab identifier, while `terminalContent()` currently returns only title/text/source; nevertheless the plan promises to detect a different target tab. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:14) [macPerception.js](/Users/todortopalov/Documents/Artemis/macPerception.js:190)  
   Fix: Add stable Terminal window and selected-tab identifiers to perception, evidence, pending authorization, and every pre-action comparison.

5. **High — stale menus within the last 40 lines remain actionable.** “Newest contiguous menu anywhere in the tail” can still select an old menu followed by a newer shell prompt or ordinary output; a fresh hash proves the buffer is unchanged, not that the menu is active.  
   Fix: Accept only a menu/prompt anchored to the final interactive block/current cursor, and invalidate it when any later shell prompt or completion output exists.

6. **High — rejected finding #12 is a correctness race, not a second-user threat model.** The product supports concurrent dashboard, pill, and phone surfaces; one operator can issue overlapping turns and have “run that again” consume another surface’s global command. Turn IDs on UI events do not partition server recall state. [README.md](/Users/todortopalov/Documents/Artemis/README.md:129)  
   Fix: Scope recall by client/session, or enforce one explicit active-interaction lease that serializes contextual turns across every surface.

7. **The accepted #12 enrichment is not actually reflected in the schema.** The rejection says tool/args/cwd/fingerprint were accepted, but `lastCommand` stores no complete `args`, target, or fingerprint. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:10)  
   Fix: Store `{tool, args, risk, targetId, contextHash, at}` exactly as validated instead of reconstructing arguments from `action` and `text`.

8. **`press_enter` is still missing from resolution and testing contracts.** The primitive is planned, but `resolveDeictic`, `candidateActions`, and the minimum tests never specify when bare “press enter” produces it versus clarification.  
   Fix: Define a `press_enter` candidate requiring a supported foreground Terminal target and fresh prompt/input evidence, then test its direct, stale-target, and confirmation cases.

9. **The candidate chooser has no acceptance threshold.** Valid strict JSON can still confidently or weakly choose the wrong visible option; the plan removed the earlier high-confidence threshold without replacing it.  
   Fix: Require a pinned confidence threshold plus deterministic corroboration, with every lower-confidence or ambiguous result becoming clarification.

10. **The canonical UI schemas remain partly fictional.** `brainChainState().current` is only a name string, insufficient to reliably derive endpoint locality; `permissionState` is incorrectly defined as `pendingConfirm` rather than macOS permissions or an approval state; `activeApplication`/visible context disappeared despite the dashboard requiring them. [server.js](/Users/todortopalov/Documents/Artemis/server.js:499) [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:40)  
    Fix: Enrich the server brain descriptor, rename `pendingConfirm` to `approvalState`, and define server-owned active-context fields with clear-on-turn-end behavior.

11. **The pill-local handler cannot restore the main window by itself.** `applyPresentation()` belongs to `AppDelegate`; moving `{restore}` handling into `PillController` requires an unstated callback/delegate path. [AppDelegate.swift](/Users/todortopalov/Documents/Artemis/app/Sources/AppDelegate.swift:143)  
    Fix: Inject an `onRestore` closure/delegate from `AppDelegate`, or keep restore on the existing presence-command path and reserve the native handler for resizing.

12. **The revised tests do not cover the remaining permission boundaries.** Missing cases include cloud fallback producing zero arbitrary tool calls, opaque benign-looking labels requiring confirmation, actual `/api/confirm` revalidation, stale menus followed by a shell prompt, concurrent surfaces, and bare `press_enter`.  
    Fix: Add these as integration contracts before implementation, including the real pending-store/confirm handler rather than only a mocked `pend` function.

VERDICT: REVISE
### Claude's response
All 12 findings accepted. Plan Rev 3 changes: #1 contextual turns NEVER fall into the generative forced-tool loop — hybrid fallback is one more candidate-choice pass on the cloud brain with the same closed set, else clarify; #2 interactive policy flipped to allowlist shape (user-named effects or plain noun-choice labels auto; 'Continue'/'Proceed'/'Yes' and all opaque effects confirm); #3 pending records gain an immutable authorization envelope and /api/confirm re-runs validation+precheck+revalidation; #4 perception returns stable window/tab identity, carried in evidence and compared pre-keystroke and post-confirm; #5 menus only valid as the FINAL interactive block — any later shell prompt or output kills them; #6 active-interaction lease serializes contextual turns across surfaces (supersedes the r1 #12 rejection's race aspect; per-client partitioning still rejected); #7 lastCommand stores {tool, args, risk, targetId, contextHash, at} exactly as validated; #8 press_enter candidate rule + direct/stale/confirm test cases specified; #9 chooser acceptance pinned at confidence >=0.8 + deterministic corroboration; #10 brain descriptor enriched server-side, permissionState renamed approvalState, server-owned activeContext with clear-on-turn-end; #11 native pill handler is resize-only, restore stays on the presence-command HTTP path; #12 integration contracts added incl. real pending store/confirm handler, opaque-label confirm, stale-menu-then-shell-prompt, zero-arbitrary-cloud-calls.

## Round 3 — Codex
Rev 3 incorporates all 12 findings, but three are only partially resolved and two new security gaps appear.

1. **Cloud fallback remains contradictory and underspecified.** Phase 2 correctly requires a closed-candidate cloud pass, but Q2 still says “existing cloud loop”; the dispatcher dependencies expose only `callLocalBrain`, with no `callCloudBrain` or safe cloud-candidate transport. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:24)  
   Fix: Add an injected `callCloudBrain` candidate chooser and change Q2 to explicitly prohibit the ordinary forced-tool loop.

2. **The interactive “allowlist” still infers safety from wording.** A plain noun such as “Production,” “Administrator,” or “All repositories” can represent deployment, privilege grant, or broad access; absence of an imperative verb does not establish a harmless effect.  
   Fix: Remove the generic plain-noun exemption; auto-execute only recognized safe prompt classes or effects explicitly described by the user, and confirm every opaque ordinal selection.

3. **`userNamed` still bypasses confirmation for opaque effects.** Saying “tell Claude yes” names a token, not what “yes” authorizes; the plan simultaneously says opaque “Yes” confirms and lists dictated answers as auto-executable. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:21)  
   Fix: Treat yes/no/continue/proceed as opaque regardless of `userNamed` unless the prompt’s effect is independently classified as safe.

4. **`press_enter` lacks an explicit interactive-risk rule.** Enter may activate the currently highlighted destructive option, yet the policy only names menu digits and prompt answers; “direct/stale/confirm” tests cannot determine the expected confirmation without a contract.  
   Fix: Route `press_enter` through interactive policy and confirm whenever the focused control/effect is unknown or consequential.

5. **The lease does not serialize all competing terminal activity.** Only contextual turns acquire it, while ordinary direct/model `run_command`, `computer_control`, and confirmed actions can still alter the terminal or working context between contextual revalidation and execution.  
   Fix: Use one abort-safe terminal-action mutex across every read-modify-act path and release it in `finally`; test direct, model, confirm, disconnect, and queue-overflow races.

6. **Terminal-derived text can become persistent prompt injection.** `naturalReply` echoes `optionLabel` into the assistant reply, which the client later returns as trusted conversation history; same-turn candidate constraints do not protect the next ordinary model turn. Current direct computer responses are not marked persistently untrusted. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:37)  
   Fix: Never place raw labels/prompts/model explanations into model-visible history, or attach persistent screen-taint provenance that `sanitizeMessages()` redacts on later turns; add a multi-turn injection test.

7. **Presence ownership omits two newly server-owned fields.** `approvalState` and `activeContext` are canonical server data, but the ownership list excludes both; existing code currently has the client POST pending confirmation state. [PLAN.md](/Users/todortopalov/Documents/Artemis/PLAN.md:40)  
   Fix: Declare both server-owned, publish approval changes directly from pending creation/consumption, reject client writes, and render active-context strings with text-only DOM APIs.

8. **The accepted test plan misses the new persistent-taint and mixed-path races.** It covers same-turn hostile tails and lease serialization, but not malicious labels surviving into the next model turn or non-contextual terminal actions racing the contextual lease.  
   Fix: Add multi-turn history-taint tests and concurrency tests spanning direct dispatch, guarded-loop execution, and `/api/confirm`.

Minor but confusing: the document still identifies itself as “Rev 2,” and Q2 retains obsolete language despite the Rev 3 design.

VERDICT: REVISE
### Claude's response
Accepted: #1 injected callCloudBrain + Q2 rewritten to prohibit the forced-tool loop for contextual turns; #2 plain-noun exemption removed — auto-exec only for recognized benign selector classes or user-described effects; #4 press_enter routed through the interactive policy with its own contract; #5 one abort-safe terminal-action mutex across contextual/direct/guarded-loop/confirm paths, released in finally; #6 screen-derived reply text carries persistent untrusted provenance (mail-taint-style channel + sanitizeMessages redaction) and labels are sanitized before echoing; #7 approvalState and activeContext declared server-owned, client writes rejected, text-only DOM rendering; #8 multi-turn history-taint test and mixed-path race tests added. Header/Q2 staleness fixed (doc now Rev 4).

Partially accepted with reason: #3 — Q1 is a USER-LOCKED decision: explicit addressing ('tell Claude yes') plus visible compatible prompt auto-executes. Hardened instead of overturned: a destructive/consequential prompt now confirms once even when explicitly addressed; bare yes/no/continue tokens chosen by ordinal (not dictated) remain opaque and confirm.

## Round 4 — Codex
Rev 4 substantially addresses the round-3 findings. Q1’s locked relay behavior is acceptable with the destructive-prompt screen. Four material gaps remain:

1. **Critical — `type y` bypasses the new interactive policy.** `terminalTypeForText` marks only ordinals/numbers/submit phrases as deictic, so `"type y"` remains a direct `type_text` action; current confirmation policy treats `type_text` as inert, although a raw-mode TUI can execute `y`, `d`, or another hotkey immediately. [toolRegistry.js](/Users/todortopalov/Documents/Artemis/toolRegistry.js:462)  
   Fix: Treat single-key input as context-sensitive whenever Terminal is foreground, route it through contextual revalidation and interactive policy, and apply the destructive-prompt screen before typing.

2. **The terminal mutex is overbroad and may block interaction for minutes.** `run_command` does not manipulate Terminal.app, yet the plan holds the same mutex across guarded shell execution, which can last 120 seconds by default; a disconnect also cannot abort every current direct-skill path because execution signals are not consistently threaded. [terminalTool.js](/Users/todortopalov/Documents/Artemis/terminalTool.js:23)  
   Fix: Use a Terminal-UI mutex only for perception plus visible keystrokes, keep working-context updates atomic separately, and thread an abort signal through acquisition and execution.

3. **`callCloudBrain` is named but its transport contract remains undefined.** Existing `brainFetch()` can select Ollama and retry/fail over across the chain, conflicting with “exactly one cloud pass.”  
   Fix: Specify a no-tools `cloudCandidateFetch()` that selects one non-local brain, makes one bounded request, performs no chain fallback, and returns only candidate-choice JSON.

4. **Presence ownership still omits presentation mode.** Existing pill behavior depends on client-published `mode`, but Rev 4’s ownership schema lists only `voiceState` and `amplitude` as client-owned; rejecting unowned writes could break full/pill/background transitions. [public/main.js](/Users/todortopalov/Documents/Artemis/public/main.js:140)  
   Fix: Declare `mode` explicitly client/native-owned and include its migration alongside `pendingConfirm → approvalState`.

5. **The locked Q1 mitigation lacks its decisive regression test.** Tests cover opaque labels generally, but not `"tell Claude yes"` against a visibly destructive compatible prompt—the exact exception that must force one Artemis confirmation.  
   Fix: Add that case, plus raw-TUI `"type y"` and confirmation-time target-change variants, to the integration contracts.

VERDICT: REVISE
### Claude's response
All 5 accepted (Rev 5): #1 single-key type_text (<=2-char payloads, Terminal foreground) routed through contextual revalidation + interactive policy + destructive-prompt screen; #2 mutex narrowed to Terminal-UI perception+keystroke sequences only, abort signal threaded, run_command excluded, workingContext separately atomic; #3 cloudCandidateFetch() specified — one non-local brain, one bounded no-tools request, candidate-choice JSON only, no fallback; #4 presentation mode declared client/native-owned in the ownership schema; #5 decisive regressions added: tell-Claude-yes vs destructive prompt (exactly one confirm), raw-TUI type y, confirmation-time target change.

## Round 5 — Codex
Rev 5 addresses all five round-4 findings:

- Short terminal inputs now require contextual policy and revalidation.
- The mutex is limited to Terminal UI operations, with abort propagation and `finally` release.
- Cloud candidate selection has a bounded, single-provider transport contract.
- Presentation `mode` ownership and migration are explicit.
- Tests cover destructive-prompt confirmation, raw-TUI input, and target-change rejection.

No new material security, correctness, schema, or race-condition problems remain. The plan is sound enough to implement.

VERDICT: APPROVED
## Resolution
APPROVED after 5 rounds (23 -> 12 -> 8 -> 5 -> 0 material findings). Builder: Claude (user pre-authorized implementation; design-heavy milestone), post-build Codex cross-inspection ON. Build starts now — no commits, no pushes.
## Post-build inspection — Round 1 dispositions
Accepted+fixed: BLOCKER candidate gating (utterance-gated candidate set, labels only inside the untrusted block); prompt security surface = trailing 3-line block (240 chars, uncapped by display limit); interactive policy reordered (destructive -> opaque-label -> Enter selfTyped/benign-only -> userNamed requires visible evidence); evidence fail-closed on unreadable identity; atomic verify+act via expect_tty guard inside the SAME AppleScript as the keystroke (typeInTerminal/runInTerminal/pressEnterInTerminal + computer_control expect_tty param); lease entry abort check; read_screen added to MAIL_UNTRUSTED_SKILLS + raw screen fallbacks now send mail_taint/mailUntrusted:true; interactive keystrokes excluded from repeat; validateToolCall injected into the dispatcher + precheck re-run at confirm time inside the lease; chooser body read bounded; contextual task/activeContext cleared on every confirm outcome; turn-key stamping in main.js/alive.js.
Rejected with reason: singleKey stays length===1 (the <=2 reading would force confirmation onto 'type ai' — the user's daily, verified literal flow; 2-char raw-TUI hotkeys are an accepted residual risk, documented); foreground guard stays a terminal-emulator blocklist rather than Terminal.app-only (FULL-mode voice use has the dashboard frontmost; target correctness is carried by tty-bound atomic keystrokes instead); pendingConfirm stays client-writable (single-user authenticated UI, display-only field; approvalState is the canonical server-owned channel).

## Post-build inspection — Round 2 (final; cap reached)
Verified fixes accepted; new findings dispositions: BLOCKER candidate-corroboration — implemented positional/label pool gating (label-shaped references expose ONLY token-matching options; positional language exposes the menu); action-shaped labels (Approve/Allow/Apply/Install/…) added to the opaque set ahead of userNamed; interactive provenance preserved through confirmation (repeat exclusion holds); validated.args now feed execution; envelope carries turnId and confirm-time clearing is turn-scoped; abort re-checked after revalidation before the keystroke; client emits a terminal keyed done from finally; policy surface block raised to 600 chars; the 4 expect_tty test expectations fixed AND the four new suites added to npm test (they had not been wired in — the reinspection caught it).
Documented as known limitations (not fixed, reasons logged): 80-char label display cap doubles as part of the policy surface (destructive verbs beyond 80 chars in a single menu label are an accepted residual); full cancellation threading through every non-stream path; precheck-before-prompt (precheck runs at execute and at confirm instead); deep-freeze of pending params (shallow-frozen envelope, single-process store).

Final: npm test 24 suites + 214 node:test assertions, 0 failures. Swift typecheck clean. Nothing committed, nothing pushed.
