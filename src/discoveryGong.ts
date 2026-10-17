// `foo discovery gong …` — the local worker for a company Gong connection
// (gong-discovery-connector-v0, D-010 local worker mode).
//
// This is the runtime adapter the discovery core was designed to be driven by:
// it lists bounded call metadata inside an approved study or inbox scope,
// normalizes it through the Gong adapter, hands the closed session shape to
// `foo discovery match`, opens exactly one proof-authorized transcript into
// process memory, synthesizes the sanitized envelope in one model request,
// and hands the envelope to `foo discovery apply`. The transcript never
// reaches argv, stdin, a file, Git, a log, an error, or the host agent's
// context; every surface this module writes is content-free.
//
// What it is not: the hosted, cross-host service the Nango discovery packet
// specifies. Ownership isolation between workspace members, signed service
// receipts, and remote hosts wait for that service. This worker runs where the
// repository working tree is, with the company credential brokered by Nango.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasFlag } from "./cliArgs.js";
import { loadDiscoveryRun, type DiscoveryLifecycle } from "./discoveryArtifacts.js";
import {
  discoveryTargetDir,
  gongScopeValidationError,
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
import { gongDiscoveryAdapter, type GongCallRecord } from "./discoveryProviders.js";
import type { DiscoverySession } from "./discoverySources.js";
import { planDiscoverySync } from "./discoverySync.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { GONG_POLICY, GongClient, GongRuntimeError, gongConnectionConfigured, gongCredentialBroker, resolveGongConnection, type FetchLike, type GongConnection, type GongParty } from "./gongNango.js";

export type GongDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
  // Fixture seam only: narrows the provider fetch ceiling so a test can
  // observe a timeout instead of waiting out GONG_POLICY.fetch_timeout_ms.
  fetchTimeoutMs?: number;
};

const MATCHABLE_STUDY_STATES = new Set<DiscoveryLifecycle>(["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"]);
const DEFAULT_LOOKBACK_DAYS = 14;
const SUPPORT_STATE = "contract_only";
const MODE = "local_worker";

type Target = {
  target_id: string;
  lane: DiscoveryLane;
  dir: string;
  connection_alias: string;
  window: { from: string; to: string };
  workspace?: string;
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
  const lines = [`Discovery (gong): ${value.status}.`];
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
function fromRuntimeError(error: GongRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect the company Gong account through Nango and set NANGO_SECRET_KEY and FOO_GONG_NANGO_CONNECTION (plus NANGO_HOST / FOO_GONG_NANGO_INTEGRATION when they differ from the defaults); or, for this runtime only, set FOO_GONG_ACCESS_KEY and FOO_GONG_ACCESS_KEY_SECRET from an administrator-issued Gong access key." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Ask the Gong administrator to refresh the connection or grant the read permission, then rerun." }), json);
    case "budget_exhausted":
      // A rate-limit stop is the quota half of R-004: the run ends, nothing
      // widens, nothing retries. The next run needs a narrower window.
      return outcome(result("budget_exhausted", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: "The agreed page or quota ceiling stopped this run; narrow the window or selectors and rerun — productfoo never widens the window or auto-retries." }), json);
    default:
      return outcome(result("invalid", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: error.code === "transcript_too_large" || error.code === "provider_timeout" ? "Nothing was written and no retry was attempted; a new attempt needs a fresh match." : null }), json);
  }
}

function isoDaysAgo(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

function loadTarget(root: string, targetId: string, env: NodeJS.ProcessEnv, now: string, phase: "list" | "process" = "list"): Target {
  if (isInboxTarget(targetId)) {
    const scope = inboxScope(root, targetId);
    if (scope.provider.toLowerCase() !== "gong") throw new Error("this inbox scope is not a Gong scope");
    if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
    // R-004: validation is pre-flight — an invalid scope never reaches the
    // provider. The workspace env selector (set below) is narrowing only and
    // never counts toward the selector minimum.
    const scopeError = gongScopeValidationError({
      window: scope.time_window,
      named_external_participants: scope.participant_allowlist,
      external_companies_or_domains: scope.domain_allowlist,
      title_tokens: scope.title_tokens,
      call_owners: scope.call_owners,
    });
    if (scopeError) throw new Error(scopeError);
    const from = new Date(scope.time_window.start);
    const to = new Date(scope.time_window.end);
    return { target_id: targetId, lane: "unassigned_call_evidence", dir: discoveryTargetDir(root, targetId), connection_alias: scope.connection_alias, window: { from: from.toISOString(), to: to.toISOString() }, workspace: env.FOO_GONG_WORKSPACE?.trim() || undefined };
  }
  const dir = discoveryTargetDir(root, targetId);
  const run = loadDiscoveryRun(dir);
  if (run.source.provider.toLowerCase() !== "gong") throw new Error("this study is not a Gong study");
  // Listing needs a matchable study; processing needs the state `match` left
  // behind (ready_to_synthesize) — the proof check decides the rest.
  const allowed = phase === "process" ? run.state === "ready_to_synthesize" || MATCHABLE_STUDY_STATES.has(run.state) : MATCHABLE_STUDY_STATES.has(run.state);
  if (!allowed) throw new Error(`study ${targetId} is not ready for provider reads (state ${run.state})`);
  let from: string;
  let to: string;
  if (run.match.expected_local_date) {
    const day = Date.parse(`${run.match.expected_local_date}T00:00:00Z`);
    if (!Number.isFinite(day)) throw new Error("the study's expected date is invalid");
    from = new Date(day - 86_400_000).toISOString();
    to = new Date(day + 2 * 86_400_000).toISOString();
  } else {
    const lookback = Number(env.FOO_GONG_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
    if (!Number.isFinite(lookback) || lookback <= 0 || lookback > 90) throw new Error("FOO_GONG_LOOKBACK_DAYS must be between 1 and 90");
    from = isoDaysAgo(now, lookback);
    to = now;
  }
  // R-004 applies to study scopes too: a gong study names its customer — the
  // study target is the named external participant or company, and the match
  // constraints narrow further. A study with neither is invalid.
  const selectorError = gongScopeValidationError({
    window: { start: from, end: to },
    named_external_participants: [...(run.match?.required_participants ?? []), ...(run.target?.name?.trim() ? [run.target.name.trim()] : [])],
    external_companies_or_domains: run.target?.organization?.trim() ? [run.target.organization.trim()] : [],
    title_tokens: run.match?.required_title_tokens ?? [],
  });
  if (selectorError) throw new Error(selectorError);
  return { target_id: targetId, lane: "study_linked", dir, connection_alias: run.source.connection_alias, window: { from, to }, workspace: env.FOO_GONG_WORKSPACE?.trim() || undefined };
}

function toRecord(call: { id: string; title?: string; url?: string; started?: string; scheduled?: string; duration?: number }, parties: GongParty[] | undefined, transcriptScope: GongConnection["transcript_scope"]): GongCallRecord | null {
  const started = call.started ?? call.scheduled;
  if (!started) return null;
  return {
    id: call.id,
    title: call.title?.trim() || "Untitled call",
    started,
    duration_seconds: call.duration,
    // A listed Gong call is a recorded, processed call; a zero-length record
    // is not a completed conversation.
    state: (call.duration ?? 0) > 0 ? "completed" : "in_progress",
    url: call.url,
    parties: (parties ?? []).map((party) => ({ name: party.name, email: party.emailAddress, title: party.title, affiliation: party.affiliation, speaker_id: party.speakerId })),
    transcript_access: transcriptScope === "missing" ? "missing" : "granted",
  };
}

// R-004: a call with no external party is the company talking to itself and
// is excluded by default. A call whose party data is absent stays in — the
// scope's own selectors still have to admit it.
function internalOnly(parties: GongParty[] | undefined): boolean {
  if (!parties || parties.length === 0) return false;
  return parties.every((party) => party.affiliation?.trim().toLowerCase() === "internal");
}

async function connect(deps: Required<Pick<GongDiscoveryDeps, "fetchImpl" | "env" | "fetchTimeoutMs">> & Pick<GongDiscoveryDeps, "sleep">): Promise<{ connection: GongConnection; client: GongClient }> {
  const connection = await resolveGongConnection({ env: deps.env, fetchImpl: deps.fetchImpl });
  const client = new GongClient(connection.credential, { fetchImpl: deps.fetchImpl, baseUrl: deps.env.FOO_GONG_API_BASE, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
  return { connection, client };
}

async function listSessions(target: Target, connection: GongConnection, client: GongClient): Promise<{ sessions: DiscoverySession[]; listed: number; pages: number; truncated: boolean; internal_only_excluded: number; incomplete: number }> {
  const listing = await client.listCalls({ from: target.window.from, to: target.window.to, workspaceId: target.workspace });
  // A ceiling stop is final for the run (R-004/R-010): no further provider
  // reads happen — the parties read waits for a window that fits the agreed
  // pages, never for a wider one.
  if (listing.truncated) return { sessions: [], listed: listing.calls.length, pages: listing.pages, truncated: true, internal_only_excluded: 0, incomplete: 0 };
  const parties = listing.calls.length ? await client.parties(listing.calls.map((call) => call.id)) : new Map<string, GongParty[]>();
  const sessions: DiscoverySession[] = [];
  let internalExcluded = 0;
  let incomplete = 0;
  for (const call of listing.calls) {
    const own = parties.get(call.id);
    if (internalOnly(own)) {
      internalExcluded += 1;
      continue;
    }
    const record = toRecord(call, own, connection.transcript_scope);
    if (!record) {
      incomplete += 1;
      continue;
    }
    const session = gongDiscoveryAdapter.normalizeSession(record, target.connection_alias);
    if (session.completion_state !== "completed") {
      incomplete += 1;
      continue;
    }
    sessions.push({ ...session, access: connection.transcript_scope === "missing" ? "denied" : "available" });
  }
  return { sessions, listed: listing.calls.length, pages: listing.pages, truncated: listing.truncated, internal_only_excluded: internalExcluded, incomplete };
}

async function readyCommand(root: string, json: boolean, deps: Required<GongDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "gong",
    mode: MODE,
    support_state: SUPPORT_STATE,
    connection_owner: "workspace",
    configured: gongConnectionConfigured(env),
    credential_broker: gongCredentialBroker(env),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...GONG_POLICY },
  };
  try {
    const { connection, client } = await connect(deps);
    // The readiness probe is one metadata call inside a one-hour window: it
    // proves the credential and the listing permission without reading calls.
    const now = deps.now();
    await client.listCalls({ from: isoDaysAgo(now, 1 / 24), to: now, workspaceId: env.FOO_GONG_WORKSPACE?.trim() || undefined });
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.credential_type = connection.credential_type;
    coverage.capabilities = { list_sessions: true, open_transcript: connection.transcript_scope !== "missing", stable_link: true, timestamps: true, transcript_scope: connection.transcript_scope };
    coverage.provider_calls = client.requests;
    return outcome(result("ok", { coverage, next_actions: [
      ...(connection.broker === "direct" ? ["Credential broker is direct: this runtime holds an administrator-issued access key itself. Refresh and revoke happen in Gong, not centrally; move to Nango for the company connection."] : []),
      "Approve a bounded Gong scope, then run foo discovery gong list <study-id|inbox:scope-id>.", ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a transcript."] : [])] }), json);
  } catch (error) {
    if (error instanceof GongRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Gong readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<GongDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery gong list <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = { mode: MODE, window: target.window, lane: target.lane, transcript_opened: false };
  try {
    const { connection, client } = await connect(deps);
    coverage.connection = connection.connection_ref;
    const listed = await listSessions(target, connection, client);
    Object.assign(coverage, { calls_listed: listed.listed, pages: listed.pages, truncated: listed.truncated, internal_only_excluded: listed.internal_only_excluded, incomplete_excluded: listed.incomplete, candidates_evaluated: listed.sessions.length, provider_calls: client.requests });
    if (listed.truncated) {
      return outcome(result("budget_exhausted", {
        study_id: targetId,
        coverage: { ...coverage, provider_error: "budget_exhausted" },
        errors: [{ code: "E_DISCOVERY_VALIDATION", message: `The window holds more calls than the ${GONG_POLICY.max_list_pages}-page ceiling; narrow the window or selectors instead of widening the read.` }],
        handoff: "Narrow the approved window or selectors and list again; the run never widens the window and never retries.",
      }), json);
    }
    if (listed.sessions.length === 0) return outcome(result("awaiting_match", { study_id: targetId, coverage, next_actions: ["No completed call with an external party was listed inside the approved window."] }), json);
    if (target.lane === "study_linked") {
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify(listed.sessions), now);
      return outcome({ ...matched.result, coverage: { ...matched.result.coverage, ...coverage }, next_actions: [...matched.result.next_actions, ...(matched.result.status === "ok" ? [`Run foo discovery gong process ${targetId} to open the one matched transcript and apply the sanitized evidence.`] : [])] }, json);
    }
    // Inbox: one session at a time so each source gets its own one-time proof.
    let lastMiss: DiscoveryCommandResult | null = null;
    let evaluated = 0;
    for (const session of listed.sessions) {
      evaluated += 1;
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify([session]), now);
      if (matched.result.status === "awaiting_match") {
        lastMiss = matched.result;
        continue;
      }
      const remaining = listed.sessions.length - evaluated;
      return outcome({
        ...matched.result,
        coverage: { ...matched.result.coverage, ...coverage, candidates_evaluated: evaluated, candidates_remaining: remaining },
        next_actions: [
          ...matched.result.next_actions,
          ...(matched.result.status === "ok" ? [`Run foo discovery gong process ${targetId} to open this one transcript and apply the sanitized evidence.`] : []),
          ...(remaining > 0 ? [`${remaining} more listed call(s) were not evaluated; run list again after this one is processed.`] : []),
        ],
      }, json);
    }
    return outcome(result("awaiting_match", { study_id: targetId, coverage: { ...coverage, candidates_evaluated: evaluated }, next_actions: lastMiss?.next_actions ?? ["No listed call matched the approved scope; nothing was opened."] }), json);
  } catch (error) {
    if (error instanceof GongRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    return invalid("Gong listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
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

function studyHypotheses(dir: string): Array<{ id: string; text: string }> {
  const file = path.join(dir, "study.md");
  if (!existsSync(file)) return [];
  const out: Array<{ id: string; text: string }> = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:[-*]|\d+\.)?\s*\**(H-\d{3})\**\s*[:—–-]?\s*(.+?)\s*$/.exec(line);
    if (match && !out.some((entry) => entry.id === match[1])) out.push({ id: match[1], text: match[2] });
  }
  return out;
}

function mmss(ms: number | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Role labels only: the speaker map is used inside this request to say who is
// the customer and who is the company, and the names never enter the text.
function renderTranscript(monologues: Array<{ speakerId?: string; sentences: Array<{ start?: number; end?: number; text: string }> }>, roles: Map<string, string>): string {
  const lines: string[] = [];
  for (const monologue of monologues) {
    const role = (monologue.speakerId && roles.get(monologue.speakerId)) || "Unknown speaker";
    for (const sentence of monologue.sentences) lines.push(`[${mmss(sentence.start)}] ${role}: ${sentence.text}`);
  }
  return lines.join("\n");
}

function containsIdentity(envelopeText: string, identities: string[]): boolean {
  const haystack = envelopeText.toLowerCase();
  return identities.some((identity) => identity.length >= 4 && haystack.includes(identity.toLowerCase()));
}

async function processCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<GongDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery gong process <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now, "process");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const match = readMatch(root, targetId);
  if (!match || !Array.isArray(match.candidates) || match.candidates.length === 0) return invalid("No matched Gong call is recorded for this target; run foo discovery gong list first.", json, "E_DISCOVERY_VALIDATION", targetId);
  if (match.candidates.length > 1) return outcome(result("ambiguous_match", { study_id: targetId, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several calls matched; a person must select one before any transcript is opened." }], handoff: `foo discovery review ${targetId} select-source --fingerprint <sha256> --by <person>` }), json);
  const candidate = match.candidates[0];
  const session = candidate.session;
  const callId = session.runtime_handle;
  if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the transcript was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
  const model = defaultSynthesisModel(deps.env);
  const coverage: Record<string, unknown> = { mode: MODE, lane: target.lane, policy_version: GONG_POLICY.policy_version, model };
  const hypotheses = target.lane === "study_linked" ? studyHypotheses(target.dir) : [];
  if (target.lane === "study_linked" && hypotheses.length === 0) return invalid("The study records no H-### hypotheses in study.md; study-linked evidence needs one to test.", json, "E_DISCOVERY_VALIDATION", targetId);
  let client: GongClient | undefined;
  try {
    const connected = await connect(deps);
    client = connected.client;
    coverage.connection = connected.connection.connection_ref;
    if (connected.connection.transcript_scope === "missing") {
      return outcome(result("needs_provider_access", { study_id: targetId, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: "The Gong credential has no transcript permission; the call was not opened." }], handoff: session.stable_url ? `Request transcript access for ${session.stable_url}` : "Request transcript access from the Gong administrator.", coverage }), json);
    }
    const parties = (await client.parties([callId])).get(callId) ?? [];
    const roles = new Map<string, string>();
    const identities: string[] = [];
    for (const party of parties) {
      if (party.speakerId) roles.set(party.speakerId, party.affiliation?.trim().toLowerCase() === "internal" ? "Company representative" : "Customer");
      if (party.name?.trim()) identities.push(party.name.trim());
      if (party.emailAddress?.trim()) identities.push(party.emailAddress.trim());
    }
    let openError: GongRuntimeError | undefined;
    let transcriptText: string | null;
    try {
      const monologues = await openAuthorizedTranscript(
        { study_dir: target.dir, local_root: localRoot(root), study_id: targetId, source_fingerprint: candidate.source_fingerprint, now },
        async () => {
          try {
            return await client!.transcript(callId);
          } catch (error) {
            if (error instanceof GongRuntimeError) openError = error;
            throw error;
          }
        },
      );
      transcriptText = renderTranscript(monologues, roles);
    } catch (error) {
      if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, transcript_body_requests: client.requests.transcript });
      return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The transcript was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery gong list ${targetId} again to re-match and mint a fresh proof.`, coverage }), json);
    }
    coverage.transcript_body_requests = client.requests.transcript;
    const estimatedTokens = Math.ceil(transcriptText.length / 4);
    if (estimatedTokens > GONG_POLICY.max_model_input_tokens) {
      transcriptText = null;
      return fromRuntimeError(new GongRuntimeError("transcript_too_large", "the transcript exceeds the model-input ceiling; nothing was synthesized"), json, targetId, coverage);
    }
    let synthesized;
    try {
      synthesized = await synthesizeDiscoveryEnvelope(
        {
          target_id: targetId,
          lane: target.lane,
          source: { provider: "gong", ...(session.stable_url ? { stable_url: session.stable_url } : {}), source_fingerprint: candidate.source_fingerprint, completed_at: session.completed_at, locator_capability: session.capabilities.timestamps ? "timestamp" : "none" },
          title: session.title,
          hypotheses,
          transcript_text: transcriptText,
          transcript_complete: true,
          caveats: session.stable_url ? [] : ["The provider returned no canonical call link for this call."],
        },
        { model, transport: deps.transport },
      );
    } catch {
      return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the transcript was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    } finally {
      transcriptText = null;
    }
    coverage.synthesis_usage = synthesized.usage ?? null;
    // Privacy screen beyond the envelope validator: party names and addresses
    // from the provider's own metadata must not appear in derived text.
    const derivedText = [
      ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
      ...synthesized.envelope.coverage.caveats,
    ].join("\n");
    if (containsIdentity(derivedText, identities)) return invalid("Synthesis leaked a participant identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(synthesized.envelope), now);
    return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
  } catch (error) {
    if (error instanceof GongRuntimeError) return fromRuntimeError(error, json, targetId, { ...coverage, transcript_body_requests: client?.requests.transcript ?? 0 });
    return invalid("Gong processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function syncCommand(root: string, json: boolean, deps: Required<GongDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const now = deps.now();
  const plan = planDiscoverySync(root, now);
  const lanes = plan.lanes.filter((lane) => lane.provider.toLowerCase() === "gong");
  if (lanes.length === 0) return outcome(result("clean_no_op", { errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })), next_actions: ["No approved Gong lane is active; approve a study source or an inbox scope first."], coverage: { mode: MODE, lanes: 0, connector_reads: 0 } }), json);
  const results: Array<{ lane_id: string; status: DiscoveryCommandStatus; handoff: string | null }> = [];
  // Metadata and match only: a transcript is opened only by an explicit
  // `process` on one target. The loop stays unarmed (R-010).
  for (const lane of lanes) {
    const targetId = lane.kind === "inbox" ? `inbox:${lane.scope_id}` : lane.study_id!;
    const listed = await listCommand(root, targetId, true, deps);
    results.push({ lane_id: lane.lane_id, status: listed.result.status, handoff: listed.result.handoff });
  }
  const ready = results.filter((entry) => entry.status === "ok").map((entry) => entry.lane_id);
  return outcome(result("ok", {
    errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })),
    next_actions: [
      ...ready.map((laneId) => `${laneId}: one call matched — run foo discovery gong process ${laneId.replace(/^study:/, "")} to open it.`),
      ...results.filter((entry) => entry.status !== "ok").map((entry) => `${entry.lane_id}: ${entry.status}${entry.handoff ? ` — ${entry.handoff}` : ""}`),
    ],
    coverage: { mode: MODE, lanes: results.length, transcripts_opened: 0, results },
  }), json);
}

export async function runGongDiscovery(root: string, args: string[], deps: GongDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved: Required<GongDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env }),
    fetchTimeoutMs: deps.fetchTimeoutMs ?? GONG_POLICY.fetch_timeout_ms,
  };
  const command = args[0];
  const target = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  try {
    if (command === "ready") return await readyCommand(root, json, resolved);
    if (command === "list") return await listCommand(root, target, json, resolved);
    if (command === "process") return await processCommand(root, target, json, resolved);
    if (command === "sync") return await syncCommand(root, json, resolved);
    return invalid("Try: ready | list <study-id|inbox:scope-id> | process <study-id|inbox:scope-id> | sync", json);
  } catch {
    return invalid("Gong discovery failed closed without exposing private source content.", json);

  }
}

