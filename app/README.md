# Artemis.app

A windowed macOS wrapper around the Artemis server. Double-click it; it starts
the server if one isn't already running, and opens the Command Center in its own
window.

## Build

```bash
bash app/build.sh
open app/build/Artemis.app
```

Needs the Xcode Command Line Tools (`xcode-select --install`) — not full Xcode.
No npm dependencies are added; Artemis still has no `node_modules`.

Drag `app/build/Artemis.app` to `/Applications` once and it behaves like any
other Mac app.

## First run

macOS asks two things the first time:

1. **"Artemis would like to access files in your Documents folder."** — Allow.
   The project lives under `~/Documents`, and the app has to read `server.js`
   and `.env` from there.
2. **Microphone access** — Allow, or the wake word and voice commands can't work.

Both are remembered.

## How it behaves

- **A server is already running?** The app attaches to it and leaves it running
  when you quit. It never terminates a server it didn't start.
- **Nothing running?** It starts `node server.js` itself and stops that one when
  you quit.
- **Links** ("open youtube", a map, a video) open in your default browser. There
  is no pop-up blocking inside the app, so hands-free opening always works — the
  "Pop-up blocked — tap Open" pill is browser-only now.
- **Closing the window quits the app.**

## Transport

The app reads the project's own `.env` — the same file the server reads, so the
two can't disagree — and works out how to connect:

- `ARTEMIS_HTTPS` decides http vs https.
- `ARTEMIS_ACCESS_TOKEN`, if set, is sent as `?key=` on the first load; the
  server replies with a cookie and every later request rides that.
- Artemis's self-signed certificate is trusted **for loopback addresses only**,
  so a bad certificate from anywhere else is still rejected.

This matters: with `ARTEMIS_HOST=0.0.0.0` the server treats every request as
remote and answers an unauthenticated `/api/status` with 401. An app that
assumed plain `http://127.0.0.1:4100` would see that, conclude nothing was
running, and try to start a second server on an occupied port.

## Configuration

| Variable | Effect |
|---|---|
| `ARTEMIS_ROOT` | Where the project lives (default: baked in at build time) |
| `ARTEMIS_NODE` | Full path to a `node` binary |
| `ARTEMIS_PORT` | Port to use (default: `PORT` from `.env`, else `4100`) |

Server output is logged to `~/Library/Logs/Artemis/server.log`.

## Known caveats

- **The microphone prompt can reappear after a rebuild.** macOS ties the grant
  to the code signature, and ad-hoc signing produces a new identity each build.
  It settles once you stop rebuilding. A Developer ID would fix it permanently.
- **`.env` is read at launch.** Changing the port or token needs an app restart,
  not just a server restart.
- **Moving the project** breaks the baked-in path until you rebuild, or set
  `ARTEMIS_ROOT`.

## The icon

`makeicon.swift` draws it with Core Graphics rather than embedding a bitmap: the
same amber core and orbital rings the app renders on screen, with every size
drawn at its own resolution instead of downsampled — which is what keeps it
legible at 16px in the menu bar.

```bash
swiftc -O -o /tmp/makeicon app/makeicon.swift && /tmp/makeicon app/AppIcon.icns
```

`build.sh` regenerates it automatically if `AppIcon.icns` is missing. To use a
different icon, drop your own `app/AppIcon.icns` in place and rebuild.

## Tests

```bash
bash app/test-app.sh                                             # node discovery, transport, probing
./app/build/Artemis.app/Contents/MacOS/Artemis --compat-check    # web API support in WKWebView
```

`--compat-check` loads the real UI and reports what the embedded web platform
can do. Measured on macOS 27, all green — including `MediaRecorder` and
`webkitSpeechRecognition`, both of which were expected to be problems and
weren't.

## Smoke checklist

- [ ] Double-clicking with no server running opens the window
- [ ] Wake word fires and a spoken command executes
- [ ] "open youtube" opens the default browser, with no "pop-up blocked"
- [ ] Quitting with a hand-started server leaves that server running
- [ ] Quitting a server the app started stops it
