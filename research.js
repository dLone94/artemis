// Artemis research engine — read-only search over OPEN sources (no login needed).
// Fixed, known-safe API hosts (no user-controlled URLs → no SSRF surface).
// Extensible: add a provider to support a new site. X/YouTube need the logged-in
// browser-extension path (deferred) — not reachable from a plain server.

import { assertNetwork } from "./networkPolicy.js";

async function fetchJson(url) {
  assertNetwork("web");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "ArtemisBot/1.0 (+research skill)", Accept: "application/json" }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = {
  hackernews: async (q, n) => {
    const r = await fetchJson(
      `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${n}&query=${encodeURIComponent(q)}`
    );
    return (r.hits || []).slice(0, n).map((h) => ({
      title: h.title || h.story_title || "(untitled)",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      meta: `${h.points || 0} points · ${h.num_comments || 0} comments`
    }));
  },
  reddit: async (q, n) => {
    const r = await fetchJson(
      `https://www.reddit.com/search.json?limit=${n}&sort=relevance&t=week&q=${encodeURIComponent(q)}`
    );
    return ((r.data && r.data.children) || []).slice(0, n).map((c) => ({
      title: c.data.title,
      url: "https://www.reddit.com" + c.data.permalink,
      meta: `r/${c.data.subreddit} · ${c.data.ups || 0} upvotes · ${c.data.num_comments || 0} comments`
    }));
  },
  github: async (q, n) => {
    const r = await fetchJson(
      `https://api.github.com/search/repositories?per_page=${n}&sort=stars&q=${encodeURIComponent(q)}`
    );
    return (r.items || []).slice(0, n).map((it) => ({
      title: it.full_name,
      url: it.html_url,
      meta: `★ ${it.stargazers_count || 0}${it.description ? " · " + it.description.slice(0, 90) : ""}`
    }));
  }
};

const ALIASES = {
  hn: "hackernews",
  hackernews: "hackernews",
  "hacker news": "hackernews",
  reddit: "reddit",
  github: "github",
  gh: "github"
};

// Reddit's provider stays below for later, but Reddit now 403s unauthenticated
// server requests, so it's not offered until we add OAuth / the extension path.
export const RESEARCH_SITES = ["hackernews", "github"];

export async function runResearch(site, query, limit = 5) {
  const key = (site || "").toLowerCase().trim();
  const provider = PROVIDERS[ALIASES[key] || key];
  if (!provider) {
    return { error: `Unsupported site "${site}". Supported right now: Hacker News, Reddit, GitHub.` };
  }
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  try {
    return { results: await provider(query, n) };
  } catch (e) {
    return { error: "Research fetch failed: " + e.message };
  }
}
