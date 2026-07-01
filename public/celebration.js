/*
 * Artemis revenue celebration module — dependency-free.
 * Loaded BEFORE app.js so the payment poller can call window.celebratePayment(payment).
 *
 * Public API:
 *   window.celebratePayment(payment)   payment = { id, amount, currency, customerLabel }
 *                                      amount is in the SMALLEST currency unit (cents).
 *   window.fireTestCelebration(dollars, currency)   manual trigger, amount in MAJOR units.
 *   window.getCelebrationSettings() / window.setCelebrationSettings(patch)
 *
 * Notes:
 *   - The VISUAL is the primary signal; sound is an enhancement that may be silent on a
 *     cold load until the first user interaction (autoplay policy).
 *   - The orb reaction is COSMETIC. This app has no real "assistant speaking" state, so
 *     there is nothing to hijack. voiceActive() is a stub returning false — the hook is
 *     left in place in case a voice mode is ever added.
 *   - No quiet hours by design (always celebrate).
 */
(function () {
  "use strict";

  // ---- Tunable config -----------------------------------------------------
  var TIERS = {
    small: { maxAmount: 50, particles: 60, durationMs: 2000, amountScale: 1.0, orbPulse: 0.6 },
    medium: { maxAmount: 500, particles: 140, durationMs: 3000, amountScale: 1.4, orbPulse: 0.85 },
    large: { maxAmount: Infinity, particles: 260, durationMs: 4000, amountScale: 1.9, orbPulse: 1.2 }
  };

  var CELEBRATION_SOUND_URL = "assets/celebration.mp3"; // swap your own jingle here
  var STAGGER_MS = 700; // gap between replays in a burst
  var CONFETTI_COLORS = ["#34d399", "#22d3ee", "#a78bfa", "#fbbf24", "#f472b6", "#60a5fa"];
  var SETTINGS_KEY = "artemisCelebrationSettings";

  // ---- Settings (localStorage, default ON) --------------------------------
  function getSettings() {
    var defaults = { enabled: true, muted: false };
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      return { enabled: parsed.enabled !== false, muted: parsed.muted === true };
    } catch (e) {
      return defaults;
    }
  }

  function setSettings(patch) {
    var next = Object.assign(getSettings(), patch || {});
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (e) {}
    return next;
  }

  // ---- Helpers ------------------------------------------------------------
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Celebration-only app: no real speaking state. Stub kept for future voice mode.
  function voiceActive() {
    try {
      if (typeof window.celebrationVoiceActive === "function") {
        return Boolean(window.celebrationVoiceActive());
      }
    } catch (e) {}
    return false;
  }

  function tierForAmountMajor(amountMajor) {
    if (amountMajor < TIERS.small.maxAmount) return TIERS.small;
    if (amountMajor < TIERS.medium.maxAmount) return TIERS.medium;
    return TIERS.large;
  }

  function formatAmount(amountMinor, currency) {
    var major = (amountMinor || 0) / 100; // assumes 2-decimal currency (USD/EUR/etc.)
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: major % 1 === 0 ? 0 : 2
      }).format(major);
    } catch (e) {
      return "$" + major.toLocaleString();
    }
  }

  // ---- Audio (decode once, reuse; AnalyserNode drives the orb) -------------
  var audioCtx = null;
  var soundBuffer = null;
  var soundLoadStarted = false;
  var soundLoadFailed = false;

  function ensureAudioContext() {
    if (audioCtx) return audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  function loadSoundBuffer() {
    if (soundLoadStarted || soundLoadFailed) return;
    var ctx = ensureAudioContext();
    if (!ctx) {
      soundLoadFailed = true;
      return;
    }
    soundLoadStarted = true;
    fetch(CELEBRATION_SOUND_URL)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then(function (data) {
        return ctx.decodeAudioData(data);
      })
      .then(function (buffer) {
        soundBuffer = buffer;
      })
      .catch(function (err) {
        soundLoadFailed = true;
        console.info(
          "Artemis celebration: no playable sound at " +
            CELEBRATION_SOUND_URL +
            " (" +
            err.message +
            "). Visual still works."
        );
      });
  }

  function playSound() {
    var settings = getSettings();
    if (settings.muted) return null;
    var ctx = ensureAudioContext();
    if (!ctx || !soundBuffer) return null;
    try {
      if (ctx.state === "suspended") ctx.resume();
      var source = ctx.createBufferSource();
      source.buffer = soundBuffer;
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      source.start(0);
      return analyser;
    } catch (e) {
      return null; // autoplay blocked etc. — visual remains primary
    }
  }

  function warmAudioOnGesture() {
    var ctx = ensureAudioContext();
    if (ctx && ctx.state === "suspended") ctx.resume();
    loadSoundBuffer();
    window.removeEventListener("pointerdown", warmAudioOnGesture);
    window.removeEventListener("keydown", warmAudioOnGesture);
  }
  window.addEventListener("pointerdown", warmAudioOnGesture);
  window.addEventListener("keydown", warmAudioOnGesture);

  // ---- Confetti overlay (single persistent canvas) ------------------------
  var canvas = null;
  var ctx2d = null;
  var particles = [];
  var rafRunning = false;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.className = "celebration-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    ctx2d = canvas.getContext("2d");
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function spawnConfetti(tier) {
    ensureCanvas();
    var count = tier.particles;
    var originX = canvas.width / 2;
    for (var i = 0; i < count; i++) {
      particles.push({
        x: originX + (Math.random() - 0.5) * 120,
        y: canvas.height * 0.25 + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 9,
        vy: Math.random() * -11 - 4,
        size: (3 + Math.random() * 4) * (tier === TIERS.large ? 1.5 : 1),
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.3,
        life: tier.durationMs / 16
      });
    }
    if (!rafRunning) {
      rafRunning = true;
      requestAnimationFrame(stepConfetti);
    }
  }

  function stepConfetti() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    var gravity = 0.32;
    var alive = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.vy += gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.life -= 1;
      if (p.life > 0 && p.y < canvas.height + 20) {
        alive.push(p);
        ctx2d.save();
        ctx2d.translate(p.x, p.y);
        ctx2d.rotate(p.rot);
        ctx2d.globalAlpha = Math.max(0, Math.min(1, p.life / 30));
        ctx2d.fillStyle = p.color;
        ctx2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
        ctx2d.restore();
      }
    }
    particles = alive;
    if (particles.length > 0) {
      requestAnimationFrame(stepConfetti);
    } else {
      rafRunning = false;
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // ---- Amount banner ("+$1,300" is the hero) ------------------------------
  function showAmountBanner(text, subText, tier, durationMs) {
    var banner = document.createElement("div");
    banner.className = "celebration-banner";
    banner.style.setProperty("--amount-scale", String(tier.amountScale));

    var amountEl = document.createElement("div");
    amountEl.className = "celebration-amount";
    amountEl.textContent = "+" + text;
    banner.appendChild(amountEl);

    if (subText) {
      var subEl = document.createElement("div");
      subEl.className = "celebration-sub";
      subEl.textContent = subText;
      banner.appendChild(subEl);
    }

    document.body.appendChild(banner);
    void banner.offsetWidth; // reflow then animate in
    banner.classList.add("is-visible");

    window.setTimeout(function () {
      banner.classList.remove("is-visible");
      window.setTimeout(function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner);
      }, 500);
    }, durationMs);
  }

  // ---- Reactive orb: surge the WebGL VoiceOrb (window.__orb) ----------------
  function webglOrb() {
    return window.__orb || null;
  }

  function driveOrbFromAudio(analyser, tier) {
    var o = webglOrb();
    if (!o || !analyser) return;
    var data = new Uint8Array(analyser.frequencyBinCount);
    o.setStatus("speaking");
    var idleFrames = 0;
    function frame() {
      analyser.getByteFrequencyData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) sum += data[i];
      var avg = sum / data.length / 255; // 0..1
      o.feed(Math.min(1, avg * (1 + tier.orbPulse)));
      if (avg < 0.01) idleFrames++;
      else idleFrames = 0;
      if (idleFrames < 30) requestAnimationFrame(frame);
      else o.setStatus("idle");
    }
    requestAnimationFrame(frame);
  }

  function pulseOrbCosmetic(tier, durationMs) {
    var o = webglOrb();
    if (!o) return;
    o.setStatus("speaking");
    o.feed(Math.min(1, 0.4 + tier.orbPulse * 0.4));
    window.setTimeout(function () {
      o.setStatus("idle");
    }, Math.min(durationMs, 1400));
  }

  // ---- Core render + burst queue ------------------------------------------
  var queue = [];
  var draining = false;

  function renderCelebration(payment, allowSound) {
    var amountMinor = payment.amount || 0;
    var tier = tierForAmountMajor(amountMinor / 100);
    var amountText = formatAmount(amountMinor, payment.currency);
    var sub = payment.customerLabel ? "from " + payment.customerLabel : "";
    var reduced = prefersReducedMotion();

    if (!reduced) spawnConfetti(tier);
    showAmountBanner(amountText, sub, tier, reduced ? 1500 : tier.durationMs);

    var soundSuppressed = !allowSound || voiceActive() || reduced;
    if (soundSuppressed) {
      if (!reduced) pulseOrbCosmetic(tier, tier.durationMs);
      return false;
    }

    var analyser = playSound();
    if (analyser) {
      driveOrbFromAudio(analyser, tier);
      return true;
    }
    pulseOrbCosmetic(tier, tier.durationMs);
    return false;
  }

  function drainQueue() {
    if (draining) return;
    draining = true;
    var soundPlayedThisBurst = false;
    function next() {
      if (queue.length === 0) {
        draining = false;
        return;
      }
      var payment = queue.shift();
      var played = renderCelebration(payment, !soundPlayedThisBurst);
      if (played) soundPlayedThisBurst = true;
      window.setTimeout(next, STAGGER_MS);
    }
    next();
  }

  // ---- Public API ---------------------------------------------------------
  function celebratePayment(payment) {
    if (!payment) return;
    if (!getSettings().enabled) return;
    queue.push(payment);
    drainQueue();
  }

  function fireTestCelebration(dollars, currency) {
    var amount = Math.round((Number(dollars) || 25) * 100);
    celebratePayment({
      id: "test_" + amount + "_" + (queue.length + 1),
      amount: amount,
      currency: currency || "USD",
      customerLabel: "Test Customer"
    });
  }

  window.celebratePayment = celebratePayment;
  window.fireTestCelebration = fireTestCelebration;
  window.getCelebrationSettings = getSettings;
  window.setCelebrationSettings = setSettings;
})();
