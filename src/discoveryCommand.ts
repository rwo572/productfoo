import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { flagValue, hasFlag } from "./cliArgs.js";
import { loadDiscoveryRun, locateStudy, transitionDiscoveryRun, validateDiscoveryPath, type DiscoveryLifecycle, type DiscoveryWrite } from "./discoveryArtifacts.js";
import { validateDiscoveryEvidence, type DiscoveryEvidenceEnvelope } from "./discoveryEvidence.js";
import { matchDiscoverySessions, sourceFingerprint } from "./discoveryMatching.js";
import { assertOpenedDiscoveryProof, authorizeDiscoverySource, consumeDiscoveryProof, markDiscoveryProofOpened, purgeDiscoveryLocalFingerprint, purgeDiscoveryLocalState, purgeDiscoveryRetention } from "./discoveryProof.js";
import { applyDiscoveryEvidence, applyInboxDiscoveryEvidence, applyReceiptVerifiedDiscoveryBundle } from "./discoveryReconcile.js";
import {
  buildLearningDestinationCatalog,
  clusterUnmatchedLearnings,
  routeLearning,
  validateHypothesisSynthesis,
  type HypothesisSynthesis,
  type LearningClusterFinding,
  type LearningDestination,
  type LearningRouteDecision,
  type LearningSignalCluster,
} from "./discoveryLearningRouting.js";
import { buildSignalBugIntake, defaultGhExec, newBugLogSession, runBugLog } from "./bugOwnerLog.js";
import { assertNormalizedSessionShape, contactHintsFromDisplayLabel, dedupeContactHints, isValidLinkedinUrl, type DiscoverySession, type SessionContactHint } from "./discoverySources.js";
import { revoke as revokeSource } from "./sourceIngress.js";
import { fanOutDiscoveryTargetSuspension } from "./discoveryConnections.js";
import { planDiscoverySync } from "./discoverySync.js";
import { parse, stringify } from "./vendorYaml.js";

export const DISCOVERY_COMMAND_SCHEMA_VERSION = "0.1" as const;

export type DiscoveryErrorCode =
  | "E_DISCOVERY_SOURCE_APPROVAL"
  | "E_DISCOVERY_PROVIDER_ACCESS"
  | "E_DISCOVERY_PROVIDER_CONNECTOR"
  | "E_DISCOVERY_RESEARCH_PROOF"
  | "E_DISCOVERY_AMBIGUOUS_MATCH"
  | "E_DISCOVERY_INVALID_ENVELOPE"
  | "E_DISCOVERY_INVALID_TRANSITION"
  | "E_DISCOVERY_MANUAL_RESOLUTION"
  | "E_DISCOVERY_RECEIPT"
  | "E_DISCOVERY_VALIDATION";

export type DiscoveryCommandStatus =
  | "ok"
  | "clean_no_op"
  | "awaiting_match"
  | "ambiguous_match"
  | "needs_source_approval"
  | "needs_provider_access"
  | "needs_provider_connector"
  | "needs_research_proof"
  | "needs_review"
  // The receipt-verified apply boundary (T-005): the service could not
  // confirm the processing receipt is active at the current revocation epoch
  // immediately before writing — fail-closed, nothing was written.
  | "needs_service_verification"
  // A stable state of the upstream Nango discovery contract: the run stopped
  | "invalid"
  | "budget_exhausted";

export type DiscoveryCommandResult = {
  schema_version: "0.1";
  status: DiscoveryCommandStatus;
  study_id?: string;
  writes: DiscoveryWrite[];
  errors: Array<{ code: DiscoveryErrorCode; message: string }>;
  handoff: string | null;
  next_actions: string[];
  coverage: Record<string, unknown>;
};

export type DiscoveryCommandOutcome = { output: string; exitCode: number; result: DiscoveryCommandResult };

function result(status: DiscoveryCommandStatus, options: Partial<Omit<DiscoveryCommandResult, "schema_version" | "status">> = {}): DiscoveryCommandResult {
  return {
    schema_version: "0.1",
    status,
    writes: options.writes ?? [],
    errors: options.errors ?? [],
    handoff: options.handoff ?? null,
    next_actions: options.next_actions ?? [],
    coverage: options.coverage ?? {},
    ...(options.study_id ? { study_id: options.study_id } : {}),
  };
}

function exitCodeFor(status: DiscoveryCommandStatus): number {
  return ["ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "needs_service_verification", "invalid", "budget_exhausted"].includes(status) ? 1 : 0;
}

function humanOutput(value: DiscoveryCommandResult): string {
  const lines = [`Discovery: ${value.status.replaceAll("_", " ")}.`];
  if (value.handoff) lines.push(value.handoff);
  for (const action of value.next_actions) lines.push(`- ${action}`);
  return `${lines.join("\n")}\n`;
}

function outcome(value: DiscoveryCommandResult, json: boolean): DiscoveryCommandOutcome {
  return { result: value, exitCode: exitCodeFor(value.status), output: json ? `${JSON.stringify(value, null, 2)}\n` : humanOutput(value) };
}

function invalid(message: string, json: boolean, code: DiscoveryErrorCode = "E_DISCOVERY_VALIDATION", studyId?: string): DiscoveryCommandOutcome {
  return outcome(result("invalid", { study_id: studyId, errors: [{ code, message: "Discovery input or state is invalid; no private source content was accepted." }], handoff: message }), json);
}

export function study(root: string, studyId: string): string {
  const found = locateStudy(root, studyId);
  if (!found) throw new Error(`Discovery study not found: ${studyId}`);
  return found;
}

export type InboxScope = {
  scope_id: string;
  provider: string;
  connection_alias: string;
  time_window: { start: string; end: string };
  participant_allowlist: string[];
  domain_allowlist: string[];
  title_tokens: string[];
  // Gong selector kind (gong-discovery-connector-v0 R-004): the call owner is
  // one of the customer selectors a gong scope may carry. Optional so every
  // pre-existing scope.yaml is unchanged; other providers ignore it.
  call_owners?: string[];
  // Zendesk selector kinds (zendesk-discovery-connector-v0 R-004): ticket
  // organizations and brands narrow a support scope the same way — optional
  // so every pre-existing scope.yaml is unchanged; other providers ignore
  // them. Zendesk internal and agent-only tickets are excluded by default and
  // a scope may not opt in (R-004).
  organizations?: string[];
  brands?: string[];
  include_internal_only?: boolean;
  // Gmail selector kind (gmail-discovery-connector-v0 R-004): the explicit
  // Gmail labels a scope is bounded to. Optional so every pre-existing
  // scope.yaml is unchanged; other providers ignore it.
  labels?: string[];
  // Slack selector kind (slack-discovery-connector-v0 R-004): the explicit
  // channel IDs and, for thread reads, thread timestamps a slack scope
  // carries. Optional so every pre-existing scope.yaml is unchanged; other
  // providers ignore it. Validation is the closed SlackScope shape in
  // sourceIngress.ts.
  channel_ids?: string[];
  thread_ts?: string[];
  // Outlook selector kind (outlook-discovery-connector-v0 R-004): the
  // explicit Outlook folders a scope is bounded to. Optional so every
  // pre-existing scope.yaml is unchanged; other providers ignore it.
  folders?: string[];
  state: "draft" | "approved" | "revoked";
};

export function isInboxTarget(targetId: string): boolean {
  return /^inbox:[a-z0-9_]+$/.test(targetId);
}

export function inboxDir(root: string): string {
  return path.join(root, "discovery", "inbox");
}

// The inbox's derived artifacts are content-free scaffolds: the study path gets
// theirs created with the study, but nothing created the inbox's, so a clean
// install that authored scope.yaml alone hit a swallowed ENOENT at apply — a
// fail-closed message that never named the missing file. scope.yaml is the
// consent boundary and is operator-authored; this only creates the three
// derived files, and only when absent. (R-006: discovery runs in a clean
// public install, and a missing input is named, not swallowed.)
export function ensureInboxScaffold(root: string): void {
  const dir = inboxDir(root);
  mkdirSync(dir, { recursive: true });
  const scaffold: Array<[string, string]> = [
    ["findings.yaml", 'schema_version: "0.1"\nfindings: []\n'],
    ["proposals.yaml", 'schema_version: "0.1"\nproposals: []\n'],
    ["events.jsonl", ""],
  ];
  for (const [name, content] of scaffold) {
    const file = path.join(dir, name);
    if (!existsSync(file)) writeFileSync(file, content);
  }
}

export function discoveryTargetDir(root: string, targetId: string): string {
  return isInboxTarget(targetId) ? inboxDir(root) : study(root, targetId);
}

export function localTargetName(targetId: string): string {
  return targetId.replace(":", "_");
}

export function inboxScope(root: string, targetId: string): InboxScope {
  if (!isInboxTarget(targetId)) throw new Error("invalid inbox target");
  const scopeId = targetId.slice("inbox:".length);
  const doc = parse(readFileSync(path.join(inboxDir(root), "scope.yaml"), "utf8")) as { scopes?: InboxScope[] };
  const scope = (doc.scopes ?? []).find((candidate) => candidate.scope_id === scopeId);
  if (!scope) throw new Error("inbox scope not found");
  return scope;
}

// R-004 (gong-discovery-connector-v0): a company-owned Gong connection lists
// metadata only inside a scope that carries a bounded time window AND at least
// one customer selector — a named external participant, an external company or
// email domain, a title token, or a call owner. A scope with no selector is
// `invalid`, and the optional Gong workspace narrows the read but is never
// itself a customer selector. Selector names follow the packet's selector
// kinds so study and inbox callers map their own field names onto them.
export type GongScopeSelectors = {
  window: { start?: string; end?: string };
  named_external_participants?: string[];
  external_companies_or_domains?: string[];
  title_tokens?: string[];
  call_owners?: string[];
};

export function gongScopeValidationError(scope: GongScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a gong scope needs a bounded time window with a valid start and end";
  if (start > end) return "a gong scope's time window must end after it starts";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["named external participants", scope.named_external_participants],
    ["external companies or email domains", scope.external_companies_or_domains],
    ["title tokens", scope.title_tokens],
    ["call owners", scope.call_owners],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a gong scope needs at least one customer selector (a named external participant, an external company or email domain, a title token, or a call owner); a time window alone is never enough, and a Gong workspace narrows the read but never substitutes for a customer selector";
  }
  return null;
}

// Zendesk scope selectors (zendesk-discovery-connector-v0 R-004): study and
// inbox callers map their own field names onto these kinds. The completed
// evidence set is solved/closed support tickets, so a window plus at least
// one customer selector — an external requester domain, a ticket organization,
// or a brand — bounds the read; a Zendesk subdomain narrows the read but
// never substitutes for a customer selector, and internal or agent-only
// tickets are excluded by default with no opt-in in V0.
export type ZendeskScopeSelectors = {
  window: { start?: string; end?: string };
  external_domains?: string[];
  organizations?: string[];
  brands?: string[];
  include_internal_only?: boolean;
};

export function zendeskScopeValidationError(scope: ZendeskScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a zendesk scope needs a bounded time window with a valid start and end";
  if (start > end) return "a zendesk scope's time window must end after it starts";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["external requester domains", scope.external_domains],
    ["ticket organizations", scope.organizations],
    ["brands", scope.brands],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a zendesk scope needs at least one customer selector (an external requester domain, a ticket organization, or a brand); a time window alone is never enough, and a Zendesk subdomain narrows the read but never substitutes for a customer selector";
  }
  // Internal and agent-only tickets are excluded by default (R-004); a scope
  // asking to include them is refused in V0 rather than silently honored.
  if (scope.include_internal_only === true) {
    return "a zendesk scope cannot include internal or agent-only tickets; they are excluded by default and the exclusion is not configurable in V0";
  }
  return null;
}

// R-004 (gmail-discovery-connector-v0): a per-user Gmail connection reads
// metadata only inside the strictest composition of the ten — an approved
// scope naming EXPLICIT Gmail labels AND a bounded time window AND at least
// one customer selector (an external sender domain or a named external
// participant). Every forbidden shape is refused outright: a windowless
// scope, a selector-less scope, a label-only scope (labels are never enough
// alone), and the mailbox-wide read. The connector's own mailbox (internal
// threads) is excluded by default and a scope cannot opt back in.
export type GmailScopeSelectors = {
  window: { start?: string; end?: string };
  labels?: string[];
  external_domains?: string[];
  external_names?: string[];
  include_internal_only?: boolean;
};

export function gmailScopeValidationError(scope: GmailScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a gmail scope needs a bounded time window with a valid start and end";
  if (start > end) return "a gmail scope's time window must end after it starts";
  const labels = (scope.labels ?? []).filter((label) => typeof label === "string" && label.trim().length > 0);
  if (labels.length === 0) return "a gmail scope needs at least one explicit Gmail label; the mailbox itself is never a scope (R-004)";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["external sender domains", scope.external_domains],
    ["named external participants", scope.external_names],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a gmail scope needs at least one customer selector (an external sender domain or a named external participant); a label alone is never enough, and reads stay gated on it";
  }
  if (scope.include_internal_only === true) return "a gmail scope cannot include the connector's own internal mailbox; the internal mailbox is excluded by default (R-004)";
  return null;
}

// Zoom runs the same discipline (zoom-discovery-connector-v0 R-004) with its
// own closed selector kind set: external_domains, external_names, and
// title_tokens — no call-owner kind. Internal-only recordings are excluded by
// default and cannot be included in V0: doing so needs an explicit selector
// plus separate approval, which does not exist yet.
export type ZoomScopeSelectors = {
  window: { start?: string; end?: string };
  external_names?: string[];
  external_domains?: string[];
  title_tokens?: string[];
  include_internal_only?: boolean;
};

export function zoomScopeValidationError(scope: ZoomScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a zoom scope needs a bounded time window with a valid start and end";
  if (start > end) return "a zoom scope's time window must end after it starts";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["named external participants", scope.external_names],
    ["external companies or email domains", scope.external_domains],
    ["title tokens", scope.title_tokens],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a zoom scope needs at least one customer selector (a named external participant, an external company or email domain, or a title token); a time window alone is never enough";
  }
  if (scope.include_internal_only) {
    return "including internal-only recordings needs a separate approval V0 does not grant; internal-only recordings stay excluded by default";
  }
  return null;
}

// R-004 (microsoft-teams-discovery-connector-v0): a tenant-owned Teams
// connection lists metadata only inside a scope that carries a bounded time
// window AND at least one customer selector — a named external participant,
// an external company or email domain, or an organizer. A scope with no
// selector is invalid, and the Entra tenant narrows the read but is never
// itself a customer selector. Internal-only meetings are excluded by default
// because they can match no customer selector; the tenant-owned organizer is
// the company's own staff, so everyone else is external.
export type TeamsScopeSelectors = {
  window: { start?: string; end?: string };
  named_external_participants?: string[];
  external_companies_or_domains?: string[];
  organizers?: string[];
};

export function teamsScopeValidationError(scope: TeamsScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a Teams scope needs a bounded time window with a valid start and end";
  if (start > end) return "a Teams scope's time window must end after it starts";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["named external participants", scope.named_external_participants],
    ["external companies or email domains", scope.external_companies_or_domains],
    ["organizers", scope.organizers],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "a Teams scope needs at least one customer selector (a named external participant, an external company or email domain, or an organizer); a time window alone is never enough, and the tenant narrows the read but never substitutes for a customer selector";
  }
  return null;
}

// R-004 (outlook-discovery-connector-v0): a per-user Outlook connection reads
// metadata only inside the email class's strictest composition — an approved
// scope naming EXPLICIT Outlook folders AND a bounded time window AND at
// least one customer selector (an external sender domain or a named external
// participant). Every forbidden shape is refused outright: a windowless
// scope, a selector-less scope, a folder-only scope (folders are never enough
// alone), and the mailbox-wide read. The connector's own mailbox (internal
// conversations) is excluded by default and a scope cannot opt back in.
export type OutlookScopeSelectors = {
  window: { start?: string; end?: string };
  folders?: string[];
  external_domains?: string[];
  external_names?: string[];
  include_internal_only?: boolean;
};

export function outlookScopeValidationError(scope: OutlookScopeSelectors): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "an outlook scope needs a bounded time window with a valid start and end";
  if (start > end) return "an outlook scope's time window must end after it starts";
  const folders = (scope.folders ?? []).filter((folder) => typeof folder === "string" && folder.trim().length > 0);
  if (folders.length === 0) return "an outlook scope needs at least one explicit Outlook folder; the mailbox itself is never a scope (R-004)";
  const selectorKinds: Array<[string, string[] | undefined]> = [
    ["external sender domains", scope.external_domains],
    ["named external participants", scope.external_names],
  ];
  const hasSelector = selectorKinds.some(([, list]) => Array.isArray(list) && list.some((entry) => typeof entry === "string" && entry.trim().length > 0));
  if (!hasSelector) {
    return "an outlook scope needs at least one customer selector (an external sender domain or a named external participant); a folder alone is never enough, and reads stay gated on it";
  }
  if (scope.include_internal_only === true) return "an outlook scope cannot include the connector's own internal mailbox; the internal mailbox is excluded by default (R-004)";
  return null;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

type InboxMatchVerdict =
  | { status: "match" }
  | { status: "near_miss"; session_participant: string; approved_label: string }
  | { status: "none"; misses: string[] };

// Plain Levenshtein over short labels. Scopes are written from memory of a
// name while providers render canonical display names ("Exampletn" vs
// "Exampleton"), so a one-edit variant is the common case, not the edge case.
function editDistance(a: string, b: string): number {
  const dist = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dist[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dist[a.length][b.length];
}

// The verdict names what missed instead of collapsing to a boolean: the
// operator submitted the session metadata and approved the scope, so echoing
// their own labels back leaks nothing while turning "outside the approved
// scope" from a source-dive into a one-line fix (#524). A one-edit participant
// variant is a near-miss — flagged for the human, never auto-opened.
function inboxSessionMatchVerdict(scope: InboxScope, session: DiscoverySession): InboxMatchVerdict {
  if (scope.state !== "approved") return { status: "none", misses: ["the inbox scope is not approved"] };
  if (session.completion_state !== "completed") return { status: "none", misses: ["the session is not completed"] };
  if (normalized(session.provider) !== normalized(scope.provider) || normalized(session.connection_alias) !== normalized(scope.connection_alias)) {
    return { status: "none", misses: [`provider/connection: the session is ${session.provider}/${session.connection_alias}, the approved scope is ${scope.provider}/${scope.connection_alias}`] };
  }
  const completedAt = Date.parse(session.completed_at);
  const start = Date.parse(String(scope.time_window?.start ?? ""));
  const end = Date.parse(String(scope.time_window?.end ?? ""));
  if (![completedAt, start, end].every(Number.isFinite) || completedAt < start || completedAt > end) {
    return { status: "none", misses: [`time_window: completed_at ${session.completed_at} is outside the approved window ${scope.time_window?.start ?? "?"}..${scope.time_window?.end ?? "?"}`] };
  }
  const participantAllowlist = (scope.participant_allowlist ?? []).map(normalized);
  const domainAllowlist = (scope.domain_allowlist ?? []).map((domain) => normalized(domain).replace(/^@/, ""));
  const titleTokens = (scope.title_tokens ?? []).map(normalized);
  const participants = session.participants.map(normalized);
  const participantMatch = participantAllowlist.some((allowed) => participants.includes(allowed));
  const domainMatch = domainAllowlist.some((domain) => participants.some((participant) => participant.endsWith(`@${domain}`)));
  const title = normalized(session.title);
  const titleMatch = titleTokens.length > 0 && titleTokens.every((token) => title.includes(token));
  if (participantMatch || domainMatch || titleMatch) return { status: "match" };

  for (const [allowedIndex, allowed] of participantAllowlist.entries()) {
    for (const [participantIndex, participant] of participants.entries()) {
      if (editDistance(allowed, participant) <= 1) {
        return {
          status: "near_miss",
          session_participant: session.participants[participantIndex],
          approved_label: (scope.participant_allowlist ?? [])[allowedIndex],
        };
      }
    }
  }

  const misses: string[] = [];
  if (participantAllowlist.length > 0) misses.push(`participant_allowlist: none of the session's ${participants.length} participant label(s) matched the ${participantAllowlist.length} approved label(s)`);
  if (domainAllowlist.length > 0) misses.push(`domain_allowlist: no session participant is at an approved domain`);
  if (titleTokens.length > 0) misses.push(`title_tokens: the session title does not contain every approved token`);
  if (misses.length === 0) misses.push("the scope configures no participant, domain, or title selector, so no session can match");
  return { status: "none", misses };
}

export function localRoot(root: string): string {
  return path.join(root, ".foo", "discovery");
}

function relative(root: string, file: string, action: DiscoveryWrite["action"] = "updated"): DiscoveryWrite {
  return { path: path.relative(root, file).split(path.sep).join("/"), action };
}

function transitionIfNeeded(studyDir: string, next: DiscoveryLifecycle, now: string): DiscoveryWrite[] {
  const current = loadDiscoveryRun(studyDir).state;
  if (current === next) return [];
  return transitionDiscoveryRun(studyDir, next, { type: "agent", id: "foo-discovery" }, now);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown validation failure";
}

function planCommand(root: string, args: string[], json: boolean): DiscoveryCommandOutcome {
  if (hasFlag(args, "--inbox")) {
    ensureInboxScaffold(root);
    const validation = validateDiscoveryPath(root);
    if (!validation.inbox) return invalid("The discovery inbox is missing.", json);
    if (!validation.ok) return invalid(`Discovery artifacts are invalid; fix these before planning provider access — ${validation.errors.join("; ")}`, json);
    const planned = planDiscoverySync(root, new Date().toISOString());
    const activeScopes = planned.lanes.filter((lane) => lane.kind === "inbox").length;
    return outcome(result(activeScopes ? "ok" : "clean_no_op", {
      next_actions: activeScopes ? ["List only sessions inside each approved inbox scope."] : ["No approved unassigned-call scope with matching source approval is active."],
      coverage: { lane: "unassigned_call_evidence", active_scopes: activeScopes },
    }), json);
  }
  const studyId = flagValue(args, "--study");
  if (!studyId) return invalid("Use --study <id> or --inbox.", json);
  let run;
  try { run = loadDiscoveryRun(study(root, studyId)); } catch { return invalid(`Study ${studyId} was not found.`, json, "E_DISCOVERY_VALIDATION", studyId); }
  const actions: string[] = [];
  if (run.state === "awaiting_interview") actions.push("Complete or schedule the discovery interview; no connector read is allowed yet.");
  else if (["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"].includes(run.state)) actions.push(`List completed ${run.source.provider} sessions, normalize metadata in the provider adapter, then run foo discovery match ${studyId} --sessions-stdin.`);
  else if (run.state === "ready_to_synthesize") actions.push("Open only the proof-authorized selected transcript in runtime memory, synthesize paraphrases, then run foo discovery apply with the sanitized envelope on stdin.");
  else if (run.state === "needs_review") actions.push("Review findings, dissent, hypothesis outcomes, mappings, and proposals before completing the study.");
  return outcome(result(run.state === "awaiting_match" ? "awaiting_match" : run.state === "needs_review" ? "needs_review" : "ok", { study_id: studyId, next_actions: actions, coverage: { lifecycle: run.state, connector_read: false } }), json);
}

function matchCommand(root: string, args: string[], stdin: string, json: boolean, now: string): DiscoveryCommandOutcome {
  const studyId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (!studyId || !hasFlag(args, "--sessions-stdin")) return invalid("Usage: foo discovery match <study-id> --sessions-stdin", json, "E_DISCOVERY_VALIDATION", studyId);
  let sessions: unknown;
  try { sessions = JSON.parse(stdin || "[]"); } catch { return invalid("Session metadata stdin must be JSON.", json, "E_DISCOVERY_VALIDATION", studyId); }
  if (!Array.isArray(sessions)) return invalid("Session metadata stdin must be an array.", json, "E_DISCOVERY_VALIDATION", studyId);
  try { sessions.forEach(assertNormalizedSessionShape); } catch (error) { return invalid(`Session metadata must use the closed normalized shape; transcript fields are refused — ${failureReason(error)}.`, json, "E_DISCOVERY_INVALID_ENVELOPE", studyId); }
  if (isInboxTarget(studyId)) {
    ensureInboxScaffold(root);
    let scope: InboxScope;
    try { scope = inboxScope(root, studyId); } catch { return invalid(`Inbox scope ${studyId} was not found.`, json, "E_DISCOVERY_VALIDATION", studyId); }
    if (scope.state !== "approved") return invalid(`Inbox scope ${studyId} is not approved.`, json, "E_DISCOVERY_INVALID_TRANSITION", studyId);
    if (sessions.length !== 1) return invalid("Inbox matching accepts exactly one normalized completed session at a time.", json, "E_DISCOVERY_VALIDATION", studyId);
    const session = sessions[0] as DiscoverySession;
    const verdict = inboxSessionMatchVerdict(scope, session);
    if (verdict.status === "near_miss") {
      return outcome(result("ambiguous_match", {
        study_id: studyId,
        errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: `Participant "${verdict.session_participant}" is one edit from the approved label "${verdict.approved_label}"; nothing was opened or recorded.` }],
        handoff: `If "${verdict.session_participant}" is the approved person, add that spelling to the scope's participant_allowlist (or correct the label) and re-run match.`,
        coverage: { candidates: 0, transcript_opened: false, lane: "unassigned_call_evidence" },
      }), json);
    }
    if (verdict.status === "none") {
      return outcome(result("awaiting_match", {
        study_id: studyId,
        next_actions: [
          "The completed session is outside the approved inbox scope; it was not opened or recorded.",
          ...verdict.misses.map((miss) => `Selector missed — ${miss}`),
        ],
        coverage: { candidates: 0, transcript_opened: false },
      }), json);
    }
    const matchDir = path.join(localRoot(root), localTargetName(studyId));
    mkdirSync(matchDir, { recursive: true });
    writeFileSync(path.join(matchDir, "match.json"), `${JSON.stringify({ schema_version: "0.1", candidates: [{ candidate_index: 1, source_fingerprint: sourceFingerprint(session), session }] }, null, 2)}\n`, { mode: 0o600 });
    // Contact capture at ingest (discovery-contact-capture-v0 R-003/D-004):
    // the matched session's own metadata seeds the scope's contact-card
    // candidates. Scope approval is the consent boundary this metadata already
    // passed; the transcript prerequisites below gate the transcript, not the
    // metadata. Raw emails never survive the derivation (R-004).
    const captured = recordContactCandidates(root, scope.scope_id, sessionContactCandidates(session), now);
    const authorized = authorizeDiscoverySource({ study_dir: inboxDir(root), local_root: localRoot(root), study_id: studyId, study_state: "awaiting_match", match_status: "unique", session, now });
    if (authorized.status === "ready_to_synthesize") {
      return outcome(result("ok", { study_id: studyId, writes: captured.writes, next_actions: ["Open this source only through the authorized transcript wrapper, synthesize an unassigned-call envelope without hypotheses, then apply it on stdin."], coverage: { candidates: 1, proof: "ready", transcript_opened: false, lane: "unassigned_call_evidence", contact_candidates_recorded: captured.added } }), json);
    }
    const status = authorized.status as DiscoveryCommandStatus;
    if (status === "invalid") purgeDiscoveryLocalState(localRoot(root), studyId);
    const code: Record<string, DiscoveryErrorCode> = {
      needs_source_approval: "E_DISCOVERY_SOURCE_APPROVAL",
      needs_provider_access: "E_DISCOVERY_PROVIDER_ACCESS",
      needs_provider_connector: "E_DISCOVERY_PROVIDER_CONNECTOR",
      needs_research_proof: "E_DISCOVERY_RESEARCH_PROOF",
    };
    return outcome(result(status, { study_id: studyId, writes: captured.writes, errors: [{ code: code[status] ?? "E_DISCOVERY_VALIDATION", message: "An inbox transcript prerequisite is missing; no transcript was opened." }], handoff: authorized.handoff ?? null, coverage: { candidates: 1, transcript_opened: false, lane: "unassigned_call_evidence", contact_candidates_recorded: captured.added } }), json);
  }
  let studyDir: string;
  let run;
  try { studyDir = study(root, studyId); run = loadDiscoveryRun(studyDir); } catch { return invalid(`Study ${studyId} was not found.`, json, "E_DISCOVERY_VALIDATION", studyId); }
  if (!["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"].includes(run.state)) return invalid(`Study ${studyId} is not ready for matching.`, json, "E_DISCOVERY_INVALID_TRANSITION", studyId);
  const matched = matchDiscoverySessions(run.match, sessions as DiscoverySession[]);
  if (matched.status === "none") return outcome(result("awaiting_match", { study_id: studyId, next_actions: ["No completed session matched every configured field; check the planned date, participant labels, and title tokens."], coverage: { candidates: 0, transcript_opened: false } }), json);
  const matchDir = path.join(localRoot(root), studyId);
  mkdirSync(matchDir, { recursive: true });
  writeFileSync(path.join(matchDir, "match.json"), `${JSON.stringify({ schema_version: "0.1", candidates: matched.matches.map((session, index) => ({ candidate_index: index + 1, source_fingerprint: matched.candidates[index].source_fingerprint, session })) }, null, 2)}\n`, { mode: 0o600 });
  if (matched.status === "ambiguous") {
    const writes = transitionIfNeeded(studyDir, "ambiguous_match", now);
    return outcome(result("ambiguous_match", { study_id: studyId, writes, errors: [{ code: "E_DISCOVERY_AMBIGUOUS_MATCH", message: "Several sessions matched; none was opened." }], handoff: `Select one of ${matched.matches.length} locally recorded candidates.`, coverage: { candidates: matched.matches.length, transcript_opened: false } }), json);
  }
  const authorized = authorizeDiscoverySource({ study_dir: studyDir, local_root: localRoot(root), study_id: studyId, study_state: run.state, match_status: "unique", session: matched.matches[0], now });
  if (authorized.status === "ready_to_synthesize") {
    const writes = transitionIfNeeded(studyDir, "ready_to_synthesize", now);
    return outcome(result("ok", { study_id: studyId, writes, next_actions: ["Open candidate 1 only through the authorized transcript wrapper, synthesize a sanitized evidence envelope in memory, then apply it on stdin."], coverage: { candidates: 1, proof: "ready", transcript_opened: false } }), json);
  }
  const status = authorized.status as DiscoveryCommandStatus;
  const lifecycle = status as DiscoveryLifecycle;
  const writes = status !== "invalid" ? transitionIfNeeded(studyDir, lifecycle, now) : [];
  const code: Record<string, DiscoveryErrorCode> = {
    needs_source_approval: "E_DISCOVERY_SOURCE_APPROVAL",
    needs_provider_access: "E_DISCOVERY_PROVIDER_ACCESS",
    needs_provider_connector: "E_DISCOVERY_PROVIDER_CONNECTOR",
    needs_research_proof: "E_DISCOVERY_RESEARCH_PROOF",
  };
  return outcome(result(status, { study_id: studyId, writes, errors: [{ code: code[status] ?? "E_DISCOVERY_VALIDATION", message: "A transcript prerequisite is missing; no transcript was opened." }], handoff: authorized.handoff ?? null, coverage: { candidates: 1, transcript_opened: false } }), json);
}

export function existingFingerprint(studyDir: string, fingerprint: string): boolean {
  // A workspace whose inbox has never received evidence has no findings file
  // yet; that is a first apply, not a replay. (autoTie treats the same state
  // as "the discovery inbox is missing" rather than crashing.)
  const findingsPath = path.join(studyDir, "findings.yaml");
  if (!existsSync(findingsPath)) return false;
  const doc = parse(readFileSync(findingsPath, "utf8")) as { findings?: Array<{ source_fingerprint?: string }> };
  return (doc.findings ?? []).some((finding) => finding.source_fingerprint === fingerprint);
}

function nextFindingId(findings: Array<Record<string, unknown>>): string {
  const highest = findings.reduce((max, finding) => {
    const match = /^F-(\d+)$/.exec(String(finding.finding_id ?? ""));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `F-${String(highest + 1).padStart(3, "0")}`;
}

function nextNumberedId(records: Array<Record<string, unknown>>, key: string, prefix: string): string {
  const highest = records.reduce((max, record) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(record[key] ?? ""));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

async function applyCommand(root: string, args: string[], stdin: string, json: boolean, now: string): Promise<DiscoveryCommandOutcome> {
  const studyId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (!studyId || !hasFlag(args, "--evidence-stdin")) return invalid("Usage: foo discovery apply <study-id> --evidence-stdin", json, "E_DISCOVERY_INVALID_ENVELOPE", studyId);
  let parsed: unknown;
  try { parsed = JSON.parse(stdin); } catch { return invalid("Evidence stdin must be valid JSON.", json, "E_DISCOVERY_INVALID_ENVELOPE", studyId); }
  let studyDir: string;
  try { studyDir = discoveryTargetDir(root, studyId); } catch { return invalid(`Discovery target ${studyId} was not found.`, json, "E_DISCOVERY_VALIDATION", studyId); }
  if (isInboxTarget(studyId)) ensureInboxScaffold(root);
  // A hosted portable bundle (needs_local_apply output, T-004) takes the
  // receipt-verified boundary — bundle shape, signature, key, bindings, the
  // current local approval/revocation state, then an online
  // discovery_receipt_status check immediately before any write. Local
  // envelopes keep the one-time-proof boundary below (R-005 vs R-007).
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { kind?: unknown }).kind === "discovery_portable_bundle") {
    const bundleApplied = await applyReceiptVerifiedDiscoveryBundle({ root, target_id: studyId, studyDir, bundle: parsed, now });
    if (bundleApplied.status === "needs_service_verification") {
      return outcome(result("needs_service_verification", {
        study_id: studyId,
        errors: [{ code: "E_DISCOVERY_RECEIPT", message: "Discovery service verification failed; nothing was written." }],
        handoff: bundleApplied.reason,
        next_actions: ["Verify the connection and receipt again when the discovery service is reachable; the receipt is not consumed and no evidence was written."],
        coverage: { receipt_status: "unverified", writes_blocked: true },
      }), json);
    }
    if (bundleApplied.status === "invalid") return invalid(bundleApplied.reason, json, "E_DISCOVERY_RECEIPT", studyId);
    return outcome(result(bundleApplied.status, {
      study_id: studyId,
      writes: bundleApplied.writes,
      next_actions: bundleApplied.status === "needs_review" ? ["Review the derived findings, dissent, mappings, and proposals. Automation stops here."] : [],
      coverage: { receipt_verified: true },
    }), json);
  }
  let envelope: DiscoveryEvidenceEnvelope;
  const lane = isInboxTarget(studyId) ? "unassigned_call_evidence" : "study_linked";
  try { envelope = validateDiscoveryEvidence(parsed, { expected_study_id: studyId, expected_lane: lane }); } catch (error) { return invalid(`The evidence envelope failed the closed privacy/schema contract — ${failureReason(error)}.`, json, "E_DISCOVERY_INVALID_ENVELOPE", studyId); }
  const replayingExistingSource = existingFingerprint(studyDir, envelope.source.source_fingerprint);
  if (!replayingExistingSource) {
    try { assertOpenedDiscoveryProof(localRoot(root), studyId, envelope.source.source_fingerprint, now); } catch {
      return outcome(result("needs_research_proof", { study_id: studyId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "An opened, matching discovery proof is required; no evidence was written." }], handoff: "Repeat metadata matching and open the selected transcript only through the authorized runtime path.", coverage: { transcript_proof: "missing_or_invalid" } }), json);
    }
  }
  try {
    const applied = isInboxTarget(studyId)
      ? applyInboxDiscoveryEvidence(root, studyDir, envelope, now)
      : applyDiscoveryEvidence(root, studyDir, envelope, now);
    if (!replayingExistingSource) consumeDiscoveryProof(localRoot(root), studyId, envelope.source.source_fingerprint, now);
    // Transcript-derived contact candidates (discovery-contact-capture-v0
    // R-005): validated name/company/title statements land on the inbox
    // scope's card as inferred suggestions. Study-linked envelopes have no
    // per-scope card, so their candidates are reported, not silently dropped.
    const envelopeCandidates = envelope.contact_candidates ?? [];
    let contactRecorded = 0;
    let contactWrites: DiscoveryWrite[] = [];
    const contactNotes: string[] = [];
    if (envelopeCandidates.length > 0) {
      if (isInboxTarget(studyId)) {
        const proposed: ContactCandidate[] = [];
        for (const candidate of envelopeCandidates) {
          if (typeof candidate.name === "string" && candidate.name.trim()) proposed.push({ field: "full_name", value: candidate.name.trim(), inferred: true, source: "envelope:transcript_synthesis" });
          if (typeof candidate.company === "string" && candidate.company.trim()) proposed.push({ field: "company", value: candidate.company.trim(), inferred: true, source: "envelope:transcript_synthesis" });
          if (typeof candidate.title === "string" && candidate.title.trim()) proposed.push({ field: "title", value: candidate.title.trim(), inferred: true, source: "envelope:transcript_synthesis" });
        }
        const recorded = recordContactCandidates(root, studyId.slice("inbox:".length), proposed, now);
        contactRecorded = recorded.added;
        contactWrites = recorded.writes;
        if (recorded.added > 0) contactNotes.push(`Recorded ${recorded.added} inferred contact candidate(s) on this scope's card; a person confirms them with foo discovery contact ${studyId.slice("inbox:".length)} --infer.`);
      } else {
        contactNotes.push("Contact candidates were validated but not recorded: cards are per inbox call scope, and this is a study-linked apply.");
      }
    }
    return outcome(result(applied.status, { study_id: studyId, writes: [...applied.writes, ...contactWrites], next_actions: [...(applied.status === "needs_review" ? ["Review the derived findings, dissent, mappings, and proposals. Automation stops here."] : []), ...contactNotes], coverage: { findings: envelope.findings.length, transcript_complete: envelope.coverage.transcript_complete, ...(envelopeCandidates.length > 0 ? { contact_candidates: envelopeCandidates.length, contact_candidates_recorded: contactRecorded } : {}) } }), json);
  } catch {
    return invalid("Evidence could not be applied; no partial discovery update was accepted.", json, "E_DISCOVERY_VALIDATION", studyId);
  }
}

type LocatedDiscoveryRecord = { file: string; key: "findings" | "proposals"; doc: { schema_version: string; findings?: Array<Record<string, unknown>>; proposals?: Array<Record<string, unknown>> }; record: Record<string, unknown> };

function findYamlRecords(root: string, targetId: string, within?: string): LocatedDiscoveryRecord[] {
  const discovery = path.join(root, "discovery");
  if (!existsSync(discovery)) return [];
  let dirs = readdirSync(discovery, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(discovery, entry.name));
  if (within) {
    if (within === "inbox" || isInboxTarget(within)) dirs = [inboxDir(root)];
    else {
      const scopedStudy = locateStudy(root, within);
      dirs = scopedStudy ? [scopedStudy] : dirs.filter((dir) => path.basename(dir) === within);
    }
  }
  const found: LocatedDiscoveryRecord[] = [];
  for (const dir of dirs) {
    for (const [fileName, key, idKey] of [["findings.yaml", "findings", "finding_id"], ["proposals.yaml", "proposals", "proposal_id"]] as const) {
      const file = path.join(dir, fileName);
      if (!existsSync(file)) continue;
      const doc = parse(readFileSync(file, "utf8")) as { schema_version: string; findings?: Array<Record<string, unknown>>; proposals?: Array<Record<string, unknown>> };
      const records = (doc[key] ?? []).filter((entry) => entry[idKey] === targetId);
      for (const record of records) found.push({ file, key, doc, record });
    }
  }
  return found;
}

// Key-order-independent equality for the human-edit check (detach D-002): the
// YAML round trip may reorder keys, and reordering alone is not a human edit.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// A real spec packet, never created implicitly by attach (D-005).
function specPacketDir(root: string, packetName: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packetName)) return null;
  const dir = path.join(root, "specs", packetName);
  return existsSync(path.join(dir, "spec.md")) ? dir : null;
}

// --- Insight ties (discovery-insight-ties-v0) ---------------------------------
// Customer insight links to the things it is about, plural and typed, in the
// owner's language: bug / spec / research / idea (R-001). `study` survives as
// a migration/automation compatibility type. Ties are pointers: destination
// ledgers record filings only (D-002).

export type InsightTie = { type: "bug" | "spec" | "research" | "idea" | "study"; ref: string; url: string | null; by: string; actor: "agent" | "human"; at: string };

function tieKey(tie: Pick<InsightTie, "type" | "ref">): string {
  return `${tie.type}:${tie.ref}`;
}

function recordTies(record: Record<string, unknown>): InsightTie[] {
  if (!Array.isArray(record.ties)) record.ties = [];
  return record.ties as InsightTie[];
}

// Read ties without materializing the field. Used where a record may end up
// with no tie so a skipped record never gains a noisy empty `ties: []`.
function peekTies(record: Record<string, unknown>): InsightTie[] {
  return Array.isArray(record.ties) ? (record.ties as InsightTie[]) : [];
}

function tieUrlFor(root: string, type: InsightTie["type"], ref: string): string | null {
  if (type === "spec") return `specs/${ref}/spec.md`;
  if (type === "research" || type === "idea") return ref;
  if (type === "study") {
    const dir = locateStudy(root, ref);
    return dir ? `${path.relative(root, dir).split(path.sep).join("/")}/study.md` : null;
  }
  return null;
}

// Resolves a research/idea document reference: bare names resolve into the
// directory, `.md` is optional, and the file must exist — ties never invent
// documents.
function resolveDocRef(root: string, dirName: "research" | "ideas", given: string): string | null {
  const base = given.includes("/") ? given : `${dirName}/${given}`;
  if (!base.startsWith(`${dirName}/`) || base.includes("..")) return null;
  for (const candidate of [base, `${base}.md`]) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

// R-002 migration: fold the superseded single-pointer fields into ties so no
// pointer from the assignment era is stranded. Lazy on every tie-touching
// verb, plus one sweep in the auto pass.
function migrateRecordTies(root: string, record: Record<string, unknown>): boolean {
  const keys = new Set(peekTies(record).map(tieKey));
  let changed = false;
  const add = (type: InsightTie["type"], ref: string, url: string | null, by: string, actor: "agent" | "human", at: string): void => {
    if (keys.has(`${type}:${ref}`)) return;
    recordTies(record).push({ type, ref, url, by, actor, at });
    keys.add(`${type}:${ref}`);
    changed = true;
  };
  const assignment = (record.assignment ?? null) as Record<string, unknown> | null;
  const by = String(assignment?.by ?? "migration");
  const actor: "agent" | "human" = assignment?.actor === "agent" ? "agent" : "human";
  const at = String(assignment?.at ?? "1970-01-01T00:00:00.000Z");
  const pointer = typeof record.assigned_to === "string" && record.assigned_to ? record.assigned_to : null;
  if (pointer) {
    if (pointer.startsWith("packet:")) add("spec", pointer.slice("packet:".length), tieUrlFor(root, "spec", pointer.slice("packet:".length)), by, actor, at);
    else if (pointer.startsWith("bug:")) {
      const basis = assignment?.basis as Record<string, unknown> | undefined;
      add("bug", pointer.slice("bug:".length), typeof basis?.issue_url === "string" ? basis.issue_url : null, by, actor, at);
    } else add("study", pointer, tieUrlFor(root, "study", pointer), by, actor, at);
  }
  const attached = typeof record.attached_to === "string" && record.attached_to ? record.attached_to : null;
  if (attached && !attached.startsWith("bug:")) {
    const disposition = record.disposition as Record<string, unknown> | undefined;
    const attachBy = String(disposition?.by ?? by);
    const attachAt = String(disposition?.at ?? at);
    if (attached.startsWith("packet:")) add("spec", attached.slice("packet:".length), tieUrlFor(root, "spec", attached.slice("packet:".length)), attachBy, "human", attachAt);
    else add("study", attached, tieUrlFor(root, "study", attached), attachBy, "human", attachAt);
  }
  if ("assigned_to" in record) { delete record.assigned_to; changed = true; }
  if ("assignment" in record) { delete record.assignment; changed = true; }
  return changed;
}

// Placement fields live on the signal side and may change after a filing; the
// filed copy is compared without them so a later tie never reads as a human
// edit of the copy (detach D-002 of discovery-review-verbs-v0).
function stripPlacement(record: Record<string, unknown>): Record<string, unknown> {
  const { ties: _ties, assigned_to: _assignedTo, assignment: _assignment, primary_home: _primaryHome, ...rest } = record;
  return rest;
}

function atomicWriteYaml(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

function atomicWriteYamlBatch(entries: Array<{ file: string; value: unknown }>): void {
  const staged = entries.map(({ file, value }, index) => {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${index}`;
    writeFileSync(temporary, stringify(value), { mode: 0o600, flag: "wx" });
    return { file, temporary };
  });
  for (const entry of staged) renameSync(entry.temporary, entry.file);
}

function learningClusterFinding(record: Record<string, unknown>, proposal?: Record<string, unknown>): LearningClusterFinding | null {
  const findingId = typeof record.finding_id === "string" ? record.finding_id : "";
  const inboxScopeId = typeof record.inbox_scope_id === "string" ? record.inbox_scope_id.trim() : "";
  const headline = typeof record.headline === "string" ? record.headline.trim() : "";
  const paraphrase = typeof record.paraphrase === "string" ? record.paraphrase.trim() : "";
  if (!/^F-\d{3}$/.test(findingId) || !inboxScopeId || (!headline && !paraphrase)) return null;
  return {
    finding_id: findingId,
    inbox_scope_id: inboxScopeId,
    headline,
    paraphrase,
    dissent: typeof record.dissent === "string" ? record.dissent.trim() : undefined,
    proposal_text: typeof proposal?.proposed_text === "string" ? proposal.proposed_text.trim() : undefined,
  };
}

function clusterSummary(cluster: LearningSignalCluster): Record<string, unknown> {
  return {
    cluster_key: cluster.cluster_key,
    source_finding_ids: cluster.source_finding_ids,
    independent_call_count: cluster.source_scope_ids.length,
    signals: cluster.findings.map((finding) => ({
      finding_id: finding.finding_id,
      headline: finding.headline,
      paraphrase: finding.paraphrase,
      dissent: finding.dissent ?? "",
      proposal_text: finding.proposal_text ?? "",
    })),
  };
}

function parseHypothesisSynthesis(stdin: string): HypothesisSynthesis | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdin); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.source_finding_ids) || !value.source_finding_ids.every((id) => typeof id === "string")) return null;
  if (!["claim", "dissent", "falsifier", "next_evidence"].every((key) => typeof value[key] === "string")) return null;
  if (value.starting_confidence !== "low" && value.starting_confidence !== "medium") return null;
  return {
    source_finding_ids: value.source_finding_ids as string[],
    claim: value.claim as string,
    dissent: value.dissent as string,
    falsifier: value.falsifier as string,
    next_evidence: value.next_evidence as string,
    starting_confidence: value.starting_confidence,
  };
}

function routeReceipt(decision: LearningRouteDecision, now: string, hypothesisId?: string): Record<string, unknown> {
  if (decision.kind === "home") {
    return {
      status: "proposed",
      type: decision.destination.type,
      subtype: null,
      ref: decision.destination.ref,
      path: decision.destination.path,
      title: decision.destination.title,
      basis: decision.basis,
      placement_confidence: decision.placement_confidence,
      why: decision.why,
      candidates: [],
      by: "foo-discovery",
      actor: "agent",
      at: now,
    };
  }
  if (decision.kind === "hypothesis") {
    return {
      status: "proposed",
      type: "backlog",
      subtype: "hypothesis",
      ref: hypothesisId,
      path: "discovery/inbox/hypotheses.yaml",
      title: decision.claim,
      basis: "new_testable_claim",
      placement_confidence: decision.starting_confidence,
      why: decision.why,
      candidates: [],
      by: "foo-discovery",
      actor: "agent",
      at: now,
    };
  }
  return {
    status: "unverified",
    type: null,
    subtype: null,
    ref: null,
    path: null,
    title: null,
    basis: decision.kind === "unmatched" ? "emerging_cluster" : decision.reason,
    placement_confidence: "low",
    why: decision.why,
    candidates: decision.candidates.map(({ destination, score }) => ({
      type: destination.type,
      ref: destination.ref,
      path: destination.path,
      title: destination.title,
      score,
    })),
    by: "foo-discovery",
    actor: "agent",
    at: now,
  };
}

function eventHome(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const home = value as Record<string, unknown>;
  return {
    status: home.status ?? null,
    type: home.type ?? null,
    subtype: home.subtype ?? null,
    ref: home.ref ?? null,
    path: home.path ?? null,
    basis: home.basis ?? null,
  };
}

function routeCommand(root: string, args: string[], stdin: string, json: boolean, now: string): DiscoveryCommandOutcome {
  const auto = hasFlag(args, "--auto");
  const synthesisStdin = hasFlag(args, "--synthesis-stdin");
  if (auto === synthesisStdin) return invalid("Usage: foo discovery route (--auto | --synthesis-stdin) [--within inbox] [--finding F-123].", json, "E_DISCOVERY_VALIDATION");
  const within = flagValue(args, "--within");
  if (within && within !== "inbox") return invalid("Learning routing only walks the approved inbox; use --within inbox or omit the flag.", json, "E_DISCOVERY_VALIDATION");
  const findingFilter = flagValue(args, "--finding");
  if (synthesisStdin && findingFilter) return invalid("Synthesis takes its exact source finding set on stdin; do not combine it with --finding.", json, "E_DISCOVERY_VALIDATION");
  if (findingFilter && !/^F-\d{3}$/.test(findingFilter)) return invalid("--finding must be a canonical F-123 finding id.", json, "E_DISCOVERY_VALIDATION");
  const dir = inboxDir(root);
  const findingsFile = path.join(dir, "findings.yaml");
  const proposalsFile = path.join(dir, "proposals.yaml");
  const hypothesesFile = path.join(dir, "hypotheses.yaml");
  const hypothesesExisted = existsSync(hypothesesFile);
  if (!existsSync(findingsFile)) return invalid("The discovery inbox is missing.", json, "E_DISCOVERY_VALIDATION");
  const findingsDoc = parse(readFileSync(findingsFile, "utf8")) as { schema_version?: string; findings?: Array<Record<string, unknown>> };
  const proposalsDoc = existsSync(proposalsFile)
    ? parse(readFileSync(proposalsFile, "utf8")) as { proposals?: Array<Record<string, unknown>> }
    : { proposals: [] as Array<Record<string, unknown>> };
  const hypothesesDoc = existsSync(hypothesesFile)
    ? parse(readFileSync(hypothesesFile, "utf8")) as { schema_version?: string; hypotheses?: Array<Record<string, unknown>> }
    : { schema_version: "0.1", hypotheses: [] as Array<Record<string, unknown>> };
  findingsDoc.findings = Array.isArray(findingsDoc.findings) ? findingsDoc.findings : [];
  hypothesesDoc.hypotheses = Array.isArray(hypothesesDoc.hypotheses) ? hypothesesDoc.hypotheses : [];
  let repairedHypotheses = 0;
  let repairedReceipts = 0;
  let hypothesesChanged = false;
  if (auto) {
    const findingById = new Map(findingsDoc.findings.map((record) => [String(record.finding_id ?? ""), record]));
    const invalidAgentHypothesisIds = new Set<string>();
    hypothesesDoc.hypotheses = hypothesesDoc.hypotheses.filter((hypothesis) => {
      if (hypothesis.created_by !== "foo-discovery") return true;
      const sourceIds = Array.isArray(hypothesis.source_finding_ids) ? [...new Set(hypothesis.source_finding_ids.map(String))] : [];
      const sourceScopes = new Set(sourceIds.map((id) => findingById.get(id)?.inbox_scope_id).filter((id) => typeof id === "string" && id));
      if (sourceIds.length >= 2 && sourceScopes.size >= 2) return true;
      const hypothesisId = String(hypothesis.hypothesis_id ?? "");
      if (/^H-\d{3}$/.test(hypothesisId)) invalidAgentHypothesisIds.add(hypothesisId);
      repairedHypotheses += 1;
      hypothesesChanged = true;
      return false;
    });
    for (const record of findingsDoc.findings) {
      const home = record.primary_home as Record<string, unknown> | undefined;
      if (home?.actor !== "agent" || home.subtype !== "hypothesis" || !invalidAgentHypothesisIds.has(String(home.ref ?? ""))) continue;
      delete record.primary_home;
      repairedReceipts += 1;
    }
  }
  const proposalByFinding = new Map<string, Record<string, unknown>>();
  for (const proposal of Array.isArray(proposalsDoc.proposals) ? proposalsDoc.proposals : []) {
    for (const findingId of Array.isArray(proposal.source_finding_ids) ? proposal.source_finding_ids.map(String) : []) {
      if (!proposalByFinding.has(findingId)) proposalByFinding.set(findingId, proposal);
    }
  }
  const destinations = buildLearningDestinationCatalog(root);
  const records = findingsDoc.findings.filter((record) =>
    (!findingFilter || record.finding_id === findingFilter)
    && record.review_state === "needs_review",
  );
  if (findingFilter && records.length === 0) return invalid(`Review target ${findingFilter} was not found in the active inbox.`, json, "E_DISCOVERY_VALIDATION");

  const sharedTargetCounts = new Map<string, number>();
  for (const record of records) {
    if (record.primary_home) continue;
    const findingId = String(record.finding_id ?? "");
    const decision = routeLearning({ finding: record, proposal: proposalByFinding.get(findingId), destinations });
    if (decision.kind === "home" && decision.basis === "semantic") {
      sharedTargetCounts.set(decision.destination.path, (sharedTargetCounts.get(decision.destination.path) ?? 0) + 1);
    }
  }

  const decisions = new Map<string, LearningRouteDecision>();
  const clusterFindings: LearningClusterFinding[] = [];
  for (const record of records) {
    const findingId = String(record.finding_id ?? "");
    const proposal = proposalByFinding.get(findingId);
    const decision = routeLearning({ finding: record, proposal, destinations, sharedTargetCounts });
    decisions.set(findingId, decision);
    if (decision.kind !== "unmatched") continue;
    const clusterFinding = learningClusterFinding(record, proposal);
    if (clusterFinding) clusterFindings.push(clusterFinding);
  }
  const clusters = clusterUnmatchedLearnings(clusterFindings);

  if (synthesisStdin) {
    const synthesis = parseHypothesisSynthesis(stdin);
    if (!synthesis) return invalid("Hypothesis synthesis stdin must be one bounded JSON object with source IDs, claim, dissent, falsifier, next evidence, and low or medium confidence.", json, "E_DISCOVERY_VALIDATION");
    const requestedSources = [...new Set(synthesis.source_finding_ids)].sort();
    const cluster = clusters.find((candidate) => candidate.source_finding_ids.join("\n") === requestedSources.join("\n"));
    if (!cluster) return invalid("The source set does not name one eligible canonical signal cluster.", json, "E_DISCOVERY_VALIDATION");
    const validation = validateHypothesisSynthesis({ cluster, synthesis });
    if (!validation.ok) return invalid(`Hypothesis synthesis was refused: ${validation.reason}.`, json, "E_DISCOVERY_VALIDATION");

    const existing = hypothesesDoc.hypotheses.find((hypothesis) => {
      const sources = Array.isArray(hypothesis.source_finding_ids) ? [...new Set(hypothesis.source_finding_ids.map(String))].sort() : [];
      return sources.join("\n") === validation.value.source_finding_ids.join("\n");
    });
    if (existing) {
      const unchanged = existing.claim === validation.value.claim
        && existing.dissent === validation.value.dissent
        && existing.falsifier === validation.value.falsifier
        && existing.next_evidence === validation.value.next_evidence
        && existing.starting_confidence === validation.value.starting_confidence;
      if (!unchanged) return invalid("That corroborated source set already has a different Hypothesis; review it instead of overwriting history.", json, "E_DISCOVERY_INVALID_TRANSITION");
      return outcome(result("clean_no_op", {
        next_actions: ["This exact synthesized Hypothesis already exists in Backlog."],
        coverage: { hypothesis_id: existing.hypothesis_id, source_finding_ids: validation.value.source_finding_ids, actor: "agent" },
      }), json);
    }

    const sourceRecords = validation.value.source_finding_ids.map((findingId) =>
      records.find((record) => record.finding_id === findingId),
    );
    if (sourceRecords.some((record) => !record)) return invalid("Every Hypothesis source must remain in the active inbox.", json, "E_DISCOVERY_VALIDATION");
    const protectedHome = sourceRecords.some((record) => {
      const home = record?.primary_home as Record<string, unknown> | undefined;
      return home && (home.actor === "human" || typeof home.type === "string");
    });
    if (protectedHome) {
      return invalid("A contributing signal already has a human or verified primary home; preserve prior routing judgment.", json, "E_DISCOVERY_INVALID_TRANSITION");
    }

    const hypothesisId = nextNumberedId(hypothesesDoc.hypotheses, "hypothesis_id", "H");
    hypothesesDoc.hypotheses.push({
      hypothesis_id: hypothesisId,
      status: "untested",
      claim: validation.value.claim,
      source_finding_ids: validation.value.source_finding_ids,
      source_scope_ids: validation.value.source_scope_ids,
      why_new: `Synthesized from ${validation.value.source_scope_ids.length} independent calls that surfaced a shared unresolved pattern.`,
      dissent: validation.value.dissent,
      falsifier: validation.value.falsifier,
      next_evidence: validation.value.next_evidence,
      starting_confidence: validation.value.starting_confidence,
      created_by: "foo-discovery",
      created_at: now,
    });
    hypothesesDoc.hypotheses.sort((left, right) => String(left.hypothesis_id).localeCompare(String(right.hypothesis_id)));
    for (const record of sourceRecords as Array<Record<string, unknown>>) {
      record.primary_home = {
        status: "proposed",
        type: "backlog",
        subtype: "hypothesis",
        ref: hypothesisId,
        path: "discovery/inbox/hypotheses.yaml",
        url: `/admin?item=${hypothesisId}`,
        title: validation.value.claim,
        basis: "corroborated_signal_cluster",
        placement_confidence: validation.value.starting_confidence,
        why: `This finding contributes to a synthesis supported by ${validation.value.source_scope_ids.length} independent calls.`,
        candidates: [],
        by: "foo-discovery",
        actor: "agent",
        at: now,
      };
    }
    atomicWriteYamlBatch([
      { file: hypothesesFile, value: { schema_version: String(hypothesesDoc.schema_version ?? "0.1"), hypotheses: hypothesesDoc.hypotheses } },
      { file: findingsFile, value: { schema_version: String(findingsDoc.schema_version ?? "0.1"), findings: findingsDoc.findings } },
    ]);
    appendAgentEvent(dir, "com.adaptivespec.discovery.hypothesis_synthesized", `hypothesis:${hypothesisId}`, {
      hypothesis_id: hypothesisId,
      source_finding_ids: validation.value.source_finding_ids,
      source_scope_count: validation.value.source_scope_ids.length,
    }, now);
    return outcome(result("ok", {
      writes: [relative(root, hypothesesFile, hypothesesExisted ? "updated" : "created"), relative(root, findingsFile), relative(root, path.join(dir, "events.jsonl"))],
      next_actions: [`Open ${hypothesisId} in the existing Backlog and test the next evidence step.`],
      coverage: { hypothesis_id: hypothesisId, source_finding_ids: validation.value.source_finding_ids, independent_call_count: validation.value.source_scope_ids.length, actor: "agent" },
    }), json);
  }

  const emergingClusters = clusters.filter((cluster) => cluster.status === "emerging");
  const synthesizedSourceSets = new Set(hypothesesDoc.hypotheses.map((hypothesis) =>
    (Array.isArray(hypothesis.source_finding_ids) ? [...new Set(hypothesis.source_finding_ids.map(String))].sort() : []).join("\n"),
  ));
  const synthesisCandidates = clusters
    .filter((cluster) => cluster.status === "eligible_for_synthesis" && !synthesizedSourceSets.has(cluster.source_finding_ids.join("\n")))
    .map(clusterSummary);
  const counts = {
    home: 0,
    emerging: emergingClusters.reduce((count, cluster) => count + cluster.source_finding_ids.length, 0),
    synthesis_candidates: synthesisCandidates,
    unverified: 0,
    already_routed: 0,
    human_preserved: 0,
    repaired_hypotheses: repairedHypotheses,
    repaired_receipts: repairedReceipts,
    actor: "agent",
  };
  const eventRows: Array<{ findingId: string; receipt: Record<string, unknown> }> = [];
  for (const record of records) {
    const current = record.primary_home as Record<string, unknown> | undefined;
    if (current) {
      if (current.actor === "human") counts.human_preserved += 1;
      else counts.already_routed += 1;
      continue;
    }
    const findingId = String(record.finding_id ?? "");
    let decision = decisions.get(findingId)!;
    if (decision.kind === "unmatched") {
      if (learningClusterFinding(record, proposalByFinding.get(findingId))) continue;
      decision = {
        kind: "unverified",
        reason: "insufficient_evidence",
        candidates: decision.candidates,
        why: "This unmatched finding lacks the call identity or bounded signal text required for safe clustering.",
      };
    }
    if (decision.kind === "home") {
      counts.home += 1;
    } else {
      counts.unverified += 1;
    }
    const receipt = routeReceipt(decision, now);
    record.primary_home = receipt;
    eventRows.push({ findingId, receipt });
  }

  if (eventRows.length === 0 && repairedHypotheses === 0 && repairedReceipts === 0) {
    return outcome(result("clean_no_op", {
      next_actions: ["Every selected finding already has a route receipt; human corrections were preserved."],
      coverage: counts,
    }), json);
  }
  if (eventRows.length > 0 || repairedReceipts > 0) {
    atomicWriteYaml(findingsFile, { schema_version: String(findingsDoc.schema_version ?? "0.1"), findings: findingsDoc.findings });
  }
  if (hypothesesChanged) {
    atomicWriteYaml(hypothesesFile, { schema_version: String(hypothesesDoc.schema_version ?? "0.1"), hypotheses: hypothesesDoc.hypotheses });
  }
  for (const row of eventRows) {
    appendAgentEvent(dir, "com.adaptivespec.discovery.home_routed", `finding:${row.findingId}`, {
      finding_id: row.findingId,
      home: eventHome(row.receipt),
    }, now);
  }
  if (repairedHypotheses > 0 || repairedReceipts > 0) {
    appendAgentEvent(dir, "com.adaptivespec.discovery.hypothesis_routing_repaired", "inbox:hypotheses", {
      removed_single_source_hypotheses: repairedHypotheses,
      removed_agent_receipts: repairedReceipts,
    }, now);
  }
  return outcome(result("ok", {
    writes: [
      ...((eventRows.length > 0 || repairedReceipts > 0) ? [relative(root, findingsFile)] : []),
      ...(hypothesesChanged ? [relative(root, hypothesesFile, hypothesesExisted ? "updated" : "created")] : []),
      relative(root, path.join(dir, "events.jsonl")),
    ],
    next_actions: counts.unverified > 0
      ? [`${counts.unverified} route(s) remain Home not verified; review only those exceptions.`]
      : synthesisCandidates.length > 0
        ? [`Synthesize ${synthesisCandidates.length} corroborated cluster(s) in fresh language through --synthesis-stdin.`]
        : ["Unmatched single-call signals remain emerging until another independent call corroborates them."],
    coverage: counts,
  }), json);
}

function appendHumanEvent(dir: string, type: string, subject: string, by: string, data: Record<string, unknown>, now: string): void {
  const event = { specversion: "1.0", id: `evt_discovery_review_${Date.parse(now)}_${type.replace(/\W/g, "_")}`, source: "agent://foo/discovery", type, subject, time: now, actor: { type: "human", id: by }, data };
  appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

// Machine placement is not human judgment: auto-assignment events carry the
// agent actor so the audit trail says who decided (discovery-assign-verbs-v0
// D-002). The subject rides in the id because one batch writes many events at
// the same timestamp.
function appendAgentEvent(dir: string, type: string, subject: string, data: Record<string, unknown>, now: string): void {
  const event = { specversion: "1.0", id: `evt_discovery_${Date.parse(now)}_${type.replace(/\W/g, "_")}_${subject.replace(/\W/g, "_")}`, source: "agent://foo/discovery", type, subject, time: now, actor: { type: "agent", id: "foo-discovery" }, data };
  appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

// The dedupe-first bug engine, seeded from a signal (bug-owner-autolog-v0):
// reproduced ties to THAT issue, filed ties to the new one, anything else is
// an honest refusal message for the caller to surface.
function runSignalBugEngine(root: string, record: Record<string, unknown>): { ok: true; tie: { ref: string; url: string | null }; note: string } | { ok: false; message: string } {
  const engine = runBugLog({ env: process.env, gh: defaultGhExec, session: newBugLogSession(process.env, root), intake: buildSignalBugIntake(record), root });
  if (engine.status !== "reproduced" && engine.status !== "filed") {
    const detail = engine.errors[0]?.message ?? "the bug queue refused the filing";
    const resume = engine.next_actions[0] ?? "";
    return { ok: false, message: `The owner bug queue did not accept this signal: ${detail} ${resume}`.trim() };
  }
  if (engine.issue_number === null) {
    return { ok: false, message: `The bug queue accepted the filing but returned no issue number; check ${engine.issue_url ?? engine.repo ?? "the owner repository"} and rerun once gh output is readable.` };
  }
  return {
    ok: true,
    tie: { ref: String(engine.issue_number), url: engine.issue_url },
    note: engine.status === "reproduced"
      ? `This signal reproduces existing issue ${engine.issue_url}; the evidence was added there as a comment — nothing new was filed.`
      : `New issue filed in the owner bug queue: ${engine.issue_url} (dedupe searched open and closed issues first).`,
  };
}

// R-004: dismissal is not a dead end. A tie means the insight matters after
// all, so it clears the dismissal — on the ledger, with the human actor.
function undismissOnTie(dir: string, record: Record<string, unknown>, target: string, by: string, key: string | null, now: string, notes: string[]): void {
  if (record.review_state !== "dismissed") return;
  record.review_state = "needs_review";
  record.disposition = { by, at: now, action: "tie" };
  appendHumanEvent(dir, "com.adaptivespec.discovery.undismissed", `findings:${target}`, by, { target, reason: "tied", tie: key }, now);
  notes.push("This record was dismissed; tying it cleared the dismissal (it is back in needs_review).");
}

// Maps a reconciliation target_path to an assignable destination — a study id
// or `packet:<name>` — or null when the target is not a place work happens
// (research papers and loose documents are advice, not destinations; D-006).
function assignableDestination(root: string, targetPath: string): string | null {
  const packetMatch = /^specs\/([^/]+)\//.exec(targetPath);
  if (packetMatch) return specPacketDir(root, packetMatch[1]) ? `packet:${packetMatch[1]}` : null;
  const studyMatch = /^discovery\/([^/]+)\//.exec(targetPath);
  if (studyMatch && studyMatch[1] !== "inbox") {
    try {
      return loadDiscoveryRun(path.join(root, "discovery", studyMatch[1])).study_id;
    } catch {
      return null;
    }
  }
  return null;
}

// The signal inbox's catch-all discrimination, verbatim (customer-signal-inbox-v0
// D-010): a target claimed by more than five records is a catch-all attractor,
// not a relationship, and must not auto-assign. One threshold, two surfaces.
const CATCH_ALL_SHARED_MAX = 5;

// Maps a reconciliation target_path to a TIE (discovery-insight-ties-v0
// R-005): specs/ packets tie as `spec`, discovery studies as `study`, and —
// new under the ties model — research and idea documents are first-class tie
// targets. The catch-all shared-count gate still applies before this runs.
function autoTieFor(root: string, targetPath: string): { type: InsightTie["type"]; ref: string; url: string | null } | null {
  const destination = assignableDestination(root, targetPath);
  if (destination) {
    return destination.startsWith("packet:")
      ? { type: "spec", ref: destination.slice("packet:".length), url: tieUrlFor(root, "spec", destination.slice("packet:".length)) }
      : { type: "study", ref: destination, url: tieUrlFor(root, "study", destination) };
  }
  if (/^research\/[^/]+\.md$/.test(targetPath) && existsSync(path.join(root, targetPath))) return { type: "research", ref: targetPath, url: targetPath };
  if (/^ideas\/[^/]+\.md$/.test(targetPath) && existsSync(path.join(root, targetPath))) return { type: "idea", ref: targetPath, url: targetPath };
  return null;
}

function autoTieCommand(root: string, args: string[], json: boolean, now: string): DiscoveryCommandOutcome {
  if (!hasFlag(args, "--auto")) return invalid("Usage: foo discovery tie --auto [--within inbox]. The automatic pass is the only top-level mode; a person ties one record with foo discovery review <F-id> tie --bug|--spec <name>|--research <doc>|--idea <doc> --by <person>.", json, "E_DISCOVERY_VALIDATION");
  const within = flagValue(args, "--within");
  if (within && within !== "inbox") return invalid("Auto-tie walks the unassigned-call inbox; rerun with --within inbox or drop the flag.", json, "E_DISCOVERY_VALIDATION");
  const findingsFile = path.join(inboxDir(root), "findings.yaml");
  if (!existsSync(findingsFile)) return invalid("The discovery inbox is missing.", json, "E_DISCOVERY_VALIDATION");
  const doc = parse(readFileSync(findingsFile, "utf8")) as { schema_version: string; findings?: Array<Record<string, unknown>> };
  const findings = doc.findings ?? [];

  // Shared-count per target across the WHOLE file, mirroring the signal-inbox
  // server: a catch-all is a property of the batch, not of one record.
  const inboxSelfPath = "discovery/inbox/findings.yaml";
  const targetCounts = new Map<string, number>();
  for (const record of findings) {
    const reconciliation = record.reconciliation as Record<string, unknown> | undefined;
    const targetPath = typeof reconciliation?.target_path === "string" ? reconciliation.target_path : null;
    if (targetPath && targetPath !== inboxSelfPath) targetCounts.set(targetPath, (targetCounts.get(targetPath) ?? 0) + 1);
  }

  const counts = { tied: 0, migrated: 0, already_placed: 0, weak: 0, catch_all: 0, no_home: 0 };
  for (const record of findings) {
    // R-002: the auto pass doubles as the migration sweep for every record.
    if (migrateRecordTies(root, record)) counts.migrated += 1;
    if (record.review_state !== "needs_review" || record.attached_to || peekTies(record).length > 0) {
      counts.already_placed += 1;
      continue;
    }
    const reconciliation = record.reconciliation as Record<string, unknown> | undefined;
    const targetPath = typeof reconciliation?.target_path === "string" ? reconciliation.target_path : null;
    if (!targetPath || targetPath === inboxSelfPath) {
      counts.no_home += 1;
      continue;
    }
    const confidence = typeof reconciliation?.confidence === "string" ? reconciliation.confidence : null;
    if (confidence !== "medium" && confidence !== "high") {
      counts.weak += 1;
      continue;
    }
    const shared = targetCounts.get(targetPath) ?? 0;
    if (shared > CATCH_ALL_SHARED_MAX) {
      counts.catch_all += 1;
      continue;
    }
    const target = autoTieFor(root, targetPath);
    if (!target) {
      counts.no_home += 1;
      continue;
    }
    recordTies(record).push({ type: target.type, ref: target.ref, url: target.url, by: "foo-discovery", actor: "agent", at: now });
    appendAgentEvent(inboxDir(root), "com.adaptivespec.discovery.tied", `finding:${String(record.finding_id)}`, { type: target.type, ref: target.ref, url: target.url, target_path: targetPath, confidence, shared_count: shared }, now);
    counts.tied += 1;
  }

  const wrote = counts.tied > 0 || counts.migrated > 0;
  const writes: DiscoveryWrite[] = [];
  if (wrote) {
    writeFileSync(findingsFile, stringify(doc));
    writes.push(relative(root, findingsFile));
    if (counts.tied > 0) writes.push(relative(root, path.join(inboxDir(root), "events.jsonl")));
  }
  return outcome(result(wrote ? "ok" : "clean_no_op", {
    writes,
    next_actions: counts.tied > 0
      ? ["Ties are links, not filings: add one with foo discovery review <F-id> tie --bug|--spec <name>|--research <doc>|--idea <doc> --by <person>, remove one with untie, or file evidence with attach."]
      : counts.migrated > 0
        ? [`Legacy pointers on ${counts.migrated} record(s) were folded into ties (findings.yaml was rewritten); no unplaced record had a genuine match, so nothing new was tied.`]
        : ["No unplaced record has a genuine match; weak, catch-all, and no-home signals stay untied for a person."],
    coverage: { ...counts, actor: "agent", catch_all_shared_max: CATCH_ALL_SHARED_MAX, evidence_copied: false },
  }), json);
}

// --- Contact cards (discovery-insight-ties-v0 R-007/R-008) --------------------
// Per-scope human-corrected identity: full name, LinkedIn, company. The
// original attribution basis is never overwritten — the card layers on top.
// Inference is LOCAL context only; candidates are returned, never written.

type ContactCard = { scope_id: string; full_name: string | null; linkedin: string | null; company: string | null; title: string | null; confirmed_by: string | null; confirmed_at: string | null; candidates?: ContactCandidate[] };

function contactsFile(root: string): string {
  return path.join(inboxDir(root), "contacts.yaml");
}

function loadContacts(root: string): { schema_version: string; contacts: ContactCard[] } {
  if (!existsSync(contactsFile(root))) return { schema_version: "0.1", contacts: [] };
  const doc = parse(readFileSync(contactsFile(root), "utf8")) as { schema_version?: string; contacts?: ContactCard[] };
  return { schema_version: String(doc.schema_version ?? "0.1"), contacts: Array.isArray(doc.contacts) ? doc.contacts : [] };
}

export { isValidLinkedinUrl } from "./discoverySources.js";

type ContactCandidate = { field: "full_name" | "company" | "title" | "linkedin"; value: string; inferred: true; source: string };

// "And if you give one, can infer the rest" — from LOCAL call context only:
// scope metadata and this scope's findings text. No web lookups (D-008).
function inferContactCandidates(scope: InboxScope, scopeFindings: Array<Record<string, unknown>>): { candidates: ContactCandidate[]; missing: Array<{ field: string; reason: string }> } {
  const candidates: ContactCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: ContactCandidate): void => {
    const key = `${candidate.field}:${candidate.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const namePattern = /\b([A-Z][a-z]+(?: [A-Z][a-zA-Z'’-]+)+)\s+(?:of|at|from)\s+([A-Z][A-Za-z0-9&.'’-]*(?: [A-Z][A-Za-z0-9&.'’-]*){0,3})/g;
  // Title statements the call content itself makes ("technical co-founder",
  // "VP of operations") — a conservative vocabulary, because every candidate
  // is a suggestion a person reads (discovery-contact-capture-v0 R-005/R-006).
  const titlePattern = /\b(technical co-founder|co-founder|founder|chief (?:executive|technology|product|operating|financial) officer|CEO|CTO|CPO|COO|CFO|president|general manager|managing director|(?:vp|vice president) of [a-z]+|head of [a-z]+|director of [a-z]+|product manager|engineering manager|technology lead)\b/gi;
  for (const record of scopeFindings) {
    for (const [fieldName, text] of [["paraphrase", record.paraphrase], ["dissent", record.dissent]] as const) {
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(namePattern)) {
        const source = `finding:${String(record.finding_id)} ${fieldName}`;
        add({ field: "full_name", value: match[1], inferred: true, source });
        add({ field: "company", value: match[2].replace(/[.,;:]$/, ""), inferred: true, source });
      }
      for (const match of text.matchAll(titlePattern)) {
        add({ field: "title", value: match[1], inferred: true, source: `finding:${String(record.finding_id)} ${fieldName}` });
      }
      for (const url of text.match(/https:\/\/[^\s"'<>)]+/g) ?? []) {
        if (isValidLinkedinUrl(url)) add({ field: "linkedin", value: url, inferred: true, source: `finding:${String(record.finding_id)} ${fieldName}` });
      }
    }
  }
  for (const participant of scope.participant_allowlist ?? []) {
    if (/^[A-Z][a-z]+(?: [A-Z][a-zA-Z'’-]+)+$/.test(participant)) {
      add({ field: "full_name", value: participant, inferred: true, source: "scope:participant_allowlist" });
    }
  }
  // Scope ids carry name tokens between the provider prefix and date tokens
  // (granola_chris_exampletn_2026_07 -> "Chris Exampletn").
  const idTokens = scope.scope_id.split("_").slice(1).filter((token) => !/^\d+$/.test(token) && !/^q\d$/.test(token));
  if (idTokens.length >= 1 && candidates.every((candidate) => candidate.field !== "full_name")) {
    add({ field: "full_name", value: idTokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" "), inferred: true, source: "scope:scope_id" });
  }
  for (const token of scope.title_tokens ?? []) {
    if (/^[A-Za-z][A-Za-z0-9&.-]+$/.test(token) && token.length >= 3) {
      add({ field: "company", value: token, inferred: true, source: "scope:title_tokens" });
    }
  }
  for (const domain of (scope.domain_allowlist ?? [])) {
    const base = domain.replace(/^@/, "").split(".")[0];
    if (base) add({ field: "company", value: base.charAt(0).toUpperCase() + base.slice(1), inferred: true, source: "scope:domain_allowlist" });
  }

  const missing: Array<{ field: string; reason: string }> = [];
  for (const field of ["full_name", "company", "title", "linkedin"] as const) {
    if (candidates.some((candidate) => candidate.field === field)) continue;
    missing.push({
      field,
      reason: field === "linkedin"
        ? "no linkedin.com URL appears in this scope's local call context; the CLI never looks it up on the web (web enrichment is a deliberate future decision owned by the research boundary)"
        : field === "title"
          ? "nothing in this scope's local call context states a title"
          : `nothing in this scope's local call context names a ${field === "full_name" ? "person" : "company"}`,
    });
  }
  return { candidates, missing };
}

// --- Persisted candidates (discovery-contact-capture-v0 R-002/R-004) ----------
// Ingest-time and sweep capture land here: inferred suggestions stored on the
// card BENEATH the human-confirmed fields. Never auto-confirmed, never
// overwriting, deduped by (field, value), and scrubbed one more time so no
// email or phone number can reach the committed file.

const CANDIDATE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const CANDIDATE_PHONE = /\+?\d[\d\s().-]{7,}\d/;

function safeContactCandidate(candidate: ContactCandidate): boolean {
  const value = candidate.value.trim();
  if (!value) return false;
  if (CANDIDATE_EMAIL.test(value) || CANDIDATE_PHONE.test(value)) return false;
  if (candidate.field === "linkedin" && !isValidLinkedinUrl(value)) return false;
  return true;
}

function emptyContactCard(scopeId: string): ContactCard {
  return { scope_id: scopeId, full_name: null, linkedin: null, company: null, title: null, confirmed_by: null, confirmed_at: null };
}

function saveContacts(root: string, contacts: ContactCard[]): void {
  contacts.sort((a, b) => (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0));
  writeFileSync(contactsFile(root), stringify({ schema_version: "0.1", contacts }));
}

// Returns the number of candidates actually added (0 = clean no-op, nothing
// written). Confirmed fields are never touched by this path.
function recordContactCandidates(root: string, scopeId: string, proposed: ContactCandidate[], now: string): { added: number; writes: DiscoveryWrite[] } {
  const safe = proposed.filter(safeContactCandidate);
  if (safe.length === 0) return { added: 0, writes: [] };
  const existing = loadContacts(root);
  const card = existing.contacts.find((candidate) => candidate.scope_id === scopeId) ?? null;
  const target = card ?? emptyContactCard(scopeId);
  const candidates = Array.isArray(target.candidates) ? target.candidates : [];
  const seen = new Set(candidates.map((candidate) => `${candidate.field}:${candidate.value.trim().toLowerCase()}`));
  let added = 0;
  for (const candidate of safe) {
    const key = `${candidate.field}:${candidate.value.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ field: candidate.field, value: candidate.value.trim(), inferred: true, source: candidate.source });
    added += 1;
  }
  if (added === 0) return { added: 0, writes: [] };
  target.candidates = candidates;
  const contactsExisted = existsSync(contactsFile(root));
  const contacts = existing.contacts.filter((candidate) => candidate.scope_id !== scopeId);
  contacts.push(target);
  saveContacts(root, contacts);
  const fields = [...new Set(safe.map((candidate) => candidate.field))];
  appendAgentEvent(inboxDir(root), "com.adaptivespec.discovery.contact_candidates_recorded", `scope:${scopeId}`, { scope_id: scopeId, added, fields }, now);
  return { added, writes: [relative(root, contactsFile(root), contactsExisted ? "updated" : "created"), relative(root, path.join(inboxDir(root), "events.jsonl"))] };
}

// Everything a matched session's metadata states about the contact: hints the
// adapter derived (display strings, email DOMAINS, provider titles/profiles)
// plus person-name participant labels. Email-shaped labels never survive —
// contactHintsFromDisplayLabel drops them and safeContactCandidate scrubs
// again (R-004).
function sessionContactCandidates(session: DiscoverySession): ContactCandidate[] {
  const hints: SessionContactHint[] = [...(session.contact_hints ?? [])];
  for (const participant of session.participants) {
    hints.push(...contactHintsFromDisplayLabel(participant, `${session.provider}:participant`));
  }
  return dedupeContactHints(hints).map((hint) => ({ field: hint.field, value: hint.value, inferred: true as const, source: hint.source }));
}

function contactCommand(root: string, args: string[], json: boolean, now: string): DiscoveryCommandOutcome {
  if (hasFlag(args, "--sweep")) {
    // R-006 (discovery-contact-capture-v0): one-shot backfill over data
    // already on disk — scope labels, scope-id tokens, title tokens, domain
    // allowlists, findings attribution text. No provider calls; rerun is a
    // clean no-op; confirmed fields are never touched.
    const scopesDoc = parse(readFileSync(path.join(inboxDir(root), "scope.yaml"), "utf8")) as { scopes?: InboxScope[] };
    const scopes = scopesDoc.scopes ?? [];
    const findingsDoc = parse(readFileSync(path.join(inboxDir(root), "findings.yaml"), "utf8")) as { findings?: Array<Record<string, unknown>> };
    const allFindings = findingsDoc.findings ?? [];
    let candidatesAdded = 0;
    let scopesUpdated = 0;
    const sweepWrites = new Map<string, DiscoveryWrite>();
    for (const scope of scopes) {
      const scopeFindings = allFindings.filter((record) => record.inbox_scope_id === scope.scope_id);
      const inference = inferContactCandidates(scope, scopeFindings);
      const recorded = recordContactCandidates(root, scope.scope_id, inference.candidates, now);
      if (recorded.added > 0) {
        candidatesAdded += recorded.added;
        scopesUpdated += 1;
        for (const write of recorded.writes) sweepWrites.set(write.path, write);
      }
    }
    return outcome(result(candidatesAdded > 0 ? "ok" : "clean_no_op", {
      writes: [...sweepWrites.values()],
      next_actions: candidatesAdded > 0
        ? [`Swept ${scopes.length} scope(s): ${candidatesAdded} inferred candidate(s) recorded on ${scopesUpdated} contact card(s). Nothing was confirmed — a person confirms a value with foo discovery contact <scope-id> --name|--company|--title|--linkedin <value> --by <person>.`]
        : ["Every contact card already carries its local candidates; nothing new on disk to sweep."],
      coverage: { scopes: scopes.length, scopes_updated: scopesUpdated, candidates_added: candidatesAdded, provider_calls: 0, confirmed_fields_touched: 0, sources: "local_disk_only" },
    }), json);
  }
  const scopeId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (!scopeId) return invalid("Usage: foo discovery contact <scope-id> [--name <text>] [--linkedin <url>] [--company <text>] [--title <text>] --by <person> | --infer [--json], or foo discovery contact --sweep [--json]", json, "E_DISCOVERY_VALIDATION");
  let scope: InboxScope;
  try {
    scope = inboxScope(root, `inbox:${scopeId}`);
  } catch {
    return invalid(`Scope ${scopeId} was not found in discovery/inbox/scope.yaml. Check the scope id, then rerun foo discovery contact <scope-id>.`, json, "E_DISCOVERY_VALIDATION");
  }
  const existing = loadContacts(root);
  const card = existing.contacts.find((candidate) => candidate.scope_id === scopeId) ?? null;

  if (hasFlag(args, "--infer")) {
    const findingsDoc = parse(readFileSync(path.join(inboxDir(root), "findings.yaml"), "utf8")) as { findings?: Array<Record<string, unknown>> };
    const scopeFindings = (findingsDoc.findings ?? []).filter((record) => record.inbox_scope_id === scopeId);
    const inference = inferContactCandidates(scope, scopeFindings);
    // Stored candidates — captured at ingest (provider metadata), apply
    // (envelope), or by the sweep — surface beside freshly derived ones.
    const merged: ContactCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of [...(card?.candidates ?? []), ...inference.candidates]) {
      const key = `${candidate.field}:${candidate.value.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
    }
    const missing = inference.missing.filter((entry) => !merged.some((candidate) => candidate.field === entry.field));
    return outcome(result("ok", {
      next_actions: [
        ...merged.map((candidate) => `Candidate ${candidate.field}: "${candidate.value}" (inferred from ${candidate.source}). Confirm it: foo discovery contact ${scopeId} --${candidate.field === "full_name" ? "name" : candidate.field} "${candidate.value}" --by <person>`),
        ...missing.map((entry) => `No ${entry.field} candidate: ${entry.reason}.`),
      ],
      coverage: { scope_id: scopeId, card, candidates: merged, missing, sources: "local_call_context_only", written: false },
    }), json);
  }

  const by = flagValue(args, "--by");
  if (!by?.trim()) return invalid(`Editing the contact card requires --by <person>: foo discovery contact ${scopeId} --name <text> --by <person>.`, json, "E_DISCOVERY_VALIDATION");
  const name = flagValue(args, "--name");
  const linkedin = flagValue(args, "--linkedin");
  const company = flagValue(args, "--company");
  const title = flagValue(args, "--title");
  if (!name && !linkedin && !company && !title) return invalid(`Nothing to update: pass at least one of --name <text>, --linkedin <url>, --company <text>, --title <text> (or --infer to see candidates).`, json, "E_DISCOVERY_VALIDATION");
  if (linkedin && !isValidLinkedinUrl(linkedin)) {
    return invalid(`The LinkedIn value must be an https URL on a linkedin.com host. Fix it, then rerun foo discovery contact ${scopeId} --linkedin <url> --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
  }
  const updated: ContactCard = card ?? emptyContactCard(scopeId);
  const fields: string[] = [];
  if (name) { updated.full_name = name; fields.push("full_name"); }
  if (linkedin) { updated.linkedin = linkedin; fields.push("linkedin"); }
  if (company) { updated.company = company; fields.push("company"); }
  if (title) { updated.title = title; fields.push("title"); }
  // Human confirmation stamp: the card is the corrected identity layer; the
  // attribution basis of the call match is never touched by this file.
  updated.confirmed_by = by;
  updated.confirmed_at = now;
  const contacts = existing.contacts.filter((candidate) => candidate.scope_id !== scopeId);
  contacts.push(updated);
  contacts.sort((a, b) => (a.scope_id < b.scope_id ? -1 : a.scope_id > b.scope_id ? 1 : 0));
  writeFileSync(contactsFile(root), stringify({ schema_version: "0.1", contacts }));
  appendHumanEvent(inboxDir(root), "com.adaptivespec.discovery.contact_updated", `scope:${scopeId}`, by, { scope_id: scopeId, fields }, now);
  return outcome(result("ok", {
    writes: [relative(root, contactsFile(root), card ? "updated" : "created"), relative(root, path.join(inboxDir(root), "events.jsonl"))],
    next_actions: [`Contact card for ${scopeId} updated (${fields.join(", ")}). The call's original attribution basis is unchanged; this card is the human-corrected identity.`],
    coverage: { scope_id: scopeId, fields_updated: fields, confirmed_by: by },
  }), json);
}

function reviewCommand(root: string, args: string[], json: boolean, now: string): DiscoveryCommandOutcome {
  const target = args[1];
  // `assign` on one finding is the same human correction as `reassign` —
  // the owner's phrasing ("assigned as a bug") is accepted verbatim.
  const action = args[2] === "assign" ? "reassign" : args[2];
  const by = flagValue(args, "--by");
  if (!target || !action || !by?.trim()) return invalid("Discovery review requires a target, action, and --by <person>.", json, "E_DISCOVERY_INVALID_TRANSITION");
  if (action === "complete") {
    try {
      const dir = study(root, target);
      const writes = transitionDiscoveryRun(dir, "complete", { type: "human", id: by }, now);
      return outcome(result("ok", { study_id: target, writes, next_actions: ["Study completed by a person."], coverage: { human_transition: true } }), json);
    } catch { return invalid("Only a needs-review study can be completed.", json, "E_DISCOVERY_INVALID_TRANSITION", target); }
  }
  if (action === "select-source") {
    const studyDir = locateStudy(root, target);
    if (studyDir) {
      const fingerprint = flagValue(args, "--fingerprint");
      const matchFile = path.join(localRoot(root), localTargetName(target), "match.json");
      if (!fingerprint || !existsSync(matchFile)) return invalid("Study source selection requires one locally listed --fingerprint.", json, "E_DISCOVERY_INVALID_TRANSITION", target);
      let candidates: Array<{ candidate_index: number; source_fingerprint: string; session: DiscoverySession }> = [];
      try {
        const matchDoc = JSON.parse(readFileSync(matchFile, "utf8")) as { candidates?: typeof candidates };
        candidates = Array.isArray(matchDoc.candidates) ? matchDoc.candidates : [];
      } catch {
        return invalid("The local ambiguous-match record is invalid; repeat metadata matching.", json, "E_DISCOVERY_VALIDATION", target);
      }
      const selected = candidates.find((candidate) => candidate.source_fingerprint === fingerprint);
      if (!selected) return invalid("The selected source fingerprint is not one of the ambiguous candidates.", json, "E_DISCOVERY_INVALID_TRANSITION", target);
      const run = loadDiscoveryRun(studyDir);
      if (!["ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof"].includes(run.state)) return invalid("This study is not awaiting source selection.", json, "E_DISCOVERY_INVALID_TRANSITION", target);
      writeFileSync(matchFile, `${JSON.stringify({ schema_version: "0.1", candidates: [selected] }, null, 2)}\n`, { mode: 0o600 });
      appendHumanEvent(studyDir, "com.adaptivespec.discovery.source_selected", `study:${target}`, by, { source_fingerprint: fingerprint }, now);
      const authorized = authorizeDiscoverySource({ study_dir: studyDir, local_root: localRoot(root), study_id: target, study_state: run.state, match_status: "unique", session: selected.session, now });
      const eventWrite = relative(root, path.join(studyDir, "events.jsonl"));
      const matchWrite = relative(root, matchFile);
      if (authorized.status === "ready_to_synthesize") {
        const writes = [...transitionIfNeeded(studyDir, "ready_to_synthesize", now), eventWrite, matchWrite];
        return outcome(result("ok", { study_id: target, writes, next_actions: ["Open only the selected source through the authorized runtime path."], coverage: { human_source_selection: true, proof: "ready", transcript_opened: false } }), json);
      }
      const status = authorized.status as DiscoveryCommandStatus;
      if (status === "invalid") purgeDiscoveryLocalState(localRoot(root), target);
      const code: Record<string, DiscoveryErrorCode> = {
        needs_source_approval: "E_DISCOVERY_SOURCE_APPROVAL",
        needs_provider_access: "E_DISCOVERY_PROVIDER_ACCESS",
        needs_provider_connector: "E_DISCOVERY_PROVIDER_CONNECTOR",
        needs_research_proof: "E_DISCOVERY_RESEARCH_PROOF",
      };
      const writes = status !== "invalid" ? [...transitionIfNeeded(studyDir, status as DiscoveryLifecycle, now), eventWrite, matchWrite] : [eventWrite];
      return outcome(result(status, { study_id: target, writes, errors: [{ code: code[status] ?? "E_DISCOVERY_VALIDATION", message: "The selected source is recorded, but a transcript prerequisite is missing." }], handoff: authorized.handoff ?? null, coverage: { human_source_selection: true, transcript_opened: false } }), json);
    }
  }
  const locatedRecords = findYamlRecords(root, target, flagValue(args, "--within"));
  if (locatedRecords.length === 0) return invalid(`Review target ${target} was not found.`, json, "E_DISCOVERY_VALIDATION");
  if (locatedRecords.length > 1) return invalid(`Review target ${target} is ambiguous; rerun with --within <study-id|inbox>.`, json, "E_DISCOVERY_INVALID_TRANSITION");
  const located = locatedRecords[0];
  const extraWrites: DiscoveryWrite[] = [];
  let reassignFrom: string | null = null;
  let reassignTo: string | null = null;
  let reassignIssueUrl: string | null = null;
  let tieEvent: { type: string; data: Record<string, unknown> } | null = null;
  const reassignNotes: string[] = [];
  if (action === "promote") {
    const destination = flagValue(args, "--destination");
    if (located.key !== "proposals" || !destination || !/^(?:R|D)-\d{3}$/.test(destination)) return invalid("Promotion requires a proposal and --destination <R-000|D-000>.", json, "E_DISCOVERY_INVALID_TRANSITION");
    Object.assign(located.record, { state: "promoted", destination, disposition: { by, at: now, action: "promote" } });
  } else if (action === "dismiss") {
    if (located.key === "proposals") Object.assign(located.record, { state: "dismissed", disposition: { by, at: now, action: "dismiss" } });
    else Object.assign(located.record, { review_state: "dismissed", disposition: { by, at: now, action: "dismiss" } });
  } else if (action === "attach") {
    let studyId = flagValue(args, "--study");
    let packetName = flagValue(args, "--packet");
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox" || located.record.lane !== "unassigned_call_evidence") return invalid("Attachment requires an inbox finding and --study <id> or --packet <packet-name>.", json, "E_DISCOVERY_INVALID_TRANSITION");
    if (studyId && packetName) return invalid(`Attach takes one destination: rerun with either --study ${studyId} or --packet ${packetName}, not both.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    if (!studyId && !packetName) {
      // Ties are the default state; attach with no destination is the
      // deliberate confirmation that files to the record's one fileable tie.
      migrateRecordTies(root, located.record);
      const ties = recordTies(located.record);
      const fileable = ties.filter((tie) => tie.type === "spec" || tie.type === "study");
      if (fileable.length === 0) {
        const bugTies = ties.filter((tie) => tie.type === "bug");
        if (bugTies.length > 0) return invalid(`This finding is filed in the owner bug queue (${bugTies.map(tieKey).join(", ")}); there is no attach step for bug ties. To file it into repository work too, run foo discovery review ${target} tie --spec <name> --by ${by} (the GitHub issue is not closed by anything here), then rerun attach.`, json, "E_DISCOVERY_INVALID_TRANSITION");
        return invalid(`This finding has no spec or study tie to file to, so attach needs a destination: foo discovery review ${target} attach --study <id> --by ${by} or --packet <packet-name> — or tie it first with foo discovery review ${target} tie --spec <name> --by ${by}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      }
      if (fileable.length > 1) return invalid(`This finding is tied to several fileable destinations (${fileable.map(tieKey).join(", ")}); name the one to file into: foo discovery review ${target} attach --study <id> --by ${by} or --packet <packet-name>.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      if (fileable[0].type === "spec") packetName = fileable[0].ref;
      else studyId = fileable[0].ref;
    }
    if (located.record.attached_to) return invalid(`This inbox finding is already attached to ${String(located.record.attached_to)}. Undo it first: foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    const originalFindingId = String(located.record.finding_id);
    if (packetName) {
      const packetDir = specPacketDir(root, packetName);
      if (!packetDir) return invalid(`Spec packet ${packetName} was not found under specs/. Attach never creates a packet; create it first (foo asp init specs/${packetName}), then rerun foo discovery review ${target} attach --packet ${packetName} --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      Object.assign(located.record, { attached_to: `packet:${packetName}`, review_state: "attached", disposition: { by, at: now, action: "attach" } });
      migrateRecordTies(root, located.record); // the filing confirms the tie (R-004 of the assign packet, ties edition)
      const evidenceFile = path.join(packetDir, "evidence.yaml");
      const evidenceExisted = existsSync(evidenceFile);
      const evidenceDoc = evidenceExisted
        ? parse(readFileSync(evidenceFile, "utf8")) as { schema_version: string; findings?: Array<Record<string, unknown>> }
        : { schema_version: "0.1", findings: [] as Array<Record<string, unknown>> };
      evidenceDoc.findings = evidenceDoc.findings ?? [];
      const attachedFindingId = nextFindingId(evidenceDoc.findings);
      evidenceDoc.findings.push({ ...stripPlacement(located.record), finding_id: attachedFindingId, original_finding_id: originalFindingId, original_lane: "unassigned_call_evidence", review_state: "needs_review" });
      writeFileSync(evidenceFile, stringify(evidenceDoc));
      appendHumanEvent(packetDir, "com.adaptivespec.discovery.inbox_attached", `finding:${attachedFindingId}`, by, { original_finding_id: originalFindingId, inbox: "discovery/inbox", packet: packetName }, now);
      extraWrites.push(relative(root, evidenceFile, evidenceExisted ? "updated" : "created"), relative(root, path.join(packetDir, "events.jsonl")));
    } else {
      Object.assign(located.record, { attached_to: studyId, review_state: "attached", disposition: { by, at: now, action: "attach" } });
      migrateRecordTies(root, located.record); // the filing confirms the tie
      const targetDir = study(root, studyId!);
      const targetFile = path.join(targetDir, "findings.yaml");
      const targetDoc = parse(readFileSync(targetFile, "utf8")) as { schema_version: string; findings: Array<Record<string, unknown>> };
      const attachedFindingId = nextFindingId(targetDoc.findings);
      targetDoc.findings.push({ ...stripPlacement(located.record), finding_id: attachedFindingId, original_finding_id: originalFindingId, original_lane: "unassigned_call_evidence", review_state: "needs_review" });
      writeFileSync(targetFile, stringify(targetDoc));
      appendHumanEvent(targetDir, "com.adaptivespec.discovery.inbox_attached", `finding:${attachedFindingId}`, by, { original_finding_id: originalFindingId, inbox: "discovery/inbox" }, now);
      extraWrites.push(relative(root, targetFile), relative(root, path.join(targetDir, "events.jsonl")));
    }
  } else if (action === "detach") {
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Detach undoes a prior attach of an inbox finding; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    const attachedTo = typeof located.record.attached_to === "string" && located.record.attached_to ? located.record.attached_to : null;
    if (!attachedTo) return invalid(`This inbox finding is not attached, so there is nothing to undo. To file it, run foo discovery review ${target} attach --study <id> --by ${by} or foo discovery review ${target} attach --packet <packet-name> --by ${by}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    const isPacketDestination = attachedTo.startsWith("packet:");
    let targetDir: string;
    let workingFile: string;
    if (isPacketDestination) {
      const packetName = attachedTo.slice("packet:".length);
      const packetDir = specPacketDir(root, packetName);
      if (!packetDir) return invalid(`Spec packet ${packetName} is missing under specs/, so its attached copy cannot be removed. Restore the packet directory, then rerun foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      targetDir = packetDir;
      workingFile = path.join(packetDir, "evidence.yaml");
    } else {
      const studyDir = locateStudy(root, attachedTo);
      if (!studyDir) return invalid(`Study ${attachedTo} is missing, so its attached copy cannot be removed. Restore the study directory, then rerun foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      targetDir = studyDir;
      workingFile = path.join(studyDir, "findings.yaml");
    }
    const workingLabel = `${path.basename(path.dirname(workingFile))}/${path.basename(workingFile)}`;
    if (!existsSync(workingFile)) return invalid(`The attached copy of ${target} was not found: ${workingLabel} is missing. Resolve manually — mark the inbox record yourself (foo discovery review ${target} dismiss --by ${by} --within inbox) or restore ${workingLabel} from history, then rerun foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_MANUAL_RESOLUTION");
    const workingDoc = parse(readFileSync(workingFile, "utf8")) as { schema_version: string; findings?: Array<Record<string, unknown>> };
    const copies = (workingDoc.findings ?? []).filter((finding) => finding.original_finding_id === String(located.record.finding_id));
    if (copies.length === 0) return invalid(`The attached copy of ${target} is no longer in ${workingLabel}. Resolve manually — mark the inbox record yourself (foo discovery review ${target} dismiss --by ${by} --within inbox) or restore the copy from history, then rerun foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_MANUAL_RESOLUTION");
    const copy = copies[0];
    // Provenance comparison (D-002): the copy was written as the inbox record
    // plus exactly these provenance fields. Any other difference is a human
    // edit, and undo must not destroy human edits.
    const expectedCopy = { ...stripPlacement(located.record), finding_id: copy.finding_id, original_finding_id: String(located.record.finding_id), original_lane: "unassigned_call_evidence", review_state: "needs_review" };
    if (canonicalJson(stripPlacement(copy)) !== canonicalJson(expectedCopy)) {
      return invalid(`The attached copy in ${workingLabel} was edited by a person after it was attached; detach will not destroy those edits. Resolve manually — keep the edits and mark the inbox record yourself (foo discovery review ${target} dismiss --by ${by} --within inbox), or restore the copy to its attached form and rerun foo discovery review ${target} detach --by ${by}.`, json, "E_DISCOVERY_MANUAL_RESOLUTION");
    }
    workingDoc.findings = (workingDoc.findings ?? []).filter((finding) => finding !== copy);
    writeFileSync(workingFile, stringify(workingDoc));
    appendHumanEvent(targetDir, "com.adaptivespec.discovery.inbox_detached", `finding:${String(copy.finding_id)}`, by, { original_finding_id: String(located.record.finding_id), detached_from: attachedTo, restored_to: "discovery/inbox" }, now);
    Object.assign(located.record, { attached_to: null, review_state: "needs_review", disposition: { by, at: now, action: "detach" } });
    extraWrites.push(relative(root, workingFile), relative(root, path.join(targetDir, "events.jsonl")));
  } else if (action === "move-home") {
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Move changes an inbox finding's primary home; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    const idea = flagValue(args, "--idea");
    const research = flagValue(args, "--research");
    const backlog = flagValue(args, "--backlog");
    const hypothesis = flagValue(args, "--hypothesis");
    if ([idea, research, backlog, hypothesis].filter(Boolean).length !== 1) {
      return invalid(`Move takes exactly one primary home: --idea <doc>, --research <doc>, --backlog <packet>, or --hypothesis <H-id>.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    let destination: LearningDestination | undefined;
    let subtype: "hypothesis" | null = null;
    if (idea) {
      const ref = resolveDocRef(root, "ideas", idea);
      if (ref) destination = buildLearningDestinationCatalog(root).find((candidate) => candidate.type === "idea" && candidate.path === ref);
    } else if (research) {
      const ref = resolveDocRef(root, "research", research);
      if (ref) destination = buildLearningDestinationCatalog(root).find((candidate) => candidate.type === "research" && candidate.path === ref);
    } else if (backlog) {
      if (specPacketDir(root, backlog)) destination = buildLearningDestinationCatalog(root).find((candidate) => candidate.type === "backlog" && candidate.ref === backlog);
    } else if (hypothesis) {
      const hypothesisFile = path.join(inboxDir(root), "hypotheses.yaml");
      if (existsSync(hypothesisFile)) {
        const hypothesisDoc = parse(readFileSync(hypothesisFile, "utf8")) as { hypotheses?: Array<Record<string, unknown>> };
        const found = (hypothesisDoc.hypotheses ?? []).find((candidate) => candidate.hypothesis_id === hypothesis);
        if (found) {
          destination = {
            type: "backlog",
            ref: hypothesis,
            path: "discovery/inbox/hypotheses.yaml",
            title: String(found.claim ?? hypothesis),
            text: String(found.claim ?? ""),
            blocks: [String(found.claim ?? "")],
          };
          subtype = "hypothesis";
        }
      }
    }
    if (!destination) return invalid("That primary-home destination does not exist on this machine; no route was changed.", json, "E_DISCOVERY_VALIDATION");
    const previous = eventHome(located.record.primary_home);
    located.record.primary_home = {
      status: "moved",
      type: destination.type,
      subtype,
      ref: destination.ref,
      path: destination.path,
      title: destination.title,
      basis: "human_move",
      placement_confidence: "high",
      why: `Moved by ${by}.`,
      candidates: [],
      by,
      actor: "human",
      at: now,
    };
    tieEvent = {
      type: "com.adaptivespec.discovery.home_moved",
      data: { target, previous, current: eventHome(located.record.primary_home) },
    };
    reassignNotes.push("Primary home moved. Also-related ties were left unchanged.");
  } else if (action === "undo-home") {
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Undo changes an inbox finding's primary home; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    if (!located.record.primary_home) return invalid("This finding has no primary-home receipt to undo.", json, "E_DISCOVERY_INVALID_TRANSITION");
    const previous = eventHome(located.record.primary_home);
    delete located.record.primary_home;
    tieEvent = { type: "com.adaptivespec.discovery.home_undone", data: { target, previous } };
    reassignNotes.push("Primary home undone. The finding can be routed again; Also-related ties were left unchanged.");
  } else if (action === "reassign") {
    // A human correction to the pointer (R-003): moves or clears assigned_to
    // with human attribution. Never touches the destination — pointers move
    // freely; only filings write destination artifacts. `--bug` is the one
    // exception by owner ruling (bug-owner-autolog-v0 D-002): it runs the
    // dedupe-first bug-log engine and points the record at the GitHub issue.
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Reassign moves an inbox finding's ties; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    migrateRecordTies(root, located.record);
    const studyId = flagValue(args, "--study");
    const packetName = flagValue(args, "--packet");
    const none = hasFlag(args, "--none");
    const bug = hasFlag(args, "--bug");
    if ([studyId, packetName, none ? "none" : undefined, bug ? "bug" : undefined].filter(Boolean).length !== 1) {
      return invalid(`Reassign takes exactly one destination: foo discovery review ${target} reassign --study <id> --by ${by}, --packet <packet-name>, --bug to file it in the owner bug queue, or --none to clear every tie.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    if (located.record.attached_to) return invalid(`This finding is filed in ${String(located.record.attached_to)}; ties cannot be replaced while a copy is filed. Detach first (foo discovery review ${target} detach --by ${by}), then rerun reassign.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    let newTie: InsightTie | null = null;
    if (packetName) {
      if (!specPacketDir(root, packetName)) return invalid(`Spec packet ${packetName} was not found under specs/. Reassign never creates a packet; create it first (foo asp init specs/${packetName}), then rerun foo discovery review ${target} reassign --packet ${packetName} --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "spec", ref: packetName, url: tieUrlFor(root, "spec", packetName), by, actor: "human", at: now };
    } else if (studyId) {
      if (!locateStudy(root, studyId)) return invalid(`Study ${studyId} was not found. Check the study id, then rerun foo discovery review ${target} reassign --study ${studyId} --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "study", ref: studyId, url: tieUrlFor(root, "study", studyId), by, actor: "human", at: now };
    } else if (bug) {
      const engine = runSignalBugEngine(root, located.record);
      if (!engine.ok) return invalid(engine.message, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "bug", ref: engine.tie.ref, url: engine.tie.url, by, actor: "human", at: now };
      reassignIssueUrl = engine.tie.url;
      reassignNotes.push(engine.note);
    }
    const previous = recordTies(located.record);
    // Departing bug ties never close their issues — say where each lives on.
    for (const prior of previous) {
      if (prior.type === "bug" && (!newTie || tieKey(prior) !== tieKey(newTie))) {
        reassignNotes.push(`The GitHub issue behind ${tieKey(prior)} is NOT closed by this; it lives on${prior.url ? ` at ${prior.url}` : " in the owner bug queue"}.`);
      }
    }
    reassignFrom = previous.length ? previous.map(tieKey).join(",") : null;
    reassignTo = newTie ? tieKey(newTie) : null;
    located.record.ties = newTie ? [newTie] : [];
    // A tie clears dismissal (R-004); --none clears every tie and is not a tie,
    // so it must not revive a dismissed record.
    if (newTie) undismissOnTie(path.dirname(located.file), located.record, target, by, reassignTo, now, reassignNotes);
    reassignNotes.push(`reassign is deprecated: ties are 1-to-many now — prefer foo discovery review ${target} tie/untie.`);
  } else if (action === "tie") {
    // R-003: add one typed link in the owner's language. Repeat to accumulate.
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Tie links an inbox finding to what it is about; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    migrateRecordTies(root, located.record);
    const specName = flagValue(args, "--spec");
    const researchDoc = flagValue(args, "--research");
    const ideaDoc = flagValue(args, "--idea");
    const bug = hasFlag(args, "--bug");
    if ([specName, researchDoc, ideaDoc, bug ? "bug" : undefined].filter(Boolean).length !== 1) {
      return invalid(`Tie takes exactly one destination per call: foo discovery review ${target} tie --bug --by ${by}, --spec <name>, --research <doc>, or --idea <doc>. Run it again to add another tie.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    let newTie: InsightTie;
    if (specName) {
      if (!specPacketDir(root, specName)) return invalid(`Spec ${specName} was not found under specs/. Tie never creates one; create it first (foo asp init specs/${specName}), then rerun foo discovery review ${target} tie --spec ${specName} --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "spec", ref: specName, url: tieUrlFor(root, "spec", specName), by, actor: "human", at: now };
    } else if (researchDoc) {
      const ref = resolveDocRef(root, "research", researchDoc);
      if (!ref) return invalid(`Research document ${researchDoc} was not found under research/. Check the name, then rerun foo discovery review ${target} tie --research <doc> --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "research", ref, url: ref, by, actor: "human", at: now };
    } else if (ideaDoc) {
      const ref = resolveDocRef(root, "ideas", ideaDoc);
      if (!ref) return invalid(`Idea document ${ideaDoc} was not found under ideas/. Check the name, then rerun foo discovery review ${target} tie --idea <doc> --by ${by}.`, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "idea", ref, url: ref, by, actor: "human", at: now };
    } else {
      const engine = runSignalBugEngine(root, located.record);
      if (!engine.ok) return invalid(engine.message, json, "E_DISCOVERY_VALIDATION");
      newTie = { type: "bug", ref: engine.tie.ref, url: engine.tie.url, by, actor: "human", at: now };
      reassignNotes.push(engine.note);
    }
    const ties = recordTies(located.record);
    if (ties.some((tie) => tieKey(tie) === tieKey(newTie))) {
      return invalid(`This finding is already tied to ${tieKey(newTie)}. Remove it first (foo discovery review ${target} untie --${newTie.type}${newTie.type === "bug" ? "" : ` ${newTie.ref}`} --by ${by}) or tie a different destination.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    ties.push(newTie);
    undismissOnTie(path.dirname(located.file), located.record, target, by, tieKey(newTie), now, reassignNotes);
    tieEvent = { type: "com.adaptivespec.discovery.tied", data: { target, type: newTie.type, ref: newTie.ref, url: newTie.url } };
  } else if (action === "untie") {
    // R-003 mirror: remove one tie. Bugs live on in GitHub; filed copies need
    // detach first; the record's review state is never re-dismissed (R-004).
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Untie removes one of an inbox finding's ties; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    migrateRecordTies(root, located.record);
    const ties = recordTies(located.record);
    const specName = flagValue(args, "--spec");
    const researchDoc = flagValue(args, "--research");
    const ideaDoc = flagValue(args, "--idea");
    const bug = hasFlag(args, "--bug");
    const rawBugRef = flagValue(args, "--bug");
    const bugRef = rawBugRef && !rawBugRef.startsWith("--") ? rawBugRef : undefined;
    if ([specName, researchDoc, ideaDoc, bug ? "bug" : undefined].filter(Boolean).length !== 1) {
      return invalid(`Untie takes exactly one tie: foo discovery review ${target} untie --bug [<issue>] --by ${by}, --spec <name>, --research <doc>, or --idea <doc>.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    let removed: InsightTie | undefined;
    if (bug) {
      const bugTies = ties.filter((tie) => tie.type === "bug" && (!bugRef || tie.ref === bugRef));
      if (bugTies.length === 0) return invalid(`This finding has no ${bugRef ? `bug:${bugRef}` : "bug"} tie; nothing to untie. Current ties: ${ties.map(tieKey).join(", ") || "none"}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      if (bugTies.length > 1) return invalid(`This finding has several bug ties (${bugTies.map(tieKey).join(", ")}); name one: foo discovery review ${target} untie --bug <issue> --by ${by}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      removed = bugTies[0];
      reassignNotes.push(`The GitHub issue behind ${tieKey(removed)} is NOT closed by this; it lives on${removed.url ? ` at ${removed.url}` : " in the owner bug queue"}.`);
    } else {
      const wanted: Array<Pick<InsightTie, "type" | "ref">> = [];
      if (specName) wanted.push({ type: "spec", ref: specName });
      if (researchDoc) wanted.push({ type: "research", ref: resolveDocRef(root, "research", researchDoc) ?? researchDoc });
      if (ideaDoc) wanted.push({ type: "idea", ref: resolveDocRef(root, "ideas", ideaDoc) ?? ideaDoc });
      removed = ties.find((tie) => wanted.some((candidate) => tieKey(candidate) === tieKey(tie)));
      if (!removed) return invalid(`This finding is not tied to ${wanted.map(tieKey).join(" or ")}; nothing to untie. Current ties: ${ties.map(tieKey).join(", ") || "none"}.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      if (removed.type === "spec" && located.record.attached_to === `packet:${removed.ref}`) {
        return invalid(`The copy of this finding is filed in specs/${removed.ref}/evidence.yaml; detach owns that reversal. Run foo discovery review ${target} detach --by ${by} first, then rerun untie.`, json, "E_DISCOVERY_INVALID_TRANSITION");
      }
    }
    located.record.ties = ties.filter((tie) => tie !== removed);
    tieEvent = { type: "com.adaptivespec.discovery.untied", data: { target, type: removed.type, ref: removed.ref, url: removed.url } };
  } else if (action === "restore") {
    // discovery-restore-verb-v0 R-001: the destination-free way back from
    // archived. Ties are not read, added, or removed — a restored record
    // keeps every tie it had. ("Archived" is the surface word; the stored
    // state stays `dismissed` — plumbing invisible.)
    if (located.key !== "findings" || path.basename(path.dirname(located.file)) !== "inbox") return invalid("Restore brings an archived inbox finding back to unreviewed; the target must be an inbox finding ID.", json, "E_DISCOVERY_INVALID_TRANSITION");
    // A filed record is refused regardless of review_state: attach → dismiss
    // leaves both attached_to set AND review_state dismissed, and restoring it
    // would strand the filed copy while the record claims to be unreviewed.
    if (located.record.attached_to) {
      return invalid(`This finding is filed in ${String(located.record.attached_to)} — detach owns that reversal. Run foo discovery review ${target} detach --by ${by} first; restore only brings archived, unfiled records back to the queue.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    if (located.record.review_state !== "dismissed") {
      const state = String(located.record.review_state ?? "unknown");
      const detail = state === "needs_review"
        ? "it is already unreviewed and waiting in the queue"
        : `its current state is ${state}`;
      return invalid(`This finding is not archived — ${detail}. Restore only brings archived records back; to archive one first, run foo discovery review ${target} dismiss --by ${by} --within inbox.`, json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    Object.assign(located.record, { review_state: "needs_review", disposition: { by, at: now, action: "restore" } });
    tieEvent = { type: "com.adaptivespec.discovery.restored", data: { target, from: "dismissed", to: "needs_review" } };
    reassignNotes.push("Restored: this record is back in the unreviewed queue. Its ties are unchanged.");
  } else if (action === "select-source") {
    const fingerprint = flagValue(args, "--fingerprint");
    const candidates = Array.isArray(located.record.source_fingerprints) ? located.record.source_fingerprints : [];
    if (located.key !== "proposals" || located.record.rationale !== "probable_duplicate_source" || !fingerprint || !candidates.includes(fingerprint)) {
      return invalid("Source selection requires a duplicate-source proposal and one listed --fingerprint.", json, "E_DISCOVERY_INVALID_TRANSITION");
    }
    Object.assign(located.record, { state: "promoted", selected_source_fingerprint: fingerprint, disposition: { by, at: now, action: "select-source" } });
  } else {
    return invalid("Review action must be complete, tie, untie, attach, detach, restore, move-home, undo-home, reassign, promote, dismiss, or select-source.", json, "E_DISCOVERY_INVALID_TRANSITION");
  }
  writeFileSync(located.file, stringify(located.doc));
  const dir = path.dirname(located.file);
  if (action === "reassign") appendHumanEvent(dir, "com.adaptivespec.discovery.reassigned", `${located.key}:${target}`, by, { target, action, from: reassignFrom, to: reassignTo, ...(reassignIssueUrl ? { issue_url: reassignIssueUrl } : {}) }, now);
  else if (tieEvent) appendHumanEvent(dir, tieEvent.type, `${located.key}:${target}`, by, tieEvent.data, now);
  else appendHumanEvent(dir, `com.adaptivespec.discovery.${action}`, `${located.key}:${target}`, by, { target, action }, now);
  return outcome(result("ok", { writes: [relative(root, located.file), relative(root, path.join(dir, "events.jsonl")), ...extraWrites], next_actions: reassignNotes, coverage: { human_transition: true, canonical_destination_edited: false } }), json);
}

function revokeFingerprint(root: string, fingerprint: string, by: string, now: string, json: boolean): DiscoveryCommandOutcome {
  if (!/^sha256:[a-f0-9]{64}$/i.test(fingerprint)) return invalid("Source revocation requires a full sha256 fingerprint.", json, "E_DISCOVERY_VALIDATION", fingerprint);
  const discoveryRoot = path.join(root, "discovery");
  const dirs = readdirSync(discoveryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(discoveryRoot, entry.name));
  const writes: DiscoveryWrite[] = [];
  let removedFindings = 0;
  for (const dir of dirs) {
    const findingsPath = path.join(dir, "findings.yaml");
    const proposalsPath = path.join(dir, "proposals.yaml");
    if (!existsSync(findingsPath) || !existsSync(proposalsPath)) continue;
    const findingsDoc = parse(readFileSync(findingsPath, "utf8")) as { schema_version: string; findings?: Array<Record<string, unknown>> };
    const findings = findingsDoc.findings ?? [];
    const removedIds = new Set(findings.filter((finding) => finding.source_fingerprint === fingerprint).map((finding) => String(finding.finding_id)));
    if (removedIds.size === 0) continue;
    removedFindings += removedIds.size;
    findingsDoc.findings = findings.filter((finding) => finding.source_fingerprint !== fingerprint);
    const proposalsDoc = parse(readFileSync(proposalsPath, "utf8")) as { schema_version: string; proposals?: Array<Record<string, unknown>> };
    proposalsDoc.proposals = (proposalsDoc.proposals ?? []).filter((proposal) => {
      const sourceIds = Array.isArray(proposal.source_finding_ids) ? proposal.source_finding_ids.map(String) : [];
      return !sourceIds.some((id) => removedIds.has(id));
    });
    writeFileSync(findingsPath, stringify(findingsDoc));
    writeFileSync(proposalsPath, stringify(proposalsDoc));
    const reportPath = path.join(dir, "report.md");
    if (existsSync(reportPath)) {
      writeFileSync(reportPath, "# Discovery report\n\nNeeds regeneration after source revocation. Active structured findings remain available for human review. Prior Git history is not erased.\n");
      writes.push(relative(root, reportPath));
    }
    appendHumanEvent(dir, "com.adaptivespec.discovery.source_revoked", `source:${fingerprint}`, by, { source_fingerprint: fingerprint, active_findings_removed: removedIds.size }, now);
    writes.push(relative(root, findingsPath), relative(root, proposalsPath), relative(root, path.join(dir, "events.jsonl")));
  }
  const localRemoved = purgeDiscoveryLocalFingerprint(localRoot(root), fingerprint);
  if (removedFindings === 0 && localRemoved.length === 0) return invalid("Discovery source fingerprint was not found.", json, "E_DISCOVERY_VALIDATION", fingerprint);
  return outcome(result("ok", { writes, next_actions: ["Active evidence for this source was removed and future ingestion is blocked. Git history was not erased."], coverage: { active_findings_removed: removedFindings, local_records_removed: localRemoved.length, git_history_erased: false } }), json);
}

async function revokeCommand(root: string, args: string[], json: boolean, now: string): Promise<DiscoveryCommandOutcome> {
  const target = args[1];
  const by = flagValue(args, "--by");
  if (!target || !by?.trim()) return invalid("Discovery revoke requires a study and --by <person>.", json, "E_DISCOVERY_INVALID_TRANSITION", target);
  if (target.startsWith("sha256:")) return revokeFingerprint(root, target, by, now, json);
  let dir: string;
  try { dir = study(root, target); } catch { return invalid("Discovery revoke target was not found.", json, "E_DISCOVERY_VALIDATION", target); }
  const run = loadDiscoveryRun(dir);
  if (run.state === "revoked") return outcome(result("clean_no_op", { study_id: target, coverage: { revoked: true } }), json);
  const revoked = revokeSource(dir, { ingress_path: "mcp", provider: run.source.provider, connection_id: run.source.connection_alias }, { packet: run.study_id, by, at: now });
  // #898: a hosted target registered from this study gets the same
  // privilege-reducing discovery_suspend_target fan-out `foo source revoke`
  // sends (nango-discovery-connector-v0 R-008), bound to this revoke's event
  // digest and limited to this study's own target. The local revoke above is
  // already applied; a service failure records revocation_pending, never a
  // claimed suspension.
  const hosted = await fanOutDiscoveryTargetSuspension({
    localRoot: root,
    provider: run.source.provider,
    connection_id: run.source.connection_alias,
    target_id: run.study_id,
    revocation_event_digest: revoked.event_digest,
    requested_by: by,
    at: now,
  });
  const findings = path.join(dir, "findings.yaml");
  const proposals = path.join(dir, "proposals.yaml");
  const report = path.join(dir, "report.md");
  writeFileSync(findings, 'schema_version: "0.1"\nfindings: []\n');
  writeFileSync(proposals, 'schema_version: "0.1"\nproposals: []\n');
  writeFileSync(report, "# Discovery report\n\nRevoked. Active derived evidence was removed from the working record. Prior Git history is not erased.\n");
  // The purge removes this study's local state, which includes its hosted-target
  // registration. While a suspension is still pending, the registration is kept
  // (with its revocation_pending mark) so a later `foo source revoke` can retry
  // the fan-out instead of finding nothing (#898).
  const registration = path.join(localRoot(root), localTargetName(run.study_id), "target.json");
  const keptRegistration = hosted.pending > 0 && existsSync(registration) ? readFileSync(registration) : null;
  purgeDiscoveryLocalState(localRoot(root), run.study_id);
  if (keptRegistration) {
    mkdirSync(path.dirname(registration), { recursive: true });
    writeFileSync(registration, keptRegistration, { mode: 0o600 });
  }
  const writes = [relative(root, findings), relative(root, proposals), relative(root, report), ...transitionDiscoveryRun(dir, "revoked", { type: "human", id: by }, now)];
  const next = ["Active evidence is removed and future reads are blocked. Git history was not erased."];
  if (hosted.pending > 0) next.push(`Hosted suspension is REVOCATION_PENDING for ${hosted.pending} registered target(s): the service has not acknowledged it, and hosted reads may continue until it does. Rerun \`foo source revoke\` to retry.`);
  return outcome(result("ok", { study_id: target, writes, next_actions: next, coverage: { active_evidence_removed: true, git_history_erased: false, hosted } }), json);
}

export async function runDiscoveryCommand(root: string, args: string[], stdin = "", now = new Date().toISOString()): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const command = args[0];
  try {
    if (command === "plan") return planCommand(root, args, json);
    if (command === "match") return matchCommand(root, args, stdin, json, now);
    if (command === "apply") return await applyCommand(root, args, stdin, json, now);
    if (command === "validate") {
      const target = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const validation = validateDiscoveryPath(root, target);
      return outcome(result(validation.ok ? "ok" : "invalid", { errors: validation.errors.map((message) => ({ code: "E_DISCOVERY_VALIDATION", message })), handoff: validation.ok ? null : "Fix discovery validation errors before using evidence.", coverage: { studies: validation.studies, inbox: validation.inbox } }), json);
    }
    if (command === "tie" || command === "assign") return autoTieCommand(root, args, json, now);
    if (command === "route") return routeCommand(root, args, stdin, json, now);
    if (command === "contact") return contactCommand(root, args, json, now);
    if (command === "review") return reviewCommand(root, args, json, now);
    if (command === "revoke") return await revokeCommand(root, args, json, now);
    if (command === "proof-opened") {
      const studyId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const fingerprint = flagValue(args, "--fingerprint");
      if (!studyId || !fingerprint) return invalid("Runtime proof-opened requires a study and source fingerprint.", json, "E_DISCOVERY_RESEARCH_PROOF", studyId);
      try {
        markDiscoveryProofOpened({ study_dir: discoveryTargetDir(root, studyId), local_root: localRoot(root), study_id: studyId, source_fingerprint: fingerprint, now });
        return outcome(result("ok", { study_id: studyId, next_actions: ["Synthesize the sanitized evidence envelope in memory, then apply it before proof expiry."], coverage: { transcript_open_attested: true } }), json);
      } catch {
        return outcome(result("needs_research_proof", { study_id: studyId, errors: [{ code: "E_DISCOVERY_RESEARCH_PROOF", message: "The transcript-open attestation did not match an active approved proof." }], handoff: "Repeat strict matching; do not reuse the transcript or a stale receipt." }), json);
      }
    }
    if (command === "sync") {
      const retention = purgeDiscoveryRetention(root, now);
      const plan = planDiscoverySync(root, now);
      const syncErrors = [...plan.errors, ...retention.failures];
      const status: DiscoveryCommandStatus = retention.failures.length ? "invalid" : plan.lanes.length ? "ok" : plan.errors.length ? "invalid" : "clean_no_op";
      return outcome(result(status, {
        writes: retention.removed.map((removedPath) => ({ path: removedPath, action: "removed" as const })),
        errors: syncErrors.map((message) => ({ code: "E_DISCOVERY_VALIDATION", message })),
        handoff: syncErrors.length ? "Fix invalid discovery lanes or retained local state; valid providers remain isolated." : null,
        next_actions: plan.lanes.map((lane) => `${lane.lane_id}: ${lane.allowed_actions.length ? lane.allowed_actions.join(" → ") : "no automated action"}`),
        coverage: { lanes: plan.lanes.length, connector_reads: plan.connector_reads, provider_failures_isolated: true, retention_removed: retention.removed.length, retention_retained: retention.retained.length, writes_allowed: ["discovery/", ".foo/discovery/"] },
      }), json);
    }
    return invalid("Try: plan | match | apply | validate | tie | contact | review | revoke | sync", json);
  } catch {
    return invalid("Discovery failed closed without exposing private source content.", json);
  }
}

