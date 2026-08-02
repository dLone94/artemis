// Background-music continuity outside the cockpit. The dock toggle on the
// dashboard persists "artemisMusic" ("0" = explicit off; anything else means
// on once a track exists) — brain/about honour the same state so the bed
// keeps playing as you move between pages. The app shell allows autoplay;
// plain browsers get a one-gesture fallback. Same volume and file as the
// cockpit module (assets/music.mp3, gitignored, a track you legally own).
(function () {
  if (localStorage.getItem("artemisMusic") === "0") return;
  fetch("/assets/music.mp3", { method: "HEAD" })
    .then((r) => {
      if (!r.ok) return;
      const el = new Audio("/assets/music.mp3");
      el.loop = true;
      el.volume = 0.42;
      el.play().catch(() => {
        const once = () => el.play().catch(() => {});
        window.addEventListener("pointerdown", once, { once: true });
        window.addEventListener("keydown", once, { once: true });
      });
    })
    .catch(() => {});
})();
