// Where the background bed had got to — ONE definition, shared by every page
// that plays it.
//
// index.html, brain.html and about.html are three separate documents. A click
// between them destroys the <audio> element and the next page builds a fresh
// one, which starts at zero. So the track restarted every single navigation:
// you never heard past the opening bars. Nothing was wrong with the playback
// code — the position simply had nowhere to live that outlived the document.
//
// It lives in sessionStorage on purpose. That survives navigation inside one
// window and dies with it, so moving between pages continues the track while a
// genuinely fresh launch still opens from the top — which is what an intro is
// for. localStorage would resume you mid-track days later.
//
// Pure arithmetic up top so the resume maths is unit-testable with no DOM
// (test/musicPosition.test.mjs).

/** sessionStorage key holding {t: seconds, at: epoch-ms}. */
export const MUSIC_POSITION_KEY = "artemisMusicPos";

/**
 * How much wall-clock time a resume may add to the saved position.
 *
 * A navigation costs milliseconds, and adding them back is what makes the
 * seam inaudible. But the same record survives the window being hidden for an
 * hour, and advancing an hour would land somewhere arbitrary — so the advance
 * is capped and a long absence simply picks up where it stopped.
 */
export const NAVIGATION_GRACE_MS = 5000;

/** Keep a seek inside the track. It loops, so past the end means back round. */
function wrap(seconds, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return seconds;
  return ((seconds % duration) + duration) % duration;
}

/**
 * The position a newly-built element should open at.
 *
 * @param {{t: number, at: number}|null} saved  what the previous document left
 * @param {number} nowMs                        epoch ms, now
 * @param {number} duration                     track length; NaN before metadata
 * @param {number} [graceMs]
 * @returns {number} seconds — always finite, always inside the track
 */
export function resumeTimeFrom(saved, nowMs, duration, graceMs = NAVIGATION_GRACE_MS) {
  if (!saved || typeof saved !== "object") return 0;
  const t = Number(saved.t);
  // A NaN or negative currentTime assignment throws in the browser and takes
  // the bed down with it, so corrupt state falls back to the top of the track.
  if (!Number.isFinite(t) || t < 0) return 0;

  const at = Number(saved.at);
  if (!Number.isFinite(at)) return wrap(t, duration);

  // Never negative: a clock that jumped backwards must not rewind the music.
  const gap = Math.min(Math.max(nowMs - at, 0), graceMs);
  return wrap(t + gap / 1000, duration);
}

/** sessionStorage, or null where it is unavailable (private mode throws). */
function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch (e) {
    return null;
  }
}

/**
 * Give an <audio> element a memory that outlives its document: it opens where
 * the last page stopped, and records its own position as it plays.
 *
 * Safe to call before the file has loaded — the seek waits for metadata,
 * because seeking while duration is unknown throws.
 *
 * @param {HTMLAudioElement} el
 * @param {{storage?: Storage, now?: () => number, key?: string}} [opts]
 * @returns {{save: () => void}} save() is exposed for shutdown paths.
 */
export function rememberPosition(el, opts = {}) {
  const store = opts.storage !== undefined ? opts.storage : defaultStorage();
  const now = opts.now || (() => Date.now());
  const key = opts.key || MUSIC_POSITION_KEY;
  const noop = { save() {} };
  if (!el || !store) return noop;

  let saved = null;
  try {
    const raw = store.getItem(key);
    if (raw) saved = JSON.parse(raw);
  } catch (e) {
    saved = null; // unreadable or malformed — start from the top, don't crash
  }

  // A seek is not honoured just because metadata arrived: the browser also
  // needs the target to be inside a seekable range, and that can lag by a beat.
  // A refused seek leaves currentTime where it was, so the attempt reports
  // whether it actually took and is retried on the next readiness event.
  function seek() {
    const target = resumeTimeFrom(saved, now(), el.duration);
    // Below a twitch, seeking is pointless and can stutter the start.
    if (target <= 0.05) return true;
    try { el.currentTime = target; } catch (e) { return false; }
    return Math.abs(Number(el.currentTime) - target) < 1;
  }

  if (typeof el.addEventListener === "function") {
    // HAVE_METADATA (readyState 1) is the earliest a seek can be legal; canplay
    // and progress are the later points at which one that was refused may land.
    const landed = el.readyState >= 1 && seek();
    if (!landed) {
      const retry = () => {
        if (!seek()) return;
        for (const ev of ["loadedmetadata", "canplay", "progress"]) el.removeEventListener(ev, retry);
      };
      for (const ev of ["loadedmetadata", "canplay", "progress"]) el.addEventListener(ev, retry);
    }
  } else if (el.readyState >= 1) {
    seek();
  }

  function save() {
    const t = Number(el.currentTime);
    if (!Number.isFinite(t) || t < 0) return;
    try {
      store.setItem(key, JSON.stringify({ t, at: now() }));
    } catch (e) { /* quota or private mode — losing the position is survivable */ }
  }

  // pagehide is the navigation itself. visibilitychange covers the app being
  // backgrounded, and the throttled timeupdate means an abrupt kill costs at
  // most a second rather than the whole position.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", save);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") save();
    });
  }
  if (typeof el.addEventListener === "function") {
    let lastSave = 0;
    el.addEventListener("timeupdate", () => {
      const ms = now();
      if (ms - lastSave < 1000) return;
      lastSave = ms;
      save();
    });
  }

  return { save };
}
