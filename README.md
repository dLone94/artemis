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
tap the mic, type in the `›` command line, or turn on the wake word and say “Artemis”.

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
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | Gmail read + draft (see below). |
| `ASSISTANT_USER_NAME` | How she addresses you (default: “sir”). |
| `STRIPE_SECRET_KEY` | Optional revenue-celebration confetti on real payments. |

**Voices** are chosen in the dock. British options include free Deepgram (Pandora/Athena/
Draco), free Microsoft Edge neural (Sonia/Libby/Ryan — most human), and ElevenLabs
(Lily/Alice). If a premium voice's quota runs out she falls back automatically.

## Gmail (optional)

Read + draft only — **she can never send email**. One-time setup:

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

## Known limitations

- **Wake word** needs Chrome/Edge (`SpeechRecognition`); on Safari/WebKit the toggle is
  disabled — use the mic button instead.
- **Edge neural voices** use an unofficial Microsoft endpoint; if it breaks, she falls back
  to Deepgram automatically.
- LAN mode is **local network only** — don't port-forward it to the public internet.

## Structure

- `server.js` — HTTP/HTTPS server, auth gate, LLM + tool loop, STT/TTS proxy, Gmail, reminders.
- `skills.js` — the tool registry (open_url, play_media, email, reminders, notes…) + confirm gate.
- `public/` — cockpit (`cockpit.js/css`), voice pipeline (`main.js`), the 3D orb (`voiceOrb.js`).
