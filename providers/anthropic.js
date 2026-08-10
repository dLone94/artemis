// Anthropic wire adapter (/v1/messages).
//
// Pure translation: no fetch, no retry, no key handling. The caller keeps
// owning the endpoint, the headers and the model id — server.js currently
// inlines ANTHROPIC_MODEL, so it passes `model` in and this adapter simply
// places it first, exactly where the inline body had it.
//
// Key ORDER is load-bearing (see providers/openaiCompat.js): the bytes on the
// wire must not change in Phase 1.

/**
 * Render one tool for /v1/messages.
 *
 * Two shapes arrive here today, and both must survive untouched:
 *   - NEUTRAL registry tools `{name, description, parameters}` → renamed to
 *     `input_schema`, matching anthropicToolDefs().
 *   - ALREADY-WIRE tools — the server-side `web_search` tool
 *     (`{type, name}`, no schema at all) and anything built directly in
 *     Anthropic shape (`input_schema`). Those are passed through verbatim.
 *
 * The passthrough branch is a wart, not a design: skills.js and the
 * WEB_SEARCH_TOOL constant emit Anthropic-shaped defs at the source. Phase 1b
 * should make the registry the single neutral origin and delete it.
 *
 * @param {import("../modelProvider.js").NeutralTool|Object} tool
 */
function toWireTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const isNeutral = Object.prototype.hasOwnProperty.call(tool, "parameters");
  if (!isNeutral) return tool; // already wire-shaped (input_schema, or a server tool)
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/**
 * Neutral request → the object today's code JSON.stringifies for /v1/messages.
 * `model` is emitted only when the caller supplies one; `temperature`, `stream`
 * and `extra` are supported for completeness and are absent from every current
 * call site, so unchanged callers produce unchanged bytes.
 *
 * @param {import("../modelProvider.js").ModelRequest} req
 * @returns {Object}
 */
export function toWire(req = {}) {
  const body = {};
  if (req.model !== undefined && req.model !== null) body.model = req.model;
  body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  body.system = req.system;
  body.tools = Array.isArray(req.tools) ? req.tools.map(toWireTool) : req.tools;
  body.messages = req.messages;
  if (req.stream !== undefined) body.stream = req.stream;
  if (req.extra) Object.assign(body, req.extra);
  return body;
}

const TOOLISH_BLOCKS = new Set(["web_search_tool_result", "server_tool_use", "tool_use", "tool_result"]);

/**
 * The spoken answer: text blocks AFTER the last tool-ish block, falling back to
 * all text when that yields nothing. Identical to finalText() — it exists so a
 * model that narrates "I'll look that up…" before searching does not get that
 * narration read aloud on top of the real answer.
 */
function finalText(content) {
  let lastTool = -1;
  content.forEach((b, i) => {
    if (TOOLISH_BLOCKS.has(b.type)) lastTool = i;
  });
  const after = lastTool >= 0 ? content.slice(lastTool + 1) : content;
  const pick = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return pick(after) || pick(content);
}

/**
 * Provider JSON → ModelResponse.
 * @param {Object} json
 * @returns {import("../modelProvider.js").ModelResponse}
 */
export function fromWire(json) {
  const data = json || {};
  const content = data.content || [];
  const toolCalls = content
    .filter((b) => b && b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) }));

  const usage = data.usage
    ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
    : null;

  return {
    text: finalText(content),
    toolCalls,
    stopReason: data.stop_reason || null,
    usage,
    raw: data
  };
}

/**
 * URLs the built-in server-side web_search consulted, in arrival order.
 * Not deduped — the caller already runs dedupeSources() over the whole turn.
 *
 * @param {Object} json
 * @returns {Array<{title: string, url: string}>}
 */
export function sourcesFromWire(json) {
  const out = [];
  for (const block of (json && json.content) || []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r && r.type === "web_search_result" && r.url) out.push({ title: r.title || r.url, url: r.url });
      }
    }
  }
  return out;
}
