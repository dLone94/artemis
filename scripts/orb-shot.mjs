// scripts/orb-shot.mjs — screenshot the orb in a given status.
// Usage: node scripts/orb-shot.mjs <idle|listening|thinking|speaking> <out.png>
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const PW = "/Users/todortopalov/Documents/Claude Code Apps/Storytel clone/node_modules/playwright-core/index.mjs";
const [status = "idle", out = `artifacts/orb-${status}.png`] = process.argv.slice(2);

const server = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: "4199" },
  stdio: "ignore",
});
try {
  await wait(1500);
  const { chromium } = await import(PW);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:4199/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__voiceOrb, null, { timeout: 10000 });
  await page.evaluate(() => {
    document.getElementById("boot")?.remove();
    document.body.classList.add("hud-in");
  });
  await page.evaluate((s) => window.__voiceOrb.setStatus(s), status);
  if (status === "speaking") {
    // Engage the synthetic speech envelope (same path production TTS uses)
    // so the voice ribbon and coil bands animate, then top up amplitude.
    await page.evaluate(() => {
      window.__voiceOrb.connectMediaElement(null);
      window.__voiceOrb.feed(0.7);
    });
  }
  await wait(1800); // let state mixes ease in (~600ms) + rings move
  await page.screenshot({ path: out });
  await browser.close();
  console.log("WROTE", out);
} finally {
  server.kill();
}
