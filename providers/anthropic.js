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
 * Render one NEUTRAL tool for /v1/messages: `parameters` becomes `input_schema`.
 * Unconditional — every tool that reaches here is neutral, because skills.js and
 * the registry now emit only the neutral shape. There is no sniffing branch.
 *
 * @param {import("../modelProvider.js").NeutralTool} tool
 */
function toWireTool(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/**
 * A neutral tool list in Anthropic shape, followed by any PROVIDER-NATIVE tools
 * verbatim. The latter are Anthropic's own server-side tools (`web_search`,
 * `{type, name}` with no schema at all) — they have no neutral equivalent to
 * translate from, so the caller hands them over opaquely and they are emitted
 * exactly as given.
 *
 * @param {import("../modelProvider.js").NeutralTool[]} tools
 * @param {Object[]} [providerTools] Emitted verbatim, after the mapped ones.
 */
// Provider-native tools come FIRST, restoring the byte order the inline
// literals produced (web_search led the array). Anthropic does not rank tools
// by position, but LLM tool selection carries a measurable position bias and
// web_search is the highest-traffic tool on this path — with the live eval
// currently unrunnable, silently moving it is a variable we cannot observe.
// Order is a deliberate compatibility choice, not an accident.
export function toWireTools(tools, providerTools) {
  const mapped = Array.isArray(tools) ? tools.map(toWireTool) : tools;
  const native = Array.isArray(providerTools) ? providerTools : [];
  if (!native.length) return mapped;
  return [...native, ...(Array.isArray(mapped) ? mapped : [])];
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
  body.tools = toWireTools(req.tools, req.providerTools);
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
