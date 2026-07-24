// Tests for the wake-profile gate.
//
// The failure this guards against is specific and nasty: the UI says "Hey
// Artemis" while the engine has loaded the Jarvis classifier, so the user says
// the wrong words at a device that looks like it's listening. Every path below
// ends with the profile the engine will ACTUALLY run.
//
// Run: node test/wakeProfile.test.mjs
import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProfile, resolveWakeProfile, FALLBACK_PROFILE } from "../public/wakeProfile.js";

const OWW = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "oww");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Stand in for the network: a map of url -> Buffer or string.
function stubFetch(files) {
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (!(key in files)) return { ok: false, status: 404 };
    const body = files[key];
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString()),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  };
}

// The built-in profile's hashes are of the REAL shipped files, so the stub has
// to serve the real bytes — otherwise every test would see a corrupt fallback.
// That also means these tests assert the shipped assets are intact.
const REAL = {
  "/oww/melspectrogram.onnx": readFileSync(join(OWW, "melspectrogram.onnx")),
  "/oww/embedding_model.onnx": readFileSync(join(OWW, "embedding_model.onnx")),
  "/oww/hey_jarvis_v0.1.onnx": readFileSync(join(OWW, "hey_jarvis_v0.1.onnx"))
};
const ARTEMIS = Buffer.from("pretend-this-is-a-trained-classifier");

const baseFiles = () => ({ ...REAL });

const artemisProfile = (overrides = {}) => ({
  id: "hey-artemis-v1",
  phrase: "Hey Artemis",
  aliasPattern: "(artemis|artist)",
  classifierUrl: "/oww/models/hey-artemis-v1/hey_artemis.onnx",
  threshold: 0.72,
  cooldownMs: 2000,
  assets: {
    "/oww/models/hey-artemis-v1/hey_artemis.onnx": sha(ARTEMIS),
    "/oww/melspectrogram.onnx": sha(REAL["/oww/melspectrogram.onnx"]),
    "/oww/embedding_model.onnx": sha(REAL["/oww/embedding_model.onnx"])
  },
  ...overrides
});

const warnings = [];
const opts = { onWarn: (m) => warnings.push(m) };

// ---- shape validation -------------------------------------------------------
{
  assert.deepEqual(validateProfile(artemisProfile()), [], "a well-formed profile validates");
  assert.ok(validateProfile(null).length, "null is rejected");
  assert.ok(validateProfile(artemisProfile({ threshold: 1.5 })).length, "threshold out of range rejected");
  assert.ok(validateProfile(artemisProfile({ threshold: "0.5" })).length, "non-numeric threshold rejected");
  assert.ok(validateProfile(artemisProfile({ phrase: "" })).length, "empty phrase rejected");
  assert.ok(validateProfile(artemisProfile({ aliasPattern: "([unclosed" })).length, "bad regex rejected");

  // a classifier outside /oww/ would let a manifest point the engine at an
  // arbitrary URL — that is a code-execution-shaped hole, not a typo
  assert.ok(validateProfile(artemisProfile({ classifierUrl: "https://evil.example/m.onnx" })).length,
    "off-origin classifier rejected");
  assert.ok(validateProfile(artemisProfile({ assets: { "/etc/passwd": sha(Buffer.from("x")) } })).length,
    "asset outside /oww/ rejected");

  const noHash = artemisProfile();
  delete noHash.assets[noHash.classifierUrl];
  assert.ok(validateProfile(noHash).length, "classifier without a declared hash rejected");
  console.log("  ✓ profile validation rejects malformed, off-origin and unhashed profiles");
}

// ---- clean install: no manifest at all --------------------------------------
{
  warnings.length = 0;
  stubFetch(baseFiles());   // no manifest.json
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id, "with no manifest the built-in profile runs");
  assert.equal(r.fellBack, false, "that isn't a rollback — it's the normal state");
  console.log("  ✓ clean install with no manifest runs the built-in profile");
}

// ---- a valid custom profile is adopted --------------------------------------
{
  warnings.length = 0;
  const p = artemisProfile();
  stubFetch({
    ...baseFiles(),
    "/oww/manifest.json": JSON.stringify({ active: p.id, profiles: { [p.id]: p } }),
    [p.classifierUrl]: ARTEMIS
  });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, "hey-artemis-v1");
  assert.equal(r.profile.phrase, "Hey Artemis");
  assert.equal(r.profile.threshold, 0.72, "the model's own operating point is used, not a default");
  assert.equal(r.fellBack, false);
  assert.ok(r.bytes[p.classifierUrl], "verified bytes are handed back so the file can't change after the check");
  console.log("  ✓ a hash-verified custom profile is adopted with its own threshold");
}

// ---- corrupt / truncated asset: roll back, do not run unverified ------------
{
  warnings.length = 0;
  const p = artemisProfile();
  stubFetch({
    ...baseFiles(),
    "/oww/manifest.json": JSON.stringify({ active: p.id, profiles: { [p.id]: p } }),
    [p.classifierUrl]: "TRUNCATED"          // real file, wrong bytes
  });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id, "a hash mismatch must roll back");
  assert.equal(r.fellBack, true);
  assert.ok(warnings.some((w) => /hash mismatch/i.test(w)), "and say why");
  console.log("  ✓ a corrupt classifier rolls back to the verified profile");
}

// ---- half-deployed: manifest points at a model that isn't there -------------
{
  warnings.length = 0;
  const p = artemisProfile();
  stubFetch({
    ...baseFiles(),
    "/oww/manifest.json": JSON.stringify({ active: p.id, profiles: { [p.id]: p } })
    // classifier absent entirely
  });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id, "a missing asset rolls back");
  assert.equal(r.fellBack, true);
  console.log("  ✓ a half-deployed bundle rolls back instead of failing to listen");
}

// ---- manifest names a profile it doesn't define -----------------------------
{
  warnings.length = 0;
  stubFetch({ ...baseFiles(), "/oww/manifest.json": JSON.stringify({ active: "ghost", profiles: {} }) });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id);
  assert.ok(warnings.some((w) => /doesn't define/.test(w)));
  console.log("  ✓ a manifest naming an undefined profile rolls back and warns");
}

// ---- an invalid profile never reaches the hash check ------------------------
{
  warnings.length = 0;
  const bad = artemisProfile({ classifierUrl: "https://evil.example/m.onnx" });
  stubFetch({ ...baseFiles(), "/oww/manifest.json": JSON.stringify({ active: bad.id, profiles: { [bad.id]: bad } }) });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id);
  assert.ok(warnings.some((w) => /rejected/.test(w)));
  console.log("  ✓ an off-origin profile is rejected before anything is fetched from it");
}

// ---- explicit rollback (manifest active:null) -------------------------------
{
  warnings.length = 0;
  const p = artemisProfile();
  stubFetch({
    ...baseFiles(),
    "/oww/manifest.json": JSON.stringify({ active: null, profiles: { [p.id]: p } }),
    [p.classifierUrl]: ARTEMIS
  });
  const r = await resolveWakeProfile(opts);
  assert.equal(r.profile.id, FALLBACK_PROFILE.id, "active:null returns to the built-in even with a valid bundle present");
  console.log("  ✓ rollback via the manifest returns to the built-in profile");
}

console.log("PASS ✅  wakeProfile: the phrase shown is always the phrase the engine loaded");
