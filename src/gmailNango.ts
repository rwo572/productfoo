// Gmail through Nango (gmail-discovery-connector-v0, local worker mode).
//
// Nango is the credential broker (R-001 reuses the gong shape verbatim): productfoo
// asks Nango for the verified user's Gmail credential and then talks to the
// Gmail REST API directly, so message bodies never transit Nango. The
// connection is per-user (D-002) — a mailbox is personal even at work — so
// unlike Gong there is no administrator-issued direct-key fallback: a personal
// OAuth grant through Nango is the only path, and readiness reports that
// broker truthfully. Credentials are held in process memory for one command,
// the Nango connection id is never printed (an opaque `connection_ref` stands
// in for it), and errors carry a typed code plus a bounded message that never
// embeds a provider response.
//
// Gmail API shapes below are beliefs owned by the packet's feasibility task
// (T-001) and pinned by fixtures in test/discoveryGmailRuntime.test.ts;
// nothing here is verified-live, and support stays contract_only.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type GmailRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "thread_too_large"
  | "budget_exhausted";

export class GmailRuntimeError extends Error {
  constructor(public readonly code: GmailRuntimeErrorCode, message: string) {
    super(message);
    this.name = "GmailRuntimeError";
  }
}

export type GmailConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // Always "nango" (D-002): a per-user mailbox has no administrator-issued
  // key. Reported so a future broker change can never arrive silently.
  broker: "nango";
  credential: { type: "oauth2"; access_token: string };
  credential_type: "oauth2";
  // Observed from the connection's OAuth scope report, never assumed
  // (R-005): message bodies need the least-privilege read-only scope. Absent
  // or unknown fails closed, so a fixture cannot manufacture body access.
  body_scope: "granted" | "missing" | "unknown";
};

// Versioned policy (R-007): hard ceilings the worker enforces and reports, so
// a later change is explicit rather than silent. quiet_period_hours is D-001's
// pinned quiet period (T-005): a thread is settled evidence once its last
// message predates the scope window's end by this much, unless an explicit
// done label (GMAIL_DONE_LABELS) marks it sooner.
export const GMAIL_POLICY = {
  policy_version: "gmail-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
  quiet_period_hours: 48,
} as const;

// Least-privilege read-only Gmail scopes (R-003). Listing bounded metadata
// needs gmail.metadata; reading a selected thread's message bodies needs
// gmail.readonly — never the full mail scope. A connection without the body
// scope stays useful for metadata and reports needs_provider_access for reads
// (R-008).
const GMAIL_BODY_SCOPE = "gmail.readonly";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_GMAIL_BASE = "https://gmail.googleapis.com";

export type GmailConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: GmailConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_GMAIL_NANGO_CONNECTION?.trim());
}

export function gmailConnectionConfigured(env: GmailConnectionEnv): boolean {
  return nangoConfigured(env);
}

export function gmailCredentialBroker(_env: GmailConnectionEnv): "nango" | null {
  // Per-user ownership (D-002): Nango is the only broker. The parameter keeps
  // the gong broker signature so callers stay parallel.
  return "nango";
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `gmail:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new GmailRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new GmailRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized thread is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new GmailRuntimeError("thread_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new GmailRuntimeError("thread_too_large", "the provider response exceeds the byte ceiling");
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
      throw new GmailRuntimeError("thread_too_large", "the provider response exceeds the byte ceiling");
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
    throw new GmailRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the verified user's Gmail credential through Nango. There is no
 * direct fallback (D-002): the mailbox belongs to one person, so the OAuth
 * grant is always brokered, refreshable, and revocable centrally. productfoo receives
 * the token for one command and never persists or prints it.
 */
export async function resolveGmailConnection(input: { env: GmailConnectionEnv; fetchImpl: FetchLike }): Promise<GmailConnection> {
  if (!nangoConfigured(input.env)) {
    throw new GmailRuntimeError("not_connected", "Gmail is not connected: connect the mailbox through Nango and set NANGO_SECRET_KEY and FOO_GMAIL_NANGO_CONNECTION (plus NANGO_HOST / FOO_GMAIL_NANGO_INTEGRATION when they differ from the defaults)");
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_GMAIL_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_GMAIL_NANGO_INTEGRATION?.trim() || "google-mail";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, GMAIL_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new GmailRuntimeError("not_connected", "Nango refused the secret key; reconnect Gmail");
  if (response.status === 404) throw new GmailRuntimeError("not_connected", "Nango has no Gmail connection with that reference; connect Gmail first");
  if (!response.ok) throw new GmailRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  if (type !== "OAUTH2") throw new GmailRuntimeError("not_connected", "the Nango connection uses a credential type productfoo does not support for Gmail");
  const token = String(credentials.access_token ?? "");
  if (!token) throw new GmailRuntimeError("auth_expired", "the Nango connection carries no usable Gmail access token; refresh or reconnect");
  const raw = (credentials.raw ?? {}) as Record<string, unknown>;
  const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
  const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
  const bodyScope: GmailConnection["body_scope"] = scopes.length === 0 ? "unknown" : scopes.some((scope) => scope.includes(GMAIL_BODY_SCOPE)) ? "granted" : "missing";
  return { connection_ref: opaqueConnectionRef(integration, connectionId), broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", body_scope: bodyScope };
}

export type GmailThreadRef = { id: string; snippet?: string };
export type GmailMessageHeader = { name?: string; value?: string };

// Parsed thread payload. Attachment parts are never fetched and their body
// data is never decoded — only text/plain parts in the thread response itself
// are read (D-003). Attachment metadata (filename, id) is dropped here.
export type GmailThreadMessage = {
  id: string;
  internal_date?: string;
  labels?: string[];
  from?: { display_name?: string; email?: string };
  to?: Array<{ display_name?: string; email?: string }>;
  subject?: string;
  body_text?: string;
};

export type GmailThread = { id: string; messages: GmailThreadMessage[] };

type GmailClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchTimeoutMs?: number;
};

/**
 * Minimal read-only Gmail REST client. Only documented read operations are
 * reachable — every request method is GET and anything else routes through
 * the single write-refusal choke point (R-009), so the refusal is testable
 * rather than scattered. There is no attachment fetch method at all (D-003).
 */
export class GmailClient {
  readonly requests = { profile: 0, list: 0, metadata: 0, thread: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly credential: { type: "oauth2"; access_token: string }, private readonly options: GmailClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GMAIL_BASE).replace(/\/+$/, "");
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? GMAIL_POLICY.fetch_timeout_ms;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private async request(method: "GET" | "POST", pathname: string, maxBytes: number = GMAIL_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    // R-009: the client is GET-shaped by construction; a future caller that
    // tries a write lands here, at the one choke point — the same gate the
    // Gong client applies to its non-read methods.
    if (method !== "GET") refuseSourceWrite(`gmail ${method} ${pathname}`);
    const wait = this.lastRequestAt + GMAIL_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${pathname}`,
      { method: "GET", headers: { authorization: `Bearer ${this.credential.access_token}`, accept: "application/json" } },
      this.fetchTimeoutMs,
    );
    if (response.status === 401) throw new GmailRuntimeError("auth_expired", "Gmail rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new GmailRuntimeError("access_denied", "Gmail denied this read; the connection lacks the required scope");
    if (response.status === 429) throw new GmailRuntimeError("budget_exhausted", "Gmail rate limit reached; no retry was attempted");
    if (response.status === 404) throw new GmailRuntimeError("provider_failure", "Gmail reported the requested record does not exist");
    if (!response.ok) throw new GmailRuntimeError("provider_failure", `Gmail answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Gmail");
  }

  /** The mailbox owner's address (metadata only) — defines "internal" for a per-user mailbox (R-004). */
  async profile(): Promise<{ email?: string }> {
    this.requests.profile += 1;
    const body = await this.request("GET", "/gmail/v1/users/me/profile", 16 * 1024);
    const email = typeof body.emailAddress === "string" ? body.emailAddress : undefined;
    return email ? { email } : {};
  }

  /**
   * Bounded metadata listing (R-004): explicit labels, a time window expressed
   * as Gmail's after/before query operators, a page ceiling, no message
   * bodies. A listing that exceeds the ceiling returns `truncated` and the
   * run stops — it never widens.
   */
  async listThreads(scope: { label_ids: string[]; from: string; to: string }): Promise<{ threads: GmailThreadRef[]; pages: number; truncated: boolean }> {
    const afterSeconds = Math.floor(Date.parse(scope.from) / 1000);
    const beforeSeconds = Math.floor(Date.parse(scope.to) / 1000);
    if (!Number.isFinite(afterSeconds) || !Number.isFinite(beforeSeconds)) throw new GmailRuntimeError("provider_failure", "the approved window is not a valid time range");
    const threads: GmailThreadRef[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages >= GMAIL_POLICY.max_list_pages) return { threads, pages, truncated: true };
      const params = new URLSearchParams({ maxPageSize: "100", q: `after:${afterSeconds} before:${beforeSeconds}` });
      // labelIds is a repeated parameter, not a joined one.
      for (const label of scope.label_ids.slice(0, 10)) params.append("labelIds", label);
      if (pageToken) params.set("pageToken", pageToken);
      this.requests.list += 1;
      const body = await this.request("GET", `/gmail/v1/users/me/threads?${params.toString()}`, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.threads) ? (body.threads as Array<Record<string, unknown>>) : []) {
        if (!entry || typeof entry.id !== "string") continue;
        threads.push({ id: entry.id, snippet: typeof entry.snippet === "string" ? entry.snippet : undefined });
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
      if (!pageToken) return { threads, pages, truncated: false };
    }
  }

  /**
   * One thread's headers only (format=metadata) — the bounded listing read
   * (R-004): participants and dates without any message body. Bodies are
   * fetched solely by `thread()` under the minted proof (R-007).
   */
  async threadMetadata(threadId: string): Promise<GmailThread> {
    if (!threadId || /\s/.test(threadId)) throw new GmailRuntimeError("provider_failure", "a single well-formed thread identifier is required");
    this.requests.metadata += 1;
    const body = await this.request("GET", `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`);
    const messagesRaw = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
    const messages = messagesRaw.map((message) => this.parseMessage(message));
    if (messages.length === 0) throw new GmailRuntimeError("access_denied", "Gmail returned no messages for the selected thread");
    return { id: threadId, messages };
  }

  /**
   * Exactly one thread's messages (R-007). This method refuses to ask for
   * more than one identifier — a fixture observes that no request ever
   * carries one. Attachment parts are skipped, never fetched (D-003).
   */
  async thread(threadId: string): Promise<GmailThread> {
    if (!threadId || /\s/.test(threadId)) throw new GmailRuntimeError("provider_failure", "a single well-formed thread identifier is required");
    this.requests.thread += 1;
    const body = await this.request("GET", `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
    if (typeof body.id === "string" && body.id !== threadId) throw new GmailRuntimeError("provider_failure", "Gmail returned a different thread than the one selected");
    const messagesRaw = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
    const messages = messagesRaw.map((message) => this.parseMessage(message));
    if (messages.length === 0) throw new GmailRuntimeError("access_denied", "Gmail returned no messages for the selected thread");
    return { id: threadId, messages };
  }

  private parseMessage(message: Record<string, unknown>): GmailThreadMessage {
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    const headers = Array.isArray(payload.headers) ? (payload.headers as GmailMessageHeader[]) : [];
    const header = (name: string): string | undefined => headers.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value;
    const from = parseEmailAddress(header("From"));
    const to = (header("To") ?? "").split(",").map(parseEmailAddress).filter((entry): entry is { display_name?: string; email?: string } => Boolean(entry));
    return {
      id: typeof message.id === "string" ? message.id : "",
      internal_date: typeof message.internalDate === "string" ? message.internalDate : undefined,
      labels: Array.isArray(message.labelIds) ? (message.labelIds as unknown[]).filter((label): label is string => typeof label === "string") : undefined,
      ...(from ? { from } : {}),
      to: to.length ? to : undefined,
      subject: header("Subject"),
      body_text: decodeTextBody(payload),
    };
  }
}

// Parses "Display Name <local@domain>" or "local@domain" into the adapter's
// participant shape. Unparseable values are dropped — never guessed.
function parseEmailAddress(value: string | undefined): { display_name?: string; email?: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const angled = /^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/.exec(trimmed);
  if (angled) return { ...(angled[1].trim() ? { display_name: angled[1].trim().replace(/^"|"$/g, "") } : {}), email: angled[2].toLowerCase() };
  return /^[^\s<>]+@[^\s<>]+$/.test(trimmed) ? { email: trimmed.toLowerCase() } : undefined;
}

// Decodes text/plain parts of the already-fetched thread response. Attachment
// parts (anything with an attachmentId) are never decoded and never fetched —
// D-003 refuses them structurally.
function decodeTextBody(payload: Record<string, unknown>): string | undefined {
  const parts = Array.isArray(payload.parts) ? (payload.parts as Array<Record<string, unknown>>) : [];
  const candidates = [payload, ...parts];
  for (const part of candidates) {
    if (typeof part.attachmentId === "string" && part.attachmentId) continue;
    const mimeType = typeof part.mimeType === "string" ? part.mimeType : "";
    const body = (part.body ?? {}) as Record<string, unknown>;
    const data = typeof body.data === "string" ? body.data : undefined;
    if (!data) continue;
    if (mimeType && mimeType !== "text/plain") continue;
    try {
      return Buffer.from(data, "base64url").toString("utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}
