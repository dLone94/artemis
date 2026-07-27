# Cockpit HUD redesign — spec

**Date:** 2026-07-27
**Status:** approved, ready to build

## Goal

Turn the cockpit into a dense Stark/JARVIS-style HUD — cyan, ringed, always in
motion — where **every gauge is bound to something Artemis actually knows**. Plus
a small orb showing which tool is running *right now*, so the user can see what
she is doing while she does it.

## Decisions already made

| Question | Decision |
|---|---|
| Goal | Both look and information — dense, but nothing decorative |
| Motion | Always moving, like the reference |
| Approach | Evolve the existing cockpit, not a rewrite |
| Palette | Cyan |

## Why evolve rather than rewrite

The current cockpit already has the reference's structure: header status row,
left log column, centre orb, right context column. What is missing is tint, ring
ornamentation, density, and data. All of that is additive, so the working
command line, TTS pipeline and wake-word wiring are never touched.

## The honesty rule

Most JARVIS themes fill space with rings that measure nothing. This one does not.
Every gauge is bound to a real value, and a gauge with no data shows as
unavailable rather than as zero — the same rule the rest of the app follows.

It will therefore **not** be pixel-identical to the reference, half of which is a
Windows desktop: media player, file manager, recycle bin, seven-day forecast.
Artemis has none of those. Same visual language and density, different content.

## Components

### 1. Palette — `public/tokens.css`

47 lines, and the variables are already named `--teal`, `--teal-deep`,
`--lavender` while holding amber values. The flip is mostly changing hexes.

- background near-black with a blue bias, primary cyan, dim cyan for structure,
  white reserved for live values, amber retained only for warnings.
- `app/makeicon.swift` holds the icon palette; regenerate so the Dock icon
  matches (`swiftc -O -o /tmp/makeicon app/makeicon.swift && /tmp/makeicon app/AppIcon.icns`).

### 2. Ring component — `public/hudRing.js` (new)

One reusable SVG ring, instanced at several sizes:

```js
createRing({ size, label, value, max, unit, tone })  -> HTMLElement
ring.set({ value, max, state })                      // updates without rebuilding
```

Structure: tick track, value arc, a continuously sweeping arc, centred label and
value. No canvas — SVG plus CSS so the browser composites it.

### 3. Motion

Always-on, as requested, but implemented so it is nearly free:

- Sweeps are CSS `@keyframes` on `transform: rotate()` only. Transform animations
  run on the compositor, off the main thread. Never animate layout properties.
- Everything pauses under `document.hidden` and when `prefers-reduced-motion` is
  set — invisible or unwanted motion is just heat.
- One shared `animation-delay` ladder so rings desynchronise without JS.

### 4. Telemetry endpoint — `GET /api/telemetry`

Polled every 2s by the cockpit. Read-only, no side effects, loopback-gated like
every other API route.

```json
{
  "cpu": { "load1": 1.9, "cores": 12 },
  "memory": { "usedBytes": 0, "totalBytes": 0 },
  "brain": { "name": "groq:llama-3.3-70b-versatile", "benched": false },
  "budget": { "remainingTokens": 84210, "limitTokens": 100000, "resetsIn": "12m" },
  "latency": { "lastFirstWordMs": 512 },
  "counts": { "unreadMail": 3, "unreadMessages": 0, "reminders": 2 },
  "fx": { "pair": "USD/KES", "value": 129.46, "asOf": "2026-07-27" }
}
```

Sources, all already available or free:

| field | source |
|---|---|
| cpu, memory | `os.loadavg()`, `os.freemem()`, `os.totalmem()` — Node built-ins |
| brain | the `BRAIN_CHAIN` / cooldown state in server.js |
| **budget** | Groq's `x-ratelimit-remaining-tokens` headers, cached from the last call |
| latency | the `ttfw` the client already measures, posted back |
| counts | `check_email` / `check_messages` / reminders store |
| fx | `finance.js` `fxRate()`, cached for 10 minutes |

Any field that cannot be read is **omitted**, and its gauge renders "—", never 0.

`budget` is deliberately included: after exhausting a day's tokens on 2026-07-26,
seeing the remaining allowance is genuinely useful rather than ornamental.

### 5. The tool orb — the only risky piece

The server currently reports `toolsUsed` when a turn *ends*. A live indicator
needs to know when each tool *starts*.

- `runNvidiaTool()` (server.js, around the `state.tools.push(name)` line) gains an
  optional `onToolStart(name)` callback, invoked after validation and before
  execution — the same point that already decides a call is real.
- `streamNvidia` passes a callback that emits a new SSE event:
  `event: tool` with `{ name, phase: "start" | "end", ok }`.
- The client renders a small ring beside the main orb: tool name, a spinning
  arc while running, and a brief settle to green/red on completion.

Colour per family, reusing `toolRegistry`'s existing `family` metadata so the
mapping is not duplicated: navigate, media, email, messages, research, memory,
reminder, contacts.

**This touches the streaming loop**, the most delicate code in the project, so it
is additive only — a callback that defaults to a no-op — and gets its own test
asserting the event fires once per executed tool and never for a rejected one.

### 6. Density and structure — `public/cockpit.css`

Corner brackets on panels, a hairline grid, thin connector lines between
sections, tighter monospace type, small-caps labels. Cosmetic only.

## Error handling

| Situation | Behaviour |
|---|---|
| `/api/telemetry` unreachable | Gauges hold their last value and dim; no crash, no zeros |
| A field missing | That gauge shows "—" |
| Budget headers unseen yet | Budget ring hidden until the first real value |
| Reduced motion / hidden tab | All animation paused |

## Testing

- `test/telemetry.test.mjs` — the endpoint returns the documented shape; a
  failing source omits its field rather than reporting zero; it is loopback-gated
  like other API routes.
- `test/toolevents.test.mjs` — driving the real server loop against the existing
  fake brain: a `tool` start event fires once per executed tool, in order, and
  **never** for a call rejected by validation.
- Existing suites must stay green; `npm test` is the proof command.
- Visual result is judged by eye — screenshot before/after.

## Constraints

- No new npm dependencies.
- No canvas for the rings; SVG + CSS only.
- Do not modify the wake-word engine, `app/`, or the TTS pipeline.
- Additive changes only in `streamNvidia`.

## Out of scope

- Weather, calendar, media player, file manager — the reference's Windows widgets
- Replacing the main orb (retinting it is IN scope — see revision below)
- Mobile layout (the cockpit is a desktop surface)

## Revision — 2026-07-27, after the first build pass

A screenshot of the built app showed the flip half-landed: status dots,
gauges and prompts turned cyan, but the centre orb, command log and context
panels stayed amber. Two findings correct this spec:

**1. The main orb is not Three.js.** It is a hand-written Canvas-2D 3D
projection (`voiceOrb.js`), sharing primitives with `brainOrb.js` via
`orbShared.js`. Retinting it is safe and cheap — no 3D library involved.

**2. "The flip is mostly changing hexes" was wrong.** The canvas layer never
reads CSS tokens. Amber is hardcoded as `rgba(...)` strings in:

| file | what |
|---|---|
| `orbShared.js` | `PAL` — the shared palette the orbs *should* all use |
| `voiceOrb.js` | duplicates `O/B/D/GLOW` inline instead of importing `PAL`; ~10 more literals |
| `brainOrb.js` | ~7 literals despite importing `PAL` |
| `miniOrb.js` | default accent `#ffb86b` |
| `cockpit.js` | starfield/grid/particle draws, ~5 literals |
| `main.js` | waveform gradient, ~3 literals |
| `brainPage.js` | `SEG_COLORS` amber ramp |
| `brain.css` | ~10 amber rgba literals |

### Added component: palette sweep

- `orbShared.js` `PAL` becomes the **single source of truth** for canvas
  colour, flipped to cyan to match `tokens.css` (`--teal #22d3ee`):
  - `O: "rgba(34,211,238,"` `B: "rgba(140,236,255,"` `Hl: "rgba(214,248,255,"`
    `D: "rgba(64,150,170,"` `GLOW: "rgba(34,200,238,0.55)"`
- `voiceOrb.js` drops its inline copy and imports `PAL`; every other literal
  above is replaced with `PAL`-derived values (append the alpha, as the
  existing `"rgba(...," + a + ")"` idiom already does).
- `brain.css` amber literals move to the cyan tokens.
- `celebration.js` confetti keeps its multi-colour set (amber there is one of
  six party colours, not UI chrome). `--amber` stays warning-only.
- Proof: `grep -rn "255,158,72\|255,150,70\|255,178\|255,190,120\|ffb86b" public/ --include='*.js' --include='*.css'`
  returns nothing outside `celebration.js` and `tokens.css`'s warning token.

Everything else in this spec stands: the tool orb, density styling, and the
two tests remain the outstanding work.
