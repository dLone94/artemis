# Artemis — a voice-first, JARVIS-style AI assistant

A local, **zero-dependency** voice assistant with a cinematic command-center UI: a live
3D orb, a HUD command log, and a real agent behind it that can search the web, open
sites, play music, read your Gmail, set reminders, and speak back — hands-free.

No framework, no build step, no `npm install`. Just Node's built-in `http`/`https`/`fs`,
`fetch` for every API (no SDKs), and vanilla JS + Canvas 2D + Web Audio on the front end.

## Run

```sh
node server.js
```

If `node` isn't on your PATH, use a standalone build directly, e.g.:

```sh
'/Users/todortopalov/Library/Caches/ms-playwright-go/1.57.0/node' server.js
```

Open **http://localhost:4100**, tap **TAP TO ENTER** (unlocks audio), and talk to her —
tap the mic, type in the `›` command line, or turn on the wake word and say “Hey Jarvis”.

### …or run her as a Mac app

```bash
bash app/build.sh && open app/build/Artemis.app
```

A real windowed app that starts the server for you, with no terminal and no
browser tab. Links open in your default browser, so pop-up blocking stops
applying and hands-free opening always works. See [`app/README.md`](app/README.md).

## Pages

- `/` — the **cockpit** (daily driver): orb, command log, context panel, controls.
- `/about.html` — the marketing/landing page.
- `/brain.html` — an interactive explainer of the request pipeline.

## Configure (`.env`)

Copy `.env.example` to `.env`. Nothing is required to boot, but each key unlocks a feature:

| Key | Enables |
| --- | --- |
| `NVIDIA_API_KEY` | The brain (NVIDIA NIM, free tier). `LLM_PROVIDER=nvidia` by default. |
| `ANTHROPIC_API_KEY` | Alternative brain (`LLM_PROVIDER=anthropic`). |
| `TAVILY_API_KEY` | Live web search (needed for news, weather, prices). |
| `DEEPGRAM_API_KEY` | Speech-to-text + text-to-speech (incl. live streaming transcript). |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Optional premium voices (free 10k chars/mo). |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | Gmail read + recoverable Trash (see below). |
| `ASSISTANT_USER_NAME` | How she addresses you (default: “sir”). |
| `STRIPE_SECRET_KEY` | Optional revenue-celebration confetti on real payments. |

**Voices** are chosen in the dock. British options include free Deepgram (Pandora/Athena/
Draco), free Microsoft Edge neural (Sonia/Libby/Ryan — most human), and ElevenLabs
(Lily/Alice). If a premium voice's quota runs out she falls back automatically.

## Gmail (optional)

Artemis implements Gmail read + recoverable Trash and no Gmail draft/send
endpoint. Follow-up nudges only open a browser compose that you review and send.
The required Google `gmail.modify` OAuth grant is broader than those implemented
operations and technically authorizes sending, so protect the refresh token.
One-time setup:

1. Google Cloud Console → **Google Auth Platform**: create an OAuth client, type
   **Desktop app**; set **Publishing status → In production** (so the token never expires).
2. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, restart.
3. Open **http://localhost:4100/auth/google** once, approve (Advanced → “go to … (unsafe)”
   if warned). The refresh token is saved to `.env` automatically. Then: “Artemis, check my email.”

## Access from your phone / another computer (optional)

Loopback-only by default (safest). To reach her on your LAN, set in `.env`:

```
ARTEMIS_HOST=0.0.0.0          # your local network (not the public internet)
ARTEMIS_ACCESS_TOKEN=secret   # required password (auto-generated + printed if blank)
ARTEMIS_HTTPS=1               # self-signed cert so a phone's microphone works
```

Startup prints `https://<lan-ip>:4100/?key=<token>` — open that on the device, accept the
self-signed-cert warning once. The token gates every request; loopback stays ungated.

## Example commands

- “Open YouTube” · “Open Google Maps and search for the nearest pharmacy”
- “What's trending on Hacker News? Then open the top one.”
- “Play some relaxing music” · “Cheer me up”
- “Check my email” · “Read the second one”
- “Remind me in 20 minutes to check the oven” · “List my reminders”
- “Remember that I prefer short answers”

## Tests

```sh
node test/confirm-gate.test.mjs   # proves consequential actions can't fire without a spoken "yes"
```

## Wake word (ships as "Hey Jarvis")

Say the active wake phrase — **“Hey Jarvis”** out of the box — to wake her
hands-free. The phrase, the classifier and its threshold all come from one
verified *wake profile* (`public/oww/manifest.json`); the UI never hardcodes it,
so what's displayed is always what the engine actually loaded. Training and
publishing a custom phrase is documented in [`wake/README.md`](wake/README.md).

Detection runs **fully on-device** via
[openWakeWord](https://github.com/dscripka/openWakeWord) (ONNX Runtime Web / WASM) — no
audio ever leaves the browser, no key or account, and it works on **any** browser
**including iPhone Safari** (where the built-in speech recognizer doesn't exist).

The model + runtime files (~14 MB) live in `public/oww/` and are **git-ignored** — drop
them in once so a fresh clone stays small:

```
public/oww/ort.min.js            # ONNX Runtime Web 1.14.0  (single-thread SIMD build)
public/oww/ort-wasm-simd.wasm    # its WASM binary
public/oww/melspectrogram.onnx   # openWakeWord release v0.5.1
public/oww/embedding_model.onnx  #   "
public/oww/hey_jarvis_v0.1.onnx  #   "
```

Get ORT from the `onnxruntime-web@1.14.0` npm package's `dist/` folder, and the three
`.onnx` files from the openWakeWord **v0.5.1** GitHub release assets. `mic-worklet.js`
is already committed. When these files are present, `/api/status` reports
`localWake.ready:true` and the wake toggle enables on every browser. If they're absent,
Artemis falls back to the Chrome/Edge `SpeechRecognition` recognizer (which listens for
“Artemis” and is disabled on Safari/WebKit).

## Known limitations
- **Edge neural voices** use an unofficial Microsoft endpoint; if it breaks, she falls back
  to Deepgram automatically.
- LAN mode is **local network only** — don't port-forward it to the public internet.

## Structure

- `server.js` — HTTP/HTTPS server, auth gate, LLM + tool loop, STT/TTS proxy, Gmail, reminders.
- `skills.js` — the tool registry (open_url, play_media, email, reminders, notes…) + confirm gate.
- `public/` — cockpit (`cockpit.js/css`), voice pipeline (`main.js`), the 3D orb (`voiceOrb.js`).
