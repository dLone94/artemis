// Display identity contract: the product is "Artemis" on every user-facing
// surface, and the compatibility-critical internals are "Artemis" too (see
// docs/NAMING-COMPAT.md — those internals never moved, which is the only reason
// the Evie rename could be reversed without a data migration).
// These are source-text assertions on purpose — the point is to catch a careless
// find-and-replace in either direction, which no runtime test would notice.
// Run: node --test test/identity.test.mjs
import assert from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("Info.plist shows Artemis and keeps the TCC-critical bundle id", () => {
  const plist = read("app/Info.plist.in");
  assert.match(plist, /<key>CFBundleName<\/key><string>Artemis<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Artemis<\/string>/);
  // Renaming the bundle id revokes every macOS permission grant.
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.artemis\.desktop<\/string>/);
});

test("the system prompt persona is Artemis", () => {
  const server = read("server.js");
  assert.ok(server.includes("You are Artemis"), 'server.js must contain "You are Artemis"');
  assert.ok(!server.includes("You are Evie"), 'server.js must not contain "You are Evie"');
});

test("the locked login page is branded ARTEMIS", () => {
  const server = read("server.js");
  const start = server.indexOf("const LOGIN_PAGE");
  assert.ok(start !== -1, "LOGIN_PAGE not found in server.js");
  const loginPage = server.slice(start, server.indexOf("\n\n", start));
  assert.ok(loginPage.includes("ARTEMIS"), "LOGIN_PAGE must be branded ARTEMIS");
  assert.ok(!/EVIE/i.test(loginPage), "LOGIN_PAGE must not mention Evie");
});

test('no front-end file claims a "Hey Evie" wake word exists', () => {
  // The loaded wake model is "Hey Artemis" (hey-artemis-v2). No "Hey Evie"
  // model was ever trained, so no UI may tell the user to say it.
  const dir = join(ROOT, "public");
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
    .filter((f) => /hey\s+evie/i.test(readFileSync(join(dir, f), "utf8")));
  assert.deepStrictEqual(offenders, [], `these files claim a "Hey Evie" wake word: ${offenders.join(", ")}`);
});

test("no user-facing surface still says Evie", () => {
  // The rename to Evie was reversed. This is the guard that keeps it reversed:
  // every surface the user reads or hears must say Artemis. Historical design
  // docs under docs/ and collected eval baselines are deliberately out of scope
  // — they are a record of what happened, not something the user reads.
  const surfaces = [
    ...readdirSync(join(ROOT, "public"))
      .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
      .map((f) => join("public", f)),
    "server.js",
    "skills.js",
    "moneySchool.js",
    "app/Info.plist.in",
    "app/build.sh",
    ...readdirSync(join(ROOT, "app/Sources"))
      .filter((f) => f.endsWith(".swift"))
      .map((f) => join("app/Sources", f)),
  ];
  const offenders = surfaces.filter((rel) => /\bEvie\b/i.test(read(rel)));
  assert.deepStrictEqual(offenders, [], `these user-facing files still say Evie: ${offenders.join(", ")}`);
});

test("the compatibility inventory documents the retained bundle id", () => {
  const doc = read("docs/NAMING-COMPAT.md");
  assert.ok(doc.includes("com.artemis.desktop"), "docs/NAMING-COMPAT.md must mention com.artemis.desktop");
});

test("the orb wordmark spells Artemis, not letters that evade string sweeps", () => {
  // voiceOrb.js is retired from the cockpit but still renders on /orb.html.
  const source = readFileSync(new URL("../public/voiceOrb.js", import.meta.url), "utf8");
  assert.match(source, /WORDMARK_LETTERS = \["A","R","T","E","M","I","S"\]/);
  assert.doesNotMatch(source, /\["E","V","I","E"\]/);
});

test("the Core centre label reads ARTEMIS", () => {
  const source = read("public/artemisCore.js");
  assert.match(source, /fillText\("ARTEMIS"/, "the Core must draw ARTEMIS at its centre");
  assert.doesNotMatch(source, /fillText\("EVE"/, "the retired EVE label must not return");
});

test("Core technical identifiers remain Artemis", () => {
  const source = read("public/artemisCore.js");
  assert.match(source, /export class ArtemisCore/, "the class must stay ArtemisCore");
  assert.match(source, /window\.__artemisAmp/, "the amplitude channel must stay __artemisAmp");
  assert.doesNotMatch(source, /class EveCore|window\.__eveAmp|from "\.\/eve/i);
});

test("EVE stays out of every user-facing surface", () => {
  for (const rel of ["public/index.html", "public/about.html", "public/core-preview.html", "server.js", "skills.js"]) {
    assert.doesNotMatch(read(rel), /\bEVE\b/, `${rel} must not carry retired EVE branding`);
  }
});
