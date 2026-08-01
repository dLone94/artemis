# Reactor Core Orb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the digital-Earth orb in `public/voiceOrb.js` with a Jarvis-style arc-reactor: glowing core + counter-rotating segmented rings + 3D gimbal cage + HUD-restyled agent moons, with adaptive state colors (cyan idle → gold thinking → white-hot speaking).

**Architecture:** Single-file rewrite of the render layers inside the existing `VoiceOrb` class. The public API, audio plumbing, moon lifecycle, ripple/halo pool, scroll recession, and wordmark are untouched. Earth-era geometry (world mask, 12.5k dots, plexus, nebula, cage, scan, surface data arcs, moon tails) is deleted and replaced by four new draw methods.

**Tech Stack:** Vanilla ES modules, Canvas 2D, zero dependencies. Node test suite via `npm test`. Screenshots via playwright-core at `/Users/todortopalov/Documents/Claude Code Apps/Storytel clone/node_modules/playwright-core`.

**Spec:** `docs/superpowers/specs/2026-08-01-reactor-orb-design.md`

## Global Constraints

- Zero runtime dependencies; Canvas 2D only; everything stays in `public/voiceOrb.js` (plus one new screenshot script).
- Public API frozen: `constructor(container, opts)`, `resize()`, `setStatus(status)`, `feed(amplitude)`, `moonInfoAt(x, y)`, `toolEvent(data)`, `connectMic(stream)`, `connectMediaElement(el)`, `stopAudio()`, `dispose()`, and the `window.__artemisAmp` export. No caller (`main.js`, `dashboardV2.js`, `orbShared.js`, `miniOrb.js`) may need changes.
- Statuses are exactly `"idle" | "listening" | "thinking" | "speaking"` (see `setStatus`).
- Reduced motion (`this.reduced`): state **colors** still apply; rotation, precession, breathing, flicker, and sweeps freeze.
- No allocation in the frame loop: reuse preallocated arrays/objects; gradients and sprites built in constructor/`resize()` only (existing convention).
- Keep: ripple/halo pool (`_emitRipple`, `_drawHalos`), moon orbits/labels/hit-test, ARTEMIS wordmark block, `hudAlpha`/`recede` scroll behavior, `_sceneAlpha`, `_listeningMix/_thinkingMix/_speakingMix` easing.
- `npm test` must pass after every task.
- Commit after every task on branch `fix/tool-calling-reliability`.

---

### Task 1: Screenshot harness + debug handle

**Files:**
- Create: `scripts/orb-shot.mjs`
- Modify: `public/voiceOrb.js` (constructor, one line)

**Interfaces:**
- Produces: `node scripts/orb-shot.mjs <status> <outfile.png>` — boots the server on port 4199, opens the dashboard, sets the orb status, screenshots to `artifacts/`.
- Produces: `window.__voiceOrb` — the live `VoiceOrb` instance (debug handle used by the harness and later tasks).

- [ ] **Step 1: Add the debug handle**

In the `VoiceOrb` constructor (after `this.container = container;`):

```js
if (typeof window !== "undefined") window.__voiceOrb = this;
```

- [ ] **Step 2: Write the harness**

```js
// scripts/orb-shot.mjs — screenshot the orb in a given status.
// Usage: node scripts/orb-shot.mjs <idle|listening|thinking|speaking> <out.png>
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const PW = "/Users/todortopalov/Documents/Claude Code Apps/Storytel clone/node_modules/playwright-core/index.mjs";
const [status = "idle", out = `artifacts/orb-${status}.png`] = process.argv.slice(2);

const server = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: "4199" },
  stdio: "ignore",
});
try {
  await wait(1500);
  const { chromium } = await import(PW);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:4199/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__voiceOrb, null, { timeout: 10000 });
  await page.evaluate((s) => window.__voiceOrb.setStatus(s), status);
  if (status === "speaking") {
    await page.evaluate(() => window.__voiceOrb.feed(0.7));
  }
  await wait(1800); // let state mixes ease in (~600ms) + rings move
  await page.screenshot({ path: out });
  await browser.close();
  console.log("WROTE", out);
} finally {
  server.kill();
}
```

- [ ] **Step 3: Verify it works against the current (Earth) orb**

Run: `node scripts/orb-shot.mjs idle artifacts/orb-baseline.png`
Expected: `WROTE artifacts/orb-baseline.png`, file exists and shows the current orb. If `channel: "chrome"` fails to launch, drop the `channel` option (bundled chromium).

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all green (harness touches no server code).

- [ ] **Step 5: Commit**

```bash
git add scripts/orb-shot.mjs public/voiceOrb.js
git commit -m "chore(orb): screenshot harness + __voiceOrb debug handle"
```

---

### Task 2: Strip Earth-era rendering to a minimal booting orb

**Files:**
- Modify: `public/voiceOrb.js` (large deletion, ~1,200–1,500 lines)

**Interfaces:**
- Consumes: nothing new.
- Produces: a minimal orb that still boots and animates: core glow sprite + halos/ripples + moons (old style, temporarily) + wordmark + scroll recession. All later tasks build on this skeleton. `_draw(time)` pass order after this task:

```js
this._drawLimb(silhouetteRadius);        // keep temporarily; deleted in Task 6
this._drawOrbitPass(false);
this._drawMoonLightPass(false, time, silhouetteRadius);
/* core glow drawImage block stays as-is */
this._drawHalos(time, silhouetteRadius);
this._drawOrbitPass(true);
this._drawMoonLightPass(true, time, silhouetteRadius);
this._drawMoonLabelPass(false); // + (true) with the same source-over wrapping as today
```

- [ ] **Step 1: Delete Earth-era code**

Delete these **methods** entirely: `_drawNebula`, `_drawProjectorBase`, `_drawSolidBody`, `_drawPlexus`, `_drawAmbientRise`, `_drawDotGlowPass`, `_drawDotPass`, `_drawLightPacketPass`, `_drawDataArcPass`, `_drawScanPass`, `_drawCagePass`, `_projectCage`, `_drawMoonTailPass`, `_drawMoonTethers`, `_drawFilament`, `_launchDataArc`.

Delete these **module-level items**: the world-mask blob and its decoder (`decodeEarthMask`, `earthMaskValue`, the mask string/bytes), `isPopulationRegion`, dot-seeding helpers, and constants that become unreferenced — at minimum `LEGACY_DOT_COUNT`, `DOT_COUNT`, `EARTH_MASK_WIDTH/HEIGHT`, `EARTH_FRONT_LONGITUDE`, all `CAGE_*`, `DOT_TONE_BUCKETS`, `DOT_ALPHA_BUCKETS`, `DOT_STYLE_GROUPS`, `DATA_ARC_*`, `WIRE_PULSE_COUNT`, `SCAN_*`, `MOON_TAIL_*`, `DOT_GLOW_SIZE`, `ARC_GLOW_SIZE`.

Delete from the **constructor**: the mask decode + coast pass, every `_dot*` typed array, `_lightBucket*`, the whole dot-seeding loop, plexus seeds, moon-tail arrays (`_moonTailX/Y/Depth`, `_moonTailCursor`, `_nextMoonTailAt`).

Delete from **`_loop`/`_draw`**: dot projection/sorting, `_cloudYaw` updates, scan scheduling, data-arc launching (`this._launchDataArc(...)` call sites — keep `toolEvent` itself; have it no-op visually for now with a `// Task 4 wires this to the ring sweep` comment), moon-tail sampling block, and all deleted draw calls from the pass list (leave the pass order shown in Interfaces above).

Keep `_emitRipple`, `_drawHalos`, `_drawLimb`, `_drawOrbitPass`, `_drawMoonLightPass`, `_drawMoonLight`, `_drawMoonLabelPass`, `_drawMoonLabel`, the core-glow `drawImage` block, the wordmark block, and all reform/`_reformStrength` state (harmless).

- [ ] **Step 2: Syntax check**

Run: `node --input-type=module --check < public/voiceOrb.js`
Expected: no output (clean parse).

- [ ] **Step 3: Boot + suite**

Run: `npm test`
Expected: green, including `boot-smoke`.

- [ ] **Step 4: Visual smoke**

Run: `node scripts/orb-shot.mjs idle artifacts/orb-stripped.png`
Expected: page renders, no console errors, minimal glow + moons visible (sparse is fine — this is the skeleton).

- [ ] **Step 5: Commit**

```bash
git add public/voiceOrb.js
git commit -m "refactor(orb): strip Earth-era rendering to minimal skeleton"
```

---

### Task 3: Adaptive state palette engine

**Files:**
- Modify: `public/voiceOrb.js` (constants + constructor + `_loop` + new method)

**Interfaces:**
- Produces: `this._coreRGB` and `this._ringRGB` — `[r, g, b]` arrays refreshed once per frame in `_loop`, consumed by every draw method in Tasks 4–6. Also `this._activeMix` — `max(_listeningMix, _thinkingMix, _speakingMix)`, used for rotation-speed scaling.

- [ ] **Step 1: Add palette constants (module level)**

```js
// Adaptive Jarvis palette: idle/listening cyan, thinking gold, speaking white-hot.
const STATE_COLORS = {
  idle:      { core: [143, 214, 255], ring: [79, 195, 255] },
  listening: { core: [191, 239, 255], ring: [110, 210, 255] },
  thinking:  { core: [255, 196, 102], ring: [255, 176, 76] },
  speaking:  { core: [242, 251, 255], ring: [190, 235, 255] },
};
```

- [ ] **Step 2: Preallocate + blend**

Constructor: `this._coreRGB = [0, 0, 0]; this._ringRGB = [0, 0, 0]; this._activeMix = 0;`

New method:

```js
_blendPalette(out, key) {
  const idle = STATE_COLORS.idle[key];
  const listen = STATE_COLORS.listening[key];
  const think = STATE_COLORS.thinking[key];
  const speak = STATE_COLORS.speaking[key];
  for (let channel = 0; channel < 3; channel++) {
    let value = idle[channel];
    value += (listen[channel] - value) * this._listeningMix;
    value += (think[channel] - value) * this._thinkingMix;
    value += (speak[channel] - value) * this._speakingMix;
    out[channel] = value | 0;
  }
}
```

In `_loop`, right after the three mix updates:

```js
this._blendPalette(this._coreRGB, "core");
this._blendPalette(this._ringRGB, "ring");
this._activeMix = Math.max(
  this._listeningMix,
  Math.max(this._thinkingMix, this._speakingMix)
);
```

- [ ] **Step 3: Un-gate thinking color from reduced motion**

In `_loop`, change `const thinkingTarget = !this.reduced && this.status === "thinking" ? 1 : 0;` to `const thinkingTarget = this.status === "thinking" ? 1 : 0;`. (The spec requires colors in reduced-motion mode; motion is frozen at the draw sites instead. `_reformStrength` already zeroes itself under `reduced` in `setStatus`, so no scatter animation returns.)

- [ ] **Step 4: Verify**

Run: `node --input-type=module --check < public/voiceOrb.js && npm test`
Expected: clean parse, suite green.

- [ ] **Step 5: Commit**

```bash
git add public/voiceOrb.js
git commit -m "feat(orb): adaptive state palette engine (cyan/gold/white-hot)"
```

---

### Task 4: Reactor core

**Files:**
- Modify: `public/voiceOrb.js` (new method `_drawCore`, replace the old core-glow drawImage block)

**Interfaces:**
- Consumes: `this._coreRGB`, `this._activeMix`, `this.cur.amp`, `this.reduced`, `this._sceneAlpha`.
- Produces: `_drawCore(time, R)` — called from `_draw` between the back and front passes. `R` is `silhouetteRadius`.

- [ ] **Step 1: Implement `_drawCore`**

```js
_drawCore(time, R) {
  const ctx = this.ctx;
  const [r, g, b] = this._coreRGB;
  const amp = this.cur.amp;
  // Breath: ~4s cycle at idle; frozen under reduced motion. Voice flares on top.
  const breath = this.reduced ? 0 : 0.04 * Math.sin(time * (TAU / 4));
  const flare = amp * 0.12;
  const coreR = R * 0.35 * (1 + breath + flare);

  // Outer halo (wide soft bloom)
  let glow = ctx.createRadialGradient(0, 0, coreR * 0.2, 0, 0, coreR * 2.4);
  glow.addColorStop(0, `rgba(${r},${g},${b},${0.5 + amp * 0.3})`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, coreR * 2.4, 0, TAU);
  ctx.fill();

  // Inner disc: white-hot center falling to state color
  const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
  disc.addColorStop(0, `rgba(255,255,255,${0.92 + amp * 0.08})`);
  disc.addColorStop(0.55, `rgba(${r},${g},${b},0.8)`);
  disc.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(0, 0, coreR, 0, TAU);
  ctx.fill();

  // Coil ring: 10 radial winding segments just outside the disc.
  // Thinking flicker: subtle per-segment alpha wobble, frozen when reduced.
  const coilInner = coreR * 1.06;
  const coilOuter = coreR * 1.3;
  const spin = this.reduced ? 0 : time * 0.05;
  ctx.lineWidth = Math.max(1.5, R * 0.02);
  ctx.lineCap = "round";
  for (let i = 0; i < 10; i++) {
    const angle = spin + (i / 10) * TAU;
    const flicker = this.reduced
      ? 0
      : this._thinkingMix * 0.25 * Math.sin(time * 7 + i * 2.4);
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.55 + flicker})`;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * coilInner, Math.sin(angle) * coilInner);
    ctx.lineTo(Math.cos(angle) * coilOuter, Math.sin(angle) * coilOuter);
    ctx.stroke();
  }
}
```

Note: gradients here are cheap (2 per frame) but if the existing code avoids per-frame gradients entirely, cache the disc/halo as offscreen sprites per palette bucket in `resize()` — follow the `_coreGlow` sprite pattern already in the file and tint via `globalAlpha` + two stacked sprites (cyan + gold) crossfaded by `_thinkingMix`.

- [ ] **Step 2: Wire into `_draw`**

Replace the old core-glow `drawImage` block with `this._drawCore(time, silhouetteRadius);` at the same position in the pass order.

- [ ] **Step 3: Verify visually**

Run: `node scripts/orb-shot.mjs idle artifacts/orb-core-idle.png && node scripts/orb-shot.mjs thinking artifacts/orb-core-thinking.png`
Expected: idle = cyan reactor disc with coil segments; thinking = the same geometry in warm gold.

- [ ] **Step 4: Suite + commit**

```bash
npm test
git add public/voiceOrb.js
git commit -m "feat(orb): reactor core — breathing disc, coil ring, amp flare"
```

---

### Task 5: Instrument rings, tick ring, tool-call sweep

**Files:**
- Modify: `public/voiceOrb.js` (constructor/resize sprite, new methods `_drawInstrumentRings` + `_launchRingSweep`, `toolEvent` wiring)

**Interfaces:**
- Consumes: `this._ringRGB`, `this._activeMix`, `this.reduced`.
- Produces: `_drawInstrumentRings(time, R)` called from `_draw`; `toolEvent(data)` now calls `this._launchRingSweep(timeNow)` (keep `toolEvent`'s signature and its existing moon bookkeeping untouched).

- [ ] **Step 1: Ring state (constructor)**

```js
this._ringAngleInner = 0;
this._ringAngleOuter = 0;
this._tickAngle = 0;
this._sweep = { active: 0, t0: 0 }; // one sweep at a time; retrigger restarts
```

- [ ] **Step 2: Tick-ring sprite (in `resize()`, after canvas sizing)**

60 ticks, every 5th longer, drawn once to an offscreen canvas sized `2.2 * R * dpr`, stroked in white at full alpha — tinting happens at draw time via `globalAlpha` and `globalCompositeOperation = "lighter"` over the state color already applied to surrounding elements. Follow the existing offscreen-sprite pattern (`_coreGlow`).

```js
const tickSize = Math.ceil(R * 2.2 * this.dpr);
this._tickSprite = document.createElement("canvas");
this._tickSprite.width = this._tickSprite.height = tickSize;
const tctx = this._tickSprite.getContext("2d");
tctx.translate(tickSize / 2, tickSize / 2);
tctx.strokeStyle = "rgba(255,255,255,0.9)";
for (let i = 0; i < 60; i++) {
  const major = i % 5 === 0;
  const angle = (i / 60) * TAU;
  const inner = R * 0.57 * this.dpr;
  const outer = (major ? R * 0.615 : R * 0.60) * this.dpr;
  tctx.lineWidth = (major ? 1.6 : 1) * this.dpr;
  tctx.beginPath();
  tctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
  tctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
  tctx.stroke();
}
```

(If `R` isn't known in `resize()`, compute from the same silhouette formula `_draw` uses — hoist that radius computation into a helper `_silhouetteRadius()` used by both.)

- [ ] **Step 3: Implement `_drawInstrumentRings`**

```js
_drawInstrumentRings(time, R) {
  const ctx = this.ctx;
  const [r, g, b] = this._ringRGB;
  const speed = 1 + this._activeMix * 2; // 3x when fully active
  if (!this.reduced) {
    this._ringAngleInner += this._dt * 0.12 * speed;
    this._ringAngleOuter -= this._dt * 0.08 * speed;
    this._tickAngle += this._dt * 0.02 * speed;
  }

  // Inner ring: 5 segments x 50deg; Outer ring: 8 segments x 33deg.
  const rings = [
    { radius: R * 0.5, count: 5, span: 50 * DEG, angle: this._ringAngleInner, width: Math.max(1.2, R * 0.014) },
    { radius: R * 0.68, count: 8, span: 33 * DEG, angle: this._ringAngleOuter, width: Math.max(1, R * 0.009) },
  ];
  const tickBoost = this._listeningMix * 0.3;
  for (const ring of rings) {
    ctx.lineWidth = ring.width;
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.5 + tickBoost})`;
    for (let i = 0; i < ring.count; i++) {
      const start = ring.angle + (i / ring.count) * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, ring.radius, start, start + ring.span);
      ctx.stroke();
    }
  }

  // Tick sprite, rotated
  const size = this._tickSprite.width / this.dpr;
  ctx.save();
  ctx.rotate(this._tickAngle);
  ctx.globalAlpha = this._sceneAlpha * (0.4 + tickBoost);
  ctx.drawImage(this._tickSprite, -size / 2, -size / 2, size, size);
  ctx.restore();

  // Tool-call sweep: bright highlight arc traveling the inner ring for 0.8s.
  // Thinking state keeps a slow perpetual sweep circulating.
  const sweepAge = time - this._sweep.t0;
  const toolSweep = this._sweep.active && sweepAge < 0.8 ? 1 - sweepAge / 0.8 : 0;
  const thinkSweep = this._thinkingMix;
  if (toolSweep > 0 || thinkSweep > 0.02) {
    const progress = toolSweep > 0 ? sweepAge / 0.8 : (this.reduced ? 0.3 : (time * 0.35) % 1);
    const alpha = Math.max(toolSweep, thinkSweep * 0.5);
    ctx.lineWidth = Math.max(2, R * 0.02);
    ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.9})`;
    const start = this._ringAngleInner + progress * TAU;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.5, start, start + 24 * DEG);
    ctx.stroke();
  }
  if (this._sweep.active && sweepAge >= 0.8) this._sweep.active = 0;
}
```

`this._dt` must be set in `_loop` from the existing frame-delta computation (store `this._dt = dt;` where `dt` is derived — it already exists for spin updates).

- [ ] **Step 4: Wire the sweep + listening iris**

In `toolEvent(data)`, where `_launchDataArc` used to fire: `this._sweep.active = 1; this._sweep.t0 = this._elapsed;` (match however `time` is tracked — `_elapsed` is maintained in `_loop`).

Listening "iris open": in `setStatus`, the existing `status === "listening"` branch already emits a ripple (`_emitRipple`) — keep that as the iris-open (halo pool renders it); no new code.

- [ ] **Step 5: Wire into `_draw`**

Call `this._drawInstrumentRings(time, silhouetteRadius);` immediately after `this._drawCore(...)`.

- [ ] **Step 6: Verify**

Run:
```bash
npm test
node scripts/orb-shot.mjs idle artifacts/orb-rings-idle.png
node scripts/orb-shot.mjs speaking artifacts/orb-rings-speaking.png
```
Expected: segmented rings + tick ring visible around the core; speaking shot near-white with visibly different ring positions between two consecutive runs (rotation).

- [ ] **Step 7: Commit**

```bash
git add public/voiceOrb.js
git commit -m "feat(orb): instrument rings, tick sprite, tool-call sweep"
```

---

### Task 6: Gimbal cage

**Files:**
- Modify: `public/voiceOrb.js` (new method `_drawGimbal`, constructor state, `_draw` wiring; delete `_drawLimb`)

**Interfaces:**
- Consumes: `this._ringRGB`, `this.reduced`, `this._dt`.
- Produces: `_drawGimbal(front, time, R)` — two-pass (back before core, front after rings), same front/back convention as `_drawOrbitPass(front)`.

- [ ] **Step 1: Gimbal state (constructor)**

```js
// Two hologram gimbal rings: tilt (fixed), precession angle, spin phase.
this._gimbals = [
  { radius: 1.12, tilt: 62 * DEG, prec: 0.6, precSpeed: 0.05, spin: 0, spinSpeed: 0.3 },
  { radius: 1.26, tilt: 74 * DEG, prec: 2.1, precSpeed: -0.035, spin: 0, spinSpeed: -0.22 },
];
```

- [ ] **Step 2: Implement `_drawGimbal`**

For each gimbal, walk 64 samples of a circle of radius `g.radius * R` in its local plane, rotate by tilt around X, then by precession around Y; project orthographically with mild depth scale; stroke only the samples whose depth sign matches the pass. Advance `prec`/`spin` by `_dt` (frozen when `this.reduced`) once per frame — do the advance only in the `front === false` pass so it isn't double-stepped.

```js
_drawGimbal(front, time, R) {
  const ctx = this.ctx;
  const [r, g, b] = this._ringRGB;
  ctx.lineWidth = Math.max(1, R * 0.007);
  for (const gimbal of this._gimbals) {
    if (!front && !this.reduced) {
      gimbal.prec += this._dt * gimbal.precSpeed;
      gimbal.spin += this._dt * gimbal.spinSpeed;
    }
    const tiltCos = Math.cos(gimbal.tilt), tiltSin = Math.sin(gimbal.tilt);
    const precCos = Math.cos(gimbal.prec), precSin = Math.sin(gimbal.prec);
    const radius = gimbal.radius * R;
    // Hologram shimmer: low-alpha flicker along the stroke, frozen when reduced.
    const shimmer = this.reduced ? 0 : 0.08 * Math.sin(time * 9 + gimbal.tilt * 40);
    let penDown = false;
    ctx.strokeStyle = `rgba(${r},${g},${b},${(front ? 0.55 : 0.18) + shimmer})`;
    ctx.beginPath();
    for (let s = 0; s <= 64; s++) {
      const u = gimbal.spin + (s / 64) * TAU;
      const localX = Math.cos(u) * radius, localY = Math.sin(u) * radius;
      // tilt around X:
      const tiltedY = localY * tiltCos, tiltedZ = localY * tiltSin;
      // precession around Y:
      const worldX = localX * precCos + tiltedZ * precSin;
      const worldZ = -localX * precSin + tiltedZ * precCos;
      const visible = front ? worldZ >= 0 : worldZ < 0;
      const scale = 1 + worldZ / (radius * 8); // mild perspective
      if (visible) {
        const screenX = worldX * scale, screenY = tiltedY * scale;
        if (penDown) ctx.lineTo(screenX, screenY);
        else { ctx.moveTo(screenX, screenY); penDown = true; }
      } else {
        penDown = false;
      }
    }
    ctx.stroke();
  }
}
```

- [ ] **Step 3: Wire into `_draw`, delete `_drawLimb`**

Pass order becomes:

```js
this._drawGimbal(false, time, silhouetteRadius);   // back halves
this._drawOrbitPass(false);
this._drawMoonLightPass(false, time, silhouetteRadius);
this._drawCore(time, silhouetteRadius);
this._drawInstrumentRings(time, silhouetteRadius);
this._drawHalos(time, silhouetteRadius);
this._drawGimbal(true, time, silhouetteRadius);    // front halves
this._drawOrbitPass(true);
this._drawMoonLightPass(true, time, silhouetteRadius);
/* moon label passes unchanged (source-over wrapping as today) */
```

Delete `_drawLimb` and its call site (the gimbal silhouette replaces the limb circle).

- [ ] **Step 4: Verify**

Run: `npm test && node scripts/orb-shot.mjs idle artifacts/orb-gimbal.png`
Expected: two tilted ellipses wrapping the reactor; front arcs brighter than back arcs; back arcs pass behind the core disc.

- [ ] **Step 5: Commit**

```bash
git add public/voiceOrb.js
git commit -m "feat(orb): 3D gimbal cage with precession and hologram shimmer"
```

---

### Task 7: Moon HUD restyle + final polish

**Files:**
- Modify: `public/voiceOrb.js` (`_drawMoonLight`, `_drawMoonLabel`)

**Interfaces:**
- Consumes: existing moon state arrays (positions, depth, active flags — reuse whatever `_drawMoonLight` reads today), `this._coreRGB`, `STATE_COLORS.thinking.ring` for running-task gold.
- Produces: final visual. No API change; `moonInfoAt` hit-test radii unchanged.

- [ ] **Step 1: Restyle the moon marker in `_drawMoonLight`**

Keep the existing per-moon screen position/depth/alpha computation. Replace the body-rendering portion (glow blob/disc) with a bracket-diamond glyph. `s` = existing moon screen radius for that moon; `active` = the moon's existing running-task flag (whatever drives today's tail/brightness — reuse it):

```js
// Diamond
const gold = STATE_COLORS.thinking.ring;
const [mr, mg, mb] = active ? gold : this._coreRGB;
const blink = active && !this.reduced ? 0.7 + 0.3 * Math.sin(time * 3) : 1;
ctx.fillStyle = `rgba(${mr},${mg},${mb},${alpha * blink})`;
ctx.beginPath();
ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
ctx.closePath();
ctx.fill();
// Corner brackets at ±1.9s
const bracket = s * 1.9, arm = s * 0.7;
ctx.lineWidth = active ? 1.6 : 1;
ctx.strokeStyle = `rgba(${mr},${mg},${mb},${alpha * (active ? 0.9 : 0.5)})`;
for (const sx of [-1, 1]) {
  ctx.beginPath();
  ctx.moveTo(x + sx * bracket, y - arm);
  ctx.lineTo(x + sx * bracket, y);
  ctx.lineTo(x + sx * bracket, y + arm);
  ctx.stroke();
}
```

- [ ] **Step 2: Restyle orbit path + label**

In `_drawOrbitPass`: reduce stroke alpha to ~40% of current (hairline paths). In `_drawMoonLabel`: add `ctx` letter-spacing via manual per-char spacing only if the current code already draws per-char; otherwise just drop label alpha ~25% and keep the existing mono font. (Do not add `canvas.letterSpacing` — Safari support is inconsistent.)

- [ ] **Step 3: Full state gallery + reduced motion check**

Run:
```bash
npm test
node scripts/orb-shot.mjs idle artifacts/orb-final-idle.png
node scripts/orb-shot.mjs listening artifacts/orb-final-listening.png
node scripts/orb-shot.mjs thinking artifacts/orb-final-thinking.png
node scripts/orb-shot.mjs speaking artifacts/orb-final-speaking.png
```
Expected: four distinct states per the spec palette table. Then reduced motion: relaunch `orb-shot` after `page.emulateMedia({ reducedMotion: "reduce" })` (add a `REDUCED=1` env branch in the harness if needed) — colors present, two consecutive screenshots identical.

- [ ] **Step 4: Dead-code sweep**

Run: `grep -n "EARTH\|_dot\|plexus\|Plexus\|nebula\|Nebula\|DataArc\|dataArc\|MoonTail\|Scan\|Cage" public/voiceOrb.js`
Expected: no hits (or only comments you deliberately kept). Delete any stragglers, re-run `npm test`.

- [ ] **Step 5: Commit**

```bash
git add public/voiceOrb.js
git commit -m "feat(orb): HUD moon markers, hairline orbits, final reactor assembly"
```

---

## Post-implementation (Claude, not Codex)

- `graphify update .` to refresh the knowledge graph.
- Relaunch the desktop app for the user's live eyeball check (rotation smoothness, state transitions, reduced motion).
- User verdict → merge decision for `fix/tool-calling-reliability`.
