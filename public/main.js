// Artemis — main page orchestrator.
// Wires the audio-reactive VoiceOrb to the real backend: mic → Deepgram STT →
// Claude (+ web search) → Deepgram TTS, plus an "Artemis …" wake word. The orb
// reacts to YOUR voice (listening) and ARTEMIS's voice (speaking) via real audio.
import { VoiceOrb } from "./voiceOrb.js";
import { resolveOpenIntent } from "./siteRegistry.js";
import { matchWake } from "./wakeWords.js";
import { initMiniOrbs } from "./miniOrb.js";
import { BrainOrb } from "./brainOrb.js";
import { prefersReducedMotion } from "./orbShared.js";
import { startLocalWake, stopLocalWake, pauseLocalWake, resumeLocalWake, localWakeRunning, captureCommand } from "./wakeLocal.js";
import { shouldSpeakFiller, fillerFor } from "./ttsPolicy.js";

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

// celebration.js checks this before playing its jingle / hijacking the orb —
// a payment landing mid-conversation must not talk over Artemis or the user
window.celebrationVoiceActive = () => speaking || recording || busy;

// On the cockpit page the orb sits dead-center; on the landing it offsets
// right to make room for the hero copy (VoiceOrb's default).
const orb = new VoiceOrb($("sceneStage"), { center: document.body.classList.contains("cockpit") });
window.__orb = orb;

// The cockpit HUD (cockpit.js) listens on window.ArtemisHUD; on pages without
// it every emit is a guarded no-op.
const hud = (fn, ...a) => { try { window.ArtemisHUD && window.ArtemisHUD[fn] && window.ArtemisHUD[fn](...a); } catch (e) {} };

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
};

const liveStatus = $("liveStatus");
const transcript = $("transcript"); // null now (chat window removed) — DOM updates are guarded
const micToggle = $("micToggle");
const wakeToggle = $("wakeToggle");

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

// Streaming TTS URL — the browser plays it progressively (first frames ~0.5s).
// Voice values: "aura-*" → Deepgram; "eleven:<id>" → that ElevenLabs voice;
// "edge:<AzureVoiceName>" → free Edge neural voice (e.g. en-GB-SoniaNeural);
// legacy "elevenlabs" → the server's default eleven voice.
function ttsUrl(text) {
  const v = settings.voice || "";
  const p = v.startsWith("eleven:")
    ? { text, provider: "elevenlabs", voice: v.slice(7) }
    : v.startsWith("edge:")
      ? { text, provider: "edge", voice: v.slice(5) }
      : v === "elevenlabs"
        ? { text, provider: "elevenlabs" }
        : { text, provider: "deepgram", voice: v };
  return "/api/tts?" + new URLSearchParams(p).toString();
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
async function startBargeIn() {
  if (!BARGE_IN_ENABLED || bargeStream) return; // disabled, or already listening
  const ctx = orb._ensureAudio();
  if (!ctx || !navigator.mediaDevices) return;
  try {
    bargeStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) { bargeStream = null; return; }
  if (!speaking) { bargeStream.getTracks().forEach((t) => t.stop()); bargeStream = null; return; }
  const src = ctx.createMediaStreamSource(bargeStream);
  bargeAnalyser = ctx.createAnalyser();
  bargeAnalyser.fftSize = 512;
  bargeFreq = new Uint8Array(bargeAnalyser.frequencyBinCount);
  src.connect(bargeAnalyser); // analyse only — never routed to the speakers
  bargeHot = 0;
  const startedAt = performance.now();
  const tick = () => {
    if (!bargeStream) return;
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
  if (bargeRaf) { cancelAnimationFrame(bargeRaf); bargeRaf = 0; }
  if (bargeStream) { bargeStream.getTracks().forEach((t) => t.stop()); bargeStream = null; }
  bargeAnalyser = null; bargeFreq = null; bargeHot = 0;
}
function bargeIn() {
  stopBargeIn();
  resetTtsPipe();
  speaking = false;
  orb.stopAudio();
  if (currentAbort) { try { currentAbort.abort(); } catch (e) {} }
  startTalk(); // immediately capture what you're now saying
}

// Public hook for the cockpit (welcome briefing etc.) — must be invoked from
// a user-gesture call chain the first time so audio is unlocked.
window.ArtemisSpeak = (t) => { try { orb._ensureAudio(); speak(String(t || "")); } catch (e) {} };

async function speak(text) {
  // speak() and the streaming pumpTts() share one <audio> element; take sole
  // ownership first so a still-draining streamed reply (or a poller-triggered
  // announce) can't leave a stale onended handler that wedges `speaking`.
  resetTtsPipe();
  pauseWakeForSpeech();
  orb.connectMediaElement(ttsEl); // route Artemis's voice into the orb's analyser
  orb.setStatus("speaking");
  setLiveStatus("Artemis is responding…  (Esc to stop)");
  speaking = true;
  startBargeIn();
  ttsEl.onended = ttsEl.onerror = () => afterSpeak();
  try {
    ttsEl.src = ttsUrl(cleanForSpeech(text));
    ttsEl.currentTime = 0;
    await ttsEl.play();
  } catch (e) {
    afterSpeak();
  }
}

function afterSpeak() {
  stopBargeIn();
  speaking = false;
  if (recording) return; // user already barged in — don't clobber the live mic UI
  orb.stopAudio();
  micStream = null; // stopAudio killed the tracks; resumeWake must reacquire
  if (wakeOn) {
    orb.setStatus("listening");
    // keep a pending yes/no question visible — it's the most important status
    setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Listening for “" + wakePhrase() + "…”");
    resumeWake();
  } else {
    orb.setStatus("idle");
    setLiveStatus(pendingConfirm ? "Say “yes” to confirm, or “no” to cancel." : "Click the mic to speak");
  }
}

// ---- persistence + settings ----
const CONV_KEY = "artemisConversationV1";
const SETTINGS_KEY = "artemisSettingsV2";
let settings = loadSettings();
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { voice: s.voice || "aura-2-thalia-en", tone: s.tone || "balanced" }; // natural Aura-2
  } catch (e) {
    return { voice: "aura-2-thalia-en", tone: "balanced" };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}
function saveConversation() {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(conversation.slice(-20))); } catch (e) {}
}
function restoreConversation() {
  try {
    const arr = JSON.parse(localStorage.getItem(CONV_KEY) || "[]");
    if (!Array.isArray(arr)) return;
    arr.forEach((m) => {
      conversation.push({ role: m.role, content: m.content });
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
  const r = resolveOpenIntent(text);
  if (!r) return false;
  // new tab if pop-ups are allowed, else the one-tap Open pill (never this tab)
  const opened = openUrl(r.url, r.label);
  const target = r.kind === "search" ? `a Google search for ${r.term}` : r.label;
  const phrase = opened ? `Opening ${target}.` : `My pop-up was blocked — tap Open and I'll bring up ${target}.`;
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
function handleConfirmIfPending(text) {
  if (!pendingConfirm) return false;
  const t = (text || "").toLowerCase().trim();
  const yes = /\b(yes|yeah|yep|yup|sure|confirm|send it|do it|go ahead|please do|affirmative|okay|ok)\b/.test(t);
  const no = /\b(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|abort|negative)\b/.test(t);
  const pa = pendingConfirm;
  pendingConfirm = null;
  if (!yes && !no) {
    // ambiguous → cancel the pending action for safety, then let the caller treat
    // this text as a brand-new command (it is NOT a confirmation).
    fetch("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmId: pa.confirmId, decision: "no" })
    }).catch(() => {});
    return false;
  }
  addMsg("user", text);
  orb._ensureAudio();
  // hold the turn: the /api/confirm POST can send an email / take seconds, and
  // without busy a mic click or a wake command would start an overlapping turn
  busy = true;
  if (wakeOn) pauseWakeForSpeech();
  orb.setStatus("thinking");
  setLiveStatus(yes ? "On it…" : "Cancelling…");
  fetch("/api/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmId: pa.confirmId, decision: yes ? "yes" : "no" })
  })
    .then((r) => r.json())
    .then((d) => {
      const reply = d.reply || (yes ? "Done." : "Cancelled.");
      addMsg("artemis", reply);
      conversation.push({ role: "assistant", content: reply });
      saveConversation();
      setLiveStatus("");
      speak(reply);
    })
    .catch(() => {
      setLiveStatus("Confirm failed.");
      afterSpeak();
    })
    .finally(() => { busy = false; });
  return true;
}

// Cockpit confirm buttons ([EXECUTE]/[ABORT] on the CONFIRM card) resolve the
// SAME pending action as the spoken yes/no — one gate, two inputs.
window.ArtemisConfirm = (yes) => {
  if (!pendingConfirm) return false;
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
  ttsQueue = [];
  sentenceBuf = "";
  firstChunkPending = true;
  try { ttsEl.pause(); } catch (e) {}
  ttsEl.onended = ttsEl.onerror = null;
  if (ttsObjUrl) { try { URL.revokeObjectURL(ttsObjUrl); } catch (e) {} ttsObjUrl = null; }
  ttsPlaying = false;
}
function feedTts(t) {
  sentenceBuf += t;
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
  const r = sentenceBuf.trim();
  sentenceBuf = "";
  if (r) enqueueTts(r);
}
function enqueueTts(text) {
  text = cleanForSpeech(text);
  if (text) {
    firstChunkPending = false; // once anything is queued, revert to whole-sentence chunks
    ttsQueue.push({ text, blobP: fetchTtsBlob(text) }); // start fetching NOW (overlaps playback)
    pumpTts();
  }
}
async function pumpTts() {
  if (ttsPlaying || !ttsQueue.length) return;
  ttsPlaying = true;
  const item = ttsQueue.shift();
  // Exactly-once advance for this clip. A decode error can fire BOTH the
  // play() rejection and the element's async error event — without the guard
  // that spawned two interleaved pump loops fighting over ttsEl. And every
  // exit path must end the turn when the queue is dry, or `speaking` sticks
  // true forever and the wake word never restarts.
  const settle = () => {
    if (settle.done) return;
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
    startBargeIn(); // listen for you to interrupt
    const blob = await item.blobP; // usually already resolved → no gap before this clip
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
  if (!text || busy) return;

  // A pending spoken OFFER (the welcome briefing: "would you like the news?")
  // is answered locally — a bare yes plays the held text, a no dismisses it,
  // anything else supersedes the offer and proceeds as a normal command.
  if (window.__pendingBriefing) {
    const held = window.__pendingBriefing;
    if (/^(yes|yeah|yep|sure|ok(ay)?|please( do)?|go ahead|do it|absolutely|why not|let'?s hear( it)?|tell me)\b/i.test(text)) {
      window.__pendingBriefing = null;
      hud("log", "you", text);
      hud("log", "artemis", held.length > 120 ? held.slice(0, 117) + "…" : held);
      orb._ensureAudio();
      speak(held);
      return;
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
  addMsg("user", text);
  hud("log", "you", text);
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
  const t0 = performance.now(); // real time-to-first-word for the HUD
  // The server tells us what kind of turn this is (intent_pending) before it
  // invokes the model. Until that arrives the class is unknown — and unknown
  // means SILENT. Speaking "let me check" on a turn that turns out to execute
  // nothing is exactly how she used to sound busy while doing nothing.
  let intentClass = null;
  const execTimer = setTimeout(() => {
    if (!busy || gotToken) return;
    hud("state", "executing");
    hud("log", "status", "running tools…");
    if (shouldSpeakFiller({ intentClass, gotToken, busy })) {
      const line = fillerFor(intentClass);
      if (line) enqueueTts(line);
    } else {
      // action turn (or not yet classified): show the wait, don't claim it
      orb.setStatus("thinking");
      setLiveStatus("Working…");
    }
  }, 1200);
  currentAbort = new AbortController();
  const timer = setTimeout(() => {
    try { currentAbort.abort(); } catch (e) {}
  }, 60000);
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation, tone: settings.tone }),
      signal: currentAbort.signal
    });
    if (!res.ok || !res.body) throw new Error("no stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
        } else if (event === "token") {
          if (!gotToken) {
            gotToken = true;
            stopThinking();
            setLiveStatus("");
            clearTimeout(execTimer);
            hud("ttfw", performance.now() - t0); // real, measured, this turn
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
        } else if (event === "error") {
          setLiveStatus(data.error || "Chat failed.");
          hud("state", "error");
          hud("log", "error", data.error || "chat failed");
        }
      }
    }
    stopThinking();
    if (toolsUsed && toolsUsed.length) {
      toolsUsed.forEach((t) => hud("log", "tool", t + " ✓"));
    }
    const replyText = out.text();
    if (replyText) {
      out.setSources(finalSources);
      conversation.push({ role: "assistant", content: replyText, sources: finalSources });
      saveConversation();
      flushTts();
      hud("log", "artemis", replyText.length > 120 ? replyText.slice(0, 117) + "…" : replyText);
    }
    if (finalSources && finalSources.length) {
      hud("context", { title: "SOURCES", links: finalSources.slice(0, 5) });
    }
    if (pendingAction) {
      pendingConfirm = pendingAction;
      setLiveStatus("Say “yes” to confirm, or “no” to cancel.");
      hud("log", "confirm", "awaiting your yes / no");
      hud("context", { title: "CONFIRM REQUIRED", lines: [replyText || pendingAction.name], confirm: true });
    }
    // execute anything Artemis chose to open (maps location, a site, etc.)
    // + render structured tool panels (e.g. the inbox) as context cards
    if (clientActions && clientActions.length) {
      for (const a of clientActions) {
        if (!a) continue;
        if (a.type === "panel" && a.card) {
          hud("context", a.card);
          continue;
        }
        if (a.url) {
          openUrl(a.url, a.label);
          hud("log", "action", "open " + (a.label || a.url));
          hud("context", { title: "OPENED", links: [{ title: a.label || a.url, url: a.url }] });
        }
      }
    }
    if (!ttsPlaying && !ttsQueue.length) { speaking = false; afterSpeak(); } // pump may have deferred to us while busy
  } catch (e) {
    stopThinking();
    resetTtsPipe();
    setLiveStatus(
      currentAbort && currentAbort.signal.aborted ? "Stopped." : "Couldn't reach the server — try again."
    );
    hud("state", "error");
    hud("log", "error", currentAbort && currentAbort.signal.aborted ? "stopped by user" : "couldn't reach the server");
    afterSpeak();
  } finally {
    clearTimeout(timer);
    clearTimeout(execTimer);
    currentAbort = null;
    busy = false;
  }
}

// ---- push-to-talk (mic → STT → ask) ----
let mediaRecorder = null;
let chunks = [];
let micStream = null;

async function startTalk() {
  if (busy || recording) return;
  stopBargeIn(); // we're recording now — no need for the barge-in listener
  // manual recording needs EXCLUSIVE mic access — a second stream on the same
  // device can come back silent (iPhone). resumeWake() restarts the engine.
  if (localWakeRunning()) await stopLocalWake();
  orb._ensureAudio(); // unlock audio in this gesture
  try {
    // stop the wake-mode viz stream first — overwriting it leaks a live mic
    // (browser "mic in use" indicator never clears)
    if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {} micStream = null; }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setLiveStatus("Microphone permission denied.");
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
  liveFinal = "";
  liveSid = null;
  livePending = [];
  liveSendQ = Promise.resolve();
  try {
    const r = await fetch("/api/stt/live/start", { method: "POST" });
    if (!r.ok) return;
    const { sid } = await r.json();
    if (!recording && !mediaRecorder) return; // user already stopped — don't open a dead session
    liveSid = sid;
    // Flush everything recorded before the session was ready — IN ORDER, so
    // Deepgram gets a valid webm stream starting with its header chunk. Without
    // this, a slow /start (common over wifi/LAN) silently drops the first words
    // of the command and only the tail ("…please") ever gets transcribed.
    const backlog = livePending; livePending = [];
    for (const b of backlog) liveSendChunk(b);
    liveEs = new EventSource("/api/stt/live/events?sid=" + sid);
    let interim = "";
    liveEs.onmessage = (ev) => {
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
    };
    liveEs.onerror = () => {}; // relay hiccup → batch fallback still runs
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
    }, 1200);
  }).finally(() => {
    if (liveEs) { try { liveEs.close(); } catch (e) {} liveEs = null; }
    hud("liveDone");
  });
}

async function onTalkStop() {
  recording = false;
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
  if (!blob.size) {
    closeLiveStt();
    afterSpeak();
    return;
  }
  // prefer the STREAMED transcript (already on screen, zero extra latency);
  // fall back to the batch POST only when streaming produced nothing
  const streamed = await closeLiveStt();
  if (streamed) {
    setLiveStatus("");
    if (handleConfirmIfPending(streamed)) return;
    if (!handleOpenIntent(streamed)) ask(streamed);
    return;
  }
  setLiveStatus("Transcribing…");
  try {
    const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": type }, body: blob });
    const data = await res.json();
    const text = (data.transcript || "").trim();
    if (text) {
      if (handleConfirmIfPending(text)) return;
      if (!handleOpenIntent(text)) ask(text);
    } else {
      setLiveStatus("Didn't catch that — try again.");
      afterSpeak();
    }
  } catch (e) {
    setLiveStatus("Transcription failed.");
    afterSpeak();
  }
}

function stopTalk() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

micToggle.addEventListener("click", () => {
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
    startTalk();
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

// short rising blip + orb flash the instant a wake word fires (kills dead air)
function playEarcon() {
  try {
    const c = orb._ensureAudio();
    if (!c) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(620, t);
    o.frequency.exponentialRampToValueAtTime(940, t + 0.13);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.22);
  } catch (e) {}
}

// ---- optional text input (removed in voice-only mode; guarded if absent) ----
const textForm = $("textForm");
const textInput = $("textInput");
if (textForm && textInput) {
  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = textInput.value.trim();
    if (!v || busy) return;
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
let wakeArmed = false;        // true after "Artemis" with no command → next phrase is the command
let wakeArmedTimer = null;
let wakeWatchdog = 0;

// Start the recognizer safely — swallow "already started" / throttle errors.
function safeStartRec() {
  if (!wakeRec || wakeRunning) return;
  try { wakeRec.start(); } catch (e) { /* already started, or throttled — the watchdog retries */ }
}
// Watchdog: Chrome's SpeechRecognition dies silently (network blip, long
// silence, throttled restart) and then she goes DEAF with no indication. This
// heartbeat guarantees it's alive whenever it should be — the real fix for
// "she stopped reacting". Only runs while wake is on and she's not talking.
function startWakeWatchdog() {
  if (wakeWatchdog) return;
  wakeWatchdog = setInterval(() => {
    if (wakeOn && !wakeRunning && !speaking && !busy) safeStartRec();
    // keep the live indicator honest
    if (wakeOn) window.__wakeLive = wakeRunning && !speaking && !busy;
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
    if (wakeOn && !busy && !speaking) setLiveStatus("Listening for “Artemis…”");
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

// The active wake phrase — the local engine wakes on "Hey Jarvis"; the browser
// fallback still uses "Artemis". Status text reflects whichever is running.
function wakePhrase() { return localWakeRunning() ? "Hey Jarvis" : "Artemis"; }

// The LOCAL wake path: openWakeWord reliably detects "Hey Jarvis" on-device
// (works on iPhone). On detection the ENGINE ITSELF captures the command from
// the same mic stream — including ~1.2s of pre-roll from before detection
// fired — so nothing you said is ever lost to a mic handoff. The WAV goes to
// batch STT (the reliable path); no MediaRecorder, no chunk streaming.
let wakeCapturing = false;
async function onLocalWake() {
  if (recording || busy || wakeCapturing) return; // already handling a turn
  if (speaking || ttsPlaying || ttsQueue.length) window.ArtemisBargeIn.interrupt(); // she was talking → interrupt
  wakeCapturing = true;
  playEarcon();
  orb.feed(0.6);
  orb.setStatus("listening");
  setLiveStatus("Listening…");
  window.__wakeLive = false;
  try {
    const wav = await captureCommand({ onLevel: (rms) => orb.feed(Math.min(1, rms * 10)) });
    if (!wav) { setLiveStatus("Didn't catch that — try again."); afterSpeak(); return; }
    setLiveStatus("Transcribing…");
    const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
    const data = await res.json();
    let text = (data.transcript || "").trim();
    // the pre-roll may include the tail of the wake phrase — scrub it off
    text = text.replace(/^\s*(hey|hi|ok(?:ay)?|a)?[,.\s]*(jarvis|jervis|jarvys|gervais)\b[,.!?\s]*/i, "").trim();
    if (!text) { setLiveStatus("Didn't catch that — try again."); afterSpeak(); return; }
    setLiveStatus("");
    if (handleConfirmIfPending(text)) return;
    if (!handleOpenIntent(text)) ask(text);
  } catch (e) {
    setLiveStatus("Transcription failed.");
    afterSpeak();
  } finally {
    wakeCapturing = false;
  }
}

async function startWakeLocal() {
  wakeStarting = true;
  orb._ensureAudio();
  const ok = await startLocalWake(localWakeCfg, onLocalWake);
  wakeStarting = false;
  if (!ok) return false;
  setWakeUi(true);
  orb.setStatus("listening");
  setLiveStatus("● Listening for “Hey Jarvis…”  (on-device)");
  window.__wakeLive = true;
  return true;
}

async function startWake() {
  if (wakeOn || wakeStarting) return;
  // Prefer the reliable local engine when it's set up; else the browser recognizer.
  if (localWakeCfg && localWakeCfg.ready) {
    if (await startWakeLocal()) return;
    // on-device engine failed to load → fall through to the browser recognizer if present
  }
  if (!SpeechRec) {
    setLiveStatus("Wake word needs Chrome or Edge (or set up the on-device engine — see README).");
    return;
  }
  wakeStarting = true;
  orb._ensureAudio();
  // a viz mic so the orb reacts to your voice while waiting
  try {
    if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (e) {} } // never leak the old one
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    orb.connectMic(micStream);
  } catch (e) {}
  wakeStarting = false;
  wakeRec = new SpeechRec();
  wakeRec.continuous = true;
  wakeRec.interimResults = false;
  wakeRec.lang = "en-US";
  wakeRec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) handleWake(e.results[i][0].transcript);
    }
  };
  wakeRec.onstart = () => { wakeRunning = true; window.__wakeLive = !speaking && !busy; };
  wakeRec.onerror = (e) => {
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
  wakeRec.onend = () => {
    wakeRunning = false;
    window.__wakeLive = false;
    // restart shortly (a tiny delay avoids Chrome's "already started" throttle);
    // the watchdog is the backstop if this restart is dropped.
    if (wakeOn && !speaking && !busy) setTimeout(safeStartRec, 300);
  };
  setWakeUi(true);
  orb.setStatus("listening");
  setLiveStatus("● Listening for “Artemis…”");
  startWakeWatchdog();
  safeStartRec();
}

function stopWake() {
  setWakeUi(false);
  disarmWake();
  stopWakeWatchdog();
  wakeRunning = false;
  if (localWakeRunning()) stopLocalWake();
  if (wakeRec) {
    wakeRec.onend = null; // don't auto-restart after an intentional stop
    try { wakeRec.stop(); } catch (e) {}
  }
  orb.stopAudio();
  orb.setStatus("idle");
  setLiveStatus("Click the mic to speak");
}

function runWakeCommand(cmd) {
  cmd = (cmd || "").trim();
  if (!cmd) return;
  disarmWake();
  pauseWakeForSpeech();
  orb.stopAudio(); // release viz mic before thinking/speaking
  micStream = null; // tracks are dead now — resumeWake must reacquire, not reuse
  if (handleConfirmIfPending(cmd)) return;
  if (handleOpenIntent(cmd)) return;
  ask(cmd);
}

function handleWake(raw) {
  const w = matchWake(raw);
  // If she's mid-sentence when you say her name, that's an interrupt — stop her
  // and take the command, don't drop it. (Only a fresh wake word interrupts; a
  // stray armed follow-up while busy is still ignored to avoid double-runs.)
  if (busy || speaking) {
    if (w) { window.ArtemisBargeIn.interrupt(); }
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
      runWakeCommand(cmd); // "Artemis, what's the weather" in one breath
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
  window.__wakeLive = false;
  if (localWakeRunning()) { pauseLocalWake(); return; } // local engine: stop hearing during her speech
  if (wakeRec) {
    try { wakeRec.stop(); } catch (e) {} // onend fires → wakeRunning=false
  }
}
function resumeWake() {
  if (!wakeOn) return;
  if (localWakeRunning()) { resumeLocalWake(); window.__wakeLive = true; return; } // local engine: re-arm detection
  if (localWakeCfg && localWakeCfg.ready) { startWakeLocal(); return; } // a manual talk stopped the engine — restart it
  // a stream whose tracks were stopped (orb.stopAudio) is useless — check
  // liveness, not just presence, or the orb never reacts after the 1st turn
  const live = micStream && micStream.getTracks().some((t) => t.readyState === "live");
  if (!live) {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        micStream = s;
        orb.connectMic(s);
      })
      .catch(() => {});
  }
  // small delay so the just-stopped recognizer has fully ended before restart
  // (avoids the "already started" throttle); the watchdog is the backstop.
  setTimeout(safeStartRec, 250);
}

wakeToggle.addEventListener("click", () => (wakeOn ? stopWake() : startWake()));
window.__handleWake = handleWake; // debug/test handle (preview verification)

// Cockpit continuity: after the boot tap (a real gesture), re-arm the wake
// word automatically if it was ON last session — she's just listening again.
window.ArtemisArmWake = () => { if (!wakeOn) startWake(); };

// ---- hero CTAs + nav CTA (voice-first: tap = start talking) ----
function startTalkGesture() {
  orb._ensureAudio();
  if (!recording && !busy && !speaking) startTalk();
}
// The dock's mic is now the single primary "Talk to Artemis" CTA. Any legacy
// in-page talk buttons still start a turn if present, but the nav no longer
// duplicates the CTA (it links to the open-source repo instead).
const talkBtn = $("talkBtn");
if (talkBtn) talkBtn.addEventListener("click", startTalkGesture);

// "What can you do?" — Artemis explains herself out loud.
const EXPLAINER =
  "I'm Artemis — your voice-first AI. Tap the mic and talk, or flip on the wake word and just say my name. " +
  "I reply in real time, and you can pick my voice and how blunt I am. " +
  "I search the web and read pages to answer with real sources, dig through Hacker News or GitHub when you want to go deeper, and open any site for you by voice. " +
  "I keep notes, remember your contacts, and can act on your behalf — drafting and sending messages — but anything that actually sends, pays, or changes something, I always confirm with you first. " +
  "So… what can I do for you?";
const explainBtn = $("explainBtn");
if (explainBtn) explainBtn.addEventListener("click", () => {
  orb._ensureAudio();
  conversation.push({ role: "assistant", content: EXPLAINER });
  saveConversation();
  speak(EXPLAINER);
});

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
    g.addColorStop(0, "rgba(255,238,212," + (0.7 + amp * 0.3) + ")");
    g.addColorStop(0.5, "rgba(255,150,70,0.45)");
    g.addColorStop(1, "rgba(255,120,50,0)");
    f.fillStyle = g; f.beginPath(); f.arc(0, 0, R * 2.4, 0, Math.PI * 2); f.fill();
    f.fillStyle = "rgba(255,214,158,0.95)"; f.beginPath(); f.arc(0, 0, R * 0.7, 0, Math.PI * 2); f.fill();
    const defs = [{ rx: 9, ry: 3.4, tilt: 0.5, sp: 1.2 }, { rx: 6.5, ry: 6.5, tilt: -0.8, sp: -0.9 }];
    for (let k = 0; k < defs.length; k++) {
      const d = defs[k];
      f.save(); f.rotate(d.tilt);
      f.lineWidth = 1; f.strokeStyle = "rgba(255,172,92," + (0.4 + amp * 0.4) + ")";
      f.beginPath(); f.ellipse(0, 0, d.rx, d.ry, 0, 0, Math.PI * 2); f.stroke();
      const ph = t * d.sp + k * 2, px = Math.cos(ph) * d.rx, py = Math.sin(ph) * d.ry, dep = 0.5 + 0.5 * Math.sin(ph);
      f.fillStyle = "rgba(255,240,214," + (0.5 + 0.5 * dep) + ")";
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
    "You say <strong>“Artemis.”</strong> The outer ring pulses as she wakes and starts listening.",
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
    caption.innerHTML = tpl.replace(/\{a\}/g, "<strong>" + name + "</strong>");
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

// freeze every CSS animation while the tab is hidden (the orb's rAF already pauses)
document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("tab-hidden", document.hidden);
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
    wakeOn || recording || busy || speaking || dock.contains(document.activeElement);

  const setState = (s) => {
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
    if (!s.chatEnabled) setLiveStatus("Set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in .env to enable conversation.");
    // Local openWakeWord engine ready? Then the wake word ("Hey Jarvis") works
    // reliably — and on iPhone — regardless of the browser recognizer.
    localWakeCfg = s.localWake || null;
    if (localWakeCfg && localWakeCfg.ready) {
      wakeToggle.disabled = false;
      wakeToggle.title = "On-device wake word “Hey Jarvis” — works on any browser, including iPhone";
      window.__wakePhrase = "Hey Jarvis";
    } else if (!SpeechRec) {
      wakeToggle.disabled = true;
      wakeToggle.title = "Wake word needs Chrome or Edge (or the on-device engine — see README)";
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
