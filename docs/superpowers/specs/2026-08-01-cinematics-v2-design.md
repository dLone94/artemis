# Cinematics v2 — "The Lab Comes Alive"

**Date:** 2026-08-01 · **Intensity:** full theatrical · **Scope:** dashboard v2 + brain page + page transitions
**User picks:** all four focus areas (boot drama, ambient life, event reactions, transitions); brain gets its own neural identity.

## 1. Dashboard boot drama (`ops2.css`, `cockpit.js`, `voiceOrb.js`)

- **CRT power-on:** at `hud-in`, a full-viewport overlay plays a bright horizontal line that expands vertically into the scene (450ms), then fades. Pure CSS on `body.dashboard-v2.hud-in::before`.
- **Panel scan-reveal:** each `.v2-panel` materializes with a top→bottom `clip-path` wipe led by a bright scan edge, keeping the existing stagger delays (70–500ms).
- **Orb ignition:** new public `VoiceOrb.ignite()` — three staggered halo ripples + a breath-envelope kick. Called from `cockpit.js` boot `dismiss()` after `enterHud()`.

## 2. Ambient life (idle is never dead) (`ops2.css`)

- **Scanline drift:** a faint 2px light band travels down the viewport every ~14s + a static 3%-opacity scanline texture. `body.dashboard-v2 .v2-shell::after`.
- **Panel glints:** a specular sweep crosses each panel frame on a long randomized-by-delay cycle (12–23s per panel).
- **Spoke energy flow:** slow continuous dash drift along spoke tick paths toward the hub (direction = data flowing to the reactor).

## 3. Event-driven reactions (`dashboardV2.js`, `ops2.css`)

- **Panel flare:** tool telemetry already pulses spokes (`is-pulsing`); now the target panel also flares (`.v2-flare`: border + glow flash, 650ms, removed on animationend).
- **Voice-reactive glow:** a 10Hz interval publishes `window.__artemisAmp` to CSS var `--v2-amp` on the shell; hub outer ring glow and dock mic halo scale with it. Skipped under reduced motion.

## 4. Page transitions (`pageCinema.js` new, hooks in index/brain/about pages)

- **Power-down:** clicks on internal page links are intercepted; `body.power-down` plays a CRT collapse (scene squeezes to a bright center line, 320ms), then navigation proceeds.
- **Power-up:** each page plays the inverse expand on load (one-shot CSS animation).
- Shared module `public/pageCinema.js`, loaded by all three pages; CSS lives in each page's stylesheet.

## 5. Brain neural identity (`brainOrb.js`, `brain.css`, `brainPage.js`)

- **Synapse web:** ~14 fixed background neuron nodes around the orb with faint interconnections; every 0.6–1.6s a random connection *fires* — a light pulse travels it, the endpoints flash and decay. Pool-based, no frame-loop allocation.
- **Neural bloom entrance:** on load, neurons light up in cascade ordered by distance from the core (~1.2s).
- **Core breath:** deepen the existing core pulse to match the reactor's breathing character (amp blending already exists via `__artemisAmp`).
- **Skill synapses:** `brainPage.js` occasionally fires `bp-synapse` on a random skill card (soft flash), echoing the orb's firings.

## Constraints

- Zero deps; CSS + Canvas 2D only. All new motion inside `@media (prefers-reduced-motion: no-preference)` or gated on `prefersReducedMotion()`.
- No frame-loop allocation in canvas code; sprites/pools preallocated.
- `npm test` stays green; verification via orb-shot-style headless screenshots (boot sequence, idle, flare, brain page) + live app relaunch.
