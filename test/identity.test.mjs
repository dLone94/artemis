// Display identity contract: the product is "Evie" on every user-facing surface,
// while the compatibility-critical internals stay "Artemis" (see docs/EVIE-COMPAT.md).
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

test("Info.plist shows Evie but keeps the TCC-critical bundle id", () => {
  const plist = read("app/Info.plist.in");
  assert.match(plist, /<key>CFBundleName<\/key><string>Evie<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Evie<\/string>/);
  // Renaming the bundle id revokes every macOS permission grant.
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.artemis\.desktop<\/string>/);
});

test("the system prompt persona is Evie", () => {
  const server = read("server.js");
  assert.ok(server.includes("You are Evie"), 'server.js must contain "You are Evie"');
  assert.ok(!server.includes("You are Artemis"), 'server.js must not contain "You are Artemis"');
});

test("the locked login page is branded EVIE", () => {
  const server = read("server.js");
  const start = server.indexOf("const LOGIN_PAGE");
  assert.ok(start !== -1, "LOGIN_PAGE not found in server.js");
  const loginPage = server.slice(start, server.indexOf("\n\n", start));
  assert.ok(loginPage.includes("EVIE"), "LOGIN_PAGE must be branded EVIE");
  assert.ok(!/ARTEMIS/i.test(loginPage), "LOGIN_PAGE must not mention Artemis");
});

test('no front-end file claims a "Hey Evie" wake word exists', () => {
  // The loaded wake model is openWakeWord "Hey Jarvis". Until a real "Hey Evie"
  // model ships and passes its FAR gate, no UI may tell the user to say it.
  const dir = join(ROOT, "public");
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
    .filter((f) => /hey\s+evie/i.test(readFileSync(join(dir, f), "utf8")));
  assert.deepStrictEqual(offenders, [], `these files claim a "Hey Evie" wake word: ${offenders.join(", ")}`);
});

test("the compatibility inventory documents the retained bundle id", () => {
  const doc = read("docs/EVIE-COMPAT.md");
  assert.ok(doc.includes("com.artemis.desktop"), "docs/EVIE-COMPAT.md must mention com.artemis.desktop");
});
