// GitHub adapter — the public search/issues API. Works unauthenticated (the
// free default); an optional GITHUB_TOKEN only raises the rate limit, so it
// stays a free-tier source (D-004). Unauth search is rate-limited to ~10 req/min
// and answers 403 when throttled — that degrades honestly with an upsell to set
// a token, never crashes.

import type { AdapterOptions, AdapterResult, SocialItem } from "./types.js";
import { resolveOptions, settleStatus, windowStartMs, withinWindow } from "./types.js";

const SEARCH_URL = "https://api.github.com/search/issues";

interface GitHubIssue {
  id?: number;
  title?: string;
  html_url?: string;
  user?: { login?: string } | null;
  created_at?: string;
  comments?: number;
  reactions?: { total_count?: number } | null;
}

export async function fetchGitHub(
  query: string,
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  const { days, limit, now, fetchImpl, githubToken, signal } = resolveOptions(opts);
  const sinceDate = new Date(windowStartMs(now, days)).toISOString().slice(0, 10);
  const q = `${query} created:>=${sinceDate}`;
  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(q)}` +
    `&sort=updated&order=desc&per_page=${limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    // GitHub rejects API requests without a User-Agent.
    "User-Agent": "foo-research",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  try {
    const res = await fetchImpl(url, { headers, signal });
    if (res.status === 403 || res.status === 429) {
      return {
        source: "github",
        status: "degraded",
        reason: githubToken
          ? `GitHub search rate-limited (HTTP ${res.status}) despite a token.`
          : `GitHub search rate-limited (HTTP ${res.status}); set GITHUB_TOKEN to raise the free limit.`,
        items: [],
      };
    }
    if (!res.ok) {
      return {
        source: "github",
        status: "excluded",
        reason: `GitHub search returned HTTP ${res.status}.`,
        items: [],
      };
    }
    const body = (await res.json()) as { items?: GitHubIssue[] };
    const issues = Array.isArray(body.items) ? body.items : [];
    const items = issues
      .map((issue): SocialItem | null => {
        if (issue.id == null || !issue.title || !issue.html_url || !issue.created_at) return null;
        const comments = typeof issue.comments === "number" ? issue.comments : 0;
        const reactions =
          typeof issue.reactions?.total_count === "number" ? issue.reactions.total_count : 0;
        return {
          source: "github",
          id: `github:${issue.id}`,
          title: issue.title,
          url: issue.html_url,
          author: issue.user?.login ?? null,
          createdAt: issue.created_at,
          score: comments + reactions,
          snippet: null,
        };
      })
      .filter((it): it is SocialItem => it !== null)
      .filter((it) => withinWindow(it.createdAt, now, days))
      .slice(0, limit);
    return {
      source: "github",
      status: settleStatus("available", items.length),
      reason: `GitHub returned ${items.length} issue/PR(s) within ${days}d${
        githubToken ? " (authenticated)" : " (unauthenticated)"
      }.`,
      items,
    };
  } catch (err) {
    return {
      source: "github",
      status: "excluded",
      reason: `GitHub fetch failed: ${(err as Error).message}`,
      items: [],
    };
  }
}
