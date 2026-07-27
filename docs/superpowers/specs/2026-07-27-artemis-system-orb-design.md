# The Artemis System — hero scene redesign

**Date:** 2026-07-27
**Status:** approved direction ("surprise me"), building
**Supersedes:** the arc-reactor orb (Revisions 2–3 of the HUD spec)

## Why

Two reactor iterations read as "just rings". The user wants: unique, tech,
continuous motion, agents as their own floating orbs, and the main orb
animated in the spirit of https://www.hellotrillion.ai/ — whose hero is a
slow-turning wireframe globe (nested ellipse wires, 180 s rotation, pulse
halos, teal/violet two-tone). We take that animation language and make it
*live*: the globe reacts to her voice, visibly computes, and is orbited by
agent moons that light up only when their agent actually works.

## Scene inventory (all in `voiceOrb.js`'s canvas, Canvas 2D)

### 1. The sphere — a particle wireframe globe

- ~1,400 dots arranged along ~7 latitude circles and ~11 longitude
  half-circles of a unit sphere, projected with the existing 3D camera
  (keep cursor-follow + auto-spin; base rotation period ~28 s on a tilted
  axis — Trillion's motion, 6× livelier).
- Each dot: 1–2 px, depth-shaded (near bright, far dim), gentle
  per-dot twinkle (phase-offset sine on alpha).
- **Two-tone shading**: dots blend from cyan (`PAL.O`) on the lit side to
  lavender/violet (`--lavender` = #b7a6ff family; add `V:` to `PAL`) on the
  dark side — this two-tone is the reference's signature look.
- A soft core glow inside the sphere (small, PAL.Hl → transparent), far
  subtler than the reactor's disc. The DOM "ARTEMIS" wordmark stays.
- **Halo pulses**: every ~5 s a thin ring expands from the sphere's
  silhouette radius and fades (reuse the ripple pool).

### 2. Voice waves on the surface

While speaking (and while listening with mic input), amp drives a
**travelling wave**: dots displace radially by
`sin(latitude·k − t·speed) · amp · 0.12R`, so sound visibly rolls across
the sphere from pole to pole. At amp 0 the sphere is a clean wireframe.

### 3. Thinking = dissolve and reform

The signature move. While status is "thinking":
- each dot drifts from its wire position toward a per-dot scatter offset
  (precomputed unit vector × up to 0.5R), with per-dot easing delays —
  the sphere loosens into a slow-swirling dust cloud;
- the swirl precesses (the cloud slowly rotates faster than the sphere);
- when thinking ends, dots ease home with overshoot — the sphere snaps
  back into focus. Blend via the existing `_thinkingMix` easing.

### 4. State summary

| status | sphere |
|---|---|
| idle | slow rotation, twinkle, halo pulses |
| listening | radius −8%, brightness up, rotation ×2.5, halo pulses faster |
| thinking | dissolve/swirl per §3 |
| speaking | surface waves per §2 + halo pulse on amp peaks |

### 5. Agent moons

Six moons, one per agent family, drawn in the same canvas (they must pass
in front of/behind the sphere by depth):

| moon | family (registry) | tone |
|---|---|---|
| RESEARCH | research/web | cyan |
| MAIL | email | teal-green |
| MESSAGES | messages | green |
| MEDIA | media/navigate | lavender |
| MEMORY | memory/notes | ice |
| FINANCE | finance | gold (the one sanctioned amber) |

- **Idle**: each moon (3–5 px core + soft glow + 9 px small-caps label)
  drifts on its own inclined elliptical orbit (radii 1.25R–1.6R, distinct
  periods 40–90 s, slight vertical bob). Dim (~0.4 alpha), label at ~0.5.
- **Active** (driven by the existing `tool` SSE events, mapped
  family→moon): the moon eases inward to ~1.05R, brightens to full, grows
  a spinning activity ring, and a **filament** (2-segment quadratic curve,
  subtle flowing dashes) connects it to the sphere while the tool runs.
- **Settle**: on `end`, filament releases, moon flashes green (ok) or red
  (fail) for ~600 ms, then eases back to its orbit.
- Multiple simultaneous active moons allowed (map keyed by family).
- Honesty rule: a moon only ever activates from a real `tool` event.

Client wiring: main.js already forwards `tool` events to
`window.ArtemisHUD.tool(data)`; additionally expose
`orb.toolEvent({family, phase, ok})` on VoiceOrb and call it from main.js
next to the existing `hud("tool", data)` call — one line. The existing
small SVG tool chip stays (textual redundancy is fine).

## Constraints (unchanged from previous revisions)

- Only `public/voiceOrb.js` + the one-line `main.js` hook change. No new
  files unless splitting helpers into `public/orbShared.js` additions.
- Public API byte-compatible: constructor(container,{center}), resize(),
  setStatus(), feed(), connectMic(), connectMediaElement(), stopAudio(),
  dispose(), cur/reduced/_ensureAudio. New method `toolEvent(data)` is
  additive.
- PAL-only colours (adding `V` violet + per-moon tones to PAL in
  orbShared.js is allowed — they become part of the single palette).
- No per-frame allocations: dot positions, scatter vectors, moon orbits
  all precomputed in the constructor as typed arrays / fixed pools.
- Reduced motion: one static frame (sphere formed, moons on their orbits,
  no dissolve).
- The old reactor drawing (bands, comets, tick marquee, scanner, bezel
  arcs) is REMOVED — the sphere + moons replace it entirely. The outer
  flat bezel ticks may stay if they help frame the scene; judgement call.
- The existing 3D `_rings`/satellites/particle shell from the pre-reactor
  era: remove — the moons replace the satellites; keep the background
  starfield particles if they read well behind the sphere.
- Wordmark untouched. TTS/mic/wake pipelines untouched.

## Proof

- `node --check public/voiceOrb.js`, `node --check public/main.js`,
  full `npm test`.
- Motion: three frames captured seconds apart must differ in the orb
  region (verified by the reviewer, not the builder).

## Cinematic pass — 2026-07-27 (round 2)

User verdict on round 1: right idea, execution not striking enough. The
scene reads as a diagram (flat uniform dots), not as light. Six upgrades,
all Canvas 2D:

1. **Additive compositing.** Draw the globe dots, wires, arcs, halos and
   moons with `globalCompositeOperation = "lighter"` (restore for text/
   labels) so overlapping light accumulates — the bloom look. Dot sizes
   vary (1–2.5 px, weighted small); brightest dots get a soft 4× radius
   glow sprite. Pre-render glow sprites to small offscreen canvases in the
   constructor — never gradient-per-dot per frame.
2. **Atmosphere.** Limb glow: a radial-gradient annulus hugging the
   sphere silhouette (cyan, brightest at the edge, transparent inward and
   outward) — planet backlight. Behind everything, a soft violet nebula
   haze (two big pre-rendered radial gradients, slowly drifting).
3. **Data arcs.** A pool of ~10 arcs: each picks two lattice points,
   lifts a quadratic control point above the surface, then animates a
   bright head travelling the curve with a fading tail over ~1.2 s;
   2–4 launches/s in idle, more while thinking/speaking. Depth-clipped
   like everything else (arcs on the far side dim).
4. **Wire pulses.** 4–6 light packets at a time racing along latitude or
   longitude wires (parametric position along the dot chain, brightening
   dots within a short window as they pass).
5. **Scan plane.** Every ~10 s a horizontal ring sweeps pole-to-pole over
   ~2.5 s: dots within its band brighten and lift slightly; the ring
   itself is a thin bright ellipse with additive glow.
6. **Moon polish.** Each moon gets: a faint static orbit path (thin
   ellipse, ~0.08 alpha), a short comet tail (5-sample position history,
   fading), and a 1 px leader line from moon to its label. Active moons'
   filaments gain a slow dash-flow animation (line-dash offset).

State hooks: thinking raises arc launch rate ~3× and tints arcs violet;
speaking launches arcs on amp peaks; listening tightens the atmosphere
(brighter limb, smaller nebula). Constraints unchanged: same files only,
PAL colours, no hot-loop allocations (pools + offscreen sprites built in
the constructor), reduced-motion = one static formed frame, API unchanged.
