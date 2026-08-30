// Artemis web access — server-side, SSRF-guarded page fetch + sanitize.
// Read-only. Fetched page text is treated as UNTRUSTED DATA, never instructions.
// Zero-dependency: Node built-ins + a regex HTML→text extractor.

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { assertNetwork } from "./networkPolicy.js";

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2_500_000; // ~2.5 MB
const MAX_REDIRECTS = 3;
const ALLOWED_CT = /text\/html|text\/plain|application\/(json|xhtml\+xml)/i;

// env-configurable allow/deny (comma-separated host suffixes); private ranges always denied
const DENY = (process.env.WEB_DENY_DOMAINS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOW = (process.env.WEB_ALLOW_DOMAINS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function ipv4IsPrivate(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 special
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function ipv4FromMapped(low) {
  const dotted = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = low.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function ipv6IsLoopback(low) {
  if (low === "::1" || low === "::") return true;
  const groups = low.split(":");
  if (groups.length === 8 && groups.slice(0, 7).every((g) => /^0*$/.test(g)) && parseInt(groups[7], 16) === 1) {
    return true;
  }
  return false;
}

function ipIsPrivate(ip) {
  const raw = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(raw)) return ipv4IsPrivate(raw);
  const mapped = ipv4FromMapped(raw);
  if (mapped) return ipv4IsPrivate(mapped);
  if (net.isIPv6(raw)) {
    if (ipv6IsLoopback(raw)) return true;
    if (raw.startsWith("fc") || raw.startsWith("fd")) return true; // ULA fc00::/7
    if (raw.startsWith("fe8") || raw.startsWith("fe9") || raw.startsWith("fea") || raw.startsWith("feb"))
      return true; // link-local fe80::/10
    if (raw.startsWith("64:ff9b:")) return true; // NAT64
    return false;
  }
  return true; // unknown form → block
}

export function addressIsPrivate(ip) {
  return ipIsPrivate(ip);
}

/** One DNS answer, already checked public. http(s) must connect using only these. */
export async function resolvePublicAddresses(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("blocked host");
  }
  if (net.isIP(host) || host.includes(":")) {
    if (ipIsPrivate(host)) throw new Error("private address blocked");
    return [{ address: host.replace(/^\[|\]$/g, ""), family: net.isIPv6(host) ? 6 : 4 }];
  }
  if (DENY.some((d) => host === d || host.endsWith("." + d))) throw new Error("denied domain");
  if (ALLOW.length && !ALLOW.some((d) => host === d || host.endsWith("." + d))) {
    throw new Error("domain not in allow-list");
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error("DNS resolution failed");
  }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new Error("private address blocked");
  return addrs;
}

/** Node `http.request` lookup that cannot see a later DNS rebind. */
export function createPinnedLookup(addrs) {
  const list = Array.isArray(addrs) ? addrs : [];
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    const want = (options && options.family) || 0;
    const pick = list.find((a) => !want || a.family === want) || list[0];
    if (!pick) return cb(new Error("no pinned address"));
    if (options && options.all) return cb(null, [{ address: pick.address, family: pick.family }]);
    cb(null, pick.address, pick.family);
  };
}

function pinnedHttpGet(u, addrs, { signal, headers, timeoutMs } = {}) {
  const isTls = u.protocol === "https:";
  const lib = isTls ? https : http;
  const lookup = createPinnedLookup(addrs);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers,
      lookup,
      servername: isTls ? u.hostname : undefined,
      timeout: timeoutMs
    }, (res) => resolve(res));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (signal) {
      if (signal.aborted) { req.destroy(); reject(new Error("aborted")); return; }
      signal.addEventListener("abort", () => { req.destroy(); reject(new Error("aborted")); }, { once: true });
    }
    req.end();
  });
}

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…"
};

export function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim().slice(0, 200) : "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n");
  body = stripTags(body);
  body = decodeEntities(body)
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ");
}
function fromCodePointSafe(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return "";
  try { return String.fromCodePoint(n); } catch (e) { return ""; }
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => fromCodePointSafe(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => (ENTITIES[m.toLowerCase()] != null ? ENTITIES[m.toLowerCase()] : m));
}

// Public: fetch one URL safely and return cleaned text.
export async function fetchPage(rawUrl, maxChars = 8000, opts = {}) {
  try { assertNetwork("fetch"); } catch (error) { return { error: error.message }; }
  let url = String(rawUrl || "");
  let redirects = 0;
  maxChars = Math.max(500, Math.min(20000, Number(maxChars) || 8000));
  const resolve = opts.resolvePublicAddresses || resolvePublicAddresses;
  const httpGet = opts.httpGet || pinnedHttpGet;

  while (true) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return { error: "Invalid URL." };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "Only http(s) URLs are allowed." };
    }
    let addrs;
    try {
      addrs = await resolve(u.hostname);
    } catch (e) {
      return { error: "Blocked for safety (" + e.message + ")." };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await httpGet(u, addrs, {
        signal: ctrl.signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        lookup: createPinnedLookup(addrs),
        headers: {
          "User-Agent": "ArtemisBot/1.0 (+voice assistant; read-only)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json",
          Host: u.host
        }
      });
    } catch (e) {
      clearTimeout(timer);
      return { error: "Fetch failed or timed out." };
    }
    clearTimeout(timer);

    const status = res.statusCode ?? res.status;
    const headerGet = (name) => {
      if (typeof res.headers?.get === "function") return res.headers.get(name);
      return res.headers?.[String(name).toLowerCase()] || null;
    };
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (++redirects > MAX_REDIRECTS) return { error: "Too many redirects." };
      const loc = headerGet("location");
      if (!loc) return { error: "Redirect without location." };
      try { res.resume?.(); } catch (e) {}
      url = new URL(loc, url).toString();
      continue;
    }
    if (!(status >= 200 && status < 300)) {
      try { res.resume?.(); } catch (e) {}
      return { error: "HTTP " + status + ".", finalUrl: url };
    }

    const ct = String(headerGet("content-type") || "").toLowerCase();
    if (!ALLOWED_CT.test(ct)) {
      try { res.resume?.(); } catch (e) {}
      return { error: "Unsupported content type: " + (ct || "unknown") + ".", finalUrl: url };
    }

    let received = 0;
    const chunks = [];
    try {
      for await (const value of res) {
        received += value.length;
        if (received > MAX_BYTES) {
          try { ctrl.abort(); } catch (e) {}
          try { res.destroy?.(); } catch (e) {}
          break;
        }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      if (!chunks.length) return { error: "Failed to read response body." };
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    if (/json/.test(ct)) {
      return { finalUrl: url, title: u.hostname, text: raw.slice(0, maxChars) };
    }
    const { title, text } = htmlToText(raw);
    if (!text) return { error: "No readable text found.", finalUrl: url, title };
    return { finalUrl: url, title: title || u.hostname, text: text.slice(0, maxChars) };
  }
}

export function webAccessEnabled() {
  return true; // fetch_page works whenever the chat (Claude) is enabled
}
