// Installed-application resolution for macOS — the generic answer to
// "Open <App>", replacing per-app special cases.
//
// Discovery is a plain directory scan of the standard LaunchServices locations
// (plus one nested level, for vendors that ship "/Applications/Vendor/App.app")
// — no Spotlight query, no native bridge, no giant hard-coded list. The scan is
// cached briefly and refreshed on a miss, so a just-installed app resolves
// without a restart and an utterance never pays for a cold scan twice.
//
// Matching is deliberately conservative: exact normalized name, then the
// spaces-removed form, then a UNIQUE prefix/substring match. Multiple credible
// candidates are returned for the caller to ask about — never guessed.
//
// This module resolves; it never launches. Launching goes through
// macPerception.openApplication with the resolved bundle path, inside the
// normal skill/permission runtime.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// Standard app locations. ARTEMIS_APP_DIRS (colon-separated) replaces the set
// entirely — used by tests and by anyone keeping apps somewhere unusual.
function defaultRoots(env = process.env) {
  const override = String(env.ARTEMIS_APP_DIRS || "").trim();
  if (override) return override.split(":").map((p) => p.trim()).filter(Boolean);
  return [
    "/Applications",
    "/Applications/Utilities",
    join(homedir(), "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities"
  ];
}

// Semantic OS aliases ONLY: spoken names that differ from the installed app's
// real name. Small on purpose — third-party apps resolve by discovery, never
// by an entry here.
export const SYSTEM_APP_ALIASES = Object.freeze({
  "settings": "System Settings",
  "system settings": "System Settings",
  "preferences": "System Settings",
  "system preferences": "System Settings"
});

/** Natural name normalization: case, .app suffix, whitespace, light punctuation. */
export function normalizeAppName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.app$/i, "")
    .replace(/['’]/g, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.?!,]+$/, "")
    .trim();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const RESCAN_ON_MISS_MIN_AGE_MS = 10 * 1000;
let cache = { apps: null, at: 0 };

async function listApps(dir, depth, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return; // missing root — normal (e.g. no ~/Applications)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.name.endsWith(".app")) {
      out.push({ displayName: basename(entry.name, ".app"), path: full });
    } else if (depth > 0 && !entry.name.startsWith(".")) {
      // one nested level: "/Applications/Some Vendor/Some App.app"
      await listApps(full, depth - 1, out);
    }
    if (out.length >= 2000) return; // sanity bound, never a real Mac
  }
}

/** Scan (or reuse) the installed-app inventory. */
export async function discoverInstalledApps(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  if (!opts.force && cache.apps && now() - cache.at < CACHE_TTL_MS) return cache.apps;
  const roots = opts.roots || defaultRoots(opts.env);
  const out = [];
  for (const root of roots) await listApps(root, 1, out);
  // de-dup by path; a name can legitimately appear twice in different roots
  const seen = new Set();
  const apps = out.filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)));
  cache = { apps, at: now() };
  return apps;
}

/** Test/refresh hook: forget the inventory. */
export function invalidateAppCache() {
  cache = { apps: null, at: 0 };
}

// The same app installed in two roots is ONE app, not an ambiguity: root
// order is priority order, so the first sighting of a name wins.
function dedupeByName(apps) {
  const seen = new Set();
  return apps.filter((a) => {
    const key = normalizeAppName(a.displayName);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesOf(apps, normalized) {
  const compactTarget = normalized.replace(/\s+/g, "");
  const exact = [];
  const compact = [];
  const fuzzy = [];
  for (const app of apps) {
    const n = normalizeAppName(app.displayName);
    if (n === normalized) exact.push(app);
    else if (n.replace(/\s+/g, "") === compactTarget) compact.push(app);
    else if (normalized.length >= 3 && (n.startsWith(normalized + " ") || n.includes(normalized))) fuzzy.push(app);
  }
  if (exact.length) return { matchType: "exact", confidence: "high", apps: dedupeByName(exact) };
  if (compact.length) return { matchType: "compact", confidence: "high", apps: dedupeByName(compact) };
  if (fuzzy.length) return { matchType: "fuzzy", confidence: "medium", apps: dedupeByName(fuzzy) };
  return { matchType: null, confidence: null, apps: [] };
}

/**
 * Resolve a natural app name against what is actually installed.
 *
 * @returns {Promise<{found:true, displayName, bundleIdentifier:null, path,
 *                    confidence, matchType}
 *                 | {found:false, candidates: string[]}>}
 *   candidates carries 2+ names when the reference was ambiguous, and is
 *   empty when nothing installed matches. bundleIdentifier is reserved
 *   (launching goes by resolved path; reading Info.plist would cost a
 *   process call per resolution for nothing the launcher needs).
 */
export async function resolveInstalledApplication(name, opts = {}) {
  const spoken = normalizeAppName(name);
  if (!spoken) return { found: false, candidates: [] };
  const normalized = normalizeAppName(SYSTEM_APP_ALIASES[spoken] || spoken);

  let apps = await discoverInstalledApps(opts);
  let match = matchesOf(apps, normalized);
  // Refresh-on-miss: the app may have been installed since the last scan.
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  if (!match.apps.length && now() - cache.at > RESCAN_ON_MISS_MIN_AGE_MS) {
    apps = await discoverInstalledApps({ ...opts, force: true });
    match = matchesOf(apps, normalized);
  }

  if (match.apps.length === 1) {
    const app = match.apps[0];
    return {
      found: true,
      displayName: app.displayName,
      bundleIdentifier: null,
      path: app.path,
      confidence: match.confidence,
      matchType: match.matchType
    };
  }
  return {
    found: false,
    candidates: match.apps.slice(0, 4).map((a) => a.displayName)
  };
}
