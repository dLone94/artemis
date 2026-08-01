// pageCinema — cinematic handoff between Artemis pages (index / brain / about).
// Leaving: shutter panels close to a bright seam (CRT power-down), then the
// navigation proceeds. Arriving: the shutters retract from a glowing line.
// Implemented as a fixed OVERLAY — the page itself is never transformed, so
// canvases measuring their containers at load are never fooled by a squashed
// layout. Self-contained (injects its own styles); inert under reduced motion.
(function () {
  const reduced = !!(
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  if (reduced) return;

  const style = document.createElement("style");
  style.textContent = `
    .pc-overlay { position: fixed; inset: 0; z-index: 240; pointer-events: none; display: none; }
    .pc-overlay.on { display: block; }
    .pc-shut { position: absolute; left: 0; right: 0; height: 50.5%; background: #020610; }
    .pc-shut--top { top: 0; transform-origin: center top; }
    .pc-shut--bot { bottom: 0; transform-origin: center bottom; }
    .pc-line {
      position: absolute; left: 0; right: 0; top: 50%; height: 2px;
      transform: translateY(-50%); opacity: 0;
      background: rgba(235, 250, 255, 0.95);
      box-shadow: 0 0 26px rgba(140, 225, 255, 0.9), 0 0 70px rgba(140, 225, 255, 0.5);
    }
    .pc-overlay.down .pc-shut { animation: pc-close 300ms cubic-bezier(0.6, 0, 0.9, 0.4) both; }
    .pc-overlay.down .pc-line { animation: pc-line-in 300ms ease-out both; }
    .pc-overlay.up .pc-shut { animation: pc-open 520ms cubic-bezier(0.2, 0.8, 0.25, 1) both; }
    .pc-overlay.up .pc-line { animation: pc-line-out 620ms ease-out both; }
    @keyframes pc-close { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    @keyframes pc-open { from { transform: scaleY(1); } to { transform: scaleY(0); } }
    @keyframes pc-line-in { from { opacity: 0; } 40% { opacity: 1; } to { opacity: 1; } }
    @keyframes pc-line-out { from { opacity: 1; } 55% { opacity: 0.9; } to { opacity: 0; } }
  `;
  document.head.appendChild(style);

  let overlay = null;
  const buildOverlay = () => {
    overlay = document.createElement("div");
    overlay.className = "pc-overlay";
    overlay.innerHTML =
      '<div class="pc-shut pc-shut--top"></div>' +
      '<div class="pc-line"></div>' +
      '<div class="pc-shut pc-shut--bot"></div>';
    document.body.appendChild(overlay);
  };

  const enter = () => {
    buildOverlay();
    overlay.classList.add("on", "up");
    // Hard timeout cleanup — never trust a single animationend (child
    // animations bubble and can swallow a once-listener).
    setTimeout(() => overlay.classList.remove("on", "up"), 700);
  };
  if (document.body) enter();
  else document.addEventListener("DOMContentLoaded", enter, { once: true });

  document.addEventListener("click", (event) => {
    const link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link || link.target || link.hasAttribute("download")) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href)) return;
    const currentPage = location.pathname.split("/").pop() || "index.html";
    const targetPage = href.split("#")[0].split("?")[0];
    if (!targetPage || targetPage === currentPage) return; // same-page anchor
    event.preventDefault();
    overlay.classList.remove("up");
    overlay.classList.add("on", "down");
    setTimeout(() => {
      location.href = href;
    }, 320);
  });
})();
