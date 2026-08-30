// Deterministic risk classification for terminal actions.
//
// The model may decide WHAT should happen; this module decides what is ALLOWED
// to happen. It is pure, dependency-light, and unit-tested — never an LLM
// prompt. Where parsing cannot confidently determine safety it escalates
// rather than assumes safe.
//
// Risk lattice (each level strictly stronger than the last):
//   safe       — read-only inspection; runs without ceremony
//   controlled — writes inside an approved workspace, installs, builds;
//                runs, but is announced and logged
//   approval   — needs an explicit spoken/clicked yes before running
//   blocked    — refused outright (security controls, disk destruction,
//                broad data wipes); no approval path from here
//
// Workspace boundaries: a command operating inside an approved workspace does
// not automatically gain write access anywhere else. Workspaces come from
// environment discovery (ARTEMIS_WORKSPACES + the project root), never a
// hardcoded username or home directory.

import { homedir, tmpdir } from "node:os";
import { resolve, sep, basename } from "node:path";
import { redactSecrets } from "./redaction.js";

export { redactSecrets };

export const RISK = Object.freeze({ safe: 0, controlled: 1, approval: 2, blocked: 3 });
const LEVELS = ["safe", "controlled", "approval", "blocked"];

function maxRisk(a, b) {
  return RISK[a] >= RISK[b] ? a : b;
}

/** Expand a leading ~ and resolve against a base directory. */
function resolvePath(token, baseDir) {
  let p = token;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return resolve(baseDir || process.cwd(), p);
}

function isInside(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Approved working directories, discovered — not hardcoded.
 * Always includes the project root this server runs from, and the system
 * temp dir (scratch space). ARTEMIS_WORKSPACES adds more, colon-separated.
 */
export function approvedWorkspaces(env = process.env, opts = {}) {
  const roots = [];
  const add = (p) => {
    if (!p) return;
    const abs = resolvePath(String(p).trim(), opts.root || process.cwd());
    if (abs && !roots.includes(abs)) roots.push(abs);
  };
  add(opts.root || process.cwd());
  add(tmpdir());
  for (const entry of String(env.ARTEMIS_WORKSPACES || "").split(":")) add(entry);
  return roots;
}

export function pathInWorkspace(p, workspaces, baseDir) {
  const abs = resolvePath(p, baseDir);
  return workspaces.some((w) => isInside(abs, w));
}

// Reading these leaks credentials even through a "safe" command like cat.
const SENSITIVE_PATH_RE =
  /(^|\/)\.ssh(\/|$)|(^|\/)id_(rsa|ed25519|ecdsa)|keychains?(\/|$)|(^|\/)\.env(\.|$)|(^|\/)\.env$|(^|\/)(credentials|\.netrc|\.npmrc|\.aws)(\/|$)|\/etc\/(sudoers|master\.passwd|shadow)/i;

// Writing here is never a workspace matter.
const BLOCKED_WRITE_TARGET_RE = /^\/dev\/(r?disk|sd|hd)|^\/System\//;

// Read-only inspection commands. A command being here does NOT bypass the
// redirect, path-sensitivity, or operator checks below.
const SAFE_PROGRAMS = new Set([
  "pwd", "ls", "cat", "head", "tail", "less", "more", "wc", "file", "stat",
  "which", "whereis", "type", "whoami", "id", "date", "cal", "uname", "sw_vers",
  "ps", "pgrep", "top", "df", "du", "grep", "egrep", "fgrep",
  "rg", "ag", "awk", "sort", "uniq", "cut", "tr", "diff", "cmp", "wc", "echo",
  "printf", "basename", "dirname", "realpath", "readlink", "md5", "shasum",
  "true", "false", "test", "sleep", "hostname", "uptime", "lsof", "tty", "history"
]);

// Local, ordinary work: file writes inside the workspace, project installs,
// builds, dev servers, editors. Announced, never silent.
const CONTROLLED_PROGRAMS = new Set([
  "mkdir", "touch", "cp", "mv", "ln", "tee", "sed", "patch", "tar", "zip",
  "unzip", "gzip", "gunzip", "node", "python", "python3", "ruby", "swift",
  "swiftc", "make", "cmake", "cc", "gcc", "clang", "go", "cargo", "tsc",
  "curl", "wget", "open", "say", "screencapture", "pip", "pip3", "pnpm",
  "yarn", "npx", "jq", "xcodebuild", "osascript"
]);

// Explicit yes required, whatever the arguments.
const APPROVAL_PROGRAMS = new Set([
  "sudo", "doas", "su", "kill", "killall", "pkill", "chmod", "chown", "chgrp",
  "launchctl", "systemsetup", "nvram", "pmset", "scutil", "dscl", "profiles",
  "softwareupdate", "shutdown", "reboot", "halt", "ssh", "scp", "sftp",
  "rsync", "security", "codesign", "csrutil", "spctl", "networksetup",
  "installer", "mount", "umount", "crontab", "visudo", "passwd"
]);

// No approval path. These either destroy disks/filesystems or disable the
// platform's security controls.
const BLOCKED_PROGRAMS = new Set(["mkfs", "newfs", "fdisk", "asr"]);

const GIT_SAFE = new Set([
  "status", "diff", "log", "show", "branch", "blame", "describe", "rev-parse",
  "ls-files", "remote", "shortlog", "reflog", "config"
]);
const GIT_CONTROLLED = new Set([
  "add", "commit", "checkout", "switch", "restore", "merge", "rebase", "stash",
  "pull", "fetch", "init", "clone", "tag", "cherry-pick", "worktree", "apply", "mv", "rm"
]);
// push (any form), history rewriting against the remote, hard resets and
// force-cleans destroy work that may not be recoverable.
const GIT_APPROVAL = new Set(["push", "filter-branch", "filter-repo", "gc"]);

/** Strip leading VAR=value assignments; return remaining tokens. */
function stripAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  return tokens.slice(i);
}

/** Tokenize one command segment, honouring quotes. Returns null on unbalanced quotes. */
export function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < segment.length) { current += segment[i + 1]; i += 1; has = true; continue; }
    if (/\s/.test(ch)) {
      if (current || has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  if (current || has) tokens.push(current);
  return tokens;
}

/** Split a command line on shell control operators, keeping quoted/escaped literals intact. */
export function splitSegments(command) {
  const segments = [];
  const ops = [];
  let current = "";
  let quote = null;
  const s = String(command);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      current += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "\n" || ch === ";") { segments.push(current); ops.push(";"); current = ""; continue; }
    if ((ch === "&" || ch === "|") && s[i + 1] === ch) { segments.push(current); ops.push(ch + ch); current = ""; i += 1; continue; }
    if (ch === "&") { segments.push(current); ops.push("&"); current = ""; continue; }
    if (ch === "|") { segments.push(current); ops.push("|"); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return { segments: segments.map((x) => x.trim()).filter(Boolean), ops };
}

function hasUnquotedShellGrouping(command) {
  let quote = null;
  const text = String(command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'" && i + 1 < text.length) { i += 1; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === ")") return true;
  }
  return false;
}

function looksLikePath(token) {
  return token.startsWith("/") || token.startsWith("~") || token.startsWith("./") ||
    token.startsWith("../") || token === "~" || token === "." || token === "..";
}

function verdict(risk, reason) {
  return { risk, reason };
}

const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/;
const WRAPPER_PROGRAMS = new Set(["env", "nice", "nohup", "timeout", "stdbuf", "command", "time", "xargs"]);

function classifySegment(segment, { workspaces, workingDirectory }) {
  // Substitution can smuggle any command past a token classifier. Escalate.
  if (/\$\(|`|<\(|>\(/.test(segment)) {
    return verdict("approval", "command substitution can hide arbitrary commands");
  }
  const tokens = stripAssignments(tokenize(segment) || []);
  if (tokenize(segment) === null) return verdict("approval", "unbalanced quoting");
  if (!tokens.length) return verdict("safe", "empty segment");

  const rawProgram = tokens[0];
  const program = basename(rawProgram).toLowerCase();

  // Privilege/wrapper prefixes hide the real command. Classify what they wrap
  // and take the stronger of "needs approval" and the inner verdict — so
  // `sudo rm -rf /System` stays blocked, while `sudo ls` is approval.
  if (program === "sudo" || program === "doas") {
    // Strip only sudo's OWN leading flags (before the wrapped command); keep
    // the wrapped command and all of its arguments intact.
    let rest = tokens.slice(1);
    while (rest.length && rest[0].startsWith("-")) rest = rest.slice(1);
    if (!rest.length) return verdict("approval", "elevated privileges");
    const inner = classifySegment(rest.join(" "), { workspaces, workingDirectory });
    return verdict(maxRisk("approval", inner.risk), inner.risk === "blocked" ? inner.reason : `elevated privileges (${inner.reason})`);
  }

  // env/nice/timeout/… hide the real program the same way sudo does. Classify
  // the inner command and never treat the wrapper itself as read-only.
  if (WRAPPER_PROGRAMS.has(program)) {
    let rest = tokens.slice(1);
    while (rest.length && (rest[0].startsWith("-") || (program === "env" && /^\w+=/.test(rest[0])))) {
      if (rest[0] === "-u" || rest[0] === "-n" || rest[0] === "--adjustment" || rest[0] === "-s") {
        rest = rest.slice(Math.min(2, rest.length));
      } else {
        rest = rest.slice(1);
      }
    }
    if (program === "timeout" && rest.length && /^[\d.]+[smhd]?$/.test(rest[0])) rest = rest.slice(1);
    if (!rest.length) {
      return verdict("approval", program === "env" ? "dumps process environment" : `${program} wrapper`);
    }
    const inner = classifySegment(rest.join(" "), { workspaces, workingDirectory });
    return verdict(
      maxRisk("approval", inner.risk),
      inner.risk === "blocked" ? inner.reason : `via ${program} (${inner.reason})`
    );
  }

  const args = tokens.slice(1);
  const flags = args.filter((a) => a.startsWith("-"));
  const flagChars = flags.filter((f) => /^-[A-Za-z]+$/.test(f)).map((f) => f.slice(1)).join("");
  const pathArgs = args.filter((a) => !a.startsWith("-") && looksLikePath(a));
  let risk = null;
  let reason = "";

  // Redirection targets are write locations regardless of the program.
  const redirect = segment.match(/(?:^|[^>])>>?\s*([^\s;|&]+)/);
  let redirectRisk = "safe";
  if (redirect) {
    const target = redirect[1];
    if (target !== "/dev/null" && !/^&\d$/.test(target)) {
      if (BLOCKED_WRITE_TARGET_RE.test(resolvePath(target, workingDirectory))) {
        return verdict("blocked", `writes to ${target}`);
      }
      redirectRisk = pathInWorkspace(target, workspaces, workingDirectory)
        ? "controlled"
        : "approval";
      if (redirectRisk === "approval") reason = `writes outside the approved workspace (${target})`;
    }
  }

  if (FORK_BOMB_RE.test(segment)) return verdict("blocked", "fork bomb");

  if (program === "printenv") return verdict("approval", "dumps process environment");
  if ((program === "awk" || program === "gawk" || program === "mawk") &&
      args.some((a) => /system\s*\(/.test(a))) {
    return verdict("approval", "awk system() runs a command");
  }

  // Program-specific rules first — they know their own destructive shapes.
  if (program === "rm") {
    const recursive = /r/.test(flagChars) || flags.includes("--recursive") || flags.includes("-rf") || flags.includes("-fr");
    const targets = args.filter((a) => !a.startsWith("-"));
    const broad = targets.some((t) => {
      const abs = resolvePath(t, workingDirectory);
      return abs === "/" || abs === homedir() || /^\/(Users|System|Library|bin|usr|etc|var)$/.test(abs) || t === "/*" || t === "~/*";
    });
    if (recursive && broad) return verdict("blocked", "recursive deletion of a root or home directory");
    if (recursive) risk = maxRisk("approval", redirectRisk), reason = "recursive/forced deletion";
    else if (targets.every((t) => pathInWorkspace(t, workspaces, workingDirectory))) {
      risk = "controlled"; reason = "deletes files inside the workspace";
    } else {
      risk = "approval"; reason = "deletes files outside the approved workspace";
    }
    return verdict(maxRisk(risk, redirectRisk), reason);
  }

  if (program === "dd") {
    if (args.some((a) => /^of=\/dev\//.test(a))) return verdict("blocked", "raw disk write");
    return verdict("approval", "low-level copy tool");
  }

  if (program === "diskutil") {
    if (args.some((a) => /^(erase|partition|reformat|zero)/i.test(a)) ||
        (args[0] === "apfs" && /^delete/i.test(args[1] || ""))) {
      return verdict("blocked", "destructive disk operation");
    }
    return verdict("approval", "disk administration");
  }

  if (program === "csrutil" || program === "spctl") {
    if (args.some((a) => /disable/i.test(a))) return verdict("blocked", "disables a macOS security control");
    return verdict("approval", "security configuration");
  }

  if (program === "git") {
    const sub = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
    if (GIT_APPROVAL.has(sub)) {
      const force = args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || a === "--mirror");
      return verdict("approval", sub === "push" ? (force ? "force push" : "git push leaves this machine") : `git ${sub} rewrites history`);
    }
    if (sub === "reset" && args.includes("--hard")) return verdict("approval", "git reset --hard discards work");
    if (sub === "clean" && args.some((a) => /^-[a-z]*f/.test(a))) return verdict("approval", "git clean -f deletes untracked files");
    if (GIT_SAFE.has(sub)) {
      if (sub === "config" && !args.includes("--get") && args.filter((a) => !a.startsWith("-")).length > 2) {
        return verdict("controlled", "git config write");
      }
      return verdict(maxRisk("safe", redirectRisk), reason || "read-only git");
    }
    if (GIT_CONTROLLED.has(sub)) return verdict(maxRisk("controlled", redirectRisk), reason || `git ${sub} writes only local repository state`);
    return verdict("approval", `unrecognised git subcommand "${sub}"`);
  }

  if (program === "npm" || program === "pnpm" || program === "yarn") {
    const sub = (args.find((a) => !a.startsWith("-")) || "").toLowerCase();
    if (args.includes("-g") || args.includes("--global")) return verdict("approval", "global install changes the whole system");
    if (sub === "publish") return verdict("approval", "publishes a package externally");
    if (sub === "test" || sub === "ls" || sub === "view" || sub === "outdated" || sub === "audit" || !args.length) {
      return verdict(maxRisk("safe", redirectRisk), reason || "project test/inspection");
    }
    if (sub === "run") {
      const script = (args.filter((a) => !a.startsWith("-"))[1] || "").toLowerCase();
      if (/^(test|lint|typecheck|check|eval)/.test(script)) return verdict(maxRisk("safe", redirectRisk), reason || "existing test/lint script");
      return verdict(maxRisk("controlled", redirectRisk), reason || "project script");
    }
    return verdict(maxRisk("controlled", redirectRisk), reason || "project package management");
  }

  if (program === "brew") {
    const sub = (args[0] || "").toLowerCase();
    if (["list", "info", "search", "--version", "config", "doctor"].includes(sub)) return verdict("safe", "brew inspection");
    return verdict("approval", "installs system-wide software");
  }

  if (program === "defaults") {
    return (args[0] || "").toLowerCase() === "read"
      ? verdict("safe", "defaults read")
      : verdict("approval", "modifies system preferences");
  }

  if (program === "chmod" || program === "chown" || program === "chgrp") {
    const recursive = /R/.test(flagChars) || flags.includes("--recursive");
    const inWs = pathArgs.length > 0 && pathArgs.every((p) => pathInWorkspace(p, workspaces, workingDirectory));
    if (!recursive && inWs) return verdict("controlled", "permission change inside the workspace");
    return verdict("approval", recursive ? "recursive permission change" : "permission change outside the workspace");
  }

  if (program === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")) {
    return verdict("approval", "find with -delete/-exec acts, not just reads");
  }

  if (BLOCKED_PROGRAMS.has(program) || /^mkfs(\.|$)/.test(program)) {
    return verdict("blocked", "filesystem/disk destruction tool");
  }
  if (APPROVAL_PROGRAMS.has(program)) {
    return verdict("approval", program === "sudo" ? "elevated privileges" : `${program} needs explicit approval`);
  }

  // Sensitive reads: cat ~/.ssh/id_rsa is "safe" by program, not by consequence.
  if (pathArgs.some((p) => SENSITIVE_PATH_RE.test(resolvePath(p, workingDirectory))) ||
      args.some((a) => SENSITIVE_PATH_RE.test(a))) {
    return verdict("approval", "touches credential/secret paths");
  }

  if (SAFE_PROGRAMS.has(program)) {
    if (program === "sed" && flags.some((f) => f === "-i" || f.startsWith("-i"))) {
      return verdict(maxRisk("controlled", redirectRisk), "sed -i edits files in place");
    }
    return verdict(maxRisk("safe", redirectRisk), reason || "read-only inspection");
  }

  if (CONTROLLED_PROGRAMS.has(program)) {
    // A write-capable tool pointed outside the workspace is no longer routine.
    const outside = pathArgs.some((p) => !pathInWorkspace(p, workspaces, workingDirectory));
    if (outside && ["cp", "mv", "ln", "tee", "mkdir", "touch", "tar", "unzip", "sed", "patch"].includes(program)) {
      return verdict("approval", "writes outside the approved workspace");
    }
    return verdict(maxRisk("controlled", redirectRisk), reason || "project-local tool");
  }

  // Unknown program: escalate rather than assume safe. A bare word with no
  // arguments (the user's own alias, e.g. "ai") stays controlled — the user
  // dictated the exact text and it takes no paths. Anything with arguments
  // is unknown surface area.
  if (!args.length) return verdict("controlled", `"${program}" is not a known command; running it bare inside the workspace`);
  return verdict("approval", `"${program}" is not a known command`);
}

/**
 * Classify a full command line.
 * @param {string} command
 * @param {{workspaces?: string[], workingDirectory?: string, env?: object}} opts
 * @returns {{risk: "safe"|"controlled"|"approval"|"blocked", reason: string, segments: number}}
 */
export function classifyCommand(command, opts = {}) {
  const text = String(command || "").trim();
  if (!text) return { risk: "blocked", reason: "empty command", segments: 0 };
  if (text.length > 4000) return { risk: "approval", reason: "unusually long command", segments: 0 };
  // Fork bomb is checked on the whole line: segment splitting on | and ; would
  // otherwise break the pattern apart before any segment sees it.
  if (FORK_BOMB_RE.test(text)) return { risk: "blocked", reason: "fork bomb", segments: 0 };
  const workspaces = opts.workspaces || approvedWorkspaces(opts.env || process.env, opts);
  const workingDirectory = opts.workingDirectory || workspaces[0];

  const { segments, ops } = splitSegments(text);
  if (!segments.length) return { risk: "blocked", reason: "empty command", segments: 0 };

  let risk = "safe";
  let reason = "read-only";
  if (ops.includes("&")) {
    risk = "approval";
    reason = "background execution escapes process ownership";
  }
  if (hasUnquotedShellGrouping(text)) {
    risk = "approval";
    reason = "subshell grouping requires approval";
  }
  // Piping anything into a shell executes unvetted text.
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i] === "|") {
      const next = stripAssignments(tokenize(segments[i + 1] || "") || [])[0] || "";
      if (["sh", "bash", "zsh", "ksh", "dash"].includes(basename(next))) {
        risk = maxRisk(risk, "approval");
        reason = "pipes content into a shell";
      }
    }
  }
  for (const segment of segments) {
    const v = classifySegment(segment, { workspaces, workingDirectory });
    if (RISK[v.risk] > RISK[risk]) { risk = v.risk; reason = v.reason; }
    if (risk === "blocked") break;
  }
  return { risk, reason, segments: segments.length };
}

/** Validate a requested working directory against the workspaces. */
export function resolveWorkingDirectory(requested, opts = {}) {
  const workspaces = opts.workspaces || approvedWorkspaces(opts.env || process.env, opts);
  if (!requested) return { ok: true, dir: workspaces[0] };
  const abs = resolvePath(String(requested), workspaces[0]);
  if (workspaces.some((w) => isInside(abs, w))) return { ok: true, dir: abs };
  return {
    ok: false,
    dir: null,
    error: `${abs} is outside the approved workspace${workspaces.length > 1 ? "s" : ""} (${workspaces.join(", ")})`
  };
}

// ---- interactive-input policy (TUI keystrokes, NOT shell commands) ---------
// A digit answered to a menu, a "y" to a prompt, a bare Enter: their risk is
// whatever the visible prompt/option DOES, which no shell classifier can see.
// Allowlist-shaped: auto-execution needs a positive reason; every unknown or
// opaque interactive effect confirms first.

// The visible prompt/option describes a consequential effect — one Artemis
// confirmation even when the user explicitly addressed it.
const DESTRUCTIVE_PROMPT_RE =
  /\b(delete|remove|erase|overwrite|uninstall|reset|force|push|deploy|pay|payment|purchase|send|grant|always\s+allow|allow\s+always|all\s+files|sudo|permissions?|permanent(?:ly)?|wipe|destroy|drop|shutdown|reboot|format)\b/i;

// A selector whose class is known benign: choosing a model, language, theme…
const BENIGN_SELECTOR_RE =
  /\b(?:choose|select|pick|set)\b[^\n]{0,40}\b(?:model|language|theme|voice|tone|colou?r|font|provider|profile|editor|style|mode)\b/i;

// A label that names no effect at all — "Yes", "Continue" — is opaque: it can
// authorize anything the program has in flight.
const OPAQUE_TOKEN_RE = /^(?:yes|no|y|n|ok(?:ay)?|continue|proceed|confirm|accept|cancel|next|done|approve|allow|apply|deny|install|update|upgrade|run|start|stop|enable|disable|submit)$/i;

/**
 * Decide whether one interactive keystroke may run without a spoken yes.
 *
 * @param {{payload?: string, optionLabel?: string, promptHeader?: string,
 *          promptKind?: string|null, userNamed?: boolean, selfTyped?: boolean}} input
 *   userNamed — the user themselves described the effect (spoke the label or
 *               dictated the answer); selfTyped — submitting text Artemis
 *               typed earlier in this same turn.
 * @returns {{auto: boolean, reason: string}}
 */
export function classifyInteractiveInput(input = {}) {
  const label = String(input.optionLabel || "").trim();
  const header = String(input.promptHeader || "").trim();
  const surface = `${label} ${header}`.trim();
  // 1. A consequential visible effect confirms — even explicitly addressed.
  if (DESTRUCTIVE_PROMPT_RE.test(surface)) {
    return { auto: false, reason: "the visible prompt looks consequential" };
  }
  // 2. An opaque label confirms even when the user spoke it: "select Continue"
  //    names a token, not an effect (Codex r3 #3 / inspection ordering fix).
  if (label && OPAQUE_TOKEN_RE.test(label)) {
    return { auto: false, reason: `the option just says "${label}" — its effect is opaque` };
  }
  // 3. Bare Enter activates whatever is highlighted: auto only for text
  //    Artemis itself just typed, or a recognized benign prompt class.
  if (input.payload === "\n") {
    if (input.selfTyped) return { auto: true, reason: "submitting text Artemis just typed" };
    if (BENIGN_SELECTOR_RE.test(header)) return { auto: true, reason: "a recognized benign selector" };
    return { auto: false, reason: "Enter would activate an unknown control" };
  }
  // 4. A user-described effect needs VISIBLE evidence to ride on — dictating
  //    "type y" at a blank shell earns no interactive bypass.
  if (input.userNamed && (input.promptKind || header)) {
    return { auto: true, reason: "the user named the effect themselves" };
  }
  if (input.selfTyped) return { auto: true, reason: "submitting text Artemis just typed" };
  if (BENIGN_SELECTOR_RE.test(header)) {
    return { auto: true, reason: "a recognized benign selector" };
  }
  return { auto: false, reason: "unrecognized interactive effect" };
}

export function riskAtLeast(risk, floor) {
  return RISK[risk] >= RISK[floor];
}

export const RISK_LEVELS = LEVELS;
