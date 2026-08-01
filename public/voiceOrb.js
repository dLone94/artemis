// The Artemis System — a voice-reactive reactor orb with eleven
// honest agent moons. Canvas 2D only; all scene geometry and draw-style
// pools are fixed before the animation loop starts.

import { PAL, prefersReducedMotion } from "./orbShared.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const STYLE_ALPHA_BUCKETS = 16;
const WORDMARK_LETTERS = ["A","R","T","E","M","I","S"];
const RIPPLE_POOL_SIZE = 16;
const HALO_LIFE = 1.25;
const BASE_SPIN_RATE = TAU / 60;
const REFORM_DURATION = 0.72;
const CAM_DISTANCE = 3.2;
const MOON_COUNT = 11;
const MOON_SETTLE_TIME = 0.6;
const MOON_ORBIT_STEPS = 48;
const MOON_LABEL_FONT = '600 9px "JetBrains Mono", monospace';
const SWEEP_LIFE = 0.8;

// Adaptive Jarvis palette: idle/listening cyan, thinking gold, speaking white-hot.
const STATE_COLORS = {
  idle:      { core: [143, 214, 255], ring: [79, 195, 255] },
  listening: { core: [191, 239, 255], ring: [110, 210, 255] },
  thinking:  { core: [255, 196, 102], ring: [255, 176, 76] },
  speaking:  { core: [242, 251, 255], ring: [190, 235, 255] },
};
const REACTOR_STATE_KEYS = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "speaking",
]);

const MOON_LABELS = Object.freeze([
  "RESEARCH",
  "MAIL",
  "MESSAGES",
  "MEDIA",
  "MEMORY",
  "FINANCE",
  "BRIEF",
  "FOLLOW-UPS",
  "SCHOOL",
  "PLAN",
  "RADAR"
]);

// One-tap description per moon — shown as a context card on click.
export const MOON_INFO = Object.freeze([
  { title: "RESEARCH", what: "Web research with sources.", say: "should I invest in… / research…" },
  { title: "MAIL", what: "Reads, checks and trashes Gmail — trash only, always asks.", say: "check my email · delete number 2" },
  { title: "MESSAGES", what: "WhatsApp unread checks and drafted sends you approve.", say: "any WhatsApp messages?" },
  { title: "MEDIA", what: "Opens sites, plays music and video.", say: "play some jazz · open YouTube" },
  { title: "MEMORY", what: "Notes, reminders and meeting notes.", say: "take notes · what were my meeting notes?" },
  { title: "FINANCE", what: "Live market figures, always with source and date.", say: "what's the dollar to shilling?" },
  { title: "BRIEF", what: "Your morning rundown: mail, day, money minute, world.", say: "give me my brief" },
  { title: "FOLLOW-UPS", what: "Who owes you a reply, and whom you owe. Nudges you send.", say: "any follow-ups?" },
  { title: "SCHOOL", what: "Investing lessons from zero, one at a time.", say: "teach me investing · next lesson" },
  { title: "PLAN", what: "Your Money Map: staged plan from your own numbers.", say: "my money map" },
  { title: "RADAR", what: "Weekly sourced sweep of your opportunity themes.", say: "run the radar" }
]);

const FAMILY_NAMES = Object.freeze([
  "research",
  "web",
  "email",
  "messages",
  "media",
  "navigate",
  "memory",
  "notes",
  "finance",
  "briefing",
  "followups",
  "followups_nudge",
  "school",
  "map",
  "map_update",
  "radar",
  "radar_update",
  "meeting"
]);
const FAMILY_MOONS = new Int8Array([0, 0, 1, 2, 3, 3, 4, 4, 5, 6, 7, 7, 8, 9, 9, 10, 10, 4]);

function makeAlphaStyles(prefix, count = STYLE_ALPHA_BUCKETS) {
  const styles = new Array(count);
  const last = count - 1;
  for (let i = 0; i < count; i++) {
    styles[i] = prefix + (i / last).toFixed(3) + ")";
  }
  return Object.freeze(styles);
}

function makeGlowSprite(prefix, size, strength) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size * 0.5;
  const glow = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    center
  );
  glow.addColorStop(0, prefix + strength + ")");
  glow.addColorStop(0.18, prefix + strength * 0.72 + ")");
  glow.addColorStop(0.52, prefix + strength * 0.2 + ")");
  glow.addColorStop(1, prefix + "0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

// 60 instrument ticks, every 5th one longer. The sprite spans 1.1 orb radii
// half-width, so drawing it at 2.2R keeps tick radii proportional at any size.
function makeTickSprite(rgb, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size * 0.5;
  const unit = center / 1.1;
  ctx.translate(center, center);
  ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`;
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const angle = (i / 60) * TAU;
    const inner = unit * 0.57;
    const outer = unit * (major ? 0.62 : 0.6);
    ctx.lineWidth = major ? 3.6 : 2.2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.stroke();
  }
  return canvas;
}

function makeReactorSprite(rgb, size, halo) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size * 0.5;
  const gradient = ctx.createRadialGradient(
    center,
    center,
    halo ? center / 12 : 0,
    center,
    center,
    center
  );
  if (halo) {
    gradient.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    gradient.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  } else {
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.8)`);
    gradient.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

const O_STYLES = makeAlphaStyles(PAL.O);
const B_STYLES = makeAlphaStyles(PAL.B);
const V_STYLES = makeAlphaStyles(PAL.V);
const HL_STYLES = makeAlphaStyles(PAL.Hl);
const MAIL_STYLES = makeAlphaStyles(PAL.MAIL);
const MESSAGE_STYLES = makeAlphaStyles(PAL.MESSAGES);
const ICE_STYLES = makeAlphaStyles(PAL.ICE);
const GOLD_STYLES = makeAlphaStyles(PAL.GOLD);
const OK_STYLES = makeAlphaStyles(PAL.OK);
const ERR_STYLES = makeAlphaStyles(PAL.ERR);
const MOON_STYLES = Object.freeze([
  O_STYLES,
  MAIL_STYLES,
  MESSAGE_STYLES,
  V_STYLES,
  ICE_STYLES,
  GOLD_STYLES,
  HL_STYLES,      // BRIEF — bright ice
  MAIL_STYLES,    // FOLLOW-UPS — mail-adjacent teal
  V_STYLES,       // SCHOOL — violet
  GOLD_STYLES,    // PLAN — finance gold family
  O_STYLES        // RADAR — primary cyan
]);
const MOON_PREFIXES = Object.freeze([
  PAL.O,
  PAL.MAIL,
  PAL.MESSAGES,
  PAL.V,
  PAL.ICE,
  PAL.GOLD,
  PAL.Hl,
  PAL.MAIL,
  PAL.V,
  PAL.GOLD,
  PAL.O
]);
const SCENE_WASH = PAL.D + "0.022)";
const GRID_STYLE = PAL.D + "0.05)";


export class VoiceOrb {
  constructor(container, opts = {}) {
    this.container = container;
    if (typeof window !== "undefined") window.__voiceOrb = this;
    this.center = !!opts.center;
    this.reduced = prefersReducedMotion();
    this.status = "idle";
    this.cur = { amp: 0 };
    this._manualAmp = 0;
    this.NB = 28;
    this.bins = new Float32Array(this.NB);

    // Fixed halo/ripple pool, shared by periodic cadence pulses and speaking
    // peaks.
    this._ripples = new Array(RIPPLE_POOL_SIZE);
    for (let i = 0; i < RIPPLE_POOL_SIZE; i++) {
      this._ripples[i] = { t0: 0, e: 0 };
    }
    this._rippleCount = 0;
    this._prevAmp = 0;
    this._lastRipple = -1;
    this._nextHaloAt = 4.8;

    this._audioActive = false;
    this._raf = 0;
    this._disposed = false;
    this._listeningMix = 0;
    this._thinkingMix = 0;
    this._speakingMix = 0;
    this._coreRGB = [0, 0, 0];
    this._ringRGB = [0, 0, 0];
    this._activeMix = 0;
    this._breathEnv = 0; // slow-eased voice envelope: a swell, not a jitter
    this._dt = 0;
    this._ringAngleInner = 0;
    this._ringAngleOuter = 0;
    this._tickAngle = 0;
    this._sweep = { active: 0, t0: 0 }; // one sweep at a time; retrigger restarts
    // Two hologram gimbal rings: fixed tilt, precessing axis, spinning phase.
    this._gimbals = [
      { radius: 1.12, tilt: 62 * DEG, prec: 0.6, precSpeed: 0.09, spin: 0, spinSpeed: 0.5 },
      { radius: 1.26, tilt: 74 * DEG, prec: 2.1, precSpeed: -0.06, spin: 0, spinSpeed: -0.36 },
    ];
    this._globeYaw = 0.78; // boot facing ~15E — Africa/Europe toward camera
    this._reformStart = -1;
    this._reformStrength = 0;
    this._reformOvershoot = 0;
    this._lastFrameAt = 0;
    this._elapsed = 0;

    // ---- Six inclined moon orbits and independent lifecycle slots ----
    this._moonOrbitRadius = new Float32Array(MOON_COUNT);
    this._moonPeriod = new Float32Array(MOON_COUNT);
    this._moonPhase = new Float32Array(MOON_COUNT);
    this._moonBobAmount = new Float32Array(MOON_COUNT);
    this._moonBobRate = new Float32Array(MOON_COUNT);
    this._moonBobPhase = new Float32Array(MOON_COUNT);
    this._moonCoreRadius = new Float32Array(MOON_COUNT);
    this._moonBasisU = new Float32Array(MOON_COUNT * 3);
    this._moonBasisV = new Float32Array(MOON_COUNT * 3);
    this._moonScreenX = new Float32Array(MOON_COUNT);
    this._moonScreenY = new Float32Array(MOON_COUNT);
    this._moonDepth = new Float32Array(MOON_COUNT);
    this._moonScale = new Float32Array(MOON_COUNT);
    this._moonVisualRadius = new Float32Array(MOON_COUNT);
    this._moonSettleMix = new Float32Array(MOON_COUNT);
    this._moonAlphaBucket = new Uint8Array(MOON_COUNT);
    this._moonActivityMix = new Float32Array(MOON_COUNT);
    this._moonRuns = new Uint16Array(MOON_COUNT);
    this._moonSettleAt = new Float64Array(MOON_COUNT);
    this._moonSettleOk = new Uint8Array(MOON_COUNT);
    this._moonSettleTimers = new Array(MOON_COUNT);
    this._moonSettleCallbacks = new Array(MOON_COUNT);
    this._familyRuns = new Uint16Array(FAMILY_NAMES.length);
    this._moonOrbitWorldX = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );
    this._moonOrbitWorldY = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );
    this._moonOrbitWorldZ = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );
    this._moonOrbitScreenX = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );
    this._moonOrbitScreenY = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );
    this._moonOrbitDepth = new Float32Array(
      MOON_COUNT * MOON_ORBIT_STEPS
    );

    for (let i = 0; i < MOON_COUNT; i++) {
      const orbitRadius = 1.25 + i * 0.07;
      const inclination = -0.9 + i * 0.34;
      const node = 0.22 + i * 1.07;
      const cosInclination = Math.cos(inclination);
      const sinInclination = Math.sin(inclination);
      const cosNode = Math.cos(node);
      const sinNode = Math.sin(node);
      const offset = i * 3;

      this._moonOrbitRadius[i] = orbitRadius;
      this._moonPeriod[i] = 40 + i * 9.6;
      this._moonPhase[i] = (i * 2.399963229728653) % TAU;
      this._moonBobAmount[i] = 0.024 + (i % 3) * 0.007;
      this._moonBobRate[i] = TAU / (11 + i * 1.7);
      this._moonBobPhase[i] = i * 1.37;
      this._moonCoreRadius[i] = 3 + (i % 3);
      this._moonSettleAt[i] = -1;
      this._moonSettleTimers[i] = 0;
      this._moonSettleCallbacks[i] = () => {
        this._moonSettleTimers[i] = 0;
        if (this._disposed || this._moonRuns[i]) return;
        this._moonSettleAt[i] = -1;
        this._loop();
      };

      // U and V form a pre-tilted circular orbit plane; camera projection makes
      // it elliptical. Evaluation is two scalar basis combinations per frame.
      this._moonBasisU[offset] = cosNode;
      this._moonBasisU[offset + 1] = 0;
      this._moonBasisU[offset + 2] = -sinNode;
      this._moonBasisV[offset] = cosInclination * sinNode;
      this._moonBasisV[offset + 1] = -sinInclination;
      this._moonBasisV[offset + 2] = cosInclination * cosNode;

      for (let point = 0; point < MOON_ORBIT_STEPS; point++) {
        const angle = (point / MOON_ORBIT_STEPS) * TAU;
        const orbitU = Math.cos(angle) * orbitRadius;
        const orbitV = Math.sin(angle) * orbitRadius;
        const orbitOffset = i * MOON_ORBIT_STEPS + point;
        this._moonOrbitWorldX[orbitOffset] =
          this._moonBasisU[offset] * orbitU +
          this._moonBasisV[offset] * orbitV;
        this._moonOrbitWorldY[orbitOffset] =
          this._moonBasisU[offset + 1] * orbitU +
          this._moonBasisV[offset + 1] * orbitV;
        this._moonOrbitWorldZ[orbitOffset] =
          this._moonBasisU[offset + 2] * orbitU +
          this._moonBasisV[offset + 2] * orbitV;
      }
    }

    this.cv = document.createElement("canvas");
    this.cv.style.display = "block";
    this.cv.style.width = "100%";
    this.cv.style.height = "100%";
    container.appendChild(this.cv);
    this.ctx = this.cv.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // State-color gradients are cached once; frame drawing only crossfades and
    // scales them, preserving the renderer's no-gradient-allocation convention.
    this._coreHaloSprites = new Array(REACTOR_STATE_KEYS.length);
    this._coreDiscSprites = new Array(REACTOR_STATE_KEYS.length);
    this._coreSpriteWeights = new Float32Array(REACTOR_STATE_KEYS.length);
    this._tickSprites = new Array(REACTOR_STATE_KEYS.length);
    for (let state = 0; state < REACTOR_STATE_KEYS.length; state++) {
      const key = REACTOR_STATE_KEYS[state];
      this._coreHaloSprites[state] = makeReactorSprite(STATE_COLORS[key].core, 256, true);
      this._coreDiscSprites[state] = makeReactorSprite(STATE_COLORS[key].core, 256, false);
      this._tickSprites[state] = makeTickSprite(STATE_COLORS[key].ring, 512);
    }

    // Cached moon and atmosphere glows; frame drawing only scales sprites.
    this._moonGlowSprites = new Array(MOON_COUNT);
    for (let moon = 0; moon < MOON_COUNT; moon++) {
      this._moonGlowSprites[moon] = makeGlowSprite(
        MOON_PREFIXES[moon],
        32,
        0.76
      );
    }
    this._settleGlowSprites = new Array(2);
    this._settleGlowSprites[0] = makeGlowSprite(PAL.ERR, 32, 0.78);
    this._settleGlowSprites[1] = makeGlowSprite(PAL.OK, 32, 0.78);

    this._mouse = { x: 0, y: 0 };
    this._mx = 0;
    this._my = 0;
    this._boundLoop = this._loop.bind(this);

    this._onResize = () => {
      this.resize();
      if (this.reduced) this._loop();
    };
    window.addEventListener("resize", this._onResize);
    this._onMouse = (event) => {
      this._mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      this._mouse.y = -((event.clientY / window.innerHeight) * 2 - 1);
    };
    if (!this.reduced) window.addEventListener("pointermove", this._onMouse);
    this._onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
      } else if (!this._disposed) {
        const resumedAt = performance.now();
        this._t0 = resumedAt - this._elapsed * 1000;
        this._lastFrameAt = resumedAt;
        this._loop();
      }
    };
    document.addEventListener("visibilitychange", this._onVis);

    this._scrollProg = 0;
    this._onScroll = () => {
      const height = window.innerHeight || 1;
      this._scrollProg = Math.max(
        0,
        Math.min(1, window.scrollY / (height * 0.85))
      );
    };
    window.addEventListener("scroll", this._onScroll, { passive: true });

    this._wordmarkSize = 0;
    this._wordmarkX = new Float32Array(WORDMARK_LETTERS.length);
    this.resize();
    this._t0 = performance.now();
    this._lastFrameAt = this._t0;
    this._loop();
  }

  resize() {
    // Dashboard v2 gives the globe a real square hub. Opt into that host's
    // coordinate space so the canvas stays circular and moon hit-testing uses
    // the same pixels; every other page keeps the original viewport scene.
    const hostRect = document.body?.classList.contains("dashboard-v2")
      ? this.container?.getBoundingClientRect?.()
      : null;
    const width = hostRect && hostRect.width > 1 ? Math.round(hostRect.width) : window.innerWidth;
    const height = hostRect && hostRect.height > 1 ? Math.round(hostRect.height) : window.innerHeight;
    this.W = width;
    this.H = height;
    this.cv.width = Math.max(1, width * this.dpr);
    this.cv.height = Math.max(1, height * this.dpr);
    this.narrow = width < 820;
    const base = Math.min(width, height) * 0.4;
    this._wordmarkSize = Math.round(base * 0.082);
    this._wordmarkFont =
      "600 " + this._wordmarkSize + 'px "JetBrains Mono", monospace';
    // Per-letter x offsets, measured once here so the frame loop never calls
    // measureText. Monospace: every glyph advance is equal, gap = one space.
    {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = this._wordmarkFont;
      const adv = ctx.measureText("A").width + ctx.measureText(" ").width;
      const left = -adv * (WORDMARK_LETTERS.length - 1) / 2;
      for (let i = 0; i < WORDMARK_LETTERS.length; i++) {
        this._wordmarkX[i] = left + adv * i;
      }
      ctx.restore();
    }
  }

  setStatus(status) {
    if (
      status === "idle" ||
      status === "listening" ||
      status === "thinking" ||
      status === "speaking"
    ) {
      if (status !== this.status) {
        const previous = this.status;
        this.status = status;
        const time = this.reduced ? 0 : this._elapsed || 0;

        if (previous === "thinking" && status !== "thinking") {
          this._reformStart = time;
          this._reformStrength = this.reduced ? 0 : this._thinkingMix;
        } else if (status === "thinking") {
          this._reformStart = -1;
          this._reformStrength = 0;
          this._reformOvershoot = 0;
        }

        if (this.reduced) this._rippleCount = 0;
        if (!this.reduced && status === "idle") {
          this._nextHaloAt = time + 4.8;
        } else if (!this.reduced && status === "listening") {
          this._nextHaloAt = time + 2.2;
        }
      }
    }
    if (this.reduced) this._loop();
  }

  feed(amplitude) {
    const value = Math.max(0, Math.min(1, Number(amplitude) || 0));
    if (value > this._manualAmp) this._manualAmp = value;
  }

  // Boot ignition: three staggered halo ripples plus a breath kick — the
  // reactor powers up as the HUD assembles. Safe to call any time.
  ignite() {
    const time = this.reduced ? 0 : this._elapsed || 0;
    this._emitRipple(time, 1);
    this._breathEnv = Math.max(this._breathEnv, 0.85);
    if (!this.reduced) {
      setTimeout(() => {
        if (!this._disposed) this._emitRipple(this._elapsed, 0.8);
      }, 240);
      setTimeout(() => {
        if (!this._disposed) this._emitRipple(this._elapsed, 0.6);
      }, 480);
    } else {
      this._loop();
    }
  }

  /**
   * Which moon (if any) sits under a canvas-relative point. Returns the
   * MOON_INFO entry plus its index, or null. Generous 18px halo — these are
   * small targets.
   */
  moonInfoAt(x, y) {
    if (this._hitCenterX == null) return null;
    let best = -1;
    let bestD = 18 * 18;
    for (let i = 0; i < MOON_COUNT; i++) {
      const dx = x - (this._hitCenterX + this._moonScreenX[i]);
      const dy = y - (this._hitCenterY + this._moonScreenY[i]);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? { index: best, ...MOON_INFO[best] } : null;
  }

  toolEvent(data = {}) {
    if (!data || typeof data !== "object") return;
    const phase =
      data.phase === "start" || data.phase === "end" ? data.phase : "";
    if (!phase || typeof data.family !== "string") return;
    const family = data.family.trim().toLowerCase();
    let familyIndex = -1;
    for (let i = 0; i < FAMILY_NAMES.length; i++) {
      if (family === FAMILY_NAMES[i]) {
        familyIndex = i;
        break;
      }
    }
    if (familyIndex < 0) return;

    const moon = FAMILY_MOONS[familyIndex];
    if (phase === "start") {
      // A firing tool call sends a bright highlight along the inner ring.
      this._sweep.active = 1;
      this._sweep.t0 = this.reduced ? 0 : this._elapsed;
      if (this._moonSettleTimers[moon]) {
        clearTimeout(this._moonSettleTimers[moon]);
        this._moonSettleTimers[moon] = 0;
      }
      if (this._familyRuns[familyIndex] < 65535) {
        if (!this._moonRuns[moon]) this._moonSettleOk[moon] = 1;
        this._familyRuns[familyIndex]++;
        if (this._moonRuns[moon] < 65535) this._moonRuns[moon]++;
      }
      this._moonSettleAt[moon] = -1;
    } else {
      // End events cannot release a different alias sharing the same moon.
      if (!this._familyRuns[familyIndex]) return;
      this._familyRuns[familyIndex]--;
      if (this._moonRuns[moon]) this._moonRuns[moon]--;
      if (data.ok !== true) this._moonSettleOk[moon] = 0;
      if (!this._moonRuns[moon]) {
        this._moonSettleAt[moon] = this.reduced ? 0 : this._elapsed;
        if (this.reduced) {
          this._moonSettleTimers[moon] = setTimeout(
            this._moonSettleCallbacks[moon],
            MOON_SETTLE_TIME * 1000
          );
        }
      }
    }

    if (this.reduced) this._loop();
  }

  _emitRipple(time, energy) {
    let slot = this._rippleCount;
    if (slot < this._ripples.length) {
      this._rippleCount++;
    } else {
      slot = 0;
      for (let i = 1; i < this._ripples.length; i++) {
        if (this._ripples[i].t0 < this._ripples[slot].t0) slot = i;
      }
    }
    this._ripples[slot].t0 = time;
    this._ripples[slot].e = Math.max(0, Math.min(1, energy));
  }

  // ---- Audio plumbing (public behavior preserved) ----
  _ensureAudio() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = AudioContextClass ? new AudioContextClass() : null;
      if (this.audioCtx) {
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.6;
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      }
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  connectMic(stream) {
    if (!this._ensureAudio()) return;
    this._disconnectSource();
    if (this._micStream && this._micStream !== stream) {
      try {
        this._micStream.getTracks().forEach((track) => track.stop());
      } catch (error) {}
    }
    this._synthSpeak = false;
    this.srcNode = this.audioCtx.createMediaStreamSource(stream);
    this.srcNode.connect(this.analyser);
    this._micStream = stream;
    this._audioActive = true;
  }

  // WebKit/Orion can break media playback after createMediaElementSource.
  // TTS remains connected directly to the element; visuals use a synthetic
  // speech envelope.
  connectMediaElement(el) {
    this._ensureAudio();
    this._disconnectSource();
    this._audioActive = false;
    this._synthSpeak = true;
  }

  _disconnectSource() {
    if (this.srcNode) {
      try {
        this.srcNode.disconnect();
      } catch (error) {}
    }
    this.srcNode = null;
  }

  stopAudio() {
    this._disconnectSource();
    this._audioActive = false;
    this._synthSpeak = false;
    if (this._micStream) {
      this._micStream.getTracks().forEach((track) => track.stop());
      this._micStream = null;
    }
  }

  _sampleAmp() {
    if (!this.analyser || !this._audioActive) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
    return Math.min(1, (sum / this.freq.length / 255) * 1.6);
  }

  _blendPalette(out, key) {
    const idle = STATE_COLORS.idle[key];
    const listen = STATE_COLORS.listening[key];
    const think = STATE_COLORS.thinking[key];
    const speak = STATE_COLORS.speaking[key];
    for (let channel = 0; channel < 3; channel++) {
      let value = idle[channel];
      value += (listen[channel] - value) * this._listeningMix;
      value += (think[channel] - value) * this._thinkingMix;
      value += (speak[channel] - value) * this._speakingMix;
      out[channel] = value | 0;
    }
  }

  // ---- Animation/state loop ----
  _loop() {
    if (this._disposed) return;
    if (!this.reduced) this._raf = requestAnimationFrame(this._boundLoop);

    const now = performance.now();
    const dt = this.reduced
      ? 0
      : Math.max(0, Math.min(0.05, (now - this._lastFrameAt) / 1000));
    this._dt = dt;
    this._lastFrameAt = now;
    this._elapsed = (now - this._t0) / 1000;
    const time = this.reduced ? 0 : this._elapsed;

    const stateEase = this.reduced ? 1 : 1 - Math.exp(-dt * 7);
    const listeningTarget = this.status === "listening" ? 1 : 0;
    const thinkingTarget = this.status === "thinking" ? 1 : 0;
    const speakingTarget = this.status === "speaking" ? 1 : 0;
    this._listeningMix +=
      (listeningTarget - this._listeningMix) * stateEase;
    this._thinkingMix += (thinkingTarget - this._thinkingMix) * stateEase;
    this._speakingMix += (speakingTarget - this._speakingMix) * stateEase;
    this._blendPalette(this._coreRGB, "core");
    this._blendPalette(this._ringRGB, "ring");
    this._activeMix = Math.max(
      this._listeningMix,
      Math.max(this._thinkingMix, this._speakingMix)
    );

    if (!this.reduced) {
      this._globeYaw +=
        dt * BASE_SPIN_RATE * (1 + this._listeningMix * 1.5);
    }

    this._reformOvershoot = 0;
    if (!this.reduced && this._reformStart >= 0) {
      const age = time - this._reformStart;
      if (age < REFORM_DURATION) {
        const progress = Math.max(0, age / REFORM_DURATION);
        this._reformOvershoot =
          this._reformStrength *
          Math.sin(progress * Math.PI) *
          (1 - progress) *
          0.12;
      } else {
        this._reformStart = -1;
        this._reformStrength = 0;
      }
    }

    for (let i = 0; i < MOON_COUNT; i++) {
      const target = this._moonRuns[i] ? 1 : 0;
      const moonEase = this.reduced
        ? 1
        : 1 - Math.exp(-dt * (target ? 5.4 : 4.2));
      this._moonActivityMix[i] +=
        (target - this._moonActivityMix[i]) * moonEase;
      if (
        !this._moonRuns[i] &&
        this._moonSettleAt[i] >= 0 &&
        time - this._moonSettleAt[i] >= MOON_SETTLE_TIME
      ) {
        this._moonSettleAt[i] = -1;
      }
    }

    // Spectrum peak-per-band and the overall voice envelope remain compatible
    // with the prior renderer and the external __artemisAmp consumer.
    let raw = this._manualAmp;
    if (this.analyser && this._audioActive) {
      this.analyser.getByteFrequencyData(this.freq);
      let sum = 0;
      for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
      raw = Math.max(
        raw,
        Math.min(1, (sum / this.freq.length / 255) * 1.6)
      );
      const usable = Math.floor(this.freq.length * 0.72);
      for (let band = 0; band < this.NB; band++) {
        const from = Math.floor((band / this.NB) * usable);
        const to = Math.max(
          from + 1,
          Math.floor(((band + 1) / this.NB) * usable)
        );
        let peak = 0;
        for (let i = from; i < to; i++) {
          if (this.freq[i] > peak) peak = this.freq[i];
        }
        const value = peak / 255;
        this.bins[band] +=
          (value - this.bins[band]) *
          (value > this.bins[band] ? 0.6 : 0.28);
      }
    } else if (this._synthSpeak && !this.reduced) {
      const envelope =
        0.4 +
        0.45 *
          Math.abs(Math.sin(time * 6.5)) *
          (0.55 + 0.45 * Math.sin(time * 2.1 + 0.7));
      raw = Math.max(raw, envelope);
      for (let band = 0; band < this.NB; band++) {
        const value =
          envelope *
          (0.35 +
            0.65 *
              Math.abs(
                Math.sin(time * (3.2 + band * 0.45) + band * 1.3)
              ));
        this.bins[band] += (value - this.bins[band]) * 0.4;
      }
    } else {
      for (let band = 0; band < this.NB; band++) this.bins[band] *= 0.88;
    }
    this._manualAmp *= 0.9;
    const ampEase = raw > this.cur.amp ? 0.3 : 0.07;
    this.cur.amp += (raw - this.cur.amp) * ampEase;
    const amp = this.cur.amp;
    window.__artemisAmp = amp;
    // Breathing envelope: chases amp slowly in both directions so the core
    // swells and relaxes with the rhythm of speech instead of twitching.
    this._breathEnv +=
      (amp - this._breathEnv) * (this.reduced ? 1 : 1 - Math.exp(-dt * 3.2));


    if (
      !this.reduced &&
      (this.status === "idle" || this.status === "listening") &&
      time >= this._nextHaloAt
    ) {
      this._emitRipple(time, this.status === "listening" ? 0.86 : 0.68);
      this._nextHaloAt =
        time +
        (this.status === "listening"
          ? 2.25
          : 5 + Math.sin(time * 0.73) * 0.85);
    }
    const speakingPeak =
      !this.reduced &&
      this.status === "speaking" &&
      amp > 0.16 &&
      amp - this._prevAmp > 0.035 &&
      time - this._lastRipple > 0.16;
    if (speakingPeak) {
      this._emitRipple(time, amp);
      this._lastRipple = time;
    }
    this._prevAmp = amp;

    if (this._rippleCount) {
      let write = 0;
      for (let read = 0; read < this._rippleCount; read++) {
        const ripple = this._ripples[read];
        if (time - ripple.t0 >= HALO_LIFE) continue;
        if (write !== read) {
          this._ripples[write].t0 = ripple.t0;
          this._ripples[write].e = ripple.e;
        }
        write++;
      }
      this._rippleCount = write;
    }

    this._mx += (this._mouse.x - this._mx) * 0.06;
    this._my += (this._mouse.y - this._my) * 0.06;
    this._draw(time);
  }

  // Project every fixed pool once. Rendering is split by depth so additive
  // light remains spatial while moon labels stay legible in source-over.
  _draw(time) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const width = this.W;
    const height = this.H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = SCENE_WASH;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = GRID_STYLE;
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 38) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 38) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const centerX = this.center || this.narrow ? width * 0.5 : width * 0.64;
    const centerYBase = this.narrow ? height * 0.46 : height * 0.5;
    const scroll = this.reduced ? 0 : this._scrollProg || 0;
    const centerY = centerYBase - scroll * height * 0.32;
    this._hitCenterX = centerX;
    this._hitCenterY = centerY;
    const recede = 1 - scroll * 0.28;
    const hudAlpha = 1 - scroll * 0.45;
    const base = Math.min(width, height) * 0.62 * recede; // globe ≈ 65-70% of cell
    const radius = base * 0.52;
    const sphereScale = 1 - this._listeningMix * 0.08;
    const silhouetteRadius = radius * sphereScale;
    const amp = this.cur.amp;

    const yaw = this._globeYaw + this._mx * 0.7;
    const pitch = 0.42 + this._my * 0.42;
    const yawCos = Math.cos(yaw);
    const yawSin = Math.sin(yaw);
    const pitchCos = Math.cos(pitch);
    const pitchSin = Math.sin(pitch);

    for (let i = 0; i < MOON_COUNT; i++) {
      const orbitAngle =
        this._moonPhase[i] + (time / this._moonPeriod[i]) * TAU;
      const orbitRadius = this._moonOrbitRadius[i];
      const orbitU = Math.cos(orbitAngle) * orbitRadius;
      const orbitV = Math.sin(orbitAngle) * orbitRadius;
      const activity = this._moonActivityMix[i];
      const easedActivity = activity * activity * (3 - 2 * activity);
      const inwardScale =
        1 + (1.05 / orbitRadius - 1) * easedActivity;
      const offset = i * 3;
      const bob =
        Math.sin(time * this._moonBobRate[i] + this._moonBobPhase[i]) *
        this._moonBobAmount[i] *
        (1 - easedActivity * 0.55);
      const pointX =
        (this._moonBasisU[offset] * orbitU +
          this._moonBasisV[offset] * orbitV) *
        inwardScale;
      const pointY =
        (this._moonBasisU[offset + 1] * orbitU +
          this._moonBasisV[offset + 1] * orbitV) *
          inwardScale +
        bob;
      const pointZ =
        (this._moonBasisU[offset + 2] * orbitU +
          this._moonBasisV[offset + 2] * orbitV) *
        inwardScale;
      const cameraX = pointX * yawCos + pointZ * yawSin;
      const cameraZ = -pointX * yawSin + pointZ * yawCos;
      const cameraY = pointY * pitchCos - cameraZ * pitchSin;
      const depth = pointY * pitchSin + cameraZ * pitchCos;
      const perspective = CAM_DISTANCE / (CAM_DISTANCE - depth);
      this._moonScreenX[i] = cameraX * radius * perspective;
      this._moonScreenY[i] = cameraY * radius * perspective;
      this._moonDepth[i] = depth;
      this._moonScale[i] = perspective;
      const settleAge =
        this._moonSettleAt[i] >= 0
          ? time - this._moonSettleAt[i]
          : -1;
      const settle =
        settleAge >= 0 && settleAge < MOON_SETTLE_TIME
          ? 1 - settleAge / MOON_SETTLE_TIME
          : 0;
      const visualAlpha = Math.min(
        1,
        0.4 + activity * 0.6 + settle * 0.45
      );
      this._moonSettleMix[i] = settle;
      this._moonAlphaBucket[i] = Math.max(
        1,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(
            visualAlpha * (STYLE_ALPHA_BUCKETS - 1)
          )
        )
      );
      this._moonVisualRadius[i] =
        this._moonCoreRadius[i] *
        (0.86 + perspective * 0.14) *
        (1 + activity * 0.24 + settle * 0.34);

      const orbitBase = i * MOON_ORBIT_STEPS;
      for (let point = 0; point < MOON_ORBIT_STEPS; point++) {
        const orbitOffset = orbitBase + point;
        const orbitX = this._moonOrbitWorldX[orbitOffset];
        const orbitY = this._moonOrbitWorldY[orbitOffset];
        const orbitZ = this._moonOrbitWorldZ[orbitOffset];
        const orbitCameraX = orbitX * yawCos + orbitZ * yawSin;
        const orbitCameraZ = -orbitX * yawSin + orbitZ * yawCos;
        const orbitCameraY =
          orbitY * pitchCos - orbitCameraZ * pitchSin;
        const orbitDepth =
          orbitY * pitchSin + orbitCameraZ * pitchCos;
        const orbitPerspective =
          CAM_DISTANCE / (CAM_DISTANCE - orbitDepth);
        this._moonOrbitScreenX[orbitOffset] =
          orbitCameraX * radius * orbitPerspective;
        this._moonOrbitScreenY[orbitOffset] =
          orbitCameraY * radius * orbitPerspective;
        this._moonOrbitDepth[orbitOffset] = orbitDepth;
      }
    }


    ctx.save();
    ctx.translate(centerX, centerY);
    this._sceneAlpha = hudAlpha;
    ctx.globalAlpha = hudAlpha;
    ctx.globalCompositeOperation = "lighter";

    this._drawGimbal(false, time, silhouetteRadius);
    this._drawOrbitPass(false);
    this._drawMoonLightPass(false, time, silhouetteRadius);

    this._drawCore(time, silhouetteRadius);
    this._drawInstrumentRings(time, silhouetteRadius);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = hudAlpha;
    this._drawMoonLabelPass(false);

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = hudAlpha;
    this._drawHalos(time, silhouetteRadius);
    this._drawGimbal(true, time, silhouetteRadius);
    this._drawOrbitPass(true);
    this._drawMoonLightPass(true, time, silhouetteRadius);

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = hudAlpha;
    this._drawMoonLabelPass(true);
    ctx.restore();

    // Preserve the centered ARTEMIS wordmark while scaling it with scroll
    // recession without rebuilding its font string in the frame loop.
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(recede, recede);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = hudAlpha;
    // Per-letter animation: a wave of lift and shimmer runs through the word,
    // her voice amplifies the bob, and thinking scatters the letters outward
    // so the wordmark dissolves with the globe. All precomputed offsets — no
    // measureText, no allocation.
    const wt = this.reduced ? 0 : time;
    const size = this._wordmarkSize;
    const bob = size * (0.1 + this.cur.amp * 0.34);
    const scatter = this._thinkingMix;
    ctx.font = this._wordmarkFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(34,211,238,0.6)";
    ctx.shadowBlur = 24;
    const mid = (WORDMARK_LETTERS.length - 1) / 2;
    for (let i = 0; i < WORDMARK_LETTERS.length; i++) {
      const phase = wt * 1.9 - i * 0.62;
      const a = 0.66 + 0.34 * Math.sin(wt * 2.6 + i * 0.9);
      const bucket = Math.max(
        0,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(a * (1 - scatter * 0.5) * (STYLE_ALPHA_BUCKETS - 1))
        )
      );
      ctx.fillStyle = HL_STYLES[bucket];
      const x =
        this._wordmarkX[i] +
        scatter * (i - mid) * size * 0.5 +
        (this.reduced ? 0 : Math.sin(wt * 0.7 + i * 1.7) * size * 0.04);
      const y =
        Math.sin(phase) * bob -
        scatter * Math.sin(i * 2.4) * size * 0.55;
      ctx.fillText(WORDMARK_LETTERS[i], x, y);
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }


  _drawCore(time, R) {
    const ctx = this.ctx;
    const [r, g, b] = this._coreRGB;
    const env = this._breathEnv;
    // The core carries the life: a deep idle breath (~4s) plus the smoothed
    // voice envelope swelling it up to +25%. Frozen under reduced motion.
    const breath = this.reduced ? 0 : 0.06 * Math.sin(time * (TAU / 4));
    const coreR = R * 0.35 * (1 + breath + env * 0.25);

    const listeningRemainder = 1 - this._listeningMix;
    const thinkingRemainder = 1 - this._thinkingMix;
    const speakingRemainder = 1 - this._speakingMix;
    this._coreSpriteWeights[0] =
      listeningRemainder * thinkingRemainder * speakingRemainder;
    this._coreSpriteWeights[1] =
      this._listeningMix * thinkingRemainder * speakingRemainder;
    this._coreSpriteWeights[2] = this._thinkingMix * speakingRemainder;
    this._coreSpriteWeights[3] = this._speakingMix;

    // Outer halo (wide soft bloom), crossfaded through cached state sprites.
    // Capped so the peak stays a glow, never a white-out.
    const haloSize = coreR * 4.2;
    const haloAlpha = Math.min(0.62, 0.42 + env * 0.28);
    for (let state = 0; state < REACTOR_STATE_KEYS.length; state++) {
      const weight = this._coreSpriteWeights[state];
      if (weight <= 0.002) continue;
      ctx.globalAlpha = this._sceneAlpha * haloAlpha * weight;
      ctx.drawImage(
        this._coreHaloSprites[state],
        -haloSize * 0.5,
        -haloSize * 0.5,
        haloSize,
        haloSize
      );
    }

    // Inner disc: white-hot center falling to the eased state color. Alpha
    // breathes with the idle cycle and is capped so structure stays visible.
    const discSize = coreR * 2;
    const discBreath = this.reduced ? 0 : 0.06 * Math.sin(time * (TAU / 4));
    const discAlpha = Math.min(0.88, 0.74 + discBreath + env * 0.1);
    for (let state = 0; state < REACTOR_STATE_KEYS.length; state++) {
      const weight = this._coreSpriteWeights[state];
      if (weight <= 0.002) continue;
      ctx.globalAlpha = this._sceneAlpha * discAlpha * weight;
      ctx.drawImage(
        this._coreDiscSprites[state],
        -discSize * 0.5,
        -discSize * 0.5,
        discSize,
        discSize
      );
    }

    // Crisp rim: a solid edge at the disc boundary keeps the core reading as
    // an object even at full speaking brightness — never a shapeless blob.
    ctx.globalAlpha = this._sceneAlpha;
    ctx.lineWidth = Math.max(2, R * 0.028);
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.75 + env * 0.25).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, TAU);
    ctx.stroke();

    // Coil ring: 10 bold winding segments just outside the disc. Fixed length
    // — no waveform spikes — but they brighten together as her voice swells.
    // Thinking flicker: subtle alpha wobble, frozen when reduced.
    const coilInner = coreR * 1.08;
    const coilOuter = coreR * 1.34;
    const spin = this.reduced ? 0 : time * 0.05;
    ctx.lineWidth = Math.max(2.5, R * 0.034);
    ctx.lineCap = "round";
    for (let i = 0; i < 10; i++) {
      const angle = spin + (i / 10) * TAU;
      const flicker = this.reduced
        ? 0
        : this._thinkingMix * 0.25 * Math.sin(time * 7 + i * 2.4);
      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.6 + env * 0.3 + flicker).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * coilInner, Math.sin(angle) * coilInner);
      ctx.lineTo(Math.cos(angle) * coilOuter, Math.sin(angle) * coilOuter);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }



  // Two counter-rotating segmented rings + the tick ring + the tool-call
  // sweep. Runs after _drawCore, which populates _coreSpriteWeights for the
  // tick-sprite state crossfade.
  _drawInstrumentRings(time, R) {
    const ctx = this.ctx;
    const [r, g, b] = this._ringRGB;
    // Organic drive: rotation surges and relaxes on slow offset sine cycles
    // (never a constant-speed spinner), voice swell adds urgency on top.
    const speed = 1 + this._activeMix * 2 + this._breathEnv * 0.8;
    if (!this.reduced) {
      const t = time;
      this._ringAngleInner +=
        this._dt * 0.3 * speed * (0.55 + 0.45 * Math.sin(t * 0.31));
      this._ringAngleOuter -=
        this._dt * 0.2 * speed * (0.55 + 0.45 * Math.sin(t * 0.23 + 2.1));
      this._tickAngle +=
        this._dt * 0.05 * speed * (0.6 + 0.4 * Math.sin(t * 0.17 + 4.2));
    }
    const tickBoost = this._listeningMix * 0.3;

    // Inner ring: 5 segments x 50 deg. Outer ring: 8 segments x 33 deg.
    // Bold rounded strokes — solid holographic hardware, not wireframe.
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.6 + tickBoost).toFixed(3)})`;
    ctx.lineWidth = Math.max(2.5, R * 0.03);
    for (let i = 0; i < 5; i++) {
      const start = this._ringAngleInner + (i / 5) * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.5, start, start + 50 * DEG);
      ctx.stroke();
    }
    ctx.lineWidth = Math.max(2, R * 0.02);
    for (let i = 0; i < 8; i++) {
      const start = this._ringAngleOuter + (i / 8) * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.68, start, start + 33 * DEG);
      ctx.stroke();
    }
    ctx.lineCap = "butt";

    // Tick ring: cached per-state sprites, crossfaded like the core.
    const tickSize = R * 2.2;
    ctx.save();
    ctx.rotate(this._tickAngle);
    for (let state = 0; state < REACTOR_STATE_KEYS.length; state++) {
      const weight = this._coreSpriteWeights[state];
      if (weight <= 0.002) continue;
      ctx.globalAlpha = this._sceneAlpha * (0.4 + tickBoost) * weight;
      ctx.drawImage(
        this._tickSprites[state],
        -tickSize * 0.5,
        -tickSize * 0.5,
        tickSize,
        tickSize
      );
    }
    ctx.restore();
    ctx.globalAlpha = this._sceneAlpha;

    // Tool-call sweep travels the inner ring once; thinking keeps a slow
    // perpetual circulation going between calls.
    const sweepAge = time - this._sweep.t0;
    const toolSweep =
      this._sweep.active && sweepAge < SWEEP_LIFE
        ? 1 - sweepAge / SWEEP_LIFE
        : 0;
    const thinkSweep = this._thinkingMix;
    if (toolSweep > 0 || thinkSweep > 0.02) {
      const progress =
        toolSweep > 0
          ? sweepAge / SWEEP_LIFE
          : this.reduced
            ? 0.3
            : (time * 0.35) % 1;
      const alpha = Math.max(toolSweep, thinkSweep * 0.5);
      ctx.lineWidth = Math.max(3, R * 0.035);
      ctx.strokeStyle = `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`;
      const start = this._ringAngleInner + progress * TAU;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.5, start, start + 24 * DEG);
      ctx.stroke();
    }
    if (this._sweep.active && sweepAge >= SWEEP_LIFE) this._sweep.active = 0;
  }

  // Hologram gimbal rings on tilted precessing axes, split into back/front
  // halves around the core. Angles advance once per frame in the back pass.
  _drawGimbal(front, time, R) {
    const ctx = this.ctx;
    const [r, g, b] = this._ringRGB;
    ctx.lineWidth = Math.max(2, R * 0.016);
    for (const gimbal of this._gimbals) {
      if (!front && !this.reduced) {
        gimbal.prec += this._dt * gimbal.precSpeed;
        gimbal.spin += this._dt * gimbal.spinSpeed;
      }
      const tiltCos = Math.cos(gimbal.tilt);
      const tiltSin = Math.sin(gimbal.tilt);
      const precCos = Math.cos(gimbal.prec);
      const precSin = Math.sin(gimbal.prec);
      const radius = gimbal.radius * R;
      // Hologram shimmer: low-alpha flicker along the stroke, frozen when reduced.
      const shimmer = this.reduced
        ? 0
        : 0.08 * Math.sin(time * 9 + gimbal.tilt * 40);
      const alpha = (front ? 0.7 : 0.2) + shimmer;
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      let penDown = false;
      ctx.beginPath();
      for (let s = 0; s <= 64; s++) {
        const u = gimbal.spin + (s / 64) * TAU;
        const localX = Math.cos(u) * radius;
        const localY = Math.sin(u) * radius;
        const tiltedY = localY * tiltCos;
        const tiltedZ = localY * tiltSin;
        const worldX = localX * precCos + tiltedZ * precSin;
        const worldZ = -localX * precSin + tiltedZ * precCos;
        const visible = front ? worldZ >= 0 : worldZ < 0;
        const scale = 1 + worldZ / (radius * 8); // mild perspective
        if (visible) {
          const screenX = worldX * scale;
          const screenY = tiltedY * scale;
          if (penDown) ctx.lineTo(screenX, screenY);
          else {
            ctx.moveTo(screenX, screenY);
            penDown = true;
          }
        } else {
          penDown = false;
        }
      }
      ctx.stroke();
    }
  }

  _drawOrbitPass(front) {
    const ctx = this.ctx;
    // Hairline orbit paths — barely-there guides under the HUD markers.
    ctx.globalAlpha = this._sceneAlpha * 0.4;
    ctx.lineWidth = 0.5;
    for (let moon = 0; moon < MOON_COUNT; moon++) {
      const base = moon * MOON_ORBIT_STEPS;
      ctx.strokeStyle = MOON_STYLES[moon][1];
      ctx.beginPath();
      for (let point = 0; point < MOON_ORBIT_STEPS; point++) {
        const next = (point + 1) % MOON_ORBIT_STEPS;
        const from = base + point;
        const to = base + next;
        const segmentFront =
          (this._moonOrbitDepth[from] +
            this._moonOrbitDepth[to]) *
            0.5 >=
          0;
        if (segmentFront !== front) continue;
        ctx.moveTo(
          this._moonOrbitScreenX[from],
          this._moonOrbitScreenY[from]
        );
        ctx.lineTo(
          this._moonOrbitScreenX[to],
          this._moonOrbitScreenY[to]
        );
      }
      ctx.stroke();
    }
    ctx.globalAlpha = this._sceneAlpha;
  }



  _drawMoonLightPass(front, time, silhouetteRadius) {
    for (let i = 0; i < MOON_COUNT; i++) {
      if ((this._moonDepth[i] >= 0) !== front) continue;
      this._drawMoonLight(i, time);
    }
  }


  // HUD marker: a diamond inside corner brackets. Gold while the moon's task
  // runs (with a slow blink), state cyan otherwise; settle flash keeps the
  // ok/err glow for completion feedback.
  _drawMoonLight(index, time) {
    const ctx = this.ctx;
    const x = this._moonScreenX[index];
    const y = this._moonScreenY[index];
    const activity = this._moonActivityMix[index];
    const settle = this._moonSettleMix[index];
    const alpha = this._moonAlphaBucket[index] / (STYLE_ALPHA_BUCKETS - 1);
    const s = this._moonVisualRadius[index];
    const active = this._moonRuns[index] > 0;

    const glowSize = s * 8;
    const glowSprite =
      settle > 0
        ? this._settleGlowSprites[this._moonSettleOk[index]]
        : this._moonGlowSprites[index];
    ctx.globalAlpha =
      this._sceneAlpha * (0.3 + activity * 0.3 + settle * 0.24);
    ctx.drawImage(
      glowSprite,
      x - glowSize * 0.5,
      y - glowSize * 0.5,
      glowSize,
      glowSize
    );
    ctx.globalAlpha = this._sceneAlpha;

    const gold = STATE_COLORS.thinking.ring;
    const rgb = active ? gold : this._coreRGB;
    const blink =
      active && !this.reduced ? 0.7 + 0.3 * Math.sin(time * 3 + index) : 1;
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(alpha * blink).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y);
    ctx.closePath();
    ctx.fill();

    const bracket = s * 1.9;
    const arm = s * 0.7;
    ctx.lineWidth = active ? 1.6 : 1;
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(alpha * (active ? 0.9 : 0.5)).toFixed(3)})`;
    for (let side = -1; side <= 1; side += 2) {
      const tip = x + side * bracket;
      const back = tip - side * arm * 0.6;
      ctx.beginPath();
      ctx.moveTo(back, y - arm);
      ctx.lineTo(tip, y);
      ctx.lineTo(back, y + arm);
      ctx.stroke();
    }
  }

  _drawMoonLabelPass(front) {
    for (let i = 0; i < MOON_COUNT; i++) {
      if ((this._moonDepth[i] >= 0) !== front) continue;
      this._drawMoonLabel(i);
    }
  }

  _drawMoonLabel(index) {
    const ctx = this.ctx;
    const x = this._moonScreenX[index];
    const y = this._moonScreenY[index];
    const activity = this._moonActivityMix[index];
    const pool = MOON_STYLES[index];
    const settle = this._moonSettleMix[index];
    const flashPool = this._moonSettleOk[index] ? OK_STYLES : ERR_STYLES;
    const drawPool = settle > 0 ? flashPool : pool;
    const radius = this._moonVisualRadius[index];
    // Dimmer than the marker — labels are secondary HUD chrome.
    const labelAlpha =
      Math.min(1, 0.5 + activity * 0.5 + settle * 0.3) * 0.75;
    const labelBucket = Math.max(
      1,
      Math.min(
        STYLE_ALPHA_BUCKETS - 1,
        Math.round(labelAlpha * (STYLE_ALPHA_BUCKETS - 1))
      )
    );
    const labelY = y + radius + 12;
    ctx.strokeStyle = drawPool[Math.max(2, labelBucket - 3)];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + radius + 2);
    ctx.lineTo(x, labelY - 3);
    ctx.stroke();
    ctx.fillStyle = drawPool[labelBucket];
    ctx.font = MOON_LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowColor = drawPool[Math.max(7, labelBucket)];
    ctx.shadowBlur = 2 + activity * 2 + settle * 2;
    ctx.fillText(MOON_LABELS[index], x, labelY);
    ctx.shadowBlur = 0;
  }


  _drawHalos(time, silhouetteRadius) {
    const ctx = this.ctx;
    for (let i = 0; i < this._rippleCount; i++) {
      const ripple = this._ripples[i];
      const age = time - ripple.t0;
      const progress = Math.max(0, Math.min(1, age / HALO_LIFE));
      const life = 1 - progress;
      if (life <= 0) continue;
      const expansion = 1 - (1 - progress) * (1 - progress);
      const radius = silhouetteRadius * (1 + expansion * 0.42);
      const alphaBucket = Math.max(
        1,
        Math.min(
          7,
          Math.round(life * ripple.e * (STYLE_ALPHA_BUCKETS - 1) * 0.46)
        )
      );
      const rotation = time * 0.08;
      ctx.lineWidth = 0.6 + life * 1.2;
      ctx.shadowBlur = life * 5;
      ctx.shadowColor = O_STYLES[alphaBucket];
      ctx.strokeStyle = O_STYLES[alphaBucket];
      ctx.beginPath();
      ctx.arc(0, 0, radius, rotation, rotation + Math.PI);
      ctx.stroke();
      ctx.shadowColor = V_STYLES[alphaBucket];
      ctx.strokeStyle = V_STYLES[alphaBucket];
      ctx.beginPath();
      ctx.arc(0, 0, radius, rotation + Math.PI, rotation + TAU);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("pointermove", this._onMouse);
    window.removeEventListener("scroll", this._onScroll);
    document.removeEventListener("visibilitychange", this._onVis);
    for (let i = 0; i < MOON_COUNT; i++) {
      if (this._moonSettleTimers[i]) {
        clearTimeout(this._moonSettleTimers[i]);
        this._moonSettleTimers[i] = 0;
      }
    }
    this.stopAudio();
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (error) {}
    }
    if (this.cv.parentNode) this.cv.parentNode.removeChild(this.cv);
  }
}
