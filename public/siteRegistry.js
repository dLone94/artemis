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

// Returns { label, url, kind, term? } when the text is an open-a-site request, else null.
export function resolveOpenIntent(text) {
  if (!text) return null;
  const m = String(text).trim().match(OPEN_RE);
  if (!m) return null;

  let target = m[1]
    .toLowerCase()
    .replace(/^(?:the|my|up|to|a|an)\s+/, "")
    .replace(/\s+(?:please|for me|right now|now|website|web site|site|page|app|dot ?com)\b.*$/, "")
    .replace(/[.?!,]+$/, "")
    .trim();
  if (!target) return null;

  // explicit URL / bare domain
  if (/^https?:\/\//i.test(target) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(target)) {
    const url = /^https?:/i.test(target) ? target : "https://" + target;
    return { label: target, url, kind: "url" };
  }

  const reg = SITE_REGISTRY[target] || SITE_REGISTRY[target.replace(/\s+/g, "")];
  if (reg) return { label: reg.label, url: reg.url, kind: "registry" };

  // Not a known site. Only fall back to a quick Google search for SHORT, simple
  // targets ("open cnn", "open hacker news"). Anything that looks like a real
  // request — compound or a question — must go to Claude, so we DON'T swallow
  // things like "open maps AND find a restaurant for my daughter".
  const isRequest = /\b(and|or|give|gimme|recommend|suggest|find|choose|pick|best|good|cheap|suitable|nearby|near|around|something|option|options|place|places|restaurant|food|cafe|coffee|that|which|where|when|how|why|who)\b/.test(target);
  const words = target.split(/\s+/).filter(Boolean);
  if (isRequest || words.length > 3) return null; // let the AI handle it

  return {
    label: `a search for "${target}"`,
    url: "https://www.google.com/search?q=" + encodeURIComponent(target),
    kind: "search",
    term: target
  };
}
