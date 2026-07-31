// The Artemis System — a voice-reactive particle-wireframe globe with six
// honest agent moons. Canvas 2D only; all scene geometry and draw-style pools
// are fixed before the animation loop starts.

import { PAL, prefersReducedMotion } from "./orbShared.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const LEGACY_DOT_COUNT = 7 * 100 + 11 * 64;
const DOT_COUNT = Math.floor(LEGACY_DOT_COUNT * 1.6);
const EARTH_MASK_WIDTH = 96;
const EARTH_MASK_HEIGHT = 48;
const EARTH_FRONT_LONGITUDE = 10 * DEG;
const CAGE_LATITUDE_COUNT = 8;
const CAGE_LONGITUDE_COUNT = 12;
const CAGE_LINE_COUNT = CAGE_LATITUDE_COUNT + CAGE_LONGITUDE_COUNT;
const CAGE_SEGMENTS_PER_LINE = 48;
const CAGE_POINTS_PER_LINE = CAGE_SEGMENTS_PER_LINE + 1;
const CAGE_POINT_COUNT = CAGE_LINE_COUNT * CAGE_POINTS_PER_LINE;
const CAGE_SEGMENT_COUNT = CAGE_LINE_COUNT * CAGE_SEGMENTS_PER_LINE;
const DOT_TONE_BUCKETS = 5;
const DOT_ALPHA_BUCKETS = 10;
const DOT_STYLE_GROUPS = DOT_TONE_BUCKETS * DOT_ALPHA_BUCKETS;
const STYLE_ALPHA_BUCKETS = 16;
const WORDMARK_LETTERS = ["A","R","T","E","M","I","S"];
const RIPPLE_POOL_SIZE = 16;
const HALO_LIFE = 1.25;
const BASE_SPIN_RATE = TAU / 60; // ops redesign: stately ~60s/rev
const REFORM_DURATION = 0.72;
const CAM_DISTANCE = 3.2;
const DATA_ARC_POOL_SIZE = 10;
const DATA_ARC_PAIR_COUNT = 40;
const DATA_ARC_LIFE = 1.2;
const DATA_ARC_TAIL_STEPS = 8;
const DATA_ARC_TAIL_SPAN = 0.32;
const WIRE_PULSE_COUNT = 5;
const SCAN_INTERVAL = 10;
const SCAN_DURATION = 2.5;
const SCAN_RING_STEPS = 64;
const MOON_COUNT = 11;
const MOON_SETTLE_TIME = 0.6;
const MOON_ORBIT_STEPS = 48;
const MOON_TAIL_SAMPLES = 5;
const MOON_TAIL_INTERVAL = 0.1;
const DOT_GLOW_SIZE = 32;
const ARC_GLOW_SIZE = 48;
const ATMOSPHERE_SPRITE_SIZE = 256;
const MOON_LABEL_FONT = '600 9px "JetBrains Mono", monospace';
const FILAMENT_DASH = Object.freeze([5, 8]);
const SOLID_LINE = Object.freeze([]);

// Authored 96×48 equirectangular land mask, north-to-south and west-to-east.
// Each row is 96 packed bits (24 hex digits): Greenland, the Americas,
// Europe/Africa, Eurasia, island chains, Australia, and Antarctica are all
// represented explicitly. It is decoded once per orb; the frame loop never
// performs a mask lookup.
const EARTH_MASK_HEX = Object.freeze([
  // Rasterized from Natural Earth 110m land polygons (equirectangular,
  // row 0 = 90N, col 0 = 180W, 2x2 supersampled) — real coastlines, not
  // hand-authored approximations.
  "000000000000000000000000",
  "000000000780000000000000",
  "000003fffff81e0000600000",
  "00007fe7ffe00e00c07e0c00",
  "0003f7f07fe000033fffe700",
  "9ffffbfc7f800ff3ffffffff",
  "ffffffdf3e301fffffffffff",
  "0fffff1c38007fffffffffff",
  "061fff1f00037ffffffffcf0",
  "080fffdf80077ffffffffc60",
  "0003ffff8003fffffffffe40",
  "0001ffffc001fffffffff800",
  "0001fffe0007ff3ffffff600",
  "0001fff800072fffffffe400",
  "0001fff00003e1fffffffc00",
  "0000ffe00007ffffffffa000",
  "00007e20000fffffffff8000",
  "00003c00001fffffffff8000",
  "00000e98001fffff3ffc0000",
  "00000780001ffffe1c788000",
  "000001c0001ffff80c38c000",
  "0000007f000ffffc08294000",
  "0000001fc007fff804734000",
  "0000001fe0003ff80037e000",
  "0000003ff8003fe000379c80",
  "0000003ffe001fe000188f80",
  "0000001ffe001fe00002c500",
  "0000001ffc001fe400007a00",
  "0000000ffc001ffc0000fe00",
  "00000007fc001fd80003ff08",
  "00000007f0000fd80003ff80",
  "00000007e0000f800003ff80",
  "00000007e0000f000001ff80",
  "0000000fc000040000010f00",
  "0000000f8000000000000203",
  "0000000e0000000000000106",
  "0000000e000000000000000c",
  "0000000c8000000000000000",
  "0000000c0000000000000000",
  "000000000000000000000000",
  "000000000000000000000000",
  "00000003000000070016b800",
  "0000000700003dffffffffe0",
  "00004fff000ffffffffffffc",
  "03fffffc01fffffffffffff0",
  "03fffffe3fffffffffffffe0",
  "ffffffffffffffffffffffff",
  "ffffffffffffffffffffffff",
]);

// lon, lat, longitudinal spread, latitudinal spread. Every plexus node is
// mask-validated inside one of these four real population regions.
const POPULATION_REGIONS = new Float32Array([
  5, 50, 18, 9,       // Western Europe
  118, 33, 20, 13,    // East Asia
  -77, 40, 14, 12,    // eastern North America
  -3, 9, 15, 11       // West Africa
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

function makeDotTonePrefixes() {
  return Object.freeze([
    PAL.Hl,                    // coastline / brightest city lights
    PAL.B,                     // inhabited land
    PAL.O,                     // quieter inland structure
    "rgba(132,153,249,",      // ocean transition
    PAL.V                      // sparse deep-ocean lattice
  ]);
}

function makeDotStyles(prefixes) {
  const styles = new Array(DOT_TONE_BUCKETS * DOT_ALPHA_BUCKETS);
  for (let tone = 0; tone < DOT_TONE_BUCKETS; tone++) {
    for (let alpha = 0; alpha < DOT_ALPHA_BUCKETS; alpha++) {
      styles[tone * DOT_ALPHA_BUCKETS + alpha] =
        prefixes[tone] +
        (alpha / (DOT_ALPHA_BUCKETS - 1)).toFixed(3) +
        ")";
    }
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

function makeLimbSprite(prefix, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const center = size * 0.5;
  const limb = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    center
  );
  limb.addColorStop(0, prefix + "0)");
  limb.addColorStop(0.68, prefix + "0)");
  limb.addColorStop(0.79, prefix + "0.05)");
  limb.addColorStop(0.84, prefix + "0.42)");
  limb.addColorStop(0.9, prefix + "0.16)");
  limb.addColorStop(1, prefix + "0)");
  ctx.fillStyle = limb;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function makeNebulaSprite(prefix, size, variant) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const centerX = size * (variant ? 0.56 : 0.44);
  const centerY = size * (variant ? 0.44 : 0.56);
  const nebula = ctx.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    size * 0.5
  );
  nebula.addColorStop(0, prefix + (variant ? "0.2)" : "0.17)"));
  nebula.addColorStop(0.3, prefix + (variant ? "0.12)" : "0.1)"));
  nebula.addColorStop(0.7, prefix + "0.035)");
  nebula.addColorStop(1, prefix + "0)");
  ctx.fillStyle = nebula;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function makeProjectorFloorSprite(prefix) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const glow = ctx.createRadialGradient(128, 32, 0, 128, 32, 128);
  glow.addColorStop(0, prefix + "0.14)");
  glow.addColorStop(0.36, prefix + "0.075)");
  glow.addColorStop(1, prefix + "0)");
  ctx.save();
  ctx.translate(128, 32);
  ctx.scale(1, 0.24);
  ctx.translate(-128, -32);
  ctx.fillStyle = glow;
  ctx.fillRect(0, -96, 256, 256);
  ctx.restore();
  return canvas;
}

function makeProjectorBeamSprite(prefix) {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  const beam = ctx.createLinearGradient(0, 192, 0, 0);
  beam.addColorStop(0, prefix + "0.18)");
  beam.addColorStop(1, prefix + "0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(0, 192);
  ctx.lineTo(192, 192);
  ctx.lineTo(144, 0);
  ctx.lineTo(48, 0);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

function decodeEarthMask() {
  const mask = new Uint8Array(EARTH_MASK_WIDTH * EARTH_MASK_HEIGHT);
  for (let row = 0; row < EARTH_MASK_HEIGHT; row++) {
    const encoded = EARTH_MASK_HEX[row];
    for (let nibble = 0; nibble < encoded.length; nibble++) {
      const value = parseInt(encoded[nibble], 16);
      const column = nibble * 4;
      mask[row * EARTH_MASK_WIDTH + column] = (value >> 3) & 1;
      mask[row * EARTH_MASK_WIDTH + column + 1] = (value >> 2) & 1;
      mask[row * EARTH_MASK_WIDTH + column + 2] = (value >> 1) & 1;
      mask[row * EARTH_MASK_WIDTH + column + 3] = value & 1;
    }
  }
  return mask;
}

function earthMaskValue(mask, column, row) {
  if (row < 0 || row >= EARTH_MASK_HEIGHT) return 0;
  let wrappedColumn = column % EARTH_MASK_WIDTH;
  if (wrappedColumn < 0) wrappedColumn += EARTH_MASK_WIDTH;
  return mask[row * EARTH_MASK_WIDTH + wrappedColumn];
}

function earthMaskValueAtGeo(mask, longitude, latitude) {
  let normalizedLongitude = (longitude + 180) % 360;
  if (normalizedLongitude < 0) normalizedLongitude += 360;
  const column = Math.min(
    EARTH_MASK_WIDTH - 1,
    Math.floor((normalizedLongitude / 360) * EARTH_MASK_WIDTH)
  );
  const row = Math.max(
    0,
    Math.min(
      EARTH_MASK_HEIGHT - 1,
      Math.floor(((90 - latitude) / 180) * EARTH_MASK_HEIGHT)
    )
  );
  return mask[row * EARTH_MASK_WIDTH + column];
}

function isPopulationRegion(longitude, latitude) {
  return (
    (longitude >= -13 && longitude <= 28 && latitude >= 39 && latitude <= 61) ||
    (longitude >= 100 && longitude <= 145 && latitude >= 18 && latitude <= 48) ||
    (longitude >= -93 && longitude <= -63 && latitude >= 27 && latitude <= 53) ||
    (longitude >= -20 && longitude <= 14 && latitude >= -2 && latitude <= 22) ||
    (longitude >= 67 && longitude <= 92 && latitude >= 7 && latitude <= 31)
  );
}

const DOT_TONE_PREFIXES = makeDotTonePrefixes();
const DOT_STYLES = makeDotStyles(DOT_TONE_PREFIXES);
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

function hashUnit(value) {
  const n = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export class VoiceOrb {
  constructor(container, opts = {}) {
    this.container = container;
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
    this._globeYaw = 0.78; // boot facing ~15E — Africa/Europe toward camera
    this._cloudYaw = 0;
    this._reformStart = -1;
    this._reformStrength = 0;
    this._reformOvershoot = 0;
    this._lastFrameAt = 0;
    this._elapsed = 0;

    // ---- Digital Earth surface: authored mask + constructor-only reseed ----
    this._earthMask = decodeEarthMask();
    const earthCoast = new Uint8Array(
      EARTH_MASK_WIDTH * EARTH_MASK_HEIGHT
    );
    for (let row = 0; row < EARTH_MASK_HEIGHT; row++) {
      for (let column = 0; column < EARTH_MASK_WIDTH; column++) {
        if (!earthMaskValue(this._earthMask, column, row)) continue;
        earthCoast[row * EARTH_MASK_WIDTH + column] =
          !earthMaskValue(this._earthMask, column - 1, row) ||
          !earthMaskValue(this._earthMask, column + 1, row) ||
          !earthMaskValue(this._earthMask, column, row - 1) ||
          !earthMaskValue(this._earthMask, column, row + 1)
            ? 1
            : 0;
      }
    }

    this._dotBase = new Float32Array(DOT_COUNT * 3);
    this._dotLatitude = new Float32Array(DOT_COUNT);
    this._dotTwinkle = new Float32Array(DOT_COUNT);
    this._dotShimmer = new Float32Array(DOT_COUNT);
    this._dotIntensity = new Float32Array(DOT_COUNT);
    this._dotDelay = new Float32Array(DOT_COUNT);
    this._dotScatter = new Float32Array(DOT_COUNT * 3);
    this._dotScreenX = new Float32Array(DOT_COUNT);
    this._dotScreenY = new Float32Array(DOT_COUNT);
    this._dotCameraX = new Float32Array(DOT_COUNT);
    this._dotCameraY = new Float32Array(DOT_COUNT);
    this._dotDepth = new Float32Array(DOT_COUNT);
    this._dotRadius = new Float32Array(DOT_COUNT);
    this._dotBaseSize = new Float32Array(DOT_COUNT);
    this._dotSurface = new Uint8Array(DOT_COUNT);
    this._dotCity = new Uint8Array(DOT_COUNT);
    this._dotToneBase = new Uint8Array(DOT_COUNT);
    this._dotWireKind = new Uint8Array(DOT_COUNT);
    this._dotWireChain = new Uint8Array(DOT_COUNT);
    this._dotWireParam = new Float32Array(DOT_COUNT);
    this._dotToneBucket = new Uint8Array(DOT_COUNT);
    this._dotStyleCounts = new Uint16Array(DOT_STYLE_GROUPS);
    this._dotStyleIndices = new Uint16Array(
      DOT_STYLE_GROUPS * DOT_COUNT
    );
    this._lightBucketCounts = new Uint16Array(6);
    this._lightBucketIndices = new Uint16Array(6 * DOT_COUNT);

    let dot = 0;
    let landDots = 0;
    let oceanDots = 0;
    let coastDots = 0;
    const longitudeStep = 360 / EARTH_MASK_WIDTH;
    const latitudeStep = 180 / EARTH_MASK_HEIGHT;
    const addEarthDot = (
      longitudeDegrees,
      latitudeDegrees,
      surface,
      seed,
      extraLand
    ) => {
      if (dot >= DOT_COUNT) return;
      const longitude = longitudeDegrees * DEG - EARTH_FRONT_LONGITUDE;
      const latitude = latitudeDegrees * DEG;
      const latitudeRadius = Math.cos(latitude);
      const offset = dot * 3;
      const populated = surface &&
        isPopulationRegion(longitudeDegrees, latitudeDegrees);
      const cityChance = populated ? 0.62 : extraLand ? 0.31 : 0.13;
      const city = surface && hashUnit(seed + 821) < cityChance ? 1 : 0;
      const longitudeFraction = (longitudeDegrees + 180) / 360;
      const latitudeFraction = (latitudeDegrees + 90) / 180;
      const wireKind = hashUnit(seed + 1871) < 0.5 ? 0 : 1;

      this._dotBase[offset] = latitudeRadius * Math.sin(longitude);
      this._dotBase[offset + 1] = Math.sin(latitude);
      this._dotBase[offset + 2] = latitudeRadius * Math.cos(longitude);
      this._dotLatitude[dot] = latitude;
      this._dotSurface[dot] = surface;
      this._dotCity[dot] = city;
      this._dotTwinkle[dot] = hashUnit(seed + 4099) * TAU;
      this._dotShimmer[dot] = surface
        ? city ? 0.25 : surface === 2 ? 0.18 : 0.14
        : 0.055;
      this._dotIntensity[dot] = surface === 2
        ? 1.12 + city * 0.1
        : surface === 1 ? 0.85 + city * 0.25 : 0;
      this._dotToneBase[dot] = city
        ? 0
        : surface === 2
          ? 1
        : surface === 1
          ? hashUnit(seed + 541) < 0.7 ? 1 : 2
          : hashUnit(seed + 727) < 0.22 ? 3 : 4;
      this._dotBaseSize[dot] = surface
        ? (surface === 2 ? 1.3 : 0.94) +
          Math.pow(hashUnit(seed + 5101), 2.6) * 0.98 +
          city * 0.18
        : 0.72 + hashUnit(seed + 5101) * 0.48;
      this._dotWireKind[dot] = wireKind;
      if (wireKind === 0) {
        this._dotWireChain[dot] = Math.max(
          0,
          Math.min(
            CAGE_LATITUDE_COUNT - 1,
            Math.floor(latitudeFraction * CAGE_LATITUDE_COUNT)
          )
        );
        this._dotWireParam[dot] = longitudeFraction;
      } else {
        this._dotWireChain[dot] = Math.max(
          0,
          Math.min(
            CAGE_LONGITUDE_COUNT - 1,
            Math.floor(longitudeFraction * CAGE_LONGITUDE_COUNT)
          )
        );
        this._dotWireParam[dot] = latitudeFraction;
      }

      if (surface) {
        landDots++;
        if (surface === 2) coastDots++;
      } else {
        oceanDots++;
      }
      dot++;
    };

    for (let row = 0; row < EARTH_MASK_HEIGHT; row++) {
      const latitude = 90 - (row + 0.5) * latitudeStep;
      for (let column = 0; column < EARTH_MASK_WIDTH; column++) {
        const cell = row * EARTH_MASK_WIDTH + column;
        const longitude = -180 + (column + 0.5) * longitudeStep;
        const land = this._earthMask[cell] !== 0;
        const coast = earthCoast[cell] !== 0;
        if (land) {
          const polar = latitude < -66;
          if (!polar || hashUnit(cell + 12011) < 0.36) {
            const jitter = coast ? 0.08 : 0.32;
            addEarthDot(
              longitude +
                (hashUnit(cell + 13001) - 0.5) * longitudeStep * jitter,
              latitude +
                (hashUnit(cell + 14009) - 0.5) * latitudeStep * jitter,
              coast ? 2 : 1,
              cell + 15013,
              false
            );
          }
          if (!polar && (coast || hashUnit(cell + 16001) < 0.32)) {
            const extraJitter = coast ? 0.28 : 0.78;
            addEarthDot(
              longitude +
                (hashUnit(cell + 17011) - 0.5) * longitudeStep * extraJitter,
              latitude +
                (hashUnit(cell + 18013) - 0.5) * latitudeStep * extraJitter,
              coast ? 2 : 1,
              cell + 19001,
              true
            );
          }
        } else if (hashUnit(cell + 20011) < 0.08) {
          addEarthDot(
            longitude +
              (hashUnit(cell + 21001) - 0.5) * longitudeStep * 0.84,
            latitude +
              (hashUnit(cell + 22003) - 0.5) * latitudeStep * 0.84,
            0,
            cell + 23003,
            false
          );
        }
      }
    }
    this._dotCount = dot;
    this._earthLandDotCount = landDots;
    this._earthOceanDotCount = oceanDots;
    this._earthCoastDotCount = coastDots;

    // Scatter direction, distance, easing delay, and twinkle phase are stable
    // per dot, so dissolve/reform never creates geometry in the frame loop.
    for (let i = 0; i < this._dotCount; i++) {
      const u = hashUnit(i + 1);
      const v = hashUnit(i + 1019);
      const w = hashUnit(i + 2039);
      const d = hashUnit(i + 3079);
      const scatterY = u * 2 - 1;
      const scatterRadius = Math.sqrt(Math.max(0, 1 - scatterY * scatterY));
      const scatterAngle = v * TAU;
      const scatterMagnitude = 0.08 + w * 0.42;
      const offset = i * 3;
      this._dotScatter[offset] =
        Math.cos(scatterAngle) * scatterRadius * scatterMagnitude;
      this._dotScatter[offset + 1] = scatterY * scatterMagnitude;
      this._dotScatter[offset + 2] =
        Math.sin(scatterAngle) * scatterRadius * scatterMagnitude;
      this._dotDelay[i] = d * 0.55;
    }

    const landDotIndices = new Uint16Array(DOT_COUNT);
    let landDotCount = 0;
    for (let i = 0; i < this._dotCount; i++) {
      if (this._dotSurface[i] && this._dotLatitude[i] > -60 * DEG) {
        landDotIndices[landDotCount++] = i;
      }
    }

    // The cage is independent from the masked surface so continent dots never
    // inherit topology assumptions. All vertices and segment buckets are fixed.
    this._cageBase = new Float32Array(CAGE_POINT_COUNT * 3);
    this._cageScreenX = new Float32Array(CAGE_POINT_COUNT);
    this._cageScreenY = new Float32Array(CAGE_POINT_COUNT);
    this._cageDepth = new Float32Array(CAGE_POINT_COUNT);
    this._cageSegmentFrom = new Uint16Array(CAGE_SEGMENT_COUNT);
    this._cageSegmentTo = new Uint16Array(CAGE_SEGMENT_COUNT);
    this._cageStyleCounts = new Uint16Array(STYLE_ALPHA_BUCKETS * 2);
    this._cageStyleIndices = new Uint16Array(
      STYLE_ALPHA_BUCKETS * 2 * CAGE_SEGMENT_COUNT
    );
    let cagePoint = 0;
    for (let ring = 0; ring < CAGE_LATITUDE_COUNT; ring++) {
      const latitude =
        -Math.PI * 0.5 +
        ((ring + 1) / (CAGE_LATITUDE_COUNT + 1)) * Math.PI;
      const latitudeRadius = Math.cos(latitude);
      const y = Math.sin(latitude);
      for (let point = 0; point < CAGE_POINTS_PER_LINE; point++) {
        const geographicLongitude =
          -Math.PI + (point / CAGE_SEGMENTS_PER_LINE) * TAU;
        const longitude = geographicLongitude - EARTH_FRONT_LONGITUDE;
        const offset = cagePoint * 3;
        this._cageBase[offset] = latitudeRadius * Math.sin(longitude);
        this._cageBase[offset + 1] = y;
        this._cageBase[offset + 2] = latitudeRadius * Math.cos(longitude);
        cagePoint++;
      }
    }
    for (let meridian = 0; meridian < CAGE_LONGITUDE_COUNT; meridian++) {
      const geographicLongitude =
        -Math.PI + (meridian / CAGE_LONGITUDE_COUNT) * TAU;
      const longitude = geographicLongitude - EARTH_FRONT_LONGITUDE;
      const longitudeSin = Math.sin(longitude);
      const longitudeCos = Math.cos(longitude);
      for (let point = 0; point < CAGE_POINTS_PER_LINE; point++) {
        const latitude =
          -Math.PI * 0.5 +
          (point / CAGE_SEGMENTS_PER_LINE) * Math.PI;
        const latitudeRadius = Math.cos(latitude);
        const offset = cagePoint * 3;
        this._cageBase[offset] = latitudeRadius * longitudeSin;
        this._cageBase[offset + 1] = Math.sin(latitude);
        this._cageBase[offset + 2] = latitudeRadius * longitudeCos;
        cagePoint++;
      }
    }
    let cageSegment = 0;
    for (let line = 0; line < CAGE_LINE_COUNT; line++) {
      const lineBase = line * CAGE_POINTS_PER_LINE;
      for (let point = 0; point < CAGE_SEGMENTS_PER_LINE; point++) {
        this._cageSegmentFrom[cageSegment] = lineBase + point;
        this._cageSegmentTo[cageSegment] = lineBase + point + 1;
        cageSegment++;
      }
    }

    // ---- Fixed cinematic pools: data arcs, wire packets, and scan plane ----
    this._dataArcActive = new Uint8Array(DATA_ARC_POOL_SIZE);
    this._dataArcFrom = new Uint16Array(DATA_ARC_POOL_SIZE);
    this._dataArcTo = new Uint16Array(DATA_ARC_POOL_SIZE);
    this._dataArcTone = new Uint8Array(DATA_ARC_POOL_SIZE);
    this._dataArcStart = new Float64Array(DATA_ARC_POOL_SIZE);
    this._dataArcDuration = new Float32Array(DATA_ARC_POOL_SIZE);
    this._dataArcLift = new Float32Array(DATA_ARC_POOL_SIZE);
    this._dataArcSampleX = new Float32Array(
      DATA_ARC_POOL_SIZE * (DATA_ARC_TAIL_STEPS + 1)
    );
    this._dataArcSampleY = new Float32Array(
      DATA_ARC_POOL_SIZE * (DATA_ARC_TAIL_STEPS + 1)
    );
    this._dataArcSampleDepth = new Float32Array(
      DATA_ARC_POOL_SIZE * (DATA_ARC_TAIL_STEPS + 1)
    );
    this._dataArcPairFrom = new Uint16Array(DATA_ARC_PAIR_COUNT);
    this._dataArcPairTo = new Uint16Array(DATA_ARC_PAIR_COUNT);
    for (let pair = 0; pair < DATA_ARC_PAIR_COUNT; pair++) {
      const from = landDotIndices[
        (31 + pair * 97) % landDotCount
      ];
      let toPosition =
        (211 + pair * 131) % landDotCount;
      let to = landDotIndices[toPosition];
      for (let attempt = 0; attempt < 24; attempt++) {
        const fromOffset = from * 3;
        const toOffset = to * 3;
        const alignment =
          this._dotBase[fromOffset] * this._dotBase[toOffset] +
          this._dotBase[fromOffset + 1] * this._dotBase[toOffset + 1] +
          this._dotBase[fromOffset + 2] * this._dotBase[toOffset + 2];
        if (alignment > -0.18 && alignment < 0.72) break;
        toPosition = (toPosition + 137) % landDotCount;
        to = landDotIndices[toPosition];
      }
      this._dataArcPairFrom[pair] = from;
      this._dataArcPairTo[pair] = to;
    }
    this._dataArcSequence = 0;
    this._nextDataArcAt = 0.18;

    this._wirePulseKind = new Uint8Array(WIRE_PULSE_COUNT);
    this._wirePulseChain = new Uint8Array(WIRE_PULSE_COUNT);
    this._wirePulsePosition = new Float32Array(WIRE_PULSE_COUNT);
    this._wirePulseSpeed = new Float32Array(WIRE_PULSE_COUNT);
    this._wirePulseDirection = new Int8Array(WIRE_PULSE_COUNT);
    this._wirePulseWindow = new Float32Array(WIRE_PULSE_COUNT);
    for (let pulse = 0; pulse < WIRE_PULSE_COUNT; pulse++) {
      const kind = pulse % 2;
      this._wirePulseKind[pulse] = kind;
      this._wirePulseChain[pulse] = kind
        ? (pulse * 3 + 1) % CAGE_LONGITUDE_COUNT
        : (pulse * 2 + 1) % CAGE_LATITUDE_COUNT;
      this._wirePulsePosition[pulse] = hashUnit(pulse + 6203);
      this._wirePulseSpeed[pulse] =
        0.12 + hashUnit(pulse + 6301) * 0.1;
      this._wirePulseDirection[pulse] = pulse % 3 ? 1 : -1;
      this._wirePulseWindow[pulse] =
        0.035 + hashUnit(pulse + 6421) * 0.025;
    }

    this._scanActive = new Uint8Array(1);
    this._scanStart = new Float64Array(1);
    this._scanNext = new Float64Array(1);
    this._scanNext[0] = SCAN_INTERVAL;
    this._scanLatitude = 0;
    this._scanRingCos = new Float32Array(SCAN_RING_STEPS);
    this._scanRingSin = new Float32Array(SCAN_RING_STEPS);
    this._scanRingX = new Float32Array(SCAN_RING_STEPS);
    this._scanRingY = new Float32Array(SCAN_RING_STEPS);
    this._scanRingDepth = new Float32Array(SCAN_RING_STEPS);
    for (let point = 0; point < SCAN_RING_STEPS; point++) {
      const angle = (point / SCAN_RING_STEPS) * TAU;
      this._scanRingCos[point] = Math.cos(angle);
      this._scanRingSin[point] = Math.sin(angle);
    }

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
    this._moonTailX = new Float32Array(MOON_COUNT * MOON_TAIL_SAMPLES);
    this._moonTailY = new Float32Array(MOON_COUNT * MOON_TAIL_SAMPLES);
    this._moonTailDepth = new Float32Array(
      MOON_COUNT * MOON_TAIL_SAMPLES
    );
    this._moonTailCursor = 0;
    this._moonTailInitialized = 0;
    this._nextMoonTailAt = 0;

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

    // A cached PAL.Hl → transparent sprite supplies the subtle inner glow
    // without allocating a CanvasGradient every frame.
    this._coreGlow = document.createElement("canvas");
    this._coreGlow.width = 192;
    this._coreGlow.height = 192;
    const glowCtx = this._coreGlow.getContext("2d");
    const glow = glowCtx.createRadialGradient(96, 96, 0, 96, 96, 96);
    glow.addColorStop(0, "rgba(207,233,255,0.58)");
    glow.addColorStop(0.4, "rgba(59,130,246,0.3)");
    glow.addColorStop(0.75, "rgba(124,92,255,0.12)");
    glow.addColorStop(1, "rgba(124,92,255,0)");
    glowCtx.fillStyle = glow;
    glowCtx.fillRect(0, 0, 192, 192);

    // ---- Layer 3: plexus network — clustered nodes + kNN web ----
    const PLEX_N = 100;
    this._plexBase = new Float32Array(PLEX_N * 3);
    this._plexSize = new Float32Array(PLEX_N);
    this._plexSX = new Float32Array(PLEX_N);
    this._plexSY = new Float32Array(PLEX_N);
    this._plexDepth = new Float32Array(PLEX_N);
    {
      for (let i = 0; i < PLEX_N; i++) {
        const region = i % 4;
        const regionOffset = region * 4;
        const centerLongitude = POPULATION_REGIONS[regionOffset];
        const centerLatitude = POPULATION_REGIONS[regionOffset + 1];
        const longitudeSpread = POPULATION_REGIONS[regionOffset + 2];
        const latitudeSpread = POPULATION_REGIONS[regionOffset + 3];
        let longitudeDegrees = centerLongitude;
        let latitudeDegrees = centerLatitude;
        for (let attempt = 0; attempt < 28; attempt++) {
          const seed = i * 97 + attempt * 131 + 3109;
          longitudeDegrees =
            centerLongitude +
            (hashUnit(seed) + hashUnit(seed + 17) - 1) * longitudeSpread;
          latitudeDegrees =
            centerLatitude +
            (hashUnit(seed + 31) + hashUnit(seed + 47) - 1) * latitudeSpread;
          if (
            earthMaskValueAtGeo(
              this._earthMask,
              longitudeDegrees,
              latitudeDegrees
            )
          ) {
            break;
          }
        }
        const latitude = latitudeDegrees * DEG;
        const longitude =
          longitudeDegrees * DEG - EARTH_FRONT_LONGITUDE;
        const latitudeRadius = Math.cos(latitude);
        this._plexBase[i * 3] = latitudeRadius * Math.sin(longitude);
        this._plexBase[i * 3 + 1] = Math.sin(latitude);
        this._plexBase[i * 3 + 2] = latitudeRadius * Math.cos(longitude);
        this._plexSize[i] = 0.9 + hashUnit(i * 17 + 23) * 1.55;
      }
      // kNN edges: 2-4 nearest neighbors each, deduplicated
      const edges = new Set();
      for (let i = 0; i < PLEX_N; i++) {
        const dists = [];
        for (let j = 0; j < PLEX_N; j++) {
          if (j === i) continue;
          const dx = this._plexBase[i * 3] - this._plexBase[j * 3];
          const dy = this._plexBase[i * 3 + 1] - this._plexBase[j * 3 + 1];
          const dz = this._plexBase[i * 3 + 2] - this._plexBase[j * 3 + 2];
          dists.push([dx * dx + dy * dy + dz * dz, j]);
        }
        dists.sort((a, b) => a[0] - b[0]);
        const k = 2 + Math.floor(hashUnit(i * 19 + 31) * 2);
        for (let e = 0; e < k; e++) edges.add(i < dists[e][1] ? i * 1000 + dists[e][1] : dists[e][1] * 1000 + i);
      }
      this._plexEdges = Int32Array.from(edges);
      this._plexAdj = Array.from({ length: PLEX_N }, () => []);
      for (const key of this._plexEdges) {
        const a = Math.floor(key / 1000), b = key % 1000;
        this._plexAdj[a].push(b); this._plexAdj[b].push(a);
      }
      this._flareNode = -1; this._flareAt = 0; this._nextFlareAt = 2;
    }
    // ---- Layer 4: ambient rising particles ----
    const AMB_N = 26;
    this._ambPhase = new Float32Array(AMB_N);
    this._ambAngle = new Float32Array(AMB_N);
    this._ambSpeed = new Float32Array(AMB_N);
    for (let i = 0; i < AMB_N; i++) {
      this._ambPhase[i] = hashUnit(i * 23 + 3);
      this._ambAngle[i] = hashUnit(i * 29 + 9) * TAU;
      this._ambSpeed[i] = 0.05 + hashUnit(i * 31 + 13) * 0.05;
    }

    // Round-two bloom and atmosphere assets. Every gradient is rasterized once
    // here; the frame loop only scales cached canvases with drawImage().
    this._dotGlowSprites = new Array(DOT_TONE_BUCKETS);
    for (let tone = 0; tone < DOT_TONE_BUCKETS; tone++) {
      this._dotGlowSprites[tone] = makeGlowSprite(
        DOT_TONE_PREFIXES[tone],
        DOT_GLOW_SIZE,
        0.58
      );
    }
    this._highlightGlow = makeGlowSprite(
      PAL.Hl,
      DOT_GLOW_SIZE,
      0.72
    );
    this._moonGlowSprites = new Array(MOON_COUNT);
    for (let moon = 0; moon < MOON_COUNT; moon++) {
      this._moonGlowSprites[moon] = makeGlowSprite(
        MOON_PREFIXES[moon],
        DOT_GLOW_SIZE,
        0.76
      );
    }
    this._settleGlowSprites = new Array(2);
    this._settleGlowSprites[0] = makeGlowSprite(
      PAL.ERR,
      DOT_GLOW_SIZE,
      0.78
    );
    this._settleGlowSprites[1] = makeGlowSprite(
      PAL.OK,
      DOT_GLOW_SIZE,
      0.78
    );
    this._arcHeadGlow = new Array(2);
    this._arcHeadGlow[0] = makeGlowSprite(
      PAL.O,
      ARC_GLOW_SIZE,
      0.78
    );
    this._arcHeadGlow[1] = makeGlowSprite(
      PAL.V,
      ARC_GLOW_SIZE,
      0.78
    );
    this._limbGlow = makeLimbSprite(
      PAL.O,
      ATMOSPHERE_SPRITE_SIZE
    );
    this._nebulaSprites = new Array(2);
    this._nebulaSprites[0] = makeNebulaSprite(
      PAL.V,
      ATMOSPHERE_SPRITE_SIZE,
      0
    );
    this._nebulaSprites[1] = makeNebulaSprite(
      PAL.V,
      ATMOSPHERE_SPRITE_SIZE,
      1
    );
    this._projectorFloor = makeProjectorFloorSprite(PAL.B);
    this._projectorBeam = makeProjectorBeamSprite(PAL.B);

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
    this._moonTailInitialized = 0;
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
          this._cloudYaw = 0;
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

  _launchDataArc(time, violet) {
    let slot = -1;
    let oldest = 0;
    for (let i = 0; i < DATA_ARC_POOL_SIZE; i++) {
      if (!this._dataArcActive[i]) {
        slot = i;
        break;
      }
      if (this._dataArcStart[i] < this._dataArcStart[oldest]) oldest = i;
    }
    if (slot < 0) slot = oldest;

    const sequence = this._dataArcSequence++;
    const pair = sequence % DATA_ARC_PAIR_COUNT;
    this._dataArcActive[slot] = 1;
    this._dataArcFrom[slot] = this._dataArcPairFrom[pair];
    this._dataArcTo[slot] = this._dataArcPairTo[pair];
    this._dataArcTone[slot] = violet ? 1 : 0;
    this._dataArcStart[slot] = time;
    this._dataArcDuration[slot] =
      DATA_ARC_LIFE * (0.92 + hashUnit(sequence + 7013) * 0.16);
    this._dataArcLift[slot] =
      0.14 + hashUnit(sequence + 7103) * 0.15;
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

  // ---- Animation/state loop ----
  _loop() {
    if (this._disposed) return;
    if (!this.reduced) this._raf = requestAnimationFrame(this._boundLoop);

    const now = performance.now();
    const dt = this.reduced
      ? 0
      : Math.max(0, Math.min(0.05, (now - this._lastFrameAt) / 1000));
    this._lastFrameAt = now;
    this._elapsed = (now - this._t0) / 1000;
    const time = this.reduced ? 0 : this._elapsed;

    const stateEase = this.reduced ? 1 : 1 - Math.exp(-dt * 7);
    const listeningTarget = this.status === "listening" ? 1 : 0;
    const thinkingTarget =
      !this.reduced && this.status === "thinking" ? 1 : 0;
    const speakingTarget = this.status === "speaking" ? 1 : 0;
    this._listeningMix +=
      (listeningTarget - this._listeningMix) * stateEase;
    this._thinkingMix += (thinkingTarget - this._thinkingMix) * stateEase;
    this._speakingMix += (speakingTarget - this._speakingMix) * stateEase;

    if (!this.reduced) {
      this._globeYaw +=
        dt * BASE_SPIN_RATE * (1 + this._listeningMix * 1.5);
      this._cloudYaw += dt * 0.18 * this._thinkingMix;

      const pulseRate =
        1 + this._thinkingMix * 0.7 + this._speakingMix * 0.45;
      for (let pulse = 0; pulse < WIRE_PULSE_COUNT; pulse++) {
        let position =
          this._wirePulsePosition[pulse] +
          this._wirePulseSpeed[pulse] *
            this._wirePulseDirection[pulse] *
            dt *
            pulseRate;
        if (this._wirePulseKind[pulse] === 0) {
          if (position < 0) position += 1;
          if (position >= 1) position -= 1;
        } else if (position < 0 || position > 1) {
          position = position < 0 ? -position : 2 - position;
          this._wirePulseDirection[pulse] *= -1;
        }
        this._wirePulsePosition[pulse] = position;
      }

      if (!this._scanActive[0] && time >= this._scanNext[0]) {
        this._scanActive[0] = 1;
        this._scanStart[0] = time;
        this._scanNext[0] = time + SCAN_INTERVAL;
      } else if (
        this._scanActive[0] &&
        time - this._scanStart[0] >= SCAN_DURATION
      ) {
        this._scanActive[0] = 0;
      }

      for (let arc = 0; arc < DATA_ARC_POOL_SIZE; arc++) {
        if (
          this._dataArcActive[arc] &&
          time - this._dataArcStart[arc] >=
            this._dataArcDuration[arc]
        ) {
          this._dataArcActive[arc] = 0;
        }
      }
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

    if (!this.reduced && time >= this._nextDataArcAt) {
      this._launchDataArc(time, this.status === "thinking");
      const baseInterval =
        0.25 + hashUnit(this._dataArcSequence + 7307) * 0.25;
      const stateRate =
        this.status === "thinking"
          ? 3
          : this.status === "speaking"
            ? 1.65
            : 1;
      this._nextDataArcAt = time + baseInterval / stateRate;
    }

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
      this._launchDataArc(time, false);
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
    this._fYawCos = yawCos; this._fYawSin = yawSin;
    this._fPitchCos = pitchCos; this._fPitchSin = pitchSin;
    const swirlYaw = this._cloudYaw;
    const swirlPitch = Math.sin(this._cloudYaw * 0.65) * 0.12;
    const swirlYawCos = Math.cos(swirlYaw);
    const swirlYawSin = Math.sin(swirlYaw);
    const swirlPitchCos = Math.cos(swirlPitch);
    const swirlPitchSin = Math.sin(swirlPitch);
    const voiceStateMix = Math.min(
      1,
      this._speakingMix + this._listeningMix
    );
    const waveAmount = this.reduced ? 0 : amp * voiceStateMix * 0.12;
    const scanVisible = !this.reduced && this._scanActive[0] !== 0;
    if (scanVisible) {
      const scanProgress = Math.max(
        0,
        Math.min(
          1,
          (time - this._scanStart[0]) / SCAN_DURATION
        )
      );
      this._scanLatitude = -Math.PI * 0.5 + scanProgress * Math.PI;
    }

    for (let group = 0; group < DOT_STYLE_GROUPS; group++) {
      this._dotStyleCounts[group] = 0;
    }
    for (let bucket = 0; bucket < 6; bucket++) {
      this._lightBucketCounts[bucket] = 0;
    }

    for (let i = 0; i < this._dotCount; i++) {
      let pulseLight = 0;
      const wireKind = this._dotWireKind[i];
      const wireChain = this._dotWireChain[i];
      const wireParam = this._dotWireParam[i];
      for (let pulse = 0; pulse < WIRE_PULSE_COUNT; pulse++) {
        if (
          this._wirePulseKind[pulse] !== wireKind ||
          this._wirePulseChain[pulse] !== wireChain
        ) {
          continue;
        }
        let distance = Math.abs(
          wireParam - this._wirePulsePosition[pulse]
        );
        if (wireKind === 0) distance = Math.min(distance, 1 - distance);
        const pulseWindow = this._wirePulseWindow[pulse];
        if (distance < pulseWindow) {
          let light = 1 - distance / pulseWindow;
          light = light * light * (3 - 2 * light);
          if (light > pulseLight) pulseLight = light;
        }
      }

      let scanLight = 0;
      if (scanVisible) {
        const scanDistance = Math.abs(
          this._dotLatitude[i] - this._scanLatitude
        );
        if (scanDistance < 0.12) {
          scanLight = 1 - scanDistance / 0.12;
          scanLight =
            scanLight * scanLight * (3 - 2 * scanLight);
        }
      }
      const lightBoost = Math.max(pulseLight, scanLight);
      const lightBucket = Math.min(
        5,
        Math.round(lightBoost * 5)
      );
      if (lightBucket) {
        const lightCount = this._lightBucketCounts[lightBucket];
        this._lightBucketIndices[
          lightBucket * DOT_COUNT + lightCount
        ] = i;
        this._lightBucketCounts[lightBucket] = lightCount + 1;
      }

      const offset = i * 3;
      const wave =
        (1 +
          Math.sin(this._dotLatitude[i] * 5 - time * 3.1) *
            waveAmount) *
        (1 + scanLight * 0.035);
      const baseX = this._dotBase[offset] * wave;
      const baseY = this._dotBase[offset + 1] * wave;
      const baseZ = this._dotBase[offset + 2] * wave;

      const delay = this._dotDelay[i];
      let dissolve = (this._thinkingMix - delay) / (1 - delay);
      dissolve = Math.max(0, Math.min(1, dissolve));
      dissolve = dissolve * dissolve * (3 - 2 * dissolve);

      const targetX = baseX + this._dotScatter[offset];
      const targetY = baseY + this._dotScatter[offset + 1];
      const targetZ = baseZ + this._dotScatter[offset + 2];
      const swirlX = targetX * swirlYawCos + targetZ * swirlYawSin;
      const swirlZ = -targetX * swirlYawSin + targetZ * swirlYawCos;
      const swirlY2 = targetY * swirlPitchCos - swirlZ * swirlPitchSin;
      const swirlZ2 = targetY * swirlPitchSin + swirlZ * swirlPitchCos;
      const reform =
        this._reformOvershoot * (1 - dissolve) * (0.75 + delay * 0.4);
      const scatterMix = dissolve - reform;

      const pointX =
        (baseX + (swirlX - baseX) * scatterMix) * sphereScale;
      const pointY =
        (baseY + (swirlY2 - baseY) * scatterMix) * sphereScale;
      const pointZ =
        (baseZ + (swirlZ2 - baseZ) * scatterMix) * sphereScale;

      const cameraX = pointX * yawCos + pointZ * yawSin;
      const cameraZ = -pointX * yawSin + pointZ * yawCos;
      const cameraY = pointY * pitchCos - cameraZ * pitchSin;
      const depth = pointY * pitchSin + cameraZ * pitchCos;
      const perspective = CAM_DISTANCE / (CAM_DISTANCE - depth);

      this._dotCameraX[i] = cameraX;
      this._dotCameraY[i] = cameraY;
      this._dotScreenX[i] = cameraX * radius * perspective;
      this._dotScreenY[i] = -cameraY * radius * perspective;
      this._dotDepth[i] = depth;

      const depthLight = Math.max(
        0,
        Math.min(1, (depth + 1.55) / 3.1)
      );
      const surface = this._dotSurface[i];
      const twinkle =
        1 +
        this._dotShimmer[i] *
          Math.sin(time * (surface ? 1.35 : 0.72) + this._dotTwinkle[i]);
      const baseAlpha = surface
        ? 0.11 + depthLight * 0.8
        : 0.025 + depthLight * 0.27;
      const dotAlpha = Math.min(
        1,
        baseAlpha *
            twinkle *
            this._dotIntensity[i] *
            (1 + this._listeningMix * 0.32) +
          lightBoost * 0.62
      );
      const alphaBucket = Math.max(
        0,
        Math.min(
          DOT_ALPHA_BUCKETS - 1,
          Math.round(dotAlpha * (DOT_ALPHA_BUCKETS - 1))
        )
      );
      const toneBucket = this._dotToneBase[i];
      this._dotToneBucket[i] = toneBucket;
      const styleGroup =
        toneBucket * DOT_ALPHA_BUCKETS + alphaBucket;
      const styleCount = this._dotStyleCounts[styleGroup];
      this._dotStyleIndices[
        styleGroup * DOT_COUNT + styleCount
      ] = i;
      this._dotStyleCounts[styleGroup] = styleCount + 1;
      this._dotRadius[i] = Math.max(
        surface ? 1.05 : 0.65,
        Math.min(
          surface ? 3.45 : 1.55,
          this._dotBaseSize[i] *
            (0.9 + depthLight * 0.1) *
            (0.94 + perspective * 0.06) *
            (1 + lightBoost * 0.12)
        )
      );
    }

    this._projectCage(
      radius,
      sphereScale,
      yawCos,
      yawSin,
      pitchCos,
      pitchSin
    );

    if (scanVisible) {
      const scanCos = Math.cos(this._scanLatitude);
      const scanY =
        Math.sin(this._scanLatitude) * sphereScale * 1.035;
      const scanRadius = scanCos * sphereScale * 1.035;
      for (let point = 0; point < SCAN_RING_STEPS; point++) {
        const pointX = this._scanRingCos[point] * scanRadius;
        const pointZ = this._scanRingSin[point] * scanRadius;
        const cameraX = pointX * yawCos + pointZ * yawSin;
        const cameraZ = -pointX * yawSin + pointZ * yawCos;
        const cameraY = scanY * pitchCos - cameraZ * pitchSin;
        const depth = scanY * pitchSin + cameraZ * pitchCos;
        const perspective = CAM_DISTANCE / (CAM_DISTANCE - depth);
        this._scanRingX[point] = cameraX * radius * perspective;
        this._scanRingY[point] = -cameraY * radius * perspective;
        this._scanRingDepth[point] = depth;
      }
    }

    for (let arc = 0; arc < DATA_ARC_POOL_SIZE; arc++) {
      if (!this._dataArcActive[arc]) continue;
      const from = this._dataArcFrom[arc];
      const to = this._dataArcTo[arc];
      const fromX = this._dotCameraX[from];
      const fromY = this._dotCameraY[from];
      const fromZ = this._dotDepth[from];
      const toX = this._dotCameraX[to];
      const toY = this._dotCameraY[to];
      const toZ = this._dotDepth[to];
      const middleX = (fromX + toX) * 0.5;
      const middleY = (fromY + toY) * 0.5;
      const middleZ = (fromZ + toZ) * 0.5;
      let directionLength = Math.sqrt(
        middleX * middleX +
          middleY * middleY +
          middleZ * middleZ
      );
      let directionX = middleX;
      let directionY = middleY;
      let directionZ = middleZ;
      if (directionLength < 0.001) {
        directionX = fromX;
        directionY = fromY;
        directionZ = fromZ;
        directionLength = Math.max(
          0.001,
          Math.sqrt(
            directionX * directionX +
              directionY * directionY +
              directionZ * directionZ
          )
        );
      }
      directionX /= directionLength;
      directionY /= directionLength;
      directionZ /= directionLength;
      const fromLength = Math.sqrt(
        fromX * fromX + fromY * fromY + fromZ * fromZ
      );
      const toLength = Math.sqrt(
        toX * toX + toY * toY + toZ * toZ
      );
      const crest =
        (fromLength + toLength) * 0.5 + this._dataArcLift[arc];
      const controlX = directionX * crest * 2 - middleX;
      const controlY = directionY * crest * 2 - middleY;
      const controlZ = directionZ * crest * 2 - middleZ;
      const progress = Math.max(
        0,
        Math.min(
          1,
          (time - this._dataArcStart[arc]) /
            this._dataArcDuration[arc]
        )
      );
      const tailStart = Math.max(0, progress - DATA_ARC_TAIL_SPAN);
      const sampleBase = arc * (DATA_ARC_TAIL_STEPS + 1);
      for (let sample = 0; sample <= DATA_ARC_TAIL_STEPS; sample++) {
        const sampleMix = sample / DATA_ARC_TAIL_STEPS;
        const u = tailStart + (progress - tailStart) * sampleMix;
        const inverse = 1 - u;
        const cameraX =
          inverse * inverse * fromX +
          2 * inverse * u * controlX +
          u * u * toX;
        const cameraY =
          inverse * inverse * fromY +
          2 * inverse * u * controlY +
          u * u * toY;
        const depth =
          inverse * inverse * fromZ +
          2 * inverse * u * controlZ +
          u * u * toZ;
        const perspective = CAM_DISTANCE / (CAM_DISTANCE - depth);
        const sampleOffset = sampleBase + sample;
        this._dataArcSampleX[sampleOffset] =
          cameraX * radius * perspective;
        this._dataArcSampleY[sampleOffset] =
          -cameraY * radius * perspective;
        this._dataArcSampleDepth[sampleOffset] = depth;
      }
    }

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

    if (!this._moonTailInitialized) {
      this._moonTailCursor = 0;
      for (let moon = 0; moon < MOON_COUNT; moon++) {
        const tailBase = moon * MOON_TAIL_SAMPLES;
        for (let sample = 0; sample < MOON_TAIL_SAMPLES; sample++) {
          const tailOffset = tailBase + sample;
          this._moonTailX[tailOffset] = this._moonScreenX[moon];
          this._moonTailY[tailOffset] = this._moonScreenY[moon];
          this._moonTailDepth[tailOffset] = this._moonDepth[moon];
        }
      }
      this._moonTailInitialized = 1;
      this._nextMoonTailAt = time + MOON_TAIL_INTERVAL;
    } else if (!this.reduced && time >= this._nextMoonTailAt) {
      this._moonTailCursor =
        (this._moonTailCursor + 1) % MOON_TAIL_SAMPLES;
      for (let moon = 0; moon < MOON_COUNT; moon++) {
        const tailOffset =
          moon * MOON_TAIL_SAMPLES + this._moonTailCursor;
        this._moonTailX[tailOffset] = this._moonScreenX[moon];
        this._moonTailY[tailOffset] = this._moonScreenY[moon];
        this._moonTailDepth[tailOffset] = this._moonDepth[moon];
      }
      this._nextMoonTailAt = time + MOON_TAIL_INTERVAL;
    }

    ctx.save();
    ctx.translate(centerX, centerY);
    this._sceneAlpha = hudAlpha;
    ctx.globalAlpha = hudAlpha;
    ctx.globalCompositeOperation = "lighter";

    this._drawNebula(time, silhouetteRadius);
    this._drawProjectorBase(time, silhouetteRadius);
    this._drawLimb(silhouetteRadius);
    this._drawOrbitPass(false);
    this._drawMoonTailPass(false);
    this._drawMoonLightPass(false, time, silhouetteRadius);
    // SOLID BODY: the planet occludes its far side and the room behind it.
    // A transparent dot-cloud has no shape; a body does.
    this._drawSolidBody(silhouetteRadius);

    const corePulse = this.reduced ? 1 : 1 + 0.06 * (0.5 + 0.5 * Math.sin(time * (TAU / 5)));
    const glowSize = silhouetteRadius * 0.64 * corePulse;
    ctx.globalAlpha =
      Math.min(
        0.68,
        hudAlpha * (0.52 + this._listeningMix * 0.08 + amp * 0.08)
      );
    ctx.drawImage(
      this._coreGlow,
      -glowSize * 0.5,
      -glowSize * 0.5,
      glowSize,
      glowSize
    );

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = hudAlpha;
    this._drawMoonLabelPass(false);

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = hudAlpha;
    this._drawCagePass(true);
    this._drawPlexus(time, silhouetteRadius);
    this._drawAmbientRise(time, silhouetteRadius);
    this._drawDotGlowPass(true);
    this._drawDotPass(true);
    this._drawLightPacketPass(true);
    this._drawDataArcPass(true);
    this._drawScanPass(true);
    this._drawHalos(time, silhouetteRadius);
    this._drawOrbitPass(true);
    this._drawMoonTailPass(true);
    this._drawMoonLightPass(true, time, silhouetteRadius);
    this._drawMoonTethers(time, silhouetteRadius);

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

  _projectCage(radius, sphereScale, yawCos, yawSin, pitchCos, pitchSin) {
    for (let group = 0; group < STYLE_ALPHA_BUCKETS * 2; group++) {
      this._cageStyleCounts[group] = 0;
    }
    for (let point = 0; point < CAGE_POINT_COUNT; point++) {
      const offset = point * 3;
      const pointX = this._cageBase[offset] * sphereScale;
      const pointY = this._cageBase[offset + 1] * sphereScale;
      const pointZ = this._cageBase[offset + 2] * sphereScale;
      const cameraX = pointX * yawCos + pointZ * yawSin;
      const cameraZ = -pointX * yawSin + pointZ * yawCos;
      const cameraY = pointY * pitchCos - cameraZ * pitchSin;
      const depth = pointY * pitchSin + cameraZ * pitchCos;
      const perspective = CAM_DISTANCE / (CAM_DISTANCE - depth);
      this._cageScreenX[point] = cameraX * radius * perspective;
      this._cageScreenY[point] = -cameraY * radius * perspective;
      this._cageDepth[point] = depth;
    }
    for (let segment = 0; segment < CAGE_SEGMENT_COUNT; segment++) {
      const from = this._cageSegmentFrom[segment];
      const to = this._cageSegmentTo[segment];
      const depth = (this._cageDepth[from] + this._cageDepth[to]) * 0.5;
      const front = depth >= 0 ? 1 : 0;
      const rim = 1 - Math.min(1, Math.abs(depth) / 0.9);
      const alpha = front ? 0.12 + rim * 0.22 : 0.035 + rim * 0.08;
      const bucket = Math.max(
        1,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(alpha * (STYLE_ALPHA_BUCKETS - 1))
        )
      );
      const group = front * STYLE_ALPHA_BUCKETS + bucket;
      const count = this._cageStyleCounts[group];
      this._cageStyleIndices[
        group * CAGE_SEGMENT_COUNT + count
      ] = segment;
      this._cageStyleCounts[group] = count + 1;
    }
  }

  _drawNebula(time, silhouetteRadius) {
    const ctx = this.ctx;
    const driftTime = this.reduced ? 0 : time;
    const tightness = 1 - this._listeningMix * 0.16;
    const firstWidth = silhouetteRadius * 3.45 * tightness;
    const firstHeight = silhouetteRadius * 2.35 * tightness;
    const firstX =
      Math.sin(driftTime * 0.055 + 0.6) * silhouetteRadius * 0.18;
    const firstY =
      Math.cos(driftTime * 0.041 + 1.1) * silhouetteRadius * 0.13;
    const secondWidth = silhouetteRadius * 2.8 * tightness;
    const secondHeight = silhouetteRadius * 3.05 * tightness;
    const secondX =
      Math.cos(driftTime * 0.047 + 2.2) * silhouetteRadius * 0.2;
    const secondY =
      Math.sin(driftTime * 0.063 + 0.3) * silhouetteRadius * 0.15;

    ctx.globalAlpha =
      this._sceneAlpha * (0.72 - this._listeningMix * 0.08);
    ctx.drawImage(
      this._nebulaSprites[0],
      firstX - firstWidth * 0.5,
      firstY - firstHeight * 0.5,
      firstWidth,
      firstHeight
    );
    ctx.globalAlpha =
      this._sceneAlpha * (0.58 - this._listeningMix * 0.05);
    ctx.drawImage(
      this._nebulaSprites[1],
      secondX - secondWidth * 0.5,
      secondY - secondHeight * 0.5,
      secondWidth,
      secondHeight
    );
    ctx.globalAlpha = this._sceneAlpha;
  }

  _drawLimb(silhouetteRadius) {
    const ctx = this.ctx;
    const size = silhouetteRadius * 2.46;
    ctx.globalAlpha =
      this._sceneAlpha * (0.66 + this._listeningMix * 0.34);
    ctx.drawImage(
      this._limbGlow,
      -size * 0.5,
      -size * 0.5,
      size,
      size
    );
    ctx.globalAlpha = this._sceneAlpha;
  }

  _drawOrbitPass(front) {
    const ctx = this.ctx;
    ctx.globalAlpha = this._sceneAlpha;
    ctx.lineWidth = 0.65;
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
  }

  _drawMoonTailPass(front) {
    if (this.reduced) return;
    const ctx = this.ctx;
    ctx.globalAlpha = this._sceneAlpha;
    ctx.lineCap = "round";
    for (let moon = 0; moon < MOON_COUNT; moon++) {
      const pool = MOON_STYLES[moon];
      const base = moon * MOON_TAIL_SAMPLES;
      for (let sample = 1; sample < MOON_TAIL_SAMPLES; sample++) {
        const previousSlot =
          (this._moonTailCursor + sample) % MOON_TAIL_SAMPLES;
        const currentSlot =
          (this._moonTailCursor + sample + 1) % MOON_TAIL_SAMPLES;
        const from = base + previousSlot;
        const to = base + currentSlot;
        const segmentFront =
          (this._moonTailDepth[from] + this._moonTailDepth[to]) *
            0.5 >=
          0;
        if (segmentFront !== front) continue;
        const bucket = front ? sample + 2 : Math.max(1, sample);
        ctx.strokeStyle = pool[bucket];
        ctx.lineWidth = 0.55 + sample * 0.16;
        ctx.beginPath();
        ctx.moveTo(this._moonTailX[from], this._moonTailY[from]);
        ctx.lineTo(this._moonTailX[to], this._moonTailY[to]);
        ctx.stroke();
      }

      for (let sample = 0; sample < MOON_TAIL_SAMPLES; sample++) {
        const slot =
          (this._moonTailCursor + sample + 1) % MOON_TAIL_SAMPLES;
        const tail = base + slot;
        if ((this._moonTailDepth[tail] >= 0) !== front) continue;
        const bucket = front ? sample + 2 : Math.max(1, sample);
        const tailRadius = 0.45 + sample * 0.14;
        ctx.fillStyle = pool[bucket];
        ctx.beginPath();
        ctx.arc(
          this._moonTailX[tail],
          this._moonTailY[tail],
          tailRadius,
          0,
          TAU
        );
        ctx.fill();
      }
    }
    ctx.lineCap = "butt";
  }

  _drawCagePass(front) {
    const ctx = this.ctx;
    ctx.globalAlpha =
      this._sceneAlpha * (1 - this._thinkingMix * 0.78);
    ctx.lineWidth = front ? 0.62 : 0.46;
    const groupOffset = front ? STYLE_ALPHA_BUCKETS : 0;
    for (let bucket = 1; bucket < STYLE_ALPHA_BUCKETS; bucket++) {
      const group = groupOffset + bucket;
      const count = this._cageStyleCounts[group];
      if (!count) continue;
      ctx.strokeStyle = B_STYLES[bucket];
      ctx.beginPath();
      const groupBase = group * CAGE_SEGMENT_COUNT;
      for (let item = 0; item < count; item++) {
        const segment = this._cageStyleIndices[groupBase + item];
        const from = this._cageSegmentFrom[segment];
        const to = this._cageSegmentTo[segment];
        ctx.moveTo(this._cageScreenX[from], this._cageScreenY[from]);
        ctx.lineTo(this._cageScreenX[to], this._cageScreenY[to]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = this._sceneAlpha;
  }

  _drawDotGlowPass(front) {
    const ctx = this.ctx;
    for (let alpha = 8; alpha < DOT_ALPHA_BUCKETS; alpha++) {
      ctx.globalAlpha =
        this._sceneAlpha * (alpha === 9 ? 0.5 : 0.3);
      for (let tone = 0; tone < DOT_TONE_BUCKETS; tone++) {
        const sprite = this._dotGlowSprites[tone];
        const group = tone * DOT_ALPHA_BUCKETS + alpha;
        const groupBase = group * DOT_COUNT;
        const groupCount = this._dotStyleCounts[group];
        for (let item = 0; item < groupCount; item++) {
          const i = this._dotStyleIndices[groupBase + item];
          if ((this._dotDepth[i] >= 0) !== front) continue;
          const size = this._dotRadius[i] * 8;
          ctx.drawImage(
            sprite,
            this._dotScreenX[i] - size * 0.5,
            this._dotScreenY[i] - size * 0.5,
            size,
            size
          );
        }
      }
    }

    ctx.globalAlpha = this._sceneAlpha * 0.46;
    for (let bucket = 4; bucket <= 5; bucket++) {
      const bucketBase = bucket * DOT_COUNT;
      const bucketCount = this._lightBucketCounts[bucket];
      for (let item = 0; item < bucketCount; item++) {
        const i = this._lightBucketIndices[bucketBase + item];
        if ((this._dotDepth[i] >= 0) !== front) continue;
        const size = this._dotRadius[i] * 9;
        ctx.drawImage(
          this._highlightGlow,
          this._dotScreenX[i] - size * 0.5,
          this._dotScreenY[i] - size * 0.5,
          size,
          size
        );
      }
    }
    ctx.globalAlpha = this._sceneAlpha;
  }

  _drawDotPass(front) {
    const ctx = this.ctx;
    ctx.globalAlpha = this._sceneAlpha;
    for (let tone = 0; tone < DOT_TONE_BUCKETS; tone++) {
      for (let alpha = 1; alpha < DOT_ALPHA_BUCKETS; alpha++) {
        let hasDots = false;
        const group = tone * DOT_ALPHA_BUCKETS + alpha;
        const groupBase = group * DOT_COUNT;
        const groupCount = this._dotStyleCounts[group];
        ctx.beginPath();
        for (let item = 0; item < groupCount; item++) {
          const i = this._dotStyleIndices[groupBase + item];
          if ((this._dotDepth[i] >= 0) !== front) continue;
          const x = this._dotScreenX[i];
          const y = this._dotScreenY[i];
          const radius = this._dotRadius[i];
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, TAU);
          hasDots = true;
        }
        if (hasDots) {
          ctx.fillStyle = DOT_STYLES[tone * DOT_ALPHA_BUCKETS + alpha];
          ctx.fill();
        }
      }
    }
  }

  _drawLightPacketPass(front) {
    const ctx = this.ctx;
    ctx.globalAlpha = this._sceneAlpha;
    for (let bucket = 1; bucket <= 5; bucket++) {
      let hasLight = false;
      const bucketBase = bucket * DOT_COUNT;
      const bucketCount = this._lightBucketCounts[bucket];
      ctx.fillStyle = HL_STYLES[6 + bucket];
      ctx.beginPath();
      for (let item = 0; item < bucketCount; item++) {
        const i = this._lightBucketIndices[bucketBase + item];
        if ((this._dotDepth[i] >= 0) !== front) continue;
        const radius =
          this._dotRadius[i] * (0.3 + bucket * 0.065);
        const x = this._dotScreenX[i];
        const y = this._dotScreenY[i];
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, TAU);
        hasLight = true;
      }
      if (hasLight) ctx.fill();
    }
  }

  _drawDataArcPass(front) {
    const ctx = this.ctx;
    ctx.globalAlpha = this._sceneAlpha;
    ctx.lineCap = "round";
    const forceViolet = this.status === "thinking";
    for (let tone = 0; tone < 2; tone++) {
      const pool = tone ? V_STYLES : O_STYLES;
      for (let step = 1; step <= DATA_ARC_TAIL_STEPS; step++) {
        const strength = step / DATA_ARC_TAIL_STEPS;
        const alpha = (0.08 + strength * 0.5) * (front ? 1 : 0.43);
        const bucket = Math.max(
          1,
          Math.min(
            STYLE_ALPHA_BUCKETS - 1,
            Math.round(alpha * (STYLE_ALPHA_BUCKETS - 1))
          )
        );
        let hasSegments = false;
        ctx.strokeStyle = pool[bucket];
        ctx.lineWidth = 0.55 + strength * 0.8;
        ctx.beginPath();
        for (let arc = 0; arc < DATA_ARC_POOL_SIZE; arc++) {
          if (
            !this._dataArcActive[arc] ||
            (forceViolet ? 1 : this._dataArcTone[arc]) !== tone
          ) {
            continue;
          }
          const base = arc * (DATA_ARC_TAIL_STEPS + 1);
          const from = base + step - 1;
          const to = from + 1;
          const segmentFront =
            (this._dataArcSampleDepth[from] +
              this._dataArcSampleDepth[to]) *
              0.5 >=
            0;
          if (segmentFront !== front) continue;
          ctx.moveTo(
            this._dataArcSampleX[from],
            this._dataArcSampleY[from]
          );
          ctx.lineTo(
            this._dataArcSampleX[to],
            this._dataArcSampleY[to]
          );
          hasSegments = true;
        }
        if (hasSegments) ctx.stroke();
      }
    }

    for (let arc = 0; arc < DATA_ARC_POOL_SIZE; arc++) {
      if (!this._dataArcActive[arc]) continue;
      const head =
        arc * (DATA_ARC_TAIL_STEPS + 1) + DATA_ARC_TAIL_STEPS;
      if ((this._dataArcSampleDepth[head] >= 0) !== front) continue;
      const tone = forceViolet ? 1 : this._dataArcTone[arc];
      const pool = tone ? V_STYLES : O_STYLES;
      const x = this._dataArcSampleX[head];
      const y = this._dataArcSampleY[head];
      const glowSize = front ? 18 : 14;
      ctx.globalAlpha = this._sceneAlpha * (front ? 0.9 : 0.4);
      ctx.drawImage(
        this._arcHeadGlow[tone],
        x - glowSize * 0.5,
        y - glowSize * 0.5,
        glowSize,
        glowSize
      );
      ctx.globalAlpha = this._sceneAlpha;
      ctx.fillStyle = pool[front ? 15 : 8];
      ctx.beginPath();
      ctx.arc(x, y, front ? 1.35 : 1, 0, TAU);
      ctx.fill();
    }
    ctx.lineCap = "butt";
    ctx.globalAlpha = this._sceneAlpha;
  }

  _drawScanPass(front) {
    if (this.reduced || !this._scanActive[0]) return;
    const ctx = this.ctx;
    let hasSegments = false;
    ctx.globalAlpha = this._sceneAlpha;
    ctx.beginPath();
    for (let point = 0; point < SCAN_RING_STEPS; point++) {
      const next = (point + 1) % SCAN_RING_STEPS;
      const segmentFront =
        (this._scanRingDepth[point] + this._scanRingDepth[next]) *
          0.5 >=
        0;
      if (segmentFront !== front) continue;
      ctx.moveTo(this._scanRingX[point], this._scanRingY[point]);
      ctx.lineTo(this._scanRingX[next], this._scanRingY[next]);
      hasSegments = true;
    }
    if (!hasSegments) return;

    ctx.lineCap = "round";
    ctx.strokeStyle = O_STYLES[front ? 4 : 2];
    ctx.shadowColor = O_STYLES[front ? 9 : 5];
    ctx.shadowBlur = front ? 7 : 4;
    ctx.lineWidth = front ? 3.2 : 2.4;
    ctx.stroke();
    ctx.strokeStyle = HL_STYLES[front ? 14 : 7];
    ctx.lineWidth = front ? 0.85 : 0.65;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineCap = "butt";
  }

  _drawMoonLightPass(front, time, silhouetteRadius) {
    for (let i = 0; i < MOON_COUNT; i++) {
      if ((this._moonDepth[i] >= 0) !== front) continue;
      if (this._moonRuns[i]) {
        this._drawFilament(i, time, silhouetteRadius);
      }
      this._drawMoonLight(i, time);
    }
  }

  _drawFilament(index, time, silhouetteRadius) {
    const ctx = this.ctx;
    const x = this._moonScreenX[index];
    const y = this._moonScreenY[index];
    const length = Math.sqrt(x * x + y * y);
    if (length < 1) return;

    const endX = (x / length) * silhouetteRadius * 0.96;
    const endY = (y / length) * silhouetteRadius * 0.96;
    const normalX = -y / length;
    const normalY = x / length;
    const curl =
      Math.sin(time * 0.9 + index * 1.7) * silhouetteRadius * 0.045;
    const middleX = (x + endX) * 0.5 + normalX * curl;
    const middleY = (y + endY) * 0.5 + normalY * curl;
    const control1X = x * 0.72 + endX * 0.28 + normalX * curl * 1.2;
    const control1Y = y * 0.72 + endY * 0.28 + normalY * curl * 1.2;
    const control2X = x * 0.28 + endX * 0.72 - normalX * curl * 0.45;
    const control2Y = y * 0.28 + endY * 0.72 - normalY * curl * 0.45;
    const pool = MOON_STYLES[index];
    const activity = this._moonActivityMix[index];
    const styleBucket = Math.max(
      7,
      Math.min(
        STYLE_ALPHA_BUCKETS - 1,
        Math.round((0.5 + activity * 0.5) * (STYLE_ALPHA_BUCKETS - 1))
      )
    );

    ctx.setLineDash(FILAMENT_DASH);
    ctx.lineDashOffset = -time * 6 - index * 3;
    ctx.lineCap = "round";
    ctx.shadowColor = pool[12];
    ctx.shadowBlur = 8 + activity * 6;
    ctx.strokeStyle = pool[5];
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(control1X, control1Y, middleX, middleY);
    ctx.quadraticCurveTo(control2X, control2Y, endX, endY);
    ctx.stroke();
    ctx.strokeStyle = pool[styleBucket];
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineCap = "butt";
    ctx.setLineDash(SOLID_LINE);
    ctx.lineDashOffset = 0;
  }

  _drawMoonLight(index, time) {
    const ctx = this.ctx;
    const x = this._moonScreenX[index];
    const y = this._moonScreenY[index];
    const perspective = this._moonScale[index];
    const activity = this._moonActivityMix[index];
    const pool = MOON_STYLES[index];
    const settle = this._moonSettleMix[index];
    const flashPool = this._moonSettleOk[index] ? OK_STYLES : ERR_STYLES;
    const drawPool = settle > 0 ? flashPool : pool;
    const alphaBucket = this._moonAlphaBucket[index];
    const radius = this._moonVisualRadius[index];

    const glowSize = radius * 8;
    const glowSprite =
      settle > 0
        ? this._settleGlowSprites[this._moonSettleOk[index]]
        : this._moonGlowSprites[index];
    ctx.globalAlpha =
      this._sceneAlpha * (0.42 + activity * 0.32 + settle * 0.24);
    ctx.drawImage(
      glowSprite,
      x - glowSize * 0.5,
      y - glowSize * 0.5,
      glowSize,
      glowSize
    );
    ctx.globalAlpha = this._sceneAlpha;
    ctx.fillStyle = drawPool[alphaBucket];
    ctx.shadowColor = drawPool[Math.max(8, alphaBucket)];
    ctx.shadowBlur = (4 + activity * 9 + settle * 8) * perspective;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (this._moonRuns[index]) {
      const ringRadius =
        radius + 3.5 + Math.sin(time * 3.2 + index) * 0.7;
      const spin = time * 3.4 + index * 0.77;
      ctx.strokeStyle = pool[15];
      ctx.shadowColor = pool[12];
      ctx.shadowBlur = 6 + activity * 5;
      ctx.lineWidth = 1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(
        x + Math.cos(spin) * ringRadius,
        y + Math.sin(spin) * ringRadius
      );
      ctx.arc(x, y, ringRadius, spin, spin + 1.15);
      ctx.moveTo(
        x + Math.cos(spin + 2.08) * ringRadius,
        y + Math.sin(spin + 2.08) * ringRadius
      );
      ctx.arc(x, y, ringRadius, spin + 2.08, spin + 3.2);
      ctx.moveTo(
        x + Math.cos(spin + 4.16) * ringRadius,
        y + Math.sin(spin + 4.16) * ringRadius
      );
      ctx.arc(x, y, ringRadius, spin + 4.16, spin + 5.3);
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.shadowBlur = 0;
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
    const labelAlpha = Math.min(1, 0.5 + activity * 0.5 + settle * 0.3);
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


  // Idle tethers: every labeled node stays visibly attached to the sphere —
  // a 1px curved line plus a small bright pulse traveling node→sphere every
  // 4-6s, staggered per node so the sky never beats in unison.

  // Layer 3: the plexus — clustered node web with propagating flares.
  _drawPlexus(time, R) {
    const ctx = this.ctx;
    const yc = this._fYawCos, ys = this._fYawSin, pc = this._fPitchCos, ps = this._fPitchSin;
    const N = this._plexSize.length;
    for (let i = 0; i < N; i++) {
      const x = this._plexBase[i * 3], y = this._plexBase[i * 3 + 1], z = this._plexBase[i * 3 + 2];
      const cx = x * yc + z * ys, cz = -x * ys + z * yc;
      const cy = y * pc - cz * ps, depth = y * ps + cz * pc;
      const persp = CAM_DISTANCE / (CAM_DISTANCE - depth);
      this._plexSX[i] = cx * R * persp;
      this._plexSY[i] = -cy * R * persp;
      this._plexDepth[i] = depth;
    }
    // flare scheduling: one random node every 2-4s, 300ms propagation
    if (!this.reduced && time >= this._nextFlareAt) {
      this._flareNode = Math.floor(hashUnit(Math.floor(time * 7) + 917) * N);
      this._flareAt = time;
      this._nextFlareAt = time + 2 + hashUnit(Math.floor(time * 13) + 311) * 2;
    }
    const flareK = this._flareNode >= 0 ? Math.max(0, 1 - (time - this._flareAt) / 0.3) : 0;
    ctx.lineWidth = 1;
    for (let edge = 0; edge < this._plexEdges.length; edge++) {
      const key = this._plexEdges[edge];
      const a = Math.floor(key / 1000), b = key % 1000;
      const front = (this._plexDepth[a] + this._plexDepth[b]) / 2 > 0;
      let alpha = front ? 0.38 : 0.11;
      if (flareK > 0 && (a === this._flareNode || b === this._flareNode)) alpha = Math.min(0.82, alpha + flareK * 0.44);
      const alphaBucket = Math.max(
        1,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(alpha * (STYLE_ALPHA_BUCKETS - 1))
        )
      );
      ctx.strokeStyle = B_STYLES[alphaBucket];
      ctx.beginPath();
      ctx.moveTo(this._plexSX[a], this._plexSY[a]);
      ctx.lineTo(this._plexSX[b], this._plexSY[b]);
      ctx.stroke();
    }
    for (let i = 0; i < N; i++) {
      const front = this._plexDepth[i] > 0;
      const size = this._plexSize[i] * (front ? 1 : 0.7);
      let alpha = front ? 0.78 : 0.32;
      if (flareK > 0 && (i === this._flareNode || this._plexAdj[this._flareNode].includes(i)))
        alpha = Math.min(1, alpha + flareK);
      if (size > 1.8) {
        const g = size * 5.4;
        ctx.globalAlpha = this._sceneAlpha * alpha * 0.36;
        ctx.drawImage(this._highlightGlow, this._plexSX[i] - g / 2, this._plexSY[i] - g / 2, g, g);
        ctx.globalAlpha = this._sceneAlpha;
      }
      const alphaBucket = Math.max(
        1,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(alpha * (STYLE_ALPHA_BUCKETS - 1))
        )
      );
      ctx.fillStyle = HL_STYLES[alphaBucket];
      ctx.beginPath(); ctx.arc(this._plexSX[i], this._plexSY[i], size * 0.75, 0, TAU); ctx.fill();
    }
  }

  // Layer 4: ambient particles rising from the base ring, despawning above.
  _drawAmbientRise(time, R) {
    if (this.reduced) return;
    const ctx = this.ctx;
    for (let i = 0; i < this._ambPhase.length; i++) {
      const k = (this._ambPhase[i] + time * this._ambSpeed[i]) % 1;
      const y = R * 1.05 - k * R * 2.3;
      const sway = Math.sin(time * 0.6 + i) * R * 0.08;
      const x = Math.cos(this._ambAngle[i]) * R * (0.55 + 0.35 * Math.sin(i)) + sway;
      const fade = Math.sin(k * Math.PI);
      const alphaBucket = Math.max(
        1,
        Math.min(
          STYLE_ALPHA_BUCKETS - 1,
          Math.round(0.3 * fade * (STYLE_ALPHA_BUCKETS - 1))
        )
      );
      ctx.fillStyle = B_STYLES[alphaBucket];
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, TAU); ctx.fill();
    }
  }

  // The projector: floor glow, three concentric rings, and the light beam.
  _drawProjectorBase(time, R) {
    const ctx = this.ctx;
    const baseY = R * 1.14;
    const pulse = this.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(time * (TAU / 5) + Math.PI);
    ctx.globalAlpha = this._sceneAlpha;
    ctx.drawImage(
      this._projectorFloor,
      -R * 1.1,
      baseY - R * 0.3,
      R * 2.2,
      R * 0.6
    );
    // three rings, brightest inner, inner one pulsing off the core's beat
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = B_STYLES[Math.round((0.6 + 0.25 * pulse) * 15)];
    ctx.beginPath();
    ctx.ellipse(0, baseY, R * 0.72, R * 0.1728, 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = B_STYLES[5];
    ctx.beginPath();
    ctx.ellipse(0, baseY, R * 0.96, R * 0.2304, 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = B_STYLES[3];
    ctx.beginPath();
    ctx.ellipse(0, baseY, R * 1.2, R * 0.288, 0, 0, TAU);
    ctx.stroke();
    // vertical beam: cached gradient from base ring to globe underside
    ctx.drawImage(
      this._projectorBeam,
      -R * 0.62,
      R * 0.55,
      R * 1.24,
      baseY - R * 0.55
    );
  }


  // Opaque planet body: dark navy disc with spherical edge shading, then a
  // crisp glowing rim and a soft atmosphere annulus. Drawn source-over so it
  // occludes back-hemisphere content and the room behind the globe.
  _drawSolidBody(R) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    const body = ctx.createRadialGradient(-R * 0.25, -R * 0.3, R * 0.1, 0, 0, R);
    body.addColorStop(0, "rgba(16,34,58,0.99)");
    body.addColorStop(0.62, "rgba(9,20,38,0.99)");
    body.addColorStop(0.92, "rgba(5,12,26,0.99)");
    body.addColorStop(1, "rgba(10,26,46,0.99)");
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(120,220,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(34,211,238,0.9)"; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
    ctx.shadowBlur = 0;
    const atmo = ctx.createRadialGradient(0, 0, R * 0.97, 0, 0, R * 1.12);
    atmo.addColorStop(0, "rgba(34,211,238,0.16)");
    atmo.addColorStop(1, "rgba(34,211,238,0)");
    ctx.fillStyle = atmo;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.12, 0, TAU); ctx.fill();
  }

  _drawMoonTethers(time, silhouetteRadius) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1;
    for (let i = 0; i < MOON_COUNT; i++) {
      const mx = this._moonScreenX[i], my = this._moonScreenY[i];
      const len = Math.hypot(mx, my) || 1;
      if (len <= silhouetteRadius * 1.02) continue;
      const ex = (mx / len) * silhouetteRadius, ey = (my / len) * silhouetteRadius;
      const midx = (mx + ex) / 2 - (my - ey) * 0.12;
      const midy = (my + ey) / 2 + (mx - ex) * 0.12;
      ctx.strokeStyle = "rgba(34,211,238,0.3)";
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.quadraticCurveTo(midx, midy, ex, ey); ctx.stroke();
      if (!this.reduced) {
        const period = 4 + (i % 3);
        const phase = ((time / period) + i * 0.618) % 1;
        const t1 = phase, u = 1 - t1;
        const px = u * u * mx + 2 * u * t1 * midx + t1 * t1 * ex;
        const py = u * u * my + 2 * u * t1 * midy + t1 * t1 * ey;
        ctx.fillStyle = "rgba(214,248,255,0.9)";
        ctx.shadowColor = "rgba(34,211,238,0.9)"; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(px, py, 1.6, 0, TAU); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalCompositeOperation = "source-over";
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
