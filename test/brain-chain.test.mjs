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

/** Run one expression against the real server module, out of process. */
async function inServer(expression, env = {}) {
  const port = await freePort();
  const script = `
    const mod = await import(process.env.ARTEMIS_SERVER_MODULE);
    console.log("RESULT:" + JSON.stringify(await (${expression})(mod)));
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
      ...env
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const line = output.split("\n").find((entry) => entry.startsWith("RESULT:"));
  if (!line) throw new Error("server probe did not emit a result:\n" + output);
  return JSON.parse(line.slice("RESULT:".length));
}

// A DAILY limit answers "2h14m47.04s", which the old parser could not read, so
// it fell through to the 5s default. That is how "your best brain is gone until
// this evening" and "wait two seconds" became the same fact — and why nothing
// could tell the user when the good model was coming back.
test("retryHintMs reads what a provider actually says, including daily limits", async () => {
  const header = (v) => `((m) => m.retryHintMs({ headers: { get: (k) => (k === "retry-after" ? ${JSON.stringify(v)} : null) } }))`;
  assert.equal(await inServer(header("12")), 12000, "bare seconds");
  assert.equal(await inServer(header("12.5s")), 12500, "decimal seconds");
  assert.equal(await inServer(header("800ms")), 800, "milliseconds");
  assert.equal(await inServer(header("2h14m47.04s")), 8087040, "a daily limit, uncapped");
  assert.equal(await inServer(header("45m")), 2700000, "minutes alone");
  assert.equal(await inServer(header("1h")), 3600000, "hours alone");
  assert.equal(await inServer(header("later")), null, "unparseable says nothing rather than guessing");
  assert.equal(await inServer(`((m) => m.retryHintMs({ headers: { get: () => null } }))`), null, "absent header says nothing");
});

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
