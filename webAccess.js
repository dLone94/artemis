// Artemis web access — server-side, SSRF-guarded page fetch + sanitize.
// Read-only. Fetched page text is treated as UNTRUSTED DATA, never instructions.
// Zero-dependency: Node built-ins + a regex HTML→text extractor.

import dns from "node:dns/promises";
import net from "node:net";

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

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) return ipv4IsPrivate(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return ipv4IsPrivate(mapped[1]);
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb"))
      return true; // link-local fe80::/10
    return false;
  }
  return true; // unknown form → block
}

async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("blocked host");
  }
  if (DENY.some((d) => host === d || host.endsWith("." + d))) throw new Error("denied domain");
  if (ALLOW.length && !ALLOW.some((d) => host === d || host.endsWith("." + d))) {
    throw new Error("domain not in allow-list");
  }
  // resolve and reject if ANY resolved address is private/loopback/link-local
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error("DNS resolution failed");
  }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new Error("private address blocked");
}

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…"
};

function htmlToText(html) {
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
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => (ENTITIES[m.toLowerCase()] != null ? ENTITIES[m.toLowerCase()] : m));
}

// Public: fetch one URL safely and return cleaned text.
export async function fetchPage(rawUrl, maxChars = 8000) {
  let url = String(rawUrl || "");
  let redirects = 0;
  maxChars = Math.max(500, Math.min(20000, Number(maxChars) || 8000));

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
    try {
      await assertPublicHost(u.hostname);
    } catch (e) {
      return { error: "Blocked for safety (" + e.message + ")." };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "ArtemisBot/1.0 (+voice assistant; read-only)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json"
        }
      });
    } catch (e) {
      clearTimeout(timer);
      return { error: "Fetch failed or timed out." };
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (++redirects > MAX_REDIRECTS) return { error: "Too many redirects." };
      const loc = res.headers.get("location");
      if (!loc) return { error: "Redirect without location." };
      url = new URL(loc, url).toString(); // re-validated at top of loop
      continue;
    }
    if (!res.ok) return { error: "HTTP " + res.status + ".", finalUrl: url };

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ALLOWED_CT.test(ct)) return { error: "Unsupported content type: " + (ct || "unknown") + ".", finalUrl: url };

    // stream with a hard size cap
    let received = 0;
    const chunks = [];
    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_BYTES) {
          try { ctrl.abort(); } catch (e) {}
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
