// Microsoft Teams through Nango (microsoft-teams-discovery-connector-v0,
// T-005 local worker mode — the gong broker/client port with Graph deltas).
//
// Nango is the credential broker only: productfoo asks Nango for the tenant's
// Microsoft Teams credential and then talks to Microsoft Graph directly, so
// transcript bytes never transit Nango. The connection is tenant-owned by
// administrator consent (R-002); there is no direct-credential fallback — a
// personal access token would undercut the tenant-owned connection contract.
// Everything here is content-free on every surface productfoo owns: the credential
// is held in process memory for one command, the Nango connection id is never
// printed (an opaque `connection_ref` stands in for it), and errors carry a
// typed code plus a bounded message that never embeds a provider response.
//
// Graph API shapes below are beliefs owned by the packet's feasibility task
// (T-001, OQ-002 records the license-coverage uncertainty) and pinned by
// fixtures in test/discoveryTeamsRuntime.test.ts; the live dogfood run (T-008)
// is what promotes them from belief to verified.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type TeamsRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "no_transcript"
  | "network"
  | "provider_timeout"
  | "transcript_too_large"
  | "budget_exhausted";

export class TeamsRuntimeError extends Error {
  constructor(public readonly code: TeamsRuntimeErrorCode, message: string) {
    super(message);
    this.name = "TeamsRuntimeError";
  }
}

export type TeamsConnection = {
  // Opaque, stable, non-enumerable stand-in for the connection identity.
  connection_ref: string;
  // The Teams connection is tenant-owned (R-002): the only broker is Nango,
  // where the Microsoft 365 administrator consented, refreshes, and revokes.
  broker: "nango";
  credential: { type: "oauth2"; access_token: string };
  credential_type: "oauth2";
  // Observed per connection, never assumed from a fixture (R-005): an OAuth
  // token is judged by its scopes when Nango reports them.
  transcript_scope: "granted" | "missing" | "unknown";
  // Observed from the connection's Nango metadata when the administrator's
  // connector setup records it. It is what lets listing classify internal-only
  // meetings from attendee email domains; unobserved, classification can not
  // claim a meeting is internal and nothing is excluded by it (R-005).
  tenant_domain: string | null;
};

// Versioned policy ceilings the worker enforces and reports, so a later change
// is explicit rather than silent (R-010). Fails closed (R-007).
export const TEAMS_POLICY = {
  policy_version: "teams-local-worker-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_pages: 5,
  min_request_interval_ms: 350,
} as const;

// Belief owned by T-001/R-003: the least-privilege Graph scope whose presence
// in the consented token signals transcript-read permission. R-003 verifies
// the real scope set receipt-backed; the capability surface only ever reports
// what the token itself declares.
const TEAMS_TRANSCRIPT_SCOPE = "OnlineMeetingTranscript.Read.All";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";

export type TeamsConnectionEnv = Record<string, string | undefined>;

export function teamsConnectionConfigured(env: TeamsConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_TEAMS_NANGO_CONNECTION?.trim());
}

export function teamsCredentialBroker(env: TeamsConnectionEnv): "nango" | null {
  return teamsConnectionConfigured(env) ? "nango" : null;
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `microsoft-teams:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new TeamsRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new TeamsRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so an
// oversized transcript is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new TeamsRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new TeamsRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
      throw new TeamsRuntimeError("transcript_too_large", "the provider response exceeds the byte ceiling");
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
    throw new TeamsRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the tenant's Teams credential. Nango is the only broker (R-002/R-011):
 * it holds the tenant-owned credential consented by the Microsoft 365
 * administrator, refreshes it, and is where that administrator revokes it.
 * productfoo receives it for one command and never persists or prints it.
 */
export async function resolveTeamsConnection(input: { env: TeamsConnectionEnv; fetchImpl: FetchLike }): Promise<TeamsConnection> {
  if (!teamsConnectionConfigured(input.env)) {
    throw new TeamsRuntimeError("not_connected", "Microsoft Teams is not connected: a Microsoft 365 administrator connects the tenant-owned connection through Nango — set NANGO_SECRET_KEY and FOO_TEAMS_NANGO_CONNECTION (plus NANGO_HOST / FOO_TEAMS_NANGO_INTEGRATION when they differ from the defaults)");
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_TEAMS_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_TEAMS_NANGO_INTEGRATION?.trim() || "microsoft-teams";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, TEAMS_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new TeamsRuntimeError("not_connected", "Nango refused the secret key; the Microsoft 365 administrator must reconnect Teams");
  if (response.status === 404) throw new TeamsRuntimeError("not_connected", "Nango has no Microsoft Teams connection with that reference; an administrator connects Teams first");
  if (!response.ok) throw new TeamsRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  const ref = opaqueConnectionRef(integration, connectionId);
  if (type !== "OAUTH2") throw new TeamsRuntimeError("not_connected", "the tenant-owned Teams connection uses a credential type productfoo does not support");
  const token = String(credentials.access_token ?? "");
  if (!token) throw new TeamsRuntimeError("auth_expired", "the tenant-owned connection carries no usable Graph access token; refresh or reconnect");
  const raw = (credentials.raw ?? {}) as Record<string, unknown>;
  const scopeValue = typeof raw.scope === "string" ? raw.scope : typeof credentials.scope === "string" ? credentials.scope : "";
  const scopes = scopeValue.split(/[\s,]+/).filter(Boolean);
  const transcriptScope: TeamsConnection["transcript_scope"] = scopes.length === 0 ? "unknown" : scopes.includes(TEAMS_TRANSCRIPT_SCOPE) ? "granted" : "missing";
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  const tenantDomain = typeof metadata.tenant_domain === "string" && metadata.tenant_domain.trim() ? metadata.tenant_domain.trim().toLowerCase() : null;
  return { connection_ref: ref, broker: "nango", credential: { type: "oauth2", access_token: token }, credential_type: "oauth2", transcript_scope: transcriptScope, tenant_domain: tenantDomain };
}

export type TeamsListedMeeting = {
  id: string;
  subject?: string;
  start?: string;
  end?: string;
  state?: string;
  organizer?: string;
  url?: string;
  transcript_available?: boolean;
};

type TeamsClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Fixture seam only: narrows the fetch ceiling so a test can observe a
  // timeout without waiting out the policy ceiling. Every real run keeps
  // TEAMS_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

// Graph puts identifiers in the path, so the read whitelist is structural:
// the meetings listing plus its transcript metadata and content subpaths.
// Anything else — or any non-GET method — routes through the single
// write-refusal choke point (R-009).
const TEAMS_READ_PATH = /^\/v1\.0\/communications\/onlineMeetings(?:\/[^/]+)?(?:\/(?:transcripts(?:\/[^/]+)?(?:\/content)?|attendanceReports))?$/;

function isReadOnlyOperation(method: "GET" | "POST", pathname: string): boolean {
  const base = pathname.split("?")[0];
  // A dot segment would normalize the path out of the whitelisted subtree.
  if (base.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return method === "GET" && TEAMS_READ_PATH.test(base);
}

/**
 * Minimal read-only Microsoft Graph client. Only documented read operations
 * are reachable; any other method or path routes through the single
 * write-refusal choke point (R-009) so the refusal is testable rather than
 * scattered. Graph shapes are T-001-owned beliefs pinned by fixtures.
 */
export class TeamsGraphClient {
  readonly requests = { list: 0, transcripts: 0, attendance: 0, transcript_content: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly credential: TeamsConnection["credential"], private readonly options: TeamsClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://graph.microsoft.com").replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? TEAMS_POLICY.fetch_timeout_ms;
  }

  private async request(method: "GET", pathname: string, maxBytes: number = TEAMS_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    if (!isReadOnlyOperation(method, pathname)) refuseSourceWrite(`microsoft-teams ${method} ${pathname}`);
    const wait = this.lastRequestAt + TEAMS_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${pathname}`,
      { method, headers: { authorization: `Bearer ${this.credential.access_token}`, accept: "application/json" } },
      this.fetchTimeoutMs,
    );
    if (response.status === 401) throw new TeamsRuntimeError("auth_expired", "Microsoft Graph rejected the credential; the Microsoft 365 administrator must refresh or reconnect");
    if (response.status === 403) throw new TeamsRuntimeError("access_denied", "Microsoft Graph denied this read; the tenant credential lacks the required permission");
    if (response.status === 429) throw new TeamsRuntimeError("budget_exhausted", "Graph throttling limit reached; no retry was attempted");
    if (response.status === 404) throw new TeamsRuntimeError("provider_failure", "Graph reported the requested record does not exist");
    if (!response.ok) throw new TeamsRuntimeError("provider_failure", `Microsoft Graph answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Microsoft Graph");
  }

  /**
   * Bounded metadata listing: one time window, a page ceiling, no content.
   * Follows Graph's `@odata.nextLink` paging; stops closed at the policy
   * ceiling instead of widening the read (R-004/R-010).
   */
  async listMeetings(window: { from: string; to: string }): Promise<{ meetings: TeamsListedMeeting[]; pages: number; truncated: boolean }> {
    const meetings: TeamsListedMeeting[] = [];
    let next: string | undefined = `/v1.0/communications/onlineMeetings?startDateTime=${encodeURIComponent(window.from)}&endDateTime=${encodeURIComponent(window.to)}`;
    let pages = 0;
    for (;;) {
      if (pages >= TEAMS_POLICY.max_list_pages) return { meetings, pages, truncated: true };
      this.requests.list += 1;
      const body = await this.request("GET", next!, 4 * 1024 * 1024);
      pages += 1;
      for (const entry of Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : []) {
        if (!entry || typeof entry.id !== "string") continue;
        const organizer = (entry.organizer ?? null) as Record<string, unknown> | null;
        const info = (organizer?.information ?? null) as Record<string, unknown> | null;
        meetings.push({
          id: entry.id,
          subject: typeof entry.subject === "string" ? entry.subject : undefined,
          start: typeof entry.startDateTime === "string" ? entry.startDateTime : undefined,
          end: typeof entry.endDateTime === "string" ? entry.endDateTime : undefined,
          state: typeof entry.state === "string" ? entry.state : undefined,
          organizer: typeof info?.displayName === "string" ? info.displayName : undefined,
          url: typeof entry.joinWebUrl === "string" ? entry.joinWebUrl : undefined,
        });
      }
      const link = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
      if (!link) return { meetings, pages, truncated: false };
      const parsed = new URL(link);
      next = `${parsed.pathname}${parsed.search}`;
    }
  }

  // Traversal probes never reach the provider, encoded or not: identifiers
  // are single opaque segments.
  private static wellFormedId(value: string, label: string): string {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new TeamsRuntimeError("provider_failure", `a single well-formed ${label} identifier is required`);
    }
    if (!value || /\s/.test(value) || decoded.includes("/") || decoded.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(decoded)) {
      throw new TeamsRuntimeError("provider_failure", `a single well-formed ${label} identifier is required`);
    }
    return value;
  }
  /** Transcript metadata for one meeting — never content. */
  async meetingTranscripts(meetingId: string): Promise<Array<{ id: string }>> {
    TeamsGraphClient.wellFormedId(meetingId, "meeting");
    this.requests.transcripts += 1;
    const body = await this.request("GET", `/v1.0/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`, 1024 * 1024);
    return (Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : [])
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({ id: entry.id as string }));
  }

  /**
   * Attendee display names and emails for one meeting, from its attendance
   * report (a T-001-owned belief pinned by fixtures; the Teams analog of the
   * gong parties read). Names feed the adapter's privacy-minimized
   * participants; emails die into domain-only company hints in the adapter.
   * A missing report is observed absence (an empty list), not an error.
   */
  async meetingAttendance(meetingId: string): Promise<Array<{ display_name?: string; email?: string }>> {
    TeamsGraphClient.wellFormedId(meetingId, "meeting");
    this.requests.attendance += 1;
    const body = await this.request("GET", `/v1.0/communications/onlineMeetings/${encodeURIComponent(meetingId)}/attendanceReports`, 1024 * 1024);
    const records: Array<{ display_name?: string; email?: string }> = [];
    for (const report of Array.isArray(body.value) ? (body.value as Array<Record<string, unknown>>) : []) {
      for (const record of Array.isArray(report.attendanceRecords) ? (report.attendanceRecords as Array<Record<string, unknown>>) : []) {
        const address = (record.emailAddress ?? null) as Record<string, unknown> | null;
        const display_name = typeof address?.name === "string" && address.name.trim() ? address.name.trim() : undefined;
        const email = typeof address?.address === "string" && address.address.trim() ? address.address.trim() : undefined;
        if (!display_name && !email) continue;
        if (!records.some((entry) => entry.display_name === display_name && entry.email === email)) records.push({ ...(display_name ? { display_name } : {}), ...(email ? { email } : {}) });
      }
    }
    return records;
  }

  /**
   * Exactly one transcript content read (R-007): the caller passes one
   * meeting id and one transcript id, and no request ever carries more. The
   * content returns bounded into process memory; nothing is written.
   */
  async transcriptContent(meetingId: string, transcriptId: string): Promise<string> {
    TeamsGraphClient.wellFormedId(meetingId, "meeting");
    TeamsGraphClient.wellFormedId(transcriptId, "transcript");
    this.requests.transcript_content += 1;
    const body = await this.request("GET", `/v1.0/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`, TEAMS_POLICY.max_response_bytes);
    const content = body.content ?? body.value ?? body;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
}
