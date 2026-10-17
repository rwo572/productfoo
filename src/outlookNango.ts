// Outlook through Nango (outlook-discovery-connector-v0, local worker mode).
//
// Nango is the credential broker (R-001, the email-class shape Gmail's worker
// established): productfoo asks Nango for the verified user's Outlook credential and
// then talks to the Microsoft Graph API directly, so message bodies never
// transit Nango. The connection is per-user (D-002) — a mailbox is personal
// even at work — so unlike Gong there is no administrator-issued direct-key
// fallback: a personal OAuth grant through Nango is the only path, and
// readiness reports that broker truthfully. Credentials are held in process
// memory for one command, the Nango connection id is never printed (an opaque
// `connection_ref` stands in for it), and errors carry a typed code plus a
// bounded message that never embeds a provider response.
//
// Microsoft Graph shapes below are beliefs owned by the packet's feasibility
// task (T-001) and pinned by fixtures in test/discoveryOutlookRuntime.test.ts;
// nothing here is verified-live, and support stays contract_only.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type OutlookRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "conversation_too_large"
  | "budget_exhausted";

export class OutlookRuntimeError extends Error {
  constructor(public readonly code: OutlookRuntimeErrorCode, message: string) {
    super(message);
    this.name = "OutlookRuntimeError";
  }
}

export type OutlookConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // Always "nango" (D-002): a per-user mailbox has no administrator-issued
  // key. Reported so a future broker change can never arrive silently.
  broker: "nango";
  credential: { type: "oauth2"; access_token: string };
  credential_type: "oauth2";
  // Observed from the connection's OAuth scope report, never assumed
  // (R-005): message bodies need the least-privilege delegated read scope.
  // Absent or unknown fails closed, so a fixture cannot manufacture body
  // access.
  body_scope: "granted" | "missing" | "unknown";
};

// Versioned policy (R-007): hard ceilings the worker enforces and reports, so
// a later change is explicit rather than silent. quiet_period_hours is the
// email class's pinned quiet period (D-001, T-005): a conversation is settled
// evidence once its last message predates the scope window's end by this
// much, unless an explicit done category (OUTLOOK_DONE_CATEGORIES) marks it
// sooner.
export const OUTLOOK_POLICY = {
  policy_version: "outlook-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
  quiet_period_hours: 48,
} as const;

// Least-privilege delegated read scopes (R-003). Graph needs one read scope
// for both bounded metadata listing and reading a selected conversation's
// message bodies: Mail.Read. Never Mail.ReadWrite, never the full mail grant
// — there is no write path in this client at all (R-009). A connection
// without the body scope stays useful for metadata and reports
// needs_provider_access for reads (R-008).
const OUTLOOK_BODY_SCOPE = "Mail.Read";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type OutlookConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: OutlookConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_OUTLOOK_NANGO_CONNECTION?.trim());
}

export function outlookConnectionConfigured(env: OutlookConnectionEnv): boolean {
  return nangoConfigured(env);
}

export function outlookCredentialBroker(_env: OutlookConnectionEnv): "nango" | null {
  // Per-user ownership (D-002): Nango is the only broker. The parameter keeps
  // the shared broker signature so callers stay parallel.
  return "nango";
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `outlook:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new OutlookRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new OutlookRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized conversation is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new OutlookRuntimeError("conversation_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new OutlookRuntimeError("conversation_too_large", "the provider response exceeds the byte ceiling");
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
      throw new OutlookRuntimeError("conversation_too_large", "the provider response exceeds the byte ceiling");
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
    throw new OutlookRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the verified user's Outlook credential through Nango. There is no
 * direct fallback (D-002): the mailbox belongs to one person, so the OAuth
 * grant is always brokered, refreshable, and revocable centrally. productfoo receives
 * the token for one command and never persists or prints it.
 */
export async function resolveOutlookConnection(input: { env: OutlookConnectionEnv; fetchImpl: FetchLike }): Promise<OutlookConnection> {
  if (!nangoConfigured(input.env)) {
    throw new OutlookRuntimeError("not_connected", "Outlook is not connected: connect the mailbox through Nango and set NANGO_SECRET_KEY and FOO_OUTLOOK_NANGO_CONNECTION (plus NANGO_HOST / FOO_OUTLOOK_NANGO_INTEGRATION when they differ from the defaults)");
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_OUTLOOK_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_OUTLOOK_NANGO_INTEGRATION?.trim() || "microsoft-outlook";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, OUTLOOK_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new OutlookRuntimeError("not_connected", "Nango refused the secret key; reconnect Outlook");
  if (response.status === 404) throw new OutlookRuntimeError("not_connected", "Nango has no Outlook connection with that reference; connect Outlook first");
  if (!response.ok) throw new OutlookRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  if (type !== "OAUTH2") throw new OutlookRuntimeError("not_connected", "the Nango connection uses a credential type productfoo does not support for Outlook");
  const token = String(credentials.access_token ?? "");
  if (!token) throw new OutlookRuntimeError("auth_expired", "the Nango connection carries no usable Outlook access token; refresh or reconnect");
  const raw = (credentials.raw ?? {}) as Record<string, unknown>;
  const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
  const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
  const bodyScope: OutlookConnection["body_scope"] = scopes.length === 0 ? "unknown" : scopes.some((scope) => scope.toLowerCase() === OUTLOOK_BODY_SCOPE.toLowerCase() || scope.toLowerCase().startsWith(`${OUTLOOK_BODY_SCOPE.toLowerCase()}.`)) ? "granted" : "missing";
  return { connection_ref: opaqueConnectionRef(integration, connectionId), broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", body_scope: bodyScope };
}

export type OutlookParticipant = { display_name?: string; smtp?: string };
export type OutlookMessage = {
  id: string;
  conversation_id?: string;
  received_at?: string;
  categories?: string[];
  from?: OutlookParticipant;
  to?: OutlookParticipant[];
  subject?: string;
  body_text?: string;
};

type OutlookClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  fetchTimeoutMs?: number;
};

// The metadata $select: every field the adapter and matcher consume, and
// nothing else — bodies are only ever selected by conversation() (R-004).
const MESSAGE_METADATA_SELECT = "id,conversationId,subject,receivedDateTime,categories,from,toRecipients,ccRecipients";
// The full-read select adds the body — and nothing else — over the metadata
// select (R-004/R-007).
const MESSAGE_SELECT_WITH_BODY = `${MESSAGE_METADATA_SELECT},body`;

// OData timestamps are ISO 8601; the approved window's ISO instants pass
// through unchanged after validation.
function odataInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new OutlookRuntimeError("provider_failure", `the approved window is not a valid time range (${label})`);
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Minimal read-only Microsoft Graph client. Only documented read operations
 * are reachable — every request method is GET and anything else routes
 * through the single write-refusal choke point (R-009), so the refusal is
 * testable rather than scattered. There is no attachment fetch method at all
 * (D-003): Graph models attachments as separate resources, and this client
 * never asks for them.
 */
export class OutlookClient {
  readonly requests = { profile: 0, list: 0, metadata: 0, conversation: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly credential: { type: "oauth2"; access_token: string }, private readonly options: OutlookClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE).replace(/\/+$/, "");
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? OUTLOOK_POLICY.fetch_timeout_ms;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private async request(method: "GET" | "POST", pathname: string, maxBytes: number = OUTLOOK_POLICY.max_response_bytes, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    // R-009: the client is GET-shaped by construction; a future caller that
    // tries a write lands here, at the one choke point — the same gate the
    // Gmail client applies to its non-read methods.
    if (method !== "GET") refuseSourceWrite(`outlook ${method} ${pathname}`);
    const wait = this.lastRequestAt + OUTLOOK_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${pathname}`,
      { method: "GET", headers: { authorization: `Bearer ${this.credential.access_token}`, accept: "application/json", ...headers } },
      this.fetchTimeoutMs,
    );
    if (response.status === 401) throw new OutlookRuntimeError("auth_expired", "Microsoft Graph rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new OutlookRuntimeError("access_denied", "Microsoft Graph denied this read; the connection lacks the required scope");
    if (response.status === 429) throw new OutlookRuntimeError("budget_exhausted", "Microsoft Graph rate limit reached; no retry was attempted");
    if (response.status === 404) throw new OutlookRuntimeError("provider_failure", "Microsoft Graph reported the requested record does not exist");
    if (!response.ok) throw new OutlookRuntimeError("provider_failure", `Microsoft Graph answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Microsoft Graph");
  }

  /** The mailbox owner's address (metadata only) — defines "internal" for a per-user mailbox (R-004). */
  async profile(): Promise<{ email?: string }> {
    this.requests.profile += 1;
    const body = await this.request("GET", "/me?$select=mail,userPrincipalName", 16 * 1024);
    const mail = typeof body.mail === "string" && body.mail ? body.mail : typeof body.userPrincipalName === "string" ? body.userPrincipalName : undefined;
    return mail ? { email: mail } : {};
  }

  /**
   * Bounded metadata listing inside ONE explicit approved folder (R-004): a
   * time window expressed as Graph's receivedDateTime range filter, a page
   * ceiling, no message bodies. Pagination re-issues the SAME pinned filter
   * with the next page's skiptoken — the approved window and folder are
   * byte-identical on every page and a listing that exceeds the ceiling
   * returns `truncated` and the run stops; it never widens.
   */
  async listFolderMessages(scope: { folder: string; from: string; to: string }): Promise<{ messages: OutlookMessage[]; pages: number; truncated: boolean }> {
    const from = odataInstant(scope.from, "start");
    const to = odataInstant(scope.to, "end");
    const filter = `receivedDateTime ge ${from} and receivedDateTime le ${to}`;
    const messages: OutlookMessage[] = [];
    let skiptoken: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages >= OUTLOOK_POLICY.max_list_pages) return { messages, pages, truncated: true };
      const params = new URLSearchParams({ $select: MESSAGE_METADATA_SELECT, $filter: filter, $orderby: "receivedDateTime asc", $top: "100" });
      if (skiptoken) params.set("$skiptoken", skiptoken);
      this.requests.list += 1;
      const body = await this.request("GET", `/me/mailFolders/${encodeURIComponent(scope.folder)}/messages?${params.toString()}`, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : []) {
        messages.push(this.parseMessage(entry));
      }
      // Follow only Graph's own paging token, never its absolute nextLink —
      // the next page must carry THIS pinned filter, and re-issuing from the
      // approved folder path keeps that true by construction.
      const nextLink = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
      const token = nextLink ? new URL(nextLink).searchParams.get("$skiptoken") : null;
      skiptoken = token ?? undefined;
      if (!skiptoken) return { messages, pages, truncated: false };
    }
  }

  /**
   * One conversation's headers only — the bounded listing read (R-004):
   * participants and dates without any message body. Bodies are fetched
   * solely by `conversation()` under the minted proof (R-007).
   */
  async conversationMetadata(conversationId: string): Promise<OutlookMessage[]> {
    if (!conversationId || /\s/.test(conversationId)) throw new OutlookRuntimeError("provider_failure", "a single well-formed conversation identifier is required");
    this.requests.metadata += 1;
    const params = new URLSearchParams({ $select: MESSAGE_METADATA_SELECT, $filter: `conversationId eq '${conversationId}'`, $orderby: "receivedDateTime asc", $top: "100" });
    const body = await this.request("GET", `/me/messages?${params.toString()}`);
    const messages = (Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : []).map((message) => this.parseMessage(message));
    if (messages.length === 0) throw new OutlookRuntimeError("access_denied", "Microsoft Graph returned no messages for the selected conversation");
    return messages;
  }

  /**
   * Exactly one conversation's messages (R-007). This method refuses to ask
   * for more than one identifier — a fixture observes that no request ever
   * carries one. Bodies arrive as text (the Prefer header asks Graph for the
   * text twin); an HTML body is dropped, never stored. Attachment resources
   * are never fetched — there is no method for them (D-003).
   */
  async conversation(conversationId: string): Promise<OutlookMessage[]> {
    if (!conversationId || /\s/.test(conversationId)) throw new OutlookRuntimeError("provider_failure", "a single well-formed conversation identifier is required");
    this.requests.conversation += 1;
    const params = new URLSearchParams({ $select: MESSAGE_SELECT_WITH_BODY, $filter: `conversationId eq '${conversationId}'`, $orderby: "receivedDateTime asc", $top: "100" });
    const body = await this.request("GET", `/me/messages?${params.toString()}`, OUTLOOK_POLICY.max_response_bytes, { prefer: 'outlook.body-content-type="Text"' });
    const messages = (Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : []).map((message) => this.parseMessage(message));
    if (messages.length === 0) throw new OutlookRuntimeError("access_denied", "Microsoft Graph returned no messages for the selected conversation");
    return messages;
  }

  private parseMessage(message: Record<string, unknown>): OutlookMessage {
    const from = parseGraphAddress((message.from ?? {}) as Record<string, unknown>);
    const to = [
      ...(Array.isArray(message.toRecipients) ? (message.toRecipients as Array<Record<string, unknown>>) : []),
      ...(Array.isArray(message.ccRecipients) ? (message.ccRecipients as Array<Record<string, unknown>>) : []),
    ].map((entry) => parseGraphAddress(entry)).filter((entry): entry is OutlookParticipant => Boolean(entry));
    const body = (message.body ?? {}) as Record<string, unknown>;
    // The HTML twin is refused even when Graph ignores the Prefer header: a
    // non-text body content type is dropped, never stored (the Gmail class's
    // html-twin exclusion).
    const bodyText = body.contentType === "text" && typeof body.content === "string" && body.content.trim() ? body.content : undefined;
    return {
      id: typeof message.id === "string" ? message.id : "",
      conversation_id: typeof message.conversationId === "string" ? message.conversationId : undefined,
      received_at: typeof message.receivedDateTime === "string" ? message.receivedDateTime : undefined,
      categories: Array.isArray(message.categories) ? (message.categories as unknown[]).filter((category): category is string => typeof category === "string") : undefined,
      ...(from ? { from } : {}),
      to: to.length ? to : undefined,
      subject: typeof message.subject === "string" ? message.subject : undefined,
      body_text: bodyText,
    };
  }
}

// Parses Graph's structured { emailAddress: { name, address } } into the
// adapter's participant shape. Unparseable values are dropped — never guessed.
function parseGraphAddress(value: Record<string, unknown>): OutlookParticipant | undefined {
  const address = (value.emailAddress ?? {}) as Record<string, unknown>;
  const smtp = typeof address.address === "string" ? address.address.trim().toLowerCase() : "";
  if (!smtp || !/^[^\s<>]+@[^\s<>]+$/.test(smtp)) return undefined;
  return { ...(typeof address.name === "string" && address.name.trim() ? { display_name: address.name.trim().replace(/^"|"$/g, "") } : {}), smtp };
}
