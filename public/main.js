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

const $ = (id) => document.getElementById(id);
const conversation = [];
let busy = false;
let recording = false;

const orb = new VoiceOrb($("sceneStage"));
window.__orb = orb;

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
};

const liveStatus = $("liveStatus");
const transcript = $("transcript"); // null now (chat window removed) — DOM updates are guarded
const micToggle = $("micToggle");
const wakeToggle = $("wakeToggle");

function setLiveStatus(t) {
  if (liveStatus) liveStatus.textContent = t;
}

// Open a URL so it ALWAYS opens. Prefer a new tab (keeps Artemis running); if the
// browser blocks the pop-up — voice commands have no click, so WebKit/Orion usually
// does — fall back to navigating THIS tab (always allowed). A short delay lets her
// spoken "opening now" start first; the conversation is saved so Back restores it.
function openUrl(url) {
  let w = null;
  try { w = window.open(url, "_blank"); } catch (e) {}
  if (w) return true; // opened in a new tab
  setTimeout(() => { try { window.location.assign(url); } catch (e) { window.location.href = url; } }, 1300);
  return false;
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
function ttsUrl(text) {
  const p =
    settings.voice === "elevenlabs"
      ? { text, provider: "elevenlabs" }
      : { text, provider: "deepgram", voice: settings.voice };
  return "/api/tts?" + new URLSearchParams(p).toString();
}

// ---- hands-free barge-in: interrupt Artemis just by speaking while she talks ----
// Listens on a mic with echo-cancellation so her own voice (through the speakers)
// doesn't false-trigger; only sustained, real speech cuts her off.
// Hands-free barge-in is OFF by default — on speakers (without solid echo
// cancellation) it can false-trigger on Artemis's own voice and abort her reply.
// The mic button still interrupts her reliably. Set to true to re-enable.
const BARGE_IN_ENABLED = false;
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

async function speak(text) {
  pauseWakeForSpeech();
  orb.connectMediaElement(ttsEl); // route Artemis's voice into the orb's analyser
  orb.setStatus("speaking");
  setLiveStatus("Artemis is responding…");
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
  orb.stopAudio();
  if (wakeOn) {
    orb.setStatus("listening");
    setLiveStatus("Listening for “Artemis…”");
    resumeWake();
  } else {
    orb.setStatus("idle");
    setLiveStatus("Click the mic to speak");
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
function handleOpenIntent(text) {
  const r = resolveOpenIntent(text);
  if (!r) return false;
  // opens in a new tab if pop-ups are allowed, else navigates this tab (always works)
  openUrl(r.url);
  const phrase = r.kind === "search" ? `Opening a Google search for ${r.term}.` : `Opening ${r.label}.`;
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
    });
  return true;
}

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
function fetchTtsBlob(text) {
  return fetch(ttsUrl(text)).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
}
function resetTtsPipe() {
  ttsQueue = [];
  sentenceBuf = "";
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
    ttsQueue.push({ text, blobP: fetchTtsBlob(text) }); // start fetching NOW (overlaps playback)
    pumpTts();
  }
}
async function pumpTts() {
  if (ttsPlaying || !ttsQueue.length) return;
  ttsPlaying = true;
  const item = ttsQueue.shift();
  try {
    pauseWakeForSpeech();
    orb.connectMediaElement(ttsEl);
    orb.setStatus("speaking");
    speaking = true;
    startBargeIn(); // listen for you to interrupt
    const blob = await item.blobP; // usually already resolved → no gap before this clip
    if (!blob) { ttsPlaying = false; pumpTts(); return; }
    if (ttsObjUrl) { try { URL.revokeObjectURL(ttsObjUrl); } catch (e) {} }
    ttsObjUrl = URL.createObjectURL(blob);
    ttsEl.onended = ttsEl.onerror = () => {
      ttsPlaying = false;
      if (ttsQueue.length) pumpTts();
      else {
        speaking = false;
        afterSpeak();
      }
    };
    ttsEl.src = ttsObjUrl;
    ttsEl.currentTime = 0;
    await ttsEl.play();
  } catch (e) {
    ttsPlaying = false;
    pumpTts();
  }
}

// ---- conversation (streaming) ----
let currentAbort = null;
async function ask(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  busy = true;
  if (wakeOn) pauseWakeForSpeech();
  addMsg("user", text);
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
        if (event === "token") {
          if (!gotToken) { gotToken = true; stopThinking(); setLiveStatus(""); }
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
        } else if (event === "error") {
          setLiveStatus(data.error || "Chat failed.");
        }
      }
    }
    stopThinking();
    const replyText = out.text();
    if (replyText) {
      out.setSources(finalSources);
      conversation.push({ role: "assistant", content: replyText, sources: finalSources });
      saveConversation();
      flushTts();
    }
    if (pendingAction) {
      pendingConfirm = pendingAction;
      setLiveStatus("Say “yes” to confirm, or “no” to cancel.");
    }
    // execute anything Artemis chose to open (maps location, a site, etc.)
    if (clientActions && clientActions.length) {
      for (const a of clientActions) {
        if (a && a.url) openUrl(a.url);
      }
    }
    if (!ttsPlaying && !ttsQueue.length) afterSpeak();
  } catch (e) {
    stopThinking();
    resetTtsPipe();
    setLiveStatus(
      currentAbort && currentAbort.signal.aborted ? "Stopped." : "Couldn't reach the server — try again."
    );
    afterSpeak();
  } finally {
    clearTimeout(timer);
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
  orb._ensureAudio(); // unlock audio in this gesture
  try {
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
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  mediaRecorder.onstop = onTalkStop;
  mediaRecorder.start();
  recording = true;
  micToggle.classList.add("recording");
  setLiveStatus("Listening… click to send");
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
    afterSpeak();
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
let wakeArmed = false;        // true after "Artemis" with no command → next phrase is the command
let wakeArmedTimer = null;
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
  wakeToggle.classList.toggle("on", on);
  wakeToggle.textContent = on ? "👂 WAKE WORD: ON" : "👂 WAKE WORD: OFF";
}

async function startWake() {
  if (!SpeechRec) {
    setLiveStatus("Wake word needs Chrome or Edge.");
    return;
  }
  orb._ensureAudio();
  // a viz mic so the orb reacts to your voice while waiting
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    orb.connectMic(micStream);
  } catch (e) {}
  wakeRec = new SpeechRec();
  wakeRec.continuous = true;
  wakeRec.interimResults = false;
  wakeRec.lang = "en-US";
  wakeRec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) handleWake(e.results[i][0].transcript);
    }
  };
  wakeRec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      setLiveStatus("Microphone blocked — allow mic access to use the wake word.");
    else if (e.error === "audio-capture") setLiveStatus("No microphone found for the wake word.");
    else if (e.error === "network") setLiveStatus("Speech recognition needs a network connection.");
    // 'no-speech' / 'aborted' are normal between phrases — ignore
  };
  wakeRec.onend = () => {
    if (wakeOn && !speaking && !busy) {
      try { wakeRec.start(); } catch (e) {}
    }
  };
  setWakeUi(true);
  orb.setStatus("listening");
  setLiveStatus("Listening for “Artemis…”  (try: “Artemis, daddy is home”)");
  try { wakeRec.start(); } catch (e) {}
}

function stopWake() {
  setWakeUi(false);
  disarmWake();
  if (wakeRec) {
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
  if (handleConfirmIfPending(cmd)) return;
  if (handleOpenIntent(cmd)) return;
  ask(cmd);
}

function handleWake(raw) {
  if (busy || speaking) return;
  console.debug("[wake] heard:", raw); // open the console to see what was recognized
  const w = matchWake(raw);
  if (w) {
    playEarcon(); // instant acknowledgement — no dead air while Claude thinks
    orb.setStatus("listening");
    orb.feed(0.6);
    const cmd = (w.rest || "").trim();
    if (cmd) {
      runWakeCommand(cmd); // "Artemis, what's the weather" in one breath
    } else {
      armWake(); // just "Artemis" → take the NEXT phrase as the command
      const ack = WAKE_ACKS[Math.floor(Math.random() * WAKE_ACKS.length)];
      setLiveStatus(ack);
      orb._ensureAudio();
      speak(ack); // Jarvis-style spoken greeting; recogniser resumes after she finishes
    }
    return;
  }
  // no wake word in this phrase — if we were just woken, treat it as the command
  if (wakeArmed) {
    orb.feed(0.5);
    runWakeCommand(raw);
  }
}

function pauseWakeForSpeech() {
  if (wakeRec) {
    try { wakeRec.stop(); } catch (e) {}
  }
}
function resumeWake() {
  if (wakeOn) {
    if (!micStream) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((s) => {
          micStream = s;
          orb.connectMic(s);
        })
        .catch(() => {});
    }
    if (wakeRec) {
      try { wakeRec.start(); } catch (e) {}
    }
  }
}

wakeToggle.addEventListener("click", () => (wakeOn ? stopWake() : startWake()));

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
  nav.classList.toggle("scrolled", y > 8);
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
    const name = ["Research", "Email triage", "Messaging"][brain.agent];
    caption.innerHTML = CAPTIONS[brain.step].replace(/\{a\}/g, "<strong>" + name + "</strong>");
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

  // The #brain section is taller than the viewport, so a top-aligned anchor jump
  // leaves the interactive panel under the fixed dock. Center the panel instead,
  // so every control lands fully clear of the dock and clickable.
  const panel = document.querySelector(".brain-panel");
  document.querySelectorAll('a[href="#brain"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      (panel || host).scrollIntoView({ behavior: "smooth", block: "center" });
      history.replaceState(null, "", "#brain");
    });
  });
})();

// ---- demo transcript: reveal lines in sequence, like a live exchange ----
(function initDemo() {
  const chat = $("demoChat");
  if (!chat) return;
  const lines = Array.from(chat.querySelectorAll(".demo-line"));
  const replay = $("demoReplay");
  const reduced = prefersReducedMotion();
  let timers = [];

  function showAll() {
    lines.forEach((l) => l.classList.add("shown"));
  }
  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    if (reduced) { showAll(); return; } // no sequential motion under reduced-motion
    lines.forEach((l) => l.classList.remove("shown"));
    lines.forEach((l) => {
      timers.push(setTimeout(() => l.classList.add("shown"), +l.dataset.delay || 0));
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

// ---- dock: keep page bottom-padding in sync with the dock, + collapse toggle ----
// The dock is position:fixed, so it would otherwise cover the footer/last cards.
// We measure its real height (which changes with collapse and mobile wrapping) and
// expose it as --dock-h; .page reserves exactly that much padding-bottom.
(function initDock() {
  const dock = $("dock");
  const toggle = $("dockToggle");
  if (!dock) return;
  const syncHeight = () => {
    // set on :root so both .page padding-bottom and html scroll-padding-bottom
    // (and any section clearance) read the dock's real, current height
    document.documentElement.style.setProperty("--dock-height", dock.offsetHeight + 30 + "px");
  };
  syncHeight();
  if ("ResizeObserver" in window) new ResizeObserver(syncHeight).observe(dock);
  window.addEventListener("resize", syncHeight);
  if (toggle) {
    toggle.addEventListener("click", () => {
      const collapsed = dock.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.title = collapsed ? "Expand controls" : "Collapse controls";
      syncHeight();
    });
  }
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
    if (!s.chatEnabled) setLiveStatus("Set ANTHROPIC_API_KEY in .env to enable conversation.");
    if (!SpeechRec) {
      wakeToggle.disabled = true;
      wakeToggle.title = "Wake word needs Chrome or Edge";
    }
    // Voice is fixed to Amelia (ElevenLabs); if its key is missing the server
    // transparently falls back to Deepgram, so nothing to toggle here.
  })
  .catch(() => {});
