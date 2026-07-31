# DASHBOARD V2 — hub-and-spoke full redesign (corrected after code audit)

Guard: build behind a body-level `dashboard-v2` layout flag — v2 is default;
`?v1` or `localStorage.artemisDashboardLayout === "v1"` restores the current
grid layout untouched. `?v2` overrides the persisted escape hatch for recovery.
The v1 branch performs zero DOM reparenting; `ops.css` stays unchanged and every
v2 selector is scoped under `body.dashboard-v2`. Nothing about data sources,
command log, voice pipeline, control pills, or voice/tone dropdowns may change
functionally. When `?key=` establishes the access cookie, the server redirect
must remove only the secret `key` parameter and preserve safe layout parameters
such as `v1`/`v2`; otherwise the remote-access gate makes the escape hatch
unreachable on first load.

Reference: `aetune-reference.png` at repo root — use its dominant hub, short
orthogonal routes, quiet peripheral frames, and negative space as composition
anchors rather than copying its thumbnails or decorative data.

RUNTIME CONTRACT: preserve and move the existing nodes, never clone them. All
39 static ids in `public/index.html` remain unique through v2 composition and
every functional id remains in the live DOM. The existing boot cleanup may
remove only its three decorative/transient roots (`#boot`, `#bootLines`, and
`#hudParticles`) after initialization. In particular,
`#sceneStage`, `#micToggle`, `#wakeToggle`, `#hudClock`, `#cmdLog`, and
`#ctxCards` are crash-critical; `#hudGauges` is also the sole publisher of the
`artemis-telemetry` browser event. Keep the existing inline
`mountOpsWall`/`DOMContentLoaded` mount exactly once, then reparent its eight
generated `ops*` roots. `mountOpsWall()` is not idempotent and must never be
called again by v2. At <=1500px, v2 explicitly restores all reparented panels
that the v1 responsive rule hides.

COMPOSITION: square-ish center stage, panels AROUND a central hub with routed
connector lines — not a uniform grid.

1 HEADER: "ARTEMIS OS" large centered, subtitle "PERSONAL VOICE AGENT" cyan,
  status dots row (BRAIN VOICE WEB MAIL) beneath; clock + model top-right;
  ABOUT remains in the top-right navigation.
2 CENTER HUB: existing 4-layer plexus globe inside a glowing ring frame.
  `VoiceOrb` opts into sizing from `#sceneStage` only when `dashboard-v2` is
  active so the canvas stays circular and moon hit-testing remains in the same
  host coordinate space; all other pages/layouts keep viewport sizing. Outer
  thin dashed ring rotates clockwise ~90s; inner solid ring has a
  counter-rotating dashed overlay ~60s; 4 static circle nodes sit at N/S/E/W
  spoke attachment points; ARTEMIS wordmark stays. A 5% radar sweep travels
  inside the outer ring at ~20s/rev.
3 FOUR SUBSYSTEM PANELS at corners, octagonal double borders (outer 1px cyan
  .5, inner 1px cyan .2, 6px inset, cut corners, corner brackets):
  TL "SYSTEM": `#opsCpu` + `#opsMem` for load %, avg, memory %, bar, and both
     sparklines, with a new wireframe-sphere motif in the left slot.
  TR "NEURAL CHAIN": `#opsBrain` + `#opsTtfw` for chain count, primary model,
     5 slot bars, response sparkline, and TTFW; retain `#hudTtfw` in the header.
  BL "COMMS" (taller): existing `.hud-left`, including scrolling `#cmdLog`,
     `#hudGauges`, `#hudTelemetry`, mic level, and wake state.
  BR "CONTEXT & MEMORY": existing `.hud-right/#ctxCards` plus `#opsTokens`,
     `#opsCounts`, `#opsUp`, and `#opsSkills` for today, usage/free tier,
     systems, token budgets, signals, and uptime.
4 SPOKES hub→panels: right-angle routes, circle nodes at bends/ends,
  arrowheads at panel end; activity pulse (log line → COMMS spoke; turn
  complete → NEURAL spoke); idle heartbeat every ~8s staggered.
5 SKILLS BAND under hub: summary is derived from the existing sources of truth:
  `${MOON_INFO.length} SKILLS ONLINE` (currently 11 capability domains) and
  `/api/agents`.agents.length (currently 19 specialists), with CONNECTING/—
  fallback rather than stale numbers. Use all 11 MOON_INFO domains so every
  canonical tool family has an honest visible target: BRIEF RADAR PLAN RESEARCH
  MAIL MEDIA MESSAGES MEMORY SCHOOL FINANCE FOLLOW-UPS. Icon-in-double-ring
  row; executing skill = bright rotating ring; hover/focus glow + tooltip;
  icons only, no thumbnails. Family aliases are semantic and explicit:
  research/web→RESEARCH, email→MAIL, messages/message/contacts→MESSAGES,
  media/navigate→MEDIA, memory/notes/reminder/meeting→MEMORY,
  briefing→BRIEF, followups/followups_nudge→FOLLOW-UPS,
  map/map_update→PLAN, radar/radar_update→RADAR, plus direct FINANCE and SCHOOL.
6 BOTTOM COMMAND BAR: move the existing `#dock` whole. "One strip" means one
  full-width octagonal outer container. At 1440px it may use two compact
  internal rows/wrapping so every control, waveform, status, command input, and
  both selects remains visible and usable; hide nothing to force a literal
  single row. Small arrow glyphs separate control groups.

ACTIVITY CONTRACT: retain the one server SSE stream. At the existing
`main.js` tool forwarding point (`ArtemisHUD.tool(data)` +
`orb.toolEvent(data)`), also dispatch `artemis-tool` with the unchanged
`{name,family,phase,ok?}` payload; `dashboardV2.js` consumes that event for the
skill ring and spoke pulses. Observe additions to `#cmdLog`: any new log line
pulses COMMS and a new `data-kind="artemis"` line is the existing, honest
turn-complete signal for NEURAL. `artemis-telemetry` pulses SYSTEM/CONTEXT and
continues to drive the existing renderers. Do not add a second EventSource or
duplicate tool-family routing on the server.

PANEL SKIN: the new double-octagonal subsystem wrapper is the sole frame.
Remove rounded/glass/border/shadow skins from reparented inner `.ops-panel`,
log, gauge, telemetry, and context-card blocks; retain their data, semantics,
scrolling, placeholder states, and renderers.

JARVIS MOTION: boot draw-in begins from the existing `body.hud-in` gate so it
does not finish behind the cockpit boot overlay: border traces ~400ms staggered,
spokes draw outward, rings spin up, and existing numbers count up; total <2.5s.
Corner-bracket flicker touches one random panel ~15s, subtly; dot-grid drift is
~1px/s. Disable the legacy inline panel `translate` parallax in v2 so panels
cannot detach from SVG endpoints. ALL motion is under `prefers-reduced-motion`
(boot skipped, static). The performance guard drops flicker + dot drift first,
never data or functional renderers.

CACHE CONTRACT: add bare query-free `href="ops2.css"` and
`src="dashboardV2.js"` references so the HTML rewriter stamps them. The stamp
must be derived from public HTML/CSS/JS mtimes separately from the backend
process fingerprint; frontend-only changes must produce a new asset URL without
incorrectly marking the live Node process stale.

DISCIPLINE: palette/fonts/glow tokens unchanged; data honesty + placeholder
states as built. DONE = self-render 2560x1440 AND 1440x900, self-compare vs
`aetune-reference.png`, list 3 biggest composition differences; render `?v1`
to prove the untouched fallback; confirm unique ids, no browser console errors,
log scrolling, and both dropdowns work.
