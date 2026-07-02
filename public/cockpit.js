// ARTEMIS cockpit controller — the HUD around the voice pipeline.
// main.js emits events through window.ArtemisHUD (guarded, so the landing and
// brain pages work without this file); this module renders them: boot sequence,
// command log, context cards, status-bar telemetry, live waveform, state
// choreography and subtle UI ticks. All motion honors prefers-reduced-motion.

import { prefersReducedMotion } from "./orbShared.js";

const reduced = prefersReducedMotion();
const $ = (id) => document.getElementById(id);

/* ---------------- boot sequence + welcome briefing ---------------- */
// "ARTEMIS OS initializing…" then TAP TO ENTER — that tap is the user gesture
// that unlocks audio, so she can greet you ALOUD with the morning briefing
// (fetched in parallel during the boot; cached 30 min server-side). Reduced
// motion: no boot, briefing lands silently in the log + context panel.
const briefingP = fetch("/api/briefing").then((r) => r.json()).catch(() => null);

// She greets you and ASKS first — the news only plays on your "yes" (spoken
// into the mic / wake word, handled in main.js via window.__pendingBriefing)
// or a ▶ tap on the card. No unprompted monologue.
function deliverBriefing(spoken) {
  briefingP.then((b) => {
    if (!b) return;
    if (spoken && b.news && window.ArtemisSpeak) {
      const ask = b.greeting + " " + b.offer;
      window.__pendingBriefing = b.news; // a bare "yes" within the next turn plays it
      addLine("artemis", ask);
      addCard({ title: "BRIEFING READY", lines: ["say “yes” — or tap play"], playText: b.news });
      window.ArtemisSpeak(ask);
    } else if (b.news) {
      // silent entry (no gesture) — text only, still one tap away from audio
      addLine("artemis", b.news);
      addCard({ title: "BRIEFING", lines: [b.news], playText: b.news });
    } else if (spoken && window.ArtemisSpeak) {
      addLine("artemis", b.greeting);
      window.ArtemisSpeak(b.greeting + " All systems are online.");
    }
  });
}

(function boot() {
  const el = $("boot");
  const lines = $("bootLines");
  const enterHud = () => document.body.classList.add("hud-in"); // panels assemble
  if (!el || !lines || reduced) {
    el && el.remove();
    enterHud();
    deliverBriefing(false); // no gesture → text only, never blocked audio
    return;
  }
  const SCRIPT = [
    "ARTEMIS OS v2.1",
    "› voice pipeline ........ ✓",
    "› brain (NVIDIA NIM) .... ✓",
    "› tools registry ........ ✓",
    "› memory ................ ✓",
    "",
    "▸ TAP TO ENTER",
  ];
  let i = 0;
  const step = () => {
    if (i < SCRIPT.length) {
      lines.textContent += SCRIPT[i] + "\n";
      i += 1;
      setTimeout(step, i === 1 ? 340 : 170);
    }
    // then wait for the tap — it doubles as the audio-unlock gesture
  };
  let entered = false;
  const dismiss = (spoken) => {
    if (entered) return; // exactly one entry (tap vs 12s fallback race)
    entered = true;
    el.classList.add("done");
    setTimeout(() => el.remove(), 550);
    enterHud();
    deliverBriefing(spoken);
  };
  el.addEventListener("click", () => dismiss(true)); // gesture → she speaks
  // safety: if the user never taps, enter silently after 30s (no gesture, no audio)
  setTimeout(() => dismiss(false), 30000);
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
  if (card.playText) {
    // ▶ plays the held text aloud (the click IS the audio-unlock gesture)
    const b = document.createElement("button");
    b.className = "hud-card-play";
    b.type = "button";
    b.textContent = "▶ PLAY";
    b.addEventListener("click", () => {
      window.__pendingBriefing = null; // answered by tap instead of voice
      addLine("artemis", card.playText.length > 120 ? card.playText.slice(0, 117) + "…" : card.playText);
      if (window.ArtemisSpeak) window.ArtemisSpeak(card.playText);
      b.remove();
    });
    div.appendChild(b);
  }
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
const STATE_LABEL = { idle: "STANDBY", listening: "LISTENING", thinking: "PROCESSING", executing: "EXECUTING", speaking: "SPEAKING", error: "FAULT" };
// TTFW counts UP live while she works, then freezes at the real measured value
let ttfwTimer = 0;
function ttfwCounting(on) {
  const el = $("hudTtfw");
  if (!el || reduced) return;
  clearInterval(ttfwTimer);
  if (!on) { ttfwTimer = 0; return; }
  const t0 = performance.now();
  ttfwTimer = setInterval(() => { el.textContent = "TTFW " + ((performance.now() - t0) / 1000).toFixed(2) + "s"; }, 90);
}
// pulse the matching subsystem dot when its tool runs
const TOOL_SYS = { web_search: "web", fetch_page: "web", web_research: "web", check_email: "gmail", read_email: "gmail", play_media: "web" };
function pulseDot(sys) {
  const d = document.querySelector(`.hud-dot[data-sys="${sys}"]`);
  if (!d) return;
  d.classList.remove("pulse");
  void d.offsetWidth; // restart the animation
  d.classList.add("pulse");
}

let lastState = "idle";
window.ArtemisHUD = {
  log(kind, text) {
    addLine(kind, text);
    if (kind === "tool") {
      const sys = TOOL_SYS[String(text).replace(/\s*✓\s*$/, "")];
      if (sys) pulseDot(sys);
    }
  },
  context: addCard,
  ttfw(ms) {
    ttfwCounting(false);
    const el = $("hudTtfw");
    if (el && ms > 0) el.textContent = "TTFW " + (ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms");
  },
  state(s) {
    if (s === lastState) return;
    lastState = s;
    document.body.dataset.aiState = s;
    const st = $("hudState");
    if (st) st.innerHTML = "<i></i> " + (STATE_LABEL[s] || s.toUpperCase());
    if (s === "thinking") ttfwCounting(true);
    if (s === "speaking" || s === "idle" || s === "error") ttfwCounting(false);
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

/* ---------------- annotation / instrument ring around the orb ---------------- */
// The Iron-Man signature: a thin rotating ring of ticks + degree numbers that
// annotates the orb. Rotation speed follows the AI state; static under reduce.
(function instrumentRing() {
  const cv = $("hudRing");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const fit = () => {
    const size = cv.clientWidth || 620;
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
  };
  fit();
  window.addEventListener("resize", fit);
  let rot = 0;
  let last = performance.now();
  function draw(now) {
    const W = cv.width, c = W / 2;
    const R = c - 10 * dpr;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = document.body.dataset.aiState;
    const speed = s === "thinking" || s === "executing" ? 0.5 : s === "listening" ? 0.22 : 0.08;
    rot += dt * speed;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.translate(c, c);
    // outer thin ring
    ctx.strokeStyle = "rgba(255,178,77,0.22)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    // rotating tick ring
    ctx.save(); ctx.rotate(rot);
    for (let i = 0; i < 72; i++) {
      const maj = i % 6 === 0;
      const a = (i / 72) * Math.PI * 2;
      ctx.strokeStyle = maj ? "rgba(255,178,77,0.5)" : "rgba(255,178,77,0.2)";
      ctx.lineWidth = (maj ? 1.4 : 1) * dpr;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
      ctx.lineTo(Math.cos(a) * (R - (maj ? 10 : 5) * dpr), Math.sin(a) * (R - (maj ? 10 : 5) * dpr));
      ctx.stroke();
    }
    ctx.restore();
    // counter-rotating degree numbers every 30°
    ctx.save(); ctx.rotate(-rot * 0.5);
    ctx.font = 8 * dpr + 'px "JetBrains Mono", monospace';
    ctx.fillStyle = "rgba(138,147,163,0.55)"; // cool dim tone
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let d = 0; d < 360; d += 30) {
      const a = (d / 180) * Math.PI;
      ctx.fillText(String(d).padStart(3, "0"), Math.cos(a) * (R - 22 * dpr), Math.sin(a) * (R - 22 * dpr));
    }
    ctx.restore();
    // dashed inner arc segment sweeping with state
    ctx.strokeStyle = "rgba(255,178,77,0.35)";
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([3 * dpr, 6 * dpr]);
    ctx.beginPath(); ctx.arc(0, 0, R - 32 * dpr, rot * 2, rot * 2 + 1.1); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (reduced) { draw(performance.now()); return; } // one static frame
  (function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    draw(now || performance.now());
  })(performance.now());
})();

/* ---------------- sparse drifting particle field ---------------- */
(function particles() {
  const cv = $("hudParticles");
  if (!cv || reduced) { cv && cv.remove(); return; }
  const ctx = cv.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W, H;
  const fit = () => { W = cv.width = Math.round(innerWidth * dpr); H = cv.height = Math.round(innerHeight * dpr); };
  fit();
  window.addEventListener("resize", fit);
  const N = 36;
  const ps = Array.from({ length: N }, (_, i) => ({
    x: ((i * 379) % 1000) / 1000, y: ((i * 611) % 1000) / 1000,          // deterministic spread
    vx: (((i * 131) % 7) - 3) * 0.00001, vy: -0.00002 - ((i * 17) % 5) * 0.000006,
    r: 0.6 + ((i * 37) % 10) / 12, a: 0.06 + ((i * 53) % 10) / 60
  }));
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.x = (p.x + p.vx + 1) % 1;
      p.y = (p.y + p.vy + 1) % 1;
      ctx.fillStyle = "rgba(255,190,120," + p.a + ")";
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r * dpr, 0, Math.PI * 2); ctx.fill();
    }
  })();
})();

/* ---------------- ambient telemetry (never an empty instrument) ---------------- */
(function telemetry() {
  const mic = $("telMic"), wake = $("telWake"), up = $("telUptime"), model = $("hudModel");
  const t0 = Date.now();
  fetch("/api/status").then((r) => r.json()).then((s) => {
    if (model && s.llmModel) model.textContent = String(s.llmModel).split("/").pop().toUpperCase();
    // resting context card: real system facts, so the panel is never empty
    addCard({
      title: "SYSTEMS",
      lines: [
        "brain  " + (s.llmModel || "—"),
        "voice  " + (s.ttsProvider || "—") + " · stt " + (s.sttEnabled ? "deepgram" : "—"),
        "mail   " + (s.gmailEnabled ? "connected" : "awaiting key"),
        "memory " + (s.notesCount || 0) + " note" + (s.notesCount === 1 ? "" : "s"),
      ],
    });
  }).catch(() => {});
  setInterval(() => {
    if (up) {
      const secs = Math.floor((Date.now() - t0) / 1000);
      up.textContent = "UP " + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
    }
    if (wake) wake.textContent = "WAKE " + (window.__artemisWakeUi ? "ON" : "OFF");
    if (mic) {
      const amp = typeof window.__artemisAmp === "number" ? window.__artemisAmp : 0;
      mic.textContent = amp > 0.001 ? "MIC " + Math.round(20 * Math.log10(amp)) + " dB" : "MIC −∞ dB";
    }
  }, 500);
})();

/* ---------------- panel counter-parallax (opposite the orb's tilt) ---------------- */
(function panelParallax() {
  if (reduced) return;
  const els = [document.querySelector(".hud-left"), document.querySelector(".hud-right"), document.querySelector(".hud-top")].filter(Boolean);
  let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
  window.addEventListener("pointermove", (e) => {
    tx = (e.clientX / innerWidth - 0.5) * -6;  // panels drift OPPOSITE the cursor
    ty = (e.clientY / innerHeight - 0.5) * -4;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
  function apply() {
    raf = 0;
    cx += (tx - cx) * 0.12;
    cy += (ty - cy) * 0.12;
    for (const el of els) el.style.translate = cx.toFixed(2) + "px " + cy.toFixed(2) + "px";
    if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05) raf = requestAnimationFrame(apply);
  }
})();

/* ---------------- opening line in the log ---------------- */
addLine("status", "systems online — say “Artemis”, tap the mic, or ask “what can I do?”");
