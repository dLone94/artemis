# Full ops redesign — the JARVIS dashboard (user's prompt, verbatim basis)

**Status:** user-approved full redesign; incremental staging rejected.
Codex quota out — Claude builds, chromium-render verification each step.

## Hard requirements (from the user's prompt)

- 12-col CSS grid, gap 16, dark navy radial background (#050a1a→#0a1230),
  dot-grid texture ~4% opacity.
- Palette: electric blue #3b82f6, cyan #22d3ee, violet #a78bfa/#c084fc
  sparingly. Everything glows softly (0 0 12px rgba(34,211,238,.35)).
- Type: Orbitron/Rajdhani condensed uppercase headings letter-spaced;
  numbers 28-40px glowing cyan-white heroes.
- Center hero: the existing particle globe (retinted electric blue/cyan,
  ~60s/rev rotation, arcs stay) over a glowing platform ring.
- 10-14 stat panels in top row + two side columns: real-data versions of
  the reference (brain chain, per-model token bars, CPU/MEM/RESPONSE
  sparklines, mail, reminders, radar age, followups, usage, uptime,
  skills online). Panels: rgba(10,20,45,.55), blur 8, 1px
  rgba(56,189,248,.35) border, radius 10, L-bracket corners, label
  top-left 11px cyan spaced, hero number, delta badge, mini chart.
- Motion: slow ambient only; count-up on load; sparkline draw-in; faint
  sweep every ~8s; prefers-reduced-motion respected.
- Data honesty overrides the prompt's "fake data": every panel binds to
  /api/telemetry or reads "—" dimmed.

## Implementation map

1. `public/ops.css` (new, loaded AFTER cockpit.css): converts body.cockpit
   to the grid (body { display:grid; grid-template-columns:repeat(12,1fr);
   grid-auto-rows:min-content; }), overrides the fixed-position layout of
   .hud-top/.hud-left/.hud-right/.dock/.scene-stage/.ops-panel into grid
   areas: header row 1 span 12; top stat row (4 panels) row 2; left col
   span 3 rows 3-5 (log, gauges+telemetry); hero center span 6 rows 3-5
   (sceneStage relative, pedestal inside); right col span 3 (context
   cards, signals); bottom stat row; dock last row span 12. hud-state and
   tool orb absolute within hero cell. Backdrop = navy gradient + dot grid.
2. `public/statPanels.js`: render INTO grid cells (no fixed pos), expand
   to 10 panels incl. TOKEN BUDGETS per-model bars from /api/telemetry
   brain.chain + budget, RADAR age, FOLLOWUPS, UPTIME, SKILLS 19 ONLINE;
   count-up animation on first paint; 8s sweep via CSS class.
3. `public/orbShared.js` PAL retint: O → rgba(59,130,246 (electric blue),
   B stays cyan-bright, keep V. voiceOrb rotation period → 60s
   (find ROTATION/spin constant). Globe must size to its grid cell
   (VoiceOrb already sizes to container).
4. Boot/wordmark/dock keep IDs; only geometry moves. ALL functional IDs
   preserved: sceneStage cmdLog hudGauges hudTelemetry ctxCards hudState
   hudToolOrb boot hudDots hudClock hudModel hudTtfw hudWave micToggle
   wakeToggle followUpToggle ambientToggle musicToggle mailWatchToggle
   bargeToggle explainBtn agentsBtn voiceSelect toneSelect cmdForm
   cmdInput liveStatus dock.
5. Verify: chromium render at 1680x1000 AND 1440x900 after each phase;
   npm test; single app instance relaunch with cache-busted URLs.
