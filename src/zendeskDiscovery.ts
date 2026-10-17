// `foo discovery zendesk …` — the local worker for the company Zendesk
// workspace (zendesk-discovery-connector-v0, D-010 local worker mode).
//
// The support-class runtime adapter: it lists bounded solved/closed ticket
// metadata inside an approved study or inbox scope, normalizes it through the
// Zendesk adapter (ticket-as-session, solved/closed admissibility with an
// observed solved_at), hands the closed session shape to
// `foo discovery match`, opens exactly one proof-authorized comment thread
// into process memory, synthesizes the sanitized envelope in one model
// request, and hands the envelope to `foo discovery apply`. The thread never
// reaches argv, stdin, a file, Git, a log, an error, or the host agent's
// context; every surface this module writes is content-free.
//
// What it is not: the hosted, cross-host service the Nango discovery packet
// specifies. Ownership isolation, signed service receipts, and remote hosts
// wait for that service. This worker runs where the repository working tree
// is, with the company credential brokered by Nango (or held directly by this
// runtime as an administrator-issued API token).

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
  zendeskScopeValidationError,
  type DiscoveryCommandOutcome,
  type DiscoveryCommandResult,
  type DiscoveryCommandStatus,
  type DiscoveryErrorCode,
} from "./discoveryCommand.js";
import type { DiscoveryLane } from "./discoveryEvidence.js";
import { openAuthorizedTranscript } from "./discoveryProof.js";
import { zendeskDiscoveryAdapter, type ZendeskTicketRecord } from "./discoveryProviders.js";
import type { DiscoverySession } from "./discoverySources.js";
import { planDiscoverySync } from "./discoverySync.js";
import { anthropicSynthesisTransport, defaultSynthesisModel, synthesisCredentialPresent, synthesizeDiscoveryEnvelope, type SynthesisTransport } from "./discoverySynthesis.js";
import { resolveZendeskConnection, zendeskConnectionConfigured, ZendeskClient, ZendeskRuntimeError, ZENDESK_POLICY, type FetchLike, type ZendeskConnection, type ZendeskScopeSelectorsRuntime, type ZendeskUser } from "./zendeskNango.js";

export type ZendeskDiscoveryDeps = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  transport?: SynthesisTransport;
  // Fixture seam only: narrows the provider fetch ceiling so a test can
  // observe a timeout instead of waiting out ZENDESK_POLICY.fetch_timeout_ms.
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
  selectors: ZendeskScopeSelectorsRuntime;
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
  const lines = [`Discovery (zendesk): ${value.status}.`];
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
function fromRuntimeError(error: ZendeskRuntimeError, json: boolean, targetId: string | undefined, coverage: Record<string, unknown>): DiscoveryCommandOutcome {
  const base = { study_id: targetId, coverage: { ...coverage, provider_error: error.code, mode: MODE } };
  switch (error.code) {
    case "not_connected":
      return outcome(result("needs_provider_connector", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect the company Zendesk workspace through Nango and set NANGO_SECRET_KEY and FOO_ZENDESK_NANGO_CONNECTION (plus NANGO_HOST / FOO_ZENDESK_NANGO_INTEGRATION when they differ from the defaults) and FOO_ZENDESK_SUBDOMAIN; or, for this runtime only, set FOO_ZENDESK_API_TOKEN and FOO_ZENDESK_API_TOKEN_EMAIL from an administrator-issued Zendesk API token." }), json);
    case "auth_expired":
    case "access_denied":
      return outcome(result("needs_provider_access", { ...base, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: error.message }], handoff: "Ask the Zendesk administrator to refresh the connection or grant the read permission, then rerun." }), json);
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
    if (scope.provider.toLowerCase() !== "zendesk") throw new Error("this inbox scope is not a Zendesk scope");
    if (scope.state !== "approved") throw new Error("this inbox scope is not approved");
    // R-004: validation is pre-flight — an invalid scope never reaches the
    // provider. The scope's selector kinds are the Zendesk kinds; participant
    // and title tokens remain Gong kinds and never stand in for one here.
    const scopeError = zendeskScopeValidationError({
      window: scope.time_window,
      external_domains: scope.domain_allowlist,
      organizations: scope.organizations,
      brands: scope.brands,
      include_internal_only: scope.include_internal_only,
    });
    if (scopeError) throw new Error(scopeError);
    const from = new Date(scope.time_window.start);
    const to = new Date(scope.time_window.end);
    return { target_id: targetId, lane: "unassigned_call_evidence", dir: discoveryTargetDir(root, targetId), connection_alias: scope.connection_alias, window: { from: from.toISOString(), to: to.toISOString() }, selectors: { external_domains: scope.domain_allowlist, organizations: scope.organizations, brands: scope.brands } };
  }
  const dir = discoveryTargetDir(root, targetId);
  const run = loadDiscoveryRun(dir);
  if (run.source.provider.toLowerCase() !== "zendesk") throw new Error("this study is not a Zendesk study");
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
    const lookback = Number(env.FOO_ZENDESK_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
    if (!Number.isFinite(lookback) || lookback <= 0 || lookback > 90) throw new Error("FOO_ZENDESK_LOOKBACK_DAYS must be between 1 and 90");
    from = isoDaysAgo(now, lookback);
    to = now;
  }
  // R-004 applies to study scopes too: a zendesk study names its customer —
  // the study's organization maps onto the ticket-organization selector kind.
  // Study match constraints (participants, title tokens) are Gong selector
  // kinds; the Zendesk worker narrows by them post-list instead.
  const organization = run.target?.organization?.trim() || undefined;
  const selectorError = zendeskScopeValidationError({
    window: { start: from, end: to },
    organizations: organization ? [organization] : [],
    include_internal_only: false,
  });
  if (selectorError) throw new Error(selectorError);
  return { target_id: targetId, lane: "study_linked", dir, connection_alias: run.source.connection_alias, window: { from, to }, selectors: { organizations: organization ? [organization] : undefined } };
}

// The canonical, off-the-wire link form R-006 validates for Zendesk — built
// from the workspace subdomain, never echoed from a provider response.
function ticketUrl(subdomain: string, ticketId: string): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`;
}

function inWindow(value: string | undefined, window: { from: string; to: string }): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= Date.parse(window.from) && at <= Date.parse(window.to);
}

// R-004: the search query reflects believed operator support; the worker
// additionally narrows after the read. A ticket whose requester sits outside
// the scope's external domains is excluded here — narrowing only, never
// widening.
function outsideDomainScope(requester: ZendeskUser | undefined, externalDomains: string[] | undefined): boolean {
  const domains = (externalDomains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) return false;
  const email = requester?.email?.trim().toLowerCase();
  const at = email ? email.lastIndexOf("@") : -1;
  if (!email || at <= 0 || at >= email.length - 1) return true;
  return !domains.includes(email.slice(at + 1));
}

async function connect(deps: Required<Pick<ZendeskDiscoveryDeps, "fetchImpl" | "env" | "fetchTimeoutMs">> & Pick<ZendeskDiscoveryDeps, "sleep">): Promise<{ connection: ZendeskConnection; client: ZendeskClient }> {
  const connection = await resolveZendeskConnection({ env: deps.env, fetchImpl: deps.fetchImpl });
  const client = new ZendeskClient(connection.credential, connection.subdomain, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, fetchTimeoutMs: deps.fetchTimeoutMs });
  return { connection, client };
}

async function listSessions(target: Target, connection: ZendeskConnection, client: ZendeskClient): Promise<{ sessions: DiscoverySession[]; listed: number; pages: number; truncated: boolean; domain_excluded: number; incomplete: number }> {
  const listing = await client.listTickets(target.window, target.selectors);
  // A ceiling stop is final for the run (R-004/R-010): no further provider
  // reads happen — the user and brand metadata reads wait for a window that
  // fits the agreed pages, never for a wider one.
  if (listing.truncated) return { sessions: [], listed: listing.tickets.length, pages: listing.pages, truncated: true, domain_excluded: 0, incomplete: 0 };
  const requesterIds = listing.tickets.map((ticket) => ticket.requester_id).filter((id): id is number => typeof id === "number");
  const users = requesterIds.length ? await client.users(requesterIds) : new Map<number, ZendeskUser>();
  const brands = listing.tickets.some((ticket) => typeof ticket.brand_id === "number") ? await client.brands() : new Map<number, string>();
  const sessions: DiscoverySession[] = [];
  let domainExcluded = 0;
  let incomplete = 0;
  for (const ticket of listing.tickets) {
    const requester = ticket.requester_id !== undefined ? users.get(ticket.requester_id) : undefined;
    if (outsideDomainScope(requester, target.selectors.external_domains)) {
      domainExcluded += 1;
      continue;
    }
    // The listing query is created-based (belief, T-001); the admissibility
    // window is the solved time, narrowed here — narrowing only (R-004).
    if (!inWindow(ticket.solved_at, target.window)) {
      incomplete += 1;
      continue;
    }
    const record: ZendeskTicketRecord = {
      id: ticket.id,
      subject: ticket.subject?.trim() || "Untitled ticket",
      status: ticket.status?.trim() || "",
      solved_at: ticket.solved_at,
      requester: requester ? { display_name: requester.name, email: requester.email } : {},
      assignee_display_name: undefined,
      brand: ticket.brand_id !== undefined ? brands.get(ticket.brand_id) : undefined,
      url: ticketUrl(connection.subdomain, ticket.id),
      comment_access: connection.comment_scope === "missing" ? "missing" : "granted",
    };
    const session = zendeskDiscoveryAdapter.normalizeSession(record, target.connection_alias);
    if (session.completion_state !== "completed") {
      incomplete += 1;
      continue;
    }
    sessions.push({ ...session, access: connection.comment_scope === "missing" ? "denied" : "available" });
  }
  return { sessions, listed: listing.tickets.length, pages: listing.pages, truncated: listing.truncated, domain_excluded: domainExcluded, incomplete };
}

async function readyCommand(root: string, json: boolean, deps: Required<ZendeskDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "zendesk",
    mode: MODE,
    support_state: SUPPORT_STATE,
    connection_owner: "workspace",
    configured: zendeskConnectionConfigured(env),
    credential_broker: env.FOO_ZENDESK_API_TOKEN?.trim() && env.FOO_ZENDESK_API_TOKEN_EMAIL?.trim() ? "direct" : env.NANGO_SECRET_KEY?.trim() && env.FOO_ZENDESK_NANGO_CONNECTION?.trim() ? "nango" : null,
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...ZENDESK_POLICY },
  };
  try {
    const { connection, client } = await connect(deps);
    // The readiness probe is one metadata call inside a one-hour window: it
    // proves the credential and the listing permission without reading a
    // comment thread.
    const now = deps.now();
    await client.listTickets({ from: isoDaysAgo(now, 1 / 24), to: now });
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.credential_type = connection.credential_type;
    coverage.capabilities = { list_sessions: true, open_transcript: connection.comment_scope !== "missing", stable_link: true, timestamps: connection.comment_scope !== "missing", comment_scope: connection.comment_scope };
    coverage.provider_calls = client.requests;
    return outcome(result("ok", { coverage, next_actions: [
      ...(connection.broker === "direct" ? ["Credential broker is direct: this runtime holds an administrator-issued API token itself. Refresh and revoke happen in Zendesk, not centrally; move to Nango for the company connection."] : []),
      "Approve a bounded Zendesk scope, then run foo discovery zendesk list <study-id|inbox:scope-id>.", ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a ticket thread."] : [])] }), json);
  } catch (error) {
    if (error instanceof ZendeskRuntimeError) return fromRuntimeError(error, json, undefined, coverage);
    return invalid("Zendesk readiness failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", undefined, coverage);
  }
}

async function listCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<ZendeskDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery zendesk list <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const coverage: Record<string, unknown> = { mode: MODE, window: target.window, lane: target.lane, thread_opened: false };
  try {
    const { connection, client } = await connect(deps);
    coverage.connection = connection.connection_ref;
    const listed = await listSessions(target, connection, client);
    Object.assign(coverage, { tickets_listed: listed.listed, pages: listed.pages, truncated: listed.truncated, domain_excluded: listed.domain_excluded, incomplete_excluded: listed.incomplete, candidates_evaluated: listed.sessions.length, provider_calls: client.requests });
    if (listed.truncated) {
      return outcome(result("budget_exhausted", {
        study_id: targetId,
        coverage: { ...coverage, provider_error: "budget_exhausted" },
        errors: [{ code: "E_DISCOVERY_VALIDATION", message: `The window holds more tickets than the ${ZENDESK_POLICY.max_list_pages}-page ceiling; narrow the window or selectors instead of widening the read.` }],
        handoff: "Narrow the approved window or selectors and list again; the run never widens the window and never retries.",
      }), json);
    }
    if (listed.sessions.length === 0) return outcome(result("awaiting_match", { study_id: targetId, coverage, next_actions: ["No solved or closed ticket with an observed solve time was listed inside the approved window."] }), json);
    if (target.lane === "study_linked") {
      const matched = await runDiscoveryCommand(root, ["match", targetId, "--sessions-stdin", "--json"], JSON.stringify(listed.sessions), now);
      return outcome({ ...matched.result, coverage: { ...matched.result.coverage, ...coverage }, next_actions: [...matched.result.next_actions, ...(matched.result.status === "ok" ? [`Run foo discovery zendesk process ${targetId} to open the one matched comment thread and apply the sanitized evidence.`] : [])] }, json);
    }
    // Inbox: one ticket at a time so each source gets its own one-time proof.
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
          ...(matched.result.status === "ok" ? [`Run foo discovery zendesk process ${targetId} to open this one comment thread and apply the sanitized evidence.`] : []),
          ...(remaining > 0 ? [`${remaining} more listed ticket(s) were not evaluated; run list again after this one is processed.`] : []),
        ],
      }, json);
    }
    return outcome(result("awaiting_match", { study_id: targetId, coverage: { ...coverage, candidates_evaluated: evaluated }, next_actions: lastMiss?.next_actions ?? ["No listed ticket matched the approved scope; nothing was opened."] }), json);
  } catch (error) {
    if (error instanceof ZendeskRuntimeError) return fromRuntimeError(error, json, targetId, coverage);
    return invalid("Zendesk listing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
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

function mmddhhmm(iso: string | undefined): string {
  const at = iso ? new Date(iso) : undefined;
  if (!at || Number.isNaN(at.getTime())) return "--/-- --:--";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

// Role labels only: the speaker map is used inside this request to say who is
// the customer and who is the company. Zendesk's own user role decides — an
// end-user is the customer, agents and admins are the company — and the names
// never enter the text.
function speakerRole(user: ZendeskUser | undefined): string {
  if (!user) return "Unknown speaker";
  return user.role?.trim().toLowerCase() === "end-user" ? "Customer" : "Company representative";
}

function renderThread(comments: Array<{ author_id?: number; body?: string; created_at?: string }>, users: Map<number, ZendeskUser>): string {
  const lines: string[] = [];
  for (const comment of comments) {
    const role = comment.author_id !== undefined ? speakerRole(users.get(comment.author_id)) : "Unknown speaker";
    const body = (comment.body ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    lines.push(`[${mmddhhmm(comment.created_at)}] ${role}: ${body}`);
  }
  return lines.join("\n");
}

function containsIdentity(envelopeText: string, identities: string[]): boolean {
  const haystack = envelopeText.toLowerCase();
  return identities.some((identity) => identity.length >= 4 && haystack.includes(identity.toLowerCase()));
}

async function processCommand(root: string, targetId: string | undefined, json: boolean, deps: Required<ZendeskDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  if (!targetId) return invalid("Usage: foo discovery zendesk process <study-id|inbox:scope-id>", json);
  const now = deps.now();
  let target: Target;
  try {
    target = loadTarget(root, targetId, deps.env, now, "process");
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "invalid discovery target", json, "E_DISCOVERY_VALIDATION", targetId);
  }
  const match = readMatch(root, targetId);
  if (!match || !Array.isArray(match.candidates) || match.candidates.length === 0) return invalid("No matched Zendesk ticket is recorded for this target; run foo discovery zendesk list first.", json, "E_DISCOVERY_VALIDATION", targetId);
  if (match.candidates.length > 1) return outcome(result("ambiguous_match", { study_id: targetId, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several tickets matched; a person must select one before any comment thread is opened." }], handoff: `foo discovery review ${targetId} select-source --fingerprint <sha256> --by <person>` }), json);
  const candidate = match.candidates[0];
  const session = candidate.session;
  const ticketId = session.runtime_handle;
  if (!synthesisCredentialPresent(deps.env)) return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "No model credential is available for server-side synthesis, so the comment thread was not opened." }], handoff: "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) for this runtime, then rerun process." }), json);
  const model = defaultSynthesisModel(deps.env);
  const coverage: Record<string, unknown> = { mode: MODE, lane: target.lane, policy_version: ZENDESK_POLICY.policy_version, model };
  const hypotheses = target.lane === "study_linked" ? studyHypotheses(target.dir) : [];
  if (target.lane === "study_linked" && hypotheses.length === 0) return invalid("The study records no H-### hypotheses in study.md; study-linked evidence needs one to test.", json, "E_DISCOVERY_VALIDATION", targetId);
  let client: ZendeskClient | undefined;
  try {
    const connected = await connect(deps);
    client = connected.client;
    coverage.connection = connected.connection.connection_ref;
    if (connected.connection.comment_scope === "missing") {
      return outcome(result("needs_provider_access", { study_id: targetId, errors: [{ code: "E_DISCOVERY_PROVIDER_ACCESS", message: "The Zendesk credential has no ticket-read permission; the comment thread was not opened." }], handoff: session.stable_url ? `Request comment access for ${session.stable_url}` : "Request comment access from the Zendesk administrator.", coverage }), json);
    }
    let openError: ZendeskRuntimeError | undefined;
    type OpenedThread = { comments: Array<{ author_id?: number; body?: string; created_at?: string }>; users: Map<number, ZendeskUser> };
    let opened: OpenedThread | undefined;
    try {
      opened = await openAuthorizedTranscript<OpenedThread>(
        { study_dir: target.dir, local_root: localRoot(root), study_id: targetId, source_fingerprint: candidate.source_fingerprint, now },
        async () => {
          try {
            const comments = await client!.comments(ticketId);
            const authorIds = comments.map((comment) => comment.author_id).filter((id): id is number => typeof id === "number");
            const users = authorIds.length ? await client!.users(authorIds) : new Map<number, ZendeskUser>();
            return { comments, users };
          } catch (error) {
            if (error instanceof ZendeskRuntimeError) openError = error;
            throw error;
          }
        },
      );
    } catch (error) {
      if (openError) return fromRuntimeError(openError, json, targetId, { ...coverage, thread_body_requests: client.requests.comments });
      return outcome(result("needs_research_proof", { study_id: targetId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The comment thread was not opened: the discovery proof is missing, expired, already used, or no longer matches the approval." }], handoff: `Run foo discovery zendesk list ${targetId} again to re-match and mint a fresh proof.`, coverage }), json);
    }
    coverage.thread_body_requests = client.requests.comments;
    let threadText: string | null = renderThread(opened.comments, opened.users);
    const estimatedTokens = Math.ceil(threadText.length / 4);
    if (estimatedTokens > ZENDESK_POLICY.max_model_input_tokens) {
      threadText = null;
      return fromRuntimeError(new ZendeskRuntimeError("transcript_too_large", "the comment thread exceeds the model-input ceiling; nothing was synthesized"), json, targetId, coverage);
    }
    let synthesized;
    try {
      synthesized = await synthesizeDiscoveryEnvelope(
        {
          target_id: targetId,
          lane: target.lane,
          source: { provider: "zendesk", ...(session.stable_url ? { stable_url: session.stable_url } : {}), source_fingerprint: candidate.source_fingerprint, completed_at: session.completed_at, locator_capability: session.capabilities.timestamps ? "timestamp" : "none" },
          title: session.title,
          hypotheses,
          transcript_text: threadText,
          transcript_complete: true,
          caveats: session.stable_url ? [] : ["The worker could not construct a canonical ticket link for this ticket."],
        },
        { model, transport: deps.transport },
      );
    } catch {
      return invalid("Synthesis did not produce a valid closed envelope; nothing was written and the comment thread was discarded.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    } finally {
      threadText = null;
    }
    coverage.synthesis_usage = synthesized.usage ?? null;
    // Privacy screen beyond the envelope validator: requester and agent names
    // from the provider's own metadata must not appear in derived text.
    const derivedText = [
      ...synthesized.envelope.findings.flatMap((finding) => [finding.headline, finding.paraphrase, finding.dissent]),
      ...synthesized.envelope.coverage.caveats,
    ].join("\n");
    if (containsIdentity(derivedText, session.participants)) return invalid("Synthesis leaked a participant identity into derived text; nothing was written.", json, "E_DISCOVERY_INVALID_ENVELOPE", targetId, coverage);
    const applied = await runDiscoveryCommand(root, ["apply", targetId, "--evidence-stdin", "--json"], JSON.stringify(synthesized.envelope), now);
    return outcome({ ...applied.result, coverage: { ...applied.result.coverage, ...coverage } }, json);
  } catch (error) {
    if (error instanceof ZendeskRuntimeError) return fromRuntimeError(error, json, targetId, { ...coverage, thread_body_requests: client?.requests.comments ?? 0 });
    return invalid("Zendesk processing failed closed without exposing private source content.", json, "E_DISCOVERY_VALIDATION", targetId, coverage);
  }
}

async function syncCommand(root: string, json: boolean, deps: Required<ZendeskDiscoveryDeps>): Promise<DiscoveryCommandOutcome> {
  const now = deps.now();
  const plan = planDiscoverySync(root, now);
  const lanes = plan.lanes.filter((lane) => lane.provider.toLowerCase() === "zendesk");
  if (lanes.length === 0) return outcome(result("clean_no_op", { errors: plan.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION" as const, message })), next_actions: ["No approved Zendesk lane is active; approve a study source or an inbox scope first."], coverage: { mode: MODE, lanes: 0, connector_reads: 0 } }), json);
  const results: Array<{ lane_id: string; status: DiscoveryCommandStatus; handoff: string | null }> = [];
  // Metadata and match only: a comment thread is opened only by an explicit
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
      ...ready.map((laneId) => `${laneId}: one ticket matched — run foo discovery zendesk process ${laneId.replace(/^study:/, "")} to open it.`),
      ...results.filter((entry) => entry.status !== "ok").map((entry) => `${entry.lane_id}: ${entry.status}${entry.handoff ? ` — ${entry.handoff}` : ""}`),
    ],
    coverage: { mode: MODE, lanes: results.length, threads_opened: 0, results },
  }), json);
}

export async function runZendeskDiscovery(root: string, args: string[], deps: ZendeskDiscoveryDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved: Required<ZendeskDiscoveryDeps> = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    transport: deps.transport ?? anthropicSynthesisTransport({ fetchImpl: deps.fetchImpl, env }),
    fetchTimeoutMs: deps.fetchTimeoutMs ?? ZENDESK_POLICY.fetch_timeout_ms,
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
    return invalid("Zendesk discovery failed closed without exposing private source content.", json);
  }
}
