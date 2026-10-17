// Social adapter orchestrator — runs the enabled keyless adapters, merges and
// dedupes their evidence, and returns both the items and honest per-source
// reports (R-001). The spine (research.ts) reports the `social` class; this is
// the gather step the agent runs to populate it.

import { fetchArxiv } from "./arxiv.js";
import { fetchGitHub } from "./github.js";
import { fetchHackerNews } from "./hackernews.js";
import { fetchReddit } from "./reddit.js";
import { fetchYouTube } from "./youtube.js";
import type { AdapterOptions, AdapterResult, SocialItem, SocialSource } from "./types.js";

// V0 sources (D-002). Reddit/HN/arXiv/GitHub are keyless HTTP; YouTube is keyless
// via the yt-dlp binary (degrades if absent). X and the paid tier are V1 (D-006).
export const DEFAULT_SOURCES: SocialSource[] = [
  "reddit",
  "hackernews",
  "arxiv",
  "github",
  "youtube",
];

type Adapter = (query: string, opts: AdapterOptions) => Promise<AdapterResult>;

// Registry of implemented adapters. Requesting a source not present here yields
// an honest `excluded` report rather than a silent drop.
const ADAPTERS: Partial<Record<SocialSource, Adapter>> = {
  reddit: fetchReddit,
  hackernews: fetchHackerNews,
  arxiv: fetchArxiv,
  github: fetchGitHub,
  youtube: fetchYouTube,
};

export interface GatherResult {
  items: SocialItem[];
  reports: AdapterResult[];
}

// Dedupe by stable id first, then collapse cross-source near-duplicates that
// point at the same URL, keeping the higher-scored copy so engagement signal
// survives the merge.
export function dedupe(items: SocialItem[]): SocialItem[] {
  const byId = new Map<string, SocialItem>();
  for (const it of items) {
    if (!byId.has(it.id)) byId.set(it.id, it);
  }
  const byUrl = new Map<string, SocialItem>();
  for (const it of byId.values()) {
    const key = normalizeUrl(it.url);
    const existing = byUrl.get(key);
    if (!existing || (it.score ?? -1) > (existing.score ?? -1)) {
      byUrl.set(key, it);
    }
  }
  return [...byUrl.values()];
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Drop trailing slash + tracking-ish query noise for a stable dedupe key.
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export async function gatherSocial(
  query: string,
  opts: AdapterOptions & { sources?: SocialSource[] } = {},
): Promise<GatherResult> {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const reports = await Promise.all(
    sources.map((source) => {
      const adapter = ADAPTERS[source];
      if (!adapter) {
        return Promise.resolve<AdapterResult>({
          source,
          status: "excluded",
          reason: `${source} adapter not yet implemented in this build.`,
          items: [],
        });
      }
      return adapter(query, opts);
    }),
  );
  // "It ran" and "it found something" are different facts, and a research tool
  // exists to keep them apart. An adapter that returns zero items has not
  // contributed evidence, whatever it thinks its status is — so the honest zero is
  // enforced here, once, rather than trusted to each adapter. `degraded` and
  // `excluded` already carry their own reason and are left alone.
  const honest = reports.map((r): AdapterResult =>
    r.status === "available" && r.items.length === 0 ? { ...r, status: "empty" } : r,
  );

  const items = dedupe(honest.flatMap((r) => r.items)).sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1),
  );
  return { items, reports: honest };
}
