// OpenAI-compatible wire adapter (/chat/completions).
//
// Speaks for Groq, NVIDIA NIM and Ollama — every brain in the chain uses this
// dialect. Pure translation: no fetch, no retry, no model selection. The caller
// still owns `model` and any per-brain extras (brainRequestExtras), because the
// brain chain picks those AFTER the body has been shaped.
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
  if (req.tools !== undefined && req.tools !== null) body.tools = req.tools.map(toWireTool);
  if (req.toolChoice !== undefined && req.toolChoice !== null) body.tool_choice = req.toolChoice;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stream !== undefined) body.stream = req.stream;
  if (req.extra) Object.assign(body, req.extra);
  return body;
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
