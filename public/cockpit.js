// ARTEMIS cockpit controller — the HUD around the voice pipeline.
// main.js emits events through window.ArtemisHUD (guarded, so the landing and
// brain pages work without this file); this module renders them: boot sequence,
// command log, context cards, status-bar telemetry, live waveform, state
// choreography and subtle UI ticks. All motion honors prefers-reduced-motion.

import { PAL, prefersReducedMotion } from "./orbShared.js";

const reduced = prefersReducedMotion();
const $ = (id) => document.getElementById(id);

/* ---------------- boot sequence + welcome briefing ---------------- */
// "ARTEMIS OS initializing…" then TAP TO ENTER — that tap is the user gesture
// that unlocks audio, so she can greet you ALOUD with the morning briefing
// (fetched in parallel during the boot; cached 30 min server-side). Reduced
// motion: no boot, briefing lands silently in the log + context panel.
const briefingP = fetch("/api/briefing").then((r) => r.json()).catch(() => null);

// She greets you and ASKS first. The spoken boot interaction atomically claims
// the once-daily Chief-of-Staff offer; the eager page-load fetch never does.
// A yes (or ▶ tap) routes through daily_brief. No unprompted monologue.
function deliverBriefing(spoken) {
  const responseP = spoken
    ? fetch("/api/briefing?claimDaily=1", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => briefingP)
    : briefingP;
  responseP.then((b) => {
    if (!b) return;
    if (b.offerSkill && b.offerCommand && b.offer) {
      const command = String(b.offerCommand);
      const ask = b.greeting + " " + b.offer;
      addLine("artemis", ask);
      addCard({
        title: b.offerSkill === "opportunity_radar" ? "RADAR DUE" : "BRIEFING READY",
        lines: [spoken ? "say “yes” — or tap play" : "tap play when ready"],
        playCommand: command
      });
      window.__pendingBriefing = { command };
      if (spoken && window.ArtemisSpeak) {
        window.ArtemisSpeak(ask);
      }
    } else if (b.inspire) {
      // mail state + a line for the day — no question, no monologue
      const parts = [b.greeting];
      if (b.mail) parts.push(b.mail);
      parts.push(b.inspire);
      const say = parts.join(" ");
      addLine("artemis", say);
      addCard({ title: "TODAY", lines: [b.mail || "", b.inspire].filter(Boolean) });
      if (spoken && window.ArtemisSpeak) window.ArtemisSpeak(say);
    } else if (spoken && b.news && window.ArtemisSpeak) {
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
    "EVIE OS v2.1",
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
    if (entered) return; // exactly one entry (tap vs 30s fallback race)
    entered = true;
    el.classList.add("done");
    setTimeout(() => el.remove(), 550);
    enterHud();
    // Cinematics v2: the reactor ignites as the HUD assembles.
    setTimeout(() => window.__voiceOrb?.ignite?.(), 420);
    deliverBriefing(spoken);
    if (spoken) {
      // the tap is a real gesture: start background music if you'd left it on,
      // else the lab hum (music.startIfWanted owns that decision after its file
      // probe resolves — no race). Re-arm the wake word if it was ON last session.
      music.startIfWanted(true);
      if (localStorage.getItem("artemisWakeOn") === "1" && window.ArtemisArmWake) {
        setTimeout(() => window.ArtemisArmWake(), 500);
      }
    }
  };
  el.addEventListener("click", () => dismiss(true)); // gesture → she speaks
  // Inside our own app shell autoplay is allowed, so the boot enters ITSELF —
  // full audio, no tap. Browsers still get the tap gate (their rule, not ours).
  const inShell = /ArtemisShell/.test(navigator.userAgent);
  if (inShell) setTimeout(() => dismiss(true), 2400);
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
  const label = { you: "YOU", artemis: "EVIE", tool: "TOOL", action: "ACTION", status: "SYS", error: "ERROR", confirm: "CONFIRM" }[kind] || kind.toUpperCase();
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
  if (card.confirm) {
    // consequential action: EXECUTE/ABORT buttons resolve the same server-side
    // gate as the spoken yes/no (window.ArtemisConfirm → /api/confirm)
    const row = document.createElement("div");
    row.className = "hud-confirm-row";
    const mk = (labelText, yes) => {
      const b = document.createElement("button");
      b.className = "hud-card-play" + (yes ? "" : " hud-abort");
      b.type = "button";
      b.textContent = labelText;
      b.addEventListener("click", () => {
        if (window.ArtemisConfirm) window.ArtemisConfirm(yes);
        div.remove();
      });
      return b;
    };
    row.appendChild(mk("▶ EXECUTE", true));
    row.appendChild(mk("✕ ABORT", false));
    div.appendChild(row);
  }
  if (card.playCommand || card.playText) {
    // A command re-enters the normal skill path; legacy news cards still play
    // their held text directly. Either click is the audio-unlock gesture.
    const b = document.createElement("button");
    b.className = "hud-card-play";
    b.type = "button";
    b.textContent = "▶ PLAY";
    b.addEventListener("click", () => {
      window.__pendingBriefing = null; // answered by tap instead of voice
      if (card.playCommand) {
        if (window.__orb && window.__orb._ensureAudio) window.__orb._ensureAudio();
        if (window.__ask) window.__ask(card.playCommand);
      } else {
        addLine("artemis", card.playText.length > 120 ? card.playText.slice(0, 117) + "…" : card.playText);
        if (window.ArtemisSpeak) window.ArtemisSpeak(card.playText);
      }
      b.remove();
    });
    div.appendChild(b);
  }
  cardsEl.prepend(div);
  requestAnimationFrame(() => div.classList.add("shown"));
  while (cardsEl.children.length > 12) cardsEl.removeChild(cardsEl.lastChild);
}

/* ---------------- ambient soundscape: the Stark-lab reactor hum ---------------- */
// Fully SYNTHESIZED with Web Audio — no files, no copyright, no cost. A low
// detuned hum that "breathes", brightens while she thinks, ducks under any
// voice, plus sparse soft data-blips. Whisper-quiet by design: texture, not
// music. Toggle in the dock (persisted); starts on the boot tap (audio unlock).
const AMBIENT_KEY = "artemisAmbient";
const ambient = (() => {
  let ctx = null, master = null, filter = null, lfoGain = null, blipTimer = 0;
  let running = false;
  const BASE = 0.05; // master level — deliberately a whisper

  function start() {
    if (running) return true;
    const orb = window.__orb;
    if (!orb) return false;
    ctx = orb._ensureAudio && orb._ensureAudio();
    if (!ctx) return false;
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // reactor hum: two barely-detuned saws beating against each other,
    // muffled behind a low-pass so it reads as machinery two rooms away
    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 120;
    filter.Q.value = 0.6;
    filter.connect(master);
    // sines, not saws: saw harmonics through small speakers read as BUZZING,
    // which is exactly the complaint that made this opt-in.
    for (const f of [55, 55.6]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(filter);
      o.start();
    }
    // air: looped noise through a gentle band-pass, quieter still
    const len = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 22222;
    for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = 420;
    nf.Q.value = 0.4;
    const ng = ctx.createGain();
    ng.gain.value = 0.06;
    noise.connect(nf).connect(ng).connect(master);
    noise.start();
    // slow breathing on the master level
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = BASE * 0.25;
    lfo.connect(lfoGain).connect(master.gain);
    lfo.start();

    master.gain.setTargetAtTime(BASE, ctx.currentTime, 1.2); // fade in
    running = true;
    scheduleBlip();
    return true;
  }
  function scheduleBlip() {
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => {
      if (running && ctx && ctx.state === "running" && !document.hidden) {
        try {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = 1100 + ((Date.now() % 7) * 190);
          g.gain.setValueAtTime(0.008, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
          o.connect(g).connect(ctx.destination);
          o.start();
          o.stop(ctx.currentTime + 0.1);
        } catch (e) {}
      }
      scheduleBlip();
    }, 9000 + (Date.now() % 12000));
  }
  function stop() {
    if (!running || !ctx) return;
    running = false;
    clearTimeout(blipTimer);
    try { master.gain.setTargetAtTime(0, ctx.currentTime, 0.3); } catch (e) {}
    // nodes idle at zero gain — cheap, and restart is instant
  }
  // state hooks: duck under ANY voice, brighten while she thinks
  function onState(s) {
    if (!running || !ctx) return;
    const t = ctx.currentTime;
    const duck = s === "speaking" || s === "listening" ? 0.35 : 1;
    try {
      master.gain.setTargetAtTime(BASE * duck, t, 0.25);
      filter.frequency.setTargetAtTime(s === "thinking" || s === "executing" ? 230 : 120, t, 0.5);
    } catch (e) {}
  }
  return {
    get running() { return running; },
    start, stop, onState,
    toggle() {
      if (running) { stop(); localStorage.setItem(AMBIENT_KEY, "0"); return false; }
      const ok = start();
      if (ok) localStorage.setItem(AMBIENT_KEY, "1");
      return ok;
    },
    wanted: () => localStorage.getItem(AMBIENT_KEY) === "1", // opt-in — the hum annoyed in practice
  };
})();
window.__ambient = ambient; // debug/test handle

// dock toggle
(function ambientToggle() {
  const btn = $("ambientToggle");
  if (!btn) return;
  const label = () => { btn.textContent = "AMBIENT: " + (ambient.running ? "ON" : "OFF"); };
  btn.addEventListener("click", () => { ambient.toggle(); label(); });
  label();
  window.__ambientLabel = label;
})();

/* ---------------- background music (your own file) ---------------- */
// Loops a track you drop at assets/music.mp3 (any file you legally own — the
// path is gitignored so nothing copyrighted gets committed). Ducks to ~28%
// under her voice so she's always audible, persists on/off, and is mutually
// exclusive with the synthesized ambient hum (they'd clash).
const music = (() => {
  const KEY = "artemisMusic";
  let el = null, available = false, ready = false;
  const FULL = 0.42;

  function ensure() {
    if (el) return el;
    el = new Audio("/assets/music.mp3");
    el.loop = true;
    el.preload = "none";
    el.volume = FULL;
    el.addEventListener("error", () => { available = false; label(); });
    return el;
  }
  function play() {
    ensure();
    if (ambient.running) { ambient.stop(); window.__ambientLabel && window.__ambientLabel(); } // one bed at a time
    el.volume = FULL;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    label();
  }
  function stop() { if (el) { el.pause(); el.volume = FULL; } label(); }
  const btn = $("musicToggle");
  function label() {
    if (!btn) return;
    btn.textContent = "MUSIC: " + (!available ? "ADD FILE" : el && !el.paused ? "ON" : "OFF");
    btn.classList.toggle("is-na", !available);
  }
  // duck under any voice
  function onState(s) {
    if (!el || el.paused) return;
    el.volume = s === "speaking" || s === "listening" ? FULL * 0.28 : FULL;
  }
  // is a file actually there? (startIfWanted waits on this so the boot-tap
  // restore doesn't lose a race with the probe and play the wrong bed)
  const probeP = fetch("/assets/music.mp3", { method: "HEAD" })
    .then((r) => { available = r.ok; })
    .catch(() => { available = false; })
    .finally(() => { ready = true; label(); });

  if (btn) btn.addEventListener("click", () => {
    // setLiveStatus lives in main.js (a separate module) — use the cockpit log,
    // which IS in scope; calling setLiveStatus here threw a ReferenceError.
    if (!available) { addLine("status", "drop a track at assets/music.mp3 to enable background music"); return; }
    if (el && !el.paused) { stop(); localStorage.setItem(KEY, "0"); }
    else { play(); localStorage.setItem(KEY, "1"); }
  });

  return {
    onState,
    get playing() { return !!(el && !el.paused); },
    get volume() { return el ? el.volume : -1; }, // debug/verification
    // opt-in; needs the boot gesture. Waits for the file probe, THEN decides:
    // play the saved music, or fall back to the ambient hum if that's wanted —
    // so the two never race and the wrong bed can't win.
    startIfWanted(ambientFallback) {
      probeP.then(() => {
        // Default ON once a track exists — the toggle records an explicit OFF.
        if (available && localStorage.getItem(KEY) !== "0") play();
        else if (ambientFallback && ambient.wanted()) { ambient.start(); window.__ambientLabel && window.__ambientLabel(); }
      });
    }
  };
})();
window.__music = music;

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

// The server emits this at the exact point a validated tool begins and again
// when it settles. Family is registry metadata from the server; the client only
// sanitizes it for a data attribute and never duplicates tool → family routing.
const toolOrb = $("hudToolOrb");
const toolName = $("hudToolName");
const toolPhase = $("hudToolPhase");
let toolFadeTimer = 0;
let toolFadeRemaining = 0;
let toolFadeStartedAt = 0;
let toolEventSeq = 0;

function sanitizeToolFamily(value) {
  return String(value || "other").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "other";
}

function cancelToolFade() {
  clearTimeout(toolFadeTimer);
  toolFadeTimer = 0;
  toolFadeRemaining = 0;
}

function scheduleToolFade(seq, delay = 2000) {
  clearTimeout(toolFadeTimer);
  toolFadeTimer = 0;
  toolFadeRemaining = Math.max(0, delay);
  if (document.hidden || !toolFadeRemaining) return;
  toolFadeStartedAt = performance.now();
  toolFadeTimer = setTimeout(() => {
    toolFadeTimer = 0;
    toolFadeRemaining = 0;
    if (seq !== toolEventSeq) return;
    toolOrb.classList.add("is-fading");
  }, toolFadeRemaining);
}

function showToolEvent(data = {}) {
  if (!toolOrb || !toolName || !toolPhase) return;
  const phase = data.phase === "start" || data.phase === "end" ? data.phase : "";
  const rawName = String(data.name || "").trim();
  if (!phase || !rawName) return;

  const seq = ++toolEventSeq;
  cancelToolFade();
  toolOrb.classList.remove("is-fading");
  toolOrb.classList.add("is-active");
  toolName.textContent = rawName.replace(/_/g, " ").toUpperCase();

  if (data.family != null || phase === "start") {
    toolOrb.dataset.family = sanitizeToolFamily(data.family);
  }

  if (phase === "start") {
    toolOrb.dataset.phase = "running";
    toolPhase.textContent = "RUNNING";
    toolOrb.setAttribute("aria-label", rawName + " tool running");
    return;
  }

  const ok = data.ok === true;
  toolOrb.dataset.phase = ok ? "success" : "failure";
  toolPhase.textContent = ok ? "COMPLETE" : "FAILED";
  toolOrb.setAttribute("aria-label", rawName + (ok ? " tool completed" : " tool failed"));
  scheduleToolFade(seq);
}

document.addEventListener("visibilitychange", () => {
  if (!toolOrb) return;
  if (document.hidden && toolFadeTimer) {
    clearTimeout(toolFadeTimer);
    toolFadeTimer = 0;
    toolFadeRemaining = Math.max(0, toolFadeRemaining - (performance.now() - toolFadeStartedAt));
  } else if (!document.hidden && toolFadeRemaining > 0) {
    scheduleToolFade(toolEventSeq, toolFadeRemaining);
  }
});

// live transcript line — ONE line that updates in place while the user speaks,
// with a blinking cursor; removed when the utterance finalizes (ask() then
// logs the final "YOU" line)
let liveLine = null;
function liveUpsert(text) {
  if (!liveLine || !liveLine.parentNode) {
    liveLine = document.createElement("div");
    liveLine.className = "hud-line shown hud-live";
    liveLine.dataset.kind = "you";
    liveLine.innerHTML = '<span class="t"></span><span class="k">YOU</span><span class="m"></span>';
    liveLine.querySelector(".t").textContent = stamp();
    logEl.appendChild(liveLine);
  }
  liveLine.querySelector(".m").textContent = text;
  logEl.scrollTop = logEl.scrollHeight;
}
function liveClear() {
  if (liveLine) { liveLine.remove(); liveLine = null; }
}

let lastState = "idle";
window.ArtemisHUD = {
  live: liveUpsert,
  liveDone: liveClear,
  log(kind, text) {
    addLine(kind, text);
    if (kind === "tool") {
      const sys = TOOL_SYS[String(text).replace(/\s*✓\s*$/, "")];
      if (sys) pulseDot(sys);
    }
  },
  context: addCard,
  tool: showToolEvent,
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
    ambient.onState(s); // hum ducks under voices, brightens while thinking
    music.onState(s);   // background track ducks under her voice too
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
      ctx.fillStyle = PAL.O + a.toFixed(3) + ")";
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
    const amp = Math.min(1, (typeof window.__artemisAmp === "number" ? window.__artemisAmp : 0));
    buf[head] = amp;
    head = (head + 1) % N;
    draw();
    // the whole ROOM reacts to voice: frame corners + panels glow with the
    // live amplitude (hers while speaking, yours while listening)
    document.body.style.setProperty("--vg", (amp * 26).toFixed(1));
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
    ctx.strokeStyle = PAL.O + "0.22)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    // rotating tick ring
    ctx.save(); ctx.rotate(rot);
    for (let i = 0; i < 72; i++) {
      const maj = i % 6 === 0;
      const a = (i / 72) * Math.PI * 2;
      ctx.strokeStyle = maj ? PAL.O + "0.5)" : PAL.O + "0.2)";
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
    ctx.fillStyle = PAL.D + "0.55)";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let d = 0; d < 360; d += 30) {
      const a = (d / 180) * Math.PI;
      ctx.fillText(String(d).padStart(3, "0"), Math.cos(a) * (R - 22 * dpr), Math.sin(a) * (R - 22 * dpr));
    }
    ctx.restore();
    // dashed inner arc segment sweeping with state
    ctx.strokeStyle = PAL.O + "0.35)";
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
      ctx.fillStyle = PAL.B + p.a + ")";
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r * dpr, 0, Math.PI * 2); ctx.fill();
    }
  })();
})();

/* ---------------- ambient telemetry (never an empty instrument) ---------------- */
(function telemetry() {
  const mic = $("telMic"), wake = $("telWake"), up = $("telUptime"), model = $("hudModel");
  const t0 = Date.now();
  let systemsShown = false, usageCard = null;
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  function refresh() {
    fetch("/api/status").then((r) => r.json()).then((s) => {
      if (model && s.llmModel) model.textContent = String(s.llmModel).split("/").pop().toUpperCase();
      if (!systemsShown) { // resting facts card — render once so it stays at the bottom
        systemsShown = true;
        addCard({
          title: "SYSTEMS",
          lines: [
            "brain  " + (s.llmModel || "—"),
            "voice  " + (s.ttsProvider || "—") + " · stt " + (s.sttEnabled ? "deepgram" : "—"),
            "mail   " + (s.gmailEnabled ? "connected" : "awaiting key"),
            "memory " + (s.notesCount || 0) + " note" + (s.notesCount === 1 ? "" : "s"),
          ],
        });
      }
      // USAGE card: today's real request tally + the ElevenLabs char wall (the
      // one free-tier limit that actually bites). Rebuilt in place each refresh.
      const u = s.usage || { llm: 0, stt: 0, search: 0, ttsChars: {} };
      const tc = u.ttsChars || {};
      const lines = [
        "today  " + fmt(u.llm) + " chats · " + fmt(u.stt) + " STT · " + fmt(u.search) + " search",
        "tts    dg " + fmt(tc.deepgram || 0) + " · edge " + fmt(tc.edge || 0) + " · 11L " + fmt(tc.elevenlabs || 0) + " chars",
      ];
      if (s.elevenUsage && s.elevenUsage.limit) {
        const e = s.elevenUsage, left = Math.max(0, e.limit - e.used), pct = Math.round((e.used / e.limit) * 100);
        lines.push("11labs " + fmt(left) + " / " + fmt(e.limit) + " chars left (" + (100 - pct) + "%)");
      }
      if (usageCard && usageCard.isConnected) {
        const ps = usageCard.querySelectorAll("p");
        lines.forEach((t, i) => { if (ps[i]) ps[i].textContent = t; });
      } else {
        addCard({ title: "USAGE · FREE TIER", lines });
        usageCard = Array.from(cardsEl.querySelectorAll(".hud-card")).find((c) => c.querySelector(".hud-card-title")?.textContent === "USAGE · FREE TIER");
      }
    }).catch(() => {});
  }
  refresh();
  setInterval(refresh, 60000); // keep the tally current
  setInterval(() => {
    if (up) {
      const secs = Math.floor((Date.now() - t0) / 1000);
      up.textContent = "UP " + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
    }
    // show the REAL recognizer state: ● LIVE = actively listening, ON = toggled
    // but the recognizer is down (paused/dead) — so a silent failure is visible
    if (wake) wake.textContent = window.__artemisWakeUi ? (window.__wakeLive ? "WAKE ● LIVE" : "WAKE ○ ON") : "WAKE OFF";
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

/* ---------------- mail watch: she speaks up when new email lands ---------------- */
// Polls the server every 90s (read-only Gmail scope). First poll BASELINES the
// current unread — only mail arriving while the cockpit is open gets announced:
// chime + context card + a spoken "New email from …" IF the room is quiet
// (never talks over a conversation; falls back to log+card otherwise).
(function mailWatch() {
  const btn = $("mailWatchToggle");
  const KEY = "artemisMailWatch";
  let enabled = localStorage.getItem(KEY) !== "0"; // default ON
  let available = false;
  let baselined = false;
  const seen = new Set();
  const cleanFrom = (f) => String(f || "").replace(/\s*<[^>]*>/, "").replace(/"/g, "").trim() || "someone";
  const label = () => { if (btn) btn.textContent = "MAIL WATCH: " + (!available ? "N/A" : enabled ? "ON" : "OFF"); };

  async function poll() {
    if (!enabled || document.hidden) return;
    try {
      const r = await fetch("/api/email/watch");
      if (!r.ok) return;
      const { mails } = await r.json();
      if (!baselined) {
        mails.forEach((m) => seen.add(m.id)); // existing unread = old news
        baselined = true;
        return;
      }
      const fresh = mails.filter((m) => !seen.has(m.id));
      if (!fresh.length) return;
      fresh.forEach((m) => seen.add(m.id));
      for (const m of fresh.slice(0, 3)) {
        addLine("status", "new email · " + cleanFrom(m.from) + " — " + m.subject);
      }
      addCard({
        title: "NEW EMAIL",
        lines: fresh.slice(0, 3).map((m) => cleanFrom(m.from) + " — " + m.subject)
      });
      uiTick(1320);
      if (document.body.dataset.aiState === "idle" && window.ArtemisSpeak) {
        const m = fresh[0];
        const extra = fresh.length > 1 ? " And " + (fresh.length - 1) + " more." : "";
        window.ArtemisSpeak("New email from " + cleanFrom(m.from) + ": " + m.subject + "." + extra);
      }
    } catch (e) {}
  }
  window.__mailPoll = poll; // debug/test handle

  fetch("/api/status").then((r) => r.json()).then((st) => {
    available = !!st.gmailEnabled;
    label();
    if (available) { poll(); setInterval(poll, 90000); }
  }).catch(label);
  if (btn) btn.addEventListener("click", () => {
    if (!available) return;
    enabled = !enabled;
    localStorage.setItem(KEY, enabled ? "1" : "0");
    label();
  });
})();

/* ---------------- reminders: she speaks up when one is due ---------------- */
// Polls every 30s. Announces the moment the room is quiet — a reminder that
// lands mid-conversation waits (retrying every 5s for up to 2 min) instead of
// talking over anyone; the log line + card land immediately either way.
function announceWhenQuiet(text, tries = 24) {
  if (document.body.dataset.aiState === "idle" && window.ArtemisSpeak) {
    window.ArtemisSpeak(text);
    return;
  }
  if (tries > 0) setTimeout(() => announceWhenQuiet(text, tries - 1), 5000);
}
(function reminderWatch() {
  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch("/api/reminders/due");
      if (!r.ok) return;
      const { due } = await r.json();
      if (!due || !due.length) return;
      for (const rem of due) {
        addLine("status", "reminder · " + rem.text + (rem.overdueMin > 2 ? " (from " + rem.overdueMin + " min ago)" : ""));
      }
      addCard({ title: "REMINDER", lines: due.map((d) => d.text) });
      uiTick(1560);
      announceWhenQuiet(due.map((d) => d.spoken).join(" "));
    } catch (e) {}
  }
  window.__reminderPoll = poll; // debug/test handle
  poll();
  setInterval(poll, 30000);
})();

/* ---------------- session continuity: replay recent turns ---------------- */
// main.js stashes the last few conversation turns on window.__artemisHistory;
// render them dimmed above the live log so the cockpit isn't blank on reload.
(function replayHistory() {
  const hist = Array.isArray(window.__artemisHistory) ? window.__artemisHistory : [];
  if (!hist.length) return;
  const sep = document.createElement("div");
  sep.className = "hud-line shown hud-earlier-sep";
  sep.innerHTML = '<span class="t"></span><span class="k"></span><span class="m">— earlier —</span>';
  logEl.appendChild(sep);
  for (const m of hist) {
    const div = document.createElement("div");
    div.className = "hud-line shown hud-earlier";
    div.dataset.kind = m.role === "user" ? "you" : "artemis";
    const label = m.role === "user" ? "YOU" : "EVIE";
    const text = String(m.content || "");
    div.innerHTML = '<span class="t"></span><span class="k"></span><span class="m"></span>';
    div.querySelector(".k").textContent = label;
    div.querySelector(".m").textContent = text.length > 110 ? text.slice(0, 107) + "…" : text;
    logEl.appendChild(div);
  }
})();

/* ---------------- opening line in the log ---------------- */
addLine("status", "systems online — say “Hey Jarvis”, tap the mic, or ask “what can I do?”");

// ── HUD gauges ────────────────────────────────────────────────────────────
// Bound to /api/telemetry. Everything shown here is something she actually
// knows; a value that can't be read renders "—" rather than 0, because
// "couldn't measure" and "is zero" are different facts and only one of them
// is reassuring.
import { createRingRow } from "./hudRing.js";

(function mountGauges() {
  const host = document.getElementById("hudGauges");
  if (!host) return;

  const row = createRingRow([
    { key: "cpu",     label: "CPU",    size: 64, max: 100, unit: "%" },
    { key: "mem",     label: "MEM",    size: 64, max: 100, unit: "%" },
    { key: "budget",  label: "TOKENS", size: 64, max: 100, unit: "%", tone: "#a78bfa" },
    { key: "latency", label: "TTFW",   size: 64, max: 3000, unit: "ms" },
    { key: "due",     label: "DUE",    size: 64 }
  ]);
  host.appendChild(row);
  const g = row.rings;

  const pct = (used, total) => (total ? Math.round((used / total) * 100) : null);

  async function poll() {
    let t = null;
    try {
      const r = await fetch("/api/telemetry", { cache: "no-store" });
      if (r.ok) t = await r.json();
      window.__telemetry = t;
      window.__telemetryShared = true;
      window.dispatchEvent(new CustomEvent("artemis-telemetry", { detail: t }));
    } catch (e) { /* keep the last values and dim, rather than zeroing them */ }
    if (!t) { for (const k in g) g[k].set({ state: "warn" }); return; }

    const cpuPct = t.cpu ? Math.min(100, Math.round((t.cpu.load1 / (t.cpu.cores || 1)) * 100)) : null;
    g.cpu.set({ value: cpuPct, state: cpuPct > 85 ? "warn" : "" });

    const memPct = t.memory ? pct(t.memory.usedBytes, t.memory.totalBytes) : null;
    g.mem.set({ value: memPct, state: memPct > 90 ? "warn" : "" });

    // Remaining share of the daily allowance. Worth a gauge of its own: a day's
    // budget was exhausted in one evening of testing, and it was invisible.
    const b = t.budget;
    const left = b && b.limitTokens ? Math.round((b.remainingTokens / b.limitTokens) * 100) : null;
    g.budget.set({ value: left, state: left != null && left < 15 ? "bad" : left != null && left < 35 ? "warn" : "" });

    const ms = t.latency ? t.latency.lastFirstWordMs : null;
    g.latency.set({ value: ms, state: ms > 2500 ? "warn" : "" });

    const due = t.counts ? t.counts.reminders : null;
    g.due.set({ value: due, max: Math.max(5, due || 0), text: due == null ? "—" : String(due) });

    // A benched brain is worth seeing before it surprises you mid-sentence.
    if (t.brain && t.brain.benched) g.budget.set({ state: "bad" });
  }

  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 2500);
})();
