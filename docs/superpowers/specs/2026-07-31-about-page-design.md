# ABOUT page — hub-and-spoke architecture diagram (user spec, near-verbatim)

Reference: aetune-reference.png at repo root (study framing before coding).
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
  BRAIN top-left "Reasoning Core": model name (LIVE), neural chain (5
  models), context memory, tool routing — visual mini plexus cluster.
  VOICE top-right "Speech Pipeline": ElevenLabs TTS, Deepgram STT, wake
  word, talk-over — visual waveform.
  MAIL & SIGNALS bottom-left "Watchers": mail watch, signals, follow-ups,
  daily brief — visual radar sweep.
  MEMORY bottom-right "Persistence": notes, token budgets, session log,
  usage tracking — visual stacked bars.
4 SKILLS band: "19 SKILLS ONLINE · 18 SPECIALISTS" (LIVE counts), then
  icon-rings: BRIEF RADAR PLAN RESEARCH MEDIA MESSAGES SCHOOL FINANCE
  FOLLOW-UPS — icon in double ring, label under, hover glow + one-line
  tooltip (reuse MOON_INFO descriptions).
5 Bottom flow strip: VOICE hears it → BRAIN reasons → SKILLS act →
  MAIL/WEB reach out → MEMORY remembers.

DATA HONESTY: live values from the same state the dashboard uses
(/api/status, /api/telemetry, /api/agents, MOON_INFO import) — no strings
that rot. Disconnected subsystem: border dims to 40%, status dot grey.

MOTION: line pulses, hub ring slow rotation, hover glows — all off under
prefers-reduced-motion. Page must read complete as a static screenshot.

FIT: single viewport height desktop, stack on narrow. Same route/app —
client-side toggle: top-bar ABOUT becomes the toggle (no navigation to
about.html); back link returns to dashboard. Zero new dependencies —
"lucide" icons become minimal inline SVG equivalents drawn by hand.
