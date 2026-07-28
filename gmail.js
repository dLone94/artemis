// Gmail for Artemis — zero-dependency, via the Gmail REST API with an OAuth
// refresh token (Desktop-app loopback flow). Artemis implements read and
// recoverable Trash operations here; it implements no draft/send operation.
//
// One-time setup (see .env.example):
//   1. Google Cloud console → create an OAuth client, type "Desktop app".
//   2. Put GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env, restart, and open
//      http://localhost:4100/auth/google — approve, copy the refresh token
//      it prints into .env as GOOGLE_REFRESH_TOKEN, restart again.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// gmail.modify authorizes read + labels/trash and Google also accepts it for
// compose/send. Artemis deliberately exposes no draft/send endpoint here.
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";

const env = (k) => process.env[k] || "";
export function gmailConfigured() {
  return !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && env("GOOGLE_REFRESH_TOKEN"));
}
export function gmailSessionGeneration() {
  return profileCacheGeneration;
}
export function gmailAuthReady() {
  // client credentials present — enough to run the one-time consent flow
  return !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"));
}

// ---- one-time consent flow (loopback) --------------------------------------
export function gmailAuthUrl(port) {
  const q = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: `http://localhost:${port}/auth/google/callback`,
    response_type: "code",
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    scope: SCOPES,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}
export async function gmailExchangeCode(code, port) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: `http://localhost:${port}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error || "Token exchange failed (no refresh_token).");
  }
  clearAccessTokenCache();
  return data.refresh_token;
}

// ---- access token (cached until ~1 min before expiry) -----------------------
let cache = { token: "", exp: 0 };
let profileAddressCache = "";
let profileAddressPromise = null;
let profileCacheGeneration = 0;
function clearAccessTokenCache() {
  cache = { token: "", exp: 0 };
  profileAddressCache = "";
  profileAddressPromise = null;
  profileCacheGeneration++;
}
async function accessToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const generation = profileCacheGeneration;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("Gmail auth failed: " + (data.error_description || data.error || res.status));
  }
  if (generation !== profileCacheGeneration) {
    throw new Error("Gmail authorization changed during token refresh.");
  }
  cache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  return cache.token;
}
async function gapi(path) {
  const generation = profileCacheGeneration;
  const token = await accessToken();
  if (generation !== profileCacheGeneration) {
    throw new Error("Gmail authorization changed before API request.");
  }
  const res = await fetch(API + path, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (generation !== profileCacheGeneration) {
    throw new Error("Gmail authorization changed during API request.");
  }
  if (!res.ok) throw new Error("Gmail API error " + res.status + ": " + (data.error?.message || ""));
  return data;
}

// ---- helpers -----------------------------------------------------------------
function safeMailboxAddress(address) {
  if (
    !address ||
    address.length > 254 ||
    /[\p{Cc}\p{Cf}]/u.test(address)
  ) {
    return false;
  }
  const parts = address.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    !domain ||
    domain.length > 253
  ) {
    return false;
  }
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

const header = (msg, name) => {
  const values = (msg.payload?.headers || [])
    .filter((h) => String(h && h.name || "").toLowerCase() === name.toLowerCase())
    .map((h) => String(h && h.value || ""));
  // Multiple instances of an address-bearing header are ambiguous. Preserve
  // that fact as a control-separated value so recipient parsing fails closed
  // rather than silently trusting the first attacker-chosen occurrence.
  return values.length <= 1 ? (values[0] || "") : values.join("\n");
};
function decodeB64Url(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
// walk the MIME tree for the first text/plain (fall back to stripped text/html)
function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64Url(payload.body.data);
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeB64Url(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  for (const part of payload.parts || []) {
    const t = extractBody(part);
    if (t) return t;
  }
  return "";
}

// ---- public API ----------------------------------------------------------------
// List one bounded page of matching thread IDs. nextPageToken, rather than
// resultSizeEstimate or a full page, is the only honest signal that the scan was
// capped and more results exist.
export async function listThreads(q, max = 25) {
  const limit = Math.min(25, Math.max(1, Number.isFinite(max) ? Math.trunc(max) : 25));
  const params = new URLSearchParams({
    q: String(q || ""),
    maxResults: String(limit)
  });
  const data = await gapi(`/threads?${params}`);
  return {
    threads: (data.threads || [])
      .filter((thread) => thread && thread.id)
      .map((thread) => ({ id: thread.id })),
    capped: !!data.nextPageToken
  };
}

function messageMeta(message) {
  return {
    id: message.id || "",
    from: header(message, "From"),
    replyTo: header(message, "Reply-To"),
    to: header(message, "To"),
    cc: header(message, "Cc"),
    bcc: header(message, "Bcc"),
    subject: header(message, "Subject") || "(no subject)",
    date: header(message, "Date"),
    internalDate: String(message.internalDate || ""),
    labelIds: Array.isArray(message.labelIds) ? [...message.labelIds] : []
  };
}

function internalDateMs(value) {
  const raw = String(value || "");
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

// Fetch metadata only, then identify the first and last messages using Gmail's
// server-side internalDate. RFC Date and API array order are not trusted for
// age or direction decisions.
export async function getThreadMeta(id) {
  const params = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "Reply-To", "To", "Cc", "Bcc", "Subject", "Date"]) {
    params.append("metadataHeaders", name);
  }
  const thread = await gapi(`/threads/${encodeURIComponent(String(id || ""))}?${params}`);
  const messages = (thread.messages || [])
    .map(messageMeta)
    .sort((a, b) => {
      const aDate = internalDateMs(a.internalDate);
      const bDate = internalDateMs(b.internalDate);
      if (!Number.isFinite(aDate) && !Number.isFinite(bDate)) return 0;
      // Fail closed: if Gmail ever omits/mangles a timestamp, leave that
      // message last so the scanner excludes the thread instead of treating an
      // older valid message as the newest.
      if (!Number.isFinite(aDate)) return 1;
      if (!Number.isFinite(bDate)) return -1;
      return aDate - bDate;
    });
  return {
    id: thread.id || String(id || ""),
    first: messages[0] || null,
    last: messages.at(-1) || null,
    messageCount: messages.length
  };
}

// users/me/profile exposes the account's primary address. A successful lookup
// is cached per process and concurrent callers share one request; failures are
// deliberately not cached so reconnecting Gmail can recover without a restart.
export async function getProfileAddress() {
  if (profileAddressCache) return profileAddressCache;
  if (profileAddressPromise) return profileAddressPromise;
  const generation = profileCacheGeneration;
  let request;
  request = gapi("/profile")
    .then((profile) => {
      const address = String(profile && profile.emailAddress || "").trim().toLowerCase();
      if (!safeMailboxAddress(address)) {
        throw new Error("Gmail profile did not return a valid email address.");
      }
      if (generation !== profileCacheGeneration) {
        throw new Error("Gmail authorization changed during profile lookup.");
      }
      profileAddressCache = address;
      return address;
    })
    .finally(() => {
      if (profileAddressPromise === request) profileAddressPromise = null;
    });
  profileAddressPromise = request;
  return request;
}

// List recent unread from the Primary inbox: [{n, id, from, subject, date, snippet}]
export async function listUnread(max = 5) {
  const q = encodeURIComponent("is:unread category:primary");
  const list = await gapi(`/messages?q=${q}&maxResults=${Math.min(10, Math.max(1, max))}`);
  const out = [];
  for (const [i, m] of (list.messages || []).entries()) {
    const msg = await gapi(`/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    out.push({
      n: i + 1,
      id: m.id,
      from: header(msg, "From"),
      subject: header(msg, "Subject") || "(no subject)",
      date: header(msg, "Date"),
      snippet: msg.snippet || "",
    });
  }
  return out;
}
// Full readable body of one message.
export async function readMessage(id) {
  const msg = await gapi(`/messages/${id}?format=full`);
  return {
    from: header(msg, "From"),
    subject: header(msg, "Subject") || "(no subject)",
    date: header(msg, "Date"),
    body: (extractBody(msg.payload) || msg.snippet || "").slice(0, 6000),
  };
}

// Move one message to Gmail's recoverable Trash. A refresh token granted under
// the old readonly scope gets a 403 until the user completes consent again.
export async function trashMessage(id) {
  const token = await accessToken();
  const res = await fetch(`${API}/messages/${encodeURIComponent(id)}/trash`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 403) {
    clearAccessTokenCache();
    return { ok: false, status: res.status, needsReauth: true };
  }
  return { ok: res.ok, status: res.status };
}
