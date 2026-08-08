import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_MODULE = pathToFileURL(join(ROOT, "server.js")).href;
const BASE_ENV = {
  LLM_PROVIDER: "groq",
  GROQ_API_KEY: "groq-key",
  GROQ_BASE_URL: "http://groq.test/v1",
  GROQ_MODEL: "quality-model",
  GROQ_FALLBACK_MODEL: "small-model",
  GROQ_CHAIN: "quality-model,openai/gpt-oss-20b,quality-model"
};

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

async function buildChain(env) {
  const port = await freePort();
  const script = `
    const { buildBrainChain } = await import(process.env.ARTEMIS_SERVER_MODULE);
    console.log("RESULT:" + JSON.stringify(buildBrainChain(JSON.parse(process.env.BRAIN_TEST_ENV))));
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ARTEMIS_HOST: "127.0.0.1",
      ARTEMIS_HTTPS: "",
      ARTEMIS_REQUIRE_AUTH: "",
      STRIPE_SECRET_KEY: "",
      ARTEMIS_SERVER_MODULE: SERVER_MODULE,
      BRAIN_TEST_ENV: JSON.stringify(env)
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const line = output.split("\n").find((entry) => entry.startsWith("RESULT:"));
  if (!line) throw new Error("brain-chain probe did not emit a result:\n" + output);
  return JSON.parse(line.slice("RESULT:".length));
}

test("buildBrainChain leaves the existing cloud chain unchanged without Ollama", async () => {
  const chain = await buildChain(BASE_ENV);
  assert.deepEqual(chain, [
    {
      name: "groq:quality-model",
      base: "http://groq.test/v1",
      key: "groq-key",
      model: "quality-model",
      extra: {}
    },
    {
      name: "groq:openai/gpt-oss-20b",
      base: "http://groq.test/v1",
      key: "groq-key",
      model: "openai/gpt-oss-20b",
      extra: { reasoning_effort: "low" }
    }
  ]);
});

test("buildBrainChain appends qwen3.5:4b as the final local tier", async () => {
  const chain = await buildChain({ ...BASE_ENV, OLLAMA_BRAIN_MODEL: "qwen3.5:4b" });
  assert.deepEqual(chain.at(-1), {
    name: "ollama:qwen3.5:4b",
    base: "http://127.0.0.1:11434/v1",
    key: "ollama",
    model: "qwen3.5:4b",
    timeoutMs: 90000
  });
});

test("Groq entries keep the shared cloud timeout", async () => {
  const chain = await buildChain({ ...BASE_ENV, OLLAMA_BRAIN_MODEL: "qwen3.5:4b" });
  const groq = chain.filter((brain) => brain.name.startsWith("groq:"));
  assert.ok(groq.length > 0);
  assert.ok(groq.every((brain) => !Object.hasOwn(brain, "timeoutMs")));
});
