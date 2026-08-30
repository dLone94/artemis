import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setOffline } from "../networkPolicy.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let directFetchCalls = 0;
const originalFetch = globalThis.fetch;
const originalLookup = dns.lookup;
globalThis.fetch = async () => {
  directFetchCalls += 1;
  return new Response(JSON.stringify({ refresh_token: "should-not-exist", hits: [], items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
dns.lookup = async () => [{ address: "93.184.216.34", family: 4 }];

setOffline(true);
process.env.GOOGLE_CLIENT_ID = "configured-client";
process.env.GOOGLE_CLIENT_SECRET = "configured-secret";
process.env.GOOGLE_REFRESH_TOKEN = "configured-refresh";

const { gmailExchangeCode, listUnread, trashMessage } = await import("../gmail.js");
const { fetchPage } = await import("../webAccess.js");
const { runResearch } = await import("../research.js");
const { getSkill } = await import("../skills.js");

await assert.rejects(() => gmailExchangeCode("oauth-code", 4100), /local-only/i);
await assert.rejects(() => listUnread(1), /local-only/i);
const page = await fetchPage("https://example.com/");
assert.match(page.error || "", /local-only/i);
const research = await runResearch("hackernews", "security", 1);
assert.match(research.error || "", /local-only/i);
await getSkill("play_media").execute({ query: "security music" });
assert.equal(directFetchCalls, 0, "direct Gmail, web, research and media leaves must make zero fetch calls");

setOffline(false);
globalThis.fetch = async (url) => {
  directFetchCalls += 1;
  if (String(url).includes("oauth2.googleapis.com")) {
    return new Response(JSON.stringify({ access_token: "cached-access-token", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response("", { status: 200 });
};
await trashMessage("message-1");
assert.equal(directFetchCalls, 2, "online Gmail setup should populate the token cache and make the API request");
setOffline(true);
await assert.rejects(() => trashMessage("message-2"), /local-only/i);
assert.equal(directFetchCalls, 2, "cached Gmail credentials must not bypass local-only mode");

globalThis.fetch = originalFetch;
dns.lookup = originalLookup;
setOffline(false);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function request(port, method, route, body = "", contentType = "application/json") {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path: route,
      headers: { host: `127.0.0.1:${port}`, "content-type": contentType }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await request(port, "GET", "/api/status");
    if (response.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-cloud-leaves-"));
const auditFile = path.join(dir, "network.json");
const port = await freePort();
const hook = path.join(ROOT, "test", "cloudNetworkAuditHook.mjs");
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${hook}`.trim(),
    PORT: String(port),
    ARTEMIS_HOST: "127.0.0.1",
    ARTEMIS_HTTPS: "",
    ARTEMIS_OFFLINE: "1",
    ARTEMIS_DATA_DIR: dir,
    ARTEMIS_NETWORK_AUDIT_FILE: auditFile,
    ARTEMIS_DISABLE_UI_AUTOMATION: "1",
    NVIDIA_API_KEY: "configured-nvidia-key",
    NVIDIA_BASE_URL: "https://cloud-brain.invalid/v1",
    LLM_PROVIDER: "nvidia",
    DEEPGRAM_API_KEY: "configured-deepgram-key",
    ELEVENLABS_API_KEY: "configured-eleven-key",
    ELEVENLABS_VOICE_ID: "abcdefghijklmnop",
    MINIMAX_API_KEY: "configured-minimax-key",
    MINIMAX_GROUP_ID: "configured-group",
    GOOGLE_CLIENT_ID: "configured-client",
    GOOGLE_CLIENT_SECRET: "configured-secret",
    GOOGLE_REFRESH_TOKEN: "configured-refresh",
    TAVILY_API_KEY: "configured-search-key",
    STRIPE_SECRET_KEY: "configured-stripe-key"
  },
  stdio: ["ignore", "ignore", "ignore"]
});

try {
  await waitReady(port);
  const chatBody = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  await request(port, "POST", "/api/chat", chatBody);
  await request(port, "POST", "/api/chat/stream", chatBody);
  await request(port, "POST", "/api/stt/live/start");
  await request(port, "POST", "/api/stt", Buffer.alloc(32000), "audio/pcm;rate=16000");
  await request(port, "GET", "/api/tts?provider=deepgram&text=hello");
  await request(port, "GET", "/api/tts?provider=edge&text=hello");
  await request(port, "GET", "/api/briefing");
  await request(port, "GET", "/api/brief");
  await request(port, "GET", "/auth/google/callback?code=oauth-code");
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const audit = JSON.parse(readFileSync(auditFile, "utf8"));
assert.equal(audit.externalFetchCalls, 0,
  `direct cloud-capable routes must create zero external HTTP calls: ${audit.fetchTargets.join(", ")}`);
assert.equal(audit.tlsCalls, 0, "direct cloud-capable routes must create zero external TLS sockets");
assert.ok(audit.fetchTargets.every((target) => target.startsWith("http://127.0.0.1:") || target.startsWith("http://localhost:")),
  `only an explicitly local brain may remain reachable: ${audit.fetchTargets.join(", ")}`);

rmSync(dir, { recursive: true, force: true });
console.log("PASS cloud leaves: direct modules and routes make zero network calls in local-only mode");
