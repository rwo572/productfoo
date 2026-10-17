// foo social adapters — the keyless free-tier port of last30days into productfoo's
// `social` SourceClass (specs/research-social-last30d-v0, R-001). This module is
// the *fetch* layer: it is deliberately separate from research.ts (the
// deterministic, fetch-free spine) so the spine keeps its "never fetches"
// invariant. The agent invokes these adapters at gather time; foo synthesizes.
//
// Every adapter is offline-testable: network access is a single injected
// `FetchLike` (default = global fetch), so unit tests pass fixtures and no live
// I/O runs in the test suite — the same posture as src/sourceIngress.ts.
//
// Every HTTP fetch is also time-bounded: `resolveOptions` hands each adapter one
// abort signal (default ceiling `DEFAULT_FETCH_TIMEOUT_MS`, overridable with
// `timeoutMs` for tests and slow-host tuning) that the adapter passes on every
// call, so one hung endpoint can no longer stall the whole gather.

export type SocialSource = "reddit" | "hackernews" | "arxiv" | "github" | "youtube";

// A single YouTube video as yt-dlp reports it (the fields the adapter needs).
// Kept separate from SocialItem so the yt-dlp boundary is injectable and the
// adapter's orchestration (recency filter, honest status) is unit-tested with a
// fake runner — no yt-dlp binary in the test suite.
export interface YtVideo {
  id: string;
  title: string;
  url: string;
  uploader: string | null;
  uploadDate: string; // YYYYMMDD (yt-dlp's format) or ISO; the adapter normalizes
  viewCount: number | null;
}

// The injectable yt-dlp boundary. The default implementation shells out; tests
// pass a fake. `search` throws MissingBinaryError when yt-dlp is not installed
// so the adapter can degrade honestly instead of crashing the run. `transcript`
// is optional best-effort enrichment (auto-subtitles) — it returns null on any
// failure rather than throwing, so a missing transcript never fails the item.
export interface YtDlp {
  search(query: string, n: number): Promise<YtVideo[]>;
  transcript?(videoId: string): Promise<string | null>;
}

// Mirrors research.ts SourceStatus for a single adapter.
//
//   available — ran AND returned at least one item. It contributed evidence.
//   empty     — ran fine, found nothing. An honest zero: not a failure, not a
//               contribution. THIS IS NOT `available`.
//   degraded  — ran but returned partial/limited signal.
//   excluded  — asked for, could not run (all strategies failed).
//
// `empty` exists because foo reported "hackernews  available — returned 0
// story(ies)" and a reader scanning the status column saw a source that
// contributed. It contributed nothing. The old three-state enum made
// "the adapter worked" and "the source yielded evidence" the same word, and they
// are the two different facts a research tool exists to keep apart. Enforced
// centrally in gatherSocial, so no adapter can claim `available` while empty.
export type AdapterStatus = "available" | "empty" | "degraded" | "excluded";

// One normalized evidence item. Fields are the union that survives across all
// sources; `score` carries whatever engagement signal the source exposes
// (upvotes, points, stars, comments) so downstream ranking is source-agnostic.
export interface SocialItem {
  source: SocialSource;
  id: string; // stable, source-prefixed id — the dedupe key (e.g. "hn:39812345")
  title: string;
  url: string;
  author: string | null;
  createdAt: string; // ISO 8601 UTC
  score: number | null; // engagement signal; null when the source exposes none
  snippet: string | null;
}

// One adapter's outcome. `status`/`reason` feed honest per-source reporting
// (R-001 done_when) even when `items` is empty.
export interface AdapterResult {
  source: SocialSource;
  status: AdapterStatus;
  reason: string;
  items: SocialItem[];
}

// The minimal HTTP surface the adapters need — a structural subset of the
// global fetch Response so tests can supply a fake without a DOM/undici type
// dependency.
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

export interface AdapterOptions {
  days?: number; // recency window; default 30
  limit?: number; // max items per source; default 25
  now?: Date; // injectable clock so recency filtering is deterministic in tests
  fetchImpl?: FetchLike; // injectable HTTP; default = global fetch
  githubToken?: string; // optional free rate-limit raise for the GitHub adapter
  ytdlp?: YtDlp; // injectable yt-dlp boundary for the YouTube adapter (default shells out)
  timeoutMs?: number; // HTTP fetch ceiling; default DEFAULT_FETCH_TIMEOUT_MS (tests pass a tiny value)
}

export const DEFAULT_DAYS = 30;
export const DEFAULT_LIMIT = 25;
// The HTTP fetch ceiling. Before this existed a hung endpoint stalled the whole
// gather for minutes, bounded only by undici's defaults (#774).
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Resolve options to concrete values once, so each adapter shares the same
// defaults and clock. The abort signal is created HERE — one per adapter run,
// clock starting when the adapter starts — so it bounds the adapter's whole
// fetch budget (every Reddit strategy included), not each individual call.
export interface ResolvedOptions {
  days: number;
  limit: number;
  now: Date;
  fetchImpl: FetchLike;
  githubToken?: string;
  signal: AbortSignal;
}

const globalFetch: FetchLike = (url, init) =>
  // eslint-disable-next-line no-undef
  (fetch as unknown as FetchLike)(url, {
    ...init,
    // Default ceiling for direct callers; the adapters pass the resolved signal
    // explicitly so the `timeoutMs` override reaches every call.
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  });

export function resolveOptions(opts: AdapterOptions = {}): ResolvedOptions {
  return {
    days: opts.days ?? DEFAULT_DAYS,
    limit: opts.limit ?? DEFAULT_LIMIT,
    now: opts.now ?? new Date(),
    fetchImpl: opts.fetchImpl ?? globalFetch,
    githubToken: opts.githubToken,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
  };
}

/**
 * The honest-zero rule, in one place: a source that returned no items did not
 * contribute evidence, so it cannot report `available` — whatever it thinks.
 *
 * Applied at BOTH layers on purpose. Each adapter settles its own status through
 * this, so an adapter is honest when called directly; and `gatherSocial` re-applies
 * it, so a future adapter that forgets cannot reintroduce the lie. `degraded` and
 * `excluded` already carry their own meaning and pass through untouched.
 */
export function settleStatus(status: AdapterStatus, itemCount: number): AdapterStatus {
  return status === "available" && itemCount === 0 ? "empty" : status;
}

// The oldest timestamp (ms) an item may carry to fall inside the recency window.
export function windowStartMs(now: Date, days: number): number {
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

// True when `iso` parses and is at or after the window start. Unparseable dates
// are treated as out-of-window (defensive: never let a garbage date leak in).
export function withinWindow(iso: string, now: Date, days: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= windowStartMs(now, days) && t <= now.getTime() + 60_000;
}
