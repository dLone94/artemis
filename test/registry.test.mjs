// Unit tests for the reliability backbone: the tool registry and the TTS policy.
// These are pure — no network, no model, no browser — which is the point: the
// rules that decide whether Artemis acts and whether she speaks are now testable
// in isolation instead of buried in a streaming loop and a browser timer.
// Run: node test/registry.test.mjs
import assert from "node:assert";
import {
  availableTools,
  openaiToolDefs,
  toolDefsForFamily,
  validateToolCall,
  needsConfirmation,
  classifyIntent
} from "../toolRegistry.js";
import { shouldSpeakFiller, fillerFor, mayStreamNarration, failureLine, INTENT } from "../public/ttsPolicy.js";

const ALL = { search: true, gmail: true };
const NO_MAIL = { search: true, gmail: false };

// ---- availability -----------------------------------------------------------
{
  const names = availableTools(ALL).map((t) => t.name);
  assert.ok(names.includes("open_url") && names.includes("web_search"), "core tools are offered");

  const withoutMail = availableTools(NO_MAIL).map((t) => t.name);
  assert.ok(!withoutMail.includes("check_email"), "an unconfigured capability is not advertised to the model");
  assert.ok(withoutMail.includes("open_url"), "unrelated tools are unaffected");

  // the schemas the model sees come from the same place as everything else
  const defs = openaiToolDefs(NO_MAIL);
  assert.equal(defs.length, withoutMail.length, "tool defs match the available set exactly");
  assert.ok(defs.every((d) => d.type === "function" && d.function.name && d.function.parameters), "defs are well-formed");
  console.log("  ✓ availability gates what the model is even offered");
}

// ---- validation happens before anything is recorded -------------------------
{
  assert.equal(validateToolCall("open_url", { url: "https://example.com" }, ALL).ok, true, "a good call passes");
  assert.equal(validateToolCall("open_url", {}, ALL).ok, false, "missing required arg is rejected");
  assert.equal(validateToolCall("open_url", { url: "" }, ALL).ok, false, "empty required string is rejected");
  assert.equal(validateToolCall("open_url", { url: 42 }, ALL).ok, false, "wrong type is rejected");
  assert.equal(validateToolCall("open_url", "{not json", ALL).ok, false, "unparseable arguments are rejected");
  assert.equal(validateToolCall("no_such_tool", {}, ALL).ok, false, "unknown tool is rejected");

  // string arguments arrive from the model as JSON text — that must work
  const parsed = validateToolCall("play_media", '{"query":"lofi"}', ALL);
  assert.equal(parsed.ok, true, "JSON-string arguments are parsed");
  assert.equal(parsed.args.query, "lofi");

  // an unconfigured tool fails with a reason the user can act on
  const mail = validateToolCall("check_email", {}, NO_MAIL);
  assert.equal(mail.ok, false);
  assert.match(mail.error, /not available/, "unavailable reads as unavailable, not as unknown");

  // extra keys are tolerated: models sprinkle them and it's harmless
  assert.equal(validateToolCall("open_url", { url: "https://x.dev", nonsense: 1 }, ALL).ok, true);
  console.log("  ✓ malformed / unknown / unavailable calls are refused before execution");
}

// ---- three-way intent classification ----------------------------------------
{
  const action = classifyIntent("open youtube", ALL);
  assert.equal(action.intent, "executable_action");
  assert.equal(action.family, "navigate");
  assert.ok(action.expected.includes("open_url"), "the expected tool set comes from the registry");

  assert.equal(classifyIntent("play some lofi", ALL).family, "media");
  assert.equal(classifyIntent("check my email", ALL).family, "email");
  assert.equal(classifyIntent("remind me in ten minutes to stretch", ALL).family, "reminder");

  // conversation must NOT be forced into a tool — that was the other half of
  // the requirement: she has to be able to just talk
  for (const chat of ["what do you think about jazz", "how are you", "thanks, that was helpful", "tell me a joke"]) {
    assert.equal(classifyIntent(chat, ALL).intent, "chat", `"${chat}" is conversation`);
  }

  // an unconfigured family can't produce an action turn
  assert.equal(classifyIntent("check my email", NO_MAIL).intent, "chat", "no gmail → not an executable action");

  // an explicitly negated action is conversation — the recall bias must not
  // turn "don't open anything" into an open
  for (const negated of ["don't open anything, just tell me what youtube.com is", "do not play any music", "without opening it, what is that site?"]) {
    assert.equal(classifyIntent(negated, ALL).intent, "chat", `"${negated}" must not force a tool`);
  }

  // a bare pronoun with nothing to point at gets a question, not a guess
  const vague = classifyIntent("open it", ALL, []);
  assert.equal(vague.intent, "needs_clarification");
  assert.equal(classifyIntent("play that one", ALL, []).intent, "needs_clarification", "'play that one' is unresolved too");

  // …but the same words resolve once the conversation supplies a referent
  const withRef = classifyIntent("open it", ALL, [{ role: "assistant", content: "I found https://example.com/thing" }]);
  assert.equal(withRef.intent, "executable_action", "a referent in context makes it actionable");
  console.log("  ✓ chat / needs_clarification / executable_action split correctly");
}

// ---- family filtering -------------------------------------------------------
{
  const nav = toolDefsForFamily(ALL, "navigate").map((d) => d.function.name);
  assert.deepEqual(nav, ["open_url"], "forcing a navigate turn can only pick open_url");
  const mail = toolDefsForFamily(ALL, "email").map((d) => d.function.name).sort();
  assert.deepEqual(mail, ["check_email", "read_email"]);
  console.log("  ✓ forcing is narrowed to the family the user asked about");
}

// ---- confirmation policy ----------------------------------------------------
{
  assert.equal(needsConfirmation("send_message", {}, ALL), true, "an external send always confirms");
  assert.equal(needsConfirmation("open_url", {}, ALL), false, "opening a tab does not");
  assert.equal(needsConfirmation("recall_notes", {}, ALL), false, "a read does not");
  // a local write the user asked for directly runs; the same write on a turn
  // that just ingested an email does not — that request may not be the user's
  assert.equal(needsConfirmation("remember_note", { tainted: false }, ALL), false);
  assert.equal(needsConfirmation("remember_note", { tainted: true }, ALL), true, "mutation after untrusted read confirms");
  assert.equal(needsConfirmation("set_reminder", { tainted: true }, ALL), true);
  console.log("  ✓ confirmation policy: external always, mutations once untrusted text is in play");
}

// ---- TTS policy -------------------------------------------------------------
{
  // the bug, as an assertion
  assert.equal(shouldSpeakFiller({ intentClass: INTENT.ACTION }), false, "never fill silence on an action turn");
  assert.equal(shouldSpeakFiller({ intentClass: null }), false, "unknown intent stays silent");
  assert.equal(shouldSpeakFiller({ intentClass: INTENT.CLARIFY }), false);
  assert.equal(shouldSpeakFiller({ intentClass: INTENT.CHAT }), true, "conversation may still get a backchannel");
  assert.equal(shouldSpeakFiller({ intentClass: INTENT.CHAT, gotToken: true }), false, "no filler once real text arrived");
  assert.equal(shouldSpeakFiller({ intentClass: INTENT.CHAT, busy: false }), false, "no filler after the turn ended");

  assert.equal(fillerFor(INTENT.ACTION), null, "no phrase to say on an action turn");
  assert.equal(typeof fillerFor(INTENT.CHAT, () => 0), "string");

  // server-side twin: narration is withheld until the action is real
  assert.equal(mayStreamNarration({ intentClass: INTENT.ACTION, actionSatisfied: false }), false);
  assert.equal(mayStreamNarration({ intentClass: INTENT.ACTION, actionSatisfied: true }), true);
  assert.equal(mayStreamNarration({ intentClass: INTENT.CHAT, actionSatisfied: false }), true);

  assert.match(failureLine("navigate"), /couldn't open/i);
  assert.match(failureLine(null), /couldn't do that/i);
  console.log("  ✓ TTS policy: no spoken promise on a turn that hasn't done anything");
}

console.log("PASS ✅  registry: availability, validation, intent, confirmation and speech policy all hold");
