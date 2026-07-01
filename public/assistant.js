// Artemis assistant — conversation with Claude (+ web search), voice in/out.
// Three ways to talk to her:
//   • Wake word: turn it on, then just say "Artemis, …" (browser speech recognition)
//   • Hold-to-talk mic (Deepgram speech-to-text)
//   • Type
// Replies are spoken back (Deepgram TTS) and the animated orb reacts to her voice.

(function () {
  "use strict";

  const conversation = []; // [{ role, content }]

  // One persistent <audio> element, "blessed" on the first user gesture so later
  // playback (e.g. on the wake-word path) is allowed without a fresh click.
  let sharedAudio = null;
  let audioBlessed = false;

  const logEl = document.getElementById("chatLog");
  const statusEl = document.getElementById("chatStatus");
  const inputEl = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSend");
  const micBtn = document.getElementById("micButton");
  const wakeBtn = document.getElementById("wakeButton");

  function audioEl() {
    if (!sharedAudio) {
      sharedAudio = new Audio();
      sharedAudio.preload = "auto";
    }
    return sharedAudio;
  }

  // A real (tiny, silent) WAV — used to "bless" the audio element during a gesture.
  function silentWavUrl() {
    const sr = 8000;
    const n = Math.floor(sr * 0.05);
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ws = (o, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    ws(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    ws(8, "WAVE");
    ws(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    ws(36, "data");
    dv.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }

  // Call inside a user gesture. Unlocks Web Audio AND blesses the <audio> element
  // so later, gesture-less playback (the wake-word path) is permitted.
  function unlockAudio() {
    const c = ctx();
    if (c) {
      try {
        const b = c.createBuffer(1, 1, 22050);
        const s = c.createBufferSource();
        s.buffer = b;
        s.connect(c.destination);
        s.start(0);
      } catch (e) {}
    }
    if (!audioBlessed) {
      const el = audioEl();
      try {
        el.src = silentWavUrl();
        el.muted = true;
        const p = el.play();
        if (p && p.then) {
          p.then(() => {
            el.pause();
            el.currentTime = 0;
            el.muted = false;
            audioBlessed = true;
          }).catch(() => {
            el.muted = false;
          });
        }
      } catch (e) {}
    }
  }

  const orb = () => window.artemisOrb || null;
  function orbState(s) {
    if (orb()) orb().setState(s);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function addMessage(role, text, sources) {
    const row = document.createElement("div");
    row.className = "chat-msg chat-" + role;
    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = role === "user" ? "You" : "Artemis";
    const body = document.createElement("div");
    body.className = "chat-text";
    body.textContent = text;
    row.appendChild(who);
    row.appendChild(body);
    if (sources && sources.length) {
      const src = document.createElement("div");
      src.className = "chat-sources";
      src.appendChild(document.createTextNode("Sources: "));
      sources.forEach((s, i) => {
        const a = document.createElement("a");
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = s.title || s.url;
        src.appendChild(a);
        if (i < sources.length - 1) src.appendChild(document.createTextNode(" · "));
      });
      row.appendChild(src);
    }
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---- audio -------------------------------------------------------------
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      audioCtx = C ? new C() : null;
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  // Speak text via backend TTS. Plays through the blessed <audio> element (works
  // on the wake path without a fresh gesture) and animates the orb while talking.
  async function speak(text) {
    let blob;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!res.ok) {
        setStatus("Voice output failed (TTS). Reply is shown above.");
        resumeWakeAfterSpeech();
        return;
      }
      blob = await res.blob();
    } catch (e) {
      resumeWakeAfterSpeech();
      return;
    }

    const url = URL.createObjectURL(blob);
    const el = audioEl();
    pauseWakeForSpeech(); // don't let the mic hear her own voice
    orbState("speaking");

    let playing = true;
    const stop = () => {
      if (!playing) return;
      playing = false;
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
      resumeWakeAfterSpeech();
    };
    el.onended = stop;
    el.onerror = stop;

    // Orb motion while she talks (synthetic energy — reliable across browsers).
    (function tick() {
      if (!playing) return;
      if (orb()) orb().feed(0.3 + Math.random() * 0.5);
      setTimeout(tick, 90);
    })();

    try {
      el.muted = false;
      el.src = url;
      el.currentTime = 0;
      await el.play();
    } catch (e) {
      setStatus("Audio was blocked — click anywhere on the page once, then try again.");
      stop();
    }
  }

  // ---- chat --------------------------------------------------------------
  let busy = false;

  async function sendText(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    busy = true;
    if (wakeOn) pauseWakeForSpeech(); // don't hear ourselves while thinking/speaking
    inputEl.value = "";
    addMessage("user", text);
    conversation.push({ role: "user", content: text });
    if (conversation.length > 20) conversation.splice(0, conversation.length - 20);
    setStatus("Artemis is thinking…");
    orbState("thinking");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: conversation })
      });
      const data = await res.json();
      if (data.error) {
        setStatus(data.error);
        resumeWakeAfterSpeech();
      } else {
        const reply = data.reply || "(no response)";
        conversation.push({ role: "assistant", content: reply });
        addMessage("assistant", reply, data.sources);
        setStatus("");
        speak(reply); // handles orb speaking + wake resume
      }
    } catch (e) {
      setStatus("Couldn't reach the server.");
      resumeWakeAfterSpeech();
    }
    busy = false;
  }

  // ---- wake word (browser speech recognition) ----------------------------
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let wakeRec = null;
  let wakeOn = false;
  let speaking = false;

  function setWakeUi(on) {
    wakeOn = on;
    window.__artemisWakeOn = on; // orb.js reads this to return to "listening"
    if (wakeBtn) {
      wakeBtn.classList.toggle("on", on);
      wakeBtn.textContent = on ? "👂 Wake word: on" : "👂 Wake word: off";
    }
    orbState(on ? "listening" : "idle");
  }

  function startWake() {
    if (!SpeechRec) {
      setStatus("Wake word needs Chrome or Edge (Web Speech API).");
      return;
    }
    unlockAudio(); // unlock audio output on this user gesture
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
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setStatus("Microphone permission needed for wake word.");
        setWakeUi(false);
      } else if (e.error === "network") {
        setStatus("Speech recognition unavailable in this browser — use Hold to talk or type.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setStatus("Wake word error: " + e.error);
      }
    };
    wakeRec.onend = () => {
      // auto-restart unless we're speaking or the user turned it off
      if (wakeOn && !speaking) {
        try {
          wakeRec.start();
        } catch (e) {}
      }
    };
    setWakeUi(true);
    setStatus("Listening for “Artemis…”  (try: “Artemis, daddy is home”)");
    try {
      wakeRec.start();
    } catch (e) {}
  }

  function stopWake() {
    setWakeUi(false);
    if (wakeRec) {
      try {
        wakeRec.stop();
      } catch (e) {}
    }
    setStatus("");
  }

  // Strip the wake word and send the rest as a message.
  function handleWake(raw) {
    if (busy || speaking) return;
    const txt = (raw || "").trim();
    const m = txt.match(/\bartemis\b[\s,!.:'-]*(.*)$/i);
    if (!m) {
      // Recognition is working but didn't catch the wake word — show what it heard.
      if (txt) setStatus("Heard: “" + txt + "” — say “Artemis …” to wake me.");
      return;
    }
    const cmd = (m[1] || "").trim();
    if (!cmd) {
      setStatus("Yes? I’m listening…");
      return;
    }
    sendText(cmd);
  }

  function pauseWakeForSpeech() {
    speaking = true;
    if (wakeRec) {
      try {
        wakeRec.stop();
      } catch (e) {}
    }
  }

  function resumeWakeAfterSpeech() {
    speaking = false;
    orbState(wakeOn ? "listening" : "idle");
    if (wakeOn && wakeRec) {
      try {
        wakeRec.start();
      } catch (e) {}
    }
  }

  // ---- push-to-talk (mic, Deepgram) --------------------------------------
  let mediaRecorder = null;
  let chunks = [];
  let stream = null;

  async function startRecording() {
    if (busy || mediaRecorder) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus("Microphone permission denied.");
      return;
    }
    ctx();
    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    unlockAudio();
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start();
    micBtn.classList.add("recording");
    orbState("listening");
    setStatus("Listening… release to send.");
  }

  async function onRecordingStop() {
    micBtn.classList.remove("recording");
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
    mediaRecorder = null;
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (!blob.size) {
      orbState(wakeOn ? "listening" : "idle");
      setStatus("");
      return;
    }
    setStatus("Transcribing…");
    try {
      const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": type }, body: blob });
      const data = await res.json();
      if (data.error) {
        setStatus(data.error);
        return;
      }
      const transcript = (data.transcript || "").trim();
      if (transcript) sendText(transcript);
      else setStatus("Didn't catch that — try again.");
    } catch (e) {
      setStatus("Transcription failed.");
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }

  // ---- wire up -----------------------------------------------------------
  if (sendBtn)
    sendBtn.addEventListener("click", () => {
      unlockAudio();
      sendText(inputEl.value);
    });
  if (inputEl)
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        unlockAudio();
        sendText(inputEl.value);
      }
    });
  if (wakeBtn) wakeBtn.addEventListener("click", () => (wakeOn ? stopWake() : startWake()));
  if (micBtn) {
    micBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startRecording();
    });
    micBtn.addEventListener("pointerup", stopRecording);
    micBtn.addEventListener("pointerleave", stopRecording);
    micBtn.addEventListener("pointercancel", stopRecording);
  }

  // Reflect availability once the server status is known.
  fetch("/api/status")
    .then((r) => r.json())
    .then((s) => {
      if (!s.chatEnabled) {
        setStatus("Add ANTHROPIC_API_KEY to .env to enable conversation.");
        [sendBtn, micBtn, wakeBtn].forEach((b) => b && (b.disabled = true));
      } else if (!s.voiceEnabled) {
        setStatus("Voice output disabled (no DEEPGRAM_API_KEY) — text + wake word still work.");
      }
      if (!SpeechRec && wakeBtn) {
        wakeBtn.disabled = true;
        wakeBtn.title = "Wake word needs Chrome or Edge";
      }
    })
    .catch(() => {});
})();
