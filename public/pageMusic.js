// Background-music continuity outside the cockpit. The dock toggle on the
// dashboard persists "artemisMusic" ("0" = explicit off; anything else means
// on once a track exists) — brain/about honour the same state so the bed
// keeps playing as you move between pages. The app shell allows autoplay;
// plain browsers get a one-gesture fallback. Same volume, file and ducking as
// the cockpit module (assets/music.mp3, gitignored, a track you legally own).
//
// about.html loads main.js, so Artemis can talk on this page too — and the
// cockpit HUD that owns the cockpit's ducking does NOT load here. That is why
// this listens for the "artemis-voice-state" broadcast main.js emits directly
// rather than going through window.ArtemisHUD, which is absent outside the
// cockpit and would silently swallow every state change.
import { musicGainFor, musicRampMs, BACKGROUND_MUSIC_GAIN } from "./musicLevels.js";
import { rememberPosition } from "./musicPosition.js";

(function () {
  if (localStorage.getItem("artemisMusic") === "0") return;
  // Levels come from musicLevels.js so this page and the cockpit can never
  // drift apart — they were two copies of 0.42 before.
  const FULL = BACKGROUND_MUSIC_GAIN;
  fetch("/assets/music.mp3", { method: "HEAD" })
    .then((r) => {
      if (!r.ok) return;
      const el = new Audio("/assets/music.mp3");
      el.loop = true;
      el.volume = FULL;
      // Pick the track up where the previous page left it. Without this every
      // move between dashboard, brain and about restarted it from the top.
      rememberPosition(el);

      // Ramp rather than jump: down fast so her first syllable is already
      // clear, back up slowly so the bed doesn't pump between sentences.
      let fadeTimer = 0;
      const fadeTo = (target, ms) => {
        clearInterval(fadeTimer);
        const from = el.volume, span = target - from, t0 = performance.now();
        if (Math.abs(span) < 0.002) { el.volume = target; return; }
        fadeTimer = setInterval(() => {
          const k = Math.min(1, (performance.now() - t0) / ms);
          el.volume = Math.max(0, Math.min(1, from + span * k));
          if (k >= 1) clearInterval(fadeTimer);
        }, 16);
      };
      // ONLY "speaking" ducks. "listening" is the resting state whenever the
      // wake word is armed, so ducking it too would pin the bed at the quiet
      // level forever and the duck would never be audible.
      window.addEventListener("artemis-voice-state", (e) => {
        if (el.paused) return;           // disabled bed: ducking never starts it
        fadeTo(musicGainFor(e.detail), musicRampMs(e.detail));
      });
      window.__pageMusic = el; // debug/verification

      el.play().catch(() => {
        const once = () => el.play().catch(() => {});
        window.addEventListener("pointerdown", once, { once: true });
        window.addEventListener("keydown", once, { once: true });
      });
    })
    .catch(() => {});
})();
