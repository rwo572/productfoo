// arXiv adapter — the public query API (export.arxiv.org), keyless, Atom XML.
// Ranked by relevance to the query (arXiv's own `sortBy=relevance`): a candidate
// pool is fetched, then the recency window is a post-filter. Newest-first was the
// bug — it returned the most-recent papers matching the AND-terms, which are
// often tangential, so a topical query came back as noise. arXiv carries no
// engagement signal, so `score` is null.

import type { AdapterOptions, AdapterResult, SocialItem } from "./types.js";
import { resolveOptions, settleStatus, withinWindow } from "./types.js";
import { parseAtomEntries } from "./xml.js";

const QUERY_URL = "https://export.arxiv.org/api/query";

// Words that carry no topical signal. Left in an AND-chain they only cost recall:
// "the" appears in every paper, so ANDing it is free, but "vs"/"using" are noise
// that a title match should not have to satisfy.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "of", "on", "or", "the", "to", "vs", "with", "what", "why", "using",
]);

/**
 * Build arXiv's `search_query`, AND-joined.
 *
 * This exists because arXiv **silently rewrites bare spaces into OR**. productfoo used to
 * send `all:kubernetes operator patterns` and arXiv answered — in its own echoed
 * query — `all:kubernetes OR all:operator OR all:patterns`. "Operator" is one of the
 * most common words in mathematics, so a Kubernetes question returned quantum
 * information theory, and a query of pure gibberish returned 25 papers. Those became
 * "findings", eligible to be typed as evidence in a research paper.
 *
 * That is fabricated evidence, and it is the worst thing a research tool can do —
 * worse than returning nothing, because nothing is honest.
 *
 * AND-joining makes the query mean what it says. A topic with no recent literature
 * now correctly returns zero.
 */
export function buildArxivQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/i)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // Nothing usable left (punctuation, or all stopwords): fall back to the raw
  // phrase, quoted. Quoting is what stops arXiv reading spaces as OR.
  if (terms.length === 0) return `all:"${query.replace(/"/g, "")}"`;
  return terms.map((t) => `all:${t}`).join(" AND ");
}

export async function fetchArxiv(
  query: string,
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  const { days, limit, now, fetchImpl, signal } = resolveOptions(opts);
  // Fetch a relevance-ranked candidate pool, then keep only the recent ones. The
  // pool is larger than `limit` so the window post-filter has relevant papers to
  // keep rather than only the newest `limit` results.
  const pool = Math.max(limit, 50);
  const url =
    `${QUERY_URL}?search_query=${encodeURIComponent(buildArxivQuery(query))}` +
    `&sortBy=relevance&sortOrder=descending&max_results=${pool}`;

  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/atom+xml" }, signal });
    if (!res.ok) {
      return {
        source: "arxiv",
        status: "excluded",
        reason: `arXiv query API returned HTTP ${res.status}.`,
        items: [],
      };
    }
    const xml = await res.text();
    const items = parseAtomEntries(xml)
      .map((e): SocialItem | null => {
        if (!e.title || !e.id) return null;
        return {
          source: "arxiv",
          id: `arxiv:${e.id}`,
          title: e.title.replace(/\s+/g, " ").trim(),
          url: e.link ?? e.id,
          author: e.author,
          createdAt: e.published ?? new Date(0).toISOString(),
          score: null,
          snippet: e.summary ? e.summary.replace(/\s+/g, " ").slice(0, 280) : null,
        };
      })
      .filter((it): it is SocialItem => it !== null)
      .filter((it) => withinWindow(it.createdAt, now, days))
      .slice(0, limit);
    return {
      source: "arxiv",
      status: settleStatus("available", items.length),
      reason: `arXiv returned ${items.length} paper(s) within ${days}d.`,
      items,
    };
  } catch (err) {
    return {
      source: "arxiv",
      status: "excluded",
      reason: `arXiv fetch failed: ${(err as Error).message}`,
      items: [],
    };
  }
}
