// Offline / local-only mode, enforced at the tool-routing level.
//
// This is not "please don't use the internet" in a prompt. Model routing and
// tools ask this module whether network access is allowed, and a request that
// genuinely requires the internet gets an honest refusal instead of a silent
// violation.
//
// What stays available offline: the local brain tier (Ollama on loopback),
// terminal execution, screen perception (Accessibility / capture / Vision OCR
// are all local), presence/pill state, local TTS via /usr/bin/say.
// What is refused offline: cloud brains, web search/fetch, Gmail, cloud STT,
// cloud TTS, and anything else that leaves the machine.

let offline = String(process.env.ARTEMIS_OFFLINE || "") === "1";
const listeners = new Set();

export function isOffline() {
  return offline;
}

export function setOffline(value) {
  const next = !!value;
  if (next === offline) return offline;
  offline = next;
  for (const fn of listeners) {
    try { fn(offline); } catch (e) {}
  }
  return offline;
}

export function onOfflineChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is this base URL a local endpoint (loopback / unix-adjacent)? */
export function isLocalEndpoint(base) {
  try {
    const url = new URL(String(base));
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch (e) {
    return false;
  }
}

/** A brain entry survives offline mode only if it is served locally. */
export function brainAllowed(brain) {
  if (!offline) return true;
  return !!brain && (String(brain.name || "").startsWith("ollama:") || isLocalEndpoint(brain.base));
}

/** Filter a brain chain down to what the current mode allows. */
export function allowedBrains(chain) {
  return (chain || []).filter((b) => brainAllowed(b));
}

/**
 * Gate for a network-touching operation. Kinds are coarse on purpose — the
 * caller names what it is about to do, this decides yes/no and owns the copy.
 * Local kinds are always allowed so the gate can be called unconditionally.
 */
const LOCAL_KINDS = new Set(["terminal", "perception", "ocr", "local_tts", "local_brain", "presence"]);

export function networkAllowed(kind) {
  if (LOCAL_KINDS.has(kind)) return true;
  return !offline;
}

export class OfflineError extends Error {
  constructor(kind) {
    super(offlineRefusal(kind));
    this.name = "OfflineError";
    this.offline = true;
    this.kind = kind;
  }
}

export function assertNetwork(kind) {
  if (!networkAllowed(kind)) throw new OfflineError(kind);
}

/** Guard a transport leaf while preserving explicitly local loopback providers. */
export function assertNetworkEndpoint(endpoint, kind = "cloud") {
  if (isLocalEndpoint(endpoint)) return;
  assertNetwork(kind);
}

export function offlineRefusal(kind) {
  const what = {
    web: "web access",
    search: "web search",
    fetch: "fetching that page",
    gmail: "checking email",
    cloud_brain: "the cloud brain",
    cloud_tts: "cloud speech synthesis",
    cloud_stt: "cloud transcription",
    telemetry: "sending telemetry"
  }[kind] || "internet access";
  return `That requires ${what}. Local-only mode is enabled.`;
}

/** Snapshot for /api/config and the dashboard. */
export function offlineState() {
  return { offline };
}
