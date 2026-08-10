// OpenAI-compatible wire adapter (/chat/completions).
//
// Speaks for Groq, NVIDIA NIM and Ollama — every brain in the chain uses this
// dialect. Translation plus the ADDRESSING of this dialect (Phase 1c): where it
// lives, how it authenticates, how `model` and per-brain extras join the body.
// Still no fetch, no retry, no brain selection — which brain is healthy stays
// server.js's business, because that is a fact about the chain, not the wire.
//
// The key ORDER below is load-bearing: server.js serialises these bodies with
// JSON.stringify, and Phase 1's contract is that the bytes on the wire do not
// change. Keep it as `messages, tools, tool_choice, max_tokens, temperature,
// stream` — that is the order every existing call site already produces.

/**
 * Render a neutral tool into OpenAI function-calling shape.
 * @param {import("../modelProvider.js").NeutralTool} tool
 */
function toWireTool(tool) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  };
}

/**
 * A whole neutral tool list in OpenAI function-calling shape. Exported because
 * the registry renders its defs through this adapter rather than mapping the
 * wire shape inline — this function is the ONLY place that knows what
 * `{type:"function", function:{…}}` looks like.
 *
 * @param {import("../modelProvider.js").NeutralTool[]} tools
 */
export function toWireTools(tools) {
  return (tools || []).map(toWireTool);
}

/**
 * Neutral request → the object today's code JSON.stringifies for
 * /chat/completions, MINUS `model` and MINUS the per-brain extras. Keys that
 * are absent today stay absent, so an unchanged caller produces unchanged bytes.
 *
 * `system` is a convenience only: this dialect has no top-level system field,
 * so it becomes the leading system message. Callers that already put the system
 * prompt in `messages` (all of server.js does) must not also pass `system`.
 *
 * @param {import("../modelProvider.js").ModelRequest} req
 * @returns {Object}
 */
export function toWire(req = {}) {
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const withSystem =
    req.system && !(messages[0] && messages[0].role === "system")
      ? [{ role: "system", content: req.system }, ...messages]
      : messages;

  const body = { messages: withSystem };
  if (req.tools !== undefined && req.tools !== null) body.tools = toWireTools(req.tools);
  if (req.toolChoice !== undefined && req.toolChoice !== null) body.tool_choice = req.toolChoice;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stream !== undefined) body.stream = req.stream;
  if (req.extra) Object.assign(body, req.extra);
  return body;
}

/**
 * Where this dialect lives for one brain-chain entry. Every OpenAI-compatible
 * host — Groq, NVIDIA NIM, Ollama, and anything else that claims the dialect —
 * serves completions at this path under its own base URL, which is exactly why
 * one adapter can speak for all of them.
 *
 * @param {{base: string}} brain A brain-chain entry.
 * @returns {string}
 */
export function endpoint(brain) {
  return brain.base + "/chat/completions";
}

/**
 * Auth + content type for one brain-chain entry. Ollama ignores the bearer
 * token entirely and the chain hands it the literal string "ollama"; sending it
 * anyway keeps every entry in the chain the same shape.
 *
 * @param {{key: string}} brain
 * @returns {Object}
 */
export function headers(brain) {
  return { Authorization: "Bearer " + brain.key, "Content-Type": "application/json" };
}

/**
 * The final JSON body: the chosen model, the translated request, then the
 * per-brain extras.
 *
 * EXTRAS GO LAST, and that is a safety property rather than a style choice. The
 * only extras in play are reasoning-channel controls — `reasoning_effort:"none"`
 * for the local Ollama tier, `"low"` for the gpt-oss models — and a brain that
 * loses that flag puts its entire answer in a reasoning channel the stream loop
 * never reads, so she says NOTHING. Last position means no wire field can ever
 * overwrite it.
 *
 * Before Phase 1c the three call sites disagreed about this order (two put
 * extras before the body, one after). It was harmless only because the two key
 * sets happen to be disjoint — which is asserted in test/modelProvider.test.mjs
 * so it stays true rather than staying lucky.
 *
 * @param {{model: string}} brain
 * @param {Object} wire Output of toWire().
 * @param {Object} [extras] Per-brain request extras.
 * @returns {Object}
 */
export function requestBody(brain, wire, extras) {
  return Object.assign({ model: brain.model }, wire, extras || {});
}

/**
 * Provider JSON → ModelResponse. Mirrors normalizeToolCalls() exactly: an id
 * falls back to "call_<i>", missing arguments become "{}", and a call with no
 * function name is dropped (models do emit those).
 *
 * @param {Object} json
 * @returns {import("../modelProvider.js").ModelResponse}
 */
export function fromWire(json) {
  const data = json || {};
  const choice = (data.choices && data.choices[0]) || {};
  const message = choice.message || {};
  const toolCalls = (message.tool_calls || [])
    .map((tc, i) => ({
      id: tc.id || "call_" + i,
      name: (tc.function && tc.function.name) || "",
      arguments: (tc.function && tc.function.arguments) || "{}"
    }))
    .filter((tc) => tc.name);

  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
    : null;

  return {
    text: message.content || "",
    toolCalls,
    stopReason: choice.finish_reason || null,
    usage,
    raw: data
  };
}

/**
 * One parsed SSE `data:` object → what it contributes to the turn. Mirrors the
 * delta handling in streamNvidia(): text only when `delta.content` is truthy,
 * tool-call fragments carrying their index (default 0), and finish_reason when
 * the chunk closes a choice. `[DONE]` is not a JSON object and never reaches here.
 *
 * @param {Object} parsed
 * @returns {import("../modelProvider.js").StreamDelta}
 */
export function deltaFromStreamChunk(parsed) {
  const chunk = parsed || {};
  const choice = chunk.choices && chunk.choices[0];
  if (!choice) return {};
  const delta = choice.delta || {};
  const out = {};
  if (delta.content) out.text = delta.content;
  if (delta.tool_calls) {
    out.toolCallDelta = delta.tool_calls.map((tcd) => ({
      index: tcd.index || 0,
      id: tcd.id || null,
      name: (tcd.function && tcd.function.name) || "",
      arguments: (tcd.function && tcd.function.arguments) || ""
    }));
  }
  if (choice.finish_reason) out.finishReason = choice.finish_reason;
  return out;
}

/**
 * Fold stream fragments into the sparse by-index accumulator streamNvidia keeps.
 * Same semantics as the inline loop: the slot is created on first sight with an
 * id fallback of "call_<index>", a later explicit id wins, and name/arguments
 * are concatenated in arrival order.
 *
 * @param {Array<{id: string, name: string, arguments: string}>} tcs Mutated in place.
 * @param {Array<{index: number, id: string|null, name: string, arguments: string}>} deltas
 * @returns {Array} the same accumulator
 */
export function accumulateToolCalls(tcs, deltas) {
  for (const frag of deltas || []) {
    const idx = frag.index || 0;
    if (!tcs[idx]) tcs[idx] = { id: frag.id || "call_" + idx, name: "", arguments: "" };
    if (frag.id) tcs[idx].id = frag.id;
    if (frag.name) tcs[idx].name += frag.name;
    if (frag.arguments) tcs[idx].arguments += frag.arguments;
  }
  return tcs;
}

/**
 * The accumulator's finished tool calls: holes dropped, nameless calls dropped —
 * the same two filters streamNvidia applies before the safety gate sees them.
 */
export function collectToolCalls(tcs) {
  return (tcs || []).filter(Boolean).filter((tc) => tc.name);
}
