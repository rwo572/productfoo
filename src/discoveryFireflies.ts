// `foo discovery fireflies …` — the local worker for a per-user Fireflies
// connection (fireflies-discovery-connector-v0, D-001 keyed direct client
// under the gong worker contract).
//
// The gong worker is the process template (R-001): list bounded transcript
// metadata inside an approved study or inbox scope, normalize it through the
// Fireflies adapter, hand the closed session shape to `foo discovery match`,
// open exactly one proof-authorized transcript into process memory, reduce it
// to the sanitized envelope in one model request, and apply locally. The
// transcript never reaches argv, stdin, a file, Git, a log, an error, or the
// host agent's context; every surface this module writes is content-free.
//
// What differs from gong, honestly: the credential is the user's own Fireflies
// API key (connection_owner "user", credential_broker "direct" — R-010/D-002),
// not a Nango-brokered company connection; there is no administrator over a
// personal key, so member isolation is a recorded gap, not a provided control.
//
// Nothing here claims live Fireflies access. Fireflies stays contract_only
// until the feasibility task (T-001) and the dogfood run (T-008) close with
// receipts; the provider API shapes the client pins are beliefs owned by
// T-001, held up by fixtures only.

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
  type DiscoveryCommandOutcome,
  type DiscoveryCommandResult,
  type DiscoveryCommandStatus,
  type DiscoveryErrorCode,
  type InboxScope,
} from "./discoveryCommand.js";
import type { DiscoveryLane } from "./discoveryEvidence.js";
import { openAuthorizedTranscript } from "./discoveryProof.js";
import { firefliesDiscoveryAdapter, firefliesInternalOnly, type FirefliesTranscriptRecord } from "./discoveryProviders.js";
import type { DiscoverySession } from "./discoverySources.js";
import { planDiscoverySync } from "./discoverySync.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { firefliesConnectionReady } from "./sourceIngress.js";
import { FirefliesClient, FirefliesRuntimeError, firefliesConnectionConfigured, firefliesCredentialBroker, resolveFirefliesConnection, FIREFLIES_POLICY, type FetchLike, type FirefliesConnection, type FirefliesListedTranscript, type FirefliesTranscript } from "./firefliesClient.js";

export type FirefliesDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
};

const MATCHABLE_STUDY_STATES = new Set<DiscoveryLifecycle>(["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"]);
const DEFAULT_LOOKBACK_DAYS = 14;

type Target = {
  target_id: string;
  lane: DiscoveryLane;
  dir: string;
  connection_alias: string;
  window: { from: string; to: string };
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
  const lines = [`Discovery (fireflies): ${value.status}.`];
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
function fromRuntimeError(error: FirefliesRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: FIREFLIES_MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect your own Fireflies account by setting FOO_FIREFLIES_API_KEY to your Fireflies API key for this runtime; a Fireflies connection covers only your own meetings." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Check that the Fireflies API key is valid and its access grants include the meeting, then rerun." }), json);
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
    if (scope.provider.toLowerCase() !== "fireflies") throw new Error("this inbox scope is not a Fireflies scope");
    if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
    // R-004: validation is pre-flight — an invalid scope never reaches the
    // provider.
    const scopeError = firefliesScopeValidationError(firefliesSelectorsFromInboxScope(scope));
    if (scopeError) throw new Error(scopeError);
    const from = new Date(scope.time_window.start);
    const to = new Date(scope.time_window.end);
    return { target_id: targetId, lane: "unassigned_call_evidence", dir: discoveryTargetDir(root, targetId), connection_alias: scope.connection_alias, window: { from: from.toISOString(), to: to.toISOString() } };
  }
  const dir = discoveryTargetDir(root, targetId);
  const run = loadDiscoveryRun(dir);
  if (run.source.provider.toLowerCase() !== "fireflies") throw new Error("this study is not a Fireflies study");
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
    const lookback = Number(env.FOO_FIREFLIES_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
    if (!Number.isFinite(lookback) || lookback <= 0 || lookback > 90) throw new Error("FOO_FIREFLIES_LOOKBACK_DAYS must be between 1 and 90");
    from = isoDaysAgo(now, lookback);
    to = now;
  }
  // R-004 applies to study scopes too: a fireflies study names its customer —
  // the study target is the named external participant or company, and the
  // match constraints narrow further. A study with neither is invalid.
  const selectorError = firefliesScopeValidationError({
    window: { start: from, end: to },
    external_names: [...(run.match?.required_participants ?? []), ...(run.target?.name?.trim() ? [run.target.name.trim()] : [])],
    external_domains: run.target?.organization?.trim() ? [run.target.organization.trim()] : [],
    title_tokens: run.match?.required_title_tokens ?? [],
  });
  if (selectorError) throw new Error(selectorError);
  return { target_id: targetId, lane: "study_linked", dir, connection_alias: run.source.connection_alias, window: { from, to } };
}

// R-005: the canonical Fireflies link is path-based, built from the transcript
// id under the registry-allowlisted host; the adapter re-validates every link
// through the shared sanitizer, so a malformed id degrades to no link.
function firefliesLink(id: string): string {
  return `https://app.fireflies.ai/transcript/${id}`;
}

// The connection and the session record describe the same fact with two
// vocabularies: a connection that has not yet read a transcript is "unknown"
// at the connection level and "missing" (not observed) at the record level.
// Only an observed successful read upgrades either to "granted" (R-005).
function observedRecordAccess(connection: FirefliesConnection): "granted" | "missing" {
  return connection.transcript_access === "granted" ? "granted" : "missing";
}

function toRecord(listed: FirefliesListedTranscript, connection: FirefliesConnection): FirefliesTranscriptRecord | null {
  if (!listed.started_at) return null;
  return {
    id: listed.id,
    title: listed.title?.trim() || "Untitled transcript",
    started_at: listed.started_at,
    ended: listed.ended,
    status: listed.status,
    participants: listed.participants ?? [],
    url: firefliesLink(listed.id),
    transcript_access: observedRecordAccess(connection),
  };
}

async function connect(deps: Required<Pick<FirefliesDiscoveryDeps, "fetchImpl" | "env">> & Pick<FirefliesDiscoveryDeps, "sleep">): Promise<{ connection: FirefliesConnection; client: FirefliesClient }> {
  const connection = resolveFirefliesConnection({ env: deps.env });
  const client = new FirefliesClient(connection.credential, { fetchImpl: deps.fetchImpl, baseUrl: deps.env.FOO_FIREFLIES_API_BASE?.trim() || undefined, sleep: deps.sleep });
  // R-005's observed grant, keyed-direct edition: a personal Fireflies key has
  // no scope system, so the one observable fact is the presented key answering
  // for its owner. One identity query observes it per invocation (gong observes
  // its grant the same way, via OAuth-scope introspection at resolve time).
  // A transcript read that still fails maps to needs_provider_access — the
  // claim is never faked, only grounded where the provider allows.
  await client.probe();
  connection.transcript_access = "granted";
  return { connection, client };
}

async function listSessions(target: Target, connection: FirefliesConnection, client: FirefliesClient): Promise<{ sessions: DiscoverySession[]; listed: number; pages: number; truncated: boolean; internal_only_excluded: number; incomplete: number }> {
  const listing = await client.listTranscripts({ from: target.window.from, to: target.window.to });
  // A ceiling stop is final for the run (R-004/R-010): no further provider
  // reads happen — the run never waits for a wider window.
  if (listing.truncated) return { sessions: [], listed: listing.transcripts.length, pages: listing.pages, truncated: true, internal_only_excluded: 0, incomplete: 0 };
  const sessions: DiscoverySession[] = [];
  let internalExcluded = 0;
  let incomplete = 0;
  for (const entry of listing.transcripts) {
    const provisional = { id: entry.id, title: entry.title?.trim() || "Untitled transcript", started_at: entry.started_at ?? "", participants: entry.participants ?? [], url: firefliesLink(entry.id), transcript_access: observedRecordAccess(connection) } satisfies FirefliesTranscriptRecord;
    if (firefliesInternalOnly(provisional)) {
      internalExcluded += 1;
      continue;
    }
    const record = toRecord(entry, connection);
    if (!record) {
      incomplete += 1;
      continue;
    }
    const session = firefliesDiscoveryAdapter.normalizeSession(record, target.connection_alias);
    if (session.completion_state !== "completed") {
      incomplete += 1;
      continue;
    }
    // Transcript access is observed, never assumed (R-005): connect() watched
    // the presented key answer for its owner, so the session reports available
    // access; until that observation the session would honestly say unknown.
    sessions.push({ ...session, access: connection.transcript_access === "granted" ? "available" : "unknown" });
  }
  return { sessions, listed: listing.transcripts.length, pages: listing.pages, truncated: listing.truncated, internal_only_excluded: internalExcluded, incomplete };
}

async function readyCommand(root: string, json: boolean, deps: Required<FirefliesDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "fireflies",
    mode: FIREFLIES_MODE,
    support_state: FIREFLIES_SUPPORT_STATE,
    // R-010/D-002: the connection is the user's own key; there is no
    // administrator over it, and member isolation is not provided.
    connection_owner: "user",
    configured: firefliesConnectionConfigured(env),
    credential_broker: firefliesCredentialBroker(env),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...FIREFLIES_POLICY },
  };
  try {
    const { connection, client } = await connect(deps);
    // connect() already ran the one identity probe that observes the grant
    // (R-005); readiness adds no further provider read.
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.capabilities = { list_sessions: true, open_transcript: connection.transcript_access === "granted", stable_link: true, timestamps: true, transcript_access: connection.transcript_access };
    coverage.provider_calls = client.requests;
    coverage.readiness = firefliesConnectionReady({ connection_ref: connection.connection_ref });
    return outcome(result("ok", { coverage, next_actions: [
      "A personal Fireflies key sees only its owner's meetings: there is no administrator over it, and productfoo does not provide member isolation between users (OQ-001 workspace-owned access stays open).",
      "Approve a bounded Fireflies scope, then run foo discovery fireflies list <study-id|inbox:scope-id>.",
      ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a transcript."] : []),
    ] }), json);
  } catch (error) {
    if (error instanceof FirefliesRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Fireflies readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<FirefliesDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery fireflies list <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = { mode: FIREFLIES_MODE, window: target.window, lane: target.lane, transcript_opened: false };
  try {
    const { connection, client } = await connect(deps);
    coverage.connection = connection.connection_ref;
    const listed = await listSessions(target, connection, client);
    Object.assign(coverage, { transcripts_listed: listed.listed, pages: listed.pages, truncated: listed.truncated, internal_only_excluded: listed.internal_only_excluded, incomplete_excluded: listed.incomplete, candidates_evaluated: listed.sessions.length, provider_calls: client.requests });
    if (listed.truncated) {
      return outcome(result("budget_exhausted", {
        study_id: targetId,
        coverage: { ...coverage, provider_error: "budget_exhausted" },
        errors: [{ code: "E_DISCOVERY_VALIDATION", message: `The window holds more transcripts than the ${FIREFLIES_POLICY.max_list_pages}-page ceiling; narrow the window or selectors instead of widening the read.` }],
        handoff: "Narrow the approved window or selectors and list again; the run never widens the window and never retries.",
      }), json);
    }
    if (listed.sessions.length === 0) return outcome(result("awaiting_match", { study_id: targetId, coverage, next_actions: ["No completed transcript with an external party was listed inside the approved window."] }), json);
    if (target.lane === "study_linked") {
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify(listed.sessions), now);
      return outcome({ ...matched.result, coverage: { ...matched.result.coverage, ...coverage }, next_actions: [...matched.result.next_actions, ...(matched.result.status === "ok" ? [`Run foo discovery fireflies process ${targetId} to open the one matched transcript and apply the sanitized evidence.`] : [])] }, json);
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
          ...(matched.result.status === "ok" ? [`Run foo discovery fireflies process ${targetId} to open this one transcript and apply the sanitized evidence.`] : []),
          ...(remaining > 0 ? [`${remaining} more listed transcript(s) were not evaluated; run list again after this one is processed.`] : []),
        ],
      }, json);
    }
    return outcome(result("awaiting_match", { study_id: targetId, coverage: { ...coverage, candidates_evaluated: evaluated }, next_actions: lastMiss?.next_actions ?? ["No listed transcript matched the approved scope; nothing was opened."] }), json);
  } catch (error) {
    if (error instanceof FirefliesRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    return invalid("Fireflies listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
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

// Neutral speaker ordinals, never names: Fireflies metadata carries no
// affiliation (OQ-002), so the render cannot honestly say Customer or Company
// representative — and keeping names out of the model text is stricter than
// gong's role labels. Timestamps render relative to the first sentence when
// the provider supplies them.
function renderFirefliesTranscript(content: FirefliesTranscript): string {
  const starts = content.sentences?.map((sentence) => Date.parse(sentence.start_date ?? "")).filter((value) => Number.isFinite(value)) ?? [];
  const first = starts.length ? Math.min(...starts) : null;
  const lines: string[] = [];
  const ordinals = new Map<string, string>();
  for (const sentence of content.sentences ?? []) {
    let label = "Speaker";
    if (sentence.speaker_id) {
      if (!ordinals.has(sentence.speaker_id)) ordinals.set(sentence.speaker_id, `Speaker ${ordinals.size + 1}`);
      label = ordinals.get(sentence.speaker_id)!;
    }
    const start = Date.parse(sentence.start_date ?? "");
    const offset = first !== null && Number.isFinite(start) ? mmss(start - first) : "00:00";
    lines.push(`[${offset}] ${label}: ${sentence.text}`);
  }
  return lines.join("\n");
}

function containsIdentity(envelopeText: string, identities: string[]): boolean {
  const haystack = envelopeText.toLowerCase();
  return identities.some((identity) => identity.length >= 4 && haystack.includes(identity.toLowerCase()));
}

async function processCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<FirefliesDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery fireflies process <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now, "process");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const match = readMatch(root, targetId);
  if (!match || !Array.isArray(match.candidates) || match.candidates.length === 0) return invalid("No matched Fireflies transcript is recorded for this target; run foo discovery fireflies list first.", json, "E_DISCOVERY_VALIDATION", targetId);
  if (match.candidates.length > 1) return outcome(result("ambiguous_match", { study_id: targetId, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several transcripts matched; a person must select one before any transcript is opened." }], handoff: `foo discovery review ${targetId} select-source --fingerprint <sha256> --by <person>` }), json);
  const candidate = match.candidates[0];
  const session = candidate.session;
  const transcriptId = session.runtime_handle;
  if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the transcript was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
  const model = defaultSynthesisModel(deps.env);
  const coverage: Record<string, unknown> = { mode: FIREFLIES_MODE, lane: target.lane, policy_version: FIREFLIES_POLICY.policy_version, model };
  const hypotheses = target.lane === "study_linked" ? studyHypotheses(target.dir) : [];
  if (target.lane === "study_linked" && hypotheses.length === 0) return invalid("The study records no H-### hypotheses in study.md; study-linked evidence needs one to test.", json, "E_DISCOVERY_VALIDATION", targetId);
  let client: FirefliesClient | undefined;
  let connection: FirefliesConnection | undefined;
  try {
    const connected = await connect(deps);
    client = connected.client;
    connection = connected.connection;
    coverage.connection = connection.connection_ref;
    // Identities for the post-synthesis leak screen: the names and domain
    // labels the provider's own metadata carries (raw emails are long gone —
    // the adapter stripped them).
    const identities = [...(session.participants ?? [])];
    let openError: FirefliesRuntimeError | undefined;
    let transcriptText: string | null;
    try {
      const content = await openAuthorizedTranscript(
        { study_dir: target.dir, local_root: localRoot(root), study_id: targetId, source_fingerprint: candidate.source_fingerprint, now },
        async () => {
          try {
            return await client!.transcript(transcriptId);
          } catch (error) {
            if (error instanceof FirefliesRuntimeError) openError = error;
            throw error;
          }
        },
      );
      // Observed, never assumed (R-005): the connection just read a
      // transcript, so transcript access is now a fact of this connection.
      connection.transcript_access = "granted";
      for (const speaker of content.speakers ?? []) {
        if (speaker.name?.trim()) identities.push(speaker.name.trim());
      }
      transcriptText = renderFirefliesTranscript(content);
    } catch (error) {
      if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, transcript_body_requests: client.requests.transcript });
      return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The transcript was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery fireflies list ${targetId} again to re-match and mint a fresh proof.`, coverage }), json);
    }
    coverage.transcript_body_requests = client.requests.transcript;
    const estimatedTokens = Math.ceil(transcriptText.length / 4);
    if (estimatedTokens > FIREFLIES_POLICY.max_model_input_tokens) {
      transcriptText = null;
      return fromRuntimeError(new FirefliesRuntimeError("transcript_too_large", "the transcript exceeds the model-input ceiling; nothing was synthesized"), json, targetId, coverage);
    }
    // OQ-002 is stated inside the envelope, not silently dropped: the model
    // sees neutral speaker ordinals because Fireflies carries no affiliation.
    const caveats = [
      "Speaker roles were not attributed: Fireflies metadata carries no affiliation (OQ-002), so speakers are neutral ordinals.",
      ...(session.stable_url ? [] : ["The provider returned no canonical transcript link for this transcript."]),
    ];
    let synthesized;
    try {
      synthesized = await synthesizeDiscoveryEnvelope(
        {
          target_id: targetId,
          lane: target.lane,
          source: { provider: "fireflies", ...(session.stable_url ? { stable_url: session.stable_url } : {}), source_fingerprint: candidate.source_fingerprint, completed_at: session.completed_at, locator_capability: session.capabilities.timestamps ? "timestamp" : "none" },
          title: session.title,
          hypotheses,
          transcript_text: transcriptText,
          transcript_complete: true,
          caveats,
        },
        { model, transport: deps.transport },
      );
    } catch {
      return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the transcript was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    } finally {
      transcriptText = null;
    }
    coverage.synthesis_usage = synthesized.usage ?? null;
    // Privacy screen beyond the envelope validator: participant names, email
    // domains, and speaker names from the provider's own metadata must not
    // appear in derived text.
    const derivedText = [
      ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
      ...synthesized.envelope.coverage.caveats,
    ].join("\n");
    if (containsIdentity(derivedText, identities)) return invalid("Synthesis leaked a participant identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(synthesized.envelope), now);
    return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
  } catch (error) {
    if (error instanceof FirefliesRuntimeError) return fromRuntimeError(error, json, targetId, { ...coverage, transcript_body_requests: client?.requests.transcript ?? 0 });
    return invalid("Fireflies processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function syncCommand(root: string, json: boolean, deps: Required<FirefliesDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const now = deps.now();
  const plan = planDiscoverySync(root, now);
  const lanes = plan.lanes.filter((lane) => lane.provider.toLowerCase() === "fireflies");
  if (lanes.length === 0) return outcome(result("clean_no_op", { errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })), next_actions: ["No approved Fireflies lane is active; approve a study source or an inbox scope first."], coverage: { mode: FIREFLIES_MODE, lanes: 0, connector_reads: 0 } }), json);
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
      ...ready.map((laneId) => `${laneId}: one transcript matched — run foo discovery fireflies process ${laneId.replace(/^study:/, "")} to open it.`),
      ...results.filter((entry) => entry.status !== "ok").map((entry) => `${entry.lane_id}: ${entry.status}${entry.handoff ? ` — ${entry.handoff}` : ""}`),
    ],
    coverage: { mode: FIREFLIES_MODE, lanes: results.length, transcripts_opened: 0, results },
  }), json);
}

export async function runFirefliesDiscovery(root: string, args: string[], deps: FirefliesDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved: Required<FirefliesDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env }),
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
    return invalid("Fireflies discovery failed closed without exposing private source content.", json);
  }
}

export const FIREFLIES_SUPPORT_STATE = "contract_only";
export const FIREFLIES_MODE = "local_worker";

// R-004: a Fireflies scope lists metadata only inside a bounded time window
// AND with at least one customer selector — external participant companies or
// email domains, named external participants, or title tokens. The packet's
// closed selector contract is {window, external_domains?, external_names?,
// title_tokens?, include_internal_only: false}: V0 excludes internal-only
// meetings by default and refuses a scope that asks otherwise, and the inbox
// scope's own field names map onto the selector kinds.
export type FirefliesScopeSelectors = {
  window: { start?: string; end?: string };
  external_names?: string[];
  external_domains?: string[];
  title_tokens?: string[];
  include_internal_only?: boolean;
};

export function firefliesScopeValidationError(scope: FirefliesScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a fireflies scope needs a bounded time window with a valid start and end";
  if (start > end) return "a fireflies scope's time window must end after it starts";
  if (scope.include_internal_only) return "a fireflies scope cannot include internal-only meetings in V0: they are excluded by default (OQ-001 leaves the workspace-archive question open)";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["named external participants", scope.external_names],
    ["external companies or email domains", scope.external_domains],
    ["title tokens", scope.title_tokens],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a fireflies scope needs at least one customer selector (a named external participant, an external company or email domain, or a title token); a time window alone is never enough";
  }
  return null;
}

// The inbox scope's generic fields map onto the Fireflies selector kinds; the
// study lane maps its own (required participants, target organization, title
// tokens) the same way gong's worker does. A scope whose provider is not
// fireflies never reaches validation.
export function firefliesSelectorsFromInboxScope(scope: InboxScope): FirefliesScopeSelectors {
  return {
    window: { start: scope.time_window?.start, end: scope.time_window?.end },
    external_names: scope.participant_allowlist,
    external_domains: scope.domain_allowlist,
    title_tokens: scope.title_tokens,
  };
}
