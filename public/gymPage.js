// Gym live view: a server-session mirror with big controls. Voice stays with
// the main Artemis surface — the session lives server-side, so anything said
// there shows up here within one poll. Buttons feed the exact same streaming
// command path speech does; the page never mutates state on its own.

const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);
const card = $("card");
const idle = $("idle");
const restEl = $("rest");

let state = null;
let restDeadline = null;   // epoch ms, seeded from the server, ticked locally
let announcedRestEnd = true;
let lastSpokenLine = "";

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function spokenWeight(grams) {
  const whole = Math.floor(grams / 1000);
  const rest = grams % 1000;
  return rest === 0 ? `${whole}` : `${whole}.${String(rest).padStart(3, "0").replace(/0+$/, "")}`;
}

async function speak(text) {
  lastSpokenLine = text;
  try {
    const audio = new Audio("/api/tts?" + new URLSearchParams({ text }));
    await audio.play();
  } catch (e) { /* locked screen or autoplay veto: the countdown still shows */ }
}

// "repeat that" — re-speak the last line this page said, locally.
window.__gymRepeat = () => { if (lastSpokenLine) speak(lastSpokenLine); };

function render() {
  const has = state && state.exercise !== undefined && !("{}" === JSON.stringify(state));
  card.hidden = !has;
  idle.hidden = Boolean(has);
  if (!has) return;

  if (state.done) {
    $("exercise").textContent = "All done";
    $("position").textContent = "Say finish workout when you're ready.";
    $("lasttime").textContent = "";
    $("upnext").textContent = "";
    $("ticks").replaceChildren();
    restEl.classList.remove("on");
    return;
  }

  const ex = state.exercise;
  $("exercise").textContent = ex.name;
  $("position").textContent =
    `set ${state.setsLoggedThisExercise + 1} of ${ex.targetSets} · target ${ex.targetReps} reps`;
  $("lasttime").textContent = state.lastTime
    ? `last time: ${spokenWeight(state.lastTime.weightGrams)} kg × ${state.lastTime.reps}`
    : "first time logging this — pick a weight that leaves two reps in the tank";
  $("upnext").textContent = state.upNext ? `up next · ${state.upNext.name}` : "last exercise";

  const ticks = [];
  for (let i = 0; i < ex.targetSets; i++) {
    const tick = document.createElement("div");
    tick.className = "tick" + (i < state.setsLoggedThisExercise ? " done" : "");
    ticks.push(tick);
  }
  $("ticks").replaceChildren(...ticks);
}

function tickRest() {
  if (restDeadline === null) { restEl.classList.remove("on"); return; }
  const remaining = Math.max(0, Math.round((restDeadline - Date.now()) / 1000));
  if (remaining > 0) {
    restEl.classList.add("on");
    restEl.textContent = fmt(remaining);
    announcedRestEnd = false;
    return;
  }
  restEl.classList.remove("on");
  restDeadline = null;
  if (!announcedRestEnd && state && state.exercise && !state.done) {
    announcedRestEnd = true;
    speak(`Rest's up — ${state.exercise.name}, set ${state.setsLoggedThisExercise + 1}.`);
  }
}

async function poll() {
  try {
    const res = await fetch("/api/gym/session", { credentials: "same-origin" });
    const next = await res.json();
    state = next && next.templateId ? next : null;
    restDeadline = state && state.restRemainingSeconds !== null && state.restRemainingSeconds !== undefined
      ? Date.now() + state.restRemainingSeconds * 1000
      : restDeadline !== null && state ? restDeadline : null;
    if (!state) restDeadline = null;
    render();
  } catch (e) { /* transient network: keep the last view */ }
}

// Buttons speak the same language the user would — one shared command path.
async function sayCommand(text) {
  $("said").textContent = "→ " + text;
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] })
    });
    const raw = await res.text();
    const tokens = [...raw.matchAll(/^data: (.*)$/gm)]
      .map((m) => { try { return JSON.parse(m[1]); } catch (e) { return {}; } })
      .filter((d) => typeof d.t === "string")
      .map((d) => d.t)
      .join("");
    if (tokens) {
      $("said").textContent = tokens;
      speak(tokens);
    }
  } catch (e) {
    $("said").textContent = "couldn't reach Artemis — try again";
  }
  await poll();
}

addEventListener("click", (event) => {
  const button = event.target.closest("button[data-say]");
  if (button) sayCommand(button.dataset.say);
});

poll();
setInterval(poll, POLL_MS);
setInterval(tickRest, 250);
