import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LOCAL_SETTINGS = ".claude/settings.local.json";

const tracked = execFileSync("git", ["ls-files", "--", LOCAL_SETTINGS], { encoding: "utf8" }).trim();
assert.equal(tracked, "", "personal Claude settings must never be tracked");

const ignored = execFileSync("git", ["check-ignore", "-q", LOCAL_SETTINGS], { stdio: "ignore" });
assert.equal(ignored, null, "personal Claude settings must be ignored");

const trackedFiles = execFileSync("git", ["ls-files", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const credentialPatterns = [
  /nvapi-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gsk_[A-Za-z0-9_-]{20,}/,
  /gh[ps]_[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const offenders = [];
for (const file of trackedFiles) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  if (credentialPatterns.some((pattern) => pattern.test(text))) offenders.push(file);
}
assert.deepEqual(offenders, [], "tracked files must not contain credential-shaped values");

console.log("PASS security credentials: local settings ignored and tracked tree secret-free");
