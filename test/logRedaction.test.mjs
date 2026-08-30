import assert from "node:assert/strict";
import { redactSecrets } from "../redaction.js";

const secret = "example-sensitive-value-1234567890";
const cases = [
  `https://127.0.0.1:4100/?key=${secret}`,
  `https://example.test/callback?code=${secret}&state=ok`,
  `token=${secret}`,
  `access_token=${secret}`,
  `Authorization: Bearer ${secret}`,
  `NVIDIA_API_KEY=${secret}`,
  `Cookie: artemis_auth=${secret}`,
  `https://example.test/file?X-Amz-Signature=${secret}`
];

for (const line of cases) {
  const redacted = redactSecrets(line);
  assert.doesNotMatch(redacted, new RegExp(secret), `secret survived redaction: ${line.split("=")[0]}`);
  assert.match(redacted, /\[redacted\]/);
}

assert.equal(redactSecrets("Server listening at https://127.0.0.1:4100/"),
  "Server listening at https://127.0.0.1:4100/");
assert.equal(redactSecrets("value nvapi-exampleStandaloneCredential123456"), "value [redacted]",
  "standalone provider credentials redact cleanly without leaking or adding offsets");

assert.doesNotMatch(
  redactSecrets("GOOGLE_REFRESH_TOKEN=1//0abcdefghijklmnopqrstuvwxyz"),
  /1\/\/0abcdefghijklmnopqrstuvwxyz/,
  "a Gmail refresh token is a send-capable credential and must not survive logs"
);
assert.match(redactSecrets("GOOGLE_REFRESH_TOKEN=1//0abcdefghijklmnopqrstuvwxyz"), /\[redacted\]/);
assert.doesNotMatch(
  redactSecrets("GOOGLE_CLIENT_SECRET=abcDEF1234567890secret"),
  /abcDEF1234567890secret/
);

console.log("PASS log redaction: query credentials, bearer tokens, cookies and API keys are removed");
