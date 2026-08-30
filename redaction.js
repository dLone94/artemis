import { inspect } from "node:util";

const SECRET_PATTERNS = [
  /([?&](?:key|token|access_token|auth_token|code|signature|sig|x-amz-signature)=)[^&#\s]+/gi,
  /(\bartemis_auth=)[^;\s]+/gi,
  /(\bAuthorization\s*:\s*)(?:Bearer\s+)?\S+/gi,
  /(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET|PASSWORD)\s*=\s*)\S+/g,
  /(\b(?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential)\s*[=:]\s*)\S+/gi,
  /\b(?:(?:sk|pk|rk)[-_]|nvapi-|gsk_|sk-ant-|gh[ps]_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{10,}\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

export function redactSecrets(value) {
  let out = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]");
  }
  return out;
}

function redactArgument(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (value instanceof Error) return redactSecrets(value.stack || value.message);
  if (value && typeof value === "object") return redactSecrets(inspect(value, { depth: 5, breakLength: 120 }));
  return value;
}

let consoleProtected = false;

/** Protect every normal server console path before native code persists stdout/stderr. */
export function installConsoleRedaction(target = console) {
  if (consoleProtected) return;
  consoleProtected = true;
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    const original = target[name].bind(target);
    target[name] = (...args) => original(...args.map(redactArgument));
  }
}
