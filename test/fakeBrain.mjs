// A fake NVIDIA/OpenAI chat-completions endpoint.
//
// The real server loop runs against this instead of the cloud, so the reliability
// guarantees can be tested for real — actual SSE parsing, actual tool execution,
// actual repair rounds — with the model's behaviour scripted, offline, and free.
// It also never touches Gmail, the web, or anything with a side effect, which is
// the whole reason model evaluation is allowed to reuse it.
import http from "node:http";

/**
 * Response specs the script can contain:
 *   { text: "..." }                          → a plain content answer
 *   { toolCalls: [{name, arguments}] }       → one or more tool calls
 *   { text, toolCalls }                      → narration AND calls
 *   { fragment: true }                       → split across many tiny SSE deltas
 *   { delayMs: n }                           → stall before responding
 *   { status: 429, retryAfter: "0.05" }      → refuse, the way a throttled brain
 *                                              does, so chain failover is testable
 */
export async function startFakeBrain() {
  let script = [];
  const requests = [];

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;

    if (req.url === "/__script" && req.method === "POST") {
      script = JSON.parse(body || "[]");
      requests.length = 0;
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/__requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }

    const parsed = JSON.parse(body || "{}");
    requests.push({
      tool_choice: parsed.tool_choice,
      toolNames: (parsed.tools || []).map((t) => t.function.name),
      messages: parsed.messages,
      stream: !!parsed.stream,
      // which chain entry asked — the only way to see a failover from outside
      model: parsed.model
    });

    const spec = script.shift() || { text: "(fake brain ran out of script)" };
    if (spec.status) {
      const headers = spec.retryAfter ? { "retry-after": String(spec.retryAfter) } : {};
      // Default body reads like a rate limit; spec.message/spec.code let a test
      // script a different failure (e.g. a 404 model_not_found for a retired model).
      const error = { message: spec.message || "rate limit" };
      if (spec.code) error.code = spec.code;
      res.writeHead(spec.status, headers).end(JSON.stringify({ error }));
      return;
    }
    if (spec.delayMs) {
      const aborted = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), spec.delayMs);
        req.on("aborted", () => { clearTimeout(t); resolve(true); });
        res.on("close", () => { clearTimeout(t); resolve(true); });
      });
      if (aborted) { try { res.destroy(); } catch (e) {} return; }
    }

    if (parsed.stream) streamSpec(res, spec);
    else jsonSpec(res, spec);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async setScript(specs) {
      await fetch(`http://127.0.0.1:${port}/__script`, { method: "POST", body: JSON.stringify(specs) });
    },
    async requests() {
      return (await fetch(`http://127.0.0.1:${port}/__requests`)).json();
    },
    close: () => new Promise((r) => server.close(r))
  };
}

function jsonSpec(res, spec) {
  const message = { role: "assistant", content: spec.text || null };
  if (spec.toolCalls) {
    message.tool_calls = spec.toolCalls.map((tc, i) => ({
      id: "call_" + i,
      type: "function",
      function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}) }
    }));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: spec.toolCalls ? "tool_calls" : "stop" }] }));
}

function streamSpec(res, spec) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (delta, finish) =>
    res.write("data: " + JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] }) + "\n\n");

  if (spec.text) {
    // fragment: deliver a few characters at a time, so the parser is tested the
    // way a real stream arrives rather than as one tidy chunk
    const parts = spec.fragment ? spec.text.match(/.{1,3}/gs) : [spec.text];
    for (const p of parts) send({ content: p });
  }
  if (spec.toolCalls) {
    spec.toolCalls.forEach((tc, index) => {
      const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {});
      if (spec.fragment) {
        // name and arguments split across deltas — the shape that used to drop calls
        send({ tool_calls: [{ index, id: "call_" + index, function: { name: tc.name.slice(0, 2) } }] });
        send({ tool_calls: [{ index, function: { name: tc.name.slice(2) } }] });
        for (const chunk of args.match(/.{1,4}/gs) || []) {
          send({ tool_calls: [{ index, function: { arguments: chunk } }] });
        }
      } else {
        send({ tool_calls: [{ index, id: "call_" + index, function: { name: tc.name, arguments: args } }] });
      }
    });
  }
  send({}, spec.toolCalls ? "tool_calls" : "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}
