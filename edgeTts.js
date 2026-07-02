// Microsoft Edge read-aloud TTS — free Azure NEURAL voices (the human-sounding
// ones: en-GB-SoniaNeural etc.) over the same zero-dep WebSocket client used
// for Deepgram live. UNOFFICIAL endpoint (what the Edge browser itself calls);
// if Microsoft ever changes it, callers fall back to Deepgram automatically.

import { wsConnect } from "./wsClient.js";
import { randomBytes, createHash } from "crypto";

const TRUSTED = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"; // Edge's public client token
const CHROMIUM = "136.0.3240.50"; // keep reasonably current — old versions get 403

// Sec-MS-GEC: SHA-256(windows_ticks_rounded_to_5min + trusted_token), upper hex.
// MUST be BigInt: windows ticks (~1.7e17) exceed Number's 2^53 precision and a
// float here silently corrupts the hash → 403.
function secMsGec() {
  const secs = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
  let ticks = secs * 10000000n;
  ticks -= ticks % 3000000000n; // round down to 5 minutes (in 100ns units)
  return createHash("sha256").update(ticks.toString() + TRUSTED, "ascii").digest("hex").toUpperCase();
}

const escapeXml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Synthesize `text` with an Edge neural voice → resolves to an MP3 Buffer.
export function edgeTtsSynthesize(text, voice = "en-GB-SoniaNeural") {
  return new Promise((resolve, reject) => {
    const reqId = randomBytes(16).toString("hex");
    const path =
      "/consumer/speech/synthesize/readaloud/edge/v1" +
      `?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}&ConnectionId=${reqId}`;
    const audio = [];
    let settled = false;
    let ws = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (e) {}
      if (err) reject(err);
      else resolve(Buffer.concat(audio));
    };
    const timer = setTimeout(() => finish(audio.length ? null : new Error("edge tts timeout")), 15000);

    ws = wsConnect(
      {
        host: "speech.platform.bing.com",
        path,
        headers: {
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            `Chrome/${CHROMIUM.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split(".")[0]}.0.0.0`,
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
          Pragma: "no-cache",
          "Cache-Control": "no-cache"
        }
      },
      {
        onOpen() {
          const ts = new Date().toString();
          ws.send(
            `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
          );
          const ssml =
            `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-GB'>` +
            `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`;
          ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
        },
        onMessage(msg) {
          if (typeof msg === "string") {
            if (msg.includes("Path:turn.end")) finish();
            return;
          }
          // binary frame: [2-byte BE header length][ascii header][audio bytes]
          if (msg.length < 2) return;
          const hlen = msg.readUInt16BE(0);
          if (msg.length < 2 + hlen) return;
          const header = msg.subarray(2, 2 + hlen).toString("utf8");
          if (header.includes("Path:audio")) {
            const body = msg.subarray(2 + hlen);
            if (body.length) audio.push(Buffer.from(body));
          }
        },
        onClose() { finish(audio.length ? null : new Error("edge tts closed with no audio")); },
        onError(e) { finish(e); }
      }
    );
  });
}
