// Background music must get out of the way when Artemis talks.
//
// This runs the REAL public/pageMusic.js inside a vm sandbox with a fake clock
// and a fake <audio>, because that page (about.html) has no cockpit HUD — the
// bug this locks in was that ducking lived only in cockpit.js, so on about.html
// she talked over a full-volume track. Driving the shipped file rather than a
// copy of its logic is the point: a reimplementation would pass forever.
//
// Run: node --test test/musicDuck.test.mjs
import assert from "node:assert";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// Levels are read from the shipped module, so the test asserts the REAL
// contract instead of a copy that could silently drift from it.
import {
  BACKGROUND_MUSIC_GAIN,
  BACKGROUND_MUSIC_DUCK_GAIN,
  musicGainFor,
  musicRampMs
} from "../public/musicLevels.js";

const FULL = BACKGROUND_MUSIC_GAIN;
const DUCKED = BACKGROUND_MUSIC_DUCK_GAIN;

/** Boot pageMusic.js against fakes; returns handles to drive time and events. */
async function bootPageMusic({ stored = null, fileExists = true } = {}) {
  let now = 0;
  const intervals = new Set();
  const listeners = new Map();
  const audio = { volume: 0, loop: false, paused: false, play: () => Promise.resolve() };

  const sandbox = {
    localStorage: { getItem: () => stored },
    fetch: () => Promise.resolve({ ok: fileExists }),
    Audio: function () { return audio; },
    performance: { now: () => now },
    setInterval: (fn) => { const h = { fn }; intervals.add(h); return h; },
    clearInterval: (h) => { intervals.delete(h); },
    console,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  // pageMusic.js imports its levels; the sandbox is a classic context, so the
  // import line is swapped for the same bindings injected directly. The rest of
  // the shipped file — the file this test exists to drive — runs untouched.
  sandbox.musicGainFor = musicGainFor;
  sandbox.musicRampMs = musicRampMs;
  sandbox.BACKGROUND_MUSIC_GAIN = BACKGROUND_MUSIC_GAIN;
  vm.createContext(sandbox);
  // pageMusic.js also imports the shared position memory. Run the real file in
  // the same sandbox rather than stubbing it: with no sessionStorage here it
  // correctly degrades to a no-op, which is exactly the behaviour this suite
  // wants — ducking must not depend on position memory being available.
  vm.runInContext(
    read("public/musicPosition.js")
      .replace(/^import[^;]+;\s*/gm, "")
      .replace(/^export\s+(const|function|let)\b/gm, "$1"),
    sandbox
  );
  // /g matters: there is more than one import line now, and stripping only the
  // first left an `import` statement that a classic context cannot parse.
  const source = read("public/pageMusic.js").replace(/^import[^;]+;\s*/gm, "");
  assert.ok(!/^import/m.test(source), "the import shim must remove every import");
  vm.runInContext(source, sandbox);
  await new Promise((r) => setImmediate(r)); // let the HEAD probe settle

  return {
    audio,
    sandbox,
    /** Fire the voice-state broadcast main.js emits. */
    say(stateName) {
      for (const fn of listeners.get("artemis-voice-state") || []) fn({ detail: stateName });
    },
    /** Advance the fake clock and run every pending fade tick. */
    advance(ms) {
      now += ms;
      for (const h of [...intervals]) h.fn();
    },
  };
}

test("the bed ducks under her voice on a page with no cockpit HUD", async () => {
  const m = await bootPageMusic();
  assert.strictEqual(m.audio.volume, FULL, "starts at full volume");

  m.say("speaking");
  m.advance(1000); // well past the fade
  assert.ok(
    Math.abs(m.audio.volume - DUCKED) < 1e-6,
    `expected ${DUCKED} while speaking, got ${m.audio.volume}`
  );
});

test("the bed comes back up when she stops", async () => {
  const m = await bootPageMusic();
  m.say("speaking");
  m.advance(1000);
  m.say("idle");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6, `expected ${FULL} when idle, got ${m.audio.volume}`);
});

test("the duck ramps rather than jumping", async () => {
  // A step change in gain clicks and reads as the track dropping out. Halfway
  // through the fade the volume must be strictly between the two levels.
  const m = await bootPageMusic();
  m.say("speaking");
  m.advance(90); // fade down is 180ms
  assert.ok(
    m.audio.volume < FULL && m.audio.volume > DUCKED,
    `expected an intermediate level mid-fade, got ${m.audio.volume}`
  );
});

test("wake-armed listening must NOT duck", async () => {
  // The bug this exists to prevent: restoreWakeListening() parks the orb in
  // "listening" between turns whenever the wake word is armed, so that IS the
  // resting state. Ducking it pinned the bed at the quiet level permanently —
  // she spoke at the same volume the music was already playing at, and the
  // whole effect was inaudible. Only her voice may duck the bed.
  const m = await bootPageMusic();
  m.say("listening");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6, `listening must stay at ${FULL}, got ${m.audio.volume}`);
});

test("thinking must not duck either — she isn't talking yet", async () => {
  const m = await bootPageMusic();
  m.say("thinking");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6, `thinking must stay at ${FULL}, got ${m.audio.volume}`);
});

test("the duck repeats across a realistic multi-turn conversation", async () => {
  // What the user actually asked for: down every time she talks, back up every
  // time she stops, turn after turn — through the real state sequence the app
  // emits, not just an isolated speaking/idle pair.
  const m = await bootPageMusic();
  const at = () => Number(m.audio.volume.toFixed(6));
  const full = Number(FULL.toFixed(6));
  const ducked = Number((DUCKED).toFixed(6));

  for (let turn = 1; turn <= 3; turn++) {
    m.say("listening"); m.advance(1000);
    assert.strictEqual(at(), full, `turn ${turn}: armed and waiting → full`);

    m.say("thinking"); m.advance(1000);
    assert.strictEqual(at(), full, `turn ${turn}: thinking → still full`);

    m.say("speaking"); m.advance(1000);
    assert.strictEqual(at(), ducked, `turn ${turn}: she's talking → ducked`);

    m.say("listening"); m.advance(1000);
    assert.strictEqual(at(), full, `turn ${turn}: she stopped → back to full`);
  }
});

test("a multi-sentence reply stays ducked throughout", async () => {
  // pumpTts() re-emits "speaking" per sentence. The bed must not pump back up
  // between clips — it should sit at the ducked level until she is done.
  const m = await bootPageMusic();
  m.say("speaking"); m.advance(1000);
  m.say("speaking"); m.advance(60);
  m.say("speaking"); m.advance(60);
  assert.ok(
    Math.abs(m.audio.volume - DUCKED) < 1e-6,
    `expected a steady ${DUCKED} across sentences, got ${m.audio.volume}`
  );
});

test("an explicit OFF still means off — ducking must not resurrect the bed", async () => {
  const m = await bootPageMusic({ stored: "0" });
  assert.strictEqual(m.audio.volume, 0, "the module must return before touching audio");
});

test("both modules read the levels from ONE source, with no local copies", () => {
  // Stronger than "the two constants agree": there is now nothing to disagree.
  // A hard-coded gain reappearing in either file is the regression.
  const cockpit = read("public/cockpit.js");
  const page = read("public/pageMusic.js");
  for (const [name, src] of [["cockpit.js", cockpit], ["pageMusic.js", page]]) {
    assert.match(src, /from "\.\/musicLevels\.js"/, `${name} must import the shared levels`);
    assert.doesNotMatch(src, /const FULL = [\d.]+/, `${name} must not re-declare a numeric level`);
    assert.doesNotMatch(src, /const DUCK(ED)? = [\d.]+/, `${name} must not re-declare a numeric duck level`);
  }
});

test("the levels are quiet enough for speech to dominate", () => {
  // The bug: the bed sat at 0.42 and she had to fight it. These are absolute
  // gains, so the numbers here are exactly what a listener hears.
  assert.ok(BACKGROUND_MUSIC_GAIN >= 0.15 && BACKGROUND_MUSIC_GAIN <= 0.20,
    `resting bed should sit in 0.15–0.20, got ${BACKGROUND_MUSIC_GAIN}`);
  assert.ok(DUCKED >= 0.03 && DUCKED <= 0.05,
    `ducked bed should sit in 0.03–0.05, got ${DUCKED}`);
  assert.ok(DUCKED < BACKGROUND_MUSIC_GAIN / 3, "speech must be unambiguously dominant");
  assert.equal(musicGainFor("speaking"), DUCKED);
  assert.equal(musicGainFor("idle"), BACKGROUND_MUSIC_GAIN);
  assert.equal(musicGainFor("listening"), BACKGROUND_MUSIC_GAIN, "listening is the resting state, not a duck");
  // attack fast, release slow — no pumping between sentences
  assert.ok(musicRampMs("speaking") <= 250 && musicRampMs("speaking") >= 100);
  assert.ok(musicRampMs("idle") >= 500 && musicRampMs("idle") <= 1000);
  assert.ok(musicRampMs("idle") > musicRampMs("speaking"), "release is slower than attack");
});

test("the cockpit ducks on speech only — the state the daily driver runs in", () => {
  // cockpit.js is an ES module wired into a live DOM, so it can't be booted in
  // a sandbox the way pageMusic.js can. This asserts the one line that carries
  // the regression: the level decision must come from the shared function, and
  // "listening" must never appear in it. If it creeps back, the bed pins quiet.
  const cockpit = read("public/cockpit.js");
  const fn = cockpit.match(/function levelFor\(s\) \{([\s\S]*?)\}/);
  assert.ok(fn, "levelFor() not found in cockpit.js");
  assert.match(fn[1], /musicGainFor\(s\)/, "the cockpit defers to the shared mapping");
  assert.doesNotMatch(fn[1], /listening/, 'levelFor() must not duck on "listening" — that is the resting state');
  // the startup path must open AT the resting level, never loud-then-drop
  assert.match(cockpit, /el\.volume = FULL;/, "the element is created at the resting gain");
  assert.match(cockpit, /el\.volume = levelFor\(document\.body\.dataset\.aiState\);/,
    "play() opens at the level the CURRENT state calls for");
});

test("main.js broadcasts the voice state outside the HUD", () => {
  // pageMusic listens for this event; hud() is a no-op on about.html, so the
  // broadcast is the only way the state reaches the bed there.
  const main = read("public/main.js");
  assert.match(main, /dispatchEvent\(new CustomEvent\("artemis-voice-state"/);
});

test("a cancelled or errored speech turn still restores the bed", async () => {
  // TTS can end three ways: finished, cancelled (barge-in / Esc), or failed.
  // main.js leaves the voice state at idle in every one of them, so the bed
  // must come back up in every one of them — silence over a ducked track is
  // the failure this guards.
  for (const ending of ["idle", "error"]) {
    const m = await bootPageMusic();
    m.say("speaking");
    m.advance(1000);
    assert.ok(Math.abs(m.audio.volume - DUCKED) < 1e-6, "ducked while speaking");
    m.say(ending);
    m.advance(2000);
    assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6,
      `after "${ending}" the bed must return to ${FULL}, got ${m.audio.volume}`);
  }
});

test("a new turn starting mid-release does not stack or drift the gain", async () => {
  // Interrupting the release with a fresh duck used to be the classic way to
  // leave two ramps fighting. The exact end level after several interleaved
  // turns must still be the two known values, not something in between.
  const m = await bootPageMusic();
  for (let i = 0; i < 4; i += 1) {
    m.say("speaking");
    m.advance(60);            // interrupt the attack
    m.say("idle");
    m.advance(120);           // interrupt the release
    m.say("speaking");
    m.advance(1000);
    assert.ok(Math.abs(m.audio.volume - DUCKED) < 1e-6,
      `turn ${i + 1}: ducked level must be exact, got ${m.audio.volume}`);
    m.say("idle");
    m.advance(2000);
    assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6,
      `turn ${i + 1}: resting level must be exact, got ${m.audio.volume}`);
  }
});

test("ducking never starts a bed the user turned off", async () => {
  // "artemisMusic" === "0" means the module returns before creating any audio;
  // and a paused element is left alone. Speech must not resurrect either.
  const off = await bootPageMusic({ stored: "0" });
  off.say("speaking");
  off.advance(1000);
  assert.strictEqual(off.audio.volume, 0, "no audio object was ever driven");

  const paused = await bootPageMusic();
  paused.audio.paused = true;
  const before = paused.audio.volume;
  paused.say("speaking");
  paused.advance(1000);
  assert.strictEqual(paused.audio.volume, before, "a paused bed is not touched by ducking");
});

test("startup opens AT the resting level — never loud, then dropped", async () => {
  const m = await bootPageMusic();
  assert.strictEqual(m.audio.volume, FULL, "the very first assignment is the resting gain");
  assert.ok(m.audio.volume <= 0.20, "and it is the new quiet level, not the old 0.42");
});

test("the capture state ducks the bed — armed listening does not", async () => {
  // The distinction that makes a listening duck possible at all: "listening"
  // is the resting state while the wake word is armed, so it stays full;
  // "capturing" is the bounded moment after the wake word fired.
  const m = await bootPageMusic();
  m.say("listening");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6, "armed listening stays at the resting level");
  m.say("capturing");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - 0.09) < 1e-6, `capture should duck to 0.09, got ${m.audio.volume}`);
  m.say("speaking");
  m.advance(1000);
  assert.ok(Math.abs(m.audio.volume - DUCKED) < 1e-6, "speech ducks deeper than capture");
  m.say("listening");
  m.advance(2000);
  assert.ok(Math.abs(m.audio.volume - FULL) < 1e-6, "and it all comes back");
});

test("the shutdown fade is defined and ends in silence", async () => {
  const { SHUTDOWN_FADE_MS } = await import("../public/musicLevels.js");
  assert.ok(SHUTDOWN_FADE_MS > 0 && SHUTDOWN_FADE_MS <= 1000, "a fade, not a cut");
  const cockpit = read("public/cockpit.js");
  assert.match(cockpit, /function fadeOut\(\)/, "the music module exposes a shutdown fade");
  assert.match(cockpit, /fadeTo\(0, SHUTDOWN_FADE_MS\)/, "it fades to zero over the shared duration");
});
