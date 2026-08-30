import { writeFileSync } from "node:fs";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

let externalFetchCalls = 0;
let localFetchCalls = 0;
let tlsCalls = 0;
const fetchTargets = [];

globalThis.fetch = async (input) => {
  try {
    const url = new URL(String(input));
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) localFetchCalls += 1;
    else externalFetchCalls += 1;
    fetchTargets.push(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    externalFetchCalls += 1;
    fetchTargets.push("unparseable");
  }
  return new Response(JSON.stringify({ error: "cloud network audit trap" }), {
    status: 503,
    headers: { "content-type": "application/json" }
  });
};

tls.connect = () => {
  tlsCalls += 1;
  throw new Error("cloud TLS audit trap");
};
syncBuiltinESMExports();

process.on("exit", () => {
  const file = process.env.ARTEMIS_NETWORK_AUDIT_FILE;
  if (file) writeFileSync(file, JSON.stringify({ externalFetchCalls, localFetchCalls, tlsCalls, fetchTargets }));
});
