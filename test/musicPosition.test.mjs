// The bed must keep PLAYING across a navigation, not start over.
//
// index.html, brain.html and about.html are three separate documents. Moving
// between them tears the <audio> element down and builds a new one, so the
// track restarted from zero every single time — the "continuity" the old
// comment claimed was only "music is also on over here", never "the same
// performance continues". This locks in the real thing: position survives the
// document, and the gap the navigation itself took is accounted for.
//
// Run: node --test test/musicPosition.test.mjs
import assert from "node:assert";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resumeTimeFrom,
  MUSIC_POSITION_KEY,
  NAVIGATION_GRACE_MS
} from "../public/musicPosition.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/* ---------------- the pure resume arithmetic ---------------- */

test("nothing remembered means start at the beginning", () => {
  assert.equal(resumeTimeFrom(null, 1000, 120), 0);
  assert.equal(resumeTimeFrom(undefined, 1000, 120), 0);
  assert.equal(resumeTimeFrom({}, 1000, 120), 0);
});

test("a navigation resumes where it left off, plus the time the load took", () => {
  // The whole point: 30s in, the new page takes 200ms to boot, so the bed
  // picks up at 30.2s — musically continuous, not rewound and not repeated.
  const at = 1_000_000;
  assert.ok(Math.abs(resumeTimeFrom({ t: 30, at }, at + 200, 120) - 30.2) < 1e-9);
});

test("the track wraps rather than seeking past its own end", () => {
  // It loops. 118s into a 120s track plus a 5s gap is 3s, not 123s — which
  // would be an invalid seek and would silently drop the bed.
  const at = 1_000_000;
  const got = resumeTimeFrom({ t: 118, at }, at + 5000, 120, 5000);
  assert.ok(Math.abs(got - 3) < 1e-9, `expected 3, got ${got}`);
});

test("a long absence resumes where it stopped instead of jumping forward", () => {
  // A navigation is milliseconds. An hour means the app was closed or
  // backgrounded, and advancing the position by an hour is meaningless —
  // it would land somewhere arbitrary. The advance is capped.
  const at = 1_000_000;
  const got = resumeTimeFrom({ t: 30, at }, at + 3_600_000, 600);
  assert.equal(got, 30 + NAVIGATION_GRACE_MS / 1000);
});

test("a clock that jumped backwards never rewinds the track", () => {
  const at = 1_000_000;
  assert.equal(resumeTimeFrom({ t: 30, at }, at - 60_000, 120), 30);
});

test("corrupt stored state is ignored, not propagated as NaN", () => {
  // A NaN currentTime assignment throws in the browser and kills the bed.
  for (const junk of [{ t: "abc", at: 1 }, { t: -5, at: 1 }, { t: Infinity, at: 1 }]) {
    assert.equal(resumeTimeFrom(junk, 2, 120), 0, `junk ${JSON.stringify(junk)} must fall back to 0`);
  }
});

test("an unknown duration still resumes — it just cannot wrap", () => {
  // duration is NaN until metadata loads. Resuming is still correct.
  const at = 1_000_000;
  assert.ok(Math.abs(resumeTimeFrom({ t: 42, at }, at + 100, NaN) - 42.1) < 1e-9);
});

/* ---------------- the shipped module, driven end to end ---------------- */

/** Turn an ES module into script source a classic vm context can run. */
function stripModuleSyntax(src) {
  const out = src
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/^export\s+(const|function|let)\b/gm, "$1");
  assert.ok(!/^\s*(import|export)\b/m.test(out), "module syntax must be fully stripped");
  return out;
}

/**
 * Boot the real public/pageMusic.js against fakes, with a session store that
 * survives the "navigation" the way sessionStorage does in one tab.
 */
async function bootPage({ store, savedAt = 0, now = 0, metadataReady = true } = {}) {
  const clock = { now };
  const intervals = new Set();
  const listeners = new Map();
  const audioListeners = new Map();

  const audio = {
    volume: 0,
    loop: false,
    paused: false,
    currentTime: 0,
    duration: metadataReady ? 120 : NaN,
    readyState: metadataReady ? 1 : 0,
    play: () => Promise.resolve(),
    addEventListener: (type, fn) => {
      if (!audioListeners.has(type)) audioListeners.set(type, []);
      audioListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = audioListeners.get(type);
      if (list) audioListeners.set(type, list.filter((f) => f !== fn));
    }
  };

  const sandbox = {
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: store,
    fetch: () => Promise.resolve({ ok: true }),
    Audio: function () { return audio; },
    performance: { now: () => clock.now },
    Date: { now: () => clock.now },
    setInterval: (fn) => { const h = { fn }; intervals.add(h); return h; },
    clearInterval: (h) => { intervals.delete(h); },
    document: { addEventListener: () => {}, visibilityState: "visible" },
    console
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };

  vm.createContext(sandbox);
  // Levels are plain constants, so injecting them is faithful. musicPosition
  // is NOT: it reads window.sessionStorage, and a copy imported into Node sees
  // Node's globals, where window is undefined — it would quietly do nothing and
  // the test would pass against a no-op. So the real file is RUN IN THE SANDBOX,
  // where window is the same window pageMusic.js sees, exactly as in a browser.
  const levels = await import("../public/musicLevels.js");
  Object.assign(sandbox, levels);
  vm.runInContext(stripModuleSyntax(read("public/musicPosition.js")), sandbox);

  const source = read("public/pageMusic.js").replace(/^import[^;]+;\s*/gm, "");
  assert.ok(!/^import/m.test(source), "the import shim must remove every import");
  vm.runInContext(source, sandbox);
  await new Promise((r) => setImmediate(r)); // let the HEAD probe settle

  return {
    audio,
    /** Metadata arriving is what makes a seek legal. */
    loadMetadata() {
      audio.readyState = 1;
      audio.duration = 120;
      for (const fn of audioListeners.get("loadedmetadata") || []) fn();
    },
    /** The browser tearing this document down on a navigation. */
    navigateAway() {
      for (const fn of listeners.get("pagehide") || []) fn();
    },
    advance(ms) { clock.now += ms; }
  };
}

/** A sessionStorage that behaves like the real one across documents. */
function sessionStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  };
}

test("leaving a page records where the track had got to", async () => {
  const store = sessionStore();
  const page = await bootPage({ store });
  page.audio.currentTime = 47.5;
  page.navigateAway();

  const saved = JSON.parse(store.getItem(MUSIC_POSITION_KEY));
  assert.ok(Math.abs(saved.t - 47.5) < 1e-9, `expected 47.5 recorded, got ${saved.t}`);
});

test("the next page picks the track up instead of restarting it", async () => {
  // The actual bug, end to end: dashboard → brain must not rewind to zero.
  const store = sessionStore();

  const dashboard = await bootPage({ store, now: 500_000 });
  dashboard.audio.currentTime = 47.5;
  dashboard.navigateAway();

  const brain = await bootPage({ store, now: 500_200 }); // 200ms to load
  brain.loadMetadata();
  assert.ok(
    Math.abs(brain.audio.currentTime - 47.7) < 1e-6,
    `expected the bed to resume near 47.7s, got ${brain.audio.currentTime}`
  );
  assert.notEqual(brain.audio.currentTime, 0, "this is the regression: back to the top");
});

test("a first visit with nothing remembered still starts at the beginning", async () => {
  const brain = await bootPage({ store: sessionStore() });
  brain.loadMetadata();
  assert.equal(brain.audio.currentTime, 0);
});

test("the seek waits for metadata — seeking before it throws in the browser", async () => {
  const store = sessionStore();
  store.setItem(MUSIC_POSITION_KEY, JSON.stringify({ t: 30, at: 0 }));

  const page = await bootPage({ store, now: 0, metadataReady: false });
  assert.equal(page.audio.currentTime, 0, "must not seek while duration is unknown");
  page.loadMetadata();
  assert.ok(page.audio.currentTime >= 30, "and must seek once metadata lands");
});

test("both music owners share ONE position module — no second copy to drift", () => {
  // Exactly the reason musicLevels.js exists: the bed was two copies of 0.42.
  // Position must not repeat that mistake.
  for (const name of ["cockpit.js", "pageMusic.js"]) {
    const src = read("public/" + name);
    assert.match(src, /from "\.\/musicPosition\.js"/, `${name} must import the shared position memory`);
    assert.match(src, /rememberPosition\(/, `${name} must actually attach it to its element`);
  }
});

test("position is session-scoped, so a fresh launch still opens from the top", () => {
  // localStorage would resume mid-track days later, which is not what an intro
  // is for. sessionStorage survives navigation and dies with the window.
  const src = read("public/musicPosition.js");
  assert.match(src, /sessionStorage/, "position lives in sessionStorage");
  assert.doesNotMatch(
    src.replace(/^\s*\/\/.*$/gm, ""),
    /localStorage/,
    "position must not leak into localStorage, which outlives the launch"
  );
});
