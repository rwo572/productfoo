// `foo discovery slack …` — the local worker for a company Slack connection
// (slack-discovery-connector-v0, chat decision_context, D-010 local worker
// mode).
//
// The chat class's worker: V0 lists nothing on its own — the approved scope's
// explicit thread selection IS the listing, transcribed content-free — and it
// opens exactly one selected thread into process memory per proof. Message
// text is rendered through deterministic member labels (never raw workspace
// user ids, including ids embedded in message bodies), synthesized into a
// summary-only decision_context envelope in one model request, and applied
// through the core command; contact capture is suppressed because harvesting
// identities from chat is out of scope for chat evidence. The transcript never
// reaches argv, stdin, a file, Git, a log, an error, or the host agent's
// context; every surface this module writes is content-free (R-005).
// Contract-only: no verified-live claim anywhere.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { flagValue, hasFlag } from "./cliArgs.js";
import {
  discoveryTargetDir,
  inboxDir,
  inboxScope,
  existingFingerprint,
  isInboxTarget,
  localRoot,
  localTargetName,
  runDiscoveryCommand,
  type DiscoveryCommandOutcome,
  type DiscoveryCommandResult,
  type DiscoveryCommandStatus,
  type DiscoveryErrorCode,
} from "./discoveryCommand.js";
import { authorizeDiscoverySource, openAuthorizedTranscript, type AuthorizationResult } from "./discoveryProof.js";
import { slackDiscoveryAdapter, type SlackThreadRecord } from "./discoveryProviders.js";
import { sourceFingerprint } from "./discoveryMatching.js";
import { type DiscoverySession } from "./discoverySources.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { SLACK_THREAD_SELECTOR, slackScopeValidationError, type SlackScope } from "./sourceIngress.js";
import { SLACK_POLICY, SlackClient, SlackRuntimeError, resolveSlackConnection, slackConnectionConfigured, slackCredentialBroker, type FetchLike, type SlackThreadRead } from "./slackNango.js";

export type SlackDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
  // Fixture seam only: narrows the provider fetch ceiling so a test can
  // observe a timeout instead of waiting out SLACK_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

const SUPPORT_STATE = "contract_only";
const MODE = "local_worker";

function result(status: DiscoveryCommandStatus, options: Partial<Omit<DiscoveryCommandResult, "schema_version" | "status">> = {}): DiscoveryCommandResult {
  return { schema_version: "0.1", status, writes: [], errors: [], handoff: null, next_actions: [], coverage: {}, ...options };
}

function exitCodeFor(status: DiscoveryCommandStatus): number {
  return ["ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "invalid", "budget_exhausted"].includes(status) ? 1 : 0;
}

function outcome(value: DiscoveryCommandResult, json: boolean): DiscoveryCommandOutcome {
  const exitCode = exitCodeFor(value.status);
  if (json) return { output: `${JSON.stringify(value, null, 2)}\n`, exitCode, result: value };
  const lines = [`Discovery (slack): ${value.status}.`];
  for (const error of value.errors) lines.push(`- ${error.message}`);
  if (value.handoff) lines.push(`Handoff: ${value.handoff}`);
  for (const action of value.next_actions) lines.push(`Next: ${action}`);
  return { output: `${lines.join("\n")}\n`, exitCode, result: value };
}

function invalid(message: string, json: boolean, code: DiscoveryErrorCode = "E_DISCOVERY_VALIDATION", targetId?: string, coverage: Record<string, unknown> = {}): DiscoveryCommandOutcome {
  return outcome(result("invalid", { study_id: targetId, errors: [{ code, message }], coverage }), json);
}

// Typed provider failures map to the discovery command's closed status set.
// Messages are productfoo's own words: no provider body, id, or credential.
function fromRuntimeError(error: SlackRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect the company Slack workspace through Nango and set NANGO_SECRET_KEY and FOO_SLACK_NANGO_CONNECTION (plus NANGO_HOST / FOO_SLACK_NANGO_INTEGRATION when they differ from the defaults); or, for this runtime only, set FOO_SLACK_BOT_TOKEN from an administrator-issued bot token." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Ask the Slack administrator to refresh the connection or grant the read scope, then rerun." }), json);
    case "budget_exhausted":
      // A rate-limit stop is final for the run: nothing widens, nothing retries.
      return outcome(result("budget_exhausted", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: "The agreed read ceiling stopped this run; narrow the thread selection and rerun — productfoo never widens a scope or auto-retries." }), json);
    default:
      return outcome(result("invalid", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: error.code === "thread_too_large" || error.code === "provider_timeout" ? "Nothing was written and no retry was attempted; a new attempt needs a fresh match." : null }), json);
  }
}

// Authorization already failed closed (wrong state, missing approval, no
// proof): the status names the discovery lifecycle to land in.
class AuthorizationFailure extends Error {
  constructor(
    public readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationFailure";
  }
}

function authorizationFailure(error: AuthorizationFailure, json: boolean, targetId: string, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const known: DiscoveryCommandStatus[] = ["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"];
  const mapped = known.includes(error.status as DiscoveryCommandStatus) ? (error.status as DiscoveryCommandStatus) : "invalid";
  return outcome(result(mapped, { study_id: targetId, errors: [{ code: mapped === "needs_source_approval" ? "E_DISCOVERY_SOURCE_APPROVAL" : "E_DISCOVERY_VALIDATION", message: error.message }], handoff: error.message, coverage }), json);
}

type SlackTarget = {
  target_id: string;
  lane: "unassigned_call_evidence";
  dir: string;
  connection_alias: string;
  scope: SlackScope;
};

// Slack V0 runs against an approved inbox scope only: chat threads have no
// study-matching counterpart, so the study path does not exist here.
function loadTarget(root: string, targetId: string): SlackTarget {
  if (!isInboxTarget(targetId)) throw new Error("Slack V0 runs against an approved inbox scope (inbox:<scope-id>); chat threads have no study-matching counterpart");
  const scope = inboxScope(root, targetId);
  if (scope.provider.toLowerCase() !== "slack") throw new Error("this inbox scope is not a Slack scope");
  if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
  const slackScope: SlackScope = { channel_ids: scope.channel_ids ?? [], thread_ts: scope.thread_ts, window: scope.time_window };
  // R-004: validation is pre-flight — an invalid scope never reaches the provider.
  const scopeError = slackScopeValidationError(slackScope);
  if (scopeError) throw new Error(scopeError);
  return { target_id: targetId, lane: "unassigned_call_evidence", dir: discoveryTargetDir(root, targetId), connection_alias: scope.connection_alias, scope: slackScope };
}

// Composite `<channel-id>/<ts>` bounds split into the exact pair a read needs;
// the validator has already checked the channel against the scope's channels,
// so a read never guesses which approved channel to ask.
function parseThreadSelector(selector: string): { channelId: string; threadTs: string } {
  const match = SLACK_THREAD_SELECTOR.exec(selector);
  if (!match) throw new Error("the thread selection must be an explicit <channel-id>/<ts> selector like C0123456789/1679237238.123456");
  return { channelId: match[1]!, threadTs: match[2]! };
}

// The selector's parent ts, as an ISO completeness point for provenance.
function selectorCompletedAt(selector: string): string {
  const { threadTs } = parseThreadSelector(selector);
  return new Date(Number(threadTs.split(".")[0]) * 1000).toISOString();
}

// Workspace permalink host (e.g. acme.slack.com) — a runtime env selector the
// operator sets from their own Slack workspace; sanitized through the declared
// provider link form before anything is stored. Absent = no stable link.
function slackPermalink(env: NodeJS.ProcessEnv, channelId: string, threadTs: string): string | undefined {
  const host = env.FOO_SLACK_WORKSPACE_HOST?.trim();
  if (!host) return undefined;
  return `https://${host}/archives/${channelId}/p${threadTs.replace(".", "")}`;
}

// Deterministic member labels: each distinct provider user id — from the user
// field OR embedded in message text — becomes member-<4 hex> for this one
// read, and bot messages are labeled "bot", so the model request and the
// rendered content never carry a resolvable workspace identity. Timestamps
// survive as locators (OQ-002).
const MESSAGE_USER_ID = /\bU[A-Z0-9]{8,}\b/g;

function renderThreadContent(messages: Array<{ ts?: string; user?: string; bot_id?: string; subtype?: string; text?: string }>): string {
  const labels = new Map<string, string>();
  const label = (userId: string): string => {
    let mapped = labels.get(userId);
    if (!mapped) {
      mapped = `member-${createHash("sha256").update(userId).digest("hex").slice(0, 4)}`;
      labels.set(userId, mapped);
    }
    return mapped;
  };
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.text !== "string" || !message.text) continue;
    // Join/leave and channel bookkeeping entries are not conversation content.
    if (message.subtype && message.subtype !== "thread_broadcast") continue;
    const speaker = message.user ? label(message.user) : message.bot_id ? "bot" : "unknown";
    const text = message.text.replace(MESSAGE_USER_ID, (id) => label(id));
    lines.push(`[${message.ts ?? "unknown-ts"}] ${speaker}: ${text}`);
  }
  return lines.join("\n");
}

// Every raw user id the read observed: speaker fields plus ids embedded in
// message bodies. The post-synthesis screen checks derived text against this
// full set — defense in depth behind the render-time scrubbing.
function observedUserIds(messages: Array<{ user?: string; text?: string }>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.user === "string") ids.add(message.user);
    if (typeof message.text === "string") {
      for (const id of message.text.match(MESSAGE_USER_ID) ?? []) ids.add(id);
    }
  }
  return [...ids];
}

function containsRawUserId(text: string, userIds: string[]): boolean {
  const haystack = text.toLowerCase();
  return userIds.some((id) => id.length >= 4 && haystack.includes(id.toLowerCase()));
}

// Exact-scope admission (OQ-001): the scope's own thread selector is the
// matcher. Writing the match record and authorizing here keeps the proof,
// fingerprint, and provenance machinery identical to every other source while
// chat evidence skips the participant/domain/title matcher it was never shaped
// for. Nothing content-bearing lands: the session is channel-level metadata.
function threadSession(target: SlackTarget, selector: string, env: NodeJS.ProcessEnv): DiscoverySession {
  const { channelId, threadTs } = parseThreadSelector(selector);
  const record: SlackThreadRecord = { channel_id: channelId, thread_ts: threadTs, permalink: slackPermalink(env, channelId, threadTs) };
  const session = slackDiscoveryAdapter.normalizeSession(record, target.connection_alias);
  session.access = "available";
  return session;
}

function selectThread(root: string, target: SlackTarget, session: DiscoverySession, now: string): string {
  const matchDir = path.join(localRoot(root), localTargetName(target.target_id));
  mkdirSync(matchDir, { recursive: true });
  writeFileSync(
    path.join(matchDir, "match.json"),
    `${JSON.stringify({ schema_version: "0.1", candidates: [{ candidate_index: 1, source_fingerprint: sourceFingerprint(session), session }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const authorized: AuthorizationResult = authorizeDiscoverySource({ study_dir: inboxDir(root), local_root: localRoot(root), study_id: target.target_id, study_state: "awaiting_match", match_status: "unique", session, now });
  if (authorized.status !== "ready_to_synthesize") throw new AuthorizationFailure(authorized.status, authorized.handoff ?? "the selected thread was not authorized for a read");
  return authorized.source_fingerprint;
}

async function readyCommand(root: string, json: boolean, deps: Required<SlackDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "slack",
    mode: MODE,
    support_state: SUPPORT_STATE,
    connection_owner: "workspace",
    configured: slackConnectionConfigured(env),
    credential_broker: slackCredentialBroker(env),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...SLACK_POLICY },
  };
  try {
    const connection = await resolveSlackConnection({ env, fetchImpl: deps.fetchImpl });
    const client = new SlackClient(connection, { fetchImpl: deps.fetchImpl, baseUrl: env.FOO_SLACK_API_BASE?.trim() || undefined, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
    // The readiness probe is one metadata call: it proves the credential and
    // the listing permission without reading any message text.
    const probe = await client.probeWorkspace();
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.capabilities = { list_sessions: true, open_threads: true, stable_link: Boolean(env.FOO_SLACK_WORKSPACE_HOST?.trim()), timestamps: true };
    coverage.provider_calls = client.requests;
    coverage.workspace_channels_visible = probe.channels;
    return outcome(result("ok", { coverage, next_actions: [
      ...(connection.broker === "direct" ? ["Credential broker is direct: this runtime holds an administrator-issued bot token itself. Refresh and revoke happen in Slack, not centrally; move to Nango for the company connection."] : []),
      "Approve a bounded Slack scope with explicit channel and thread selectors, then run foo discovery slack list <inbox:scope-id>.",
      ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a thread."] : []),
    ] }), json);
  } catch (error) {
    if (error instanceof SlackRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Slack readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<SlackDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery slack list <inbox:scope-id>", json);
  const now = deps.now();
  let target: SlackTarget;
  try {
    target = loadTarget(root, targetId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = {
    mode: MODE,
    support_state: SUPPORT_STATE,
    lane: target.lane,
    transcript_opened: false,
    provider_calls: { conversations_list: 0, conversations_info: 0, conversations_history: 0, conversations_replies: 0 },
    selected_threads: target.scope.thread_ts?.length ?? 0,
  };
  // Content-free listing: the approved scope's own explicit thread selection
  // is the listing. No provider call happens; thread existence is proven by
  // the single read in `process`.
  const selected = target.scope.thread_ts ?? [];
  // Fail fast on an unconfigured runtime even where no provider call would
  // happen: an operator learns about the gap before any work runs.
  if (!slackConnectionConfigured(deps.env)) {
    return fromRuntimeError(new SlackRuntimeError("not_connected", "Slack is not connected: set NANGO_SECRET_KEY and FOO_SLACK_NANGO_CONNECTION for the company connection through Nango"), json, targetId, coverage);
  }
  if (selected.length > 1) {
    return outcome(result("ambiguous_match", {
      study_id: targetId,
      coverage,
      errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: `The scope selected ${selected.length} threads; processing reads exactly one per proof, so name one.` }],
      handoff: `foo discovery slack process ${targetId} --thread <channel-id>/<ts>`,
      next_actions: [`Approved thread selectors: ${selected.join(", ")}`],
    }), json);
  }
  const selector = selected[0]!;
  try {
    const fingerprint = selectThread(root, target, threadSession(target, selector, deps.env), now);
    return outcome(result("ok", {
      study_id: targetId,
      coverage: { ...coverage, matched_thread: selector, source_fingerprint: fingerprint },
      next_actions: [`Run foo discovery slack process ${targetId} to open this one thread and apply the sanitized summary-only evidence.`],
    }), json);
  } catch (error) {
    if (error instanceof AuthorizationFailure) return authorizationFailure(error, json, targetId, coverage);
    return invalid("Slack listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function processCommand(root: string, targetId: string | undefined, args: string[], json: boolean, deps: Required<SlackDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery slack process <inbox:scope-id> [--thread <channel-id>/<ts>]", json);
  const now = deps.now();
  let target: SlackTarget;
  try {
    target = loadTarget(root, targetId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = { mode: MODE, support_state: SUPPORT_STATE, lane: target.lane, transcript_opened: false };
  const requested = flagValue(args, "--thread");
  if (requested && !target.scope.thread_ts?.includes(requested.trim())) {
    return invalid("the requested thread is not in the approved scope's explicit thread selection; nothing was opened", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
  const selected = requested?.trim() ?? target.scope.thread_ts?.[0];
  if (!selected) {
    return outcome(result("ambiguous_match", {
      study_id: targetId,
      coverage,
      errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "The scope selected several threads; name one with --thread <channel-id>/<ts>." }],
      handoff: `foo discovery slack process ${targetId} --thread <channel-id>/<ts>`,
    }), json);
  }
  // Proof and match first, before any provider call or model request: the
  // authorization gates everything downstream.
  // One read per applied source: if this exact thread's evidence is already
  // applied to the inbox, a repeat process must not re-match and re-open it.
  // A completed apply consumes the proof and removes the local match state, so
  // the applied fingerprint in findings.yaml is the only durable record.
  const candidateSession = threadSession(target, selected, deps.env);
  if (existingFingerprint(discoveryTargetDir(root, targetId), sourceFingerprint(candidateSession))) {
    return outcome(result("needs_research_proof", {
      study_id: targetId,
      coverage,
      errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "This thread's evidence was already applied; reopening it would read the source a second time." }],
      handoff: "Run foo discovery slack list to select a different approved thread, or review the applied evidence.",
    }), json);
  }
  let fingerprint: string;
  try {
    fingerprint = selectThread(root, target, candidateSession, now);
  } catch (error) {
    if (error instanceof AuthorizationFailure) return authorizationFailure(error, json, targetId, coverage);
    // Fail closed, but never silently: the operator needs the validator's
    // reason on stderr. Validator and matcher messages are policy text and
    // carry no source content.
    console.error(`Slack select failed: ${error instanceof Error ? error.message : String(error)}`);
    return invalid("Slack processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
  // Synthesis credential BEFORE opening: no content is fetched if the run
  // cannot synthesize it.
  if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, coverage, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the thread was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
  const model = defaultSynthesisModel(deps.env);
  const { channelId, threadTs } = parseThreadSelector(selected);
  let connection;
  try {
    connection = await resolveSlackConnection({ env: deps.env, fetchImpl: deps.fetchImpl });
  } catch (error) {
    if (error instanceof SlackRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    throw error;
  }
  const client = new SlackClient(connection, { fetchImpl: deps.fetchImpl, baseUrl: deps.env.FOO_SLACK_API_BASE?.trim() || undefined, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
  coverage.connection = connection.connection_ref;
  // Exactly one content read happens inside the proof boundary (the reply
  // ceiling is enforced inside the client); rendering through member labels
  // happens immediately, and the raw read never leaves this scope.
  let openError: SlackRuntimeError | undefined;
  let read: SlackThreadRead | undefined;
  try {
    read = await openAuthorizedTranscript(
      { study_dir: inboxDir(root), local_root: localRoot(root), study_id: targetId, source_fingerprint: fingerprint, now },
      async () => {
        try {
          return await client.threadReplies(channelId, threadTs);
        } catch (error) {
          if (error instanceof SlackRuntimeError) openError = error;
          throw error;
        }
      },
    );
  } catch (error) {
    if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, transcript_body_requests: client.requests.conversations_replies });
    return outcome(result("needs_research_proof", { study_id: targetId, coverage, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The thread was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery slack list ${targetId} again to re-match and mint a fresh proof.` }), json);
  }
  coverage.transcript_body_requests = client.requests.conversations_replies;
  const permalink = slackPermalink(deps.env, channelId, threadTs);
  const rendered = renderThreadContent(read.messages);
  const rawUserIds = observedUserIds(read.messages);
  const truncated = read.has_more;
  const estimatedTokens = Math.ceil(rendered.length / 4);
  if (estimatedTokens > SLACK_POLICY.max_model_input_tokens) {
    return fromRuntimeError(new SlackRuntimeError("thread_too_large", "the thread exceeds the model-input ceiling; nothing was synthesized"), json, targetId, { ...coverage, transcript_body_requests: client.requests.conversations_replies });
  }
  let synthesized;
  try {
    synthesized = await synthesizeDiscoveryEnvelope(
      {
        target_id: targetId,
        lane: target.lane,
        // The permalink is channel-level provenance (no member identity); when
        // the workspace host is unset there is no stable link, and the
        // envelope must say so explicitly rather than imply one exists.
        source: { provider: "slack", source_fingerprint: fingerprint, completed_at: selectorCompletedAt(selected), locator_capability: "timestamp", ...(permalink ? { stable_url: permalink } : {}) },
        title: `Slack thread ${channelId} ${threadTs}`,
        hypotheses: [],
        transcript_text: rendered,
        // A thread longer than the one-page reply ceiling was not fully read;
        // the envelope says so instead of implying completeness.
        transcript_complete: !truncated,
        caveats: [
          ...(truncated ? ["The thread exceeded the reply ceiling; later replies were not read and the summary covers the first page only."] : []),
          ...(permalink ? [] : ["No stable link is available for this thread; provenance is the channel and thread ids only."]),
        ],
      },
      { model, transport: deps.transport },
    );
  } catch {
    return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the thread content was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
  }
  coverage.synthesis_usage = synthesized.usage ?? null;
  coverage.model = model;
  // Privacy screen beyond the envelope validator: raw workspace user ids must
  // not survive into derived text even as prose; member labels are the only
  // speaker identity the envelope ever carries.
  const derivedText = [
    ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
    ...synthesized.envelope.coverage.caveats,
  ].join("\n");
  if (containsRawUserId(derivedText, rawUserIds)) return invalid("Synthesis leaked a member identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
  // Chat class: no contact capture from chat in V0 — identity harvesting from
  // message text is out of scope for decision_context evidence.
  const envelope = { ...synthesized.envelope };
  delete envelope.contact_candidates;
  const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(envelope), now);
  return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
}

export async function runSlackDiscovery(root: string, args: string[], deps: SlackDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const required: Required<SlackDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env: deps.env }),
    fetchTimeoutMs: deps.fetchTimeoutMs ?? SLACK_POLICY.fetch_timeout_ms,
  };
  const [command, targetId] = args;
  try {
    if (command === "ready") return await readyCommand(root, json, required);
    if (command === "list") return await listCommand(root, targetId, json, required);
    if (command === "process") return await processCommand(root, targetId, args, json, required);
    return invalid("Usage: foo discovery slack <ready|list|process> …", json);
  } catch (error) {
    if (error instanceof SlackRuntimeError) return fromRuntimeError(error, json, targetId, { mode: MODE, support_state: SUPPORT_STATE });
    // Fail closed, but never silently: the operator needs the real reason on
    // stderr. Internal validator/command messages are policy text and carry no
    // source content.
    console.error(`Slack discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    return invalid("Slack discovery failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId);
  }
}
