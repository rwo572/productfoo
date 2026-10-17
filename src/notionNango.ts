// Notion through Nango (notion-discovery-connector-v0, contract-only docs slice).
//
// Nango is the credential broker (the packet's External Prerequisites: Nango
// as the OAuth broker for the company Notion connection). Everything here is
// content-free on every surface productfoo owns: the credential is held in process
// memory for one operation, the Nango connection id is never printed (an
// opaque `connection_ref` stands in for it), and errors carry a typed code
// plus a bounded message that never embeds a provider response.
//
// The Notion API shapes below are beliefs owned by the packet's feasibility
// task (T-001) and pinned by fixtures in test/discoveryNotionRuntime.test.ts;
// the receipt-backed feasibility report (R-003) is what promotes them from
// belief to verified. Support stays contract_only until then.
//
// Read-only by construction (R-007): only documented read operations are
// reachable; any other method or path routes through the single write-refusal
// choke point so the refusal is testable rather than scattered. The
// workspace-wide search endpoint is deliberately NOT on the allow-list — a
// workspace-wide listing is exactly what R-004 refuses.

import { createHash } from "node:crypto";
import { refuseSourceWrite } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type NotionRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "content_too_large"
  | "budget_exhausted";

export class NotionRuntimeError extends Error {
  constructor(public readonly code: NotionRuntimeErrorCode, message: string) {
    super(message);
    this.name = "NotionRuntimeError";
  }
}

export type NotionConnection = {
  // Opaque, stable stand-in for the connection identity — never the raw id.
  connection_ref: string;
  // Who supplied the credential: Nango (the company connection, refreshable
  // and revocable centrally) or a direct administrator-issued integration
  // token set in this runtime's environment. The readiness surface reports it
  // so the direct path is never mistaken for the company connection.
  broker: "nango" | "direct";
  credential: { type: "oauth2"; access_token: string };
};

// Versioned policy ceilings (the Granola/Gong policy pattern): hard limits the
// runtime enforces and reports, so a later change is explicit rather than
// silent. Every ceiling fails closed.
export const NOTION_POLICY = {
  policy_version: "notion-docs-0.1",
  max_response_bytes: 2 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_list_records: 50,
  min_request_interval_ms: 350,
} as const;

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_NOTION_BASE = "https://api.notion.com";
// Belief owned by T-001: the Notion API version header pins response shapes.
const NOTION_API_VERSION = "2022-06-28";

export type NotionConnectionEnv = Record<string, string | undefined>;

function nangoConfigured(env: NotionConnectionEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_NOTION_NANGO_CONNECTION?.trim());
}

function directConfigured(env: NotionConnectionEnv): boolean {
  return Boolean(env.FOO_NOTION_API_TOKEN?.trim());
}

export function notionConnectionConfigured(env: NotionConnectionEnv): boolean {
  return nangoConfigured(env) || directConfigured(env);
}

export function notionCredentialBroker(env: NotionConnectionEnv): "nango" | "direct" | null {
  if (nangoConfigured(env)) return "nango";
  if (directConfigured(env)) return "direct";
  return null;
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  return `notion:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new NotionRuntimeError("provider_timeout", "the provider did not answer within the fetch ceiling");
    throw new NotionRuntimeError("network", `network failure reaching ${new URL(url).hostname}`);
  } finally {
    clearTimeout(timer);
  }
}

// Reads a response body while counting toward the byte ceiling, so oversized
// page content is dropped before it is ever materialized in full.
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new NotionRuntimeError("content_too_large", "the provider response exceeds the byte ceiling");
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new NotionRuntimeError("content_too_large", "the provider response exceeds the byte ceiling");
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
      throw new NotionRuntimeError("content_too_large", "the provider response exceeds the byte ceiling");
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
    throw new NotionRuntimeError("provider_failure", `${label} returned a response productfoo could not read`);
  }
}

/**
 * Resolve the company's Notion credential. Nango is the broker: it holds the
 * OAuth credential, refreshes it, and is where an administrator revokes it.
 * When Nango is not configured, an administrator-issued integration token set
 * directly in this runtime's environment (FOO_NOTION_API_TOKEN) is accepted as
 * the direct fallback — the same read-only surface, minus the central refresh
 * and revoke story, and reported as `direct` so it is never mistaken for the
 * company connection. Either way productfoo receives the credential for one operation
 * and never persists or prints it.
 */
export async function resolveNotionConnection(input: { env: NotionConnectionEnv; fetchImpl: FetchLike }): Promise<NotionConnection> {
  const broker = notionCredentialBroker(input.env);
  if (broker === null) {
    throw new NotionRuntimeError("not_connected", "Notion is not connected: set NANGO_SECRET_KEY and FOO_NOTION_NANGO_CONNECTION for the company connection through Nango, or FOO_NOTION_API_TOKEN for a direct administrator-issued integration token");
  }
  if (broker === "direct") {
    const token = input.env.FOO_NOTION_API_TOKEN!.trim();
    return {
      connection_ref: `notion:direct:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
      broker: "direct",
      credential: { type: "oauth2", access_token: token },
    };
  }
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_NOTION_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_NOTION_NANGO_INTEGRATION?.trim() || "notion";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  const response = await fetchWithTimeout(input.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } }, NOTION_POLICY.fetch_timeout_ms);
  if (response.status === 401 || response.status === 403) throw new NotionRuntimeError("not_connected", "Nango refused the secret key; reconnect Notion");
  if (response.status === 404) throw new NotionRuntimeError("not_connected", "Nango has no Notion connection with that reference; connect Notion first");
  if (!response.ok) throw new NotionRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const type = String(credentials.type ?? "").toUpperCase();
  const token = String(credentials.access_token ?? "");
  if (type !== "OAUTH2" || !token) throw new NotionRuntimeError("not_connected", "the Nango connection carries no usable Notion OAuth token; reconnect Notion");
  return { connection_ref: opaqueConnectionRef(integration, connectionId), broker: "nango", credential: { type: "oauth2", access_token: token } };
}

export type NotionPageMeta = { id: string; title?: string; last_edited_time?: string; url?: string };
export type NotionBlock = { text?: string; has_children?: boolean };

type NotionClientOptions = {
  fetchImpl: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const READ_PATHS = new Set(["page", "blocks_children", "database_query"]);

/**
 * Minimal read-only Notion REST client. Only the three documented read
 * operations are reachable — page metadata, one page's block content, and a
 * bounded database query. Any other method or path routes through the single
 * write-refusal choke point (R-007), and the workspace-wide search endpoint is
 * absent from the allow-list entirely (R-004).
 */
export class NotionClient {
  readonly requests = { page: 0, content: 0, database: 0 };
  private lastRequestAt = 0;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly credential: NotionConnection["credential"], private readonly options: NotionClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_NOTION_BASE).replace(/\/+$/, "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private async request(kind: "page" | "blocks_children" | "database_query", pathname: string, body?: unknown, maxBytes: number = NOTION_POLICY.max_response_bytes): Promise<Record<string, unknown>> {
    if (!READ_PATHS.has(kind)) refuseSourceWrite(`notion ${kind} ${pathname}`);
    const wait = this.lastRequestAt + NOTION_POLICY.min_request_interval_ms - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    const response = await fetchWithTimeout(
      this.options.fetchImpl,
      `${this.baseUrl}${pathname}`,
      {
        method: body !== undefined ? "POST" : "GET",
        headers: { authorization: `Bearer ${this.credential.access_token}`, accept: "application/json", "notion-version": NOTION_API_VERSION, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      NOTION_POLICY.fetch_timeout_ms,
    );
    if (response.status === 401) throw new NotionRuntimeError("auth_expired", "Notion rejected the credential; refresh or reconnect");
    if (response.status === 403) throw new NotionRuntimeError("access_denied", "Notion denied this read; the connection lacks the required permission");
    if (response.status === 429) throw new NotionRuntimeError("budget_exhausted", "Notion rate limit reached; no retry was attempted");
    if (response.status === 404) throw new NotionRuntimeError("provider_failure", "Notion reported the requested record does not exist or is not shared with the connection");
    if (!response.ok) throw new NotionRuntimeError("provider_failure", `Notion answered ${response.status}`);
    return parseJson(await readBounded(response, maxBytes), "Notion");
  }

  /** One page's metadata — title, last-edited time, canonical link. No content. */
  async page(pageId: string): Promise<NotionPageMeta> {
    this.requests.page += 1;
    const body = await this.request("page", `/v1/pages/${encodeURIComponent(pageId)}`, undefined, 256 * 1024);
    const title = plainText((body.properties as Record<string, unknown> | undefined)?.title);
    return {
      id: typeof body.id === "string" ? body.id : pageId,
      title: typeof title === "string" ? title : undefined,
      last_edited_time: typeof body.last_edited_time === "string" ? body.last_edited_time : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
    };
  }

  /**
   * Exactly one page's content (R-005): the page's block children flattened to
   * plain text, read once, bounded by the byte ceiling. The caller is the
   * proof-gated summarize flow; no other path may call this.
   */
  async pageContent(pageId: string): Promise<string> {
    this.requests.content += 1;
    const body = await this.request("blocks_children", `/v1/blocks/${encodeURIComponent(pageId)}/children`, undefined, NOTION_POLICY.max_response_bytes);
    const blocks = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
    const lines: string[] = [];
    for (const block of blocks) {
      // A Notion block carries its text under the type key
      // ({type: "paragraph", paragraph: {rich_text: [...]}}); some property
      // shapes carry rich_text directly.
      const kind = typeof block.type === "string" ? block.type : "";
      const payload = kind && block[kind] && typeof block[kind] === "object" ? (block[kind] as Record<string, unknown>) : block;
      const text = plainText(payload) ?? plainText(block);
      if (text) lines.push(text);
    }
    return lines.join("\n");
  }

  /** Bounded metadata listing for one approved database selection. No content. */
  async queryDatabase(databaseId: string): Promise<Array<{ id: string; title?: string; last_edited_time?: string; url?: string }>> {
    this.requests.database += 1;
    const rows: Array<{ id: string; title?: string; last_edited_time?: string; url?: string }> = [];
    let cursor: string | undefined;
    for (;;) {
      const body = await this.request("database_query", `/v1/databases/${encodeURIComponent(databaseId)}/query`, { page_size: NOTION_POLICY.max_list_records, ...(cursor ? { start_cursor: cursor } : {}) }, 1024 * 1024);
      for (const entry of Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : []) {
        if (typeof entry.id !== "string") continue;
        const properties = (entry.properties ?? {}) as Record<string, unknown>;
        rows.push({
          id: entry.id,
          title: plainText(properties[Object.keys(properties).find((key) => (properties[key] as Record<string, unknown> | undefined)?.type === "title") ?? ""] ?? {}),
          last_edited_time: typeof entry.last_edited_time === "string" ? entry.last_edited_time : undefined,
          url: typeof entry.url === "string" ? entry.url : undefined,
        });
        if (rows.length >= NOTION_POLICY.max_list_records) return rows;
      }
      cursor = typeof (body as { next_cursor?: unknown }).next_cursor === "string" && body.next_cursor ? (body.next_cursor as string) : undefined;
      if (!cursor) return rows;
    }
  }
}

// Flattens a Notion rich-text array (or any property object carrying one)
// to its plain text. Belief owned by T-001, pinned by fixtures.
function plainText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rich = (value as Record<string, unknown>).rich_text ?? (value as Record<string, unknown>).title;
  if (!Array.isArray(rich)) return undefined;
  const text = rich.map((entry) => (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).plain_text === "string" ? (entry as Record<string, unknown>).plain_text : "")).join("");
  return text.trim() ? text : undefined;
}
