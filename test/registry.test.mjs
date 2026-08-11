// Unit tests for the reliability backbone: the tool registry and the TTS policy.
// These are pure — no network, no model, no browser — which is the point: the
// rules that decide whether Artemis acts and whether she speaks are now testable
// in isolation instead of buried in a streaming loop and a browser timer.
// Run: node test/registry.test.mjs
import assert from "node:assert";
import {
  availableTools,
  neutralToolDefs,
  neutralToolDefsForFamily,
  anthropicToolDefs,
  openaiToolDefs,
  toolDefsForFamily,
  validateToolCall,
  needsConfirmation,
  classifyIntent
} from "../toolRegistry.js";
import { skillToolDefs } from "../skills.js";
import { shouldSpeakFiller, mayStreamNarration, failureLine, INTENT } from "../public/ttsPolicy.js";

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

// ---- Phase 1b: tools have ONE neutral origin --------------------------------
// Every def in this codebase is born as {name, description, parameters} and is
// rendered into a wire format only by a provider adapter. Two things must hold:
// nothing upstream may leak a wire shape, and the OpenAI rendering must not move
// by a single byte — server.js hashes it into `toolRegistryHash` for eval
// provenance, so a change there silently reclassifies every past eval run.
{
  // 1. the origin is neutral: skills.js emits `parameters`, never `input_schema`
  const skillDefs = skillToolDefs({ includeDirect: true });
  assert.ok(skillDefs.length > 0, "there are skills to check");
  assert.ok(skillDefs.every((d) => "parameters" in d), "every skill def carries `parameters`");
  assert.ok(
    skillDefs.every((d) => !("input_schema" in d)),
    "no skill def carries Anthropic's `input_schema` — the origin has no wire format"
  );

  // 2. the neutral accessor is the whole registry, in neutral shape
  const neutral = neutralToolDefs(ALL);
  assert.equal(neutral.length, availableTools(ALL).length, "neutral defs cover every available tool");
  assert.ok(
    neutral.every((d) => Object.keys(d).join(",") === "name,description,parameters"),
    "a neutral def is exactly {name, description, parameters}"
  );

  // 3. BYTE GUARD: openaiToolDefs is neutralToolDefs wrapped, and nothing else.
  //    Built here from the neutral list so the wrapper shape AND the key order
  //    are both asserted — JSON.stringify preserves insertion order.
  const expectedOpenai = neutral.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters }
  }));
  assert.equal(
    JSON.stringify(openaiToolDefs(ALL)),
    JSON.stringify(expectedOpenai),
    "openaiToolDefs is byte-identical to the pre-Phase-1b shape (protects toolRegistryHash)"
  );

  // the family slice is the same rendering, so it must hold there too
  const expectedFamily = neutralToolDefsForFamily(ALL, "email").map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters }
  }));
  assert.ok(expectedFamily.length > 0, "the email family is non-empty");
  assert.equal(JSON.stringify(toolDefsForFamily(ALL, "email")), JSON.stringify(expectedFamily));

  // 4. the Anthropic rendering still renames the key, and only the key
  const anth = anthropicToolDefs(ALL);
  assert.equal(anth.length, neutral.length, "same tools, different dialect");
  assert.ok(
    anth.every((d) => Object.keys(d).join(",") === "name,description,input_schema"),
    "anthropicToolDefs entries are {name, description, input_schema}"
  );
  assert.deepEqual(anth.map((d) => d.input_schema), neutral.map((d) => d.parameters), "only the key name changed");

  console.log("  ✓ one neutral tool origin; OpenAI defs byte-identical, Anthropic defs still input_schema");
}

// ---- validation happens before anything is recorded -------------------------
{
  assert.equal(validateToolCall("open_url", { url: "https://example.com" }, ALL).ok, true, "a good call passes");
  assert.equal(validateToolCall("open_url", {}, ALL).ok, false, "missing required arg is rejected");
  assert.equal(validateToolCall("open_url", { url: "" }, ALL).ok, false, "empty required string is rejected");
  assert.equal(validateToolCall("open_url", { url: 42 }, ALL).ok, false, "wrong type is rejected");
  assert.equal(validateToolCall("open_url", "{not json", ALL).ok, false, "unparseable arguments are rejected");
  assert.equal(validateToolCall("no_such_tool", {}, ALL).ok, false, "unknown tool is rejected");

  // A union-typed argument accepts either shape. log_set declares reps that way
  // because a provider validates the model's generation against the schema we
  // publish, and an integer-only reps cost a live turn a 400 when the model
  // quoted the number next to its string-typed sibling.
  const quotedReps = validateToolCall("log_set", {
    exercise: "bench press", weight_value: "80", unit: "kg", reps: "8",
    raw_answer: "bench press eighty kilos eight reps"
  }, ALL);
  assert.equal(quotedReps.ok, true, "a quoted whole number passes the union type");
  const plainReps = validateToolCall("log_set", {
    exercise: "bench press", weight_value: "80", unit: "kg", reps: 8,
    raw_answer: "bench press eighty kilos eight reps"
  }, ALL);
  assert.equal(plainReps.ok, true, "an integer still passes the union type");
  const badReps = validateToolCall("log_set", {
    exercise: "bench press", weight_value: "80", unit: "kg", reps: true,
    raw_answer: "bench press eighty kilos eight reps"
  }, ALL);
  assert.equal(badReps.ok, false, "a union type is not a free pass for any shape");

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

  // Deleting mail is only OFFERED on the email_delete route (delete_email is
  // forceFamilies-gated), so a phrasing that misses this pattern makes deletion
  // impossible before any model is involved. Measured against a real report:
  // "delete the unread ones" — what a person says right after she reads the
  // inbox aloud — routed to plain "email" and the tool was never on the table.
  for (const phrase of [
    "delete the unread emails", "delete the unread ones", "trash the unread ones",
    "get rid of the unread ones", "clear the unread ones",
    "delete the first one", "delete number 2", "clear my inbox"
  ]) {
    assert.equal(classifyIntent(phrase, ALL).family, "email_delete", `"${phrase}" must reach delete_email`);
  }
  // ...without swallowing the other things a person deletes.
  for (const [phrase, family] of [
    ["delete the unread messages", "messages"],
    ["delete my reminders", "reminder"],
    ["clear my notes", "memory"]
  ]) {
    assert.equal(classifyIntent(phrase, ALL).family, family, `"${phrase}" is not email deletion`);
  }
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

// ---- research must not swallow ordinary research ----------------------------
// Regression: the research family originally matched bare "research" and "look
// into", so "research what's on Hacker News" forced the INVESTMENT brief. An
// investment brief about Hacker News is a worse answer than no answer.
{
  const notFinance = [
    "research what is on Hacker News about rust",
    "look into GitHub projects for onnx",
    "research the best coffee in Sofia",
    "dig into that error message",
    "look into why the build is slow"
  ];
  for (const q of notFinance) {
    assert.notEqual(classifyIntent(q, ALL).family, "research", `"${q}" is not an investment question`);
  }

  const finance = [
    "research Kenyan treasury bills",
    "look into Nigerian eurobonds",
    "is a global index fund a good investment",
    "should I invest in gold",
    "worth investing in South African property",
    "analyse emerging market bond yields",
    "dig into MSCI world ETF",
    "research REITs in Kenya"
  ];
  for (const q of finance) {
    const c = classifyIntent(q, ALL);
    assert.equal(c.family, "research", `"${q}" is an investment question`);
    assert.ok(c.expected.includes("research_investment"), "and forces the research skill");
  }
  console.log("  ✓ investment research is recognised without swallowing ordinary research");
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
  // The bug, as an assertion. There is no turn of any kind on which she
  // announces that she is about to answer — a canned "let me check" was the
  // single most robotic thing she did, and on an action turn it was a promise
  // the client had no standing to make.
  for (const cls of [INTENT.ACTION, INTENT.CHAT, INTENT.CLARIFY, null, undefined]) {
    assert.equal(shouldSpeakFiller({ intentClass: cls }), false, `no filler for intent ${cls}`);
  }
  assert.equal(shouldSpeakFiller(), false, "no filler even with no arguments");

  // server-side twin: narration is withheld until the action is real
  assert.equal(mayStreamNarration({ intentClass: INTENT.ACTION, actionSatisfied: false }), false);
  assert.equal(mayStreamNarration({ intentClass: INTENT.ACTION, actionSatisfied: true }), true);
  assert.equal(mayStreamNarration({ intentClass: INTENT.CHAT, actionSatisfied: false }), true);

  assert.match(failureLine("navigate"), /couldn't open/i);
  assert.match(failureLine(null), /couldn't do that/i);
  console.log("  ✓ TTS policy: no spoken promise on a turn that hasn't done anything");
}

console.log("PASS ✅  registry: availability, validation, intent, confirmation and speech policy all hold");
