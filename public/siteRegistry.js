// Artemis site registry + "open a website" intent detection.
// Browser-only: Artemis can open URLs in new tabs, NOT launch native OS apps.

export const SITE_REGISTRY = {
  instagram: { label: "Instagram", url: "https://instagram.com" },
  ig: { label: "Instagram", url: "https://instagram.com" },
  chatgpt: { label: "ChatGPT", url: "https://chat.openai.com" },
  "chat gpt": { label: "ChatGPT", url: "https://chat.openai.com" },
  openai: { label: "ChatGPT", url: "https://chat.openai.com" },
  youtube: { label: "YouTube", url: "https://youtube.com" },
  yt: { label: "YouTube", url: "https://youtube.com" },
  gmail: { label: "Gmail", url: "https://mail.google.com" },
  email: { label: "Gmail", url: "https://mail.google.com" },
  twitter: { label: "X (Twitter)", url: "https://x.com" },
  x: { label: "X (Twitter)", url: "https://x.com" },
  github: { label: "GitHub", url: "https://github.com" },
  google: { label: "Google", url: "https://google.com" },
  "google maps": { label: "Google Maps", url: "https://maps.google.com" },
  "google map": { label: "Google Maps", url: "https://maps.google.com" },
  maps: { label: "Google Maps", url: "https://maps.google.com" },
  "google calendar": { label: "Google Calendar", url: "https://calendar.google.com" },
  calendar: { label: "Google Calendar", url: "https://calendar.google.com" },
  drive: { label: "Google Drive", url: "https://drive.google.com" }
};

const OPEN_RE = /\b(?:open(?:\s+up)?|launch|take me to|pull up|go to|bring up|navigate to|show me)\b\s+(.+)/i;

// The target had explicit web words on it ("WhatsApp Web", "a webpage about…"),
// so it can never be a local-app name.
const WEB_WORDED_RE = /\b(?:web|website|web\s?site|webpage|web\s?page|site|page|online|browser|tab|url|link)\b/i;

/** Extract and clean the object of an open/launch phrase, or null. */
function openObjectOf(text) {
  if (!text) return null;
  const m = String(text).trim().match(OPEN_RE);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const target = raw
    .replace(/^(?:the|my|up|to|a|an)\s+/, "")
    .replace(/\s+(?:please|for me|right now|now|website|web site|site|page|app|dot ?com)\b.*$/, "")
    .replace(/[.?!,]+$/, "")
    .trim();
  return target ? { target, raw } : null;
}

// Returns { label, url, kind } when the text is an open-a-site request the
// BROWSER should fast-path (explicit URL, bare domain, or a known registry
// site), else null — everything else goes to the assistant, where the server
// resolves installed macOS applications generically. The old behavior of
// turning short unknown targets into a Google search is exactly the bug that
// made "Open WhatsApp" search the web instead of launching the app.
export function resolveOpenIntent(text) {
  const parsed = openObjectOf(text);
  if (!parsed) return null;
  const { target } = parsed;

  // explicit URL / bare domain — but never a ".app" suffix, which is an
  // application name ("Terminal.app"), not the .app TLD
  if (!/\.app$/i.test(target) &&
      (/^https?:\/\//i.test(target) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(target))) {
    const url = /^https?:/i.test(target) ? target : "https://" + target;
    return { label: target, url, kind: "url" };
  }

  const reg = SITE_REGISTRY[target] || SITE_REGISTRY[target.replace(/\s+/g, "")];
  if (reg) return { label: reg.label, url: reg.url, kind: "registry" };

  return null; // the assistant decides: installed app, web, or clarification
}

// True LAUNCH verbs only: "show me X", "pull up X", "take me to X" are
// navigation/display phrasings and stay with the model — an app launch is
// something you open, launch, or start.
const APP_OPEN_RE = /\b(?:open(?:\s+up)?|launch|start)\b\s+(.+)/i;

// Server-side companion (pure, shared across the wire): the cleaned object of
// an "open X" phrase when X could plausibly be an INSTALLED APPLICATION —
// null whenever the phrase is web-shaped (URL, domain, registry site, web
// words) or compound enough to be a real request for the model.
export function openTargetForText(text) {
  if (!APP_OPEN_RE.test(String(text || ""))) return null;
  const parsed = openObjectOf(text);
  if (!parsed) return null;
  if (resolveOpenIntent(text)) return null;           // browser fast-path owns it
  const { target, raw } = parsed;
  if (WEB_WORDED_RE.test(raw)) return null;            // "WhatsApp Web", "a webpage about…"
  if (/^(?:it|that|this|them|those|these)\b/.test(target)) return null; // pronouns clarify elsewhere
  // Compound phrases and embedded requests belong to the model, not the
  // launcher: "open maps and find a restaurant", "pull up X in Sofia on the map".
  const isRequest = /\b(and|or|give|gimme|recommend|suggest|find|choose|pick|best|good|cheap|suitable|nearby|near|around|something|option|options|place|places|restaurant|food|cafe|coffee|that|which|where|when|how|why|who|in|on|at|for|with|about|from)\b/.test(target);
  const words = target.split(/\s+/).filter(Boolean);
  if (isRequest || words.length > 4) return null;
  if (!/^[\w .&'’+-]+$/.test(target)) return null;     // launchable names only
  return target;
}
