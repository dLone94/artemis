# DASHBOARD V2 — hub-and-spoke full redesign (user spec, near-verbatim)

Guard: build behind a layout flag DASHBOARD_V2 — v2 is default; ?v1 (and a
persisted localStorage escape hatch) restores the current grid layout
untouched. Nothing about data sources, command log, voice pipeline,
control pills, or voice/tone dropdowns may change functionally.
Reference: aetune-reference.png at repo root — study before coding.

COMPOSITION: square-ish center stage, panels AROUND a central hub with
routed connector lines — not a uniform grid.

1 HEADER: "ARTEMIS OS" large centered, subtitle "PERSONAL VOICE AGENT"
  cyan, status dots row (BRAIN VOICE WEB MAIL) beneath; clock + model
  top-right; ABOUT top-right corner.
2 CENTER HUB: existing 4-layer plexus globe inside a glowing ring frame:
  outer thin dashed ring rotating cw ~90s, inner solid ring with
  counter-rotating dashes ~60s; 4 circle nodes at N/S/E/W spoke
  attachment points; ARTEMIS wordmark stays.
3 FOUR SUBSYSTEM PANELS at corners, octagonal double borders (outer 1px
  cyan .5, inner 1px cyan .2, 6px inset, cut corners, corner brackets):
  TL "SYSTEM": load % + avg, memory % + bar, both sparklines, wireframe-
     sphere motif left slot. TR "NEURAL CHAIN": chain count, primary
     model, 5 slot bars, response sparkline, TTFW. BL "COMMS" (taller):
     command log w/ timestamps+speakers scrolling, mic level, wake
     state. BR "CONTEXT & MEMORY": today, usage/free tier, systems,
     token budgets, signals, uptime.
4 SPOKES hub→panels: right-angle routes, circle nodes at bends/ends,
  arrowheads at panel end; activity pulse (log line → COMMS spoke; turn
  complete → NEURAL spoke); idle heartbeat every ~8s staggered.
5 SKILLS BAND under hub: "19 SKILLS ONLINE · 18 SPECIALISTS" (live
  counts per data-honesty), icon-in-double-ring row BRIEF RADAR PLAN
  RESEARCH MEDIA MESSAGES SCHOOL FINANCE FOLLOW-UPS; executing skill =
  bright rotating ring (wire to tool SSE events); hover glow + tooltip;
  icons only, no thumbnails.
6 BOTTOM COMMAND BAR: everything from the current voice bar in one
  full-width octagonal strip, items separated by small arrow glyphs.

JARVIS MOTION: boot draw-in (border traces ~400ms staggered, spokes draw
outward, rings spin up, numbers count up; total <2.5s); radar sweep line
inside hub outer ring ~20s/rev 5%; corner-bracket flicker on one random
panel ~15s subtle; dot-grid parallax drift ~1px/s; ALL under
prefers-reduced-motion (boot skipped, static); perf guard: drop flicker
+ parallax first, never data.

DISCIPLINE: palette/fonts/glow tokens unchanged; data honesty +
placeholder states as built. DONE = self-render 2560x1440 AND 1440x900,
self-compare vs aetune-reference.png, list 3 biggest composition
differences; confirm log scrolls and dropdowns work.
