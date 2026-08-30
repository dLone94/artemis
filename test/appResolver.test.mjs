// Installed-application resolution: generic discovery, natural-name matching,
// semantic OS aliases, conservative fuzziness, honest misses. Fixture-driven —
// the resolver scans injected roots, never this machine's real /Applications.
//
// Run: node --test test/appResolver.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveInstalledApplication,
  discoverInstalledApps,
  invalidateAppCache,
  normalizeAppName,
  SYSTEM_APP_ALIASES
} from "../appResolver.js";

const ROOT = mkdtempSync(join(tmpdir(), "artemis-apps-"));
const APPS = join(ROOT, "Applications");
const SYS = join(ROOT, "System-Applications");
for (const dir of [
  join(APPS, "WhatsApp.app"),
  join(APPS, "Onyx Scribe.app"),
  join(APPS, "Vendor Suite", "Nested Tool.app"), // one nested level
  join(SYS, "System Settings.app"),
  join(SYS, "Terminal.app")
]) mkdirSync(dir, { recursive: true });

const OPTS = { roots: [APPS, SYS] };
test.beforeEach(() => invalidateAppCache());
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test("discovery finds .app bundles in the given roots, one nested level deep", async () => {
  const apps = await discoverInstalledApps({ ...OPTS, force: true });
  const names = apps.map((a) => a.displayName).sort();
  assert.deepEqual(names, ["Nested Tool", "Onyx Scribe", "System Settings", "Terminal", "WhatsApp"]);
});

test("natural names resolve: case, .app suffix, whitespace", async () => {
  for (const spoken of ["WhatsApp", "whatsapp", "WhatsApp.app", "  whatsapp  "]) {
    const r = await resolveInstalledApplication(spoken, OPTS);
    assert.equal(r.found, true, `"${spoken}"`);
    assert.equal(r.displayName, "WhatsApp");
    assert.match(r.path, /WhatsApp\.app$/);
    assert.equal(r.confidence, "high");
  }
  for (const spoken of ["onyx scribe", "ONYX Scribe", "ONYX Scribe.app"]) {
    const r = await resolveInstalledApplication(spoken, OPTS);
    assert.equal(r.found && r.displayName, "Onyx Scribe", `"${spoken}"`);
    assert.equal(r.matchType, "exact", "normalized equality is an exact match");
  }
});

test("system aliases: settings/preferences resolve to System Settings", async () => {
  for (const spoken of ["settings", "Settings", "system settings", "preferences", "System Preferences"]) {
    const r = await resolveInstalledApplication(spoken, OPTS);
    assert.equal(r.found && r.displayName, "System Settings", `"${spoken}"`);
  }
  // the alias layer stays a SMALL semantic map, not an app database
  assert.ok(Object.keys(SYSTEM_APP_ALIASES).length <= 8, "alias layer stays deliberately small");
});

test("compact matching: spoken name without spaces still resolves", async () => {
  const r = await resolveInstalledApplication("onyxscribe", OPTS);
  assert.equal(r.found && r.displayName, "Onyx Scribe");
  assert.equal(r.matchType, "compact");
});

test("a unique strong partial match resolves; junk does not", async () => {
  const partial = await resolveInstalledApplication("scribe", OPTS);
  assert.equal(partial.found && partial.displayName, "Onyx Scribe", "unique substring resolves");
  assert.equal(partial.confidence, "medium");
  const junk = await resolveInstalledApplication("xz", OPTS);
  assert.equal(junk.found, false, "too-short fragments never fuzzy-match");
});

test("two credible candidates → no pick, both names offered", async () => {
  mkdirSync(join(APPS, "Onyx Control.app"), { recursive: true });
  try {
    const r = await resolveInstalledApplication("onyx", { ...OPTS, force: true });
    assert.equal(r.found, false, "ambiguity must not guess");
    assert.deepEqual(r.candidates.sort(), ["Onyx Control", "Onyx Scribe"]);
  } finally {
    rmSync(join(APPS, "Onyx Control.app"), { recursive: true, force: true });
  }
});

test("a missing app is an honest miss with no candidates", async () => {
  const r = await resolveInstalledApplication("SomeAppThatDoesNotExist", OPTS);
  assert.deepEqual(r, { found: false, candidates: [] });
});

test("nested vendor folders resolve too", async () => {
  const r = await resolveInstalledApplication("nested tool", OPTS);
  assert.equal(r.found && r.displayName, "Nested Tool");
});

test("the cache refreshes on a miss so a just-installed app resolves", async () => {
  let clock = 1_000_000;
  const opts = { ...OPTS, now: () => clock };
  await discoverInstalledApps({ ...opts, force: true });
  mkdirSync(join(APPS, "Brand New.app"), { recursive: true });
  try {
    clock += 11_000; // past the rescan-on-miss floor, inside the TTL
    const r = await resolveInstalledApplication("brand new", opts);
    assert.equal(r.found && r.displayName, "Brand New");
  } finally {
    rmSync(join(APPS, "Brand New.app"), { recursive: true, force: true });
  }
});

test("normalization is stable and safe", () => {
  assert.equal(normalizeAppName("  ONYX   Scribe.app "), "onyx scribe");
  assert.equal(normalizeAppName("What's-App"), "whats app");
  assert.equal(normalizeAppName(""), "");
});
