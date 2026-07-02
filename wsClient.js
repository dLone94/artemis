// Minimal zero-dependency WebSocket CLIENT (RFC 6455) over TLS — just enough
// to talk to Deepgram's live-transcription socket. Client-side only: we send
// masked frames (binary audio + small text control messages) and receive the
// server's unmasked text frames (JSON results). Handles ping→pong, close, and
// basic fragmentation. Not a general-purpose implementation — no extensions,
// no compression, no client-received masked frames.

import { connect as tlsConnect } from "tls";
import { randomBytes, createHash } from "crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function wsConnect({ host, path, headers = {} }, cb = {}) {
  const key = randomBytes(16).toString("base64");
  const expectAccept = createHash("sha1").update(key + GUID).digest("base64");

  let handshaken = false;
  let hsBuf = Buffer.alloc(0);
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let fragParts = [];
  let closed = false;

  const sock = tlsConnect({ host, port: 443, servername: host }, () => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "", ""
    ];
    sock.write(lines.join("\r\n"));
  });
  sock.setNoDelay(true);
  sock.setTimeout(75000, () => fail(new Error("websocket idle timeout")));

  function fail(err) {
    if (closed) return;
    closed = true;
    try { sock.destroy(); } catch (e) {}
    cb.onError && cb.onError(err);
    cb.onClose && cb.onClose();
  }

  function frame(opcode, payload) {
    // client frames MUST be masked
    const mask = randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  function deliver(opcode, payload) {
    if (opcode === 1) cb.onMessage && cb.onMessage(payload.toString("utf8"));
    else if (opcode === 2) cb.onMessage && cb.onMessage(payload); // binary (unused by Deepgram)
    else if (opcode === 8) { // close
      try { sock.write(frame(8, Buffer.alloc(0))); } catch (e) {}
      closed = true;
      try { sock.end(); } catch (e) {}
      cb.onClose && cb.onClose();
    } else if (opcode === 9) { // ping → pong (echo payload)
      try { sock.write(frame(10, payload)); } catch (e) {}
    }
    // 10 (pong): ignore
  }

  function parseFrames() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const maskBit = (buf[1] & 0x80) !== 0; // servers must not mask; tolerate anyway
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = maskBit ? 4 : 0;
      if (buf.length < off + maskLen + len) return; // wait for more bytes
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (maskBit) {
        const mask = buf.subarray(off, off + 4);
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0) { // continuation
        fragParts.push(Buffer.from(payload));
        if (fin) {
          deliver(fragOp, Buffer.concat(fragParts));
          fragOp = 0; fragParts = [];
        }
      } else if (!fin) {
        fragOp = opcode;
        fragParts = [Buffer.from(payload)];
      } else {
        deliver(opcode, payload);
      }
    }
  }

  sock.on("data", (d) => {
    if (!handshaken) {
      hsBuf = Buffer.concat([hsBuf, d]);
      const end = hsBuf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = hsBuf.subarray(0, end).toString("utf8");
      if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(expectAccept)) {
        return fail(new Error("websocket handshake failed: " + head.split("\r\n")[0]));
      }
      handshaken = true;
      cb.onOpen && cb.onOpen();
      buf = Buffer.from(hsBuf.subarray(end + 4));
      hsBuf = Buffer.alloc(0);
      parseFrames();
      return;
    }
    buf = Buffer.concat([buf, d]);
    parseFrames();
  });
  sock.on("error", fail);
  sock.on("close", () => { if (!closed) { closed = true; cb.onClose && cb.onClose(); } });

  return {
    get open() { return handshaken && !closed; },
    send(data) {
      if (closed || !handshaken) return false;
      try {
        sock.write(typeof data === "string" ? frame(1, Buffer.from(data, "utf8")) : frame(2, Buffer.from(data)));
        return true;
      } catch (e) {
        return false;
      }
    },
    close() {
      if (closed) return;
      try { sock.write(frame(8, Buffer.alloc(0))); } catch (e) {}
      setTimeout(() => { try { sock.destroy(); } catch (e) {} }, 400);
    }
  };
}
