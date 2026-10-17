// Slack through Nango (slack-discovery-connector-v0, local worker mode).
// Nango is the credential broker only: productfoo asks Nango for the company's Slack
// token and then talks to Slack's Web API directly. Every surface productfoo owns is
// content-free: provider errors and metadata only — message text is fetched by
// the worker through the proof boundary and never persisted outside process
// memory (R-005). Slack API shapes below are beliefs owned by the packet's
// feasibility task (T-001) and pinned by fixtures in test/discoverySlack.test.ts;
// the live dogfood run (T-007) is what would promote them from belief to verified.
// Contract-only: this adapter makes no verified-live claim.

import { createHash } from "node:crypto";
import { SLACK_CHANNEL_ID, refuseSourceWrite, SLACK_SCOPE_LIMITS } from "./sourceIngress.js";

export type FetchLike = typeof globalThis.fetch;

export type SlackRuntimeErrorCode =
  | "not_connected"
  | "auth_expired"
  | "access_denied"
  | "provider_failure"
  | "network"
  | "provider_timeout"
  | "thread_too_large"
  | "budget_exhausted";

export class SlackRuntimeError extends Error {
  constructor(
    public readonly code: SlackRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SlackRuntimeError";
  }
}

export type SlackConnection = {
  // Opaque provider-side reference for match.json provenance. Never a secret.
  connection_ref: string;
  broker: "nango" | "direct";
  // Secret material stays in process memory only; never logged, never stored.
  token: string;
};

export type SlackResponseEnvelope = Record<string, unknown>;

export const SLACK_POLICY = {
  policy_version: "slack-local-worker-0.1",
  max_response_bytes: 4 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  max_replies_per_thread: 200,
  min_request_interval_ms: 1_100,
  max_channels_probed: SLACK_SCOPE_LIMITS.max_channels_per_scope,
} as const;

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_SLACK_BASE = "https://slack.com";
const SLACK_READ_API = new Set(["conversations.list", "conversations.info", "conversations.history", "conversations.replies"]);
const SLACK_AUTH_ERRORS = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired"]);
const SLACK_ACCESS_ERRORS = new Set(["missing_scope", "not_in_channel", "not_allowed_type", "method_not_supported_for_channel_type", "access_denied"]);

export type SlackConnectionEnv = Record<string, string | undefined>;

export function slackConnectionConfigured(env: SlackConnectionEnv): boolean {
  const viaNango = Boolean(env.NANGO_SECRET_KEY?.trim() && env.FOO_SLACK_NANGO_CONNECTION?.trim());
  const direct = Boolean(env.FOO_SLACK_BOT_TOKEN?.trim());
  return viaNango || direct;
}

export function slackCredentialBroker(env: SlackConnectionEnv): "nango" | "direct" | null {
  if (env.NANGO_SECRET_KEY?.trim() && env.FOO_SLACK_NANGO_CONNECTION?.trim()) return "nango";
  if (env.FOO_SLACK_BOT_TOKEN?.trim()) return "direct";
  return null;
}

function opaqueConnectionRef(integration: string, connectionId: string): string {
  // Hash, never log, never store the raw connection id in findings provenance.
  return `slack:${createHash("sha256").update(`${integration}\n${connectionId}`).digest("hex").slice(0, 16)}`;
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new SlackRuntimeError("provider_timeout", "the Slack runtime timed out");
    }
    throw new SlackRuntimeError("network", "the Slack runtime could not reach the network");
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new SlackRuntimeError("provider_failure", "the provider response exceeded the size ceiling");
  }
  const body = await response.text();
  if (body.length > maxBytes) throw new SlackRuntimeError("provider_failure", "the provider response exceeded the size ceiling");
  return body;
}

function parseJson(raw: string, what: string): SlackResponseEnvelope {
  try {
    return JSON.parse(raw) as SlackResponseEnvelope;
  } catch {
    throw new SlackRuntimeError("provider_failure", `${what} returned something that is not JSON`);
  }
}

async function resolveNangoSlackToken(input: { env: SlackConnectionEnv; fetchImpl: FetchLike }): Promise<SlackConnection> {
  const secret = input.env.NANGO_SECRET_KEY!.trim();
  const connectionId = input.env.FOO_SLACK_NANGO_CONNECTION!.trim();
  const integration = input.env.FOO_SLACK_NANGO_INTEGRATION?.trim() || "slack";
  const host = (input.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
  const url = `${host}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integration)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      input.fetchImpl,
      url,
      { method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" } },
      SLACK_POLICY.fetch_timeout_ms,
    );
  } catch (error) {
    if (error instanceof SlackRuntimeError) throw error;
    throw new SlackRuntimeError("network", "the Slack runtime could not reach the network");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SlackRuntimeError("not_connected", "Nango refused the secret key; check the NANGO_SECRET_KEY for this runtime");
  }
  if (response.status === 404) {
    throw new SlackRuntimeError("not_connected", "Nango has no Slack connection under FOO_SLACK_NANGO_CONNECTION; connect Slack first");
  }
  if (!response.ok) throw new SlackRuntimeError("provider_failure", `Nango answered ${response.status} while resolving the Slack connection`);
  const body = parseJson(await readBounded(response, 256 * 1024), "Nango");
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  const token = typeof credentials.access_token === "string" ? credentials.access_token : "";
  if (!token) throw new SlackRuntimeError("not_connected", "the Nango connection carries no usable Slack token; reconnect Slack");
  return { connection_ref: opaqueConnectionRef(integration, connectionId), broker: "nango", token };
}

export async function resolveSlackConnection(input: { env: SlackConnectionEnv; fetchImpl: FetchLike }): Promise<SlackConnection> {
  const broker = slackCredentialBroker(input.env);
  if (broker === null) {
    throw new SlackRuntimeError(
      "not_connected",
      "Slack is not connected: set NANGO_SECRET_KEY and FOO_SLACK_NANGO_CONNECTION for the company connection through Nango, or FOO_SLACK_BOT_TOKEN for a direct administrator-issued bot token held in this runtime only",
    );
  }
  if (broker === "direct") {
    const token = input.env.FOO_SLACK_BOT_TOKEN!.trim();
    return { connection_ref: `slack:direct:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`, broker: "direct", token };
  }
  return resolveNangoSlackToken(input);
}

export type SlackMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
};

export type SlackThreadRead = {
  messages: SlackMessage[];
  has_more: boolean;
};

export class SlackClient {
  readonly requests = { conversations_list: 0, conversations_info: 0, conversations_history: 0, conversations_replies: 0 };
  private readonly connection: SlackConnection;
  private readonly options: { fetchImpl: FetchLike; baseUrl: string; now: () => number; sleep: (ms: number) => Promise<void>; fetchTimeoutMs: number };
  private lastRequestAt = 0;

  constructor(connection: SlackConnection, options: Partial<{ fetchImpl: FetchLike; baseUrl: string; now: () => number; sleep: (ms: number) => Promise<void>; fetchTimeoutMs: number }> = {}) {
    this.connection = connection;
    this.options = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      baseUrl: (options.baseUrl ?? DEFAULT_SLACK_BASE).replace(/\/+$/, ""),
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      fetchTimeoutMs: options.fetchTimeoutMs ?? SLACK_POLICY.fetch_timeout_ms,
    };
  }

  // V0's read surface is exactly four conversations.* methods. Anything else —
  // a POST, a chat.* call, an admin.* call — is refused before it leaves productfoo,
  // so the Slack API can never be mutated from a discovery run.
  private async request(api: string, params: Record<string, string>, maxBytes: number = SLACK_POLICY.max_response_bytes): Promise<SlackResponseEnvelope> {
    if (!SLACK_READ_API.has(api)) refuseSourceWrite(`slack ${api}`);
    const wait = this.lastRequestAt + SLACK_POLICY.min_request_interval_ms - this.options.now();
    if (wait > 0) await this.options.sleep(wait);
    this.lastRequestAt = this.options.now();
    const url = `${this.options.baseUrl}/api/${api}?${new URLSearchParams(params).toString()}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.options.fetchImpl,
        url,
        { method: "GET", headers: { authorization: `Bearer ${this.connection.token}`, accept: "application/json" } },
        this.options.fetchTimeoutMs,
      );
    } catch (error) {
      if (error instanceof SlackRuntimeError) throw error;
      throw new SlackRuntimeError("network", "the Slack runtime could not reach the network");
    }
    if (response.status === 401 || response.status === 403) throw new SlackRuntimeError("auth_expired", "Slack rejected the token; refresh or reconnect");
    if (response.status === 429) throw new SlackRuntimeError("budget_exhausted", "Slack rate limit reached; no retry was attempted");
    if (!response.ok) throw new SlackRuntimeError("provider_failure", `Slack answered ${response.status}`);
    const body = parseJson(await readBounded(response, maxBytes), "Slack");
    if (body.ok !== true) {
      const error = typeof body.error === "string" ? body.error : "unknown_error";
      if (SLACK_AUTH_ERRORS.has(error)) throw new SlackRuntimeError("auth_expired", "Slack rejected the token; refresh or reconnect");
      if (SLACK_ACCESS_ERRORS.has(error)) throw new SlackRuntimeError("access_denied", "Slack denied this read; the token lacks the required scope or channel access");
      if (error === "rate_limited") throw new SlackRuntimeError("budget_exhausted", "Slack rate limit reached; no retry was attempted");
      throw new SlackRuntimeError("provider_failure", "Slack refused the read; the selected channel or thread may no longer exist");
    }
    return body;
  }

  // Readiness probe: one metadata-only page of channels. Message text is never
  // requested here.
  async probeWorkspace(): Promise<{ channels: number }> {
    this.requests.conversations_list += 1;
    const body = await this.request("conversations.list", { types: "public_channel,private_channel", limit: "200", exclude_archived: "true" }, 1024 * 1024);
    return { channels: Array.isArray(body.channels) ? body.channels.length : 0 };
  }

  // The one content read in V0: the messages of the explicitly selected
  // thread, one bounded page.
  async threadReplies(channelId: string, threadTs: string): Promise<SlackThreadRead> {
    if (!SLACK_CHANNEL_ID.test(channelId)) throw new SlackRuntimeError("provider_failure", "a single well-formed channel identifier is required");
    if (!/^\d{10}\.\d{6}$/.test(threadTs)) throw new SlackRuntimeError("provider_failure", "a single well-formed thread timestamp is required");
    this.requests.conversations_replies += 1;
    const body = await this.request("conversations.replies", { channel: channelId, ts: threadTs, limit: String(SLACK_POLICY.max_replies_per_thread) });
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: SlackMessage[] = rawMessages.map((message) => {
      const record = (message ?? {}) as Record<string, unknown>;
      return {
        ts: typeof record.ts === "string" ? record.ts : undefined,
        user: typeof record.user === "string" ? record.user : undefined,
        bot_id: typeof record.bot_id === "string" ? record.bot_id : undefined,
        subtype: typeof record.subtype === "string" ? record.subtype : undefined,
        text: typeof record.text === "string" ? record.text : undefined,
      };
    });
    return { messages, has_more: body.has_more === true };
  }
}
