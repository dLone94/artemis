# ABOUT page — hub-and-spoke architecture diagram

Reference: `aetune-reference.png` at repo root. Preserve its information
hierarchy rather than its portrait proportions: dominant system name, central
hub, routed architecture, capability taxonomy, then a causal flow strip.
Theme: same as dashboard — dark navy, cyan/violet 90/10, Orbitron/Rajdhani,
reuse existing background (gradient + dot grid).

STEAL from reference: octagonal cut-corner panels with DOUBLE borders
(outer 1px bright cyan, inner 1px 30% opacity, 6px apart) + corner
brackets; right-angle routed connector lines 1px cyan 0.4 with circle
nodes at bends/ends and direction arrowheads, a slow pulse traveling each
line every ~6s staggered; central hub = glowing ring + plexus-mini;
icon-in-ring rows with labels; bottom flow strip icon→label→arrow. SKIP
the snow-globe orbs entirely.

LAYOUT top→bottom:
1 Header "ARTEMIS OS" large, subtitle "Personal Voice Agent",
  back-to-dashboard link top-left.
2 Center hub circular emblem ~180px (plexus sphere style, ARTEMIS
  wordmark, glow ring), spokes to four corner panels, arrows outward.
3 Four subsystem panels (small visual left + 3-4 item icon list right):
  BRAIN top-left "Reasoning Core": active model (LIVE), fallback chain
  (LIVE list/count from `telemetry.brain.chain`), context memory, tool routing
  — visual mini plexus cluster.
  VOICE top-right "Speech Pipeline": active TTS provider (LIVE), Deepgram
  STT state, active wake phrase/state, talk-over — visual waveform.
  MAIL & SIGNALS bottom-left "Watchers": mail watch, signals, follow-ups,
  daily brief — visual radar sweep.
  MEMORY bottom-right "Persistence": notes, token budgets, session log,
  usage tracking — visual stacked bars.
4 SKILLS band: "{MOON_INFO.length} SKILLS ONLINE · {agents.length}
  SPECIALISTS" (LIVE counts; currently 11 and 19), then a curated nine-skill
  subset of the 11 user-facing skills:
  icon-rings: BRIEF RADAR PLAN RESEARCH MEDIA MESSAGES SCHOOL FINANCE
  FOLLOW-UPS — icon in double ring, label under, hover glow + one-line
  tooltip (reuse MOON_INFO descriptions).
5 Bottom flow strip: VOICE hears it → BRAIN reasons → SKILLS act →
  MAIL & WEB reach out → MEMORY remembers.

DATA HONESTY: fetch the same state the dashboard uses (`/api/status`,
`/api/telemetry`, `/api/agents`, and the `MOON_INFO` import), independently
with `cache: "no-store"`, so one slow/failed source cannot suppress the other
two. Omitted telemetry means `—`/`UNAVAILABLE`, never zero. Agent-fetch failure
means `— SPECIALISTS`, never zero specialists. Map health and values as follows:

- BRAIN: `status.chatEnabled`; use `telemetry.brain.name` as the active model
  only when `status.llmProvider` confirms a Groq/NVIDIA-compatible provider
  (so a benched primary can show its real fallback). Otherwise the authoritative
  configured model is `status.llmModel`. The fallback chain still comes from
  `telemetry.brain.chain`; do not label `telemetry.brain.name` as active in
  Anthropic mode because that telemetry helper can fall back to NVIDIA metadata.
  If status is unavailable or still pending, show no active-model claim (`—`)
  even when telemetry has already returned; the chain may still render as
  configured routing data.
- VOICE: the selected TTS provider comes from the existing `#voiceSelect`
  value (ElevenLabs, Edge, or Deepgram); `/api/status` supplies backend
  availability, not the user's active selection. Edge is only available when
  `status.voiceEnabled` is true because the current `/api/tts` entry guard
  rejects all providers when no voice backend is enabled. Wake ON/OFF mirrors
  `#wakeToggle`, while `localWake` describes on-device profile readiness.
  `sttEnabled` remains the Deepgram STT health field. Talk-over mirrors the
  existing `#bargeToggle`; neither wake ON/OFF nor talk-over is an API field.
- MAIL & SIGNALS: mail uses `gmailEnabled`; web/signals uses `webEnabled`;
  mail-watch mirrors `#mailWatchToggle`. Follow-ups and daily brief are fixed
  capability labels backed by their `MOON_INFO` entries, not measured health.
- MEMORY: use `notesCount`, `usage`, optional `telemetry.budget`, and the
  existing command-log entry count. There is no `memoryEnabled` field.
- SKILLS: use `MOON_INFO.length`; SPECIALISTS uses `agents.length` after a
  successful `/api/agents` response. Roster availability does not imply that
  the brain is connected.

Disconnected or mixed capability state is shown row by row with a grey dot
and visible `OFFLINE`/`UNAVAILABLE` wording; color is never the only cue. Dim
the decorative border/glow to 40%, not the panel text. Only dim a whole panel's
frame when its endpoint failed or every mapped capability is unavailable.

MOTION: line pulses, hub ring slow rotation, hover glows — all off under
`prefers-reduced-motion`. Base connector paths, nodes, arrowheads, hub, and all
content stay visible without animation; entrance motion never gates content.
Also pause about motion while the view is closed/hidden.

FIT: the 1680×1000 desktop composition fits within one `100dvh` viewport. On
narrow or short screens the fixed view itself scrolls, panels stack, skills
wrap, and the connector overlay hides or is deliberately rerouted rather than
pointing at moved targets. Same route/app — client-side toggle: top-bar ABOUT
becomes the toggle (no navigation to `about.html`); back link returns to the
dashboard. Zero new dependencies — "lucide" icons become consistent minimal
24×24 geometric inline SVG equivalents drawn by hand (not sketch-style art).

## Mounting and interaction contract

- `aboutPage.js` builds `#aboutView` exactly once, lazily on first open. Before
  that there is no about DOM, polling, or animation.
- Because `body.cockpit` is a 12-column CSS grid with `overflow: hidden`, the
  view is a grid-escaping overlay: `position: fixed; inset: 0; z-index: 100;
  overflow-y: auto`, with its own opaque-enough navy/dot backdrop. Existing
  skills and boot overlays are z-index 80 and 90 respectively.
- Change the existing top-bar ABOUT anchor to `href="#about"` and wire it as a
  toggle with `aria-controls`/`aria-expanded`. Auto-open when the initial hash
  is `#about`; browser back/forward, Escape, and the in-view back link close it
  without reload and without dropping `location.search` (including `?key=`).
- Treat the view as a labelled modal/page surface: focus the back control on
  open, make the obscured dashboard inert, trap focus, restore focus to ABOUT
  on close, and handle Escape in capture phase so existing cockpit Escape
  handlers do not also fire. Provide visible `:focus-visible` treatment and a
  minimum 44×44px back-control hit area. Tooltips must work on focus as well as
  hover and remain represented in the accessibility tree.
- Preserve every existing functional ID and leave `about.html` untouched. New
  selectors and keyframes are namespaced `about-*` to avoid the cockpit's
  global animation names.

## Static asset contract

Link `about-ops.css` after `ops.css` and load `aboutPage.js` as a direct module
script in `index.html`, using literal queryless double-quoted `href`/`src`
values. `serveStatic` appends its cache-busting `?v=` token to direct HTML
assets and also serves static responses with `no-store`; do not hand-add a
query string that bypasses the rewriter.

## Audit corrections (2026-07-31)

- Replaced the stale `19 skills · 18 specialists` copy with dynamic counts
  (`MOON_INFO.length`, `agents.length`; currently 11 · 19).
- Replaced fixed five-model and ElevenLabs claims with the actual telemetry and
  status/client-control fields, and made `status.llmModel` authoritative in
  Anthropic mode.
- Defined partial-failure and row-level dimming rules for panels that have no
  single backend connectivity flag.
- Added the fixed-overlay/grid escape, lazy mount, hash/history, focus,
  accessibility, responsive, reduced-motion, namespacing, and cache-busted
  static-loading requirements discovered in the codebase audit.
