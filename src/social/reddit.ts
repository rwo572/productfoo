// Reddit adapter — the one non-trivial port. Bare reddit.com/*.json rate-limits
// hard (429/403), which is why last30days ships several strategies.
//
// HONEST LIMITATION (found by the dependency watcher, 2026-07-12): Arctic Shift
// CANNOT serve a global keyword search — its API answers
//   "'query' query parameter requires one of: author, subreddit"
// so an arctic call with only a query returns HTTP 400, always. It was in this
// chain and had never once worked; the fallback masked it. It is removed rather
// than left as a strategy that silently fails. (It does work when scoped to a
// subreddit — see OQ: use it for subreddit-scoped search, which would restore an
// off-reddit.com fallback.)
//
// So the chain is Reddit Atom (.rss) → Reddit public JSON. Both live on
// reddit.com and therefore throttle TOGETHER: there is currently no off-domain
// fallback for global keyword search. Resilience here is weaker than a
// multi-host chain, and the spec says so rather than implying otherwise. A
// strategy that throws or 429s drops to the next; the source is only `excluded`
// if all fail (R-001 done_when).
//
// Reddit asks clients to send a descriptive User-Agent; we do (it is correct
// practice, though it does not by itself defeat rate limiting).

import type { AdapterOptions, AdapterResult, SocialItem } from "./types.js";
import { resolveOptions, settleStatus, windowStartMs, withinWindow } from "./types.js";
import type { ResolvedOptions } from "./types.js";
import { parseAtomEntries } from "./xml.js";

// The JSON shape shared by Arctic Shift and Reddit public listings.
interface RedditPost {
  id?: string;
  title?: string;
  permalink?: string;
  url?: string;
  author?: string;
  created_utc?: number; // epoch seconds
  score?: number;
  selftext?: string;
}

function postToItem(p: RedditPost): SocialItem | null {
  if (!p.id || !p.title) return null;
  const createdSec = typeof p.created_utc === "number" ? p.created_utc : 0;
  return {
    source: "reddit",
    id: `reddit:${p.id}`,
    title: p.title,
    url: p.permalink ? `https://www.reddit.com${p.permalink}` : p.url || "",
    author: p.author ?? null,
    createdAt: new Date(createdSec * 1000).toISOString(),
    score: typeof p.score === "number" ? p.score : null,
    snippet: p.selftext ? p.selftext.slice(0, 280) : null,
  };
}

function filterAndCap(items: (SocialItem | null)[], o: ResolvedOptions): SocialItem[] {
  return items
    .filter((it): it is SocialItem => it !== null && Boolean(it.url))
    .filter((it) => withinWindow(it.createdAt, o.now, o.days))
    .slice(0, o.limit);
}

// Reddit asks for a unique, descriptive User-Agent on API-ish requests.
const REDDIT_UA = "foo-research/0.1 (+https://github.com/rwo572/productfoo)";

async function redditRss(query: string, o: ResolvedOptions): Promise<SocialItem[]> {
  const url =
    `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=month`;
  const res = await o.fetchImpl(url, {
    headers: { Accept: "application/atom+xml", "User-Agent": REDDIT_UA },
    signal: o.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseAtomEntries(xml).map((e): SocialItem | null => {
    if (!e.title || !e.link) return null;
    // Reddit Atom ids look like "t3_abcdef"; fall back to the link.
    const id = e.id ? e.id.replace(/^.*?(t3_[a-z0-9]+).*$/i, "$1") : e.link;
    return {
      source: "reddit",
      id: `reddit:${id}`,
      title: e.title,
      url: e.link,
      author: e.author,
      createdAt: e.published ?? new Date(0).toISOString(),
      score: null, // the Atom feed carries no engagement score
      snippet: e.summary ? e.summary.slice(0, 280) : null,
    };
  });
  return filterAndCap(items, o);
}

async function redditPublicJson(query: string, o: ResolvedOptions): Promise<SocialItem[]> {
  const url =
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}` +
    `&sort=relevance&t=month&limit=${o.limit}`;
  const res = await o.fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": REDDIT_UA },
    signal: o.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { children?: { data?: RedditPost }[] } };
  const children = body.data?.children ?? [];
  return filterAndCap(
    children.map((c) => (c.data ? postToItem(c.data) : null)),
    o,
  );
}

// arctic is deliberately absent: its API cannot do a global keyword search, so
// it returned HTTP 400 on every call (see the header note). Both remaining
// strategies are on reddit.com and throttle together — a known, recorded
// resilience gap, not a silent one.
const STRATEGIES: { name: string; run: (q: string, o: ResolvedOptions) => Promise<SocialItem[]> }[] =
  [
    { name: "rss", run: redditRss },
    { name: "public", run: redditPublicJson },
  ];

export async function fetchReddit(
  query: string,
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  const o = resolveOptions(opts);
  const tried: string[] = [];
  for (const strategy of STRATEGIES) {
    try {
      const items = await strategy.run(query, o);
      if (items.length > 0) {
        const prior = tried.length ? ` (after ${tried.join(", ")})` : "";
        return {
          source: "reddit",
          status: settleStatus("available", items.length),
          reason: `Reddit via ${strategy.name}: ${items.length} post(s) within ${o.days}d${prior}.`,
          items,
        };
      }
      tried.push(`${strategy.name}: empty`);
    } catch (err) {
      tried.push(`${strategy.name}: ${(err as Error).message}`);
    }
  }
  // Every strategy either failed or returned nothing. If any strategy actually
  // ran without error we degraded (no signal); if all threw we exclude.
  const allErrored = tried.every((t) => !t.endsWith("empty"));
  return {
    source: "reddit",
    status: allErrored ? "excluded" : "degraded",
    reason: `Reddit returned no usable posts — ${tried.join("; ")}.`,
    items: [],
  };
}
