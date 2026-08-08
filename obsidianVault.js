// Zero-dependency Obsidian vault access for Artemis. Reads are cached by file
// mtime; writes are append-only or create-only and are confined to one vault.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import {
  basename,
  dirname,
  extname,
  relative,
  resolve,
  sep
} from "node:path";

const SKIP_DIRECTORIES = new Set([
  ".obsidian",
  "_attachments",
  "graphify-out",
  "_templates"
]);

// Absolute path -> parsed note plus the source body used by read/search.
const noteCache = new Map();

function vaultRoot() {
  const configured = String(process.env.OBSIDIAN_VAULT_PATH || "~/obsidian-vault").trim();
  const expanded = configured === "~"
    ? os.homedir()
    : configured.startsWith("~/") || configured.startsWith("~\\")
      ? resolve(os.homedir(), configured.slice(2))
      : configured;
  return resolve(expanded);
}

function confine(path) {
  const root = vaultRoot();
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + sep) && absolute !== root) {
    throw new Error("path escapes vault: " + path);
  }

  // The lexical check above is necessary but not sufficient: an existing
  // `daily` or `meetings` symlink could otherwise redirect a write outside the
  // vault. Resolve the closest existing ancestor so new files are safe too.
  const realRoot = realpathSync(root);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  if (!realExisting.startsWith(realRoot + sep) && realExisting !== realRoot) {
    throw new Error("path escapes vault: " + path);
  }
  return absolute;
}

function requireVault() {
  if (!vaultAvailable()) throw new Error("vault is not available: " + vaultRoot());
}

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relativePath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

function fileStem(path) {
  return basename(path, extname(path));
}

function parseLinks(body) {
  const links = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = pattern.exec(body))) {
    const target = match[1].split("|", 1)[0].split("#", 1)[0].trim();
    if (target) links.push(target.replace(/\.md$/i, ""));
  }
  return links;
}

function parseTags(body) {
  const tags = new Set();
  for (const match of body.matchAll(/(^|[\s([{])#([\p{L}\p{N}_/-]+)/gmu)) {
    tags.add(match[2]);
  }

  const frontmatter = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) {
    const tagLine = frontmatter[1].match(/^tags\s*:\s*(.*)$/im);
    if (tagLine) {
      const raw = tagLine[1].trim().replace(/^\[|\]$/g, "");
      for (const tag of raw.split(/[\s,]+/)) {
        const cleaned = tag.replace(/^['"#]|['"]$/g, "").trim();
        if (cleaned) tags.add(cleaned);
      }
    }
  }
  return [...tags];
}

function parseNote(root, absolute, stats) {
  const body = readFileSync(absolute, "utf8");
  const path = relativePath(root, absolute);
  const heading = body.match(/^#\s+(.+?)\s*$/m);
  const title = heading ? heading[1].trim() : fileStem(path);
  const headings = [...body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
  return {
    mtimeMs: stats.mtimeMs,
    body,
    filename: fileStem(path),
    headings,
    note: {
      path,
      title,
      links: parseLinks(body),
      tags: parseTags(body),
      mtime: stats.mtimeMs
    }
  };
}

function markdownFiles(root) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(resolve(directory, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(resolve(directory, entry.name));
      }
    }
  };
  visit(root);
  return files;
}

function cachedEntries() {
  scanVault();
  const root = vaultRoot();
  return [...noteCache.entries()]
    .filter(([absolute]) => absolute.startsWith(root + sep))
    .map(([, cached]) => cached)
    .sort((a, b) => a.note.path.localeCompare(b.note.path));
}

function cleanSingleLine(value) {
  return String(value == null ? "" : value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  return cleanSingleLine(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function noteAliases(cached) {
  const pathWithoutExtension = cached.note.path.replace(/\.md$/i, "");
  return [
    cached.note.path,
    pathWithoutExtension,
    cached.filename,
    cached.note.title
  ].map((value) => value.toLowerCase());
}

function resolveLink(target, entries) {
  const wanted = String(target || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  const matches = entries.filter((cached) => noteAliases(cached).includes(wanted));
  return matches.length === 1 ? matches[0] : null;
}

export function vaultAvailable() {
  try {
    return statSync(vaultRoot()).isDirectory();
  } catch (error) {
    return false;
  }
}

export function scanVault() {
  const root = vaultRoot();
  if (!vaultAvailable()) {
    noteCache.clear();
    return new Map();
  }

  const seen = new Set();
  for (const absolute of markdownFiles(root)) {
    seen.add(absolute);
    let stats;
    try {
      stats = statSync(absolute);
    } catch (error) {
      continue;
    }
    const cached = noteCache.get(absolute);
    if (!cached || cached.mtimeMs !== stats.mtimeMs) {
      try {
        noteCache.set(absolute, parseNote(root, absolute, stats));
      } catch (error) {
        noteCache.delete(absolute);
      }
    }
  }

  for (const absolute of noteCache.keys()) {
    if (!seen.has(absolute)) noteCache.delete(absolute);
  }

  const notes = new Map();
  for (const cached of cachedEntriesWithoutScan(root)) {
    notes.set(cached.note.path, { ...cached.note, links: [...cached.note.links], tags: [...cached.note.tags] });
  }
  return notes;
}

function cachedEntriesWithoutScan(root = vaultRoot()) {
  return [...noteCache.entries()]
    .filter(([absolute]) => absolute.startsWith(root + sep))
    .map(([, cached]) => cached)
    .sort((a, b) => a.note.path.localeCompare(b.note.path));
}

export function searchNotes(query, limit = 5) {
  const wanted = String(query || "").trim().toLowerCase();
  if (!wanted) return [];
  const max = Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 5);

  return cachedEntries()
    .map((cached) => {
      const filename = cached.filename.toLowerCase();
      const headingMatch = cached.headings.some((heading) => heading.toLowerCase().includes(wanted));
      const lowerBody = cached.body.toLowerCase();
      const first = lowerBody.indexOf(wanted);
      if (!filename.includes(wanted) && !headingMatch && first < 0) return null;

      let occurrences = 0;
      let offset = 0;
      while ((offset = lowerBody.indexOf(wanted, offset)) >= 0) {
        occurrences += 1;
        offset += Math.max(1, wanted.length);
      }
      const rank = filename.includes(wanted) ? 3 : headingMatch ? 2 : 1;
      const start = Math.max(0, (first >= 0 ? first : 0) - 80);
      const end = Math.min(cached.body.length, (first >= 0 ? first + wanted.length : 0) + 120);
      let snippet = cached.body.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "…" + snippet;
      if (end < cached.body.length) snippet += "…";
      return {
        rank,
        occurrences,
        result: {
          path: cached.note.path,
          title: cached.note.title,
          snippet
        }
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      b.rank - a.rank ||
      b.occurrences - a.occurrences ||
      a.result.title.localeCompare(b.result.title)
    )
    .slice(0, max)
    .map((entry) => entry.result);
}

export function readNote(nameOrPath) {
  const raw = String(nameOrPath || "").trim();
  if (!raw) return null;
  try {
    confine(raw);
  } catch (error) {
    return null;
  }

  const wanted = raw.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const wantedWithoutExtension = wanted.replace(/\.md$/i, "");
  const entries = cachedEntries();

  const exactPath = entries.filter((cached) => {
    const path = cached.note.path.toLowerCase();
    return path === wanted || path.replace(/\.md$/i, "") === wantedWithoutExtension;
  });
  let matches = exactPath;
  if (!matches.length) {
    matches = entries.filter((cached) => cached.note.title.toLowerCase() === wantedWithoutExtension);
  }
  if (!matches.length) {
    matches = entries.filter((cached) =>
      cached.note.title.toLowerCase().includes(wantedWithoutExtension) ||
      cached.note.path.toLowerCase().includes(wantedWithoutExtension)
    );
  }
  if (!matches.length) return null;
  if (matches.length > 1) return { ambiguous: matches.map((cached) => cached.note.path) };
  const cached = matches[0];
  return { path: cached.note.path, title: cached.note.title, body: cached.body };
}

export function appendToDaily(text) {
  requireVault();
  const now = new Date();
  const date = localDateKey(now);
  const relativeFile = `daily/${date}.md`;
  const directory = confine("daily");
  const absolute = confine(relativeFile);
  mkdirSync(directory, { recursive: true });

  const bullet = `- ${localTimeKey(now)} — ${cleanSingleLine(text)}\n`;
  if (!existsSync(absolute)) {
    try {
      writeFileSync(absolute, `# ${date}\n\n## Captured\n${bullet}`, { encoding: "utf8", flag: "wx" });
      noteCache.delete(absolute);
      return { path: relativeFile };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
  }

  const existing = readFileSync(absolute, "utf8");
  const prefix = existing.endsWith("\n") ? "" : "\n";
  const captured = /^## Captured\s*$/m.test(existing) ? "" : "\n## Captured\n";
  appendFileSync(absolute, prefix + captured + bullet, "utf8");
  noteCache.delete(absolute);
  return { path: relativeFile };
}

function reminderLines(reminders, date) {
  if (!Array.isArray(reminders)) return [];
  return reminders
    .map((reminder) => {
      const text = cleanSingleLine(
        reminder && typeof reminder === "object" ? reminder.text : reminder
      );
      if (!text) return null;
      const target = `${date}-${slug(text) || "reminder"}`;
      return `- [[${target}]] — ${text}`;
    })
    .filter(Boolean);
}

export function writeMeetingNote({ title, summary, transcript, reminders } = {}) {
  requireVault();
  const date = localDateKey();
  const safeTitle = cleanSingleLine(title) || "Meeting";
  const safeSlug = slug(safeTitle) || "meeting";
  const directory = confine("meetings");
  mkdirSync(directory, { recursive: true });

  const reminderItems = reminderLines(reminders, date);
  const sections = [
    `# ${safeTitle}`,
    "",
    "## Summary",
    String(summary == null ? "" : summary).trim() || "No summary available."
  ];
  if (reminderItems.length) {
    sections.push("", "## Reminders", ...reminderItems);
  }
  sections.push("", "## Transcript", String(transcript == null ? "" : transcript).trim(), "");
  const content = sections.join("\n");

  for (let suffix = 1; ; suffix += 1) {
    const name = `${date}-${safeSlug}${suffix === 1 ? "" : `-${suffix}`}.md`;
    const relativeFile = `meetings/${name}`;
    const absolute = confine(relativeFile);
    try {
      writeFileSync(absolute, content, { encoding: "utf8", flag: "wx" });
      noteCache.delete(absolute);
      return { path: relativeFile };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
  }
}

export function vaultGraph() {
  const entries = cachedEntries();
  const indexByPath = new Map(entries.map((cached, index) => [cached.note.path, index]));
  const edgeKeys = new Set();
  const edges = [];
  const degree = new Array(entries.length).fill(0);

  for (const cached of entries) {
    const from = indexByPath.get(cached.note.path);
    for (const link of cached.note.links) {
      const target = resolveLink(link, entries);
      if (!target) continue;
      const to = indexByPath.get(target.note.path);
      if (from === to) continue;
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      const key = `${a}:${b}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push([a, b]);
      degree[a] += 1;
      degree[b] += 1;
    }
  }

  return {
    nodes: entries.map((cached, index) => ({
      id: cached.note.path,
      title: cached.note.title,
      degree: degree[index]
    })),
    edges
  };
}

export function cappedGraph(limit = 60) {
  const graph = vaultGraph();
  const max = Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 60);
  const kept = graph.nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => b.node.degree - a.node.degree || a.index - b.index)
    .slice(0, max);
  const remap = new Map(kept.map((entry, index) => [entry.index, index]));
  return {
    nodes: kept.map((entry) => entry.node),
    edges: graph.edges
      .filter(([from, to]) => remap.has(from) && remap.has(to))
      .map(([from, to]) => [remap.get(from), remap.get(to)])
  };
}
