import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_MODULE = pathToFileURL(join(ROOT, "server.js")).href;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function cleanEnv(overrides = {}) {
  return {
    ...process.env,
    ARTEMIS_HOST: "127.0.0.1",
    ARTEMIS_HTTPS: "",
    ARTEMIS_REQUIRE_AUTH: "",
    STRIPE_SECRET_KEY: "",
    DEEPGRAM_API_KEY: "test-deepgram",
    ELEVENLABS_API_KEY: "",
    ELEVENLABS_VOICE_ID: "",
    MINIMAX_API_KEY: "",
    MINIMAX_GROUP_ID: "",
    MINIMAX_VOICE_ID: "",
    MINIMAX_MODEL: "",
    ARTEMIS_VOICEBOX_ENABLED: "0",
    ARTEMIS_TTS_PROVIDER: "",
    ...overrides
  };
}

function resultFrom(output) {
  const line = String(output).split("\n").find((entry) => entry.startsWith("RESULT:"));
  if (!line) throw new Error("child probe did not emit a result:\n" + output);
  return JSON.parse(line.slice("RESULT:".length));
}

async function providerProbe(overrides, expressions) {
  const port = await freePort();
  const script = `
    const server = await import(process.env.ARTEMIS_SERVER_MODULE);
    const result = ${expressions};
    console.log("RESULT:" + JSON.stringify(result));
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    env: cleanEnv({
      PORT: String(port),
      ARTEMIS_SERVER_MODULE: SERVER_MODULE,
      ...overrides
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  return resultFrom(output);
}

async function routeProbe(mode) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(os.tmpdir(), "artemis-minimax-test-"));
  const script = `
    import http from "node:http";

    const mode = process.env.MINIMAX_TEST_MODE;
    let minimaxRequest = null;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("https://api.minimax.io/")) {
        minimaxRequest = {
          url,
          authorization: init.headers && init.headers.Authorization,
          body: JSON.parse(init.body || "{}")
        };
        if (mode === "failure") return new Response("upstream failed", { status: 503 });
        return new Response(JSON.stringify({
          data: { audio: Buffer.from("minimax-audio").toString("hex"), status: 2 },
          base_resp: { status_code: 0, status_msg: "success" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response(Buffer.from("deepgram-audio"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" }
        });
      }
      throw new Error("unexpected outbound fetch: " + url);
    };

    await import(process.env.ARTEMIS_SERVER_MODULE);

    function request(method, path, body) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: Number(process.env.PORT),
          method,
          path,
          headers: {
            host: "127.0.0.1:" + process.env.PORT,
            ...(body ? { "content-type": "application/json" } : {})
          }
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          }));
        });
        req.on("error", reject);
        if (body) req.end(JSON.stringify(body));
        else req.end();
      });
    }

    const deadline = Date.now() + 10000;
    while (true) {
      try {
        const ready = await request("GET", "/api/status");
        if (ready.status === 200) break;
      } catch (error) {}
      if (Date.now() >= deadline) throw new Error("server did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const text = "hello minimax";
    const tts = await request("POST", "/api/tts", { text, provider: "minimax" });
    const status = await request("GET", "/api/status");
    const statusBody = JSON.parse(status.body.toString("utf8"));
    console.log("RESULT:" + JSON.stringify({
      status: tts.status,
      provider: tts.headers["x-tts-provider"],
      audio: tts.body.toString("utf8"),
      minimaxChars: statusBody.usage.ttsChars.minimax,
      textLength: text.length,
      minimaxRequest
    }));
    process.exit(0);
  `;

  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: ROOT,
      env: cleanEnv({
        PORT: String(port),
        ARTEMIS_DATA_DIR: dataDir,
        ARTEMIS_SERVER_MODULE: SERVER_MODULE,
        MINIMAX_TEST_MODE: mode,
        MINIMAX_API_KEY: "test-minimax-key",
        MINIMAX_GROUP_ID: "test-group",
        MINIMAX_VOICE_ID: "test-voice"
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    });
    return resultFrom(output);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("TTS provider resolution prefers explicit MiniMax, then enabled providers", async () => {
  const both = await providerProbe(
    {
      ELEVENLABS_API_KEY: "eleven-key",
      ELEVENLABS_VOICE_ID: "eleven-voice-id-1234",
      MINIMAX_API_KEY: "minimax-key",
      MINIMAX_GROUP_ID: "group-id"
    },
    `[server.resolveTtsProvider("minimax"), server.resolveTtsProvider("")]`
  );
  assert.deepEqual(both, ["minimax", "elevenlabs"]);

  const minimaxOnly = await providerProbe(
    { MINIMAX_API_KEY: "minimax-key", MINIMAX_GROUP_ID: "group-id" },
    `server.resolveTtsProvider("")`
  );
  assert.equal(minimaxOnly, "minimax");

  const deepgramOnly = await providerProbe({}, `server.resolveTtsProvider("")`);
  assert.equal(deepgramOnly, "deepgram");
});

test("MiniMax non-200 falls back to Deepgram in the same request", async () => {
  const result = await routeProbe("failure");
  assert.equal(result.status, 200);
  assert.equal(result.provider, "deepgram-fallback");
  assert.equal(result.audio, "deepgram-audio");
});

test("successful MiniMax TTS increments its character usage", async () => {
  const result = await routeProbe("success");
  assert.equal(result.status, 200);
  assert.equal(result.provider, "minimax");
  assert.equal(result.audio, "minimax-audio");
  assert.equal(result.minimaxChars, result.textLength);
  assert.equal(result.minimaxRequest.url, "https://api.minimax.io/v1/t2a_v2?GroupId=test-group");
  assert.equal(result.minimaxRequest.authorization, "Bearer test-minimax-key");
  assert.deepEqual(result.minimaxRequest.body, {
    model: "speech-2.6-turbo",
    text: "hello minimax",
    voice_setting: { voice_id: "test-voice" },
    audio_setting: { format: "mp3", sample_rate: 32000 }
  });
});
