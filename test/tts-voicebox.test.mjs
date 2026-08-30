import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chooseVoiceboxProfile, createVoiceboxTtsProvider } from "../voiceboxTts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_MODULE = pathToFileURL(join(ROOT, "server.js")).href;

const PROFILES = [
  { id: "preset", name: "Standard", voice_type: "preset", sample_count: 0 },
  { id: "jarvis-id", name: "Jarvis", voice_type: "cloned", sample_count: 1 },
  { id: "other-id", name: "Other clone", voice_type: "cloned", sample_count: 1 }
];

test("Voicebox profile discovery honors an explicit cloned id or name", () => {
  assert.equal(chooseVoiceboxProfile(PROFILES, "jarvis-id")?.id, "jarvis-id");
  assert.equal(chooseVoiceboxProfile(PROFILES, "jarvis")?.id, "jarvis-id");
  assert.equal(chooseVoiceboxProfile(PROFILES, "Standard"), null);
});

test("Voicebox profile discovery prefers Artemis/Jarvis, then a sole usable clone", () => {
  assert.equal(chooseVoiceboxProfile(PROFILES)?.id, "jarvis-id");
  assert.equal(
    chooseVoiceboxProfile([{ id: "only", name: "My voice", voice_type: "cloned", sample_count: 1 }])?.id,
    "only"
  );
  assert.equal(
    chooseVoiceboxProfile([
      { id: "one", name: "One", voice_type: "cloned", sample_count: 1 },
      { id: "two", name: "Two", voice_type: "cloned", sample_count: 1 }
    ]),
    null
  );
});

test("Voicebox provider discovers the clone and returns generated WAV audio", async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method || "GET", body: init.body });
    if (url.endsWith("/health")) {
      return Response.json({ status: "healthy", model_loaded: true });
    }
    if (url.endsWith("/profiles")) return Response.json(PROFILES);
    if (url.endsWith("/speak")) {
      return Response.json({ id: "generation-id", status: "generating" });
    }
    if (url.endsWith("/generate/generation-id/status")) {
      return new Response(
        'data: {"id":"generation-id","status":"generating"}\n\n' +
        'data: {"id":"generation-id","status":"completed","duration":1.2,"error":null}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url.endsWith("/audio/generation-id")) {
      return new Response(Buffer.from("voicebox-wav"), {
        headers: { "content-type": "audio/x-wav" }
      });
    }
    throw new Error("unexpected Voicebox request: " + url);
  };
  const provider = createVoiceboxTtsProvider({
    baseUrl: "http://voicebox.test:17493/",
    profile: "Jarvis",
    fetchImpl
  });

  const result = await provider.synthesize("Hello from Artemis.");

  assert.equal(result.audio.toString(), "voicebox-wav");
  assert.equal(result.contentType, "audio/x-wav");
  assert.equal(result.profile.id, "jarvis-id");
  assert.equal(result.generationId, "generation-id");
  assert.deepEqual(JSON.parse(requests.find((request) => request.url.endsWith("/speak")).body), {
    text: "Hello from Artemis.",
    profile: "jarvis-id",
    language: "en"
  });
  assert.equal(provider.info().available, true);
  assert.equal(provider.info().profile.name, "Jarvis");
});

test("Voicebox provider preloads a downloaded model before the first synthesis", async () => {
  const requests = [];
  let modelLoaded = false;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method || "GET" });
    if (url.endsWith("/health")) {
      return Response.json({
        status: "healthy",
        model_loaded: modelLoaded,
        model_downloaded: true,
        model_size: "1.7B"
      });
    }
    if (url.endsWith("/profiles")) return Response.json(PROFILES);
    if (url.endsWith("/models/load?model_size=1.7B")) {
      modelLoaded = true;
      return Response.json({ status: "loaded" });
    }
    if (url.endsWith("/speak")) {
      assert.equal(modelLoaded, true, "synthesis must wait for the startup preload");
      return Response.json({ id: "warm-generation", status: "completed" });
    }
    if (url.endsWith("/audio/warm-generation")) {
      return new Response(Buffer.from("warm-voicebox-wav"), {
        headers: { "content-type": "audio/x-wav" }
      });
    }
    throw new Error("unexpected Voicebox request: " + url);
  };
  const provider = createVoiceboxTtsProvider({
    baseUrl: "http://voicebox.test:17493",
    profile: "Jarvis",
    fetchImpl
  });

  await Promise.all([provider.preload(), provider.preload()]);
  const result = await provider.synthesize("Ready immediately.");

  assert.equal(result.audio.toString(), "warm-voicebox-wav");
  assert.equal(
    requests.filter((request) => request.url.includes("/models/load?")).length,
    1,
    "concurrent startup checks must share one model load"
  );
  assert.equal(provider.info().modelLoaded, true);
});

test("Voicebox synthesis stops reading status SSE as soon as completion arrives", async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "healthy", model_loaded: true, model_downloaded: true });
    }
    if (url.endsWith("/profiles")) return Response.json(PROFILES);
    if (url.endsWith("/speak")) {
      return Response.json({ id: "streaming-generation", status: "generating" });
    }
    if (url.endsWith("/generate/streaming-generation/status")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"id":"streaming-generation","status":"completed","error":null}\n\n'
          ));
          // Voicebox may keep an SSE connection alive for subsequent status events.
          // Deliberately do not close this stream.
        }
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/audio/streaming-generation")) {
      return new Response(Buffer.from("completed-voicebox-wav"));
    }
    throw new Error("unexpected Voicebox request: " + url);
  };
  const provider = createVoiceboxTtsProvider({
    baseUrl: "http://voicebox.test:17493",
    profile: "Jarvis",
    fetchImpl,
    generationTimeoutMs: 50
  });

  const result = await provider.synthesize("Do not wait for the SSE to close.");

  assert.equal(result.audio.toString(), "completed-voicebox-wav");
});

test("Voicebox cancels a stalled generation so Artemis can fall back promptly", async () => {
  let cancelled = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return Response.json({ status: "healthy", model_loaded: true, model_downloaded: true });
    }
    if (url.endsWith("/profiles")) return Response.json(PROFILES);
    if (url.endsWith("/speak")) {
      return Response.json({ id: "stalled-generation", status: "generating" });
    }
    if (url.endsWith("/generate/stalled-generation/status")) {
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" }
      });
    }
    if (url.endsWith("/generate/stalled-generation/cancel")) {
      cancelled++;
      return Response.json({ message: "cancelled" });
    }
    throw new Error("unexpected Voicebox request: " + url);
  };
  const provider = createVoiceboxTtsProvider({
    baseUrl: "http://voicebox.test:17493",
    profile: "Jarvis",
    fetchImpl,
    generationTimeoutMs: 20
  });

  assert.equal(await provider.synthesize("Fallback without a long stall."), null);
  assert.equal(cancelled, 1);
  assert.match(provider.info().error, /timed out/i);
});

test("Voicebox provider reports unavailable without throwing into the TTS route", async () => {
  const provider = createVoiceboxTtsProvider({
    fetchImpl: async () => { throw new Error("connection refused"); },
    retryDelayMs: 60_000
  });

  assert.equal(await provider.synthesize("Fallback please."), null);
  assert.equal(provider.info().available, false);
  assert.match(provider.info().error, /connection refused/);
});

test("Voicebox provider treats a malformed configured URL as unavailable", async () => {
  const provider = createVoiceboxTtsProvider({ baseUrl: "not a valid URL" });
  assert.equal(await provider.synthesize("Fallback please."), null);
  assert.equal(provider.info().available, false);
  assert.match(provider.info().error, /url/i);
});

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

async function routeProbe(mode) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(os.tmpdir(), "artemis-voicebox-test-"));
  const script = `
    import http from "node:http";
    const mode = process.env.VOICEBOX_TEST_MODE;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url === "http://127.0.0.1:17493/health") {
        if (mode === "failure") return new Response("offline", { status: 503 });
        return Response.json({ status: "healthy", model_loaded: true });
      }
      if (url === "http://127.0.0.1:17493/profiles") return Response.json(${JSON.stringify(PROFILES)});
      if (url === "http://127.0.0.1:17493/speak") {
        return Response.json({ id: "voicebox-generation", status: "generating" });
      }
      if (url.endsWith("/generate/voicebox-generation/status")) {
        return new Response('data: {"id":"voicebox-generation","status":"completed","error":null}\\n\\n');
      }
      if (url.endsWith("/audio/voicebox-generation")) {
        return new Response(Buffer.from("voicebox-route-wav"), { headers: { "content-type": "audio/x-wav" } });
      }
      if (url.startsWith("https://api.deepgram.com/")) {
        return new Response(Buffer.from("deepgram-fallback"), { headers: { "content-type": "audio/mpeg" } });
      }
      throw new Error("unexpected outbound fetch: " + url);
    };
    await import(process.env.ARTEMIS_SERVER_MODULE);
    function request(path) {
      return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: Number(process.env.PORT), path }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on("error", reject);
      });
    }
    const deadline = Date.now() + 10000;
    while (true) {
      try { if ((await request("/api/status")).status === 200) break; } catch (error) {}
      if (Date.now() >= deadline) throw new Error("server did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = await request("/api/tts?text=hello&provider=voicebox&profile=Jarvis");
    console.log("RESULT:" + JSON.stringify({
      status: result.status,
      provider: result.headers["x-tts-provider"],
      contentType: result.headers["content-type"],
      audio: result.body.toString("utf8")
    }));
    process.exit(0);
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        ARTEMIS_HOST: "127.0.0.1",
        ARTEMIS_HTTPS: "",
        ARTEMIS_REQUIRE_AUTH: "",
        ARTEMIS_DATA_DIR: dataDir,
        ARTEMIS_SERVER_MODULE: SERVER_MODULE,
        ARTEMIS_VOICEBOX_ENABLED: "1",
        ARTEMIS_VOICEBOX_PROFILE: "Jarvis",
        ARTEMIS_TTS_PROVIDER: "voicebox",
        DEEPGRAM_API_KEY: "test-deepgram",
        ELEVENLABS_API_KEY: "",
        ELEVENLABS_VOICE_ID: "",
        MINIMAX_API_KEY: "",
        MINIMAX_GROUP_ID: "",
        STRIPE_SECRET_KEY: "",
        VOICEBOX_TEST_MODE: mode
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    });
    const line = output.split("\n").find((entry) => entry.startsWith("RESULT:"));
    return JSON.parse(line.slice("RESULT:".length));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("Artemis TTS route serves Voicebox cloned-voice audio", async () => {
  const result = await routeProbe("success");
  assert.equal(result.status, 200);
  assert.equal(result.provider, "voicebox");
  assert.equal(result.contentType, "audio/x-wav");
  assert.equal(result.audio, "voicebox-route-wav");
});

test("Artemis TTS route falls back when Voicebox is unavailable", async () => {
  const result = await routeProbe("failure");
  assert.equal(result.status, 200);
  assert.equal(result.provider, "deepgram-fallback");
  assert.equal(result.audio, "deepgram-fallback");
});
