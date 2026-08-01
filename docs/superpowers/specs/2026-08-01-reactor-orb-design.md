# Reactor Core Orb — Design Spec

**Date:** 2026-08-01
**Status:** Approved direction (A+B hybrid: arc-reactor core + gimbal cage), adaptive state colors
**Replaces:** the digital-Earth orb concept in `public/voiceOrb.js` (dot-sphere, world mask, plexus shell, nebula)

## 1. Problem

The Earth-globe orb never reads as intentional design at dashboard scale — successive fidelity passes (6× mask, coast hierarchy, plexus shell) produced no perceptible improvement to the user. The orb's job is to be an iconic, voice-reactive presence, not a geography exhibit. New direction: a Jarvis-style holographic arc reactor.

## 2. Visual design

The orb is composed of four layers, drawn back-to-front inside the existing canvas:

### 2.1 Reactor core (~35% of orb radius)

- **Inner glow:** solid radial-gradient disc, white-hot center falling to the state color.
- **Coil ring:** 10 short radial segments evenly spaced around the inner disc (arc-reactor winding look). Static relative to each other; the whole coil ring rotates very slowly.
- **Outer halo:** soft wide bloom around the core.
- **Behavior:** breathes on a ~4s cycle at idle; voice amplitude (`feed()` / mic RMS) drives core scale (+ up to ~12%) and bloom intensity directly — the core is the voice meter.

### 2.2 Segmented instrument rings (2 rings, flat in orb plane)

- Hairline circles broken into arc segments with gaps (inner: 5 segments, outer: 8 segments — exact counts tunable).
- A fine tick ring between them: 60 ticks, every 5th tick longer/brighter.
- Inner ring rotates clockwise, outer counter-clockwise, different slow speeds. Active states multiply rotation speed ~3×.
- **Tool-call sweep:** when `toolEvent()` fires, a bright highlight travels along one arc segment (~800ms). This replaces the Earth-era surface data arcs.

### 2.3 Gimbal cage (2 rings, 3D projected)

- Two thin elliptical rings orbiting the assembly on tilted axes that slowly precess.
- Projected 3D: the front half of each ring draws brighter and *over* the core; the back half draws dimmer and *behind* it (two-pass draw, same pattern as the current orbit passes).
- Subtle scanline shimmer (low-alpha horizontal banding on ring strokes) sells the hologram.

### 2.4 Agent moons — HUD restyle

- Moons keep orbits, labels, lifecycle, hit-testing (`moonInfoAt`) unchanged.
- Marker becomes a small diamond glyph inside corner brackets (`⟨◆⟩` feel), drawn with hairline strokes.
- Orbit path: barely-visible hairline ellipse.
- Tails removed. An agent with a running task gets a slow marker blink + brighter brackets.
- Label: existing mono font, letter-spaced, dimmer than today.
- Moon color follows the state palette: gold while its task runs, cyan when done.

## 3. Adaptive state colors

Driven by the existing `setStatus()` states and `_listeningMix/_thinkingMix/_speakingMix` easing (crossfade ≈600ms; current `stateEase` may be tuned to match).

| State | Core | Rings |
|---|---|---|
| `idle` | soft cyan, slow breath | dim cyan, slow rotation |
| `listening` | brighter cyan + one-shot "iris open" ring expansion on entry | cyan, ticks brighten |
| `thinking` | warm gold, gentle flicker | gold sweep circulating the inner ring |
| `speaking` | white-hot, amplitude-driven flare | cyan-white, 3× rotation speed |

Palette anchors: ice cyan `#4fc3ff` / `#bfefff`, white-hot `#f2fbff`, warm gold `#ffc466`, deep navy falloff toward the background. Exact values tuned during implementation against `tokens.css`.

**Reduced motion (`this.reduced`):** state colors still apply; rotation, precession, breathing, and flicker freeze (matches current behavior of gating animation on `reduced`).

## 4. Technical approach

- **Same file, same public API.** `VoiceOrb` keeps its constructor signature and all public methods: `setStatus`, `feed`, `resize`, `moonInfoAt`, `toolEvent`, `connectMic`, `connectMediaElement`, `stopAudio`, and the `window.__artemisAmp` export. `main.js`, `dashboardV2.js`, `miniOrb.js`, `orbShared.js` require no changes (miniOrb/brainOrb are out of scope).
- **Deleted:** Earth-era passes and data — `_drawSolidBody`, dot seeding/classification, world-mask blob + decode, plexus (`_drawPlexus`), nebula (`_drawNebula`), ambient rise, dot glow/dot passes, data-arc surface pass, moon tails. Estimated −1,200–1,500 lines.
- **Added (~400–500 lines):** `_drawCore`, `_drawInstrumentRings` (with tool-sweep state), `_drawGimbal` (front/back passes), `_drawMoonHUD`.
- **Canvas 2D only, zero dependencies.** Tick ring and segmented rings pre-rendered to offscreen canvases once per resize; the frame loop rotates them via `ctx.rotate` + `drawImage`.
- **Tests:** remove world-mask/dot-classification unit tests; update any test asserting Earth internals; keep/extend API-surface tests (status transitions, amp feed, toolEvent). Suite must stay green.

## 5. Error handling

No new failure modes: no network, no assets, no new inputs. Guard rails carried over: amplitude clamped as today; `toolEvent` with unknown payload degrades to a generic sweep; zero-size canvas short-circuits draw (existing resize guard).

## 6. Verification

1. Unit tests green (`npm test` equivalent used in repo).
2. Headless screenshots (existing playwright standalone harness) at each state — idle, listening, thinking, speaking — plus one with an active moon and a tool sweep.
3. Live relaunch of the desktop app for user eyeball check: rotation smoothness, state color transitions, reduced-motion mode.
