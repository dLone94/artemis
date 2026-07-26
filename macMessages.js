// Reading unread messaging state from macOS without opening an app.
//
// The Dock badge owns the count. Notification Centre is only an enrichment
// source because dismissed alerts disappear even while messages remain unread.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { whatsappInstalled } from "./whatsapp.js";

const NOTIFICATION_DB = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.com.apple.usernoted",
  "db2",
  "db"
);
const WHATSAPP_DOCK_NAME = "WhatsApp";
const WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp";

const DOCK_BADGE_SCRIPT = `
on run argv
  set targetApp to item 1 of argv
  tell application "System Events"
    tell process "Dock"
      set badgeValue to value of attribute "AXStatusLabel" of UI element targetApp of list 1
    end tell
  end tell
  if badgeValue is missing value then return "missing value"
  return badgeValue as text
end run
`;

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function stdoutOf(result) {
  if (result && typeof result === "object" && "stdout" in result) return result.stdout;
  return result;
}

function commandFailed(result) {
  if (!result || typeof result !== "object") return false;
  return (Number.isInteger(result.exitCode) && result.exitCode !== 0) ||
    (Number.isInteger(result.code) && result.code !== 0);
}

export function parseBadge(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value === "missing value") return 0;
  if (!/^\d+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

export async function dockBadge(appName, opts = {}) {
  const run = opts.run || runFile;
  try {
    // argv keeps an app name out of AppleScript source, for the same reason the
    // sending side passes URLs as process arguments instead of shell strings.
    const result = await run("/usr/bin/osascript", ["-e", DOCK_BADGE_SCRIPT, String(appName || "")]);
    if (commandFailed(result)) return null;
    return parseBadge(stdoutOf(result));
  } catch (error) {
    // Accessibility denial and "app not in Dock" are unknown states here.
    // unreadReport checks installation separately before choosing user copy.
    return null;
  }
}

export function parseNotificationRow(plistObject) {
  const req = plistObject && plistObject.req && typeof plistObject.req === "object"
    ? plistObject.req
    : {};
  const text = (value) => typeof value === "string" && value !== "" ? value : null;
  return {
    sender: text(req.titl),
    preview: text(req.body),
    group: text(req.subt),
    at: plistObject && plistObject.date != null ? plistObject.date : null
  };
}

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export async function recentNotifications(bundleId, opts = {}) {
  const identifier = String(bundleId || "").trim();
  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) throw new Error("invalid bundle id");

  const run = opts.run || runFile;
  const source = opts.dbPath || NOTIFICATION_DB;
  const snapshotDir = await fs.mkdtemp(join(opts.tmpDir || tmpdir(), "artemis-messages-"));
  const snapshot = join(snapshotDir, "db");

  try {
    // Notification Centre uses a VFS whose page format survives `.backup` and
    // cannot be reopened by plain sqlite3. VACUUM rewrites committed WAL state
    // into the standard SQLite file the filtered reader below can query.
    await run("/usr/bin/sqlite3", [
      "-readonly",
      "-batch",
      source,
      `VACUUM INTO ${sqlString(snapshot)};`
    ]);

    // The identifier predicate is the privacy boundary: notification payloads
    // for Mail, Chrome, Messages and every other app stay inside SQLite.
    const sql = `
      SELECT hex(record.data)
      FROM record
      JOIN app ON app.app_id = record.app_id
      WHERE app.identifier = ${sqlString(identifier)}
      ORDER BY record.delivered_date DESC, record.rec_id DESC;
    `;
    const rawRows = stdoutOf(await run("/usr/bin/sqlite3", [
      "-readonly",
      "-batch",
      "-noheader",
      snapshot,
      sql
    ]));
    const hexRows = String(rawRows == null ? "" : rawRows)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const items = [];
    for (let i = 0; i < hexRows.length; i += 1) {
      const hex = hexRows[i];
      if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) continue;
      const plistPath = join(snapshotDir, `row-${i}.plist`);
      await fs.writeFile(plistPath, Buffer.from(hex, "hex"));
      const extract = async (key) => {
        try {
          const result = await run("/usr/bin/plutil", [
            "-extract",
            key,
            "raw",
            "-n",
            "-o",
            "-",
            plistPath
          ]);
          if (commandFailed(result)) return null;
          return String(stdoutOf(result) == null ? "" : stdoutOf(result));
        } catch (error) {
          return null;
        }
      };
      // Real Notification Centre plists contain values JSON cannot represent.
      // Pulling only documented keys also keeps unrelated payload data in place.
      const [sender, preview, group, at] = await Promise.all([
        extract("req.titl"),
        extract("req.body"),
        extract("req.subt"),
        extract("date")
      ]);
      const item = parseNotificationRow({ req: { titl: sender, body: preview, subt: group }, date: at });
      if (item.sender || item.preview || item.group || item.at != null) items.push(item);
    }
    return items;
  } finally {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  }
}

export async function unreadReport(opts = {}) {
  let installed;
  try {
    installed = "installed" in opts
      ? !!opts.installed
      : await (opts.isInstalled || whatsappInstalled)();
  } catch (error) {
    return { count: null, items: [], degraded: ["installation_unreadable"] };
  }
  if (!installed) return { count: null, items: [], degraded: ["not_installed"] };

  const badgeReader = opts.dockBadge || dockBadge;
  const notificationReader = opts.recentNotifications || recentNotifications;
  const [badgeResult, notificationResult] = await Promise.allSettled([
    badgeReader(WHATSAPP_DOCK_NAME, opts),
    notificationReader(WHATSAPP_BUNDLE_ID, opts)
  ]);

  let count = null;
  const degraded = [];
  if (badgeResult.status === "fulfilled") {
    count = badgeResult.value == null ? null : parseBadge(badgeResult.value);
  }
  if (count == null) degraded.push("badge_unreadable");

  let items = [];
  if (notificationResult.status === "fulfilled" && Array.isArray(notificationResult.value)) {
    items = notificationResult.value;
  } else {
    degraded.push("notifications_unreadable");
  }

  // A stale Notification Centre row must not contradict the authoritative
  // badge or turn an already-read message back into a "new" one.
  if (count === 0) items = [];
  else if (count != null && items.length > count) items = items.slice(0, count);

  return { count, items, degraded };
}
