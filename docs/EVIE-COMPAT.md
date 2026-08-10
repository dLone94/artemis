# Evie — compatibility inventory (what intentionally stays "Artemis")

Stage 1 of the Artemis → Evie rename changed **display and spoken surfaces only**.
Every identifier below still says `Artemis`/`artemis` **on purpose**. Each one is a
compatibility anchor: macOS keys permissions and defaults off some of them, and the
rest address on-disk user data that has no migration path.

Rule of thumb: **if the user reads it, it says Evie. If the OS or the filesystem reads
it, it says Artemis.**

## Intentionally unchanged

| Item | Where | Why it must stay "Artemis" |
| --- | --- | --- |
| `CFBundleIdentifier` = `com.artemis.desktop` | `app/Info.plist.in` | macOS TCC keys **every** permission grant (Microphone, Input Monitoring, Accessibility, Automation) to the bundle id. Changing it silently revokes all of them and the user must re-grant each by hand. |
| Signing identity `FlowClone Dev` | `app/build.sh` | TCC also binds grants to the code-signing identity. Re-signing under a new identity invalidates existing grants exactly like a bundle-id change. |
| Built app file name `Artemis.app` | `app/build.sh` output, `app/build/` | The bundle path is part of what the user (and any launch agent / login item) points at. The app *displays* as "Evie" via `CFBundleDisplayName`; the file on disk keeps its name so existing grants, aliases and Dock entries survive. |
| `CFBundleExecutable` = `Artemis` | `app/Info.plist.in` | Name of the Mach-O binary inside the bundle, produced by `build.sh`. It is also the process name that `log show --predicate 'process == "Artemis"'` matches. |
| `setFrameAutosaveName("ArtemisMain")` | `app/Sources/AppDelegate.swift` | The autosave key under which AppKit stores window position/size in the defaults domain. Renaming it loses the user's window geometry. |
| Defaults domain / `UserDefaults` keys (e.g. `dictationEnabled`) | `app/Sources/*.swift` | The defaults domain is derived from the bundle id, and the keys are read by already-installed builds. Renaming either resets every user preference to its default. |
| Dispatch queue / error-domain labels (`com.artemis.dictation.network`, `com.artemis.dictation.events`, `ArtemisDictation`) | `app/Sources/DictationController.swift` | Internal identifiers, never displayed. Kept aligned with the bundle id. |
| `ARTEMIS_*` environment variables (`ARTEMIS_ROOT`, `ARTEMIS_NODE`, `ARTEMIS_PORT`, `ARTEMIS_HOST`, `ARTEMIS_HTTPS`, `ARTEMIS_ACCESS_TOKEN`, `ARTEMIS_DATA_DIR`, `ARTEMIS_FAKE_TOOLS`, …) | `server.js`, `skills.js`, `eval/`, `app/Sources/ArtemisConfig.swift`, `package.json` | They live in the user's `.env`, in shell profiles, and in the Info.plist `ArtemisRoot` substitution. Renaming them makes an existing `.env` silently stop configuring anything. |
| Auth cookie `artemis_auth` | `server.js`, `app/Sources/DictationController.swift` | Renaming it logs out every already-paired phone/browser and breaks the native dictation client, which sends the cookie by name. |
| `.data/` stores (`money-map.json`, `gym-log.json`, `action-log.json`, reminders, notes, follow-ups…) | `.data/`, `ARTEMIS_DATA_DIR` | Real user data. Directory and file names are load-bearing paths, not labels. |
| Log directory `~/Library/Logs/Artemis` | `app/Sources/ServerController.swift` | Existing logs, plus any diagnostics instructions already given to the user, point there. |
| Port `4100`, all `/api/*` routes | `server.js`, `public/*.js` | Wire contract shared with the native shell, the eval harness, and bookmarked URLs. |
| `ARTEMIS_SYSTEM_PROMPT` const name | `server.js` | Code identifier. Its *contents* now say "You are Evie"; the binding name is internal. |
| `window.Artemis*` globals (`ArtemisHUD`, `ArtemisSpeak`, `ArtemisConfirm`, `ArtemisBargeIn`, `ArtemisArmWake`, `ArtemisDashboard`, `ArtemisBrainTrace`), `window.__artemis*` | `public/*.js` | Cross-module JS API surface. Renaming is a pure-churn refactor with real breakage risk and zero user benefit. |
| `localStorage` keys (`artemisConversationV1`, `artemisSettingsV2`, `artemisWakeOn`, `artemisMusic`, `artemisAmbient`, `artemisMailWatch`, `artemisBargeIn`, `artemisCelebratedV2`, `artemisDashboardLayout`, `artemisFollowUp`, `artemisCelebrationSettings`) | `public/*.js` | Renaming discards the user's saved conversation, settings, layout and toggles on first load after the update. |
| Custom DOM events `artemis-telemetry`, `artemis-tool`; HUD line kind `"artemis"` | `public/main.js`, `public/cockpit.js`, `public/dashboardV2.js` | Internal event/key names. The *rendered* label for the `"artemis"` kind is now `EVIE`. |
| `UserAgent` suffix `ArtemisShell/1.0` | `app/Sources/AppDelegate.swift` | Sniffed by `public/cockpit.js` (`/ArtemisShell/.test(...)`) to detect the native shell. |
| Self-signed cert subject `/CN=Artemis` | `server.js` | Changing the CN produces a *different* certificate, so every phone that already accepted the old one gets a fresh scary warning. |
| `package.json` `"name": "artemis"` | `package.json` | Package identity, referenced by tooling and lockfiles. |
| Test/eval file names, fixtures, and `eval/` internals | `test/`, `eval/` | Baselines, result files, and the `npm test` chain reference them by path. |
| Wake model files and profile ids (`hey-artemis-v2`, `hey_jarvis_v0.1.onnx`, `hey-jarvis-v0.1`) and `public/wakeLocal.js` loading logic | `public/oww/`, `public/wakeProfile.js`, `public/wakeLocal.js` | Asset paths + SHA-256 pins; renaming an id or file breaks hash verification and forces a rollback. See "Wake phrase" below. |
| Browser-fallback wake vocabulary (`"artemis"`, `"hey artemis"`, …) | `public/wakeWords.js` | Matching data for the Chrome/Edge `SpeechRecognition` fallback, not display text. The token the recognizer accepts is unchanged in Stage 1, so the UI must not claim otherwise. |
| Bracketed log tags `[stt-live]`, `[brain]`, `[dictation]` and `console.*` diagnostics | everywhere | Operator-facing diagnostics, grepped by existing runbooks. |
| Source comments mentioning Artemis | everywhere | Left alone deliberately to keep the Stage 1 diff minimal and reviewable. |

## Wake phrase — manifest-driven, never hardcoded

The wake phrase is **not a constant anywhere in the product**. It is declared by the
active profile in `public/oww/manifest.json`, and a profile is only adopted if every
asset it names matches the SHA-256 the manifest declares (`public/wakeProfile.js`,
`resolveWakeProfile()`).

- **Currently active: `hey-artemis-v2` — phrase "Hey Artemis"**, threshold 0.99. Its three
  declared assets verify against the files on disk, so this is the classifier the engine
  actually loads.
- **Verified rollback: `hey-jarvis-v0.1` — phrase "Hey Jarvis"** (`FALLBACK_PROFILE`,
  compiled into `wakeProfile.js` with its own hashes). Any failure — missing manifest,
  malformed profile, off-origin classifier URL, hash mismatch, half-deployed bundle —
  rolls back to it *before* recognition starts. Failing back to a wake word that works
  beats failing forward into one that might not.
- **No "Hey Evie" model exists.** The Evie rename was display-only and did not touch the
  wake stack.

Every display surface interpolates the resolved phrase instead of spelling one out:
`main.js` caches it in `resolvedWakePhrase` (seeded from `FALLBACK_PROFILE.phrase`,
replaced once `resolveWakeProfile()` returns) and fills every
`<span data-wake-phrase>` slot; `brainPage.js` does the same for `brain.html`, which does
not load `main.js`; `wakePhrase()` prefers the engine's live profile whenever it is
running, so an engine rollback repaints the copy. `cockpit.js` avoids the problem entirely
by saying "say the wake phrase".

This is enforced, not merely intended. `test/wakeProfile.test.mjs` bans the curly-quoted
literals “Hey Jarvis”, “Hey Artemis” and “Hey Evie” from every view file, recomputes the
active profile's asset hashes from disk, asserts the rollback classifier is present, and
asserts the resolution rule agrees with the manifest. `test/identity.test.mjs` separately
bans any "Hey Evie" claim.

> **How this was caught:** Stage 1 of the rename hardcoded "Hey Jarvis" into the UI on the
> stale belief that the custom model had failed its gate and never loaded. The manifest
> said otherwise. Hardcoding *any* phrase is the bug — which phrase is hardcoded is a
> detail.

### Known gap: `evaluation.verdict` is not a gate

`hey-artemis-v2` carries `"evaluation": { "verdict": "FAIL" }` in the manifest, and
`resolveWakeProfile()` **does not read that field** — it gates on shape and asset hashes
only. A profile that failed its false-accept-rate evaluation is therefore live. That is a
wake-quality question, not a display-honesty one (the UI correctly reports what is
running), but it should be resolved deliberately: either gate on `verdict` or re-run the
evaluation and record a passing operating point. See `wake/README.md`.

## Migration

**No data migration is required, by design.** The identity change is display-only:
no bundle id, defaults domain, storage key, file path, route, port, cookie, or env var
moved. An existing install picks up the new name on the next launch with:

- every macOS permission grant intact (bundle id + signing identity unchanged);
- window geometry, preferences, and `localStorage` state intact (keys unchanged);
- `.data/` contents and `.env` intact (paths and variable names unchanged);
- already-paired phones still authenticated (cookie name and token unchanged).

The only visible change after `bash app/build.sh` is the name and the on-screen copy.

## Future rename risks

If a later stage wants the internals renamed too, these are the sharp edges:

1. **Bundle id (`com.artemis.desktop` → `com.evie.desktop`)** — the expensive one. macOS
   treats the result as a *different application*: Microphone, Input Monitoring,
   Accessibility, and Automation grants all reset and must be re-approved one dialog at a
   time. The `UserDefaults` domain moves with it, so window geometry and app preferences
   are lost unless explicitly copied over. Any such change needs a first-run migration
   step plus user-facing instructions, not a search-and-replace.
2. **Renaming the built `Artemis.app` file** — breaks Dock entries, login items, aliases,
   and any Automation grant that names the old path. Combined with a bundle-id change it
   guarantees a full re-grant cycle.
3. **Signing identity** — re-signing (including ad-hoc re-signing during a rebuild)
   invalidates TCC grants even when the bundle id is untouched. Stable signing is why
   `SIGN_ID` is pinned in `app/build.sh`.
4. **`ARTEMIS_*` env vars** — a rename orphans the user's `.env` silently: nothing errors,
   features just stop being configured. Would need a dual-read (`EVIE_X ?? ARTEMIS_X`)
   deprecation window.
5. **`artemis_auth` cookie** — logs out every remote device and breaks the native
   dictation client until it is rebuilt in lockstep.
6. **`localStorage` keys** — discards conversation history, voice/tone settings, dashboard
   layout, and wake/ambient toggles unless a read-old-write-new shim ships first.
7. **`.data/` file names and `~/Library/Logs/Artemis`** — real data and real logs; needs a
   copy-then-verify migration, never an in-place rename.
8. **Wake phrase "Hey Evie"** — not a rename at all but a new model: it requires training,
   an FAR/FRR gate (`wake/README.md`), a new profile id and SHA-256 pins. Shipping it is a
   manifest change (`active`), not a code change — no display string needs editing,
   because none of them name a phrase. Until that model exists, no UI string may claim it
   does.
