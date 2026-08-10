// Provider wire-format contract. Phase 1's whole promise is that extracting the
// translation changed NOTHING on the wire, so the decisive assertions compare
// the adapter's output against a hand-written literal of the body server.js
// used to build inline — key order included, because JSON.stringify preserves it.
//
// Run: node --test test/modelProvider.test.mjs
import assert from "node:assert";
import test from "node:test";

const { WIRE, adapterFor } = await import("../modelProvider.js");
const openaiCompat = await import("../providers/openaiCompat.js");
const anthropic = await import("../providers/anthropic.js");

// Three tools in the neutral shape the registry stores (openaiToolDefs' inner
// `function` object / anthropicToolDefs' pre-rename input).
const NEUTRAL_TOOLS = [
  {
    name: "open_url",
    description: "Open a URL in the user's browser.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
  },
  {
    name: "check_email",
    description: "Read unread mail.",
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } } }
  },
  {
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  }
];

const MESSAGES = [
  { role: "system", content: "detailed thinking off\n\nYou are Artemis." },
  { role: "user", content: "open youtube" }
];

test("adapterFor returns the module for each wire format", () => {
  assert.equal(adapterFor(WIRE.OPENAI), openaiCompat);
  assert.equal(adapterFor(WIRE.ANTHROPIC), anthropic);
  assert.throws(() => adapterFor("gemini"), /unknown wire format/);
});

// ---- OpenAI-compatible: byte-identical request bodies -----------------------

test("openaiCompat.toWire matches the inline /chat/completions body byte for byte", () => {
  const req = {
    messages: MESSAGES,
    tools: NEUTRAL_TOOLS,
    toolChoice: "required",
    maxTokens: 1024,
    temperature: 0.3,
    stream: true
  };

  // Exactly what streamNvidia used to build inline (minus `model`, which the
  // caller still prepends, and minus brainRequestExtras, appended after).
  const expected = {
    messages: MESSAGES,
    tools: [
      { type: "function", function: { name: "open_url", description: NEUTRAL_TOOLS[0].description, parameters: NEUTRAL_TOOLS[0].parameters } },
      { type: "function", function: { name: "check_email", description: NEUTRAL_TOOLS[1].description, parameters: NEUTRAL_TOOLS[1].parameters } },
      { type: "function", function: { name: "web_search", description: NEUTRAL_TOOLS[2].description, parameters: NEUTRAL_TOOLS[2].parameters } }
    ],
    tool_choice: "required",
    max_tokens: 1024,
    temperature: 0.3,
    stream: true
  };

  assert.equal(JSON.stringify(openaiCompat.toWire(req)), JSON.stringify(expected));
});

test("openaiCompat.toWire keeps a forced single-function tool_choice object verbatim", () => {
  const toolChoice = { type: "function", function: { name: "open_url" } };
  const wire = openaiCompat.toWire({ messages: MESSAGES, tools: [NEUTRAL_TOOLS[0]], toolChoice, maxTokens: 256, temperature: 0 });
  assert.equal(
    JSON.stringify(wire),
    JSON.stringify({
      messages: MESSAGES,
      tools: [{ type: "function", function: { name: "open_url", description: NEUTRAL_TOOLS[0].description, parameters: NEUTRAL_TOOLS[0].parameters } }],
      tool_choice: toolChoice,
      max_tokens: 256,
      temperature: 0
    })
  );
});

test("openaiCompat.toWire omits keys the tool-free call sites never sent", () => {
  // completeMeetingModel: messages + max_tokens + temperature, nothing else.
  const wire = openaiCompat.toWire({
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    maxTokens: 1600,
    temperature: 0.1
  });
  assert.equal(
    JSON.stringify(wire),
    JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], max_tokens: 1600, temperature: 0.1 })
  );
  assert.deepEqual(Object.keys(wire), ["messages", "max_tokens", "temperature"]);
});

test("openaiCompat.toWire preserves the streaming body's full key order after model/extras merge", () => {
  const merged = Object.assign(
    { model: "llama-3.3-70b-versatile" },
    openaiCompat.toWire({ messages: MESSAGES, tools: NEUTRAL_TOOLS, toolChoice: "auto", maxTokens: 1024, temperature: 0.3, stream: true }),
    { reasoning_effort: "none" }
  );
  assert.deepEqual(Object.keys(merged), [
    "model",
    "messages",
    "tools",
    "tool_choice",
    "max_tokens",
    "temperature",
    "stream",
    "reasoning_effort"
  ]);
});

// ---- OpenAI-compatible: response parsing -----------------------------------

test("openaiCompat.fromWire reads text, tool calls, stop reason and usage", () => {
  const fixture = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "Let me check that.",
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "check_email", arguments: '{"limit":5}' } },
            { id: "call_def", type: "function", function: { name: "open_url", arguments: '{"url":"https://youtube.com"}' } }
          ]
        }
      }
    ],
    usage: { prompt_tokens: 812, completion_tokens: 43 }
  };
  const res = openaiCompat.fromWire(fixture);
  assert.equal(res.text, "Let me check that.");
  assert.deepEqual(res.toolCalls, [
    { id: "call_abc", name: "check_email", arguments: '{"limit":5}' },
    { id: "call_def", name: "open_url", arguments: '{"url":"https://youtube.com"}' }
  ]);
  assert.equal(res.stopReason, "tool_calls");
  assert.deepEqual(res.usage, { inputTokens: 812, outputTokens: 43 });
  assert.equal(res.raw, fixture);
});

test("openaiCompat.fromWire handles a content-only answer", () => {
  const res = openaiCompat.fromWire({ choices: [{ finish_reason: "stop", message: { content: "Opened it." } }] });
  assert.equal(res.text, "Opened it.");
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.stopReason, "stop");
  assert.equal(res.usage, null);
});

test("openaiCompat.fromWire keeps production edge cases: id fallback, missing arguments, nameless call dropped", () => {
  const res = openaiCompat.fromWire({
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "open_url" } }, // no id, no arguments
            { id: "call_x", function: { arguments: '{"a":1}' } } // no name → dropped
          ]
        }
      }
    ]
  });
  assert.deepEqual(res.toolCalls, [{ id: "call_0", name: "open_url", arguments: "{}" }]);
  assert.equal(res.text, "");
  assert.equal(res.stopReason, null);
  assert.equal(res.usage, null);
});

test("openaiCompat.fromWire survives an empty/garbage envelope", () => {
  const res = openaiCompat.fromWire({});
  assert.deepEqual({ text: res.text, toolCalls: res.toolCalls, stopReason: res.stopReason, usage: res.usage }, {
    text: "",
    toolCalls: [],
    stopReason: null,
    usage: null
  });
});

// ---- OpenAI-compatible: streaming deltas ------------------------------------

test("openaiCompat stream deltas accumulate tool calls by index like streamNvidia", () => {
  const chunks = [
    { choices: [{ delta: { content: "Sure, " } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "open_", arguments: '{"url"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "url", arguments: ':"https://x.dev"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] } }] }, // nameless → dropped
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ];

  const tcs = [];
  let text = "";
  let finish = null;
  for (const chunk of chunks) {
    const delta = openaiCompat.deltaFromStreamChunk(chunk);
    if (delta.text) text += delta.text;
    if (delta.toolCallDelta) openaiCompat.accumulateToolCalls(tcs, delta.toolCallDelta);
    if (delta.finishReason) finish = delta.finishReason;
  }

  assert.equal(text, "Sure, ");
  assert.equal(finish, "tool_calls");
  assert.deepEqual(tcs[1], { id: "call_1", name: "", arguments: "{}" });
  assert.deepEqual(openaiCompat.collectToolCalls(tcs), [
    { id: "call_1", name: "open_url", arguments: '{"url":"https://x.dev"}' }
  ]);
});

test("openaiCompat.deltaFromStreamChunk ignores chunks with no choices", () => {
  assert.deepEqual(openaiCompat.deltaFromStreamChunk({}), {});
  assert.deepEqual(openaiCompat.deltaFromStreamChunk({ choices: [] }), {});
});

// ---- Anthropic: byte-identical request bodies -------------------------------

test("anthropic.toWire matches the inline /v1/messages body byte for byte", () => {
  const system = "You are Artemis.";
  const wire = anthropic.toWire({
    model: "claude-opus-4-8",
    maxTokens: 1024,
    system,
    tools: NEUTRAL_TOOLS,
    messages: MESSAGES
  });

  const expected = {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system,
    tools: [
      { name: "open_url", description: NEUTRAL_TOOLS[0].description, input_schema: NEUTRAL_TOOLS[0].parameters },
      { name: "check_email", description: NEUTRAL_TOOLS[1].description, input_schema: NEUTRAL_TOOLS[1].parameters },
      { name: "web_search", description: NEUTRAL_TOOLS[2].description, input_schema: NEUTRAL_TOOLS[2].parameters }
    ],
    messages: MESSAGES
  };

  assert.equal(JSON.stringify(wire), JSON.stringify(expected));
});

test("anthropic.toWire passes already-wire tools through untouched and omits an unset model", () => {
  // Exactly what callClaude ships: the server-side web_search tool (no schema),
  // fetch_page and the skill defs, all born in Anthropic shape.
  const webSearch = { type: "web_search_20260209", name: "web_search" };
  const fetchPage = { name: "fetch_page", description: "Fetch a page.", input_schema: { type: "object", properties: {} } };
  const wire = anthropic.toWire({ maxTokens: 1024, system: "S", tools: [webSearch, fetchPage], messages: MESSAGES });

  assert.equal(
    JSON.stringify(wire),
    JSON.stringify({ max_tokens: 1024, system: "S", tools: [webSearch, fetchPage], messages: MESSAGES })
  );
  assert.equal("model" in wire, false);
});

// ---- Anthropic: response parsing --------------------------------------------

const ANTHROPIC_FIXTURE = {
  stop_reason: "tool_use",
  usage: { input_tokens: 2201, output_tokens: 118 },
  content: [
    { type: "text", text: "Let me look that up. " },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "artemis" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", title: "Artemis program", url: "https://nasa.gov/artemis" },
        { type: "web_search_result", url: "https://example.com/no-title" },
        { type: "web_search_result", title: "no url here" }
      ]
    },
    { type: "tool_use", id: "toolu_2", name: "fetch_page", input: { url: "https://nasa.gov/artemis" } },
    { type: "text", text: "Here's what I found." }
  ]
};

test("anthropic.fromWire keeps finalText semantics: only text AFTER the last tool block", () => {
  const res = anthropic.fromWire(ANTHROPIC_FIXTURE);
  assert.equal(res.text, "Here's what I found.");
  assert.ok(!res.text.includes("Let me look that up"), "narration before the last tool block must be dropped");
  assert.deepEqual(res.toolCalls, [
    { id: "toolu_2", name: "fetch_page", arguments: '{"url":"https://nasa.gov/artemis"}' }
  ]);
  assert.equal(res.stopReason, "tool_use");
  assert.deepEqual(res.usage, { inputTokens: 2201, outputTokens: 118 });
  assert.equal(res.raw, ANTHROPIC_FIXTURE);
});

test("anthropic.sourcesFromWire harvests built-in web_search URLs with a title fallback", () => {
  assert.deepEqual(anthropic.sourcesFromWire(ANTHROPIC_FIXTURE), [
    { title: "Artemis program", url: "https://nasa.gov/artemis" },
    { title: "https://example.com/no-title", url: "https://example.com/no-title" }
  ]);
  assert.deepEqual(anthropic.sourcesFromWire({}), []);
});

test("anthropic.fromWire returns all text when the response has no tool blocks", () => {
  const res = anthropic.fromWire({
    stop_reason: "end_turn",
    content: [
      { type: "text", text: "Morning. " },
      { type: "text", text: "Nothing on the calendar." }
    ]
  });
  assert.equal(res.text, "Morning. Nothing on the calendar.");
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.stopReason, "end_turn");
  assert.equal(res.usage, null);
});

test("anthropic.fromWire serialises a tool_use with no input as {}", () => {
  const res = anthropic.fromWire({ content: [{ type: "tool_use", id: "toolu_9", name: "check_email" }] });
  assert.deepEqual(res.toolCalls, [{ id: "toolu_9", name: "check_email", arguments: "{}" }]);
  assert.equal(res.text, "");
  assert.equal(res.stopReason, null);
});
