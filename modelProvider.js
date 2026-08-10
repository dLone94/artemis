// Model provider abstraction — WIRE FORMAT ONLY.
//
// Phase 1 of the provider migration. Today server.js speaks two wire formats
// with the details inlined at each call site: OpenAI-compatible
// (/chat/completions, used by Groq/NVIDIA/Ollama) and Anthropic (/v1/messages).
// This module names the neutral shapes that sit between the agent loops and
// those two dialects, and hands out the adapter that translates.
//
// Deliberately NOT in scope (Phase 1b and later):
//   - transport (fetch, timeouts, aborts)
//   - retry / brain benching / cooldown
//   - streaming plumbing and SSE transport
//   - the agent loops, the safety gate, routes, prompts, the registry
//
// This file performs NO I/O and holds NO state. It is pure.

import * as openaiCompat from "./providers/openaiCompat.js";
import * as anthropic from "./providers/anthropic.js";

/**
 * A provider-neutral tool declaration. JSON-Schema `parameters`, exactly as the
 * registry stores it — each adapter renames the field to whatever its wire
 * format wants (`function.parameters` vs `input_schema`).
 *
 * @typedef {Object} NeutralTool
 * @property {string} name
 * @property {string} [description]
 * @property {Object} [parameters] JSON Schema for the tool's arguments.
 */

/**
 * One request to a model, before it has been rendered into anybody's dialect.
 *
 * `messages` are passed through verbatim: the two dialects already agree on
 * `{role, content}` for the shapes we send, and normalising them is a Phase 1b
 * problem, not a wire-format one.
 *
 * @typedef {Object} ModelRequest
 * @property {Array<Object>} messages Conversation turns, provider-shaped today.
 * @property {string} [system] System prompt (Anthropic takes it top-level; the
 *   OpenAI-compatible path carries it as a `system` message instead).
 * @property {NeutralTool[]} [tools] Neutral tool list.
 * @property {string|Object} [toolChoice] "auto" | "none" | "required" | a
 *   provider-shaped forced-call object. Passed through untouched.
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {boolean} [stream]
 * @property {string} [model] Only used where the adapter owns the model field.
 * @property {Object} [extra] Provider-specific keys appended last. Callers that
 *   already merge their own extras (server.js and brainRequestExtras) should
 *   keep doing that outside the adapter.
 */

/**
 * One tool call, normalised. `arguments` is always a JSON *string* because
 * that is what the OpenAI-compatible wire gives us and what the executor
 * already parses.
 *
 * @typedef {Object} NeutralToolCall
 * @property {string} id
 * @property {string} name
 * @property {string} arguments JSON string; "{}" when the model sent nothing.
 */

/**
 * One model response, normalised.
 *
 * @typedef {Object} ModelResponse
 * @property {string} text
 * @property {NeutralToolCall[]} toolCalls
 * @property {string|null} stopReason Provider's own value, unmapped.
 * @property {{inputTokens: number, outputTokens: number}|null} usage
 * @property {Object} raw The untouched provider JSON.
 */

/**
 * One decoded SSE chunk from a streaming completion.
 *
 * @typedef {Object} StreamDelta
 * @property {string} [text] Text fragment, when this chunk carried one.
 * @property {Array<{index: number, id: string|null, name: string, arguments: string}>} [toolCallDelta]
 * @property {string} [finishReason]
 */

/** The wire formats this server can speak. */
export const WIRE = {
  OPENAI: "openai-compat",
  ANTHROPIC: "anthropic"
};

const ADAPTERS = {
  [WIRE.OPENAI]: openaiCompat,
  [WIRE.ANTHROPIC]: anthropic
};

/**
 * The adapter module for a wire format.
 * @param {string} wire One of WIRE.*
 * @returns {typeof openaiCompat | typeof anthropic}
 */
export function adapterFor(wire) {
  const adapter = ADAPTERS[wire];
  if (!adapter) throw new Error("unknown wire format: " + String(wire));
  return adapter;
}

export { openaiCompat, anthropic };
