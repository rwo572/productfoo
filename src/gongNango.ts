// Gong through Nango (gong-discovery-connector-v0, local worker mode).
//
// Nango is the credential broker only (Granola packet D-007, carried by this
// packet's D-003/D-010): productfoo asks Nango for the company's Gong credential and
// then talks to Gong's REST API directly, so transcript bytes never transit
// Nango. Everything here is content-free on every surface productfoo owns: credentials
// are held in process memory for one command, the Nango connection id is never
// printed (an opaque `connection_ref` stands in for it), and errors carry a
// typed code plus a bounded message that never embeds a provider response.
//
// Gong API shapes below are beliefs owned by the packet's feasibility task
// (T-001) and pinned by fixtures in test/discoveryGongRuntime.test.ts; the
// live dogfood run (T-009) is what promotes them from belief to verified.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type GongRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "transcript_too_large"
  | "budget_exhausted";

export class GongRuntimeError extends Error {
  constructor(public readonly code: GongRuntimeErrorCode, message: string) {
    super(message);
    this.name = "GongRuntimeError";
  }
}

export type GongCredential =
  | { type: "basic"; username: string; password: string }
  | { type: "oauth2"; access_token: string };

export type GongConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // Who supplied the credential: Nango (the company connection, refreshable
  // and revocable centrally) or a direct administrator-issued access key set
  // in this runtime's environment. The readiness surface reports it so the
  // direct path is never mistaken for the company connection.
  broker: "nango" | "direct";
  credential: GongCredential;
  credential_type: "basic" | "oauth2";
  // Observed per connection, never assumed from a fixture (R-005):
  // basic access keys carry the account's full read grant; an OAuth token is
  // judged by its scopes when Nango reports them.
  transcript_scope: "granted" | "missing" | "unknown";
};

// Versioned policy fields (Granola packet R-005): hard ceilings the worker
// enforces and reports, so a later change is explicit rather than silent.
export const GONG_POLICY = {
  policy_version: "gong-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
} as const;

const GONG_TRANSCRIPT_SCOPE = "api:calls:read:transcript";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_GONG_BASE = "https://api.gong.io";

export type GongConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: GongConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_GONG_NANGO_CONNECTION?.trim());
}

function directConfigured(env: GongConnectionEnv): boolean {
  return Boolean(env.FOO_GONG_ACCESS_KEY?.trim() && env.FOO_GONG_ACCESS_KEY_SECRET?.trim());
}

export function gongConnectionConfigured(env: GongConnectionEnv): boolean {
  return nangoConfigured(env) || directConfigured(env);
}

export function gongCredentialBroker(env: GongConnectionEnv): "nango" | "direct" | null {
  if (nangoConfigured(env)) return "nango";
  if (directConfigured(env)) return "direct";
  return null;
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `gong:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new GongRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new GongRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized transcript is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new GongRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new GongRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
      throw new GongRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
    throw new GongRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the company's Gong credential. Nango is the primary broker: it holds
 * the credential, refreshes it, and is where an administrator revokes it. When
 * Nango is not configured, an administrator-issued access key and secret set
 * directly in this runtime's environment (FOO_GONG_ACCESS_KEY /
 * FOO_GONG_ACCESS_KEY_SECRET) is accepted as the direct fallback — the same
 * company credential, minus the central refresh and revoke story. Either way
 * productfoo receives it for one command and never persists or prints it.
 */
export async function resolveGongConnection(input: { env: GongConnectionEnv; fetchImpl: FetchLike }): Promise<GongConnection> {
  const broker = gongCredentialBroker(input.env);
  if (broker === null) {
    throw new GongRuntimeError("not_connected", "Gong is not connected: set NANGO_SECRET_KEY and FOO_GONG_NANGO_CONNECTION for the company connection through Nango, or FOO_GONG_ACCESS_KEY and FOO_GONG_ACCESS_KEY_SECRET for a direct administrator-issued access key");
  }
  if (broker === "direct") {
    const username = input.env.FOO_GONG_ACCESS_KEY!.trim();
    const password = input.env.FOO_GONG_ACCESS_KEY_SECRET!.trim();
    return {
      connection_ref: `gong:direct:${createHash("sha256").update(username).digest("hex").slice(0, 16)}`,
      broker: "direct",
      credential: { type: "basic", username, password },
      credential_type: "basic",
      transcript_scope: "granted",
    };
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_GONG_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_GONG_NANGO_INTEGRATION?.trim() || "gong";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, GONG_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new GongRuntimeError("not_connected", "Nango refused the secret key; reconnect Gong");
  if (response.status === 404) throw new GongRuntimeError("not_connected", "Nango has no Gong connection with that reference; connect Gong first");
  if (!response.ok) throw new GongRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  const ref = opaqueConnectionRef(integration, connectionId);
  if (type === "BASIC") {
    const username = String(credentials.username ?? "");
    const password = String(credentials.password ?? "");
    if (!username || !password) throw new GongRuntimeError("not_connected", "the Nango connection carries no usable Gong access key");
    return { connection_ref: ref, broker: "nango", credential: { type: "basic", username, password }, credential_type: "basic", transcript_scope: "granted" };
  }
  if (type === "OAUTH2") {
    const token = String(credentials.access_token ?? "");
    if (!token) throw new GongRuntimeError("auth_expired", "the Nango connection carries no usable Gong access token; refresh or reconnect");
    const raw = (credentials.raw ?? {}) as Record<string, unknown>;
    const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
    const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
    const transcriptScope: GongConnection["transcript_scope"] = scopes.length === 0 ? "unknown" : scopes.includes(GONG_TRANSCRIPT_SCOPE) ? "granted" : "missing";
    return { connection_ref: ref, broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", transcript_scope: transcriptScope };
  }
  throw new GongRuntimeError("not_connected", "the Nango connection uses a credential type productfoo does not support for Gong");
}

export type GongListedCall = { id: string; title?: string; url?: string; scheduled?: string; started?: string; duration?: number; workspaceId?: string };
export type GongParty = { name?: string; emailAddress?: string; title?: string; affiliation?: string; speakerId?: string };
export type GongTranscriptMonologue = { speakerId?: string; topic?: string; sentences: Array<{ start?: number; end?: number; text: string }> };

type GongClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Fixture seam only: narrows the fetch ceiling so a test can observe a
  // timeout without waiting out the policy ceiling. Every real run keeps
  // GONG_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

const READ_ONLY_POSTS = new Set(["/v2/calls/extensive", "/v2/calls/transcript"]);

/**
 * Minimal read-only Gong REST client. Only documented read operations are
 * reachable; any other method or path routes through the single write-refusal
 * choke point (R-009) so the refusal is testable rather than scattered.
 */
export class GongClient {
  readonly requests = { list: 0, extensive: 0, transcript: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly credential: GongCredential, private readonly options: GongClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GONG_BASE).replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? GONG_POLICY.fetch_timeout_ms;
  }

  private authorization(): string {
    if (this.credential.type === "basic") return `Basic ${Buffer.from(`${this.credential.username}:${this.credential.password}`).toString("base64")}`;
    return `Bearer ${this.credential.access_token}`;
  }

  private async request(method: "GET" | "POST", pathname: string, body?: unknown, maxBytes: number = GONG_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    const readOnly = method === "GET" || (method === "POST" && READ_ONLY_POSTS.has(pathname.split("?")[0]));
    if (!readOnly) refuseSourceWrite(`gong ${method} ${pathname}`);
    const wait = this.lastRequestAt + GONG_POLICY.min_request_interval_ms - this.now();
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
    if (response.status === 401) throw new GongRuntimeError("auth_expired", "Gong rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new GongRuntimeError("access_denied", "Gong denied this read; the credential lacks the required permission");
    if (response.status === 429) throw new GongRuntimeError("budget_exhausted", "Gong rate limit reached; no retry was attempted");
    if (response.status === 404) throw new GongRuntimeError("provider_failure", "Gong reported the requested record does not exist");
    if (!response.ok) throw new GongRuntimeError("provider_failure", `Gong answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Gong");
  }

  /** Bounded metadata listing: one time window, a page ceiling, no content. */
  async listCalls(window: { from: string; to: string; workspaceId?: string }): Promise<{ calls: GongListedCall[]; pages: number; truncated: boolean }> {
    const calls: GongListedCall[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages >= GONG_POLICY.max_list_pages) return { calls, pages, truncated: true };
      const params = new URLSearchParams({ fromDateTime: window.from, toDateTime: window.to });
      if (window.workspaceId) params.set("workspaceId", window.workspaceId);
      if (cursor) params.set("cursor", cursor);
      this.requests.list += 1;
      const body = await this.request("GET", `/v2/calls?${params.toString()}`, undefined, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.calls) ? (body.calls as Array<Record<string, unknown>>) : []) {
        if (!entry || typeof entry.id !== "string") continue;
        calls.push({
          id: entry.id,
          title: typeof entry.title === "string" ? entry.title : undefined,
          url: typeof entry.url === "string" ? entry.url : undefined,
          scheduled: typeof entry.scheduled === "string" ? entry.scheduled : undefined,
          started: typeof entry.started === "string" ? entry.started : undefined,
          duration: typeof entry.duration === "number" ? entry.duration : undefined,
          workspaceId: typeof entry.workspaceId === "string" ? entry.workspaceId : undefined,
        });
      }
      const records = (body.records ?? {}) as Record<string, unknown>;
      cursor = typeof records.cursor === "string" && records.cursor ? records.cursor : undefined;
      if (!cursor) return { calls, pages, truncated: false };
    }
  }

  /** Party metadata for the given calls (names, titles, affiliation, speaker ids) — no content fields are requested. */
  async parties(callIds: string[]): Promise<Map<string, GongParty[]>> {
    const out = new Map<string, GongParty[]>();
    for (let index = 0; index < callIds.length; index += 100) {
      const batch = callIds.slice(index, index + 100);
      this.requests.extensive += 1;
      const body = await this.request("POST", "/v2/calls/extensive", {
        filter: { callIds: batch },
        contentSelector: { exposedFields: { parties: true } },
      }, 4 * 1024 * 1024);
      for (const call of Array.isArray(body.calls) ? (body.calls as Array<Record<string, unknown>>) : []) {
        const meta = (call.metaData ?? {}) as Record<string, unknown>;
        const id = typeof meta.id === "string" ? meta.id : undefined;
        if (!id) continue;
        const parties = Array.isArray(call.parties) ? (call.parties as Array<Record<string, unknown>>) : [];
        out.set(id, parties.map((party) => ({
          name: typeof party.name === "string" ? party.name : undefined,
          emailAddress: typeof party.emailAddress === "string" ? party.emailAddress : undefined,
          title: typeof party.title === "string" ? party.title : undefined,
          affiliation: typeof party.affiliation === "string" ? party.affiliation : undefined,
          speakerId: typeof party.speakerId === "string" ? party.speakerId : undefined,
        })));
      }
    }
    return out;
  }

  /**
   * Exactly one call's transcript (R-007). Gong's transcript operation is
   * batch-capable; this method refuses to ask for more than one identifier and
   * a fixture observes that no request ever carries more.
   */
  async transcript(callId: string): Promise<GongTranscriptMonologue[]> {
    if (!callId || /\s/.test(callId)) throw new GongRuntimeError("provider_failure", "a single well-formed call identifier is required");
    this.requests.transcript += 1;
    const body = await this.request("POST", "/v2/calls/transcript", { filter: { callIds: [callId] } });
    const transcripts = Array.isArray(body.callTranscripts) ? (body.callTranscripts as Array<Record<string, unknown>>) : [];
    const own = transcripts.find((entry) => entry.callId === callId);
    if (!own || !Array.isArray(own.transcript)) throw new GongRuntimeError("access_denied", "Gong returned no transcript for the selected call");
    return (own.transcript as Array<Record<string, unknown>>).map((monologue) => ({
      speakerId: typeof monologue.speakerId === "string" ? monologue.speakerId : undefined,
      topic: typeof monologue.topic === "string" ? monologue.topic : undefined,
      sentences: (Array.isArray(monologue.sentences) ? (monologue.sentences as Array<Record<string, unknown>>) : [])
        .filter((sentence) => typeof sentence.text === "string")
        .map((sentence) => ({ start: typeof sentence.start === "number" ? sentence.start : undefined, end: typeof sentence.end === "number" ? sentence.end : undefined, text: sentence.text as string })),
    }));
  }
}
