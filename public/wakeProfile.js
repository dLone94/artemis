// Which wake word is running, and whether it can be trusted.
//
// The phrase, the classifier, its threshold and its display text used to be
// hardcoded in six places. Nothing tied them together, so a half-finished change
// could leave the UI saying "Hey Artemis" while the engine loaded the Jarvis
// model — the status would be confidently wrong and the user would just think
// she'd stopped listening.
//
// Now one profile drives all of it, and it is only accepted if every asset it
// names matches the hash it declares. A tampered, truncated or half-deployed
// model does not load: it falls back to the known-good Jarvis profile BEFORE any
// recognition starts. Failing back to a wake word that works beats failing
// forward into one that might not.

// The floor. Compiled in rather than fetched, so a missing or corrupt manifest
// still leaves a working wake word. These hashes are of the files shipped in
// public/oww/ and verified at load.
export const FALLBACK_PROFILE = Object.freeze({
  id: "hey-jarvis-v0.1",
  phrase: "Hey Jarvis",
  // what the browser's speech recognizer tends to hear instead
  aliasPattern: "(jarvis|jervis|jarvys|gervais)",
  classifierUrl: "/oww/hey_jarvis_v0.1.onnx",
  threshold: 0.5,
  cooldownMs: 2000,
  assets: {
    "/oww/hey_jarvis_v0.1.onnx": "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
    "/oww/melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "/oww/embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f"
  },
  verified: true
});

const MANIFEST_URL = "/oww/manifest.json";

/** Shape check. A profile that fails this is not worth hashing. */
export function validateProfile(p) {
  const errs = [];
  if (!p || typeof p !== "object") return ["profile is not an object"];
  if (!p.id || typeof p.id !== "string") errs.push("missing id");
  if (!p.phrase || typeof p.phrase !== "string") errs.push("missing phrase");
  if (!p.classifierUrl || !String(p.classifierUrl).startsWith("/oww/")) errs.push("classifierUrl must be under /oww/");
  if (typeof p.threshold !== "number" || !(p.threshold > 0 && p.threshold < 1)) errs.push("threshold must be between 0 and 1");
  if (p.cooldownMs != null && (typeof p.cooldownMs !== "number" || p.cooldownMs < 0)) errs.push("cooldownMs must be a non-negative number");
  if (!p.assets || typeof p.assets !== "object") errs.push("missing assets map");
  else {
    if (!p.assets[p.classifierUrl]) errs.push("classifier has no declared hash");
    for (const [url, sha] of Object.entries(p.assets)) {
      if (!String(url).startsWith("/oww/")) errs.push(`asset outside /oww/: ${url}`);
      if (!/^[0-9a-f]{64}$/i.test(String(sha))) errs.push(`bad sha256 for ${url}`);
    }
  }
  const evaluation = p.evaluation;
  if (!evaluation || typeof evaluation !== "object") {
    errs.push("missing release evaluation");
  } else {
    if (evaluation.verdict !== "PASS") errs.push("evaluation verdict is not PASS");
    if (!/^[0-9a-f]{64}$/i.test(String(evaluation.artifactSha256 || ""))) {
      errs.push("evaluation is not bound to an artifact sha256");
    } else if (p.assets && p.assets[p.classifierUrl] &&
               evaluation.artifactSha256.toLowerCase() !== String(p.assets[p.classifierUrl]).toLowerCase()) {
      errs.push("evaluation artifact hash does not match classifier");
    }
    if (typeof evaluation.threshold !== "number" || evaluation.threshold !== p.threshold) {
      errs.push("evaluation threshold does not match profile");
    }
    if (!evaluation.version || typeof evaluation.version !== "string") {
      errs.push("missing evaluation version");
    }
  }
  if (p.aliasPattern) {
    try { new RegExp(p.aliasPattern, "i"); } catch (e) { errs.push("aliasPattern is not a valid regex"); }
  }
  return errs;
}

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch every asset the profile declares and check it against its hash.
 * Returns the fetched bytes so the caller doesn't download them twice.
 */
export async function verifyAssets(profile) {
  const bytes = {};
  for (const [url, expected] of Object.entries(profile.assets)) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const got = await sha256(buf);
    if (got !== String(expected).toLowerCase()) {
      throw new Error(`${url} hash mismatch (expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    }
    bytes[url] = buf;
  }
  return bytes;
}

/**
 * Resolve the wake profile to run.
 *
 * The manifest is the ONLY thing that switches the active profile, and the
 * bundler writes it last — so a half-copied model directory is never pointed at.
 * Any failure at any step falls back to the verified built-in.
 *
 * @returns {{profile: object, bytes: object, fellBack: boolean, reason?: string}}
 */
export async function resolveWakeProfile({ onWarn } = {}) {
  const warn = (m) => { try { (onWarn || console.warn)(m); } catch (e) {} };
  let candidate = null;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (res.ok) {
      const manifest = await res.json();
      const active = manifest && manifest.active;
      candidate = active && manifest.profiles ? manifest.profiles[active] : null;
      if (active && !candidate) warn(`wake manifest names "${active}" but doesn't define it`);
    }
  } catch (e) {
    // no manifest is the normal case before a custom model is bundled
  }

  if (candidate) {
    const errs = validateProfile(candidate);
    if (errs.length) {
      warn("wake profile rejected: " + errs.join("; "));
    } else {
      try {
        const bytes = await verifyAssets(candidate);
        return { profile: Object.freeze({ ...candidate, verified: true }), bytes, fellBack: false };
      } catch (e) {
        warn("wake profile failed verification, rolling back: " + e.message);
      }
    }
  }

  // Verify the fallback too — a corrupted shipped model should be loud, not a
  // wake word that silently never fires.
  try {
    const bytes = await verifyAssets(FALLBACK_PROFILE);
    return { profile: FALLBACK_PROFILE, bytes, fellBack: !!candidate, reason: candidate ? "custom profile failed verification" : undefined };
  } catch (e) {
    warn("shipped wake assets failed verification: " + e.message);
    return { profile: FALLBACK_PROFILE, bytes: null, fellBack: true, reason: "assets corrupt: " + e.message };
  }
}
