// The background track has to be SEEKABLE, or resuming its position is a
// no-op.
//
// This is the non-obvious half of the "music restarts on every page change"
// bug. Remembering the position is useless if the browser then refuses to seek
// to it — and Chromium refuses whenever HTMLMediaElement.seekable is empty,
// which is exactly what happens when the server answers media with a plain 200
// and no Accept-Ranges. Proven in a real browser: with range support the bed
// resumed at 47.6s, without it the seek was rejected outright and the track
// started from zero.
//
// Spawns the REAL server on an ephemeral port (loopback needs no token).
// Run: node --test test/mediaRange.test.mjs
import assert from "node:assert";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const PORT = await freePort();
const HOST = `127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ARTEMIS_HOST: "127.0.0.1", ARTEMIS_HTTPS: "", STRIPE_SECRET_KEY: "" },
  stdio: ["ignore", "ignore", "ignore"]
});

const deadline = Date.now() + 20000;
let up = false;
while (Date.now() < deadline && !up) {
  try { up = (await request(PORT, "/api/status", { host: HOST })).status === 200; } catch (e) { /* booting */ }
  if (!up) await new Promise((r) => setTimeout(r, 200));
}

test.after(() => child.kill("SIGTERM"));

test("the server advertises byte ranges, so media can be seeked", async () => {
  assert.ok(up, "server did not boot");
  const res = await request(PORT, "/musicLevels.js", { host: HOST });
  assert.equal(res.status, 200);
  assert.equal(res.headers["accept-ranges"], "bytes",
    "without Accept-Ranges the browser leaves seekable empty and refuses every seek");
});

test("a range request returns 206 with exactly the bytes asked for", async () => {
  assert.ok(up, "server did not boot");
  const whole = await request(PORT, "/musicLevels.js", { host: HOST });
  const part = await request(PORT, "/musicLevels.js", { host: HOST, range: "bytes=10-19" });

  assert.equal(part.status, 206, "a range request must be answered 206, not 200");
  assert.equal(part.body.length, 10, "exactly the ten bytes requested");
  assert.deepEqual(part.body, whole.body.subarray(10, 20), "and they must be the right ten bytes");
  assert.match(String(part.headers["content-range"]), /^bytes 10-19\/\d+$/);
});

test("an open-ended range runs to the end of the file", async () => {
  const whole = await request(PORT, "/musicLevels.js", { host: HOST });
  const tail = await request(PORT, "/musicLevels.js", { host: HOST, range: "bytes=5-" });
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.body, whole.body.subarray(5));
});

test("a suffix range returns the last N bytes", async () => {
  const whole = await request(PORT, "/musicLevels.js", { host: HOST });
  const suffix = await request(PORT, "/musicLevels.js", { host: HOST, range: "bytes=-12" });
  assert.equal(suffix.status, 206);
  assert.deepEqual(suffix.body, whole.body.subarray(whole.body.length - 12));
});

test("a range past the end is refused with 416, not a wrong body", async () => {
  const res = await request(PORT, "/musicLevels.js", { host: HOST, range: "bytes=99999999-" });
  assert.equal(res.status, 416);
  assert.match(String(res.headers["content-range"]), /^bytes \*\/\d+$/);
});

test("an ordinary request is completely unaffected", async () => {
  // Range support must not change what every other request already receives.
  const res = await request(PORT, "/musicLevels.js", { host: HOST });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /javascript/);
  assert.match(String(res.headers["cache-control"]), /no-store/);
  assert.match(res.body.toString("utf8"), /BACKGROUND_MUSIC_GAIN/);
});

test("HTML is still version-stamped, and ranges agree with what it serves", async () => {
  // index.html gets its asset URLs rewritten at serve time. A range must be
  // taken over the REWRITTEN bytes or Content-Length and body disagree.
  const whole = await request(PORT, "/index.html", { host: HOST });
  assert.equal(whole.status, 200);
  assert.match(whole.body.toString("utf8"), /\.js\?v=/, "asset stamping must still happen");

  const part = await request(PORT, "/index.html", { host: HOST, range: "bytes=0-49" });
  assert.equal(part.status, 206);
  assert.deepEqual(part.body, whole.body.subarray(0, 50), "ranged bytes must come from the stamped document");
});
