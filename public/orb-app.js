// Part 1 proving-ground glue: instantiate the orb, wire dev controls + audio.
import { VoiceOrb } from "./voiceOrb.js";

const stage = document.getElementById("orbStage");
const label = document.getElementById("statusLabel");
const LABELS = {
  idle: "◦ ARTEMIS · STANDBY",
  listening: "◦ LISTENING",
  thinking: "◦ THINKING",
  speaking: "◦ SPEAKING"
};

const orb = new VoiceOrb(stage);
window.__orb = orb; // exposed for verification

function setState(s) {
  orb.setStatus(s);
  label.textContent = LABELS[s] || "◦ ARTEMIS";
  document.querySelectorAll("[data-state]").forEach((b) => b.classList.toggle("active", b.dataset.state === s));
}

document.querySelectorAll("[data-state]").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.state !== "listening" && b.dataset.state !== "speaking") orb.stopAudio();
    setState(b.dataset.state);
  });
});

// LISTENING — route mic into the analyser
document.getElementById("micBtn").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    orb.connectMic(stream);
    setState("listening");
  } catch (e) {
    label.textContent = "◦ MIC BLOCKED";
  }
});

// SPEAKING — play a TTS clip and route it into the analyser
const ttsAudio = new Audio();
ttsAudio.crossOrigin = "anonymous";
document.getElementById("ttsBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Daddy is home. Systems nominal. I am watching everything." })
    });
    if (!res.ok) {
      label.textContent = "◦ TTS UNAVAILABLE";
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    orb.connectMediaElement(ttsAudio);
    setState("speaking");
    ttsAudio.src = url;
    ttsAudio.onended = () => {
      URL.revokeObjectURL(url);
      orb.stopAudio();
      setState("idle");
    };
    await ttsAudio.play();
  } catch (e) {
    label.textContent = "◦ AUDIO BLOCKED";
  }
});

setState("idle");
