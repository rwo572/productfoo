// `foo discovery teams …` — the local worker for a tenant-owned Microsoft
// Teams connection (microsoft-teams-discovery-connector-v0, T-006 local
// worker mode; the gong worker port with Graph deltas, R-011).
//
// This is the runtime adapter the discovery core was designed to be driven by:
// it lists bounded meeting metadata inside an approved study or inbox scope,
// normalizes it through the Teams adapter, hands the closed session shape to
// `foo discovery match`, opens exactly one proof-authorized transcript into
// process memory, synthesizes the sanitized envelope in one model request,
// and hands the envelope to `foo discovery apply`. The transcript never
// reaches argv, stdin, a file, Git, a log, an error, or the host agent's
// context; every surface this module writes is content-free.
//
// Graph deltas from the gong worker (D-001): the connection is tenant-owned
// through Nango only (R-002 — no direct-credential fallback), listing filters
// what the approved scope selects with internal-only meetings excluded by
// default (the contracts pin `include_internal_only: false`), and the
// transcript is observed per meeting through its transcript metadata before
// the single content read (R-005/R-007). Support state is `contract_only`
// until the feasibility task (T-001) and the dogfood run (T-008) produce
// receipt-backed evidence.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasFlag } from "./cliArgs.js";
import { loadDiscoveryRun, type DiscoveryLifecycle } from "./discoveryArtifacts.js";
import {
  discoveryTargetDir,
  inboxScope,
  isInboxTarget,
  localRoot,
  localTargetName,
  runDiscoveryCommand,
  teamsScopeValidationError,
  type DiscoveryCommandOutcome,
  type DiscoveryCommandResult,
  type DiscoveryCommandStatus,
  type DiscoveryErrorCode,
} from "./discoveryCommand.js";
import type { DiscoveryLane } from "./discoveryEvidence.js";
import { openAuthorizedTranscript } from "./discoveryProof.js";
import { teamsDiscoveryAdapter, type TeamsMeetingRecord } from "./discoveryProviders.js";
import type { DiscoverySession } from "./discoverySources.js";
import { planDiscoverySync } from "./discoverySync.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { resolveTeamsConnection, TEAMS_POLICY, TeamsGraphClient, TeamsRuntimeError, teamsConnectionConfigured, teamsCredentialBroker, type FetchLike, type TeamsConnection, type TeamsListedMeeting } from "./teamsNango.js";

export type TeamsDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
  // Fixture seam only: narrows the provider fetch ceiling so a test can
  // observe a timeout instead of waiting out TEAMS_POLICY.fetch_timeout_ms.
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
  selectors: { named_external_participants: string[]; external_companies_or_domains: string[]; organizers: string[] };
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
  const lines = [`Discovery (teams): ${value.status}.`];
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
function fromRuntimeError(error: TeamsRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "A Microsoft 365 administrator connects the tenant-owned Teams connection through Nango (NANGO_SECRET_KEY and FOO_TEAMS_NANGO_CONNECTION, plus NANGO_HOST / FOO_TEAMS_NANGO_INTEGRATION when they differ from the defaults)." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Ask the Microsoft 365 administrator to refresh the connection or grant the read permission, then rerun." }), json);
    case "no_transcript":
      // Observed absence from the provider's own metadata (R-005): the
      // meeting has no transcript to open — a degraded-capability stop, not
      // an error.
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Request transcript access from the Microsoft 365 administrator." }), json);
    case "budget_exhausted":
      // A throttling stop is final for the run (R-004/R-010): the run ends,
      // nothing widens, nothing retries. The next run needs a narrower window.
      return outcome(result("budget_exhausted", { ...base, errors: [{ code: "E_DISCOVERY_VALIDATION", message: error.message }], handoff: "Graph throttling stopped this run; narrow the window or selectors and rerun — productfoo never widens the window or auto-retries." }), json);
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
    if (scope.provider.toLowerCase() !== "microsoft-teams") throw new Error("this inbox scope is not a Microsoft Teams scope");
    if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
    // R-004: validation is pre-flight — an invalid scope never reaches the
    // provider. The connection alias is narrowing only and never counts
    // toward the selector minimum.
    const scopeError = teamsScopeValidationError({
      window: scope.time_window,
      named_external_participants: scope.participant_allowlist,
      external_companies_or_domains: scope.domain_allowlist,
      organizers: [],
    });
    if (scopeError) throw new Error(scopeError);
    return { target_id: targetId, lane: "unassigned_call_evidence", dir: discoveryTargetDir(root, targetId), connection_alias: scope.connection_alias, window: { from: new Date(scope.time_window.start).toISOString(), to: new Date(scope.time_window.end).toISOString() }, selectors: { named_external_participants: scope.participant_allowlist, external_companies_or_domains: scope.domain_allowlist, organizers: scope.call_owners ?? [] } };
  }
  const dir = discoveryTargetDir(root, targetId);
  const run = loadDiscoveryRun(dir);
  if (run.source.provider.toLowerCase() !== "microsoft-teams") throw new Error("this study is not a Microsoft Teams study");
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
    const lookback = Number(env.FOO_TEAMS_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
    if (!Number.isFinite(lookback) || lookback <= 0 || lookback > 90) throw new Error("FOO_TEAMS_LOOKBACK_DAYS must be between 1 and 90");
    from = isoDaysAgo(now, lookback);
    to = now;
  }
  // R-004 applies to study scopes too: a Teams study names its customer — the
  // study target is the named external participant or company, and the match
  // constraints narrow further. A study with neither is invalid.
  const selectors = {
    named_external_participants: [...(run.match?.required_participants ?? []), ...(run.target?.name?.trim() ? [run.target.name.trim()] : [])],
    external_companies_or_domains: run.target?.organization?.trim() ? [run.target.organization.trim()] : [],
    organizers: [],
  };
  const selectorError = teamsScopeValidationError({ window: { start: from, end: to }, ...selectors });
  if (selectorError) throw new Error(selectorError);
  return { target_id: targetId, lane: "study_linked", dir, connection_alias: run.source.connection_alias, window: { from, to }, selectors };
}

function toRecord(meeting: TeamsListedMeeting): TeamsMeetingRecord | null {
  if (!meeting.start) return null;
  return {
    meeting_id: meeting.id,
    subject: meeting.subject?.trim() || "Untitled meeting",
    start_time: meeting.start,
    ...(meeting.end ? { end_time: meeting.end } : {}),
    ...(meeting.state ? { state: meeting.state } : {}),
    ...(meeting.organizer ? { organizer_display_name: meeting.organizer } : {}),
    // No url: Teams has no approved stable-link form yet, so joinWebUrl is
    // dropped at the worker boundary rather than handed to the adapter, which
    // refuses every undeclared link (R-006). Canonical links stay absent until
    // feasibility verifies one (T-001).
  };
}

// R-004: listing is bounded by the approved window and internal-only meetings
// are excluded by default. Classification is observed, not assumed: the
// attendance report — the Teams analog of the gong parties read (R-005) — is
// metadata for every listed meeting, and a meeting is internal-only only when
// its attendees are observed and every attendee's email domain is the tenant's
// own. A meeting whose attendee data is absent stays in (absent data is not
// evidence of internal-only) — the match step still narrows, and scope
// selectors keep validating the read before any request is made.
function internalOnly(attendees: Array<{ email?: string }>, tenantDomain: string | null): boolean {
  if (!tenantDomain || attendees.length === 0) return false;
  return attendees.every((attendee) => (attendee.email ?? "").trim().toLowerCase().endsWith(`@${tenantDomain}`));
}

async function connect(deps: Required<Pick<TeamsDiscoveryDeps, "fetchImpl" | "env" | "fetchTimeoutMs">> & Pick<TeamsDiscoveryDeps, "sleep">): Promise<{ connection: TeamsConnection; client: TeamsGraphClient }> {
  const connection = await resolveTeamsConnection({ env: deps.env, fetchImpl: deps.fetchImpl });
  const client = new TeamsGraphClient(connection.credential, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
  return { connection, client };
}

async function listSessions(target: Target, connection: TeamsConnection, client: TeamsGraphClient): Promise<{ sessions: DiscoverySession[]; listed: number; pages: number; truncated: boolean; internal_only_excluded: number; incomplete: number }> {
  const listing = await client.listMeetings({ from: target.window.from, to: target.window.to });
  // A ceiling stop is final for the run (R-004/R-010): no further provider
  // reads happen — the next run needs a narrower window, never a wider one.
  if (listing.truncated) return { sessions: [], listed: listing.meetings.length, pages: listing.pages, truncated: true, internal_only_excluded: 0, incomplete: 0 };
  const sessions: DiscoverySession[] = [];
  let internalExcluded = 0;
  let incomplete = 0;
  for (const meeting of listing.meetings) {
    const record = toRecord(meeting);
    if (!record) {
      incomplete += 1;
      continue;
    }
    // The attendance report is the Teams analog of the gong parties read
    // (R-005): metadata for every listed meeting — display names and email
    // domains, no content. A missing report is observed absence; the match
    // step then fails closed.
    try {
      record.attendees = await client.meetingAttendance(meeting.id);
    } catch (error) {
      if (error instanceof TeamsRuntimeError && error.code === "provider_failure") record.attendees = [];
      else throw error;
    }
    if (internalOnly(record.attendees, connection.tenant_domain)) {
      internalExcluded += 1;
      continue;
    }
    // Transcript capability is observed on the connection (the brokered
    // scope), not per meeting — the listing carries no per-meeting grant
    // (R-005). `unknown` fails closed, so the adapter never reports a
    // capability the connection did not prove.
    record.transcript_available = connection.transcript_scope === "granted";
    const session = teamsDiscoveryAdapter.normalizeSession(record, target.connection_alias);
    if (session.completion_state !== "completed") {
      incomplete += 1;
      continue;
    }
    sessions.push({ ...session, access: connection.transcript_scope === "missing" ? "denied" : "available" });
  }
  return { sessions, listed: listing.meetings.length, pages: listing.pages, truncated: listing.truncated, internal_only_excluded: internalExcluded, incomplete };
}

async function readyCommand(root: string, json: boolean, deps: Required<TeamsDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "microsoft-teams",
    mode: MODE,
    support_state: SUPPORT_STATE,
    connection_owner: "workspace",
    configured: teamsConnectionConfigured(env),
    credential_broker: teamsCredentialBroker(env),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...TEAMS_POLICY },
  };
  try {
    const { connection, client } = await connect(deps);
    // The readiness probe is one metadata call inside a one-hour window: it
    // proves the credential and the listing permission without reading
    // meeting content.
    const now = deps.now();
    await client.listMeetings({ from: isoDaysAgo(now, 1 / 24), to: now });
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.credential_type = connection.credential_type;
    coverage.capabilities = { list_sessions: true, open_transcript: connection.transcript_scope !== "missing", stable_link: false, timestamps: false, transcript_scope: connection.transcript_scope, stable_link_note: "no Teams link form is declared yet; canonical links stay absent until feasibility verifies one (T-001)" };
    coverage.provider_calls = client.requests;
    return outcome(result("ok", { coverage, next_actions: [
      "Approve a bounded Microsoft Teams scope, then run foo discovery teams list <study-id|inbox:scope-id>.",
      ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a transcript."] : []),
    ] }), json);
  } catch (error) {
    if (error instanceof TeamsRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Microsoft Teams readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<TeamsDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery teams list <study-id|inbox:scope-id>", json);
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
    Object.assign(coverage, { meetings_listed: listed.listed, pages: listed.pages, truncated: listed.truncated, internal_only_excluded: listed.internal_only_excluded, incomplete_excluded: listed.incomplete, candidates_evaluated: listed.sessions.length, provider_calls: client.requests });
    if (listed.truncated) {
      return outcome(result("budget_exhausted", {
        study_id: targetId,
        coverage: { ...coverage, provider_error: "budget_exhausted" },
        errors: [{ code: "E_DISCOVERY_VALIDATION", message: `The window holds more meetings than the ${TEAMS_POLICY.max_list_pages}-page ceiling; narrow the window or selectors instead of widening the read.` }],
        handoff: "Narrow the approved window or selectors and list again; the run never widens the window and never retries.",
      }), json);
    }
    // R-008: a missing transcript scope degrades the run before any match
    // decision. The listing itself succeeded, so the run reports that plainly;
    // the transcript gate surfaces at process as needs_provider_access.
    if (connection.transcript_scope === "missing") {
      return outcome(result("ok", {
        study_id: targetId,
        coverage: { ...coverage, transcript_scope: connection.transcript_scope, degraded: "transcript_scope_missing" },
        next_actions: ["The tenant credential has no transcript permission; the Microsoft 365 administrator grants it, then list runs again to match, and process opens the one matched transcript."],
      }), json);
    }
    if (listed.sessions.length === 0) return outcome(result("awaiting_match", { study_id: targetId, coverage, next_actions: ["No completed meeting selected by the approved scope was listed inside the window."] }), json);
    if (target.lane === "study_linked") {
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify(listed.sessions), now);
      return outcome({ ...matched.result, coverage: { ...matched.result.coverage, ...coverage }, next_actions: [...matched.result.next_actions, ...(matched.result.status === "ok" ? [`Run foo discovery teams process ${targetId} to open the one matched transcript and apply the sanitized evidence.`] : [])] }, json);
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
          ...(matched.result.status === "ok" ? [`Run foo discovery teams process ${targetId} to open this one transcript and apply the sanitized evidence.`] : []),
          ...(remaining > 0 ? [`${remaining} more listed meeting(s) were not evaluated; run list again after this one is processed.`] : []),
        ],
      }, json);
    }
    return outcome(result("awaiting_match", { study_id: targetId, coverage: { ...coverage, candidates_evaluated: evaluated }, next_actions: lastMiss?.next_actions ?? ["No listed meeting matched the approved scope; nothing was opened."] }), json);
  } catch (error) {
    if (error instanceof TeamsRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    return invalid("Microsoft Teams listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
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

function containsIdentity(envelopeText: string, identities: string[]): boolean {
  const haystack = envelopeText.toLowerCase();
  return identities.some((identity) => identity.length >= 4 && haystack.includes(identity.toLowerCase()));
}

async function processCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<TeamsDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery teams process <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now, "process");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const model = defaultSynthesisModel(deps.env);
  const coverage: Record<string, unknown> = { mode: MODE, lane: target.lane, policy_version: TEAMS_POLICY.policy_version, model };
  let client: TeamsGraphClient | undefined;
  try {
    const connected = await connect(deps);
    client = connected.client;
    coverage.connection = connected.connection.connection_ref;
    if (connected.connection.transcript_scope === "missing") {
      // R-008: a missing transcript scope is degraded with needs_provider_access
      // before any transcript metadata, content, or proof machinery runs.
      return outcome(result("needs_provider_access", { study_id: targetId, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: "The tenant credential has no transcript permission; the meeting was not opened." }], handoff: "Request transcript access from the Microsoft 365 administrator.", coverage }), json);
    }
    const match = readMatch(root, targetId);
    if (!match || !Array.isArray(match.candidates) || match.candidates.length === 0) return invalid("No matched Teams meeting is recorded for this target; run foo discovery teams list first.", json, "E_DISCOVERY_VALIDATION", targetId);
    if (match.candidates.length > 1) return outcome(result("ambiguous_match", { study_id: targetId, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several meetings matched; a person must select one before any transcript is opened." }], handoff: `foo discovery review ${targetId} select-source --fingerprint <sha256> --by <person>` }), json);
    const candidate = match.candidates[0];
    const session = candidate.session;
    const meetingId = session.runtime_handle;
    if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the transcript was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
    const hypotheses = target.lane === "study_linked" ? studyHypotheses(target.dir) : [];
    if (target.lane === "study_linked" && hypotheses.length === 0) return invalid("The study records no H-### hypotheses in study.md; study-linked evidence needs one to test.", json, "E_DISCOVERY_VALIDATION", targetId);
    // Observe transcript availability from the provider's own metadata —
    // never assumed (R-005) — but only after the proof gate: no transcript
    // request of any kind (metadata included) happens before the proof
    // (R-007), so the metadata read lives inside the authorized wrapper.
    let openError: TeamsRuntimeError | undefined;
    let transcriptText: string | null;
    try {
      transcriptText = await openAuthorizedTranscript(
        { study_dir: target.dir, local_root: localRoot(root), study_id: targetId, source_fingerprint: candidate.source_fingerprint, now },
        async () => {
          try {
            const transcripts = await client!.meetingTranscripts(meetingId);
            if (transcripts.length === 0) throw new TeamsRuntimeError("no_transcript", "No transcript is recorded for the selected meeting; the meeting was not opened.");
            // Exactly one content read for one meeting id and one transcript
            // id (R-007) — the only content request in this run.
            return await client!.transcriptContent(meetingId, transcripts[0].id);
          } catch (error) {
            // A transport failure whose state is unknown (a fetch that threw
            // before a response existed) is not a provider answer: it degrades
            // to the fresh-proof path below instead of a typed result.
            if (error instanceof TeamsRuntimeError && error.code !== "network") openError = error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, transcript_body_requests: client.requests.transcript_content });
      return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The transcript was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery teams list ${targetId} again to re-match and mint a fresh proof.`, coverage }), json);
    }
    coverage.transcript_body_requests = client.requests.transcript_content;
    const estimatedTokens = Math.ceil(transcriptText.length / 4);
    if (estimatedTokens > TEAMS_POLICY.max_model_input_tokens) {
      transcriptText = null;
      return fromRuntimeError(new TeamsRuntimeError("transcript_too_large", "the transcript exceeds the model-input ceiling; nothing was synthesized"), json, targetId, coverage);
    }
    let synthesized;
    try {
      synthesized = await synthesizeDiscoveryEnvelope(
        {
          target_id: targetId,
          lane: target.lane,
          source: { provider: "microsoft-teams", ...(session.stable_url ? { stable_url: session.stable_url } : {}), source_fingerprint: candidate.source_fingerprint, completed_at: session.completed_at, locator_capability: session.capabilities.timestamps ? "timestamp" : "none" },
          title: session.title,
          hypotheses,
          transcript_text: transcriptText,
          transcript_complete: true,
          caveats: session.stable_url ? [] : ["The provider returned no canonical meeting link for this meeting."],
        },
        { model, transport: deps.transport },
      );
    } catch {
      return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the transcript was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    } finally {
      transcriptText = null;
    }
    coverage.synthesis_usage = synthesized.usage ?? null;
    // Privacy screen beyond the envelope validator: participant identities
    // observed from the provider's own metadata must not appear in derived text.
    const identities: string[] = [...target.selectors.named_external_participants, ...target.selectors.organizers, ...session.participants].filter((entry): entry is string => Boolean(entry?.trim()));
    const derivedText = [
      ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
      ...synthesized.envelope.coverage.caveats,
    ].join("\n");
    if (containsIdentity(derivedText, identities)) return invalid("Synthesis leaked a participant identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(synthesized.envelope), now);
    return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
  } catch (error) {
    if (error instanceof TeamsRuntimeError) return fromRuntimeError(error, json, targetId, { ...coverage, transcript_body_requests: client?.requests.transcript_content ?? 0 });
    return invalid("Microsoft Teams processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function syncCommand(root: string, json: boolean, deps: Required<TeamsDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const now = deps.now();
  const plan = planDiscoverySync(root, now);
  const lanes = plan.lanes.filter((lane) => lane.provider.toLowerCase() === "microsoft-teams");
  if (lanes.length === 0) return outcome(result("clean_no_op", { errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })), next_actions: ["No approved Microsoft Teams lane is active; approve a study source or an inbox scope first."], coverage: { mode: MODE, lanes: 0, connector_reads: 0 } }), json);
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
      ...ready.map((laneId) => `${laneId}: one meeting matched — run foo discovery teams process ${laneId.replace(/^study:/, "")} to open it.`),
      ...results.filter((entry) => entry.status !== "ok").map((entry) => `${entry.lane_id}: ${entry.status}${entry.handoff ? ` — ${entry.handoff}` : ""}`),
    ],
    coverage: { mode: MODE, lanes: results.length, transcripts_opened: 0, results },
  }), json);
}

export async function runTeamsDiscovery(root: string, args: string[], deps: TeamsDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved: Required<TeamsDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env }),
    fetchTimeoutMs: deps.fetchTimeoutMs ?? TEAMS_POLICY.fetch_timeout_ms,
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
    return invalid("Microsoft Teams discovery failed closed without exposing private source content.", json);
  }
}
