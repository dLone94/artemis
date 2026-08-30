// Routing precedence: a specific local system intent must outrank the generic
// browser "open X" shortcut — on BOTH sides of the wire.
//
// Regression: saying "Open Terminal." opened a Google search for "terminal".
// The client's resolveOpenIntent (public/siteRegistry.js) runs before ask(),
// swallowed the phrase, and built a search URL — the server's deterministic
// computer routing never saw the request. The client must yield local-app
// targets to the assistant, and the server must classify every open-terminal
// phrasing as computer_control — while web navigation keeps working.
//
// Run: node --test test/openIntent.test.mjs
import test from "node:test";
import assert from "node:assert";
import { resolveOpenIntent } from "../public/siteRegistry.js";
import { classifyIntent } from "../toolRegistry.js";

const CAPS = { search: true, gmail: true, vault: true };

// ---- client side: the browser shortcut must yield Terminal to the assistant

test("client: open-terminal phrasings are NOT swallowed by the browser shortcut", () => {
  for (const phrase of [
    "Open Terminal.",
    "Open the Terminal",
    "open terminal",
    "Launch Terminal",
    "Launch the Terminal",
    "Show Terminal",
    "Bring up Terminal",
    "open up terminal",
    "Open Terminal.app",
    "open the terminal app"
  ]) {
    assert.equal(resolveOpenIntent(phrase), null,
      `"${phrase}" must fall through to the assistant, not the browser`);
  }
});

test("client: web navigation still resolves", () => {
  const domain = resolveOpenIntent("open google.com");
  assert.ok(domain && domain.url === "https://google.com" && domain.kind === "url", "bare domains still open");
  const full = resolveOpenIntent("Open https://openai.com");
  assert.ok(full && full.url === "https://openai.com" && full.kind === "url", "explicit URLs still open");
  const site = resolveOpenIntent("open youtube");
  assert.ok(site && site.kind === "registry" && /youtube/.test(site.url), "registry sites still open");
});

test("client: app-like names are NEVER swallowed into a Google search", () => {
  for (const phrase of [
    "Open WhatsApp",
    "Open Settings",
    "Open ONYX Scribe",
    "open onyx scribe.app",
    "open hacker news" // unknown target: the assistant decides, not a search URL
  ]) {
    assert.equal(resolveOpenIntent(phrase), null,
      `"${phrase}" must fall through to the assistant, not the browser`);
  }
});

// ---- server side: possible app names carry openTarget for the resolver

test("server: open-app phrasings carry a cleaned openTarget", () => {
  for (const [phrase, target] of [
    ["Open WhatsApp", "whatsapp"],
    ["Open Settings", "settings"],
    ["Open System Settings", "system settings"],
    ["Open ONYX Scribe", "onyx scribe"],
    ["Open ONYX Scribe.app", "onyx scribe.app"],
    ["launch Spotify", "spotify"]
  ]) {
    const intent = classifyIntent(phrase, CAPS, []);
    assert.equal(intent.family, "navigate", `"${phrase}" stays in the navigate family`);
    assert.equal(intent.openTarget, target, `"${phrase}" carries openTarget "${target}"`);
  }
});

test("server: web-shaped opens never carry an app target", () => {
  for (const phrase of [
    "open google.com",
    "Open https://openai.com",
    "open youtube",
    "Open WhatsApp Web",
    "Open a webpage about ONYX Scribe",
    "Open the OpenAI website",
    "pull up Emilia's Café in Sofia on the map"
  ]) {
    const intent = classifyIntent(phrase, CAPS, []);
    assert.ok(!intent.openTarget, `"${phrase}" must not read as an app launch (got "${intent.openTarget}")`);
  }
  const search = classifyIntent("Search Google for WhatsApp", CAPS, []);
  assert.ok(!search.openTarget && search.family !== "navigate", "an explicit search is never an app launch");
});

// ---- server side: classifyIntent must put Terminal in the computer family

test("server: every open-terminal phrasing classifies as computer_control/open_terminal", () => {
  for (const phrase of [
    "Open Terminal.",
    "Open the Terminal",
    "Launch Terminal",
    "Launch the Terminal",
    "Show Terminal",
    "Focus Terminal",
    "Bring up Terminal",
    "bring up the terminal",
    "Open Terminal.app"
  ]) {
    const intent = classifyIntent(phrase, CAPS, []);
    assert.equal(intent.family, "computer", `"${phrase}" routes to the computer family, got ${intent.family}`);
    assert.equal(intent.computerAction, "open_terminal", `"${phrase}" derives open_terminal`);
    assert.deepEqual(intent.expected, ["computer_control"], `"${phrase}" expects the computer_control tool`);
  }
});

test("server: web navigation and search are untouched", () => {
  for (const phrase of ["open google.com", "Open https://openai.com", "Open the OpenAI website"]) {
    const intent = classifyIntent(phrase, CAPS, []);
    assert.equal(intent.family, "navigate", `"${phrase}" stays browser navigation, got ${intent.family}`);
    assert.ok(!intent.computerAction, `"${phrase}" derives no computer action`);
  }
  const search = classifyIntent("Search Google for terminal commands", CAPS, []);
  assert.notEqual(search.family, "computer", "a search ABOUT terminal is not an open-terminal command");
  assert.notEqual(search.computerAction, "open_terminal", "no terminal action for a web search");
});

test("server: the word Terminal inside a web request does not launch Terminal", () => {
  const intent = classifyIntent("Open a webpage about Terminal", CAPS, []);
  assert.notEqual(intent.family, "computer", "webpage-about-terminal is not app control");
  assert.ok(!intent.computerAction, "no open_terminal action derived");
});

test("server: instructional questions never auto-execute", () => {
  for (const phrase of ["Tell me how to open Terminal", "how do I open the terminal?", "explain how to open terminal"]) {
    const intent = classifyIntent(phrase, CAPS, []);
    assert.notEqual(intent.intent, "executable_action", `"${phrase}" is a question, not a command (got ${intent.intent})`);
    assert.ok(!intent.computerAction, `"${phrase}" must not derive an executable terminal action`);
  }
});

test("server: gym status questions stay actionable despite the how-to guard", () => {
  const intent = classifyIntent("how long left", CAPS, []);
  assert.equal(intent.family, "gym", "\"how long left\" still routes to the gym family");
  assert.equal(intent.intent, "executable_action", "status questions remain executable");
});
