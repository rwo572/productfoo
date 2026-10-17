// Zoom through Nango (zoom-discovery-connector-v0, local worker mode).
//
// Nango is the credential broker only (gong-discovery-connector-v0 D-003,
// carried by this packet's D-001): productfoo asks Nango for the company's Zoom
// credential and then talks to Zoom's REST API directly, so transcript bytes
// never transit Nango. Everything here is content-free on every surface productfoo
// owns: credentials are held in process memory for one command, the Nango
// connection id is never printed (an opaque `connection_ref` stands in for
// it), and errors carry a typed code plus a bounded message that never embeds
// a provider response or a tokenized download URL.
//
// Zoom API shapes below are beliefs owned by the packet's feasibility task
// (T-001) and pinned by fixtures in test/discoveryZoomRuntime.test.ts; the
// live dogfood run (T-010) is what promotes them from belief to verified.

import { createHash } from "node:crypto";
import type { ZoomRecordingRecord } from "./discoveryProviders.js";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type ZoomRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "transcript_too_large"
  | "budget_exhausted";

export class ZoomRuntimeError extends Error {
  constructor(public readonly code: ZoomRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ZoomRuntimeError";
  }
}

export type ZoomCredential = { type: "oauth2"; access_token: string };

export type ZoomConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // Who supplied the credential: Nango (the company connection, refreshable
  // and revocable centrally) or a direct server-to-server OAuth app issued by
  // an administrator in this runtime's environment. The readiness surface
  // reports it so the direct path is never mistaken for the company connection.
  broker: "nango" | "direct";
  credential: ZoomCredential;
  credential_type: "oauth2";
  // Observed per connection, never assumed from a fixture (R-005): recording
  // listing and cloud-recording downloads are the same server-to-server grant,
  // so an OAuth token is judged by the recording read scopes when Nango
  // reports them.
  transcript_scope: "granted" | "missing" | "unknown";
};

// Versioned policy fields (Granola packet R-005, carried by D-001): hard
// ceilings the worker enforces and reports, so a later change is explicit
// rather than silent.
export const ZOOM_POLICY = {
  policy_version: "zoom-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  max_transcript_bytes: 4 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  max_page_size: 300,
  min_request_interval_ms: 350,
} as const;

// The recording read grant that also covers cloud-recording downloads
// (belief owned by T-001; the feasibility report pins the exact scope string).
const ZOOM_RECORDING_SCOPES = ["recording:read", "recording:read:admin"];
const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_ZOOM_BASE = "https://api.zoom.us";
const DEFAULT_ZOOM_TOKEN_BASE = "https://zoom.us";

export type ZoomConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: ZoomConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_ZOOM_NANGO_CONNECTION?.trim());
}

function directConfigured(env: ZoomConnectionEnv): boolean {
  return Boolean(env.FOO_ZOOM_ACCOUNT_ID?.trim() && env.FOO_ZOOM_CLIENT_ID?.trim() && env.FOO_ZOOM_CLIENT_SECRET?.trim());
}

export function zoomConnectionConfigured(env: ZoomConnectionEnv): boolean {
  return nangoConfigured(env) || directConfigured(env);
}

export function zoomCredentialBroker(env: ZoomConnectionEnv): "nango" | "direct" | null {
  if (nangoConfigured(env)) return "nango";
  if (directConfigured(env)) return "direct";
  return null;
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `zoom:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ZoomRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new ZoomRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized transcript is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ZoomRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ZoomRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
      throw new ZoomRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
    throw new ZoomRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

function recordingScopeFromScopes(scopes: string[]): ZoomConnection["transcript_scope"] {
  if (scopes.length === 0) return "unknown";
  return scopes.some((scope) => ZOOM_RECORDING_SCOPES.includes(scope)) ? "granted" : "missing";
}

/**
 * Resolve the company's Zoom credential. Nango is the primary broker: it holds
 * the credential, refreshes it, and is where an administrator revokes it. When
 * Nango is not configured, an administrator-issued server-to-server OAuth app
 * (FOO_ZOOM_ACCOUNT_ID / FOO_ZOOM_CLIENT_ID / FOO_ZOOM_CLIENT_SECRET) is
 * accepted as the direct fallback — the same company grant, minus the central
 * refresh and revoke story. Either way productfoo receives it for one command and
 * never persists or prints it.
 */
export async function resolveZoomConnection(input: { env: ZoomConnectionEnv; fetchImpl: FetchLike }): Promise<ZoomConnection> {
  const broker = zoomCredentialBroker(input.env);
  if (broker === null) {
    throw new ZoomRuntimeError("not_connected", "Zoom is not connected: set NANGO_SECRET_KEY and FOO_ZOOM_NANGO_CONNECTION for the company connection through Nango, or FOO_ZOOM_ACCOUNT_ID, FOO_ZOOM_CLIENT_ID, and FOO_ZOOM_CLIENT_SECRET for a direct administrator-issued server-to-server app");
  }
  if (broker === "direct") {
    const accountId = input.env.FOO_ZOOM_ACCOUNT_ID!.trim();
    const clientId = input.env.FOO_ZOOM_CLIENT_ID!.trim();
    const clientSecret = input.env.FOO_ZOOM_CLIENT_SECRET!.trim();
    // Documented server-to-server token exchange — an auth operation, not a
    // source read; it happens once per command against zoom.us. The response
    // token lives in process memory for the command and is never logged.
    const response = await fetchWithTimeout(
      input.fetchImpl,
      `${DEFAULT_ZOOM_TOKEN_BASE}/oauth/token`,
      {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "account_credentials", account_id: accountId }).toString(),
      },
      ZOOM_POLICY.fetch_timeout_ms,
    );
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new ZoomRuntimeError("auth_expired", "Zoom refused the server-to-server credential; check the account id, client id, and secret");
    if (!response.ok) throw new ZoomRuntimeError("provider_failure", `Zoom answered ${response.status} while exchanging the server-to-server credential`);
    const body = parseJson(await readBounded(response, 64 * 1024), "Zoom");
    const token = String(body.access_token ?? "");
    if (!token) throw new ZoomRuntimeError("auth_expired", "Zoom returned no access token for the server-to-server credential");
    return { connection_ref: `zoom:direct:${createHash("sha256").update(clientId).digest("hex").slice(0, 16)}`, broker: "direct", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", transcript_scope: "granted" };
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_ZOOM_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_ZOOM_NANGO_INTEGRATION?.trim() || "zoom";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, ZOOM_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new ZoomRuntimeError("not_connected", "Nango refused the secret key; reconnect Zoom");
  if (response.status === 404) throw new ZoomRuntimeError("not_connected", "Nango has no Zoom connection with that reference; connect Zoom first");
  if (!response.ok) throw new ZoomRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  const ref = opaqueConnectionRef(integration, connectionId);
  if (type === "OAUTH2") {
    const token = String(credentials.access_token ?? "");
    if (!token) throw new ZoomRuntimeError("auth_expired", "the Nango connection carries no usable Zoom access token; refresh or reconnect");
    const raw = (credentials.raw ?? {}) as Record<string, unknown>;
    const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
    const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
    return { connection_ref: ref, broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", transcript_scope: recordingScopeFromScopes(scopes) };
  }
  throw new ZoomRuntimeError("not_connected", "the Nango connection uses a credential type productfoo does not support for Zoom");
}

export type ZoomRecordingFile = { file_type?: string; download_url?: string; play_url?: string; status?: string };

// A listed recording as the client hands it to the worker: the shared contract
// record plus the file manifest the worker needs to find one recording's
// downloadable transcript file. The adapter consumes only the contract subset.
export type ZoomListedRecording = ZoomRecordingRecord & { recording_files?: ZoomRecordingFile[] };

type ZoomClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Fixture seam only: narrows the fetch ceiling so a test can observe a
  // timeout without waiting out the policy ceiling. Every real run keeps
  // ZOOM_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

/**
 * Minimal read-only Zoom REST client. Only documented read operations are
 * reachable; any other method or path routes through the single write-refusal
 * choke point (R-009) so the refusal is testable rather than scattered.
 */
export class ZoomClient {
  readonly requests = { list: 0, transcript: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly credential: ZoomCredential, private readonly options: ZoomClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ZOOM_BASE).replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? ZOOM_POLICY.fetch_timeout_ms;
  }

  private authorization(): string {
    return `Bearer ${this.credential.access_token}`;
  }

  private async request(pathname: string, maxBytes: number): Promise<Record<string, unknown>> {
    if (!pathname.startsWith("/")) refuseSourceWrite(`zoom ${pathname}`);
    const wait = this.lastRequestAt + ZOOM_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(this.options.fetchImpl, `${this.baseUrl}${pathname}`, { method: "GET", headers: { authorization: this.authorization(), accept: "application/json" } }, this.fetchTimeoutMs);
    if (response.status === 401) throw new ZoomRuntimeError("auth_expired", "Zoom rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new ZoomRuntimeError("access_denied", "Zoom denied this read; the credential lacks the required permission");
    if (response.status === 429) throw new ZoomRuntimeError("budget_exhausted", "Zoom rate limit reached; no retry was attempted");
    if (response.status === 404) throw new ZoomRuntimeError("provider_failure", "Zoom reported the requested record does not exist");
    if (!response.ok) throw new ZoomRuntimeError("provider_failure", `Zoom answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Zoom");
  }

  /**
   * Bounded metadata listing: one time window, a page ceiling, no content. A
   * recording's participant records carry no affiliation field — the mapping
   * passes through only what is observed and leaves the rest undefined.
   */
  async listSessions(userId: string, window: { from: string; to: string }): Promise<{ recordings: ZoomListedRecording[]; pages: number; truncated: boolean }> {
    const recordings: ZoomListedRecording[] = [];
    let nextPageToken: string | undefined;
    let pages = 0;
    for (;;) {
      if (pages >= ZOOM_POLICY.max_list_pages) return { recordings, pages, truncated: true };
      const params = new URLSearchParams({ from: window.from, to: window.to, page_size: String(ZOOM_POLICY.max_page_size) });
      if (nextPageToken) params.set("next_page_token", nextPageToken);
      this.requests.list += 1;
      const body = await this.request(`/users/${encodeURIComponent(userId)}/recordings?${params.toString()}`, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.recordings) ? (body.recordings as Array<Record<string, unknown>>) : []) {
        // Entries without the contract's required identity fields cannot be
        // normalized and are skipped, exactly as Gong's listing skips calls
        // without an id.
        if (!entry || typeof entry.uuid !== "string" || typeof entry.topic !== "string" || typeof entry.start_time !== "string") continue;
        const files = (Array.isArray(entry.recording_files) ? (entry.recording_files as Array<Record<string, unknown>>) : []).map((file) => ({
          file_type: typeof file.file_type === "string" ? file.file_type : undefined,
          download_url: typeof file.download_url === "string" ? file.download_url : undefined,
          play_url: typeof file.play_url === "string" ? file.play_url : undefined,
          status: typeof file.status === "string" ? file.status : undefined,
        }));
        // A transcript file counts as available only when it is actually
        // downloadable — the observed state of THIS recording, never assumed
        // from the topic or the account (R-005).
        const transcriptFile = files.find((file) => file.file_type === "TRANSCRIPTION" && file.download_url && file.status === "completed");
        const participants = (Array.isArray(entry.participants) ? (entry.participants as Array<Record<string, unknown>>) : [])
          .map((participant) => ({
            display_name: typeof participant.display_name === "string" ? participant.display_name : undefined,
            email: typeof participant.email === "string" ? participant.email : undefined,
          }))
          .filter((participant) => participant.display_name || participant.email);
        recordings.push({
          meeting_uuid: entry.uuid,
          topic: entry.topic,
          start_time: entry.start_time,
          end_time: typeof entry.end_time === "string" ? entry.end_time : undefined,
          state: typeof entry.state === "string" ? entry.state : undefined,
          host_display_name: typeof entry.host_display_name === "string" ? entry.host_display_name : undefined,
          participants,
          // Omitted, never cleaned: a tokenized or non-canonical page URL is
          // dropped here and the adapter additionally refuses non-canonical
          // forms as defense in depth (R-006).
          url: this.canonicalPageUrl(typeof entry.play_url === "string" ? entry.play_url : undefined),
          transcript_available: Boolean(transcriptFile),
          recording_files: files,
        });
      }
      nextPageToken = typeof body.next_page_token === "string" && body.next_page_token ? body.next_page_token : undefined;
      if (!nextPageToken) return { recordings, pages, truncated: false };
    }
  }

  // Accepts only the canonical recording page form the sanitizer in
  // src/discoverySources.ts accepts (one account subdomain, /recording/<id>,
  // no query, no fragment); anything else — including tokenized share links —
  // is omitted, never cleaned (R-006).
  private canonicalPageUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.search || parsed.hash) return undefined;
      const host = parsed.hostname.toLowerCase();
      const suffix = ".zoom.us";
      if (!host.endsWith(suffix)) return undefined;
      const label = host.slice(0, -suffix.length);
      if (!label || !/^[a-z0-9-]+$/.test(label)) return undefined;
      if (!/^\/recording\/[A-Za-z0-9_-]{16,128}$/.test(parsed.pathname)) return undefined;
      return `https://${host}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Exactly one transcript download (R-007): the observed, downloadable
   * transcript file of one recording. The URL is the one the listing observed
   * for that recording; a tokenized link may be used in transit (Zoom's own
   * access mechanism) and is never logged, persisted, or echoed — error
   * messages carry the hostname only.
   */
  async transcript(downloadUrl: string): Promise<{ vtt: string }> {
    let hostname = "";
    try {
      const parsed = new URL(downloadUrl);
      hostname = parsed.hostname;
      if (parsed.protocol !== "https:" || !(parsed.hostname === "zoom.us" || parsed.hostname.endsWith(".zoom.us"))) {
        throw new Error("not a zoom host");
      }
    } catch {
      throw new ZoomRuntimeError("provider_failure", "a single well-formed Zoom transcript download URL is required");
    }
    this.requests.transcript += 1;
    const response = await fetchWithTimeout(this.options.fetchImpl, downloadUrl, { method: "GET", headers: { authorization: this.authorization(), accept: "text/vtt, text/plain, */*" } }, this.fetchTimeoutMs);
    if (response.status === 401) throw new ZoomRuntimeError("auth_expired", `Zoom rejected the credential for the transcript download from ${hostname}`);
    if (response.status === 403) throw new ZoomRuntimeError("access_denied", `Zoom denied the transcript download from ${hostname}`);
    if (response.status === 429) throw new ZoomRuntimeError("budget_exhausted", "Zoom rate limit reached; no retry was attempted");
    if (response.status === 404) throw new ZoomRuntimeError("provider_failure", `Zoom reported the transcript on ${hostname} does not exist`);
    if (!response.ok) throw new ZoomRuntimeError("provider_failure", `Zoom answered ${response.status} for the transcript download`);
    return { vtt: await readBounded(response, ZOOM_POLICY.max_transcript_bytes) };
  }
}
