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
function clearAccessTokenCache() {
  cache = { token: "", exp: 0 };
}
async function accessToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
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
  cache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  return cache.token;
}
async function gapi(path) {
  const token = await accessToken();
  const res = await fetch(API + path, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gmail API error " + res.status + ": " + (data.error?.message || ""));
  return data;
}

// ---- helpers -----------------------------------------------------------------
const header = (msg, name) =>
  (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
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
