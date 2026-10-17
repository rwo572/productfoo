// Hacker News adapter — the cleanest keyless source. Uses the public Algolia
// search API (hn.algolia.com/api/v1), no key, no cookies. Uses `search`
// (relevance-ranked), not `search_by_date` (newest-first): a recency-only sort
// returned the newest stories that mentioned the terms rather than the ones
// actually about the topic. The recency window stays as a server-side numeric
// filter plus a post-filter for safety.

import type { AdapterOptions, AdapterResult, SocialItem } from "./types.js";
import { resolveOptions, settleStatus, windowStartMs, withinWindow } from "./types.js";

const SEARCH = "https://hn.algolia.com/api/v1/search";

interface AlgoliaHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  created_at?: string | null;
  points?: number | null;
  num_comments?: number | null;
  story_text?: string | null;
}

function toItem(hit: AlgoliaHit): SocialItem | null {
  if (!hit.objectID || !hit.title || !hit.created_at) return null;
  const points = typeof hit.points === "number" ? hit.points : 0;
  const comments = typeof hit.num_comments === "number" ? hit.num_comments : 0;
  return {
    source: "hackernews",
    id: `hn:${hit.objectID}`,
    title: hit.title,
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author ?? null,
    createdAt: hit.created_at,
    // Engagement = upvotes plus discussion; both are real signal on HN.
    score: points + comments,
    snippet: hit.story_text ? hit.story_text.slice(0, 280) : null,
  };
}

export async function fetchHackerNews(
  query: string,
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  const { days, limit, now, fetchImpl, signal } = resolveOptions(opts);
  const sinceSec = Math.floor(windowStartMs(now, days) / 1000);
  // Relevance-ranked within the window; fetch a pool larger than `limit` so the
  // post-filter and slice keep the most relevant in-window stories, not the first
  // `limit` the API happened to return.
  const pool = Math.max(limit, 50);
  const url =
    `${SEARCH}?query=${encodeURIComponent(query)}` +
    `&tags=story&numericFilters=created_at_i>=${sinceSec}&hitsPerPage=${pool}`;

  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) {
      return {
        source: "hackernews",
        status: "excluded",
        reason: `HN Algolia returned HTTP ${res.status}.`,
        items: [],
      };
    }
    const body = (await res.json()) as { hits?: AlgoliaHit[] };
    const hits = Array.isArray(body.hits) ? body.hits : [];
    const items = hits
      .map(toItem)
      .filter((it): it is SocialItem => it !== null)
      .filter((it) => withinWindow(it.createdAt, now, days))
      .slice(0, limit);
    return {
      source: "hackernews",
      status: settleStatus("available", items.length),
      reason: `HN Algolia returned ${items.length} story(ies) within ${days}d.`,
      items,
    };
  } catch (err) {
    return {
      source: "hackernews",
      status: "excluded",
      reason: `HN Algolia fetch failed: ${(err as Error).message}`,
      items: [],
    };
  }
}
