// ARTEMIS cockpit controller — the HUD around the voice pipeline.
// main.js emits events through window.ArtemisHUD (guarded, so the landing and
// brain pages work without this file); this module renders them: boot sequence,
// command log, context cards, status-bar telemetry, live waveform, state
// choreography and subtle UI ticks. All motion honors prefers-reduced-motion.

import { prefersReducedMotion } from "./orbShared.js";

const reduced = prefersReducedMotion();
const $ = (id) => document.getElementById(id);

/* ---------------- boot sequence ---------------- */
// 1.6s of "ARTEMIS OS initializing" — pure theater, skipped under reduced
// motion (CSS hides .boot entirely) and dismissible with a click.
(function boot() {
  const el = $("boot");
  const lines = $("bootLines");
  if (!el || !lines || reduced) { el && el.remove(); return; }
  const SCRIPT = [
    "ARTEMIS OS v2.1",
    "› voice pipeline ........ ✓",
    "› brain (NVIDIA NIM) .... ✓",
    "› tools registry ........ ✓",
    "› memory ................ ✓",
    "",
    "Good evening, sir.",
  ];
  let i = 0;
  const step = () => {
    if (i < SCRIPT.length) {
      lines.textContent += SCRIPT[i] + "\n";
      i += 1;
      setTimeout(step, i === 1 ? 340 : 190);
    } else {
      setTimeout(dismiss, 420);
    }
  };
  const dismiss = () => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 550);
  };
  el.addEventListener("click", dismiss); // impatient? tap through
  setTimeout(step, 120);
})();

/* ---------------- status bar: clock + subsystem dots ---------------- */
(function statusBar() {
  const clock = $("hudClock");
  const tick = () => { clock.textContent = new Date().toTimeString().slice(0, 8); };
  tick();
  setInterval(tick, 1000);

  fetch("/api/status")
    .then((r) => r.json())
    .then((s) => {
      const set = (sys, on) => {
        const d = document.querySelector(`.hud-dot[data-sys="${sys}"]`);
        if (d) d.classList.add(on ? "on" : "off");
      };
      set("brain", s.chatEnabled);
      set("voice", s.voiceEnabled);
      set("web", s.webEnabled);
      set("gmail", s.gmailEnabled);
    })
    .catch(() => {});
})();

/* ---------------- command log + context cards ---------------- */
const logEl = $("cmdLog");
const cardsEl = $("ctxCards");
const emptyCard = document.createElement("div");
emptyCard.className = "hud-empty";
emptyCard.textContent = "sources, actions and confirmations appear here";
cardsEl.appendChild(emptyCard);

const stamp = () => new Date().toTimeString().slice(0, 8);

function addLine(kind, text) {
  const div = document.createElement("div");
  div.className = "hud-line";
  div.dataset.kind = kind;
  const label = { you: "YOU", artemis: "ARTEMIS", tool: "TOOL", action: "ACTION", status: "SYS", error: "ERROR", confirm: "CONFIRM" }[kind] || kind.toUpperCase();
  div.innerHTML = '<span class="t"></span><span class="k"></span><span class="m"></span>';
  div.querySelector(".t").textContent = stamp();
  div.querySelector(".k").textContent = label;
  div.querySelector(".m").textContent = String(text || "");
  logEl.appendChild(div);
  requestAnimationFrame(() => div.classList.add("shown"));
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild); // bounded
  logEl.scrollTo({ top: logEl.scrollHeight, behavior: reduced ? "auto" : "smooth" });
}

function addCard(card) {
  if (emptyCard.parentNode) emptyCard.remove();
  const div = document.createElement("div");
  div.className = "hud-card";
  const title = document.createElement("div");
  title.className = "hud-card-title";
  title.textContent = card.title || "CONTEXT";
  div.appendChild(title);
  (card.links || []).forEach((l) => {
    const a = document.createElement("a");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = l.title || l.url;
    div.appendChild(a);
  });
  (card.lines || []).forEach((t) => {
    const p = document.createElement("p");
    p.textContent = t;
    div.appendChild(p);
  });
  cardsEl.prepend(div);
  requestAnimationFrame(() => div.classList.add("shown"));
  while (cardsEl.children.length > 12) cardsEl.removeChild(cardsEl.lastChild);
}

/* ---------------- subtle UI tick on state changes ---------------- */
// Uses the orb's AudioContext (only exists after a user gesture, so this can
// never fire an autoplay warning). Deliberately tiny — a whisper, not a beep.
function uiTick(freq) {
  if (reduced) return;
  try {
    const c = window.__orb && window.__orb.audioCtx;
    if (!c || c.state !== "running") return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.018, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.07);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.08);
  } catch (e) {}
}
const STATE_TONES = { listening: 920, thinking: 640, executing: 760, speaking: 540, error: 240 };

/* ---------------- the HUD bus (main.js talks to us through this) ---------------- */
let lastState = "idle";
window.ArtemisHUD = {
  log: addLine,
  context: addCard,
  ttfw(ms) {
    const el = $("hudTtfw");
    if (el && ms > 0) el.textContent = "TTFW " + (ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms");
  },
  state(s) {
    if (s === lastState) return;
    lastState = s;
    document.body.dataset.aiState = s;
    if (STATE_TONES[s]) uiTick(STATE_TONES[s]);
  },
};

/* ---------------- live waveform strip ---------------- */
// Driven by the REAL voice amplitude the orb publishes (window.__artemisAmp):
// your mic while listening, her synthetic speech envelope while speaking.
(function waveform() {
  const cv = $("hudWave");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const fit = () => {
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
    cv.height = Math.round(36 * dpr);
  };
  fit();
  window.addEventListener("resize", fit);

  const N = 140;
  const buf = new Float32Array(N);
  let head = 0;

  function draw() {
    const W = cv.width, H = cv.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    const bw = W / N;
    for (let i = 0; i < N; i++) {
      const v = buf[(head + i) % N];
      const h = Math.max(1.5 * dpr, v * (H * 0.92));
      const a = 0.18 + v * 0.8;
      ctx.fillStyle = "rgba(255,178,77," + a.toFixed(3) + ")";
      ctx.fillRect(i * bw, mid - h / 2, Math.max(1, bw - 1.2 * dpr), h);
    }
  }
  if (reduced) {
    draw(); // one static baseline — no live animation
    return;
  }
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    buf[head] = Math.min(1, (typeof window.__artemisAmp === "number" ? window.__artemisAmp : 0));
    head = (head + 1) % N;
    draw();
  })();
})();

/* ---------------- opening line in the log ---------------- */
addLine("status", "systems online — say “Artemis”, tap the mic, or ask “what can I do?”");
