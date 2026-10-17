// Zendesk through Nango (zendesk-discovery-connector-v0, local worker mode).
//
// Nango is the credential broker only (Granola packet D-007, carried by this
// packet's D-010): productfoo asks Nango for the company's Zendesk credential and
// then talks to the Zendesk REST API directly, so comment-thread content
// never transits Nango. Everything here is content-free on every surface productfoo
// owns: credentials are held in process memory for one command, the Nango
// connection id is never printed (an opaque `connection_ref` stands in for
// it), and errors carry a typed code plus a bounded message that never
// embeds a provider response.
//
// Zendesk API shapes below are beliefs owned by the packet's feasibility task
// (T-001) and pinned by fixtures in test/discoveryZendeskRuntime.test.ts; the
// live dogfood run (T-008) is what promotes them from belief to verified.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type ZendeskRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "transcript_too_large"
  | "budget_exhausted";

export class ZendeskRuntimeError extends Error {
  constructor(public readonly code: ZendeskRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ZendeskRuntimeError";
  }
}

export type ZendeskCredential =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth2"; access_token: string };

export type ZendeskConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // Who supplied the credential: Nango (the company connection, refreshable
  // and revocable centrally) or a direct administrator-issued API token set
  // in this runtime's environment. The readiness surface reports it so the
  // direct path is never mistaken for the company connection.
  broker: "nango" | "direct";
  credential: ZendeskCredential;
  credential_type: "basic" | "oauth2";
  // Observed per connection, never assumed from a fixture (R-005): a direct
  // administrator-issued API token carries the account's full read grant; an
  // OAuth token is judged by its scopes when Nango reports them.
  comment_scope: "granted" | "missing" | "unknown";
  // The workspace's Zendesk subdomain — the API host for every request. It is
  // a workspace fact (env), not a per-person credential, and never printed.
  subdomain: string;
};

// Versioned policy fields (Granola packet R-005): hard ceilings the worker
// enforces and reports, so a later change is explicit rather than silent.
export const ZENDESK_POLICY = {
  policy_version: "zendesk-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
} as const;

// Belief, owned by the packet's feasibility task (T-001): the OAuth scope
// that carries ticket reads (comment threads included). A token without it is
// observed as `missing` and the adapter fails closed (R-005).
const ZENDESK_COMMENT_SCOPE = "tickets:read";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";

export type ZendeskConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: ZendeskConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_ZENDESK_NANGO_CONNECTION?.trim());
}

function directConfigured(env: ZendeskConnectionEnv): boolean {
  return Boolean(env.FOO_ZENDESK_API_TOKEN?.trim() && env.FOO_ZENDESK_API_TOKEN_EMAIL?.trim());
}

export function zendeskConnectionConfigured(env: ZendeskConnectionEnv): boolean {
  return nangoConfigured(env) || directConfigured(env);
}

export function zendeskCredentialBroker(env: ZendeskConnectionEnv): "nango" | "direct" | null {
  if (nangoConfigured(env)) return "nango";
  if (directConfigured(env)) return "direct";
  return null;
}

// One DNS label: Zendesk subdomains are a single label under zendesk.com.
const SUBDOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function workspaceSubdomain(env: ZendeskConnectionEnv): string {
  const subdomain = env.FOO_ZENDESK_SUBDOMAIN?.trim() ?? "";
  if (!subdomain) {
    throw new ZendeskRuntimeError("not_connected", "FOO_ZENDESK_SUBDOMAIN is not set: the workspace's Zendesk subdomain is required to reach the API host for every broker");
  }
  if (!SUBDOMAIN_SHAPE.test(subdomain)) {
    throw new ZendeskRuntimeError("not_connected", "FOO_ZENDESK_SUBDOMAIN must be the workspace's single Zendesk subdomain label, not a URL");
  }
  return subdomain.toLowerCase();
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `zendesk:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ZendeskRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new ZendeskRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized comment thread is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ZendeskRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ZendeskRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
      throw new ZendeskRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
    throw new ZendeskRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the company's Zendesk credential. Nango is the primary broker: it
 * holds the credential, refreshes it, and is where an administrator revokes
 * it. When Nango is not configured, an administrator-issued API token and
 * agent email set directly in this runtime's environment (FOO_ZENDESK_API_TOKEN
 * / FOO_ZENDESK_API_TOKEN_EMAIL) is accepted as the direct fallback — the same
 * company credential, minus the central refresh and revoke story. Either way
 * productfoo receives it for one command and never persists or prints it. The
 * workspace subdomain (FOO_ZENDESK_SUBDOMAIN) is required for both brokers.
 */
export async function resolveZendeskConnection(input: { env: ZendeskConnectionEnv; fetchImpl: FetchLike }): Promise<ZendeskConnection> {
  const broker = zendeskCredentialBroker(input.env);
  if (broker === null) {
    throw new ZendeskRuntimeError("not_connected", "Zendesk is not connected: set NANGO_SECRET_KEY and FOO_ZENDESK_NANGO_CONNECTION for the company connection through Nango, or FOO_ZENDESK_API_TOKEN and FOO_ZENDESK_API_TOKEN_EMAIL for a direct administrator-issued API token");
  }
  const subdomain = workspaceSubdomain(input.env);
  if (broker === "direct") {
    const email = input.env.FOO_ZENDESK_API_TOKEN_EMAIL!.trim();
    const token = input.env.FOO_ZENDESK_API_TOKEN!.trim();
    return {
      connection_ref: `zendesk:direct:${createHash("sha256").update(`${subdomain}\n${email}`).digest("hex").slice(0, 16)}`,
      broker: "direct",
      // Zendesk API-token auth: basic credentials whose username is the
      // agent email with the /token suffix (belief, T-001-owned).
      credential: { type: "basic", username: `${email}/token`, password: token },
      credential_type: "basic",
      comment_scope: "granted",
      subdomain,
    };
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_ZENDESK_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_ZENDESK_NANGO_INTEGRATION?.trim() || "zendesk";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, ZENDESK_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new ZendeskRuntimeError("not_connected", "Nango refused the secret key; reconnect Zendesk");
  if (response.status === 404) throw new ZendeskRuntimeError("not_connected", "Nango has no Zendesk connection with that reference; connect Zendesk first");
  if (!response.ok) throw new ZendeskRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  const ref = opaqueConnectionRef(integration, connectionId);
  if (type === "OAUTH2") {
    const token = String(credentials.access_token ?? "");
    if (!token) throw new ZendeskRuntimeError("auth_expired", "the Nango connection carries no usable Zendesk access token; refresh or reconnect");
    const raw = (credentials.raw ?? {}) as Record<string, unknown>;
    const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
    const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
    const commentScope: ZendeskConnection["comment_scope"] = scopes.length === 0 ? "unknown" : scopes.includes(ZENDESK_COMMENT_SCOPE) ? "granted" : "missing";
    return { connection_ref: ref, broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", comment_scope: commentScope, subdomain };
  }
  throw new ZendeskRuntimeError("not_connected", "the Nango connection uses a credential type productfoo does not support for Zendesk");
}

export type ZendeskListedTicket = { id: string; subject?: string; status?: string; solved_at?: string; created_at?: string; updated_at?: string; requester_id?: number; assignee_id?: number; brand_id?: number };
export type ZendeskUser = { id: number; name?: string; email?: string; role?: string };
export type ZendeskBrand = { id: number; name?: string };
export type ZendeskComment = { id?: number; author_id?: number; body?: string; public?: boolean; created_at?: string };
export type ZendeskScopeSelectorsRuntime = { external_domains?: string[]; organizations?: string[]; brands?: string[] };

// One query clause per selector value, believed Zendesk search field syntax —
// T-001 owns verifying the operators against the live search surface; the
// fixtures pin productfoo's construction so any correction is a visible change.
function zendeskQueryParts(window: { from: string; to: string }, selectors: ZendeskScopeSelectorsRuntime): string {
  const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);
  const parts = [`type:ticket`, `status:solved,closed`, `created>=${day(window.from)}`, `created<=${day(window.to)}`];
  const group = (label: string, values: string[] | undefined, wrap: (value: string) => string): string | undefined => {
    const trimmed = (values ?? []).map((value) => value.trim()).filter(Boolean);
    if (!trimmed.length) return undefined;
    const clauses = trimmed.map((value) => `${label}:${wrap(value)}`);
    return trimmed.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
  };
  // The listing is narrowed by the selectors where the search surface
  // supports it; the worker additionally narrows by requester domain and
  // solved time after the read — narrowing only, never widening (R-004).
  parts.push(...[group("requester.email", selectors.external_domains, (value) => `*@${value}`), group("organization", selectors.organizations, (value) => `"${value.replaceAll('"', "")}"`), group("brand", selectors.brands, (value) => `"${value.replaceAll('"', "")}"`)].filter((part): part is string => Boolean(part)));
  return parts.join(" ");
}

type ZendeskClientOptions = {
  fetchImpl: FetchLike;
  // Fixture seam only: overrides the https://{subdomain}.zendesk.com host so
  // a test can point the client at a local server. Every real run derives the
  // host from the connection's workspace subdomain.
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Fixture seam only: narrows the fetch ceiling so a test can observe a
  // timeout without waiting out the policy ceiling. Every real run keeps
  // ZENDESK_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

const READ_ONLY_POSTS = new Set(["/api/v2/users/show_many"]);

/**
 * Minimal read-only Zendesk REST client. Only documented read operations are
 * reachable; any other method or path routes through the single write-refusal
 * choke point (R-009) so the refusal is testable rather than scattered.
 */
export class ZendeskClient {
  readonly requests = { list: 0, users: 0, brands: 0, comments: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly credential: ZendeskCredential, private readonly subdomain: string, private readonly options: ZendeskClientOptions) {
    this.baseUrl = (options.baseUrl ?? `https://${subdomain}.zendesk.com`).replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? ZENDESK_POLICY.fetch_timeout_ms;
  }

  private authorization(): string {
    if (this.credential.type === "basic") return `Basic ${Buffer.from(`${this.credential.username}:${this.credential.password}`).toString("base64")}`;
    return `Bearer ${this.credential.access_token}`;
  }

  private async request(method: "GET" | "POST", pathname: string, body?: unknown, maxBytes: number = ZENDESK_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    const readOnly = method === "GET" || (method === "POST" && READ_ONLY_POSTS.has(pathname.split("?")[0]!));
    if (!readOnly) refuseSourceWrite(`zendesk ${method} ${pathname}`);
    const wait = this.lastRequestAt + ZENDESK_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${pathname}`,
      {
        method,
        headers: { authorization: this.authorization(), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      this.fetchTimeoutMs,
    );
    if (response.status === 401) throw new ZendeskRuntimeError("auth_expired", "Zendesk rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new ZendeskRuntimeError("access_denied", "Zendesk denied this read; the credential lacks the required permission");
    if (response.status === 429) throw new ZendeskRuntimeError("budget_exhausted", "Zendesk rate limit reached; no retry was attempted");
    if (response.status === 404) throw new ZendeskRuntimeError("provider_failure", "Zendesk reported the requested record does not exist");
    if (!response.ok) throw new ZendeskRuntimeError("provider_failure", `Zendesk answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Zendesk");
  }

  /** Bounded metadata listing: one selector set, a page ceiling, no content. */
  async listTickets(window: { from: string; to: string }, selectors: ZendeskScopeSelectorsRuntime = {}): Promise<{ tickets: ZendeskListedTicket[]; pages: number; truncated: boolean }> {
    const tickets: ZendeskListedTicket[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages >= ZENDESK_POLICY.max_list_pages) return { tickets, pages, truncated: true };
      const params = new URLSearchParams({ query: zendeskQueryParts(window, selectors) });
      if (cursor) params.set("cursor", cursor);
      this.requests.list += 1;
      const body = await this.request("GET", `/api/v2/search/export.json?${params.toString()}`, undefined, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : []) {
        if (!entry || typeof entry.id !== "number") continue;
        tickets.push({
          id: String(entry.id),
          subject: typeof entry.subject === "string" ? entry.subject : undefined,
          status: typeof entry.status === "string" ? entry.status : undefined,
          solved_at: typeof entry.solved_at === "string" ? entry.solved_at : undefined,
          created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
          requester_id: typeof entry.requester_id === "number" ? entry.requester_id : undefined,
          assignee_id: typeof entry.assignee_id === "number" ? entry.assignee_id : undefined,
          brand_id: typeof entry.brand_id === "number" ? entry.brand_id : undefined,
        });
      }
      const meta = (body.meta ?? {}) as Record<string, unknown>;
      cursor = typeof meta.after_cursor === "string" && meta.after_cursor ? meta.after_cursor : undefined;
      const hasMore = typeof meta.has_more === "boolean" ? meta.has_more : Boolean(cursor);
      if (!hasMore) return { tickets, pages, truncated: false };
    }
  }

  /** User metadata for the given ids (names, roles) — batched, no content fields. */
  async users(ids: number[]): Promise<Map<number, ZendeskUser>> {
    const out = new Map<number, ZendeskUser>();
    const unique = [...new Set(ids.filter((id) => Number.isFinite(id)))];
    for (let index = 0; index < unique.length; index += 100) {
      const batch = unique.slice(index, index + 100);
      this.requests.users += 1;
      const body = await this.request("POST", `/api/v2/users/show_many?ids=${batch.map((id) => String(id)).join(",")}`, undefined, 4 * 1024 * 1024);
      for (const entry of Array.isArray(body.users) ? (body.users as Array<Record<string, unknown>>) : []) {
        if (typeof entry.id !== "number") continue;
        out.set(entry.id, {
          id: entry.id,
          name: typeof entry.name === "string" ? entry.name : undefined,
          email: typeof entry.email === "string" ? entry.email : undefined,
          role: typeof entry.role === "string" ? entry.role : undefined,
        });
      }
    }
    return out;
  }

  /** Account brands, once per listing run, so brand_id maps to a name. */
  async brands(): Promise<Map<number, string>> {
    this.requests.brands += 1;
    const body = await this.request("GET", "/api/v2/brands.json", undefined, 1024 * 1024);
    const out = new Map<number, string>();
    for (const entry of Array.isArray(body.brands) ? (body.brands as Array<Record<string, unknown>>) : []) {
      if (typeof entry.id === "number" && typeof entry.name === "string") out.set(entry.id, entry.name);
    }
    return out;
  }

  /**
   * Exactly one ticket's comment thread (R-007). This method refuses to ask
   * for more than one identifier and a fixture observes that no request ever
   * carries more.
   */
  async comments(ticketId: string): Promise<ZendeskComment[]> {
    if (!ticketId || /[\s?&/]/.test(ticketId)) throw new ZendeskRuntimeError("provider_failure", "a single well-formed ticket identifier is required");
    this.requests.comments += 1;
    const body = await this.request("GET", `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`);
    return (Array.isArray(body.comments) ? (body.comments as Array<Record<string, unknown>>) : []).map((comment) => ({
      id: typeof comment.id === "number" ? comment.id : undefined,
      author_id: typeof comment.author_id === "number" ? comment.author_id : undefined,
      body: typeof comment.body === "string" ? comment.body : undefined,
      public: typeof comment.public === "boolean" ? comment.public : undefined,
      created_at: typeof comment.created_at === "string" ? comment.created_at : undefined,
    }));
  }
}
