// Fireflies direct-key client (fireflies-discovery-connector-v0, local worker
// mode, D-001).
//
// There is no broker: the credential is the user's own Fireflies API key (D-002
// granola rule), read from this runtime's environment for one command, held in
// process memory, never persisted or printed — an opaque `connection_ref` (a
// hash of the key) stands in for it on every report. This is the structural
// difference from gongNango (R-004: no Nango OAuth for this source): the broker
// type is `"direct" | null`, so a nango-brokered Fireflies connection is not
// even expressible here.
//
// Everything is content-free on every surface productfoo owns: errors carry a typed
// code plus a bounded message that never embeds a provider response or key
// material, responses are read under a byte ceiling, and the only HTTP paths
// are the read queries below — any GraphQL mutation routes through the single
// write-refusal choke point (R-009) so the refusal is testable, not scattered.
//
// Every provider shape below — the GraphQL endpoint, the auth header scheme,
// the field names, offset pagination — is a BELIEF owned by the packet's
// feasibility task (T-001, still open), pinned by fixtures in
// test/discoveryFireflies.test.ts. Nothing here has ever spoken to the live
// Fireflies API; the dogfood run (T-008) is what would promote these beliefs,
// with receipts.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type FirefliesRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "transcript_too_large"
  | "budget_exhausted";

export class FirefliesRuntimeError extends Error {
  constructor(public readonly code: FirefliesRuntimeErrorCode, message: string) {
    super(message);
    this.name = "FirefliesRuntimeError";
  }
}

// Versioned policy fields (R-006): hard ceilings the worker enforces and
// reports, kept identical to GONG_POLICY's values so a later divergence is an
// explicit decision — test/discoveryFireflies.test.ts pins the equality.
export const FIREFLIES_POLICY = {
  policy_version: "fireflies-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
} as const;

const DEFAULT_FIREFLIES_BASE = "https://api.fireflies.ai";

export type FirefliesConnectionEnv = Record<string, string | undefined>;

export type FirefliesConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity: a
  // hash of the key, never the key itself.
  connection_ref: string;
  // A Fireflies connection belongs to the verified user whose key it is
  // (R-010/D-002); no administrator stands over it, and member isolation is a
  // recorded gap in readiness, not a provided control.
  broker: "direct";
  credential: { type: "key"; api_key: string };
  // Transcript access is observed per connection, never assumed: it reads
  // "unknown" until an actual transcript read succeeds in this process
  // (T-008 observes it for real; fixtures only pin the shape).
  transcript_access: "granted" | "unknown";
};

export function firefliesConnectionConfigured(env: FirefliesConnectionEnv): boolean {
  return Boolean(env.FOO_FIREFLIES_API_KEY?.trim());
}

export function firefliesCredentialBroker(env: FirefliesConnectionEnv): "direct" | null {
  return firefliesConnectionConfigured(env) ? "direct" : null;
}

/**
 * Resolve the user's Fireflies connection from the environment. No network, no
 * broker: a direct read of FOO_FIREFLIES_API_KEY for one command. The key is
 * never logged; the connection_ref is a stable hash of it so reports can name
 * the connection without exposing it.
 */
export function resolveFirefliesConnection(input: { env: FirefliesConnectionEnv }): FirefliesConnection {
  const api_key = input.env.FOO_FIREFLIES_API_KEY?.trim();
  if (!api_key) {
    throw new FirefliesRuntimeError("not_connected", "Fireflies is not connected: set FOO_FIREFLIES_API_KEY to your own Fireflies API key");
  }
  return {
    connection_ref: `fireflies:direct:${createHash("sha256").update(api_key).digest("hex").slice(0, 16)}`,
    broker: "direct",
    credential: { type: "key", api_key },
    transcript_access: "unknown",
  };
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new FirefliesRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new FirefliesRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized payload is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new FirefliesRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new FirefliesRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      chunks.length = 0;
      throw new FirefliesRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseJson(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new FirefliesRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

// BELIEF (T-001): Fireflies' API is GraphQL at /graphql, bearer-key auth,
// offset pagination, and the field names below. The query strings are the
// single place to correct if the live API differs.
const FIREFLIES_VIEWER_QUERY = "query FooViewer { viewer { user_id email } }";
const FIREFLIES_LIST_QUERY =
  "query FooListTranscripts($from: String!, $to: String!, $limit: Int!, $offset: Int!) { transcripts(fromDate: $from, toDate: $to, limit: $limit, offset: $offset) { id title date end_date status participants { display_name email } } }";
const FIREFLIES_TRANSCRIPT_QUERY =
  "query FooTranscript($id: ID!) { transcript(id: $id) { title speakers { name } sentences { text start_date end_date speaker_id } } }";

const LIST_PAGE_SIZE = 50;

export type FirefliesViewer = { user_id?: string; email?: string };

// Raw transcript metadata as the list query returns it (no content fields are
// requested); the adapter consumes exactly this shape.
export type FirefliesListedTranscript = {
  id: string;
  title?: string;
  started_at?: string;
  ended?: string;
  status?: string;
  participants?: Array<{ display_name?: string; email?: string }>;
};

export type FirefliesTranscript = {
  title?: string;
  speakers?: Array<{ name?: string }>;
  sentences?: Array<{ text?: string; start_date?: string; end_date?: string; speaker_id?: string }>;
};

type FirefliesClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function epochToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Minimal read-only Fireflies GraphQL client. The single request() function is
 * the write-refusal choke point (R-009): GraphQL speaks over POST, so a
 * mutation is refused by inspecting the query text — the only read operations
 * reachable are the three query constants above.
 */
export class FirefliesClient {
  readonly requests = { viewer: 0, list: 0, transcript: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly credential: FirefliesConnection["credential"], private readonly options: FirefliesClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_FIREFLIES_BASE).replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private async request(query: string, variables: Record<string, unknown>, maxBytes: number = FIREFLIES_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    // GraphQL rides over POST, so the read-only rule is the query text: a
    // mutation never leaves this process (R-009).
    if (/\bmutation\b/i.test(query)) refuseSourceWrite(`fireflies graphql mutation`);
    const wait = this.lastRequestAt + FIREFLIES_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}/graphql`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.credential.api_key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      FIREFLIES_POLICY.fetch_timeout_ms,
    );
    if (response.status === 401) throw new FirefliesRuntimeError("auth_expired", "Fireflies rejected the API key; check the key or replace it");
    if (response.status === 403) throw new FirefliesRuntimeError("access_denied", "Fireflies denied this read; the key lacks the required access");
    if (response.status === 429) throw new FirefliesRuntimeError("budget_exhausted", "Fireflies rate limit reached; no retry was attempted");
    if (!response.ok) throw new FirefliesRuntimeError("provider_failure", `Fireflies answered ${response.status}`);
    const body = parseJson(await readBounded(response, maxBytes), "Fireflies");
    const errors = Array.isArray(body.errors) ? body.errors : [];
    if (errors.length > 0) throw new FirefliesRuntimeError("provider_failure", "Fireflies reported the query could not be served");
    const data = (body.data ?? {}) as Record<string, unknown>;
    return data;
  }

  /** Identity probe for readiness (R-005): the connection answers for one user. The result is never printed. */
  async probe(): Promise<FirefliesViewer> {
    this.requests.viewer += 1;
    const data = await this.request(FIREFLIES_VIEWER_QUERY, {}, 64 * 1024);
    const viewer = (data.viewer ?? {}) as Record<string, unknown>;
    return { user_id: stringOrUndefined(viewer.user_id), email: stringOrUndefined(viewer.email) };
  }

  /** Bounded metadata listing: one time window, a page ceiling, no content fields requested. */
  async listTranscripts(window: { from: string; to: string }): Promise<{ transcripts: FirefliesListedTranscript[]; pages: number; truncated: boolean }> {
    const transcripts: FirefliesListedTranscript[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      if (pages >= FIREFLIES_POLICY.max_list_pages) return { transcripts, pages, truncated: true };
      this.requests.list += 1;
      const data = await this.request(FIREFLIES_LIST_QUERY, { from: window.from, to: window.to, limit: LIST_PAGE_SIZE, offset }, 4 * 1024 * 1024);
      pages += 1;
      const entries = Array.isArray(data.transcripts) ? (data.transcripts as Array<Record<string, unknown>>) : [];
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string") continue;
        const participants = Array.isArray(entry.participants) ? (entry.participants as Array<Record<string, unknown>>) : [];
        transcripts.push({
          id: entry.id,
          title: stringOrUndefined(entry.title),
          started_at: epochToIso(entry.date),
          ended: epochToIso(entry.end_date),
          status: stringOrUndefined(entry.status),
          participants: participants
            .filter((participant) => participant && (typeof participant.display_name === "string" || typeof participant.email === "string"))
            .map((participant) => ({ display_name: stringOrUndefined(participant.display_name), email: stringOrUndefined(participant.email) })),
        });
      }
      if (entries.length < LIST_PAGE_SIZE) return { transcripts, pages, truncated: false };
      offset += LIST_PAGE_SIZE;
    }
  }

  /**
   * Exactly one transcript's content (R-007). A fixture observes that the
   * request carries a single well-formed identifier and nothing else.
   */
  async transcript(id: string): Promise<FirefliesTranscript> {
    if (!id || /\s/.test(id)) throw new FirefliesRuntimeError("provider_failure", "a single well-formed transcript identifier is required");
    this.requests.transcript += 1;
    const data = await this.request(FIREFLIES_TRANSCRIPT_QUERY, { id });
    const entry = (data.transcript ?? {}) as Record<string, unknown>;
    if (!entry || typeof entry !== "object") throw new FirefliesRuntimeError("access_denied", "Fireflies returned no transcript for the selected identifier");
    const speakers = Array.isArray(entry.speakers) ? (entry.speakers as Array<Record<string, unknown>>) : [];
    const sentences = Array.isArray(entry.sentences) ? (entry.sentences as Array<Record<string, unknown>>) : [];
    return {
      title: stringOrUndefined(entry.title),
      speakers: speakers.map((speaker) => ({ name: stringOrUndefined(speaker.name) })),
      sentences: sentences
        .filter((sentence) => typeof sentence.text === "string")
        .map((sentence) => ({
          text: sentence.text as string,
          start_date: stringOrUndefined(sentence.start_date),
          end_date: stringOrUndefined(sentence.end_date),
          speaker_id: stringOrUndefined(sentence.speaker_id),
        })),
    };
  }
}
