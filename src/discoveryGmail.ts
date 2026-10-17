// `foo discovery gmail …` — the local worker for a verified user's Gmail
// connection (gmail-discovery-connector-v0, per-user mailbox, D-002).
//
// This is the gong worker contract (R-011) with the email class's stricter
// composition: listing happens only inside an approved inbox scope naming
// explicit Gmail labels, a bounded window, and a customer selector (R-004);
// the readiness probe never lists (a label-less threads.list would be a
// mailbox-wide read, so `ready` proves the credential with one profile call);
// listing fetches thread headers only (format=metadata); and process opens
// exactly one proof-authorized thread's bodies into process memory, reduces
// them in one bounded model request to a PII-minimized closed envelope,
// screens derived text against the thread's own participants, applies
// locally, and discards the text in a `finally` (R-007). Attachments are
// never opened (D-003) — the client has no attachment method at all. Message
// text never reaches argv, stdin, a file, Git, a log, an error, or the host
// agent's context; every surface this module writes is content-free.
//
// What it is not: live support. Gmail reports `contract_only` until the
// feasibility report (T-001) proves the API surface and a real per-user
// dogfood run (T-008) succeeds — and the connection belongs to the verified
// user whose mailbox it is, never to the workspace (R-010).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasFlag } from "./cliArgs.js";
import {
  discoveryTargetDir,
  gmailScopeValidationError,
  inboxScope,
  isInboxTarget,
  localRoot,
  localTargetName,
  runDiscoveryCommand,
  type DiscoveryCommandOutcome,
  type DiscoveryCommandResult,
  type DiscoveryCommandStatus,
  type DiscoveryErrorCode,
} from "./discoveryCommand.js";
import type { DiscoveryLane } from "./discoveryEvidence.js";
import { openAuthorizedTranscript } from "./discoveryProof.js";
import { gmailDiscoveryAdapter, gmailInternalOnly, gmailThreadAdmissibility, type GmailThreadRecord } from "./discoveryProviders.js";
import type { DiscoverySession } from "./discoverySources.js";
import { planDiscoverySync } from "./discoverySync.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { GMAIL_POLICY, GmailClient, GmailRuntimeError, gmailConnectionConfigured, gmailCredentialBroker, resolveGmailConnection, type FetchLike, type GmailConnection, type GmailThreadMessage } from "./gmailNango.js";

export type GmailDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
  fetchTimeoutMs?: number;
};

const SUPPORT_STATE = "contract_only";
const MODE = "local_worker";

type Target = {
  target_id: string;
  lane: DiscoveryLane;
  dir: string;
  connection_alias: string;
  window: { from: string; to: string };
  labels: string[];
  external_domains: string[];
  external_names: string[];
};

function result(status: DiscoveryCommandStatus, options: Partial<Omit<DiscoveryCommandResult, "schema_version" | "status">> = {}): DiscoveryCommandResult {
  return { schema_version: "0.1", status, writes: [], errors: [], handoff: null, next_actions: [], coverage: {}, ...options };
}

function exitCodeFor(status: DiscoveryCommandStatus): number {
  return ["ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "invalid", "budget_exhausted"].includes(status) ? 1 : 0;
}

function outcome(value: DiscoveryCommandResult, json: boolean): DiscoveryCommandOutcome {
  const exitCode = exitCodeFor(value.status);
  if (json) return { output: `${JSON.stringify(value, null, 2)}\n`, exitCode, result: value };
  const lines = [`Discovery (gmail): ${value.status}.`];
  for (const error of value.errors) lines.push(`- ${error.message}`);
  if (value.handoff) lines.push(`Handoff: ${value.handoff}`);
  for (const action of value.next_actions) lines.push(`Next: ${action}`);
  return { output: `${lines.join("\n")}\n`, exitCode, result: value };
}

function invalid(message: string, json: boolean, code: DiscoveryErrorCode = "E_DISCOVERY_VALIDATION", targetId?: string, coverage: Record<string, unknown> = {}): DiscoveryCommandOutcome {
  return outcome(result("invalid", { study_id: targetId, errors: [{ code, message }], coverage }), json);
}

// Typed provider failures map to the discovery command's closed status set.
// Messages are productfoo's own words: no provider body, address, or credential.
function fromRuntimeError(error: GmailRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect the Gmail mailbox through Nango and set NANGO_SECRET_KEY and FOO_GMAIL_NANGO_CONNECTION (plus NANGO_HOST / FOO_GMAIL_NANGO_INTEGRATION when they differ from the defaults); the connection belongs to the verified user whose mailbox it is." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Reconnect the mailbox in Nango or grant the missing least-privilege read scope, then rerun." }), json);
    case "budget_exhausted":
      // A rate-limit stop is final for the run (R-004): the run ends, nothing
      // widens, nothing retries. The next run needs a narrower window.
      return outcome(result("budget_exhausted", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: "The agreed page or quota ceiling stopped this run; narrow the window or selectors and rerun — productfoo never widens the window or auto-retries." }), json);
    default:
      return outcome(result("invalid", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: error.code === "thread_too_large" || error.code === "provider_timeout" ? "Nothing was written and no retry was attempted; a new attempt needs a fresh match." : null }), json);
  }
}

// D-001's pinned boundary (T-005): a thread is settled when its last message
// predates the scope window's end by the quiet period, unless it carries an
// explicit done label.
function quietPeriodBoundary(windowEnd: string, quietPeriodHours: number): string {
  return new Date(Date.parse(windowEnd) - quietPeriodHours * 3_600_000).toISOString();
}

// R-004: the gmail scope is the strictest composition — validation is
// pre-flight, so an invalid scope never reaches the provider.
function gmailTarget(root: string, targetId: string): Target {
  if (!isInboxTarget(targetId)) {
    // V0 keeps every Gmail read inside an approved, label-bearing scope; the
    // study lane is deferred with the hosted service.
    throw new Error("gmail evidence is inbox-scoped in V0: approve an inbox scope naming explicit labels, a bounded window, and a customer selector (R-004)");
  }
  const scope = inboxScope(root, targetId);
  if (scope.provider.toLowerCase() !== "gmail") throw new Error("this inbox scope is not a Gmail scope");
  if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
  // The workspace env selector is narrowing only and never counts toward the
  // selector minimum.
  const selectors = {
    window: scope.time_window,
    labels: scope.labels,
    external_domains: scope.domain_allowlist,
    external_names: scope.participant_allowlist,
    include_internal_only: false as const,
  };
  const scopeError = gmailScopeValidationError(selectors);
  if (scopeError) throw new Error(scopeError);
  return {
    target_id: targetId,
    lane: "unassigned_call_evidence",
    dir: discoveryTargetDir(root, targetId),
    connection_alias: scope.connection_alias,
    window: { from: new Date(scope.time_window.start).toISOString(), to: new Date(scope.time_window.end).toISOString() },
    labels: scope.labels ?? [],
    external_domains: scope.domain_allowlist ?? [],
    external_names: scope.participant_allowlist ?? [],
  };
}

function toRecord(thread: { id: string; messages: GmailThreadMessage[] }, ownerEmail: string | undefined, bodyAccess: GmailConnection["body_scope"], quietPeriodEndsAt: string): GmailThreadRecord | null {
  if (thread.messages.length === 0) return null;
  const last = thread.messages[thread.messages.length - 1];
  const lastAt = last.internal_date ? new Date(Number(last.internal_date)).toISOString() : undefined;
  if (!lastAt || !Number.isFinite(Date.parse(lastAt))) return null;
  const participants: Array<{ display_name?: string; email?: string }> = [];
  for (const message of thread.messages) {
    if (message.from?.display_name || message.from?.email) participants.push({ ...(message.from.display_name ? { display_name: message.from.display_name } : {}), ...(message.from.email ? { email: message.from.email } : {}) });
    for (const recipient of message.to ?? []) participants.push({ ...(recipient.display_name ? { display_name: recipient.display_name } : {}), ...(recipient.email ? { email: recipient.email } : {}) });
  }
  const labels = [...new Set(thread.messages.flatMap((message) => message.labels ?? []))];
  const subject = [...thread.messages].reverse().map((message) => message.subject?.trim()).find(Boolean);
  return {
    thread_id: thread.id,
    snippet_subject: subject || last.subject?.trim() || "",
    last_message_at: lastAt,
    participants,
    labels,
    quiet_period_ends_at: quietPeriodEndsAt,
    ...(ownerEmail ? { mailbox_owner_email: ownerEmail } : {}),
    ...(bodyAccess === "granted" ? { body_access: "granted" as const } : { body_access: "missing" as const }),
  };
}

async function connect(deps: Required<Pick<GmailDiscoveryDeps, "fetchImpl" | "env" | "fetchTimeoutMs">> & Pick<GmailDiscoveryDeps, "sleep">): Promise<{ connection: GmailConnection; client: GmailClient }> {
  const connection = await resolveGmailConnection({ env: deps.env, fetchImpl: deps.fetchImpl });
  const client = new GmailClient(connection.credential, { fetchImpl: deps.fetchImpl, baseUrl: deps.env.FOO_GMAIL_API_BASE, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
  return { connection, client };
}

// The one bounded model request (R-007): render the thread's text bodies into
// role-labeled lines. The owner is "Mailbox owner"; every other address is
// "Customer". The rendered text exists only inside this function's caller.
function renderThread(thread: { messages: GmailThreadMessage[] }, ownerEmail: string | undefined): string {
  const lines: string[] = [];
  for (const message of thread.messages) {
    const at = message.internal_date ? new Date(Number(message.internal_date)).toISOString().slice(0, 16).replace("T", " ") : "unknown date";
    const role = ownerEmail && message.from?.email?.toLowerCase() === ownerEmail.toLowerCase() ? "Mailbox owner" : "Customer";
    const body = message.body_text?.trim() || "(no text/plain part in this message)";
    lines.push(`[${at}] ${role}: ${body.replaceAll(/\s+/g, " ").trim()}`);
  }
  return lines.join("\n");
}

function containsIdentity(envelopeText: string, identities: string[]): boolean {
  const haystack = envelopeText.toLowerCase();
  return identities.some((identity) => identity.length >= 4 && haystack.includes(identity.toLowerCase()));
}

async function readyCommand(_root: string, json: boolean, deps: Required<GmailDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "gmail",
    mode: MODE,
    support_state: SUPPORT_STATE,
    // R-010: the mailbox is personal even at work — ownership is reported
    // honestly, never emulated as workspace access.
    connection_owner: "user",
    configured: gmailConnectionConfigured(env),
    credential_broker: gmailCredentialBroker(env),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...GMAIL_POLICY },
  };
  try {
    const { connection, client } = await connect(deps);
    // The readiness probe is one profile call: it proves the credential and
    // reports the mailbox identity this connection owns, without listing —
    // a label-less threads.list would be a mailbox-wide read (R-004).
    const profile = await client.profile();
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.credential_type = connection.credential_type;
    coverage.body_scope = connection.body_scope;
    coverage.capabilities = { list_sessions: "pending_approved_scope", open_bodies: connection.body_scope === "granted", stable_link: false, timestamps: false, link_form: "none declared in V0 (R-006)" };
    coverage.provider_calls = client.requests;
    return outcome(result("ok", { coverage, next_actions: [
      "Approve a bounded Gmail scope (explicit labels, a time window, and a customer selector), then run foo discovery gmail list <inbox:scope-id>.",
      ...(connection.body_scope !== "granted" ? ["The connection lacks gmail.readonly: listing works, but process reports needs_provider_access until the least-privilege body scope is granted."] : []),
      ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a thread."] : []),
    ] }), json);
  } catch (error) {
    if (error instanceof GmailRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Gmail readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<GmailDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery gmail list <inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = gmailTarget(root, targetId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = { mode: MODE, window: target.window, lane: target.lane, labels: target.labels.length, bodies_opened: false };
  try {
    const { connection, client } = await connect(deps);
    coverage.connection = connection.connection_ref;
    coverage.body_scope = connection.body_scope;
    const profile = await client.profile();
    const quietPeriodEndsAt = quietPeriodBoundary(target.window.to, GMAIL_POLICY.quiet_period_hours);
    const listing = await client.listThreads({ label_ids: target.labels, from: target.window.from, to: target.window.to });
    // A ceiling stop is final for the run (R-004): no further provider reads
    // happen — the run waits for a window that fits the agreed pages, never
    // for a wider one.
    if (listing.truncated) {
      return outcome(result("budget_exhausted", {
        study_id: targetId,
        coverage: { ...coverage, provider_error: "budget_exhausted", threads_listed: listing.threads.length, pages: listing.pages },
        errors: [{ code: "E_DISCOVERY_VALIDATION", message: `The window holds more threads than the ${GMAIL_POLICY.max_list_pages}-page ceiling; narrow the window or selectors instead of widening the read.` }],
        handoff: "Narrow the approved window or selectors and list again; the run never widens the window and never retries.",
      }), json);
    }
    const sessions: DiscoverySession[] = [];
    let internalExcluded = 0;
    let incomplete = 0;
    for (const ref of listing.threads) {
      // Header-only reads (format=metadata): the listing never opens a body.
      const thread = await client.threadMetadata(ref.id);
      const record = toRecord(thread, profile.email, connection.body_scope, quietPeriodEndsAt);
      if (!record) {
        incomplete += 1;
        continue;
      }
      if (gmailInternalOnly(record)) {
        internalExcluded += 1;
        continue;
      }
      // D-001: only settled threads are evidence; the quiet-period boundary
      // and the done-label override are applied by the adapter.
      if (gmailThreadAdmissibility(record) !== "completed") {
        incomplete += 1;
        continue;
      }
      sessions.push({ ...gmailDiscoveryAdapter.normalizeSession(record, target.connection_alias), access: "available" });
    }
    Object.assign(coverage, { threads_listed: listing.threads.length, pages: listing.pages, internal_only_excluded: internalExcluded, incomplete_excluded: incomplete, candidates_evaluated: sessions.length, provider_calls: client.requests });
    if (sessions.length === 0) return outcome(result("awaiting_match", { study_id: targetId, coverage, next_actions: ["No settled thread with an external participant was listed inside the approved scope."] }), json);
    // One session at a time so each source gets its own one-time proof.
    let lastMiss: DiscoveryCommandResult | null = null;
    let evaluated = 0;
    for (const session of sessions) {
      evaluated += 1;
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify([session]), now);
      if (matched.result.status === "awaiting_match") {
        lastMiss = matched.result;
        continue;
      }
      // R-008: the shared gate refuses a session that cannot open its
      // transcript generically (needs_provider_connector); for Gmail the actual
      // cause is observable — a missing body scope is an access problem, not a
      // connector one. The match state the shared command already wrote stays
      // intact: degrade to needs_provider_access with the honest handoff,
      // preserving the metadata and the match.
      if (matched.result.status === "needs_provider_connector" && connection.body_scope !== "granted") {
        return outcome(result("needs_provider_access", {
          study_id: targetId,
          errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: "The Gmail connection lacks the gmail.readonly scope; the thread's metadata matched, but its body cannot be opened." }],
          handoff: "Grant the least-privilege read scope (gmail.readonly) on the connection in Nango, then rerun foo discovery gmail process.",
          coverage: { ...matched.result.coverage, ...coverage, candidates_evaluated: evaluated, candidates_remaining: sessions.length - evaluated },
        }), json);
      }
      const remaining = sessions.length - evaluated;
      return outcome({
        ...matched.result,
        coverage: { ...matched.result.coverage, ...coverage, candidates_evaluated: evaluated, candidates_remaining: remaining },
        next_actions: [
          ...matched.result.next_actions,
          ...(matched.result.status === "ok" ? [`Run foo discovery gmail process ${targetId} to open this one thread and apply the sanitized evidence.`] : []),
          ...(remaining > 0 ? [`${remaining} more listed thread(s) were not evaluated; run list again after this one is processed.`] : []),
        ],
      }, json);
    }
    return outcome(result("awaiting_match", { study_id: targetId, coverage: { ...coverage, candidates_evaluated: evaluated }, next_actions: lastMiss?.next_actions ?? ["No listed thread matched the approved scope; nothing was opened."] }), json);
  } catch (error) {
    if (error instanceof GmailRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    return invalid("Gmail listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

type MatchFile = { schema_version: "0.1"; candidates: Array<{ candidate_index: number; source_fingerprint: string; session: DiscoverySession }> };

function readMatch(root: string, targetId: string): MatchFile | null {
  const file = path.join(localRoot(root), localTargetName(targetId), "match.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as MatchFile;
  } catch {
    return null;
  }
}

async function processCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<GmailDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery gmail process <inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = gmailTarget(root, targetId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const match = readMatch(root, targetId);
  if (!match || !Array.isArray(match.candidates) || match.candidates.length === 0) return invalid("No matched Gmail thread is recorded for this target; run foo discovery gmail list first.", json, "E_DISCOVERY_VALIDATION", targetId);
  if (match.candidates.length > 1) return outcome(result("ambiguous_match", { study_id: targetId, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several threads matched; a person must select one before any thread is opened." }], handoff: `foo discovery review ${targetId} select-source --fingerprint <sha256> --by <person>` }), json);
  const candidate = match.candidates[0];
  const session = candidate.session;
  const threadId = session.runtime_handle;
  if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the thread was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
  const model = defaultSynthesisModel(deps.env);
  const coverage: Record<string, unknown> = { mode: MODE, lane: target.lane, policy_version: GMAIL_POLICY.policy_version, model, bodies_opened: false };
  let client: GmailClient | undefined;
  try {
    const connected = await connect(deps);
    client = connected.client;
    coverage.connection = connected.connection.connection_ref;
    if (connected.connection.body_scope !== "granted") {
      // R-008: a missing body scope degrades reads to needs_provider_access
      // while metadata and the matching state stay intact.
      return outcome(result("needs_provider_access", { study_id: targetId, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: "The Gmail connection lacks the gmail.readonly scope; the thread was not opened." }], handoff: "Grant the least-privilege read scope (gmail.readonly) on the connection in Nango, then rerun process.", coverage }), json);
    }
    const profile = await client.profile();
    const identities: string[] = [];
    for (const participant of [profile.email, ...(session.participants ?? [])]) {
      if (participant?.trim()) identities.push(participant.trim());
    }
    let openError: GmailRuntimeError | undefined;
    let threadText: string;
    try {
      threadText = await openAuthorizedTranscript(
        { study_dir: target.dir, local_root: localRoot(root), study_id: targetId, source_fingerprint: candidate.source_fingerprint, now },
        async () => {
          try {
            // R-007: exactly one thread identifier, read under the minted proof.
            return await client!.thread(threadId).then((thread) => renderThread(thread, profile.email));
          } catch (error) {
            if (error instanceof GmailRuntimeError) openError = error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, thread_body_requests: client.requests.thread });
      return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The thread was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery gmail list ${targetId} again to re-match and mint a fresh proof.` }), json);
    }
    coverage.thread_body_requests = client.requests.thread;
    const estimatedTokens = Math.ceil(threadText.length / 4);
    if (estimatedTokens > GMAIL_POLICY.max_model_input_tokens) {
      return fromRuntimeError(new GmailRuntimeError("thread_too_large", "the thread exceeds the model-input ceiling; nothing was synthesized"), json, targetId, coverage);
    }
    let synthesized;
    try {
      synthesized = await synthesizeDiscoveryEnvelope(
        {
          target_id: targetId,
          lane: target.lane,
          source: { provider: "gmail", source_fingerprint: candidate.source_fingerprint, completed_at: session.completed_at, locator_capability: "none" },
          title: session.title,
          hypotheses: [],
          // The thread's text body is the "transcript" here: role-labeled,
          // screen-then-discard, never quoted verbatim by the model.
          transcript_text: threadText,
          transcript_complete: true,
          caveats: ["Gmail declares no stable link form in V0 (R-006): the thread is identified by its matched fingerprint only.", "Attachments were never opened (D-003)."],
        },
        { model, transport: deps.transport },
      );
    } catch {
      // R-007: the thread text is discarded with this frame — it never
      // reaches disk, a log, or an error surface, even when synthesis throws.
      return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the thread was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    }
    coverage.synthesis_usage = synthesized.usage ?? null;
    // Privacy screen beyond the envelope validator: the mailbox owner's
    // address and the thread's own participant labels must not appear in
    // derived text.
    const derivedText = [
      ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
      ...synthesized.envelope.coverage.caveats,
    ].join("\n");
    if (containsIdentity(derivedText, identities)) return invalid("Synthesis leaked a participant identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(synthesized.envelope), now);
    return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
  } catch (error) {
    if (error instanceof GmailRuntimeError) return fromRuntimeError(error, json, targetId, { ...coverage, thread_body_requests: client?.requests.thread ?? 0 });
    return invalid("Gmail processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function syncCommand(root: string, json: boolean, deps: Required<GmailDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const now = deps.now();
  const plan = planDiscoverySync(root, now);
  const lanes = plan.lanes.filter((lane) => lane.provider.toLowerCase() === "gmail");
  if (lanes.length === 0) return outcome(result("clean_no_op", { errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })), next_actions: ["No approved Gmail lane is active; approve an inbox scope naming explicit labels first."], coverage: { mode: MODE, lanes: 0, connector_reads: 0 } }), json);
  const results: Array<{ lane_id: string; status: DiscoveryCommandStatus; handoff: string | null }> = [];
  // Metadata and match only: a thread body is opened only by an explicit
  // `process` on one target. The loop stays unarmed (R-007/V-010).
  for (const lane of lanes) {
    const targetId = `inbox:${lane.scope_id}`;
    const listed = await listCommand(root, targetId, true, deps);
    results.push({ lane_id: lane.lane_id, status: listed.result.status, handoff: listed.result.handoff });
  }
  const ready = results.filter((entry) => entry.status === "ok").map((entry) => entry.lane_id);
  return outcome(result("ok", {
    errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })),
    next_actions: [
      ...ready.map((laneId) => `${laneId}: one thread matched — run foo discovery gmail process ${laneId} to open it.`),
      ...results.filter((entry) => entry.status !== "ok").map((entry) => `${entry.lane_id}: ${entry.status}${entry.handoff ? ` — ${entry.handoff}` : ""}`),
    ],
    coverage: { mode: MODE, lanes: results.length, threads_opened: 0, results },
  }), json);
}

export async function runGmailDiscovery(root: string, args: string[], deps: GmailDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved: Required<GmailDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env }),
    fetchTimeoutMs: deps.fetchTimeoutMs ?? GMAIL_POLICY.fetch_timeout_ms,
  };
  const command = args[0];
  const target = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  try {
    if (command === "ready") return await readyCommand(root, json, resolved);
    if (command === "list") return await listCommand(root, target, json, resolved);
    if (command === "process") return await processCommand(root, target, json, resolved);
    if (command === "sync") return await syncCommand(root, json, resolved);
    return invalid("Try: ready | list <inbox:scope-id> | process <inbox:scope-id> | sync", json);
  } catch {
    return invalid("Gmail discovery failed closed without exposing private source content.", json);
  }
}
