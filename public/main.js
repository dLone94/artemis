// Artemis — main page orchestrator.
// Wires the audio-reactive VoiceOrb to the real backend: mic → Deepgram STT →
// Claude (+ web search) → Deepgram TTS, plus an "Artemis …" wake word. The orb
// reacts to YOUR voice (listening) and ARTEMIS's voice (speaking) via real audio.
import { ArtemisCore } from "./artemisCore.js";
import { MOON_INFO } from "./coreCapabilities.js";
import { resolveOpenIntent } from "./siteRegistry.js";
import { voiceSuspended } from "./presentationPolicy.js";
import { isClosingPhrase, loadFollowUpEnabled, matchWake, saveFollowUpEnabled } from "./wakeWords.js";
import { initMiniOrbs } from "./miniOrb.js";
import { BrainOrb } from "./brainOrb.js";
import { PAL, prefersReducedMotion } from "./orbShared.js";
import { startLocalWake, stopLocalWake, pauseLocalWake, resumeLocalWake, localWakeRunning, captureCommand, activeWakeProfile } from "./wakeLocal.js";
import { FALLBACK_PROFILE, resolveWakeProfile } from "./wakeProfile.js";
import { confirmationDecision } from "./confirmDecision.js";
import { isMeetingStartPhrase, isMeetingStopPhrase } from "./meetingCapture.js";
import { takeVoiceboxChunks } from "./ttsChunking.js";
import { startHealthClient } from "./healthClient.js";

const $ = (id) => document.getElementById(id);

// ---- open-source links ----------------------------------------------------
// TODO: fill these in ONCE and every "Open source" / repo / docs / getting-
// started link on the page lights up. While a value is empty, its links render
// disabled (aria-disabled, no href) instead of pointing at a broken URL.
const LINKS = {
  repo: "",  // e.g. "https://github.com/you/artemis"
  docs: "",  // e.g. "https://github.com/you/artemis#readme"
  start: "", // e.g. "https://github.com/you/artemis#getting-started"
};
document.querySelectorAll("[data-link]").forEach((a) => {
  const url = LINKS[a.dataset.link] || "";
  if (url) {
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.removeAttribute("aria-disabled");
  } else {
    a.removeAttribute("href"); // an <a> without href isn't a broken link
    a.setAttribute("aria-disabled", "true");
    a.title = "Link coming soon";
  }
});

const conversation = [];
let busy = false;
let recording = false;
let talkStarting = false;
let talkSuppressClosingAck = false;
let conversationLive = false;
let followUpEnabled = true;
try { followUpEnabled = loadFollowUpEnabled(window.localStorage); } catch (e) {}
let followUpInFlight = false;
let followUpCaptureOpen = false;
let followUpGeneration = 0;
let followUpStarting = false;
let followUpAbort = null;

const MEETING_MAX_MS = 30 * 60 * 1000;
const MEETING_WAIT_FOR_SPEECH_MS = 20000;
const MEETING_STT_TIMEOUT_MS = 30000;
const MEETING_LOCAL_START_TIMEOUT_MS = 15000;
// The slowest server provider is itself bounded at 60s; leave enough room for
// its raw fallback write and response instead of aborting at the same instant.
const MEETING_SAVE_TIMEOUT_MS = 70000;
let meetingSession = null;
let meetingGeneration = 0;
let deferredMeetingReply = null;

function meetingVoiceActive() {
  return !!meetingSession;
}

// celebration.js checks this before playing its jingle / hijacking the orb —
// a payment landing mid-conversation must not talk over Artemis or the user
window.celebrationVoiceActive = () =>
  speaking || recording || talkStarting || followUpInFlight || busy || meetingVoiceActive();

// The Artemis Core — the hero visualization. Still bound to `orb` because the
// whole app talks to it through that name (and window.__orb); it is a drop-in
// for the retired VoiceOrb, so renaming the binding would be pure churn.
const orb = new ArtemisCore($("sceneStage"), { center: document.body.classList.contains("cockpit") });

// Clickable skill moons: a click near a moon opens its info card. The stage
// sits behind the HUD panels, so only clicks that reach it (the open middle
// of the screen) are candidates — panels and dock stay unaffected.
(function moonClicks() {
  const stage = $("sceneStage");
  if (!stage || !orb.moonInfoAt) return;
  stage.style.pointerEvents = "auto";
  stage.style.cursor = "default";
  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    const hit = orb.moonInfoAt(e.clientX - r.left, e.clientY - r.top);
    stage.style.cursor = hit ? "pointer" : "default";
  });
  stage.addEventListener("click", (e) => {
    const r = stage.getBoundingClientRect();
    const hit = orb.moonInfoAt(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    hud("context", { title: hit.title, lines: [hit.what, "Try: " + hit.say] });
  });
})();
window.__orb = orb;

// ---- ActiveTaskIndicator: the one place a Core view-model reaches the DOM ----
// The Core owns the canvas; this owns the accessible text line under it. Both
// render the SAME derived view, so the picture and the words can never disagree
// about what Artemis is doing.
(function activeTaskIndicator() {
  const el = $("coreTask");
  if (!el || !orb.onView) return;
  orb.onView((view) => {
    const detail = view.detail && view.detail !== view.task ? view.detail : "";
    el.textContent = detail ? view.task + " · " + detail : view.task;
    el.dataset.state = view.state;
    el.dataset.empty = view.state === "standby" ? "1" : "0";
  });
})();

// The cockpit HUD (cockpit.js) listens on window.ArtemisHUD; on pages without
// it every emit is a guarded no-op.
const hud = (fn, ...a) => { try { window.ArtemisHUD && window.ArtemisHUD[fn] && window.ArtemisHUD[fn](...a); } catch (e) {} };

// ---- presence bus (feeds the floating pill with REAL dashboard state) ------
// The dashboard is the single source of truth; the pill only renders what we
// publish here. We push the orb's actual state, active task, and live mic/TTS
// amplitude — never an invented waveform — and receive the pill's quick-control
// commands back over the same bus.
// Presentation mode is runtime state, not just window dressing: in PILL mode
// (native shell only) the dashboard window is hidden by design and the voice
// runtime must keep running — the pill is the visible open-mic indicator.
// voiceHidden() is the ONLY visibility question the voice paths may ask;
// document.hidden alone would silence Artemis the moment the shell orders the
// window out, which is exactly the bug this replaces.
const inArtemisShell = /ArtemisShell/.test(navigator.userAgent);
let presentationMode = "full";
function voiceHidden() {
  return voiceSuspended(document.hidden, presentationMode, inArtemisShell);
}

const presencePub = (() => {
  let mode = "full";
  let last = { state: "", task: "", capability: "", amplitude: -1 };
  let latestView = null;
  let pending = null;
  // The orb eases cur.amp inside its render loop, which stops with the hidden
  // window. Mirror the raw fed amplitude here (with its own decay) so the pill
  // keeps seeing REAL levels while the dashboard is ordered out.
  let fedAmp = 0;
  const origFeed = orb.feed && orb.feed.bind(orb);
  if (origFeed) {
    orb.feed = (a) => {
      const v = Math.max(0, Math.min(1, Number(a) || 0));
      if (v > fedAmp) fedAmp = v;
      origFeed(a);
    };
  }

  function post(patch) {
    try {
      fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      }).catch(() => {});
    } catch (e) {}
  }
  function publish(patch) {
    if (patch.mode) mode = patch.mode;
    post({ mode, ...patch });
  }
  function setPending(obj) {
    pending = obj; // { name, prompt } or null
    post({ mode, pendingConfirm: pending });
  }

  if (orb.onView) orb.onView((view) => { latestView = view; });

  // One lightweight loop: publish state/task changes immediately, and stream
  // amplitude only while it moves (the server throttles further).
  function tick() {
    const view = latestView;
    if (view) {
      const state = view.state === "standby" ? "idle" : view.state;
      const detail = view.detail && view.detail !== view.task ? view.detail : "";
      const task = detail ? view.task + " · " + detail : (view.state === "standby" ? "" : view.task);
      const capability = Number.isInteger(view.capability) && view.capability >= 0
        ? (MOON_INFO[view.capability]?.title || "")
        : "";
      const eased = orb.cur ? orb.cur.amp : 0;
      const amp = Math.min(1, Math.max(eased, fedAmp) * 1.7);
      fedAmp *= 0.55; // decays here because the orb's own decay is rAF-bound
      const active = state === "listening" || state === "speaking";
      const patch = {};
      if (state !== last.state) patch.state = last.state = state;
      if (task !== last.task) patch.task = last.task = task || "";
      if (capability !== last.capability) patch.capability = last.capability = capability;
      if (active) { patch.amplitude = amp; patch.listening = state === "listening"; patch.speaking = state === "speaking"; }
      else if (last.amplitude !== 0) { patch.amplitude = last.amplitude = 0; patch.listening = false; patch.speaking = false; }
      if (Object.keys(patch).length) publish(patch);
    }
    setTimeout(tick, 180);
  }
  tick();

  // Receive the pill's commands. The pill is presentation only — the actual
  // action still runs through the dashboard's authoritative paths here.
  function connect() {
    const es = new EventSource("/api/presence/events");
    es.addEventListener("state", (e) => {
      let snap = {};
      try { snap = JSON.parse(e.data); } catch (err) { return; }
      if (snap.approvalState && snap.approvalState.confirmId) {
        const id = snap.approvalState.confirmId;
        if (!pendingConfirm || pendingConfirm.confirmId !== id) {
          pendingConfirm = { confirmId: id, name: snap.approvalState.tool };
          pendingConfirmPrompt = snap.approvalState.prompt || pendingConfirmPrompt;
          syncConfirmToCore();
        }
      }
    });
    es.addEventListener("command", (e) => {
      let cmd = "";
      try { cmd = JSON.parse(e.data).command; } catch (err) {}
      if (cmd === "cancel") {
        try { window.ArtemisBargeIn && window.ArtemisBargeIn.interrupt(); } catch (err) {}
        cancelPendingConfirmation();
      }
      else if (cmd === "mute") setAssistantMuted(true);
      else if (cmd === "unmute") setAssistantMuted(false);
      else if (cmd === "restore") setPresentationMode("full");
      else if (cmd === "pill" || cmd === "background") setPresentationMode(cmd);
      else if (cmd === "approve") { try { window.ArtemisConfirm && window.ArtemisConfirm(true); } catch (err) {} }
      else if (cmd === "deny") { try { window.ArtemisConfirm && window.ArtemisConfirm(false); } catch (err) {} }
    });
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }
  connect();

  return { publish, setPending, getMode: () => mode };
})();
function publishPresence(patch) { presencePub.publish(patch); }

// Mirror the orb's voice state onto the equalizer in the control dock so the
// voice bars animate during LISTENING/SPEAKING. Wrapping setStatus catches
// every call site (including celebration surges) from one place.
const voiceBars = document.getElementById("voiceBars");
// While LISTENING/SPEAKING, scale the equalizer by the orb's live mic/TTS
// amplitude. A rAF runs ONLY during a voice state, then stops — no idle cost.
let ampRaf = 0;
function startAmpBars() {
  if (ampRaf || !voiceBars || orb.reduced) return;
  const tick = () => {
    const amp = orb.cur ? Math.min(1, orb.cur.amp * 1.7) : 0;
    voiceBars.style.setProperty("--amp", amp.toFixed(3));
    ampRaf = requestAnimationFrame(tick);
  };
  ampRaf = requestAnimationFrame(tick);
}
function stopAmpBars() {
  if (ampRaf) { cancelAnimationFrame(ampRaf); ampRaf = 0; }
  if (voiceBars) voiceBars.style.setProperty("--amp", "0");
}
const _orbSetStatus = orb.setStatus.bind(orb);
orb.setStatus = (s) => {
  _orbSetStatus(s);
  const active = s === "listening" || s === "speaking";
  if (voiceBars) voiceBars.classList.toggle("voice-active", active);
  if (active) startAmpBars();
  else stopAmpBars();
  hud("state", s); // the whole cockpit HUD choreographs with the voice state
  // Broadcast the same state to anything that isn't the cockpit HUD. The music
  // bed needs it to duck, and on about.html the HUD does not exist — hud() is a
  // no-op there, so a listener that went through it would never hear a word.
  document.body.dataset.aiState = s;
  try { window.dispatchEvent(new CustomEvent("artemis-voice-state", { detail: s })); } catch (e) {}
};

const liveStatus = $("liveStatus");
const transcript = $("transcript"); // null now (chat window removed) — DOM updates are guarded
const micToggle = $("micToggle");
const wakeToggle = $("wakeToggle");
const followUpToggle = $("followUpToggle");

function setLiveStatus(t) {
  if (liveStatus) liveStatus.textContent = t;
}

// Open a URL in a NEW tab — Artemis must NEVER navigate herself away (the old
// same-tab fallback "closed" her mid-conversation). Voice commands carry no
// click gesture, so the browser may block window.open; when that happens we
// show a one-tap glowing "Open" pill (a real gesture — always allowed) instead
// of hijacking this tab. TIP: allow pop-ups for this site (Safari/Orion:
// Settings → Websites → Pop-up Windows → localhost → Allow) and every open is
// fully hands-free.
let openPill = null;
function openUrl(url, label) {
  let parsed;
  try { parsed = new URL(url, location.href); } catch (e) { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  url = parsed.href;
  let w = null;
  try { w = window.open(url, "_blank"); } catch (e) {}
  if (w) return true; // opened in a new tab — Artemis stays put
  showOpenPill(url, label);
  return false;
}
window.__openUrl = openUrl; // debug/test handle (used by preview verification)
function showOpenPill(url, label) {
  if (openPill) { openPill.remove(); openPill = null; }
  let name = label || "";
  if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { name = "link"; } }
  const b = document.createElement("button");
  b.className = "open-link";
  b.type = "button";
  b.textContent = "▶ Open " + (name.length > 42 ? name.slice(0, 39) + "…" : name);
  b.addEventListener("click", () => {
    try { window.open(url, "_blank"); } catch (e) {}
    b.remove();
    openPill = null;
  });
  document.body.appendChild(b);
  openPill = b;
  setLiveStatus("Pop-up blocked — tap Open. (Allow pop-ups for this site and I'll open tabs myself.)");
  setTimeout(() => { if (openPill === b) { b.remove(); openPill = null; } }, 25000);
}

// One consumer for browser actions, whether they came from a normal tool turn
// or from the confirmation endpoint after an explicitly approved nudge.
/**
 * Clean shutdown, in the order that avoids stranding anything:
 * stop taking work → disarm wake → release the microphone → stop speaking →
 * fade the music → close the pill → ask the native shell to quit (which stops
 * the Node server and dictation it owns via applicationWillTerminate).
 *
 * Outside the native shell there is no app to quit, so it stops at "quiet".
 */
let shuttingDown = false;
async function shutdownArtemis() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { window.__artemisShuttingDown = true; } catch (e) {}
  hud("log", "status", "shutting down");

  // 1. no new work, and no follow-up window reopening behind us
  try { await abortFollowUp({ endConversation: true }); } catch (e) {}
  conversationLive = false;

  // 2 + 3. disarm wake and release the mic it holds
  try { await stopLocalWake(); } catch (e) {}
  try { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } } catch (e) {}
  try { orb.stopAudio(); } catch (e) {}

  // 4. stop speaking — but only AFTER the goodbye line has had its moment
  const quiet = () => {
    try { resetTtsPipe(); } catch (e) {}
    try { if (ttsEl) { ttsEl.pause(); ttsEl.src = ""; } } catch (e) {}
  };

  // 5. fade the bed rather than cutting it
  try { window.__music && window.__music.fadeOut && window.__music.fadeOut(); } catch (e) {}
  try {
    const bed = window.__pageMusic;
    if (bed && !bed.paused) { bed.volume = 0; bed.pause(); }
  } catch (e) {}

  // Give the spoken "Shutting down." ~1.2s to land, then go.
  setTimeout(() => {
    quiet();
    try { window.webkit.messageHandlers.artemisPresentation.postMessage("quit"); } catch (e) {}
  }, 1200);
}

function applyClientActions(actions) {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action) continue;
    if (action.type === "panel" && action.card) {
      hud("context", action.card);
      continue;
    }
    if (action.type === "open" && action.url) {
      const opened = openUrl(action.url, action.label);
      hud("log", "action", (opened ? "open " : "ready to open ") + (action.label || action.url));
      hud("context", {
        title: opened ? "OPENED" : "READY TO OPEN",
        links: [{ title: action.label || action.url, url: action.url }]
      });
    }
    if (action.type === "presentation" && action.mode) {
      setPresentationMode(action.mode);
    }
    if (action.type === "shutdown") {
      void shutdownArtemis();
    }
  }
}

// Presentation: full dashboard / floating pill / background. The mode is shared
// via the presence bus (so the pill knows) and handed to the native shell,
// which owns the actual window show/hide. In a plain browser the shell bridge
// is absent and the mode is still broadcast for any listener.
function setPresentationMode(mode) {
  presentationMode = String(mode || "full");
  publishPresence({ mode: presentationMode });
  try { window.webkit.messageHandlers.artemisPresentation.postMessage(String(presentationMode)); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("artemis-presentation", { detail: presentationMode })); } catch (e) {}
  // Mode changes can flip the voice policy WITHOUT a visibilitychange event
  // (pill → background while the window stays hidden), so re-apply it here.
  if (voiceHidden()) suspendHiddenVoice();
}

function addMsg(role, text, sources) {
  if (!transcript) return; // voice-only: no transcript window
  const row = document.createElement("div");
  row.className = "t-msg t-" + (role === "user" ? "user" : "artemis");
  const who = document.createElement("span");
  who.className = "t-who";
  who.textContent = role === "user" ? "You" : "Artemis";
  const bubble = document.createElement("div");
  bubble.className = "t-bubble";
  bubble.textContent = text;
  row.appendChild(who);
  row.appendChild(bubble);
  if (sources && sources.length) {
    const s = document.createElement("div");
    s.className = "t-sources";
    s.appendChild(document.createTextNode("Sources: "));
    sources.forEach((src, i) => {
      const a = document.createElement("a");
      a.href = src.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = src.title || src.url;
      s.appendChild(a);
      if (i < sources.length - 1) s.appendChild(document.createTextNode(" · "));
    });
    row.appendChild(s);
  }
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
}

// ---- speaking (Artemis voice → orb) ----
const ttsEl = new Audio();
let speaking = false;
let ttsGeneration = 0;

// Streaming TTS URL — the browser plays it progressively (first frames ~0.5s).
// Voice values: "voicebox:<profile>" → a local Voicebox clone;
// "aura-*" → Deepgram; "eleven:<id>" → that ElevenLabs voice;
// "edge:<AzureVoiceName>" → free Edge neural voice (e.g. en-GB-SoniaNeural);
// legacy "elevenlabs" → the server's default eleven voice.
function ttsUrl(text) {
  const v = settings.voice || "";
  const p = v.startsWith("voicebox:")
    ? { text, provider: "voicebox", profile: v.slice(9) }
    : v === "voicebox"
      ? { text, provider: "voicebox" }
    : v.startsWith("eleven:")
    ? { text, provider: "elevenlabs", voice: v.slice(7) }
    : v.startsWith("edge:")
      ? { text, provider: "edge", voice: v.slice(5) }
      : v === "elevenlabs"
        ? { text, provider: "elevenlabs" }
        : { text, provider: "deepgram", voice: v };
  return "/api/tts?" + new URLSearchParams(p).toString();
}

function voiceboxVoiceSelected() {
  const voice = String(settings.voice || "");
  return voice === "voicebox" || voice.startsWith("voicebox:");
}

// ---- hands-free barge-in: interrupt Artemis just by speaking while she talks ----
// Listens on a mic with echo-cancellation so her own voice (through the speakers)
// doesn't false-trigger; only sustained, real speech cuts her off.
// Hands-free barge-in is OFF by default — on speakers (without solid echo
// cancellation) it can false-trigger on Artemis's own voice and abort her reply.
// The mic button still interrupts her reliably. Set to true to re-enable.
// Hands-free "talk over her" barge-in — off by default (on speakers it can
// false-trigger on her own voice); a runtime dock toggle turns it on, best with
// headphones. The keyboard/mic interrupt below always works regardless.
let BARGE_IN_ENABLED = false;
try { BARGE_IN_ENABLED = localStorage.getItem("artemisBargeIn") === "1"; } catch (e) {}
let bargeStream = null, bargeAnalyser = null, bargeFreq = null, bargeRaf = 0, bargeHot = 0;
let bargeGeneration = 0, bargeStartingGeneration = null;
async function startBargeIn(expectedTtsGeneration = ttsGeneration) {
  if (!BARGE_IN_ENABLED || bargeStream ||
      bargeStartingGeneration === bargeGeneration) return;
  const ctx = orb._ensureAudio();
  if (!ctx || !navigator.mediaDevices) return;
  const generation = bargeGeneration;
  bargeStartingGeneration = generation;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    if (bargeStartingGeneration === generation) bargeStartingGeneration = null;
    return;
  }
  if (bargeStartingGeneration === generation) bargeStartingGeneration = null;
  if (generation !== bargeGeneration ||
      expectedTtsGeneration !== ttsGeneration ||
      meetingVoiceActive() || !speaking || bargeStream) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  bargeStream = stream;
  try {
    const src = ctx.createMediaStreamSource(bargeStream);
    bargeAnalyser = ctx.createAnalyser();
    bargeAnalyser.fftSize = 512;
    bargeFreq = new Uint8Array(bargeAnalyser.frequencyBinCount);
    src.connect(bargeAnalyser); // analyse only — never routed to the speakers
  } catch (e) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) {}
    if (bargeStream === stream) bargeStream = null;
    return;
  }
  bargeHot = 0;
  const startedAt = performance.now();
  const tick = () => {
    if (generation !== bargeGeneration || !bargeStream) return;
    bargeRaf = requestAnimationFrame(tick);
    if (performance.now() - startedAt < 350) return; // brief settle window
    bargeAnalyser.getByteFrequencyData(bargeFreq);
    let s = 0;
    for (let i = 0; i < bargeFreq.length; i++) s += bargeFreq[i];
    const amp = s / bargeFreq.length / 255;
    if (amp > 0.18) { bargeHot++; if (bargeHot >= 5) bargeIn(); } // ~85ms sustained → your voice
    else bargeHot = Math.max(0, bargeHot - 1);
  };
  bargeRaf = requestAnimationFrame(tick);
}
function stopBargeIn() {
  bargeGeneration++;
  bargeStartingGeneration = null;
  if (bargeRaf) { cancelAnimationFrame(bargeRaf); bargeRaf = 0; }
  if (bargeStream) { bargeStream.getTracks().forEach((t) => t.stop()); bargeStream = null; }
  bargeAnalyser = null; bargeFreq = null; bargeHot = 0;
}
function bargeIn() {
  const interruptedTts = speaking || ttsPlaying || ttsQueue.length > 0;
  stopBargeIn();
  resetTtsPipe();
  speaking = false;
  orb.stopAudio();
  if (currentAbort) { try { currentAbort.abort(); } catch (e) {} }
  startTalk({ suppressClosingAck: interruptedTts }); // immediately capture what you're now saying
}

// Public hook for the cockpit (welcome briefing etc.) — must be invoked from
// a user-gesture call chain the first time so audio is unlocked.
window.ArtemisSpeak = (t) => { try { orb._ensureAudio(); speak(String(t || "")); } catch (e) {} };

async function speak(text) {
  // Meeting capture owns the microphone continuously. pauseLocalWake() cannot
  // interrupt mode="capture" (by design), so playing TTS here would transcribe
  // Artemis into the user's notes. Meeting completion speaks only after it has
  // closed the mic and released meetingSession.
  if (meetingVoiceActive()) return;
  // speak() and the streaming pumpTts() share one <audio> element; take sole
  // ownership first so a still-draining streamed reply (or a poller-triggered
  // announce) can't leave a stale onended handler that wedges `speaking`.
  if (followUpInFlight || followUpStarting) void abortFollowUp();
  stopBargeIn();
  resetTtsPipe();
  const generation = ttsGeneration;
  pauseWakeForSpeech();
  orb.connectMediaElement(ttsEl); // route Artemis's voice into the orb's analyser
  orb.setStatus("speaking");
  setLiveStatus("Artemis is responding…  (Esc to stop)");
  speaking = true;
  startBargeIn(generation);
  const settle = () => {
    if (settle.done || generation !== ttsGeneration) return;
    settle.done = true;
    afterSpeak();
  };
  ttsEl.onended = ttsEl.onerror = settle;
  try {
    ttsEl.src = ttsUrl(cleanForSpeech(text));
    ttsEl.currentTime = 0;
    await ttsEl.play();
  } catch (e) {
    settle();
  }
}

// The ONLY repairs the health system can ask this page to perform. An explicit
// allowlist of two local actions: re-arm the listener we own, resume the audio
// context we own. Nothing here can touch a permission, a process or a file.
window.__artemisRecover = {
  wake: () => { restoreWakeListening(); return true; },
  audio: async () => {
    const ctx = window.__orb && window.__orb.audioCtx;
    if (ctx && ctx.state !== "running") { try { await ctx.resume(); } catch (e) { return false; } }
    return true;
  }
};
// Whether the wake word is SUPPOSED to be armed — the difference between
// "switched off" (DISABLED) and "stopped working" (FAILED).
Object.defineProperty(window, "__wakeExpected", { get: () => wakeOn && !voiceHidden(), configurable: true });

function restoreWakeListening() {
  if (meetingVoiceActive()) {
    showMeetingPhaseUi(meetingSession);
    return;
  }
  if (voiceHidden()) {
    window.__wakeLive = false;
    return;
  }
  if (recording || talkStarting || speaking) return;
  if (wakeOn) {
    orb.setStatus("listening");
    // keep a pending yes/no question visible — it's the most important status
    setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Listening for “" + wakePhrase() + "…”");
    void resumeWake();
  } else {
    orb.setStatus("idle");
    setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Click the mic to speak");
  }
}

async function abortFollowUp({ endConversation = false, resumeWakeAfter = false } = {}) {
  if (endConversation) conversationLive = false;
  followUpGeneration++;
  if (followUpAbort) {
    try { followUpAbort.abort(); } catch (e) {}
  }
  if (!meetingVoiceActive() &&
      (followUpCaptureOpen || followUpStarting) &&
      (localWakeRunning() || wakeStarting)) {
    await stopLocalWake();
  }
  if (resumeWakeAfter && wakeOn && !meetingVoiceActive() &&
      !voiceHidden() && !recording && !talkStarting && !speaking && !busy) {
    restoreWakeListening();
  }
}

function canStartFollowUp() {
  return wakeOn && conversationLive && followUpEnabled && !voiceHidden() &&
    !recording && !talkStarting && !busy && !speaking &&
    !ttsPlaying && !ttsQueue.length && !wakeCapturing && !followUpInFlight &&
    !meetingVoiceActive() && localWakeRunning();
}

async function afterSpeak() {
  stopBargeIn();
  speaking = false;
  // A stale audio onended/error callback can land after meeting capture claimed
  // the mic. It must not stop the orb, resume wake detection, or open follow-up.
  if (meetingVoiceActive()) {
    showMeetingPhaseUi(meetingSession);
    return;
  }
  if (recording || talkStarting) return; // user already barged in — don't clobber the live mic UI
  orb.stopAudio();
  micStream = null; // stopAudio killed the tracks; resumeWake must reacquire
  if (followUpInFlight || followUpStarting) return;
  if (!wakeOn || !conversationLive || !followUpEnabled || voiceHidden() || busy) {
    if (conversationLive && (!wakeOn || !followUpEnabled || voiceHidden() || busy)) conversationLive = false;
    restoreWakeListening();
    return;
  }

  // A mic-tap turn temporarily stops the local engine for exclusive access.
  // Bring it back before applying the localWakeRunning() capture guard.
  const generation = followUpGeneration;
  followUpStarting = true;
  try {
    if (!localWakeRunning()) await resumeWake();
    if (generation !== followUpGeneration) return;
    if (canStartFollowUp()) {
      void followUpListen();
      return;
    }
    conversationLive = false; // no local engine means no safe follow-up window
  } finally {
    followUpStarting = false;
  }
  restoreWakeListening();
}

// ---- persistence + settings ----
const CONV_KEY = "artemisConversationV1";
const SETTINGS_KEY = "artemisSettingsV3";
const LEGACY_SETTINGS_KEY = "artemisSettingsV2";
let settings = loadSettings();
function loadSettings() {
  try {
    const current = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (current) {
      return { voice: current.voice || "voicebox", tone: current.tone || "balanced" };
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY) || "{}");
    // One-time V2 → V3 migration intentionally selects the locally cloned voice.
    // The old tone survives, and every previous provider remains in the picker.
    return { voice: "voicebox", tone: legacy.tone || "balanced" };
  } catch (e) {
    return { voice: "voicebox", tone: "balanced" };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}
saveSettings();
function saveConversation() {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(conversation.slice(-20))); } catch (e) {}
}
function restoreConversation() {
  try {
    const arr = JSON.parse(localStorage.getItem(CONV_KEY) || "[]");
    if (!Array.isArray(arr)) return;
    arr.forEach((m) => {
      conversation.push({
        role: m.role,
        content: m.content,
        sources: m.sources,
        mailUntrusted: m.role === "assistant" && m.mailUntrusted === true
      });
      addMsg(m.role === "user" ? "user" : "artemis", m.content, m.sources);
    });
    // hand the last few turns to the cockpit so its command log isn't blank on
    // reload (cockpit.js loads after this module, so stash it on a global)
    window.__artemisHistory = arr.slice(-6).map((m) => ({ role: m.role, content: m.content }));
  } catch (e) {}
}

// ---- thinking indicator ----
let thinkTimer = null;
function startThinking() {
  let n = 0;
  setLiveStatus("Artemis is thinking");
  thinkTimer = setInterval(() => {
    n = (n + 1) % 4;
    setLiveStatus("Artemis is thinking" + ".".repeat(n));
  }, 420);
}
function stopThinking() {
  if (thinkTimer) {
    clearInterval(thinkTimer);
    thinkTimer = null;
  }
}

// ---- "open a website" intent (browser opens URLs in new tabs only) ----
// A local shortcut that skips the round-trip for a plain "open <site>". It used
// to announce "Opening X." unconditionally — including when the pop-up was
// blocked and nothing had actually opened, which is the same lie the server side
// of this bug told. It now reports what really happened. (It does not re-ask the
// server on a block: the one-tap Open pill is already on screen, and a second
// pass would queue a duplicate open.)
function handleOpenIntent(text) {
  if (meetingVoiceActive()) return false;
  const r = resolveOpenIntent(text);
  if (!r) return false;
  // new tab if pop-ups are allowed, else the one-tap Open pill (never this tab)
  const opened = openUrl(r.url, r.label);
  const phrase = opened ? `Opening ${r.label}.` : `My pop-up was blocked — tap Open and I'll bring up ${r.label}.`;
  addMsg("user", text);
  addMsg("artemis", phrase, [{ title: `Open ${r.label}`, url: r.url }]);
  conversation.push({ role: "user", content: text });
  conversation.push({ role: "assistant", content: phrase });
  saveConversation();
  orb._ensureAudio();
  speak(phrase);
  return true;
}

// ---- confirm-before-act: intercept the user's yes/no for a pending action ----
let pendingConfirm = null;
let confirmCompletionGeneration = 0;
// WAITING is a real Core state: while a yes/no gate is open, that IS what
// Artemis is doing. Called after every assignment rather than replacing them —
// the confirm gate is delicate and this stays purely additive. setPendingConfirm
// early-returns when nothing changed, so calling it liberally is free.
function syncConfirmToCore() {
  if (orb.setPendingConfirm) orb.setPendingConfirm(!!pendingConfirm);
  // Mirror the approval to the floating pill so it can surface Allow/Deny. The
  // pill is presentation only; the real gate stays here (ArtemisConfirm).
  try {
    presencePub.setPending(pendingConfirm
      ? { name: pendingConfirm.name, prompt: pendingConfirmPrompt || pendingConfirm.name }
      : null);
  } catch (e) {}
}
let pendingConfirmPrompt = "";
function cancelPendingConfirmation() {
  if (!pendingConfirm) return;
  const pendingAction = pendingConfirm;
  pendingConfirm = null;
  pendingConfirmPrompt = "";
  syncConfirmToCore();
  fetch("/api/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmId: pendingAction.confirmId, decision: "no" })
  }).catch(() => {});
}

function handleConfirmIfPending(text) {
  if (!pendingConfirm) return false;
  // Repeating the pending action's verb IS consent: replying "delete them" to
  // "shall I move these to trash?" previously counted as ambiguous, cancelled
  // the confirmation, and re-ran the command — an infinite loop from the
  // user's side.
  const pa = pendingConfirm;
  const decision = confirmationDecision(text, pa.name);
  const yes = decision === "yes";
  const no = decision === "no";
  pendingConfirm = null;
  syncConfirmToCore();
  if (!yes && !no) {
    // Ambiguous is NOT consent and NOT refusal — and it must not cancel.
    // The old path cancelled the pending action and re-ran the words as a
    // fresh command; the model, now on a free chat turn, would happily
    // NARRATE the action as done ("deleted!") while nothing happened.
    // First ambiguity: keep the confirmation alive and ask again plainly.
    // Second in a row: cancel out loud, then treat the text as a command.
    if (!pa.ambiguousOnce) {
      pa.ambiguousOnce = true;
      pendingConfirm = pa;
      syncConfirmToCore();
      addMsg("user", text);
      const reprompt = "Just to be safe — is that a yes or a no?";
      addMsg("artemis", reprompt);
      speak(reprompt);
      return true;
    }
    fetch("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: pa.confirmId, decision: "no" })
    }).catch(() => {});
    addMsg("artemis", "Okay, I've cancelled that.");
    speak("Okay, I've cancelled that.");
    // Consume the utterance entirely: handing it to the model here is how a
    // cancelled delete became a cheerfully narrated fake success.
    return true;
  }
  addMsg("user", text);
  orb._ensureAudio();
  // hold the turn: the /api/confirm POST can send an email / take seconds, and
  // without busy a mic click or a wake command would start an overlapping turn
  busy = true;
  const completionGeneration = ++confirmCompletionGeneration;
  const completionMeetingGeneration = meetingGeneration;
  const ownsCompletion = () =>
    completionGeneration === confirmCompletionGeneration &&
    completionMeetingGeneration === meetingGeneration &&
    !meetingVoiceActive();
  if (wakeOn) pauseWakeForSpeech();
  orb.setStatus("thinking");
  setLiveStatus(yes ? "On it…" : "Cancelling…");
  fetch("/api/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmId: pa.confirmId, decision: yes ? "yes" : "no" })
  })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || "Confirm failed.");
      return data;
    })
    .then((d) => {
      if (!ownsCompletion()) return;
      const reply = d.reply || (yes ? "Done." : "Cancelled.");
      addMsg("artemis", reply);
      conversation.push({ role: "assistant", content: reply });
      saveConversation();
      applyClientActions(d.clientActions);
      setLiveStatus("");
      speak(reply);
    })
    .catch(() => {
      if (!ownsCompletion()) return;
      setLiveStatus("Confirm failed.");
      const reply = "I couldn't verify that action completed.";
      addMsg("artemis", reply);
      conversation.push({ role: "assistant", content: reply });
      saveConversation();
      speak(reply);
    })
    .finally(() => {
      if (completionGeneration === confirmCompletionGeneration &&
          completionMeetingGeneration === meetingGeneration) {
        busy = false;
      }
    });
  return true;
}

// Cockpit confirm buttons ([EXECUTE]/[ABORT] on the CONFIRM card) resolve the
// SAME pending action as the spoken yes/no — one gate, two inputs.
window.ArtemisConfirm = (yes, confirmId) => {
  if (!pendingConfirm) return false;
  if (confirmId && pendingConfirm.confirmId && pendingConfirm.confirmId !== confirmId) return false;
  hud("log", "you", yes ? "confirm (button)" : "abort (button)");
  return handleConfirmIfPending(yes ? "yes" : "no");
};

// ---- streaming reply accumulator (DOM-optional: voice-only has no transcript) ----
function addAssistantStreaming() {
  let buf = "";
  let bubble = null;
  if (transcript) {
    const row = document.createElement("div");
    row.className = "t-msg t-artemis";
    const who = document.createElement("span");
    who.className = "t-who";
    who.textContent = "Artemis";
    bubble = document.createElement("div");
    bubble.className = "t-bubble";
    row.appendChild(who);
    row.appendChild(bubble);
    transcript.appendChild(row);
    transcript.scrollTop = transcript.scrollHeight;
  }
  return {
    append(t) {
      buf += t;
      if (bubble) { bubble.textContent = buf; transcript.scrollTop = transcript.scrollHeight; }
    },
    set(t) { buf = t; if (bubble) bubble.textContent = t; },
    text() { return buf; },
    setSources() {} // sources are spoken/omitted in voice-only mode
  };
}

// strip markdown/symbols so the voice never reads "**", "#", backticks, etc. aloud
function cleanForSpeech(s) {
  return (s || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) -> text
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")    // `code` -> code
    .replace(/[*_#~>|]+/g, " ")               // bold/italic/headers/quotes/tables
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "") // emoji
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---- sentence-chunked TTS pipeline (gapless: each chunk's audio is prefetched as a
// blob the moment it's queued, so the next sentence is ready to play with no pause) ----
let ttsQueue = [];
let ttsPlaying = false;
let sentenceBuf = "";
let ttsObjUrl = null;
let firstChunkPending = true; // FASTER: get the first words out asap, then settle into sentences
function fetchTtsBlob(text) {
  return fetch(ttsUrl(text)).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
}
function resetTtsPipe() {
  ttsGeneration++;
  ttsQueue = [];
  sentenceBuf = "";
  firstChunkPending = true;
  try { ttsEl.pause(); } catch (e) {}
  ttsEl.onended = ttsEl.onerror = null;
  if (ttsObjUrl) { try { URL.revokeObjectURL(ttsObjUrl); } catch (e) {} ttsObjUrl = null; }
  ttsPlaying = false;
}
function feedTts(t) {
  if (meetingVoiceActive()) return;
  sentenceBuf += t;
  if (voiceboxVoiceSelected()) {
    const split = takeVoiceboxChunks(sentenceBuf, { firstChunkPending });
    sentenceBuf = split.remainder;
    firstChunkPending = split.firstChunkPending;
    for (const chunk of split.chunks) enqueueTts(chunk);
    return;
  }
  let m;
  while ((m = sentenceBuf.match(/^([\s\S]*?[.!?…]+["')\]]?)(\s|$)/))) {
    const sent = m[1] + (m[2] || "");
    sentenceBuf = sentenceBuf.slice(sent.length);
    enqueueTts(sent);
  }
  // FASTER: the very first chunk goes out on the first clause boundary (comma /
  // dash / colon) or ~40 chars, so she starts speaking ~a second sooner instead
  // of waiting for a full sentence. Only the first chunk — the rest stay whole.
  if (firstChunkPending && sentenceBuf.length) {
    let cut = -1;
    const clause = sentenceBuf.match(/^[\s\S]{14,}?[,—:;-]\s/);
    if (clause) cut = clause[0].length;
    else if (sentenceBuf.length > 40) { const sp = sentenceBuf.lastIndexOf(" ", 40); if (sp > 18) cut = sp + 1; }
    if (cut > 0) { enqueueTts(sentenceBuf.slice(0, cut)); sentenceBuf = sentenceBuf.slice(cut); }
  }
  if (sentenceBuf.length > 150) {
    let cut = sentenceBuf.lastIndexOf(", ");
    if (cut < 50) cut = sentenceBuf.lastIndexOf(" ");
    if (cut > 40) {
      enqueueTts(sentenceBuf.slice(0, cut + 1));
      sentenceBuf = sentenceBuf.slice(cut + 1);
    }
  }
}
function flushTts() {
  if (meetingVoiceActive()) { sentenceBuf = ""; return; }
  if (voiceboxVoiceSelected()) {
    const split = takeVoiceboxChunks(sentenceBuf, { firstChunkPending, flush: true });
    sentenceBuf = split.remainder;
    firstChunkPending = split.firstChunkPending;
    for (const chunk of split.chunks) enqueueTts(chunk);
    return;
  }
  const r = sentenceBuf.trim();
  sentenceBuf = "";
  if (r) enqueueTts(r);
}
function enqueueTts(text) {
  if (meetingVoiceActive()) return;
  text = cleanForSpeech(text);
  if (text) {
    firstChunkPending = false; // once anything is queued, revert to whole-sentence chunks
    ttsQueue.push({
      text,
      generation: ttsGeneration,
      blobP: fetchTtsBlob(text)
    }); // start fetching NOW (overlaps playback)
    pumpTts();
  }
}
async function pumpTts() {
  if (meetingVoiceActive()) {
    resetTtsPipe();
    speaking = false;
    return;
  }
  if (ttsPlaying || !ttsQueue.length) return;
  const generation = ttsGeneration;
  ttsPlaying = true;
  const item = ttsQueue.shift();
  if (item.generation !== generation) {
    ttsPlaying = false;
    return;
  }
  // Exactly-once advance for this clip. A decode error can fire BOTH the
  // play() rejection and the element's async error event — without the guard
  // that spawned two interleaved pump loops fighting over ttsEl. And every
  // exit path must end the turn when the queue is dry, or `speaking` sticks
  // true forever and the wake word never restarts.
  const settle = () => {
    if (settle.done || generation !== ttsGeneration) return;
    settle.done = true;
    ttsPlaying = false;
    if (ttsQueue.length) { pumpTts(); return; }
    if (busy) return; // stream still generating — more sentences are coming
    speaking = false;
    afterSpeak();
  };
  try {
    pauseWakeForSpeech();
    orb.connectMediaElement(ttsEl);
    orb.setStatus("speaking");
    speaking = true;
    startBargeIn(generation); // listen for you to interrupt
    const blob = await item.blobP; // usually already resolved → no gap before this clip
    // Capture may have started while this fetch was in flight.
    if (generation !== ttsGeneration || meetingVoiceActive()) return;
    if (!blob) { settle(); return; } // fetch failed → skip clip, still end the turn
    if (ttsObjUrl) { try { URL.revokeObjectURL(ttsObjUrl); } catch (e) {} }
    ttsObjUrl = URL.createObjectURL(blob);
    ttsEl.onended = ttsEl.onerror = settle;
    ttsEl.src = ttsObjUrl;
    ttsEl.currentTime = 0;
    await ttsEl.play();
  } catch (e) {
    settle();
  }
}

// ---- conversation (streaming) ----
let currentAbort = null;
window.__ask = (t) => ask(t); // debug/test handle (used by preview verification)

// ---- typed command line (cockpit) — same pipeline as voice ----
const cmdForm = $("cmdForm");
const cmdInput = $("cmdInput");
if (cmdForm && cmdInput) {
  cmdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = cmdInput.value.trim();
    if (!t) return;
    cmdInput.value = "";
    orb._ensureAudio(); // Enter is a gesture — unlocks audio for the spoken reply
    if (handleConfirmIfPending(t)) return;
    if (recording || talkStarting) return;
    ask(t);
  });
  // "/" focuses the command line from anywhere (unless already typing somewhere)
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== cmdInput && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) {
      e.preventDefault();
      cmdInput.focus();
    }
  });
}
async function ask(text) {
  text = (text || "").trim();
  if (!text || busy || meetingVoiceActive()) return;
  const shownText = text;

  // A pending welcome offer is answered locally. The daily-brief marker turns a
  // bare yes into the normal executable command; legacy news text still plays
  // directly. A no dismisses either, and any other command supersedes the offer.
  if (window.__pendingBriefing) {
    const held = window.__pendingBriefing;
    if (/^(yes|yeah|yep|sure|ok(ay)?|please( do)?|go ahead|do it|absolutely|why not|let'?s hear( it)?|tell me)\b/i.test(text)) {
      window.__pendingBriefing = null;
      if (held && typeof held === "object" && held.command) {
        text = String(held.command).trim();
      } else {
        hud("log", "you", text);
        hud("log", "artemis", held.length > 120 ? held.slice(0, 117) + "…" : held);
        orb._ensureAudio();
        speak(held);
        return;
      }
    }
    if (/^(no( thanks| thank you)?|nope|nah|not now|later|skip|maybe later)\b/i.test(text)) {
      window.__pendingBriefing = null;
      hud("log", "you", text);
      orb._ensureAudio();
      speak("Very well, sir.");
      return;
    }
    window.__pendingBriefing = null; // a real command outranks the offer
  }

  busy = true;
  if (wakeOn) pauseWakeForSpeech();
  addMsg("user", shownText);
  hud("log", "you", shownText);
  conversation.push({ role: "user", content: text });
  if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
  saveConversation();
  orb.setStatus("thinking");
  startThinking();
  resetTtsPipe();
  const out = addAssistantStreaming();
  let gotToken = false;
  let finalSources = null;
  let pendingAction = null;
  let clientActions = null;
  let toolsUsed = null;
  let mailUntrusted = false;
  const t0 = performance.now(); // real time-to-first-word for the HUD
  const turnMeetingGeneration = meetingGeneration;
  const turnAbort = new AbortController();
  currentAbort = turnAbort;
  const ownsTurn = () =>
    turnMeetingGeneration === meetingGeneration &&
    currentAbort === turnAbort &&
    !meetingVoiceActive();
  // The server tells us what kind of turn this is (intent_pending) before it
  // invokes the model. Until that arrives the class is unknown — and unknown
  // means SILENT. Speaking "let me check" on a turn that turns out to execute
  // nothing is exactly how she used to sound busy while doing nothing.
  let intentClass = null;
  // The shared UI state (alive.js) tracks turns through these events — same
  // validated SSE lifecycle, no second stream. Every event carries this
  // stream's own key so a late event from an aborted turn can never be
  // attributed to the newer one.
  const turnKey = (window.__artemisTurnKey = (window.__artemisTurnKey || 0) + 1);
  window.dispatchEvent(new CustomEvent("artemis-turn", { detail: { phase: "begin", key: turnKey } }));
  const turnEvent = (event, data) =>
    window.dispatchEvent(new CustomEvent("artemis-turn", { detail: { phase: "event", key: turnKey, event, data } }));
  const execTimer = setTimeout(() => {
    if (!busy || gotToken || !ownsTurn()) return;
    hud("state", "executing");
    hud("log", "status", "running tools…");
    // Show the wait, never announce it. See shouldSpeakFiller.
    orb.setStatus("thinking");
    setLiveStatus("Working…");
  }, 1200);
  const timer = setTimeout(() => {
    try { turnAbort.abort(); } catch (e) {}
  }, 60000);
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation, tone: settings.tone }),
      signal: turnAbort.signal
    });
    if (!ownsTurn()) return;
    if (!res.ok || !res.body) throw new Error("no stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ownsTurn()) {
        try { await reader.cancel(); } catch (e) {}
        return;
      }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = chunk.split("\n");
        const evLine = lines.find((l) => l.startsWith("event:"));
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!evLine || !dataLine) continue;
        const event = evLine.slice(6).trim();
        let data = {};
        try { data = JSON.parse(dataLine.slice(5).trim()); } catch (e) {}
        if (event === "intent_pending") {
          intentClass = data.intent || null;
          hud("log", "status", "intent: " + intentClass);
          turnEvent(event, data);
        } else if (event === "interpreting") {
          // The contextual interpreter is resolving the utterance against the
          // live screen — show the thought, don't speak it.
          hud("log", "status", "understanding…");
          setLiveStatus("Understanding…");
          turnEvent(event, data);
        } else if (event === "tool") {
          hud("tool", data);
          orb.toolEvent(data);
          // The dashboard reuses the exact validated SSE lifecycle that drives
          // the orb; it never opens a second stream or guesses that a tool ran.
          window.dispatchEvent(new CustomEvent("artemis-tool", { detail: { ...data, turnKey } }));
        } else if (event === "mail_taint") {
          // Monotonic within the turn: provenance must survive even if the
          // stream drops before terminal metadata.
          mailUntrusted = true;
        } else if (event === "token") {
          if (!gotToken) {
            gotToken = true;
            stopThinking();
            setLiveStatus("");
            clearTimeout(execTimer);
            const ttfw = performance.now() - t0;
            hud("ttfw", ttfw); // real, measured, this turn
            turnEvent("token", {}); // first token only — the state cares, not the text
            // Share it with the server so the HUD gauge and the logs quote the
            // same number instead of each keeping a private one.
            fetch("/api/telemetry/ttfw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ms: ttfw }) }).catch(() => {});
          }
          out.append(data.t);
          feedTts(data.t);
        } else if (event === "reset") {
          out.set("");
          resetTtsPipe();
          gotToken = false;
        } else if (event === "done") {
          finalSources = data.sources;
          pendingAction = data.pendingAction || null;
          clientActions = data.clientActions || null;
          toolsUsed = data.toolsUsed || null;
          mailUntrusted = mailUntrusted || data.mailUntrusted === true;
          turnEvent(event, data);
        } else if (event === "error") {
          turnEvent(event, data);
          setLiveStatus(data.error || "Chat failed.");
          hud("state", "error");
          hud("log", "error", data.error || "chat failed");
          // Speak it. Silence reads as "she didn't hear me", so the user
          // repeats themselves at a machine that already gave up.
          if (data.spoken) { out.append(data.spoken); feedTts(data.spoken); gotToken = true; }
        }
      }
    }
    // A fresh explicit voice phrase may have interrupted this older stream and
    // claimed meeting capture. Its late terminal metadata must not install a
    // stale confirmation, open a URL, append model output, or restart TTS.
    if (!ownsTurn()) return;
    stopThinking();
    if (toolsUsed && toolsUsed.length) {
      toolsUsed.forEach((t) => hud("log", "tool", t + " ✓"));
    }
    const replyText = out.text();
    if (replyText) {
      out.setSources(finalSources);
      conversation.push({
        role: "assistant",
        content: replyText,
        sources: finalSources,
        mailUntrusted
      });
      saveConversation();
      flushTts();
      hud("log", "artemis", replyText.length > 120 ? replyText.slice(0, 117) + "…" : replyText);
    }
    if (finalSources && finalSources.length) {
      hud("context", { title: "SOURCES", links: finalSources.slice(0, 5) });
    }
    if (pendingAction) {
      pendingConfirm = pendingAction;
      pendingConfirmPrompt = replyText || pendingAction.name;
      syncConfirmToCore();
      setLiveStatus("Say “yes” to confirm, or “no” to cancel.");
      hud("log", "confirm", "awaiting your yes / no");
      hud("context", { title: "CONFIRM REQUIRED", lines: [replyText || pendingAction.name], confirm: true, confirmId: pendingAction.confirmId });
    }
    // execute anything Artemis chose to open (maps location, a site, etc.)
    // + render structured tool panels (e.g. the inbox) as context cards
    applyClientActions(clientActions);
    // pump may have drained while the stream was still marked busy. Defer the
    // terminal decision until finally clears busy so a pending-confirm reply
    // opens its follow-up window and a bare "yes" is accepted.
    if (!ttsPlaying && !ttsQueue.length) { speaking = false; queueMicrotask(afterSpeak); }
  } catch (e) {
    if (!ownsTurn()) return;
    stopThinking();
    resetTtsPipe();
    setLiveStatus(
      turnAbort.signal.aborted ? "Stopped." : "Couldn't reach the server — try again."
    );
    hud("state", "error");
    hud("log", "error", turnAbort.signal.aborted ? "stopped by user" : "couldn't reach the server");
    afterSpeak();
  } finally {
    clearTimeout(timer);
    clearTimeout(execTimer);
    // The shared UI state must see every turn end — including fetch failures
    // and aborts that never produced a server `done`. Idempotent by design.
    turnEvent("done", {});
    if (currentAbort === turnAbort) {
      currentAbort = null;
      busy = false;
    }
  }
}

// ---- push-to-talk (mic → STT → ask) ----
let mediaRecorder = null;
let chunks = [];
let micStream = null;
let talkMeetingGeneration = 0;

let assistantMuted = false;
function setAssistantMuted(on) {
  assistantMuted = !!on;
  if (assistantMuted) {
    if (recording) stopTalk();
    pauseWakeForSpeech();
    setLiveStatus("Muted.");
  } else if (wakeOn) {
    void resumeWake();
    setLiveStatus("");
  }
  try { presencePub.publish({ muted: assistantMuted }); } catch (e) {}
}

async function startTalk({ suppressClosingAck = false } = {}) {
  if (assistantMuted || busy || recording || talkStarting || meetingVoiceActive()) return;
  wakeStartGeneration++;
  talkStarting = true;
  const turnMeetingGeneration = meetingGeneration;
  talkMeetingGeneration = turnMeetingGeneration;
  talkSuppressClosingAck = suppressClosingAck;
  await abortFollowUp({ endConversation: true });
  if (meetingVoiceActive() || turnMeetingGeneration !== meetingGeneration) {
    talkStarting = false;
    talkSuppressClosingAck = false;
    return;
  }
  stopBargeIn(); // we're recording now — no need for the barge-in listener
  // manual recording needs EXCLUSIVE mic access — a second stream on the same
  // device can come back silent (iPhone). resumeWake() restarts the engine.
  if (localWakeRunning() || wakeStarting) await stopLocalWake();
  if (meetingVoiceActive() || turnMeetingGeneration !== meetingGeneration) {
    talkStarting = false;
    talkSuppressClosingAck = false;
    return;
  }
  orb._ensureAudio(); // unlock audio in this gesture
  try {
    // stop the wake-mode viz stream first — overwriting it leaks a live mic
    // (browser "mic in use" indicator never clears)
    if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {} micStream = null; }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (meetingVoiceActive() || turnMeetingGeneration !== meetingGeneration) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      micStream = null;
      talkStarting = false;
      talkSuppressClosingAck = false;
      return;
    }
  } catch (e) {
    talkStarting = false;
    talkSuppressClosingAck = false;
    if (turnMeetingGeneration !== meetingGeneration) return;
    window.__micDenied = true;
    setLiveStatus("Microphone permission denied.");
    restoreWakeListening();
    return;
  }
  orb.connectMic(micStream); // orb reacts to YOUR voice
  orb.setStatus("listening");
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
  chunks = [];
  openLiveStt(); // words appear AS you speak (falls back to batch if unavailable)
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      chunks.push(e.data); // always kept — batch STT is the safety net
      liveSendChunk(e.data);
    }
  };
  mediaRecorder.onstop = onTalkStop;
  mediaRecorder.start(250); // 250ms slices feed the live stream
  recording = true;
  talkStarting = false;
  micToggle.classList.add("recording");
  setLiveStatus("Listening… click to send");
}

// ---- live streaming transcript (server relay → Deepgram live) ----
// The transcript builds word-by-word in the HUD while you're still talking.
// If the relay can't start (offline, no key) everything silently degrades to
// the batch /api/stt path that has always worked.
let liveSid = null;
let liveEs = null;
let liveFinal = "";
let liveDoneResolve = null;
let livePending = []; // chunks recorded before the session opened (incl. the webm header)
let liveSendQ = Promise.resolve(); // serializes chunk POSTs — parallel fetches can arrive OUT OF ORDER

async function openLiveStt() {
  const turnMeetingGeneration = talkMeetingGeneration;
  liveFinal = "";
  liveSid = null;
  livePending = [];
  liveSendQ = Promise.resolve();
  try {
    const r = await fetch("/api/stt/live/start", { method: "POST" });
    if (!r.ok) return;
    const { sid } = await r.json();
    if (turnMeetingGeneration !== meetingGeneration ||
        meetingVoiceActive() || (!recording && !mediaRecorder)) {
      // The relay session exists server-side already; close it even though this
      // stale manual turn must not attach an EventSource or touch meeting UI.
      fetch("/api/stt/live/stop?sid=" + sid, { method: "POST" }).catch(() => {});
      return;
    }
    liveSid = sid;
    // Flush everything recorded before the session was ready — IN ORDER, so
    // Deepgram gets a valid webm stream starting with its header chunk. Without
    // this, a slow /start (common over wifi/LAN) silently drops the first words
    // of the command and only the tail ("…please") ever gets transcribed.
    const backlog = livePending; livePending = [];
    for (const b of backlog) liveSendChunk(b);
    const eventSource = new EventSource("/api/stt/live/events?sid=" + sid);
    liveEs = eventSource;
    let interim = "";
    eventSource.onmessage = (ev) => {
      if (turnMeetingGeneration !== meetingGeneration || meetingVoiceActive()) {
        try { eventSource.close(); } catch (e) {}
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.done) {
        if (liveDoneResolve) { liveDoneResolve(liveFinal.trim()); liveDoneResolve = null; }
        return;
      }
      if (m.final) {
        if (m.t) liveFinal += (liveFinal ? " " : "") + m.t;
        interim = "";
      } else {
        interim = m.t || "";
      }
      const shown = (liveFinal + " " + interim).trim();
      if (shown) {
        hud("live", shown);
        setLiveStatus("“" + (shown.length > 90 ? "…" + shown.slice(-87) : shown) + "”");
      }
      if (m.speechFinal && liveDoneResolve) {
        liveDoneResolve(liveFinal.trim());
        liveDoneResolve = null;
      }
    };
    eventSource.onerror = () => {}; // relay hiccup → batch fallback still runs
  } catch (e) { /* no live transcript this turn — batch handles it */ }
}
function liveSendChunk(blob) {
  if (!liveSid) { if (livePending.length < 120) livePending.push(blob); return; } // hold until the session opens
  const sid = liveSid; // capture: the chain may run after closeLiveStt nulls liveSid
  // chain, don't fire-and-forget: the browser runs parallel POSTs on ~6 sockets
  // and they can ARRIVE REORDERED — shuffled webm = garbled/partial transcript
  liveSendQ = liveSendQ.then(() =>
    fetch("/api/stt/live/chunk?sid=" + sid, { method: "POST", body: blob, keepalive: true }).catch(() => {})
  );
}
function closeLiveStt() {
  const sid = liveSid;
  liveSid = null;
  if (!sid) return Promise.resolve("");
  return new Promise((resolve) => {
    liveDoneResolve = resolve;
    // drain the chunk queue BEFORE signalling stop — otherwise CloseStream can
    // beat the final audio chunks to the server and the last words get eaten
    liveSendQ.then(() =>
      fetch("/api/stt/live/stop?sid=" + sid, { method: "POST" }).catch(() => {})
    );
    // don't hold the turn hostage: Deepgram flushes finals fast or not at all
    setTimeout(() => {
      if (liveDoneResolve) { liveDoneResolve(liveFinal.trim()); liveDoneResolve = null; }
    }, 700);
  }).finally(() => {
    if (liveEs) { try { liveEs.close(); } catch (e) {} liveEs = null; }
    hud("liveDone");
  });
}

// ---- speech-to-text transport ----------------------------------------------
// One audio contract for BOTH providers: 16 kHz mono signed-16-bit PCM. The
// browser already has the decoder, so the single decode/resample happens here
// and neither the local engine nor Deepgram needs a transcode. Web Audio's
// OfflineAudioContext works with the network down, which is the whole point.
let __sttStatus = null;
let __sttStatusAt = 0;
async function sttStatus() {
  if (__sttStatus && Date.now() - __sttStatusAt < 15000) return __sttStatus;
  try {
    const r = await fetch("/api/stt/status", { cache: "no-store" });
    if (r.ok) { __sttStatus = await r.json(); __sttStatusAt = Date.now(); }
  } catch (e) { /* keep the last known answer */ }
  return __sttStatus;
}

async function blobToPcm16(blob, targetRate = 16000) {
  const bytes = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new Ctx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
  } finally {
    decodeCtx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.round(decoded.duration * targetRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OfflineCtx(1, frames, targetRate);   // mono, resampled once
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  const chan = rendered.getChannelData(0);
  const pcm = new Int16Array(chan.length);
  for (let i = 0; i < chan.length; i += 1) {
    const v = Math.max(-1, Math.min(1, chan[i]));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return pcm.buffer;
}

/** POST recorded audio to STT in whatever format the routed provider wants. */
async function postSttAudio(blob, type) {
  const status = await sttStatus();
  if (status && status.provider === null) {
    return { error: status.message || "No speech provider available.", transcript: "" };
  }
  if (status && status.wantsPcm) {
    try {
      const pcm = await blobToPcm16(blob, status.sampleRate || 16000);
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "audio/pcm;rate=" + (status.sampleRate || 16000) },
        body: pcm
      });
      return await res.json();
    } catch (e) {
      // Decoding failed (odd codec). In hybrid the compressed body still works;
      // in local-only it cannot, and the server says so honestly.
      if (status.cloudForbidden) return { error: "I couldn't transcribe that locally. Try again.", transcript: "" };
    }
  }
  const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": type }, body: blob });
  return await res.json();
}

async function onTalkStop() {
  const turnMeetingGeneration = talkMeetingGeneration;
  recording = false;
  const suppressClosingAck = talkSuppressClosingAck;
  talkSuppressClosingAck = false;
  micToggle.classList.remove("recording");
  const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
  mediaRecorder = null;
  const blob = new Blob(chunks, { type });
  chunks = [];
  orb.stopAudio();
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (turnMeetingGeneration !== meetingGeneration) {
    void closeLiveStt();
    if (meetingVoiceActive()) showMeetingPhaseUi(meetingSession);
    return;
  }
  if (!blob.size) {
    closeLiveStt();
    afterSpeak();
    return;
  }
  // prefer the STREAMED transcript (already on screen, zero extra latency);
  // fall back to the batch POST only when streaming produced nothing
  const streamed = await closeLiveStt();
  if (turnMeetingGeneration !== meetingGeneration) {
    if (meetingVoiceActive()) showMeetingPhaseUi(meetingSession);
    return;
  }
  if (streamed) {
    if (!dispatchUtterance(streamed, { suppressClosingAck })) {
      setLiveStatus("Didn't catch that — try again.");
      afterSpeak();
    }
    return;
  }
  setLiveStatus("Transcribing…");
  try {
    const data = await postSttAudio(blob, type);
    if (turnMeetingGeneration !== meetingGeneration) return;
    // Local and cloud transcripts enter the SAME dispatch — offline voice keeps
    // the full contextual/permission runtime, never a reduced command set.
    if (!dispatchUtterance(data.transcript, { suppressClosingAck })) {
      setLiveStatus(data.error || "Didn't catch that — try again.");
      afterSpeak();
    }
  } catch (e) {
    if (turnMeetingGeneration !== meetingGeneration) return;
    setLiveStatus("Transcription failed.");
    afterSpeak();
  }
}

function stopTalk() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

micToggle.addEventListener("click", () => {
  // During meeting capture the primary mic remains the truthful stop control.
  // Never fall through to startTalk(), which would close the shared local engine
  // and open the unrelated MediaRecorder pipeline.
  if (meetingVoiceActive()) {
    requestMeetingStop(meetingSession, "mic");
    return;
  }
  // barge-in: if Artemis is talking (or has speech queued/streaming), cut her off
  if (speaking || ttsPlaying || ttsQueue.length) {
    resetTtsPipe();
    speaking = false;
    orb.stopAudio();
    if (currentAbort) { try { currentAbort.abort(); } catch (e) {} }
    // the abort clears `busy` only on a later microtask — clear it NOW or
    // startTalk()'s busy-guard silently eats this click
    busy = false;
    stopThinking();
    startTalk({ suppressClosingAck: true });
    return;
  }
  // cancel a thinking turn
  if (busy && currentAbort) {
    try { currentAbort.abort(); } catch (e) {}
    return;
  }
  if (recording) stopTalk();
  else startTalk();
});

/**
 * Public barge-in hook — interrupt Artemis the moment the user starts speaking.
 *
 *   window.ArtemisBargeIn.interrupt()
 *
 * Cancels queued/playing TTS, aborts an in-flight reply stream, and releases
 * the orb's speaking state. The live mic pipeline already barges in on its own
 * (mic click / VAD via startBargeIn); this hook exists so OTHER surfaces — the
 * Brain page's future live mode, an external VAD, a hardware button — can wire
 * the same interruption without reaching into internals. Safe to call anytime.
 */
window.ArtemisBargeIn = {
  interrupt() {
    void abortFollowUp({ endConversation: true, resumeWakeAfter: true });
    stopBargeIn();
    resetTtsPipe();
    speaking = false;
    orb.stopAudio();
    if (currentAbort) { try { currentAbort.abort(); } catch (e) {} }
    busy = false;
    stopThinking();
    afterSpeak(); // settle the orb/status back to idle (or wake-listening)
  },
};

// ---- interrupt her, three ways ----------------------------------------------
// 1) keyboard: Escape (or Space, when you're not typing) stops her instantly.
// 2) the mic button already cuts her off + starts listening (barge-in above).
// 3) an opt-in "TALK OVER: ON" dock toggle enables hands-free VAD barge-in.
function isInterruptible() { return speaking || ttsPlaying || ttsQueue.length || busy; }
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (e.key === "Escape" || (e.key === " " && !typing)) {
    if (isInterruptible()) { e.preventDefault(); window.ArtemisBargeIn.interrupt(); setLiveStatus("Stopped."); }
  }
});
const bargeToggle = $("bargeToggle");
if (bargeToggle) {
  const label = () => { bargeToggle.textContent = "TALK OVER: " + (BARGE_IN_ENABLED ? "ON" : "OFF"); };
  bargeToggle.addEventListener("click", () => {
    BARGE_IN_ENABLED = !BARGE_IN_ENABLED;
    try { localStorage.setItem("artemisBargeIn", BARGE_IN_ENABLED ? "1" : "0"); } catch (e) {}
    if (BARGE_IN_ENABLED && speaking) startBargeIn();
    else if (!BARGE_IN_ENABLED) stopBargeIn();
    label();
  });
  label();
}

if (followUpToggle) {
  const label = () => {
    followUpToggle.classList.toggle("on", followUpEnabled);
    followUpToggle.textContent = "FOLLOW-UP: " + (followUpEnabled ? "ON" : "OFF");
  };
  followUpToggle.addEventListener("click", () => {
    followUpEnabled = !followUpEnabled;
    try { saveFollowUpEnabled(window.localStorage, followUpEnabled); } catch (e) {}
    label();
    if (!followUpEnabled) {
      void abortFollowUp({ endConversation: true, resumeWakeAfter: true });
    }
  });
  label();
}

// short rising blip + orb flash the instant a wake word fires (kills dead air)
function playEarcon({ soft = false } = {}) {
  try {
    const c = orb._ensureAudio();
    if (!c) return;
    const t = c.currentTime;
    const rise = soft ? 0.012 : 0.02;
    const sweep = soft ? 0.075 : 0.13;
    const fade = soft ? 0.11 : 0.2;
    const stop = soft ? 0.13 : 0.22;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(620, t);
    o.frequency.exponentialRampToValueAtTime(940, t + sweep);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(soft ? 0.05 : 0.14, t + rise);
    g.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + stop);
  } catch (e) {}
}

// ---- optional text input (removed in voice-only mode; guarded if absent) ----
const textForm = $("textForm");
const textInput = $("textInput");
if (textForm && textInput) {
  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = textInput.value.trim();
    if (!v || busy || meetingVoiceActive()) return;
    orb._ensureAudio();
    textInput.value = "";
    if (handleConfirmIfPending(v)) return;
    if (handleOpenIntent(v)) return;
    ask(v);
  });
}

// ---- wake word (browser speech recognition) ----
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
// Jarvis-style greetings spoken when you say just "Artemis"
const WAKE_ACKS = [
  "I'm here, sir.",
  "Yes, sir?",
  "What do you need, sir?",
  "How can I help, sir?",
  "At your service, sir.",
  "Listening, sir.",
  "Go ahead, sir.",
  "Standing by, sir.",
  "Right here, sir."
];
let wakeRec = null;
let wakeOn = false;
let wakeRunning = false;      // is the recognizer ACTUALLY live right now (onstart/onend)
let wakeRecStarting = false;  // start() returned, but onstart/onerror has not landed yet
let wakeVizStarting = false;  // browser wake visualization getUserMedia is pending
let wakeStartGeneration = 0;  // invalidates async engine/viz starts on mic-owner changes
let wakeRecStartGeneration = 0;
let wakeRecMeetingGeneration = 0;
let wakeArmed = false;        // true after "Artemis" with no command → next phrase is the command
let wakeArmedTimer = null;
let wakeWatchdog = 0;

// Start the recognizer safely — swallow "already started" / throttle errors.
function safeStartRec() {
  if (!wakeRec || wakeRunning || wakeRecStarting ||
      wakeVizStarting || !wakeOn || speaking || busy ||
      voiceHidden() ||
      meetingVoiceActive() || localWakeRunning()) return;
  try {
    wakeRecStartGeneration = wakeStartGeneration;
    wakeRecMeetingGeneration = meetingGeneration;
    wakeRecStarting = true;
    wakeRec.start();
  } catch (e) {
    wakeRecStarting = false; // already started, or throttled — the watchdog retries
  }
}
// Watchdog: Chrome's SpeechRecognition dies silently (network blip, long
// silence, throttled restart) and then she goes DEAF with no indication. This
// heartbeat guarantees it's alive whenever it should be — the real fix for
// "she stopped reacting". Only runs while wake is on and she's not talking.
function startWakeWatchdog() {
  if (wakeWatchdog) return;
  wakeWatchdog = setInterval(() => {
    if (wakeOn && !voiceHidden() && !wakeRunning && !speaking && !busy &&
        !meetingVoiceActive() && !localWakeRunning()) safeStartRec();
    // keep the live indicator honest
    if (wakeOn) {
      window.__wakeLive = !voiceHidden() && !meetingVoiceActive() &&
        ((localWakeRunning() && !speaking && !busy) ||
         (wakeRunning && !speaking && !busy));
    }
  }, 2500);
}
function stopWakeWatchdog() { if (wakeWatchdog) { clearInterval(wakeWatchdog); wakeWatchdog = 0; } window.__wakeLive = false; }
function disarmWake() {
  wakeArmed = false;
  if (wakeArmedTimer) { clearTimeout(wakeArmedTimer); wakeArmedTimer = null; }
}
function armWake() {
  wakeArmed = true;
  if (wakeArmedTimer) clearTimeout(wakeArmedTimer);
  wakeArmedTimer = setTimeout(() => {
    wakeArmed = false;
    if (wakeOn && !busy && !speaking && !meetingVoiceActive()) {
      setLiveStatus("Listening for “" + wakePhrase() + "…”");
    }
  }, 12000); // listen ~12s for the follow-up (the greeting eats a second or two)
}

function setWakeUi(on) {
  wakeOn = on;
  window.__artemisWakeOn = on;
  if (window.__dockOnWake) window.__dockOnWake(on); // wake ON keeps the dock expanded
  wakeToggle.classList.toggle("on", on);
  wakeToggle.textContent = on ? "WAKE WORD: ON" : "WAKE WORD: OFF"; // mono austerity, no emoji
  window.__artemisWakeUi = on; // cockpit telemetry footer reads this
  try { localStorage.setItem("artemisWakeOn", on ? "1" : "0"); } catch (e) {} // survives reloads
}

let localWakeCfg = null;    // { key, ready } from /api/status
let wakeStarting = false;   // re-entrancy guard: the permission prompt takes a while

// Strips a leading wake phrase off a transcript. The alternatives come from the
// profile because every wake word gets misheard differently — the recognizer
// hears "gervais" for Jarvis and "artist" for Artemis, and a list tuned for one
// is useless for the other.
function wakePrefixRe() {
  const alias = activeWakeProfile().aliasPattern || "(artemis)";
  return new RegExp(`^\\s*(hey|hi|ok(?:ay)?|a)?[,.\\s]*${alias}\\b[,.!?\\s]*`, "i");
}

// The active wake phrase comes from the VERIFIED profile the engine actually
// loaded — never from a constant here. Displaying one phrase while the engine
// listens for another is worse than displaying nothing: the user says the wrong
// words and concludes she's broken.
//
// Before the engine starts there is still copy to render, so the manifest is
// resolved once at boot and cached here. Every display string interpolates this
// — no view in this repo may spell a wake phrase out literally, which is exactly
// the mistake that shipped a UI saying "Hey Jarvis" at a "Hey Artemis" model.
let resolvedWakePhrase = FALLBACK_PROFILE.phrase;
function wakePhrase() { return localWakeRunning() ? activeWakeProfile().phrase : resolvedWakePhrase; }

// Static copy marks its slot with <span data-wake-phrase>; this fills them all.
// Re-run whenever the engine adopts a profile, so the page can never keep a
// phrase the engine has since rolled back from.
function fillWakePhrase() {
  const phrase = wakePhrase();
  document.querySelectorAll("[data-wake-phrase]").forEach((el) => { el.textContent = phrase; });
}
fillWakePhrase();
resolveWakeProfile({ onWarn: (m) => console.info("[wake] " + m) })
  .then((r) => {
    resolvedWakePhrase = (r && r.profile && r.profile.phrase) || FALLBACK_PROFILE.phrase;
    fillWakePhrase();
  })
  .catch(() => { /* the built-in phrase is already showing */ });

function scrubWakePrefix(text) {
  return String(text || "").replace(wakePrefixRe(), "").trim();
}

function currentMeeting(session) {
  return !!session && meetingSession === session && session.generation === meetingGeneration;
}

function meetingWordCount(session) {
  let count = 0;
  for (const [seq, text] of session.transcripts) {
    if (seq >= session.cutoffSeq) continue;
    const words = String(text || "").trim().match(/\S+/g);
    if (words) count += words.length;
  }
  return count;
}

function meetingElapsedMinutes(session) {
  if (!session.startedAt) return 0;
  return Math.max(0, Math.floor((performance.now() - session.startedAt) / 60000));
}

function showMeetingRecordingUi(session) {
  if (!currentMeeting(session) || session.phase !== "capturing") return;
  const minutes = meetingElapsedMinutes(session);
  const words = meetingWordCount(session);
  orb.setStatus("listening");
  micToggle.classList.add("recording");
  micToggle.setAttribute("aria-label", "Stop meeting notes");
  setLiveStatus(
    `Recording meeting notes… ${minutes} min, ${words} words — tap mic or say “stop taking notes”`
  );
  window.__wakeLive = false;
  if (window.__dockOnWake) window.__dockOnWake(true);
}

function showMeetingStartingUi(session) {
  if (!currentMeeting(session) || session.phase !== "starting") return;
  orb.setStatus("listening");
  micToggle.classList.add("recording");
  micToggle.setAttribute("aria-label", "Stop meeting notes");
  setLiveStatus("Opening meeting microphone… tap the mic to cancel");
  window.__wakeLive = false;
  if (window.__dockOnWake) window.__dockOnWake(true);
}

function showMeetingPhaseUi(session) {
  if (!currentMeeting(session)) return;
  if (session.phase === "capturing") {
    showMeetingRecordingUi(session);
  } else if (session.phase === "starting") {
    showMeetingStartingUi(session);
  } else if (session.phase === "stopping") {
    setLiveStatus("Finishing meeting notes…");
  } else if (session.phase === "finalizing") {
    orb.setStatus("thinking");
    setLiveStatus("Structuring and saving meeting notes…");
  }
  window.__wakeLive = false;
}

function clearMeetingTimers(session) {
  if (session.deadlineTimer) {
    clearTimeout(session.deadlineTimer);
    session.deadlineTimer = 0;
  }
  if (session.minuteTimer) {
    clearInterval(session.minuteTimer);
    session.minuteTimer = 0;
  }
}

function setMeetingControlsLocked(session, locked) {
  if (locked) {
    session.wakeToggleWasDisabled = wakeToggle.disabled;
    session.followUpToggleWasDisabled = followUpToggle ? followUpToggle.disabled : false;
    wakeToggle.disabled = true;
    if (followUpToggle) followUpToggle.disabled = true;
    return;
  }
  wakeToggle.disabled = session.wakeToggleWasDisabled;
  if (followUpToggle) followUpToggle.disabled = session.followUpToggleWasDisabled;
}

function requestMeetingStop(session, reason) {
  if (!currentMeeting(session)) return Promise.resolve();
  if (session.phase === "stopping" || session.phase === "finalizing") {
    return session.stopPromise || Promise.resolve();
  }

  session.stopReason = reason || "stop";
  session.phase = "stopping";
  clearMeetingTimers(session);
  window.__wakeLive = false;
  setLiveStatus("Finishing meeting notes…");
  hud("log", "status", `notes: stopping (${session.stopReason})`);
  if (session.cancelLocalStart) session.cancelLocalStart();
  session.preserveActiveCapture = [
    "mic",
    "page hidden",
    "30 minute limit",
  ].includes(session.stopReason);

  // stopLocalWake is the existing capture cancellation seam. It closes the
  // shared mic immediately and optionally returns the already-buffered partial.
  session.stopPromise = stopLocalWake({
    preserveCapture: session.preserveActiveCapture,
  }).catch(() => {});
  return session.stopPromise;
}

async function transcribeMeetingChunk(session, seq, wav) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEETING_STT_TIMEOUT_MS);
  session.sttControllers.set(seq, controller);
  try {
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "STT failed");
    if (!currentMeeting(session)) return;

    const raw = typeof data.transcript === "string" ? data.transcript.trim() : "";
    if (!raw) return;

    // Match on a scrubbed copy only. The actual transcript remains verbatim and
    // is never sent through dispatchUtterance or added to model conversation.
    if (isMeetingStopPhrase(scrubWakePrefix(raw))) {
      session.cutoffSeq = Math.min(session.cutoffSeq, seq);
      for (const [otherSeq, otherController] of session.sttControllers) {
        if (otherSeq > session.cutoffSeq) otherController.abort();
      }
      for (const otherSeq of session.transcripts.keys()) {
        if (otherSeq >= session.cutoffSeq) session.transcripts.delete(otherSeq);
      }
      requestMeetingStop(session, "spoken phrase");
      return;
    }

    if (seq < session.cutoffSeq) {
      session.transcripts.set(seq, raw);
      showMeetingRecordingUi(session);
    }
  } catch (e) {
    if (currentMeeting(session) && !controller.signal.aborted) {
      hud("log", "error", `notes: chunk ${seq + 1} transcription failed`);
    }
  } finally {
    clearTimeout(timeout);
    session.sttControllers.delete(seq);
  }
}

function launchMeetingStt(session, seq, wav) {
  const task = transcribeMeetingChunk(session, seq, wav);
  session.sttTasks.set(seq, task);
  // The task owns its error handling. Removing it only after settlement retains
  // a bounded promise for finalization without retaining the WAV afterward.
  void task.finally(() => {
    if (session.sttTasks.get(seq) === task) session.sttTasks.delete(seq);
  });
}

async function meetingCaptureLoop(session) {
  while (currentMeeting(session) && session.phase === "capturing") {
    const remaining = session.deadlineAt - performance.now();
    if (remaining <= 0) {
      requestMeetingStop(session, "30 minute limit");
      break;
    }

    const captureStarted = performance.now();
    const wav = await captureCommand({
      // Reusing the wake pre-roll in a loop duplicates the previous utterance.
      preRollMs: 0,
      waitForSpeechMs: Math.min(MEETING_WAIT_FOR_SPEECH_MS, remaining),
      onLevel: (rms) => {
        if (!currentMeeting(session) || session.phase !== "capturing") return;
        orb.feed(Math.min(1, rms * 10));
        // AudioWorklet frames remain a useful deadline backstop when background
        // timer throttling delays the wall-clock timeout.
        if (performance.now() >= session.deadlineAt) {
          requestMeetingStop(session, "30 minute limit");
        }
      },
    });

    if (!currentMeeting(session)) break;
    if (session.phase !== "capturing") {
      if (session.phase === "stopping" &&
          session.preserveActiveCapture && wav) {
        const seq = session.nextSeq++;
        launchMeetingStt(session, seq, wav);
      }
      break;
    }
    if (!wav) {
      // Ordinary silence consumes the configured wait and simply reopens. An
      // immediate null means the engine stopped or another capture stole the
      // single capResolve owner; fail closed instead of spinning.
      const immediate = performance.now() - captureStarted < 250;
      if (!localWakeRunning() || immediate) {
        session.captureError = "The local microphone engine stopped.";
        requestMeetingStop(session, "capture unavailable");
        break;
      }
      continue;
    }

    const seq = session.nextSeq++;
    // Do not await STT here. finishCapture left the engine idle, so the next
    // loop iteration must reclaim mode="capture" before network work completes.
    launchMeetingStt(session, seq, wav);
  }
}

async function restoreEngineAfterMeeting(session) {
  // The normal post-TTS/visibility path restores the saved wake preference via
  // resumeWake(), including its local-to-browser fallback. Here only ensure a
  // meeting-owned local engine cannot survive when wake was originally off.
  if (session.localCaptureStarted && !session.wakeWasOn && localWakeRunning()) {
    await stopLocalWake();
  }
}

async function startMeetingLocalWake(session) {
  if (localWakeRunning()) return true;
  let timeout = 0;
  let cancel;
  const cancelled = new Promise((resolve) => {
    cancel = () => resolve(false);
  });
  session.cancelLocalStart = cancel;
  const boundedStart = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), MEETING_LOCAL_START_TIMEOUT_MS);
  });
  try {
    const ok = await Promise.race([
      startLocalWake(localWakeCfg, onLocalWake),
      cancelled,
      boundedStart,
    ]);
    if (!ok) await stopLocalWake();
    return ok === true;
  } finally {
    clearTimeout(timeout);
    if (session.cancelLocalStart === cancel) session.cancelLocalStart = null;
  }
}

async function saveMeetingTranscript(session, transcriptText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEETING_SAVE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptText }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Meeting save failed");
    const reply = typeof data.reply === "string" && data.reply.trim()
      ? data.reply.trim()
      : "I saved the meeting notes.";
    const candidate = data.pendingAction;
    const pendingAction = candidate &&
      typeof candidate.confirmId === "string" &&
      candidate.name === "set_meeting_reminders"
      ? candidate
      : null;
    // The reply may contain transcript-derived action text and the server marks
    // it mailUntrusted. It is intentionally not appended to conversation/model
    // history; it is only displayed and spoken to the user who supplied it.
    return { reply, pendingAction };
  } finally {
    clearTimeout(timeout);
  }
}

function waitForMeetingReleaseTick() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function releaseCompetingMicsForMeeting(session) {
  pauseWakeForSpeech();
  if (wakeRec && wakeRunning) {
    try { wakeRec.stop(); } catch (e) {}
  }

  // Normally the queueMicrotask handoff lets the originating local-wake or
  // follow-up turn clear these owners first. If a different stale voice result
  // claimed meeting mode, explicitly settle its capture before taking capResolve.
  const ownerDeadline = performance.now() + 500;
  while (currentMeeting(session) && session.phase === "starting" &&
         (wakeCapturing || followUpInFlight || followUpStarting) &&
         performance.now() < ownerDeadline) {
    await waitForMeetingReleaseTick();
  }
  if (!currentMeeting(session) || session.phase !== "starting") return;
  if (wakeCapturing || followUpCaptureOpen) {
    await stopLocalWake();
  }
  const ownerCloseDeadline = performance.now() + 1000;
  while (currentMeeting(session) && session.phase === "starting" &&
         (wakeCapturing || followUpInFlight || followUpStarting) &&
         performance.now() < ownerCloseDeadline) {
    await waitForMeetingReleaseTick();
  }
  if (!currentMeeting(session) || session.phase !== "starting") return;
  if (wakeCapturing || followUpInFlight || followUpStarting) {
    throw new Error("another voice capture did not close");
  }

  // A stale browser-wake result can claim meeting mode while a manual mic tap
  // is still acquiring or stopping its MediaRecorder. Wait for that existing
  // cleanup path rather than opening a second input stream.
  const manualDeadline = performance.now() + 3000;
  while (currentMeeting(session) && session.phase === "starting" &&
         (recording || talkStarting || liveEs ||
          (mediaRecorder && mediaRecorder.state !== "inactive")) &&
         performance.now() < manualDeadline) {
    if (recording) stopTalk();
    await waitForMeetingReleaseTick();
  }
  if (!currentMeeting(session) || session.phase !== "starting") return;
  if (recording || talkStarting || liveEs ||
      (mediaRecorder && mediaRecorder.state !== "inactive")) {
    throw new Error("manual microphone did not close");
  }

  const browserDeadline = performance.now() + 1500;
  while (currentMeeting(session) && session.phase === "starting" &&
         (wakeRunning || wakeRecStarting || wakeVizStarting) &&
         performance.now() < browserDeadline) {
    await waitForMeetingReleaseTick();
  }
  if (!currentMeeting(session) || session.phase !== "starting") return;
  if (wakeRunning || wakeRecStarting || wakeVizStarting) {
    throw new Error("browser wake microphone did not close");
  }

  // Release the browser wake visualization/manual stream before the local
  // AudioWorklet engine acquires exclusive ownership.
  if (micStream) {
    try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    micStream = null;
  }
  orb.stopAudio();
}

async function finalizeMeetingCapture(session) {
  if (!currentMeeting(session) || session.finalizeStarted) return;
  session.finalizeStarted = true;
  session.phase = "finalizing";
  clearMeetingTimers(session);

  if (session.stopPromise) await session.stopPromise;
  micToggle.classList.remove("recording");
  micToggle.setAttribute("aria-label", session.micAriaLabel || "Talk to Artemis");
  orb.setStatus("thinking");
  setLiveStatus("Structuring and saving meeting notes…");

  // Every STT request is individually bounded, so finalization cannot be held
  // forever by a missing early sequence.
  await Promise.allSettled(Array.from(session.sttTasks.values()));
  const transcriptText = Array.from(session.transcripts.entries())
    .filter(([seq]) => seq < session.cutoffSeq)
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("\n")
    .trim();

  let reply;
  let groupedPending = null;
  if (session.startError) {
    reply = "I couldn't start meeting capture because the local microphone engine isn't available.";
  } else if (session.captureError && !transcriptText) {
    reply = "The microphone stopped before I could save any meeting notes.";
  } else if (!transcriptText) {
    reply = "I didn't catch any meeting notes to save.";
  } else {
    try {
      const saved = await saveMeetingTranscript(session, transcriptText);
      reply = saved.reply;
      groupedPending = saved.pendingAction;
    } catch (e) {
      reply = "I couldn't save the meeting notes.";
    }
  }

  await restoreEngineAfterMeeting(session);
  if (!currentMeeting(session)) return;

  setMeetingControlsLocked(session, false);
  meetingSession = null;
  conversationLive = !!groupedPending;
  if (groupedPending) {
    pendingConfirm = groupedPending;
    pendingConfirmPrompt = "Set the grouped meeting reminders?";
    syncConfirmToCore();
    hud("log", "confirm", "meeting reminders awaiting your yes / no");
    hud("context", {
      title: "CONFIRM REQUIRED",
      lines: ["Set the grouped meeting reminders?"],
      confirm: true,
      confirmId: groupedPending.confirmId
    });
  }
  addMsg("artemis", reply);
  hud("log", "artemis", reply.length > 120 ? reply.slice(0, 117) + "…" : reply);
  if (document.hidden) {
    deferredMeetingReply = reply;
    orb.setStatus("idle");
    setLiveStatus(groupedPending
      ? "Meeting notes saved — return to Artemis to confirm the reminders."
      : "Meeting capture finished — return to Artemis for details.");
    return;
  }
  orb._ensureAudio();
  speak(reply);
}

async function runMeetingCapture(session) {
  try {
    // Browser SpeechRecognition also has restart callbacks; meeting guards below
    // keep it dormant while this explicit session owns the microphone.
    await releaseCompetingMicsForMeeting(session);
    if (!currentMeeting(session) || session.phase !== "starting") return;
    const localWasRunning = localWakeRunning();
    if (!localWakeRunning()) {
      const ok = await startMeetingLocalWake(session);
      if (!currentMeeting(session) || session.phase !== "starting") return;
      if (!ok) throw new Error("local capture unavailable");
    }
    session.localCaptureStarted = !localWasRunning;

    if (!currentMeeting(session) || session.phase !== "starting") {
      await stopLocalWake();
      return;
    }

    session.phase = "capturing";
    hud("log", "status", "notes: recording started");
    showMeetingRecordingUi(session);
    await meetingCaptureLoop(session);
  } catch (e) {
    if (currentMeeting(session)) {
      const message = e && e.message ? e.message : "capture unavailable";
      const captureBegan = session.phase === "capturing";
      if (captureBegan) session.captureError = message;
      else session.startError = message;
      requestMeetingStop(session, captureBegan ? "capture failed" : "start failed");
    }
  } finally {
    if (currentMeeting(session) &&
        session.phase !== "stopping" &&
        session.phase !== "finalizing") {
      requestMeetingStop(session, "capture ended");
    }
    if (currentMeeting(session) && session.stopPromise) await session.stopPromise;
    if (currentMeeting(session)) await finalizeMeetingCapture(session);
  }
}

function beginMeetingCapture() {
  if (meetingVoiceActive()) {
    setLiveStatus("Already taking meeting notes.");
    return false;
  }
  if (document.hidden) {
    hud("log", "error", "notes: open the Artemis tab before recording");
    return false;
  }

  const claimedAt = performance.now();
  const session = {
    generation: ++meetingGeneration,
    phase: "starting",
    wakeWasOn: wakeOn,
    micAriaLabel: micToggle.getAttribute("aria-label"),
    wakeToggleWasDisabled: false,
    followUpToggleWasDisabled: false,
    deadlineTimer: 0,
    minuteTimer: 0,
    deadlineAt: claimedAt + MEETING_MAX_MS,
    startedAt: claimedAt,
    stopPromise: null,
    stopReason: null,
    startError: null,
    captureError: null,
    cancelLocalStart: null,
    localCaptureStarted: false,
    preserveActiveCapture: false,
    finalizeStarted: false,
    nextSeq: 0,
    cutoffSeq: Number.POSITIVE_INFINITY,
    transcripts: new Map(),
    sttTasks: new Map(),
    sttControllers: new Map(),
  };
  meetingSession = session;
  wakeStartGeneration++;
  confirmCompletionGeneration++;
  session.deadlineTimer = setTimeout(
    () => requestMeetingStop(session, "30 minute limit"),
    MEETING_MAX_MS
  );
  session.minuteTimer = setInterval(() => {
    if (!currentMeeting(session) || session.phase !== "capturing") return;
    const minutes = meetingElapsedMinutes(session);
    const words = meetingWordCount(session);
    hud("log", "status", `notes: ${minutes} min, ${words} words`);
    showMeetingRecordingUi(session);
  }, 60000);

  // Claim every competing voice loop synchronously. The actual async runner is
  // deferred so an originating wake/follow-up dispatcher reaches its finally
  // and releases wakeCapturing/followUpInFlight first.
  conversationLive = false;
  followUpGeneration++;
  disarmWake();
  if (followUpAbort) {
    try { followUpAbort.abort(); } catch (e) {}
  }
  cancelPendingConfirmation();
  if (recording) stopTalk();
  stopBargeIn();
  resetTtsPipe();
  speaking = false;
  if (currentAbort) {
    try { currentAbort.abort(); } catch (e) {}
  }
  currentAbort = null;
  busy = false;
  stopThinking();
  setMeetingControlsLocked(session, true);
  window.__wakeLive = false;
  showMeetingStartingUi(session);
  hud("log", "status", "notes: preparing local microphone");
  queueMicrotask(() => {
    if (currentMeeting(session) && session.phase === "starting") {
      void runMeetingCapture(session);
    }
  });
  return true;
}

// Every voice entry point lands here after STT. Keep the safety-sensitive
// ordering shared: scrub any captured wake prefix, then confirmation, local
// open intent, and finally the assistant.
function dispatchUtterance(text, { suppressClosingAck = false } = {}) {
  const command = scrubWakePrefix(text);
  // Meeting speech is consumed only by the capture loop. A stale wake/STT
  // completion — including a second exact start phrase — must not touch its UI
  // or become a normal assistant command.
  if (meetingVoiceActive()) return true;
  if (!command) return false;
  if (isMeetingStartPhrase(command)) {
    beginMeetingCapture();
    return true;
  }
  if (isClosingPhrase(command)) {
    conversationLive = false;
    cancelPendingConfirmation();
    const ttsActive = speaking || ttsPlaying || ttsQueue.length > 0;
    if (!suppressClosingAck && !ttsActive) speak("Done.");
    else if (!ttsActive) afterSpeak();
    return true;
  }
  conversationLive = true;
  setLiveStatus("");
  if (handleConfirmIfPending(command)) return true;
  if (!handleOpenIntent(command)) ask(command);
  return true;
}

// The LOCAL wake path: openWakeWord runs the classifier named by the VERIFIED
// manifest profile (whatever phrase that profile declares) entirely on-device
// (works on iPhone). On detection the ENGINE ITSELF captures the command from
// the same mic stream — including ~1.2s of pre-roll from before detection
// fired — so nothing you said is ever lost to a mic handoff. The WAV goes to
// batch STT (the reliable path); no MediaRecorder, no chunk streaming.
let wakeCapturing = false;
async function onLocalWake(ev) {
  if (ev && ev.error) {
    setLiveStatus("Wake audio stalled.");
    return;
  }
  if (assistantMuted) return;
  if (recording || talkStarting || busy || wakeCapturing ||
      followUpInFlight || meetingVoiceActive()) return; // already handling a turn
  const turnMeetingGeneration = meetingGeneration;
  const interruptedTts = speaking || ttsPlaying || ttsQueue.length > 0;
  if (interruptedTts) window.ArtemisBargeIn.interrupt(); // she was talking → interrupt
  wakeCapturing = true;
  // The bed drops to the capture level ONLY here — after the wake word fired
  // and while her command is actually being recorded. Merely being armed is
  // the resting state and must stay at full level.
  try { window.dispatchEvent(new CustomEvent("artemis-voice-state", { detail: "capturing" })); } catch (e) {}
  playEarcon();
  orb.feed(0.6);
  orb.setStatus("listening");
  setLiveStatus("Listening…");
  window.__wakeLive = false;
  try {
    const wav = await captureCommand({ onLevel: (rms) => orb.feed(Math.min(1, rms * 10)) });
    if (turnMeetingGeneration !== meetingGeneration) return;
    if (!wav) { setLiveStatus("Didn't catch that — try again."); afterSpeak(); return; }
    setLiveStatus("Transcribing…");
    const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    const data = await res.json();
    if (turnMeetingGeneration !== meetingGeneration) return;
    // the pre-roll may include the tail of the wake phrase; the shared
    // dispatcher scrubs it using the active profile's declared mishearings.
    if (!dispatchUtterance(data.transcript, { suppressClosingAck: interruptedTts })) {
      setLiveStatus("Didn't catch that — try again.");
      afterSpeak();
    }
  } catch (e) {
    if (turnMeetingGeneration !== meetingGeneration) return;
    setLiveStatus("Transcription failed.");
    afterSpeak();
  } finally {
    wakeCapturing = false;
    try { window.dispatchEvent(new CustomEvent("artemis-voice-state", { detail: "listening" })); } catch (e) {}
  }
}

function followUpStillCurrent(generation) {
  return generation === followUpGeneration && wakeOn && conversationLive &&
    followUpEnabled && !voiceHidden() && !recording && !talkStarting &&
    !busy && !speaking && !meetingVoiceActive() && localWakeRunning();
}

async function followUpListen() {
  if (!canStartFollowUp()) return false;
  const generation = ++followUpGeneration;
  let returnToWake = false;
  let sttAbort = null;
  followUpInFlight = true;
  followUpCaptureOpen = true;
  hud("log", "status", "follow-up: mic open — just talk (20s)");
  playEarcon({ soft: true });
  orb.feed(0.35);
  orb.setStatus("listening");
  setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Listening…");
  window.__wakeLive = false;

  try {
    // A 20-SECOND WALL-CLOCK WINDOW, not "20s unless the room makes a sound".
    // Any noise above the speech threshold starts a capture; 1.1s of quiet
    // then finishes it with an empty transcript — and ending the conversation
    // on that blip is why the window felt like it never lasted. Blips loop;
    // only true silence for the REMAINING time (or a real utterance) exits.
    const deadline = performance.now() + 20000;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 500) {
        conversationLive = false;
        returnToWake = true;
        return false;
      }
      const wav = await captureCommand({
        waitForSpeechMs: remaining,
        onLevel: (rms) => orb.feed(Math.min(1, rms * 10))
      });
      followUpCaptureOpen = false;
      if (!followUpStillCurrent(generation)) return false;
      if (!wav) {
        conversationLive = false;
        returnToWake = true;
        hud("log", "status", "follow-up: closed (silence) — say \u201c" + wakePhrase() + "\u201d");
        return false;
      }

      setLiveStatus("Transcribing…");
      sttAbort = new AbortController();
      followUpAbort = sttAbort;
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        signal: sttAbort.signal
      });
      const data = await res.json();
      if (!followUpStillCurrent(generation)) return false;
      const text = scrubWakePrefix(data.transcript);
      if (!text) {
        // noise blip, not a command — reopen quietly within the same window
        followUpCaptureOpen = true;
        setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Listening…");
        continue;
      }
      if (!dispatchUtterance(text)) {
        conversationLive = false;
        returnToWake = true;
        return false;
      }
      return true;
    }
  } catch (e) {
    if (generation === followUpGeneration) {
      conversationLive = false;
      setLiveStatus("Transcription failed.");
      returnToWake = true;
    }
    return false;
  } finally {
    if (followUpAbort === sttAbort) followUpAbort = null;
    followUpCaptureOpen = false;
    followUpInFlight = false;
    if (returnToWake && generation === followUpGeneration &&
        !recording && !talkStarting && !speaking && !busy) {
      restoreWakeListening();
    }
  }
}

async function startWakeLocal(
  expectedWakeGeneration = wakeStartGeneration,
  expectedMeetingGeneration = meetingGeneration
) {
  if (voiceHidden() || meetingVoiceActive()) return false;
  wakeStarting = true;
  orb._ensureAudio();
  const ok = await startLocalWake(localWakeCfg, onLocalWake);
  wakeStarting = false;
  if (expectedWakeGeneration !== wakeStartGeneration ||
      expectedMeetingGeneration !== meetingGeneration ||
      meetingVoiceActive()) {
    if (ok) pauseLocalWake();
    return false;
  }
  if (!ok) return false;
  setWakeUi(true);
  orb.setStatus("listening");
  setLiveStatus(`● Listening for “${activeWakeProfile().phrase}…”  (on-device)`);
  fillWakePhrase(); // the engine may have adopted a different profile than boot resolved
  window.__wakeLive = true;
  return true;
}

async function acquireBrowserWakeViz({ allowWakeOff = false } = {}) {
  if (wakeVizStarting) return false;
  const turnMeetingGeneration = meetingGeneration;
  const turnWakeStartGeneration = wakeStartGeneration;
  let stream = null;
  let accepted = false;
  wakeVizStarting = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (turnMeetingGeneration !== meetingGeneration ||
        turnWakeStartGeneration !== wakeStartGeneration ||
        voiceHidden() || meetingVoiceActive() || localWakeRunning() ||
        speaking || busy || recording || talkStarting ||
        (!allowWakeOff && !wakeOn)) {
      return false;
    }
    if (micStream && micStream !== stream) {
      try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    }
    micStream = stream;
    orb.connectMic(stream);
    accepted = true;
    return true;
  } catch (e) {
    return false;
  } finally {
    wakeVizStarting = false;
    if (!accepted && stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      if (micStream === stream) micStream = null;
    }
  }
}

async function startWake({ resumeBrowser = false } = {}) {
  if (voiceHidden() || (!resumeBrowser && wakeOn) ||
      wakeStarting || meetingVoiceActive()) return false;
  const turnMeetingGeneration = meetingGeneration;
  const turnWakeStartGeneration = wakeStartGeneration;
  // Prefer the reliable local engine when it's set up; else the browser recognizer.
  if (!resumeBrowser && localWakeCfg && localWakeCfg.ready) {
    if (await startWakeLocal(turnWakeStartGeneration, turnMeetingGeneration)) return true;
    if (turnWakeStartGeneration !== wakeStartGeneration ||
        turnMeetingGeneration !== meetingGeneration ||
        meetingVoiceActive()) return false;
    // on-device engine failed to load → fall through to the browser recognizer if present
  }
  if (!SpeechRec) {
    setLiveStatus("Wake word needs Chrome or Edge (or set up the on-device engine — see README).");
    if (resumeBrowser) setWakeUi(false);
    return false;
  }
  wakeStarting = true;
  orb._ensureAudio();
  // a viz mic so the orb reacts to your voice while waiting
  if (micStream) {
    try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    micStream = null;
  }
  await acquireBrowserWakeViz({ allowWakeOff: true });
  if (turnWakeStartGeneration !== wakeStartGeneration ||
      turnMeetingGeneration !== meetingGeneration ||
      voiceHidden() || meetingVoiceActive() ||
      speaking || busy || recording || talkStarting) {
    wakeStarting = false;
    return false;
  }
  wakeStarting = false;
  const recognizer = new SpeechRec();
  wakeRec = recognizer;
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = "en-US";
  recognizer.onresult = (e) => {
    if (wakeRec !== recognizer ||
        wakeRecStartGeneration !== wakeStartGeneration ||
        wakeRecMeetingGeneration !== meetingGeneration ||
        speaking || busy || voiceHidden()) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) handleWake(e.results[i][0].transcript);
    }
  };
  recognizer.onstart = () => {
    if (wakeRec !== recognizer) {
      try { recognizer.stop(); } catch (e) {}
      return;
    }
    wakeRecStarting = false;
    wakeRunning = true;
    if (wakeRecStartGeneration !== wakeStartGeneration ||
        wakeRecMeetingGeneration !== meetingGeneration ||
        !wakeOn || voiceHidden() ||
        meetingVoiceActive() || localWakeRunning()) {
      window.__wakeLive = false;
      // safeStartRec may have run one tick before meeting/local ownership was
      // claimed, while onstart was still pending and wakeRunning was false.
      // Shut that recognizer down as soon as the browser reports it live.
      try { recognizer.stop(); } catch (e) {}
      return;
    }
    window.__wakeLive = !speaking && !busy;
  };
  recognizer.onerror = (e) => {
    if (wakeRec !== recognizer) return;
    wakeRecStarting = false;
    if (wakeRecStartGeneration !== wakeStartGeneration ||
        wakeRecMeetingGeneration !== meetingGeneration) return;
    if (meetingVoiceActive()) return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
      // fatal: without stopping, onend would restart instantly → error → onend,
      // an infinite tight loop while the toggle claims the wake word is ON
      setLiveStatus(e.error === "audio-capture"
        ? "No microphone found for the wake word."
        : "Microphone blocked — allow mic access to use the wake word.");
      stopWake();
      return;
    }
    // 'no-speech' / 'aborted' / 'network' are transient — onend + the watchdog
    // bring it back, so we DON'T tear down (that was making her go deaf).
  };
  recognizer.onend = () => {
    if (wakeRec !== recognizer) return;
    wakeRecStarting = false;
    wakeRunning = false;
    window.__wakeLive = false;
    // restart shortly (a tiny delay avoids Chrome's "already started" throttle);
    // the watchdog is the backstop if this restart is dropped.
    if (wakeOn && !voiceHidden() && !speaking && !busy &&
        !meetingVoiceActive() && !localWakeRunning()) {
      setTimeout(safeStartRec, 300);
    }
  };
  setWakeUi(true);
  orb.setStatus("listening");
  setLiveStatus("● Listening for “" + wakePhrase() + "…”");
  startWakeWatchdog();
  safeStartRec();
  return true;
}

function stopWake() {
  if (meetingVoiceActive()) return;
  wakeStartGeneration++;
  setWakeUi(false);
  conversationLive = false;
  followUpGeneration++;
  if (followUpAbort) {
    try { followUpAbort.abort(); } catch (e) {}
  }
  disarmWake();
  stopWakeWatchdog();
  wakeRunning = false;
  wakeRecStarting = false;
  if (localWakeRunning() || wakeStarting) stopLocalWake();
  const recognizer = wakeRec;
  wakeRec = null;
  if (recognizer) {
    recognizer.onend = null; // don't auto-restart after an intentional stop
    try { recognizer.stop(); } catch (e) {}
  }
  orb.stopAudio();
  orb.setStatus("idle");
  setLiveStatus("Click the mic to speak");
}

function runWakeCommand(cmd, { suppressClosingAck = false } = {}) {
  if (meetingVoiceActive()) return;
  cmd = (cmd || "").trim();
  if (!cmd) return;
  disarmWake();
  pauseWakeForSpeech();
  orb.stopAudio(); // release viz mic before thinking/speaking
  micStream = null; // tracks are dead now — resumeWake must reacquire, not reuse
  dispatchUtterance(cmd, { suppressClosingAck });
}

function handleWake(raw) {
  if (meetingVoiceActive()) return;
  const w = matchWake(raw);
  let interruptedTts = false;
  // If she's mid-sentence when you say her name, that's an interrupt — stop her
  // and take the command, don't drop it. (Only a fresh wake word interrupts; a
  // stray armed follow-up while busy is still ignored to avoid double-runs.)
  if (busy || speaking) {
    if (w) {
      interruptedTts = speaking || ttsPlaying || ttsQueue.length > 0;
      window.ArtemisBargeIn.interrupt();
    }
    else return;
  }
  console.debug("[wake] heard:", raw); // open the console to see what was recognized
  window.__wakeHeard = (raw || "").trim();
  if (w) {
    playEarcon(); // instant chime the moment she catches her name
    orb.setStatus("listening");
    orb.feed(0.6);
    const cmd = (w.rest || "").trim();
    if (cmd) {
      runWakeCommand(cmd, { suppressClosingAck: interruptedTts }); // "Artemis, what's the weather" in one breath
    } else {
      // just "Artemis": arm for the follow-up AND speak a short ack. The ack
      // pauses the recogniser briefly; when it ends, resumeWake restarts it and
      // your next phrase is captured. (Say it after she answers, not over her.)
      armWake();
      const ack = WAKE_ACKS[Math.floor(Math.random() * WAKE_ACKS.length)];
      setLiveStatus(ack);
      speak(ack);
    }
    return;
  }
  // heard speech but no wake word — if we were just woken, it's the command;
  // otherwise surface what she heard so a mis-hear is VISIBLE, not silent.
  if (wakeArmed) {
    orb.feed(0.5);
    runWakeCommand(raw);
  } else if (wakeOn && window.__wakeHeard) {
    setLiveStatus("● Listening… (heard “" + window.__wakeHeard.slice(0, 36) + "”)");
  }
}

function pauseWakeForSpeech() {
  // Invalidate a browser recognizer whose start/result event is still queued.
  // Otherwise Artemis's own TTS could be heard as a fresh wake command.
  wakeStartGeneration++;
  window.__wakeLive = false;
  if (localWakeRunning()) { pauseLocalWake(); return; } // local engine: stop hearing during her speech
  if (wakeRec) {
    try { wakeRec.stop(); } catch (e) {} // onend fires → wakeRunning=false
  }
}
async function resumeWake() {
  if (!wakeOn || voiceHidden() || meetingVoiceActive()) return false;
  const turnWakeStartGeneration = wakeStartGeneration;
  const turnMeetingGeneration = meetingGeneration;
  if (localWakeRunning()) { resumeLocalWake(); window.__wakeLive = true; return true; } // local engine: re-arm detection
  if (localWakeCfg && localWakeCfg.ready) {
    if (await startWakeLocal(turnWakeStartGeneration, turnMeetingGeneration)) return true; // a manual talk stopped the engine — restart it
    if (turnWakeStartGeneration !== wakeStartGeneration ||
        turnMeetingGeneration !== meetingGeneration ||
        !wakeOn || meetingVoiceActive()) return false;
    // The preference is still ON, so a failed local restart must use the same
    // browser fallback as initial startup instead of leaving the UI "on" but deaf.
    return startWake({ resumeBrowser: true });
  }
  if (!wakeRec) return startWake({ resumeBrowser: true });
  // a stream whose tracks were stopped (orb.stopAudio) is useless — check
  // liveness, not just presence, or the orb never reacts after the 1st turn
  const live = micStream && micStream.getTracks().some((t) => t.readyState === "live");
  if (!live) {
    void acquireBrowserWakeViz();
  }
  // small delay so the just-stopped recognizer has fully ended before restart
  // (avoids the "already started" throttle); the watchdog is the backstop.
  setTimeout(safeStartRec, 250);
  return false;
}

wakeToggle.addEventListener("click", () => {
  if (meetingVoiceActive()) return;
  return wakeOn ? stopWake() : startWake();
});
window.__handleWake = handleWake; // debug/test handle (preview verification)

// Cockpit continuity: after the boot tap (a real gesture), re-arm the wake
// word automatically if it was ON last session — she's just listening again.
window.ArtemisArmWake = () => { if (!wakeOn && !meetingVoiceActive()) startWake(); };

// ---- hero CTAs + nav CTA (voice-first: tap = start talking) ----
function startTalkGesture() {
  orb._ensureAudio();
  if (!recording && !busy && !speaking && !meetingVoiceActive()) startTalk();
}
// The dock's mic is now the single primary "Talk to Artemis" CTA. Any legacy
// in-page talk buttons still start a turn if present, but the nav no longer
// duplicates the CTA (it links to the open-source repo instead).
const talkBtn = $("talkBtn");
if (talkBtn) talkBtn.addEventListener("click", startTalkGesture);

// "What can you do?" — Artemis explains herself out loud.
// A function, not a constant: the wake phrase is only known after the manifest
// resolves, so this must be built at speak time.
const explainerText = () =>
  `I'm Artemis — your voice-first AI. Tap the mic and talk, or flip on the wake word and say “${wakePhrase()}”. ` +
  "I reply in real time, and you can pick my voice and how blunt I am. " +
  "I search the web and read pages to answer with real sources, dig through Hacker News or GitHub when you want to go deeper, and open any site for you by voice. " +
  "I keep notes, remember your contacts, and can act on your behalf — drafting and sending messages — but anything that actually sends, pays, or changes something, I always confirm with you first. " +
  "So… what can I do for you?";
// CAPABILITIES: an animated overlay of every skill — the same data that
// labels the moons, so the two can never drift apart. Click a card to hear
// the example command; Esc or the backdrop closes it.
const explainBtn = $("explainBtn");
let skillsOverlay = null;
function toggleSkillsOverlay() {
  if (skillsOverlay) { skillsOverlay.remove(); skillsOverlay = null; return; }
  const ov = document.createElement("div");
  ov.className = "skills-overlay";
  const panel = document.createElement("div");
  panel.className = "skills-panel";
  panel.innerHTML = '<div class="skills-title">SKILLS · ' + MOON_INFO.length + ' ONLINE</div>';
  MOON_INFO.forEach((m, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skills-card";
    card.style.setProperty("--i", i);
    card.innerHTML =
      '<span class="skills-dot" data-moon="' + i + '"></span>' +
      '<span class="skills-name">' + m.title + '</span>' +
      '<span class="skills-what">' + m.what + '</span>' +
      '<span class="skills-say">“' + m.say + '”</span>';
    card.addEventListener("click", () => {
      hud("context", { title: m.title, lines: [m.what, "Try: " + m.say] });
    });
    panel.appendChild(card);
  });
  ov.appendChild(panel);
  ov.addEventListener("click", (e) => { if (e.target === ov) toggleSkillsOverlay(); });
  document.body.appendChild(ov);
  skillsOverlay = ov;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && skillsOverlay) toggleSkillsOverlay(); });
if (explainBtn) explainBtn.addEventListener("click", toggleSkillsOverlay);

// AGENTS: the sub-agent roster — orchestrator + every specialist, live from
// the server so the window can never drift from what actually runs.
let agentsOverlay = null;
async function toggleAgentsOverlay() {
  if (agentsOverlay) { agentsOverlay.remove(); agentsOverlay = null; return; }
  let data = null;
  try { data = await (await fetch("/api/agents", { cache: "no-store" })).json(); } catch (e) {}
  if (!data || !data.agents) return;
  const ov = document.createElement("div");
  ov.className = "skills-overlay";
  const panel = document.createElement("div");
  panel.className = "skills-panel";
  panel.innerHTML = '<div class="skills-title">SUB-AGENTS · 1 ORCHESTRATOR + ' + data.agents.length + " SPECIALISTS</div>";
  const all = [data.orchestrator, ...data.agents];
  all.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "skills-card";
    card.style.setProperty("--i", i);
    card.innerHTML =
      '<span class="skills-dot"></span>' +
      '<span class="skills-name">' + (a.title || a.family) + "</span>" +
      '<span class="skills-what">' + a.craft + "</span>" +
      '<span class="skills-say">' + a.tokens + " tokens per turn</span>";
    panel.appendChild(card);
  });
  ov.appendChild(panel);
  ov.addEventListener("click", (e) => { if (e.target === ov) toggleAgentsOverlay(); });
  document.body.appendChild(ov);
  agentsOverlay = ov;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && agentsOverlay) toggleAgentsOverlay(); });
const agentsBtn = $("agentsBtn");
if (agentsBtn) agentsBtn.addEventListener("click", toggleAgentsOverlay);

// ---- revenue celebrations (carried over; orb surges on a payment) ----
const CELEB_KEY = "artemisCelebratedV2";
function loadCeleb() {
  try {
    return JSON.parse(localStorage.getItem(CELEB_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}
function saveCeleb(rec) {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const t = {};
  Object.keys(rec).forEach((id) => {
    if ((rec[id] || 0) >= cutoff) t[id] = rec[id];
  });
  try { localStorage.setItem(CELEB_KEY, JSON.stringify(t)); } catch (e) {}
}
async function pollCelebrations() {
  let payments = [];
  try {
    const res = await fetch("/api/payments/recent?lookbackMs=" + 24 * 3600 * 1000);
    if (!res.ok) return;
    payments = (await res.json()).payments || [];
  } catch (e) {
    return;
  }
  const seen = loadCeleb();
  const fresh = payments
    .filter((p) => p && p.id && !seen[p.id])
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  if (!fresh.length) return;
  fresh.forEach((p) => (seen[p.id] = Date.now()));
  saveCeleb(seen);
  const cap = fresh.slice(0, 6);
  if (fresh.length > 6)
    console.info(`Artemis: replayed the 6 most recent of ${fresh.length} new payment(s); the rest are in history.`);
  cap.slice().reverse().forEach((p) => {
    if (typeof window.celebratePayment === "function") window.celebratePayment(p);
  });
}
setInterval(pollCelebrations, 5000);
pollCelebrations();

// ---- navbar blur + scroll reveals + floating CTA + background-orb fade ----
const nav = $("nav");
const floatCta = $("floatCta");
const sceneStage = $("sceneStage");
function onScroll() {
  const y = window.scrollY;
  if (nav) nav.classList.toggle("scrolled", y > 8); // cockpit has no #nav
  // reveal the floating CTA once the hero is mostly scrolled past
  if (floatCta) floatCta.classList.toggle("show", y > window.innerHeight * 0.6);
  // Fade the fixed hero-orb layer as you leave the hero so its rings + "ARTEMIS"
  // wordmark stop bleeding through the #brain / Proof text below. Full brightness
  // in the hero, down to a faint ambient glow past it (readability > ambiance).
  if (sceneStage) {
    const fade = Math.min(1, y / (window.innerHeight * 0.7));
    sceneStage.style.opacity = (1 - fade * 0.92).toFixed(3);
  }
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll(); // set correct state if the page loads already scrolled
if (floatCta) {
  floatCta.addEventListener("click", () => {
    document.getElementById("live").scrollIntoView({ behavior: "smooth", block: "center" });
    orb._ensureAudio();
    if (!recording && !busy) startTalk();
  });
}

// the persistent corner orb — a mini orbital HUD that follows you and reacts to her voice
const fcOrb = document.getElementById("fcOrb");
if (fcOrb) {
  const f = fcOrb.getContext("2d");
  const fdpr = Math.min(window.devicePixelRatio || 1, 2);
  const reducedFc = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  fcOrb.width = 24 * fdpr;
  fcOrb.height = 24 * fdpr;
  const ft0 = performance.now();
  function drawFcOrb() {
    if (!reducedFc) requestAnimationFrame(drawFcOrb);
    if (document.hidden && !reducedFc) return;
    const t = reducedFc ? 0 : (performance.now() - ft0) / 1000;
    const amp = orb.cur ? orb.cur.amp : 0;
    const S = 24, c = S / 2, R = 3.2 + amp * 1.6;
    f.setTransform(fdpr, 0, 0, fdpr, 0, 0);
    f.clearRect(0, 0, S, S);
    f.save(); f.translate(c, c); f.globalCompositeOperation = "lighter";
    const g = f.createRadialGradient(0, 0, 0, 0, 0, R * 2.4);
    g.addColorStop(0, PAL.Hl + (0.7 + amp * 0.3) + ")");
    g.addColorStop(0.5, PAL.O + "0.45)");
    g.addColorStop(1, PAL.O + "0)");
    f.fillStyle = g; f.beginPath(); f.arc(0, 0, R * 2.4, 0, Math.PI * 2); f.fill();
    f.fillStyle = PAL.B + "0.95)"; f.beginPath(); f.arc(0, 0, R * 0.7, 0, Math.PI * 2); f.fill();
    const defs = [{ rx: 9, ry: 3.4, tilt: 0.5, sp: 1.2 }, { rx: 6.5, ry: 6.5, tilt: -0.8, sp: -0.9 }];
    for (let k = 0; k < defs.length; k++) {
      const d = defs[k];
      f.save(); f.rotate(d.tilt);
      f.lineWidth = 1; f.strokeStyle = PAL.O + (0.4 + amp * 0.4) + ")";
      f.beginPath(); f.ellipse(0, 0, d.rx, d.ry, 0, 0, Math.PI * 2); f.stroke();
      const ph = t * d.sp + k * 2, px = Math.cos(ph) * d.rx, py = Math.sin(ph) * d.ry, dep = 0.5 + 0.5 * Math.sin(ph);
      f.fillStyle = PAL.Hl + (0.5 + 0.5 * dep) + ")";
      f.beginPath(); f.arc(px, py, 0.9 + 1.1 * dep, 0, Math.PI * 2); f.fill();
      f.restore();
    }
    f.restore();
  }
  requestAnimationFrame(drawFcOrb);
}

const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// upgrade the flat card/agent orbs into mini animated 3D orbital nodes
initMiniOrbs();

// ---- "The Brain" explanatory orb + pipeline stepper ----
// The orb is driven by a discrete state machine (wake→route→tool→respond) instead
// of audio. The stepper buttons drive it manually; until the user touches them it
// auto-plays the pipeline so the section reads as a live demo, not a static diagram.
(function initBrain() {
  const host = $("brainOrb");
  if (!host) return;
  const brain = new BrainOrb(host);
  window.__brain = brain;

  const stepBtns = Array.from(document.querySelectorAll(".brain-step"));
  const agentBtns = Array.from(document.querySelectorAll(".brain-agent"));
  const caption = $("brainCaption");
  const section = document.querySelector(".brain");

  // caption per step; {a} is replaced with the active sub-agent's name
  const CAPTIONS = [
    "You say <strong>“{w}.”</strong> The outer ring pulses as she wakes and starts listening.",
    "She reads your intent and <strong>routes</strong> it to {a} — that node lights up and links back to the core.",
    "{a} runs its <strong>tool</strong> — a web search, a draft, a lookup. Its node spins while the work runs.",
    "She composes the answer and <strong>speaks</strong> it — the core flares and a voice wave ripples outward."
  ];

  function setActive(list, idx) {
    list.forEach((b, i) => b.classList.toggle("is-active", i === idx));
  }
  function renderCaption() {
    if (!caption) return;
    // guarded lookups: an out-of-range step/agent must degrade, never throw
    const name = ["Research", "Email triage", "Messaging"][brain.agent] || "the agent";
    const tpl = CAPTIONS[brain.step] || CAPTIONS[0] || "";
    caption.innerHTML = tpl
      .replace(/\{a\}/g, "<strong>" + name + "</strong>")
      .replace(/\{w\}/g, wakePhrase());
  }
  function showStep(step) {
    brain.setStep(step);
    setActive(stepBtns, step);
    renderCaption();
  }
  function showAgent(idx) {
    brain.setAgent(idx);
    setActive(agentBtns, idx);
    renderCaption();
  }

  // auto-play the pipeline until the user interacts, then hand over control
  let manual = false;
  let timer = 0;
  function stopAuto() {
    if (manual) return;
    manual = true;
    clearInterval(timer);
    if (section) section.classList.add("is-manual");
  }
  function startAuto() {
    if (brain.reduced || manual) return; // reduced-motion: static, no auto-cycle
    timer = setInterval(() => {
      showStep((brain.step + 1) % 4);
    }, 2600);
  }

  stepBtns.forEach((b) => b.addEventListener("click", () => { stopAuto(); showStep(+b.dataset.step); }));
  agentBtns.forEach((b) => b.addEventListener("click", () => { stopAuto(); showAgent(+b.dataset.agent); }));

  renderCaption();

  // Under reduced motion the orb is static and the pipeline does NOT auto-advance,
  // so the "Auto-playing…" hint would be a lie — reword it to reflect manual control.
  const hintEl = section && section.querySelector(".brain-hint");
  if (brain.reduced && hintEl) hintEl.textContent = "Tap any step to walk through the pipeline.";

  // only start the auto-cycle once the section is actually seen
  if ("IntersectionObserver" in window) {
    const startIo = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { startAuto(); startIo.disconnect(); }
      });
    }, { threshold: 0.35 });
    startIo.observe(host);
  } else {
    startAuto();
  }

  // (the nav "The Brain" link now opens brain.html — the standalone page —
  // so the old #brain anchor-centering handler is gone)
})();

// ---- demo transcript: reveal lines in sequence, like a live exchange ----
(function initDemo() {
  const chat = $("demoChat");
  if (!chat) return;
  const lines = Array.from(chat.querySelectorAll(".demo-line"));
  const replay = $("demoReplay");
  const reduced = prefersReducedMotion();
  let timers = [];

  // STREAMING replies: Artemis's lines type out word-by-word, like TTS starting
  // before the full answer is composed. The bubble's leading text node is
  // wrapped so the source/action chips inside survive; chips fade in after.
  lines.forEach((l) => {
    if (!l.classList.contains("bot")) return;
    const bubble = l.querySelector(".demo-bubble");
    const first = bubble && bubble.firstChild;
    if (!first || first.nodeType !== 3) return; // expect a leading text node
    const span = document.createElement("span");
    span.className = "demo-typed";
    span.dataset.full = first.textContent.trim();
    span.textContent = span.dataset.full;
    bubble.replaceChild(span, first);
  });
  function typeLine(l) {
    const typed = l.querySelector(".demo-typed");
    if (!typed) return;
    const words = (typed.dataset.full || "").split(" ");
    const chips = Array.from(l.querySelectorAll(".demo-src, .demo-action"));
    chips.forEach((c) => (c.style.opacity = "0"));
    typed.textContent = "";
    words.forEach((w, i) => {
      timers.push(setTimeout(() => {
        typed.textContent += (i ? " " : "") + w;
        if (i === words.length - 1) chips.forEach((c) => { c.style.transition = "opacity 0.3s"; c.style.opacity = "1"; });
      }, 90 + i * 55)); // ~word cadence of streamed speech
    });
  }
  function showAll() {
    lines.forEach((l) => {
      l.classList.add("shown");
      const typed = l.querySelector(".demo-typed");
      if (typed) typed.textContent = typed.dataset.full; // full text, no typing
      l.querySelectorAll(".demo-src, .demo-action").forEach((c) => (c.style.opacity = "1"));
    });
  }
  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    if (reduced) { showAll(); return; } // no sequential motion under reduced-motion
    lines.forEach((l) => l.classList.remove("shown"));
    lines.forEach((l) => {
      timers.push(setTimeout(() => {
        l.classList.add("shown");
        if (l.classList.contains("bot")) typeLine(l);
      }, +l.dataset.delay || 0));
    });
  }
  if (replay) replay.addEventListener("click", play);

  // Optional spoken clip so "spoken out loud" is literally true. Off by default;
  // plays only when the user taps "Hear it spoken". Replays the transcript in sync,
  // and degrades gracefully if the audio asset is missing or blocked.
  const audio = $("demoAudio");
  const hearBtn = $("demoHear");
  if (audio && hearBtn) {
    const reset = () => { hearBtn.setAttribute("aria-pressed", "false"); hearBtn.textContent = "🔊 Hear it spoken"; };
    hearBtn.addEventListener("click", () => {
      if (!audio.paused) { audio.pause(); audio.currentTime = 0; return; }
      audio.currentTime = 0;
      play(); // re-run the transcript reveal alongside the voice
      const p = audio.play();
      if (p && p.catch) p.catch(() => { /* autoplay-blocked or missing file: no-op */ });
    });
    audio.addEventListener("play", () => { hearBtn.setAttribute("aria-pressed", "true"); hearBtn.textContent = "⏸ Stop"; });
    audio.addEventListener("pause", reset);
    audio.addEventListener("ended", reset);
    audio.addEventListener("error", () => { hearBtn.disabled = true; hearBtn.textContent = "🔇 Audio unavailable"; });
  }

  // play once when the section first scrolls into view
  if (reduced) {
    showAll();
  } else if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { play(); io.disconnect(); } });
    }, { threshold: 0.3 });
    io.observe(chat);
  } else {
    play();
  }
})();

// pause a section's CSS ambient loops once it scrolls fully offscreen
const pauseIo = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle("anim-paused", !e.isIntersecting)),
  { threshold: 0 }
);
document.querySelectorAll(".features, .team, .demo").forEach((el) => pauseIo.observe(el));

// Tear the voice stack down when no visible surface can vouch for an open
// microphone. Shared by the visibility handler and presentation-mode changes.
function suspendHiddenVoice() {
  conversationLive = false;
  wakeStartGeneration++;
  void abortFollowUp({ endConversation: true, resumeWakeAfter: false });
  stopBargeIn();
  if (localWakeRunning() || wakeStarting) void stopLocalWake();
  if (wakeRec) {
    try { wakeRec.stop(); } catch (e) {}
  }
  if (micStream) {
    try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    micStream = null;
  }
  window.__wakeLive = false;
}

// freeze every CSS animation while the tab is hidden (the orb's rAF already pauses)
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("tab-hidden", document.hidden);
  if (document.hidden && meetingVoiceActive()) {
    // The in-page orb/status can no longer make an open mic visible — the pill
    // has no meeting UI — so this closes and saves regardless of mode.
    requestMeetingStop(meetingSession, "page hidden");
    return;
  }
  if (document.hidden) {
    // PILL mode: the window is hidden by design and the pill stays on screen,
    // so the voice runtime keeps running. Every other hidden case suspends.
    if (voiceHidden()) suspendHiddenVoice();
    return;
  }
  if (!document.hidden && !meetingVoiceActive() && deferredMeetingReply) {
    const reply = deferredMeetingReply;
    deferredMeetingReply = null;
    orb._ensureAudio();
    speak(reply);
    return;
  }
  if (!document.hidden && !meetingVoiceActive() && wakeOn &&
      !recording && !talkStarting && !speaking && !busy) {
    restoreWakeListening();
  }
});

// ---- dock: intent-driven state machine (idle mic bubble ⇄ expanded panel) ----
// data-state="idle" shows only the mic bottom-right; "expanded" is the full panel.
// Expands on mic click / any focus or pointer inside / wake word ON. Collapses on
// outside click, Escape, the ▾ toggle, or ~4s with no interaction — but never
// while a conversation is live (recording / thinking / speaking) or wake is ON.
// --dock-height stays synced so page padding + scroll-padding clear the real dock.
(function initDock() {
  const dock = $("dock");
  const toggle = $("dockToggle");
  if (!dock) return;

  const syncHeight = () => {
    document.documentElement.style.setProperty("--dock-height", dock.offsetHeight + 30 + "px");
  };
  syncHeight();
  if ("ResizeObserver" in window) new ResizeObserver(syncHeight).observe(dock);
  window.addEventListener("resize", syncHeight);

  // the cockpit dock is a permanent HUD bar — no idle bubble, no collapse
  if (document.body.classList.contains("cockpit")) {
    dock.dataset.state = "expanded";
    return;
  }

  let idleTimer = 0;
  // keep the panel open while it's genuinely in use
  const inUse = () =>
    wakeOn || recording || busy || speaking || meetingVoiceActive() ||
    dock.contains(document.activeElement);

  const setState = (s) => {
    // The expanded dock carries the persistent recording status and stop mic.
    // Escape and the explicit collapse chevron cannot hide them mid-meeting.
    if (s === "idle" && meetingVoiceActive()) s = "expanded";
    if (dock.dataset.state === s) return;
    dock.dataset.state = s;
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(s === "expanded"));
      toggle.title = s === "expanded" ? "Collapse controls" : "Expand controls";
    }
    syncHeight();
  };
  const collapseSoon = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (inUse()) collapseSoon(); // re-check later instead of closing mid-use
      else setState("idle");
    }, 4000);
  };
  const expand = () => { setState("expanded"); collapseSoon(); };

  // expand triggers: any pointer/focus inside the dock (covers the mic click),
  // plus the wake word turning ON (hooked from setWakeUi below)
  dock.addEventListener("pointerdown", expand);
  dock.addEventListener("focusin", expand);
  dock.addEventListener("input", collapseSoon); // selects count as interaction
  window.__dockOnWake = (on) => { if (on) expand(); else collapseSoon(); };

  // collapse triggers — explicit user intent bypasses the in-use guard
  document.addEventListener("pointerdown", (e) => {
    if (!dock.contains(e.target) && !inUse()) setState("idle");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dock.dataset.state === "expanded") {
      if (dock.contains(document.activeElement)) document.activeElement.blur();
      setState("idle");
    }
  });
  if (toggle) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setState("idle");
      toggle.blur(); // don't let lingering focus instantly re-expand
    });
  }

  collapseSoon();
})();

// ---- settings (voice + tone) + restore prior conversation ----
const voiceSelect = $("voiceSelect");
const toneSelect = $("toneSelect");
const clearBtn = $("clearBtn");
if (voiceSelect) {
  voiceSelect.value = settings.voice;
  voiceSelect.addEventListener("change", () => {
    settings.voice = voiceSelect.value;
    saveSettings();
  });
}
if (toneSelect) {
  toneSelect.value = settings.tone;
  toneSelect.addEventListener("change", () => {
    settings.tone = toneSelect.value;
    saveSettings();
  });
}
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    if (meetingVoiceActive()) {
      showMeetingPhaseUi(meetingSession);
      return;
    }
    conversation.length = 0;
    saveConversation();
    transcript.innerHTML = "";
    setLiveStatus("Cleared. Tap the mic, or type below");
  });
}
restoreConversation();

// disabled-state hint if no keys
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    if (!s.chatEnabled && !meetingVoiceActive()) {
      setLiveStatus("Set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in .env to enable conversation.");
    }
    // Local openWakeWord engine ready? Then the wake word works reliably — and
    // on iPhone — regardless of the browser recognizer. The phrase shown is the
    // server's view of the active profile; once the engine loads and verifies
    // its assets, wakePhrase() takes over from the verified profile itself.
    localWakeCfg = s.localWake || null;
    if (localWakeCfg && localWakeCfg.ready) {
      const phrase = localWakeCfg.phrase || FALLBACK_PROFILE.phrase;
      wakeToggle.disabled = false;
      wakeToggle.title = `On-device wake word “${phrase}” — works on any browser, including iPhone`;
      window.__wakePhrase = phrase;
    } else if (!SpeechRec) {
      wakeToggle.disabled = true;
      wakeToggle.title = "Wake word needs Chrome or Edge (or the on-device engine — see README)";
    }
    // A status response can land after an explicit meeting start. Preserve the
    // capability-derived post-meeting value without re-enabling the live toggle.
    if (meetingVoiceActive()) {
      meetingSession.wakeToggleWasDisabled = wakeToggle.disabled;
      wakeToggle.disabled = true;
    }
    // Email triage card flips to Live once Gmail is authorized (see .env.example)
    const emailStatus = $("emailStatus");
    if (emailStatus && s.gmailEnabled) {
      emailStatus.classList.remove("standby");
      emailStatus.classList.add("live");
      emailStatus.innerHTML = '<span class="s-dot"></span> Live';
    }
    // Voice is fixed to Amelia (ElevenLabs); if its key is missing the server
    // transparently falls back to Deepgram, so nothing to toggle here.
  })
  .catch(() => {});

// Pause every HUD animation when the window isn't visible. Always-on motion was
// asked for; burning a laptop battery animating a hidden tab was not.
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("hud-paused", document.hidden);
});

// Self-diagnostics: report what only this page can see (wake listener, audio
// engine, pill), and accept the two local repairs registered above. Health
// announcements go through the ONE existing voice path — never a second one.
window.__artemisSay = (text) => speak(text);
startHealthClient();
