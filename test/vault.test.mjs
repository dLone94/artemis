import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import { basename, join, resolve } from "node:path";
import {
  appendToDaily,
  cappedGraph,
  readNote,
  scanVault,
  searchNotes,
  vaultGraph,
  writeMeetingNote
} from "../obsidianVault.js";
import { classifyIntent, needsConfirmation, toolByName } from "../toolRegistry.js";
import { MAIL_UNTRUSTED_SKILLS, UNTRUSTED_SKILLS } from "../untrusted.js";

function localDateKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function withVault(run) {
  const previous = process.env.OBSIDIAN_VAULT_PATH;
  const root = mkdtempSync(join(os.tmpdir(), "vault-"));
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    return run(root);
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function note(root, relativePath, body) {
  const path = join(root, relativePath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

test("scanVault parses wikilink aliases and headings while graph drops unresolved links", () => {
  withVault((root) => {
    note(root, "Alpha.md", "# Alpha\n\n[[Alpha]] [[Beta|alias]] [[Gamma#head]] [[Missing]]\n");
    note(root, "Beta.md", "# Beta\n");
    note(root, "Gamma.md", "# Gamma\n");

    const scan = scanVault();
    assert.deepEqual(scan.get("Alpha.md").links, ["Alpha", "Beta", "Gamma", "Missing"]);

    const graph = vaultGraph();
    assert.equal(graph.nodes.length, 3);
    assert.equal(
      graph.edges.some(([from, to]) =>
        graph.nodes[from].title === "Alpha" && graph.nodes[to].title === "Missing"
      ),
      false
    );
  });
});

test("searchNotes ranks a title match ahead of a body-only match", () => {
  withVault((root) => {
    note(root, "Ferry schedule.md", "# Ferry schedule\n\nDepartures at noon.\n");
    note(root, "Travel.md", "# Travel\n\nThe ferry departs after lunch.\n");

    const results = searchNotes("ferry");
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Ferry schedule");
    assert.equal(results[1].title, "Travel");
  });
});

test("appendToDaily creates headers once and appends captured bullets", () => {
  withVault((root) => {
    const today = localDateKey();
    const first = appendToDaily("first capture");
    const second = appendToDaily("second capture");

    assert.equal(first.path, `daily/${today}.md`);
    assert.deepEqual(second, first);
    const body = readFileSync(join(root, first.path), "utf8");
    assert.equal((body.match(new RegExp(`^# ${today}$`, "gm")) || []).length, 1);
    assert.equal((body.match(/^## Captured$/gm) || []).length, 1);
    assert.equal((body.match(/^- \d{2}:\d{2} — /gm) || []).length, 2);
    assert.match(body, /first capture/);
    assert.match(body, /second capture/);
  });
});

test("writeMeetingNote creates collision-safe slug suffixes", () => {
  withVault((root) => {
    const today = localDateKey();
    const input = {
      title: "Weekly sync",
      summary: "We checked progress.",
      transcript: "A short transcript.",
      reminders: []
    };

    const first = writeMeetingNote(input);
    const second = writeMeetingNote(input);

    assert.equal(first.path, `meetings/${today}-weekly-sync.md`);
    assert.equal(second.path, `meetings/${today}-weekly-sync-2.md`);
  });
});

test("vaultGraph reports resolved edges and undirected node degree", () => {
  withVault((root) => {
    note(root, "A.md", "# A\n\n[[B]]\n");
    note(root, "B.md", "# B\n\n[[C]]\n");
    note(root, "C.md", "# C\n");

    const graph = vaultGraph();
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.nodes.find((node) => node.title === "B").degree, 2);
  });
});

test("vault paths stay confined and unsafe meeting titles are slugged inside meetings", () => {
  withVault((root) => {
    appendToDaily("inside only");
    assert.equal(readNote("../../etc/passwd"), null);

    const result = writeMeetingNote({
      title: "../escape",
      summary: "Still inside.",
      transcript: "Still inside.",
      reminders: []
    });
    const absolute = resolve(root, result.path);
    assert.ok(absolute.startsWith(resolve(root) + "/"));
    assert.equal(basename(result.path).endsWith("-escape.md"), true);
  });
});

test("vault writes reject symlink escapes", () => {
  withVault((root) => {
    const outside = mkdtempSync(join(os.tmpdir(), "vault-outside-"));
    try {
      symlinkSync(outside, join(root, "daily"), "dir");
      assert.throws(() => appendToDaily("must stay inside"), /path escapes vault/);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("vault tools are capability-gated, routed, and taint note reads", () => {
  assert.equal(toolByName("save_note", { vault: false }), null);
  assert.equal(toolByName("save_note", { vault: true }).family, "vault");
  assert.equal(
    needsConfirmation("save_note", { tainted: true }, { vault: true }),
    true,
    "a tainted turn cannot write attacker text into the vault without a yes"
  );
  assert.equal(
    needsConfirmation("save_note", { tainted: false }, { vault: true }),
    false,
    "a user-asked note still writes without a prompt"
  );

  const save = classifyIntent("save this in my Obsidian vault", { vault: true });
  assert.equal(save.intent, "executable_action");
  assert.equal(save.family, "vault");
  assert.deepEqual(save.expected, ["save_note"]);

  const read = classifyIntent("search my Obsidian notes for ferry", { vault: true });
  assert.equal(read.intent, "executable_action");
  assert.equal(read.family, "vault_read");
  assert.deepEqual(read.expected, ["search_notes", "read_note"]);
  assert.equal(UNTRUSTED_SKILLS.has("search_notes"), true);
  assert.equal(UNTRUSTED_SKILLS.has("read_note"), true);
  assert.equal(MAIL_UNTRUSTED_SKILLS.has("search_notes"), true);
  assert.equal(MAIL_UNTRUSTED_SKILLS.has("read_note"), true);
});

test("cappedGraph keeps at most 60 high-degree nodes and remaps every edge", () => {
  withVault((root) => {
    const links = [];
    for (let index = 1; index < 70; index += 1) {
      const title = `Note ${index}`;
      links.push(`[[${title}]]`);
      note(root, `${title}.md`, `# ${title}\n`);
    }
    note(root, "Hub.md", `# Hub\n\n${links.join(" ")}\n`);

    const graph = cappedGraph();
    assert.ok(graph.nodes.length <= 60);
    assert.ok(graph.edges.every(([from, to]) =>
      from >= 0 && to >= 0 && from < graph.nodes.length && to < graph.nodes.length
    ));
  });
});
