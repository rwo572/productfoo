// Connector Substrate V0 (nango_connector_substrate_v0): the packet-side
// evidence ledger. Discovery/access of live MCP servers happen in the agent
// runtime (productfoo's CLI is pure fs+argv and cannot call mcp__* tools); this module
// owns everything that persists to the packet regardless of runtime — classify,
// the fail-closed per-packet gate, approval/revoke provenance, purge, and the
// coverage-honest receipt. The runtime hands the discovered tool surface in as
// JSON (the spec's documented CLI-bridge override), so the whole flow is
// offline-testable against fixtures with no live connector I/O.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GateBlock, UsageError } from "./errorTaxonomy.js";
import path from "node:path";
import { specIdFromFooSpecTrailer } from "./specLinkedCommits.js";
import { readJson } from "./jsonFile.js";

export type IngressPath = "mcp" | "nango" | "custom" | "browser";
export type ApprovalState = "excluded" | "approved" | "revoked";

// Durable source identity (R-008). One entity reachable via multiple paths is a
// single source keyed on {provider, connection_id}; ingress path is provenance
// and never changes classification. `external_id` is an optional per-selection
// discriminator used only by per-PR-capable providers (GitHub PRs, R-011); it is
// absent for connection-keyed providers (Linear, Supabase).
export type SourceId = { ingress_path: IngressPath; provider: string; connection_id: string; external_id?: string };

export type EvidenceClass = "system_of_record" | "reference" | "communication" | "support_context" | "decision_context" | "context_only" | "approved_source_artifact";
export type Sensitivity = "low" | "medium" | "high";

export type Classification = {
  source_category: string;
  authority: "authoritative" | "supporting" | "context_only";
  sensitivity: Sensitivity;
  evidence_class: EvidenceClass;
  model_exposure: "summary_only" | "full";
  // false => the source took the most-restrictive default (unregistered provider).
  registered: boolean;
};

// User-facing one-line glosses for evidence-class tokens (R-006): the raw token
// must never appear alone on a trust surface.
export const EVIDENCE_CLASS_GLOSS: Record<EvidenceClass, string> = {
  system_of_record: "authoritative system of record",
  reference: "supporting reference material",
  communication: "communication / message content",
  support_context: "customer support context",
  decision_context: "decision context — explains why the work changed; it informs and never settles",
  context_only: "background context only",
  approved_source_artifact: "an explicitly selected document, summarized only",
};

// The source-category registry (R-002). Adding a category is a registry entry,
// not a code change. Supabase is the worked app_data example (R-004); Linear is
// the first managed-connector category (linear-integration-v0 R-001).
export const SOURCE_CATEGORY_REGISTRY: Record<string, Omit<Classification, "registered">> = {
  supabase: {
    source_category: "app_data",
    authority: "authoritative",
    sensitivity: "high",
    evidence_class: "system_of_record",
    model_exposure: "summary_only",
  },
  linear: {
    // Issue/project tracking is supporting reference material, not a system of
    // record for the product's own data — it enters as approved-private-context
    // and must be verified against repo-truth before becoming a requirement
    // (linear-integration-v0 R-003).
    source_category: "issue_tracker",
    authority: "supporting",
    sensitivity: "medium",
    evidence_class: "reference",
    model_exposure: "summary_only",
  },
  github: {
    // A code host is supporting evidence as a whole, so the registry entry stays
    // the conservative `reference` (a real EvidenceClass; github-integration-v0
    // R-001). The split that elevates *typed* facts (PR merge state, check
    // conclusions, commit SHAs/paths) to system_of_record authority is applied at
    // verdict time (R-004), not as a second registry class; free-text (bodies,
    // titles, check-run logs) stays inert reference here.
    source_category: "code_host",
    authority: "supporting",
    sensitivity: "medium",
    evidence_class: "reference",
    model_exposure: "summary_only",
  },
  firecrawl: {
    // Firecrawl is governed web ingress (alpha-dist-repo-v0 R-006): crawl/scrape
    // of PUBLIC web content into LLM-ready form, feeding `foo research` under the
    // B5 read-and-synthesize gates. The open web is supporting reference material
    // — never a system of record — and fetched content stays untrusted: it must
    // never drive a tool call over private or connected-source data, and private
    // or connected content is never sent TO Firecrawl (assertNoPrivateToFirecrawl
    // in research.ts). Sensitivity is low because only public pages and the
    // search terms transit it — by construction, nothing private is in scope.
    source_category: "web_research",
    authority: "supporting",
    sensitivity: "low",
    evidence_class: "reference",
    model_exposure: "summary_only",
  },
  granola: {
    // Meeting transcripts are high-sensitivity communication. Discovery may
    // expose screened paraphrases only after a per-study approval; the source
    // itself is never authoritative product truth.
    source_category: "meeting_transcript",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  gong: {
    // Gong call transcripts are the same class as Granola meetings
    // (gong-discovery-connector-v0 T-002): high-sensitivity communication,
    // screened paraphrases only after a per-study approval, never
    // authoritative product truth. Registration is classification, not
    // support — Gong stays contract_only until its live path is proven.
    source_category: "meeting_transcript",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  jira: {
    // Jira work-system state is the same class as Linear — supporting issue
    // tracking, never a system of record for the product's own data
    // (jira-source-connector-v0 R-002). Tracker status corroborates packet
    // truth at reconcile time; repo proof still decides (R-006 renders
    // conflicts, it does not let the tracker win — RISK-001). Registration
    // is classification, not support — Jira stays contract_only until its
    // receipt-backed feasibility record exists (R-003).
    source_category: "issue_tracker",
    authority: "supporting",
    sensitivity: "medium",
    evidence_class: "reference",
    model_exposure: "summary_only",
  },
  fireflies: {
    // Fireflies archives cross-platform meetings (Zoom/Meet/Teams) under one
    // keyed account (fireflies-discovery-connector-v0 T-002): the same
    // high-sensitivity communication class as Gong and Granola — screened
    // paraphrases only after a per-scope approval, never authoritative
    // product truth. Registration is classification, not support — Fireflies
    // stays contract_only until the feasibility task proves the API path.
    source_category: "meeting_transcript",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  notion: {
    // The first docs source (notion-discovery-connector-v0 R-002/D-001/D-002):
    // this entry DEFINES the docs class that the Google Drive + Docs and
    // Confluence packets later register into. Product intent in documents is
    // supporting evidence — never authoritative product truth — and only
    // explicitly selected pages/databases may be read, exactly once, under
    // the proof boundary, reduced to a PII-minimized summary (the
    // approved_source_artifact model). Documents are not sessions: the docs
    // class never reuses meeting_transcript's classification or lane. A page
    // a workspace can see is not evidence — a page a person selected is.
    source_category: "docs",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "approved_source_artifact",
    model_exposure: "summary_only",
  },
  zendesk: {
    // Support tickets introduce the `support` class beside the meeting classes
    // (zendesk-discovery-connector-v0 R-002): solved tickets are customers
    // describing pain in their own words — supporting, high-sensitivity,
    // support-context evidence, never reused meeting-transcript
    // classification and never authoritative product truth. Registration is
    // classification, not support — Zendesk stays contract_only until its
    // feasibility record and dogfood run exist.
    source_category: "support",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "support_context",
    model_exposure: "summary_only",
  },

  gmail: {
    // Email introduces its own category (gmail-discovery-connector-v0 R-002):
    // a mailbox is written customer communication — commitments, objections,
    // and follow-ups — and is never reclassified as a meeting transcript to
    // reuse that lane. Sensitivity is the registry's highest cost: the mailbox
    // is personal even at work, the connection is per-user (D-002), and
    // exposure stays summary_only behind label/thread scoping (R-004).
    // Registration is classification, not support — Gmail stays contract_only
    // until the feasibility report proves the API surface (R-003).
    source_category: "email",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  zoom: {
    // Zoom cloud-recording transcripts are the same class as Granola meetings
    // and Gong calls (zoom-discovery-connector-v0 T-002): high-sensitivity
    // communication, screened paraphrases only after a per-study approval,
    // never authoritative product truth. Registration is classification, not
    // support — Zoom stays contract_only until its feasibility report
    // (T-001) and a real company-connected dogfood run exist.
    source_category: "meeting_transcript",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  "microsoft-teams": {
    // Teams online-meeting transcripts are the same class as Granola and Gong
    // (microsoft-teams-discovery-connector-v0 T-002): high-sensitivity
    // communication, screened paraphrases only after a per-study approval,
    // never authoritative product truth. Registration is classification, not
    // support — Teams stays contract_only until its feasibility task and
    // dogfood run prove the Graph path.
    source_category: "meeting_transcript",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
  slack: {
    // Slack introduces the chat class (slack-discovery-connector-v0 R-002) —
    // the strictest defaults of the top ten, because chat carries social
    // noise, ambiguity, and third-party privacy exposure. Chat evidence is
    // supporting DECISION CONTEXT: it explains why the work changed and never
    // settles it (D-001 — summary-only exposure always, even when raw access
    // exists; chat is never an approved_source_artifact). Selection is
    // explicit channels and threads only, and DMs/group DMs are outside V0 by
    // construction, not by policy toggle (D-002). Registration is
    // classification, not support — Slack stays contract_only until its
    // feasibility record (T-001) and company-connected dogfood run (T-007).
    source_category: "chat",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "decision_context",
    model_exposure: "summary_only",
  },
  outlook: {
    // Outlook registers into the EXISTING email class
    // (outlook-discovery-connector-v0 R-002): identical values to Gmail's
    // entry — the class is shared, not forked, and no Outlook-specific lane is
    // created. Same mailbox sensitivity, same per-user ownership (D-002), same
    // summary_only exposure behind folder/conversation scoping (R-004).
    // Registration is classification, not support — Outlook stays
    // contract_only until its feasibility report proves the Graph surface
    // (R-003).
    source_category: "email",
    authority: "supporting",
    sensitivity: "high",
    evidence_class: "communication",
    model_exposure: "summary_only",
  },
};

// Most-restrictive default (R-002): an unrecognized or uncategorized source is
// context-only, summary-only, read-only, excluded until explicitly approved.
export const MOST_RESTRICTIVE_DEFAULT: Classification = {
  source_category: "unknown",
  authority: "context_only",
  sensitivity: "high",
  evidence_class: "context_only",
  model_exposure: "summary_only",
  registered: false,
};

// Fail-closed: any unrecognized provider takes the most-restrictive default.
export function classifyProvider(provider: string): Classification {
  const entry = SOURCE_CATEGORY_REGISTRY[provider?.toLowerCase?.() ?? ""];
  if (!entry) return { ...MOST_RESTRICTIVE_DEFAULT };
  return { ...entry, registered: true };
}

// --- Notion docs scope (notion-discovery-connector-v0 R-004) -----------------
//
// A Notion approval names EXPLICIT pages or databases inside a bounded window —
// the RFC's `explicit_document_or_container_selected` boundary. The scope string
// stored in the approval ledger is the canonical serialization of this shape, so
// the accumulated-scope machinery (#528) works unchanged: one connection may
// carry several deliberately-bounded document selections, and revocation clears
// them all. There is no wildcard for docs: `*` (the substrate's unrestricted
// scope for other providers) NEVER admits a Notion read, because a
// workspace-wide listing is exactly what R-004 refuses.

export type NotionApprovedScope = {
  page_ids?: string[];
  database_ids?: string[];
  window: { from: string; to: string };
};

// Notion object ids are 32 hex digits, seen dashed or undashed. Storage and
// every comparison use the dashed lowercase canonical form.
const NOTION_UUID = /^[0-9a-f]{32}$/i;

function canonicalNotionId(raw: string, label: string): string {
  const hex = raw.trim().replace(/-/g, "");
  if (!NOTION_UUID.test(hex)) throw new Error(`${label} carries an invalid Notion identifier`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalIdList(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) throw new Error(`${label} must be an array of Notion identifiers`);
  const canonical = [...new Set((raw as string[]).map((id) => canonicalNotionId(id, label)))];
  return canonical;
}

// Parse and canonicalize one Notion approved scope from its stored string form.
// Throws a bounded, actionable message on every invalid shape — callers who
// want a validation result use notionScopeValidationError below.
export function parseNotionScope(raw: string): NotionApprovedScope {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "*" || /^(?:workspace|all)(?:[-_]wide)?$/i.test(trimmed)) {
    throw new Error("a Notion scope must name explicit pages or databases — workspace-wide access is refused (R-004)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("a Notion scope is a JSON object: {page_ids?, database_ids?, window:{from,to}}");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("a Notion scope is a JSON object: {page_ids?, database_ids?, window:{from,to}}");
  const shape = parsed as Record<string, unknown>;
  const SCOPE_KEYS = new Set(["page_ids", "database_ids", "window"]);
  for (const key of Object.keys(shape)) {
    if (!SCOPE_KEYS.has(key)) throw new Error(`a Notion scope contains unknown field ${key} — workspace-wide or crawler shapes are refused (R-004)`);
  }
  const page_ids = canonicalIdList(shape.page_ids, "page_ids");
  const database_ids = canonicalIdList(shape.database_ids, "database_ids");
  if (!page_ids?.length && !database_ids?.length) throw new Error("a Notion scope has no explicit selection: name at least one page or database (R-004)");
  const window = (shape.window ?? {}) as Record<string, unknown>;
  if (typeof window.from !== "string" || typeof window.to !== "string" || !Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to)) || Date.parse(window.from) >= Date.parse(window.to)) {
    throw new Error("a Notion scope needs a bounded window {from,to} with from before to");
  }
  return {
    ...(page_ids?.length ? { page_ids } : {}),
    ...(database_ids?.length ? { database_ids } : {}),
    window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
  };
}

// Validation-result form of parseNotionScope (null = valid), matching the
// gongScopeValidationError pattern so pre-flight checks read alike.
export function notionScopeValidationError(raw: string): string | null {
  try {
    parseNotionScope(raw);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid Notion scope";
  }
}

// Admission check for ONE content read or metadata listing (R-004/R-005): the
// selected page or database must be named by THIS stored scope. A stored
// wildcard admits nothing here, and an unparseable stored scope fails closed.
export function notionScopeAllowsSelection(scope: string | undefined, selection: { page_id?: string; database_id?: string }): boolean {
  if (!scope?.trim()) return false;
  let approved: NotionApprovedScope;
  try {
    approved = parseNotionScope(scope);
  } catch {
    return false;
  }
  if (selection.page_id?.trim()) {
    try {
      return (approved.page_ids ?? []).includes(canonicalNotionId(selection.page_id, "page_id"));
    } catch {
      return false;
    }
  }
  if (selection.database_id?.trim()) {
    try {
      return (approved.database_ids ?? []).includes(canonicalNotionId(selection.database_id, "database_id"));
    } catch {
      return false;
    }
  }
  return false;
}

export function sourceKey(id: Pick<SourceId, "provider" | "connection_id" | "external_id">): string {
  const base = `${id.provider}::${id.connection_id}`;
  // Per-PR gate keying for GitHub only (github-integration-v0 R-011): GitHub
  // admits per-PR selection, so PR #1 and PR #2 in one repo (same connection_id)
  // must be distinct gate keys, and revoking one must not purge the other. Other
  // providers stay connection-keyed (R-008), so their approve/record flows are
  // unchanged even when a candidate carries an external_id.
  return id.provider === "github" && id.external_id ? `${base}::${id.external_id}` : base;
}

// --- Company-owned Gong connection (gong-discovery-connector-v0 R-002/D-002) -

// A Gong connection belongs to a productfoo workspace (the company), not to the person
// who happened to connect it. The tenant-scoped canonical source identity keys
// on the workspace plus the administrator-issued credential's canonical key;
// hosts never see it and still receive only the opaque `connection_ref`.
// This is a contract pin, not a runtime: the hosted tier that will enforce it
// stays contract_only (R-008), and these primitives reuse the substrate's
// existing SourceId and ledger rather than a parallel identity or role system —
// the only roles are the spec's minimum, administrator and member.
// Provider-parameterized company-connection identity (R-002): productfoo connects one
// company account per provider. Gong pinned the contract
// (gong-discovery-connector-v0 R-002/D-002); Zoom runs the same playbook
// (zoom-discovery-connector-v0 R-002/D-001) — the connection state machine
// below is shared, and the provider pin lives only in the identity.
export type CompanyCanonicalSourceIdentity<Provider extends string = string> = {
  foo_workspace: string;
  provider: Provider;
  canonical_connection_key: string;
};
export type GongCanonicalSourceIdentity = CompanyCanonicalSourceIdentity<"gong">;
export type ZoomCanonicalSourceIdentity = CompanyCanonicalSourceIdentity<"zoom">;

export function gongCanonicalSourceIdentity(input: { foo_workspace: string; canonical_connection_key: string }): GongCanonicalSourceIdentity {
  const foo_workspace = input.foo_workspace.trim();
  const canonical_connection_key = input.canonical_connection_key.trim();
  if (!foo_workspace) throw new Error("a company-owned Gong connection needs a foo_workspace");
  if (!canonical_connection_key) throw new Error("a company-owned Gong connection needs a canonical_connection_key");
  return { foo_workspace, provider: "gong", canonical_connection_key };
}

// The substrate identity for the company connection: the workspace scopes the
// ledger key, so two workspaces sharing one Gong account never share approval
// state. Approve/revoke keep using the existing per-packet ledger unchanged.
export function gongWorkspaceSourceId(identity: GongCanonicalSourceIdentity): SourceId {
  return { ingress_path: "nango", provider: "gong", connection_id: `${identity.foo_workspace}/${identity.canonical_connection_key}` };
}

// The same workspace-scoped identity for the company Zoom connection: two
// workspaces sharing one Zoom account never share approval state, and the
// approve/revoke ledger keeps using the substrate SourceId unchanged.
export function zoomCanonicalSourceIdentity(input: { foo_workspace: string; canonical_connection_key: string }): ZoomCanonicalSourceIdentity {
  const foo_workspace = input.foo_workspace.trim();
  const canonical_connection_key = input.canonical_connection_key.trim();
  if (!foo_workspace) throw new Error("a company-owned Zoom connection needs a foo_workspace");
  if (!canonical_connection_key) throw new Error("a company-owned Zoom connection needs a canonical_connection_key");
  return { foo_workspace, provider: "zoom", canonical_connection_key };
}

export function zoomWorkspaceSourceId(identity: ZoomCanonicalSourceIdentity): SourceId {
  return { ingress_path: "nango", provider: "zoom", connection_id: `${identity.foo_workspace}/${identity.canonical_connection_key}` };
}

// Opaque means not directly identifying: no email addresses, no display names.
function assertOpaqueRef(value: string, label: string): string {
  const ref = value.trim();
  if (!ref) throw new Error(`${label} is required`);
  if (ref.includes("@")) throw new Error(`${label} must be opaque: it must not carry an email address`);
  if (/\s/.test(ref)) throw new Error(`${label} must be opaque: it must not carry a display name`);
  return ref;
}

// The closed `discovery_connection_ready` payload (the nango discovery
// contract, extended by this packet's Contracts section): it reports ownership
// and never returns calls.
export type DiscoveryConnectionReady = {
  event: "discovery_connection_ready";
  connection_owner: "workspace" | "user";
  // Present only when the owner is a workspace: the one accountable
  // administrator, as an opaque ref.
  admin_ref?: string;
  // The only connection identity a host ever receives.
  connection_ref: string;
};

function companyConnectionReady(input: { connection_ref: string; admin_ref: string }): DiscoveryConnectionReady {
  const connection_ref = assertOpaqueRef(input.connection_ref, "connection_ref");
  const admin_ref = assertOpaqueRef(input.admin_ref, "admin_ref");
  return { event: "discovery_connection_ready", connection_owner: "workspace", admin_ref, connection_ref };
}

export function gongConnectionReady(input: { connection_ref: string; admin_ref: string }): DiscoveryConnectionReady {
  return companyConnectionReady(input);
}

export function zoomConnectionReady(input: { connection_ref: string; admin_ref: string }): DiscoveryConnectionReady {
  return companyConnectionReady(input);
}

// --- Per-user keyed Fireflies connection (fireflies-discovery-connector-v0
// R-010/D-002) ---------------------------------------------------------------

// A Fireflies connection belongs to the verified user whose API key it is, per
// the granola packet rule: a shared team archive is not emulated with one
// person's credentials. The ready payload therefore carries no admin_ref —
// there is no accountable administrator over a personal key — and the
// workspace-archive question stays open (OQ-001), not a V0 promise.
export function firefliesConnectionReady(input: { connection_ref: string }): DiscoveryConnectionReady {
  const connection_ref = assertOpaqueRef(input.connection_ref, "connection_ref");
  return { event: "discovery_connection_ready", connection_owner: "user", connection_ref };
}

// Refusal for a member attempting an administrator-only connection lifecycle
// operation. Disconnect, rotate, and revoke are the accountable
// administrator's; a member's honest path is to ask them. The provider label
// comes from the connection's own identity (Gong by default).
function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export class MemberConnectionRefusal extends Error {
  constructor(
    readonly action: "disconnect" | "rotate" | "revoke",
    readonly actor_ref: string,
    provider = "Gong",
  ) {
    super(`the ${provider} connection is workspace-owned: only its accountable administrator may ${action} it; ask the administrator, then retry`);
    this.name = "MemberConnectionRefusal";
  }
}

// Refusal for a personal provider credential (one person's login or API key)
// presented as the company connection (R-002): productfoo connects the company
// account only, and says so.
export class PersonalCredentialRefused extends Error {
  readonly handoff: string;
  constructor(provider = "Gong") {
    super(`a personal ${provider} credential cannot stand in for the company connection`);
    this.name = "PersonalCredentialRefused";
    this.handoff = `${provider} connects once per workspace: ask your ${provider} administrator to issue the company access key (or install the company app), then connect it through the productfoo-owned connect surface.`;
  }
}

export type CompanyConnectionGrant = { grant_ref: string; member_ref: string };
export type GongConnectionGrant = CompanyConnectionGrant;

// The closed company-connection state the ownership contract pins. Every
// outstanding item is member-attributed: session refs, queued lanes, and
// receipts arise inside a member's approved scope, and grants are per member.
export type CompanyConnection<Provider extends string = string> = {
  identity: CompanyCanonicalSourceIdentity<Provider>;
  // Opaque; the only connection identity a host ever receives.
  connection_ref: string;
  connection_owner: "workspace";
  connection_owner_role: "admin";
  // Opaque ref of the one accountable administrator (R-002).
  admin_ref: string;
  connected: boolean;
  members: string[];
  session_refs: Array<{ session_ref: string; member_ref: string }>;
  grants: CompanyConnectionGrant[];
  queued_lanes: Array<{ lane_ref: string; member_ref: string }>;
  unconsumed_receipts: Array<{ receipt_ref: string; member_ref: string }>;
};
export type GongCompanyConnection = CompanyConnection<"gong">;
export type ZoomCompanyConnection = CompanyConnection<"zoom">;

export function connectCompanyConnection<Provider extends string>(input: {
  identity: CompanyCanonicalSourceIdentity<Provider>;
  connection_ref: string;
  admin_ref: string;
  // What the presented credential claims to be. A personal credential is
  // refused here — the connect surface is where R-002's rule lives.
  presented_credential: { issued_for: "company" | "personal" };
}): CompanyConnection<Provider> {
  if (input.presented_credential.issued_for === "personal") throw new PersonalCredentialRefused(providerLabel(input.identity.provider));
  const admin_ref = assertOpaqueRef(input.admin_ref, "admin_ref");
  return {
    identity: input.identity,
    connection_ref: assertOpaqueRef(input.connection_ref, "connection_ref"),
    connection_owner: "workspace",
    connection_owner_role: "admin",
    admin_ref,
    connected: true,
    members: [admin_ref],
    session_refs: [],
    grants: [],
    queued_lanes: [],
    unconsumed_receipts: [],
  };
}

function assertAdministrator(state: CompanyConnection, actor_ref: string, action: "disconnect" | "rotate" | "revoke"): void {
  if (actor_ref.trim() !== state.admin_ref) throw new MemberConnectionRefusal(action, actor_ref, providerLabel(state.identity.provider));
}

// R-002: administrator disconnect or revoke is tenant-wide — every member's
// outstanding session references, grants, queued lanes, and unconsumed
// receipts die with the connection, because they were all held against it.
function invalidateTenantWide(state: CompanyConnection): CompanyConnection {
  return { ...state, connected: false, session_refs: [], grants: [], queued_lanes: [], unconsumed_receipts: [] };
}

export function disconnectCompanyConnection(state: CompanyConnection, actor_ref: string): CompanyConnection {
  assertAdministrator(state, actor_ref, "disconnect");
  return invalidateTenantWide(state);
}

export function revokeCompanyConnection(state: CompanyConnection, actor_ref: string): CompanyConnection {
  assertAdministrator(state, actor_ref, "revoke");
  return invalidateTenantWide(state);
}

export function rotateCompanyConnection(state: CompanyConnection, actor_ref: string, next: { connection_ref: string }): CompanyConnection {
  assertAdministrator(state, actor_ref, "rotate");
  return { ...state, connection_ref: assertOpaqueRef(next.connection_ref, "connection_ref") };
}

// Registering a study or inbox target against the connection is for current
// workspace members; connection membership never grants call access by itself
// — every read still needs the packet-local approval and the service grant.
export function assertCanApproveScope(state: CompanyConnection, actor_ref: string): void {
  if (!state.members.includes(actor_ref.trim())) throw new Error("only a current workspace member may register a target against the company connection; a removed member's approval rights have lapsed");
}

// A member who leaves loses their approvals and grants; the connection itself
// survives because it was never theirs (R-002). Removing the accountable
// administrator is ownership transfer, which stays deferred (R-002).
export function removeWorkspaceMember(state: CompanyConnection, member_ref: string): { connection: CompanyConnection; lapsed: { session_refs: string[]; grants: string[]; queued_lanes: string[]; unconsumed_receipts: string[] } } {
  const member = member_ref.trim();
  if (member === state.admin_ref) throw new Error("the accountable administrator cannot be removed like a member; ownership transfer is out of V0 scope and needs the second administrator's out-of-band confirmation");
  if (!state.members.includes(member)) throw new Error(`"${member}" is not a member of this workspace connection`);
  const lapses = <T extends { member_ref: string }>(items: T[]): T[] => items.filter((item) => item.member_ref !== member);
  const lapsed = {
    session_refs: state.session_refs.filter((item) => item.member_ref === member).map((item) => item.session_ref),
    grants: state.grants.filter((item) => item.member_ref === member).map((item) => item.grant_ref),
    queued_lanes: state.queued_lanes.filter((item) => item.member_ref === member).map((item) => item.lane_ref),
    unconsumed_receipts: state.unconsumed_receipts.filter((item) => item.member_ref === member).map((item) => item.receipt_ref),
  };
  return {
    connection: {
      ...state,
      members: state.members.filter((entry) => entry !== member),
      session_refs: lapses(state.session_refs),
      grants: lapses(state.grants),
      queued_lanes: lapses(state.queued_lanes),
      unconsumed_receipts: lapses(state.unconsumed_receipts),
    },
    lapsed,
  };
}

// --- Tenant-owned Teams connection (microsoft-teams-discovery-connector-v0 R-002) --

// A Teams connection belongs to the productfoo workspace (the company), consented by
// an administrator for the Microsoft Entra tenant — never one person's Teams
// login (R-002). The tenant-scoped canonical source identity keys on the
// workspace plus the consented tenant id; hosts never see it and still
// receive only the opaque `connection_ref`. Contract pin, not a runtime: the
// same shape as the Gong company connection, reusing the substrate's
// SourceId and ledger, with the spec's one delta — ownership transfer is
// possible WITH a second administrator's out-of-band confirmation.
export type TeamsCanonicalSourceIdentity = {
  foo_workspace: string;
  provider: "microsoft-teams";
  tenant_id: string;
};

export function teamsCanonicalSourceIdentity(input: { foo_workspace: string; tenant_id: string }): TeamsCanonicalSourceIdentity {
  const foo_workspace = input.foo_workspace.trim();
  const tenant_id = input.tenant_id.trim();
  if (!foo_workspace) throw new Error("a tenant-owned Teams connection needs a foo_workspace");
  if (!tenant_id) throw new Error("a tenant-owned Teams connection needs a tenant_id");
  return { foo_workspace, provider: "microsoft-teams", tenant_id };
}

// The substrate identity for the tenant connection: the workspace scopes the
// ledger key, so two workspaces sharing one Entra tenant never share approval
// state. Approve/revoke keep using the existing per-packet ledger unchanged.
export function teamsTenantSourceId(identity: TeamsCanonicalSourceIdentity): SourceId {
  return { ingress_path: "nango", provider: "microsoft-teams", connection_id: `${identity.foo_workspace}/${identity.tenant_id}` };
}

export function teamsConnectionReady(input: { connection_ref: string; admin_ref: string }): DiscoveryConnectionReady {
  const connection_ref = assertOpaqueRef(input.connection_ref, "connection_ref");
  const admin_ref = assertOpaqueRef(input.admin_ref, "admin_ref");
  return { event: "discovery_connection_ready", connection_owner: "workspace", admin_ref, connection_ref };
}

// Refusal for a member attempting an administrator-only connection lifecycle
// operation, ownership transfer included — transfer changes who the
// accountable administrator IS, so only the current administrator starts it.
export class TeamsMemberConnectionRefusal extends Error {
  constructor(
    readonly action: "disconnect" | "rotate" | "revoke" | "transfer",
    readonly actor_ref: string,
  ) {
    super(`the Teams connection is tenant-owned: only its accountable administrator may ${action} it; ask the administrator, then retry`);
    this.name = "TeamsMemberConnectionRefusal";
  }
}

// Refusal for a personal Teams credential (one person's login) presented as
// the tenant connection (R-002): productfoo connects the organization's consented
// app only, and says so.
export class TeamsPersonalCredentialRefused extends Error {
  readonly handoff: string;
  constructor() {
    super("a personal Teams login cannot stand in for the tenant connection");
    this.name = "TeamsPersonalCredentialRefused";
    this.handoff = "Teams connects once per tenant: ask your Microsoft 365 administrator to consent the productfoo app for the organization, then connect it through the productfoo-owned connect surface.";
  }
}

export type TeamsConnectionGrant = { grant_ref: string; member_ref: string };

// The closed tenant-connection state the ownership contract pins. Every
// outstanding item is member-attributed: session refs, queued lanes, and
// receipts arise inside a member's approved scope, and grants are per member.
export type TeamsTenantConnection = {
  identity: TeamsCanonicalSourceIdentity;
  // Opaque; the only connection identity a host ever receives.
  connection_ref: string;
  connection_owner: "workspace";
  connection_owner_role: "admin";
  // Opaque ref of the one accountable administrator (R-002).
  admin_ref: string;
  connected: boolean;
  members: string[];
  session_refs: Array<{ session_ref: string; member_ref: string }>;
  grants: TeamsConnectionGrant[];
  queued_lanes: Array<{ lane_ref: string; member_ref: string }>;
  unconsumed_receipts: Array<{ receipt_ref: string; member_ref: string }>;
};

export function connectTeamsTenantConnection(input: {
  identity: TeamsCanonicalSourceIdentity;
  connection_ref: string;
  admin_ref: string;
  // What the presented credential claims to be. A personal login is refused
  // here — the connect surface is where R-002's rule lives.
  presented_credential: { issued_for: "tenant" | "personal" };
}): TeamsTenantConnection {
  if (input.presented_credential.issued_for === "personal") throw new TeamsPersonalCredentialRefused();
  const admin_ref = assertOpaqueRef(input.admin_ref, "admin_ref");
  return {
    identity: input.identity,
    connection_ref: assertOpaqueRef(input.connection_ref, "connection_ref"),
    connection_owner: "workspace",
    connection_owner_role: "admin",
    admin_ref,
    connected: true,
    members: [admin_ref],
    session_refs: [],
    grants: [],
    queued_lanes: [],
    unconsumed_receipts: [],
  };
}

function assertTeamsAdministrator(state: TeamsTenantConnection, actor_ref: string, action: "disconnect" | "rotate" | "revoke" | "transfer"): void {
  if (actor_ref.trim() !== state.admin_ref) throw new TeamsMemberConnectionRefusal(action, actor_ref);
}

// R-002: administrator disconnect or revoke is tenant-wide — every member's
// outstanding session references, grants, queued lanes, and unconsumed
// receipts die with the connection, because they were all held against it.
function invalidateTeamsTenantWide(state: TeamsTenantConnection): TeamsTenantConnection {
  return { ...state, connected: false, session_refs: [], grants: [], queued_lanes: [], unconsumed_receipts: [] };
}

export function disconnectTeamsTenantConnection(state: TeamsTenantConnection, actor_ref: string): TeamsTenantConnection {
  assertTeamsAdministrator(state, actor_ref, "disconnect");
  return invalidateTeamsTenantWide(state);
}

export function revokeTeamsTenantConnection(state: TeamsTenantConnection, actor_ref: string): TeamsTenantConnection {
  assertTeamsAdministrator(state, actor_ref, "revoke");
  return invalidateTeamsTenantWide(state);
}

export function rotateTeamsTenantConnection(state: TeamsTenantConnection, actor_ref: string, next: { connection_ref: string }): TeamsTenantConnection {
  assertTeamsAdministrator(state, actor_ref, "rotate");
  return { ...state, connection_ref: assertOpaqueRef(next.connection_ref, "connection_ref") };
}

// Registering a study or inbox target against the connection is for current
// workspace members; connection membership never grants call access by itself
// — every read still needs the packet-local approval and the service grant.
export function assertCanApproveTeamsScope(state: TeamsTenantConnection, actor_ref: string): void {
  if (!state.members.includes(actor_ref.trim())) throw new Error("only a current workspace member may register a target against the tenant connection; a removed member's approval rights have lapsed");
}

// A member who leaves loses their approvals and grants; the connection itself
// survives because it was never theirs (R-002). Removing the accountable
// administrator is ownership transfer, which needs its own second-admin path.
export function removeTeamsWorkspaceMember(state: TeamsTenantConnection, member_ref: string): { connection: TeamsTenantConnection; lapsed: { session_refs: string[]; grants: string[]; queued_lanes: string[]; unconsumed_receipts: string[] } } {
  const member = member_ref.trim();
  if (member === state.admin_ref) throw new Error("the accountable administrator cannot be removed like a member; ownership transfer needs a second administrator's out-of-band confirmation (transferTeamsTenantConnection)");
  if (!state.members.includes(member)) throw new Error(`"${member}" is not a member of this tenant connection`);
  const lapses = <T extends { member_ref: string }>(items: T[]): T[] => items.filter((item) => item.member_ref !== member);
  const lapsed = {
    session_refs: state.session_refs.filter((item) => item.member_ref === member).map((item) => item.session_ref),
    grants: state.grants.filter((item) => item.member_ref === member).map((item) => item.grant_ref),
    queued_lanes: state.queued_lanes.filter((item) => item.member_ref === member).map((item) => item.lane_ref),
    unconsumed_receipts: state.unconsumed_receipts.filter((item) => item.member_ref === member).map((item) => item.receipt_ref),
  };
  return {
    connection: {
      ...state,
      members: state.members.filter((entry) => entry !== member),
      session_refs: lapses(state.session_refs),
      grants: lapses(state.grants),
      queued_lanes: lapses(state.queued_lanes),
      unconsumed_receipts: lapses(state.unconsumed_receipts),
    },
    lapsed,
  };
}

// R-002's one delta from the Gong ruling: ownership transfer IS in scope, but
// it needs a second administrator's out-of-band confirmation. The
// confirmation is a person other than the outgoing and incoming
// administrator — one administrator cannot confirm their own transfer, and
// the incoming administrator cannot either. The connection persists with its
// members and outstanding state; only the accountable administrator changes.
export function transferTeamsTenantConnection(
  state: TeamsTenantConnection,
  input: { actor_ref: string; next_admin_ref: string; second_admin_confirmation: { confirmed_by: string } },
): TeamsTenantConnection {
  assertTeamsAdministrator(state, input.actor_ref, "transfer");
  const next_admin_ref = assertOpaqueRef(input.next_admin_ref, "next_admin_ref");
  const confirmed_by = assertOpaqueRef(input.second_admin_confirmation.confirmed_by, "confirmed_by");
  if (confirmed_by === input.actor_ref.trim()) throw new Error("ownership transfer needs a SECOND administrator's confirmation; the outgoing administrator cannot confirm their own transfer");
  if (confirmed_by === next_admin_ref) throw new Error("ownership transfer needs a SECOND administrator's confirmation; the incoming administrator cannot confirm their own transfer");
  return {
    ...state,
    admin_ref: next_admin_ref,
    members: state.members.includes(next_admin_ref) ? state.members : [...state.members, next_admin_ref],
  };
}

// --- Read-only enforcement (R-007) -----------------------------------------

export class SourceWriteRefused extends Error {
  constructor(action: string) {
    super(`read-only V0: write-back to a connected source is refused (attempted: ${action})`);
    this.name = "SourceWriteRefused";
  }
}

// Any code path that would mutate a connected source must route through here so
// the refusal is a single, testable choke point rather than scattered intent.
export function refuseSourceWrite(action: string): never {
  throw new SourceWriteRefused(action);
}

// --- PII minimization for summaries (R-006) --------------------------------

// Strips the obvious third-party identifiers before a summary is allowed into a
// local-only ledger. Conservative by design: emails, phones, and long digit
// runs (account IDs) become typed placeholders.
export function minimizeSummary(text: string): string {
  // Walk @ delimiters once rather than restarting an email regex at every
  // character of a long non-email token. Preserve the existing match grammar.
  const parts: string[] = [];
  let consumed = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > consumed && /[\w.+-]/.test(text[start - 1])) start--;
    let dot = at + 1;
    while (dot < text.length && /[\w-]/.test(text[dot])) dot++;
    if (start === at || dot === at + 1 || text[dot] !== ".") continue;
    let end = dot + 1;
    while (end < text.length && /[\w.-]/.test(text[end])) end++;
    if (end === dot + 1) continue;
    parts.push(text.slice(consumed, start), "[email]");
    consumed = end;
  }
  parts.push(text.slice(consumed));
  return parts.join("")
    // Date-shaped runs (T-012 follow-up): an ISO date or timestamp is a date,
    // not contact data — typed [date] token, carved out before the phone
    // window so "2026-09-26" cannot read as a phone number.
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g, "[date]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/\b\d{6,}\b/g, "[id]");
}

// --- Packet connection state: the ownership seam (R-002) ---------------------
//
// The company-connection state machines above are pure functions. This is
// where they become enforceable at runtime (audit remediation F3: the
// ownership and revocation guards previously had zero call sites — contract
// pins only). The seam is the packet-ledger mutation entry points (`foo
// source approve`, `foo source revoke`, and `foo discovery revoke`, which
// funnels through the same revoke below): when a company or tenant connection
// state is persisted for the source being mutated, the mutation runs the
// existing ownership guard first. Where no connect surface has registered a
// connection yet, behavior is unchanged — that limitation is documented in
// docs/security-model.md ("Source access is not source approval").

type PacketConnectionState = CompanyConnection | TeamsTenantConnection;

const PACKET_CONNECTIONS_SCHEMA = "0.1";

// One company account per provider (R-002), so the packet's connection-state
// file is keyed by provider, each entry carrying the workspace-scoped
// connection_id it governs (`<foo_workspace>/<canonical_connection_key>` from
// gongWorkspaceSourceId / zoomWorkspaceSourceId / teamsTenantSourceId).
type PacketConnectionsFile = {
  schema_version: typeof PACKET_CONNECTIONS_SCHEMA;
  kind: "source_connection_state";
  connections: Record<string, { connection_id: string; state: PacketConnectionState }>;
};

function packetConnectionsPath(packetDir: string): string {
  return path.join(packetDir, "integration-connections.json");
}

function emptyPacketConnections(): PacketConnectionsFile {
  return { schema_version: PACKET_CONNECTIONS_SCHEMA, kind: "source_connection_state", connections: {} };
}

// A connection-state record is a GUARD input: a corrupt or unrecognized file
// must fail closed — the mutation is refused — rather than silently disabling
// the ownership guard it would have enforced.
function readPacketConnections(packetDir: string): PacketConnectionsFile {
  const file = packetConnectionsPath(packetDir);
  if (!existsSync(file)) return emptyPacketConnections();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`packet connection state is not valid JSON (${file}); refusing the guarded mutation rather than bypassing it — re-connect the company connection`);
  }
  const raw = parsed as Partial<PacketConnectionsFile> | null;
  if (!raw || raw.schema_version !== PACKET_CONNECTIONS_SCHEMA || raw.kind !== "source_connection_state" || !raw.connections || typeof raw.connections !== "object") {
    throw new Error(`packet connection state has an unrecognized shape (${file}); refusing the guarded mutation rather than bypassing it — re-connect the company connection`);
  }
  return raw as PacketConnectionsFile;
}

function writePacketConnections(packetDir: string, file: PacketConnectionsFile): void {
  // 0600: the state pins ownership (admin and member refs) for the workspace's
  // company connections; same mode as the discovery target registry.
  writeFileSync(packetConnectionsPath(packetDir), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

// The persisted state must carry the fields the guards read. A malformed
// record is refused, never trusted and never treated as "no connection".
function assertConnectionStateShape(state: PacketConnectionState): void {
  if (!state || typeof state !== "object" || state.connection_owner !== "workspace" || typeof state.admin_ref !== "string" || !Array.isArray(state.members) || !state.identity?.provider) {
    throw new Error("persisted packet connection state is malformed; refusing the guarded mutation — re-connect the company connection");
  }
}

// Load the company/tenant connection state persisted for one substrate source,
// or null when no connect surface has registered one (the V0 default: the
// CLI and hosted connect surface do not exist yet, so state is present only
// where a host seeds it — the seam then enforces; absent state changes
// nothing, which is the documented current behavior).
export function loadPacketConnectionState(packetDir: string, source: Pick<SourceId, "provider" | "connection_id">): PacketConnectionState | null {
  const { connections } = readPacketConnections(packetDir);
  const entry = connections[source.provider.trim().toLowerCase()];
  if (!entry || entry.connection_id !== source.connection_id) return null;
  assertConnectionStateShape(entry.state);
  return entry.state;
}

// Persist connection state created through the existing connect guards
// (connectCompanyConnection / connectTeamsTenantConnection, which refuse a
// personal credential at the connect surface itself). The CLI/hosted connect
// flow that will call this does not exist yet (R-008: the hosted tier stays
// contract_only); until it does, a host may seed state here directly.
export function savePacketConnectionState(packetDir: string, source: Pick<SourceId, "provider" | "connection_id">, state: PacketConnectionState): void {
  assertConnectionStateShape(state);
  const file = readPacketConnections(packetDir);
  file.connections[source.provider.trim().toLowerCase()] = { connection_id: source.connection_id, state };
  writePacketConnections(packetDir, file);
}

// The seam enforcement itself: when the source being mutated is governed by a
// persisted company/tenant connection, the ledger mutation runs the existing
// ownership guard first. Approving (registering a study or inbox target) is
// for current workspace members; revoking is the accountable administrator's
// (R-002) and routes through the revocation guard below so the tenant-wide
// invalidation is persisted with the revoke. Returns the governing state, or
// null when the source has no company connection (behavior unchanged).
function connectionStateForMutation(packetDir: string, id: Pick<SourceId, "provider" | "connection_id">, actor: string): PacketConnectionState | null {
  const state = loadPacketConnectionState(packetDir, id);
  if (!state) return null;
  if (isTeamsTenantConnection(state)) assertCanApproveTeamsScope(state, actor);
  else assertCanApproveScope(state, actor);
  return state;
}

// Honest narrowing for the two persisted state shapes: TeamsTenantConnection
// pins identity.provider to the literal "microsoft-teams"; a company
// connection never does (gong/zoom workspace identities).
function isTeamsTenantConnection(state: PacketConnectionState): state is TeamsTenantConnection {
  return state.identity.provider === "microsoft-teams";
}

// --- Slack scope selection (slack-discovery-connector-v0 R-004/D-002) ------

// The closed scope shape for Slack: explicit channel IDs and, for thread
// reads, explicit thread timestamps, always inside a bounded time window.
// There is deliberately no field that could name a user, a workspace, or "all
// channels" — anything else is refused before validation even runs.
export type SlackScope = {
  channel_ids: string[];
  thread_ts?: string[];
  window: { start?: string; end?: string };
};

// Versioned per-scope ceilings (RISK-003): channel sprawl is the chat class's
// failure mode, so a scope naming more than the ceiling is invalid — never
// silently truncated. A listing run that hits a content ceiling stops; it
// never widens.
export const SLACK_SCOPE_LIMITS = {
  policy_version: "slack-scope-0.1",
  max_channels_per_scope: 10,
  max_threads_per_scope: 25,
} as const;

// Slack channel identifiers: channels — public, and private admitted per the
// OQ-001 recommendation (explicit ID selection with the approval event as the
// administrator's attestation) — start with `C`. The DM shape (`D…`) and the
// group-DM / mpim shape (`G…`) are refused HERE, in the closed shape: there is
// no user field to name, so a DM could only be smuggled in as a channel ID and
// the prefix check rejects it (D-002 — refused by construction, not by policy
// toggle). Identifier shapes are beliefs owned by the feasibility task (T-001).
const SLACK_DM_LIKE_CHANNEL = /^[DG]/;
export const SLACK_CHANNEL_ID = /^C[A-Za-z0-9]{8,}$/;
// Thread bounds are composite `<channel-id>/<ts>` selectors: the binding to
// the channel that contains the thread is explicit, so a read never has to
// guess which approved channel to ask. The capture groups are for the runtime
// splitter; .test() behavior is unchanged. Patterns are shared with the
// runtime adapter and client so one definition owns the shape.
export const SLACK_THREAD_SELECTOR = /^(C[A-Za-z0-9]{8,})\/(\d{10}\.\d{6})$/;

export function slackScopeValidationError(scope: SlackScope): string | null {
  const start = Date.parse(scope.window?.start ?? "");
  const end = Date.parse(scope.window?.end ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "a slack scope needs a bounded time window with a valid start and end; a channel alone without a window is invalid";
  if (start > end) return "a slack scope's time window must end after it starts";
  const channels = Array.isArray(scope.channel_ids) ? scope.channel_ids : [];
  if (channels.length === 0) return "a slack scope needs explicit channel IDs; an empty channel set is invalid and the workspace as a whole is never in scope";
  if (channels.some((id) => typeof id !== "string" || id !== id.trim() || !id)) return "a slack scope's channel IDs must be explicit, exact identifiers";
  if (channels.some((id) => id.includes("*"))) return "a slack scope refuses wildcards: only explicit channel IDs are selectable, never the workspace";
  if (channels.some((id) => SLACK_DM_LIKE_CHANNEL.test(id))) return "a slack scope refuses DM and group-DM shapes by construction (D-002): identifiers starting D or G are outside V0";
  if (channels.some((id) => !SLACK_CHANNEL_ID.test(id))) return "a slack scope's channel IDs must be Slack channel identifiers (C…); anything else is refused rather than guessed";
  if (channels.length > SLACK_SCOPE_LIMITS.max_channels_per_scope) return `a slack scope is limited to ${SLACK_SCOPE_LIMITS.max_channels_per_scope} channels (RISK-003); approve more bounded scopes instead of widening one`;
  // R-004: explicit thread bounds are mandatory — a channel-and-window scope
  // alone can neither list nor read, so a scope without at least one thread
  // selector is invalid rather than a broad channel grant. Bounds are
  // composite `<channel-id>/<ts>` selectors bound to the scope's own channels.
  const threads = Array.isArray(scope.thread_ts) ? scope.thread_ts : [];
  if (threads.length === 0) return "a slack scope needs explicit thread bounds (at least one <channel-id>/<ts> selector); a channel-and-window scope alone can neither list nor read";
  const approvedChannels = new Set(channels);
  for (const entry of threads) {
    if (typeof entry !== "string" || entry !== entry.trim() || !SLACK_THREAD_SELECTOR.test(entry)) return "a slack scope's thread bounds must be explicit <channel-id>/<ts> selectors like C0123456789/1679237238.123456";
    if (!approvedChannels.has(entry.split("/")[0]!)) return "a slack scope's thread bounds must name channels listed in the same scope's channel_ids";
  }
  if (threads.length > SLACK_SCOPE_LIMITS.max_threads_per_scope) return `a slack scope is limited to ${SLACK_SCOPE_LIMITS.max_threads_per_scope} threads per approval (RISK-003); approve more bounded scopes instead of widening one`;
  return null;
}

// --- Ledger events ----------------------------------------------------------

type ApprovalEvent = {
  type: "com.adaptivespec.source.approved" | "com.adaptivespec.source.revoked";
  source_id: SourceId;
  packet: string;
  scope?: string;
  prior_scope?: string;
  by: string;
  at: string;
};

function eventsPath(packetDir: string): string {
  return path.join(packetDir, "events.jsonl");
}

// Source-derived summaries are local-only and gitignored (B1 / R-006); only
// payload-free approval/revoke provenance is committed to events.jsonl.
function integrationLedgerPath(packetDir: string): string {
  return path.join(packetDir, "integration-events.jsonl");
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Fail-closed: an unparseable ledger line is ignored, never trusted.
        return null;
      }
    })
    .filter((v): v is Record<string, unknown> => v !== null);
}

// Resolve the current approval state per source from the committed ledger.
// Latest approved/revoked event wins; anything else is excluded (fail-closed).
// Approvals ACCUMULATE scopes (#528): one connection may hold many
// deliberately-bounded scopes, each granted by its own approval event, so
// `scopes` collects every scope approved since the last revoke (trimmed,
// deduped, in ledger order — a missing/null scope contributes ""). `scope`
// remains the latest event's value for single-approval readers. A revoke
// clears the accumulation; the event schema is unchanged, so existing
// ledgers read identically (one approval event => one accumulated scope).
export function approvalStates(packetDir: string): Map<string, { state: ApprovalState; scope?: string; scopes: string[] }> {
  const states = new Map<string, { state: ApprovalState; scope?: string; scopes: string[] }>();
  for (const event of readJsonl(eventsPath(packetDir))) {
    const type = event.type;
    if (type !== "com.adaptivespec.source.approved" && type !== "com.adaptivespec.source.revoked") continue;
    const data = (event.data ?? {}) as { source_id?: SourceId; scope?: string | null };
    const sid = data.source_id;
    if (!sid || !sid.provider || !sid.connection_id) continue;
    const key = sourceKey(sid);
    if (type === "com.adaptivespec.source.approved") {
      const prior = states.get(key);
      const scopes = prior?.state === "approved" ? [...prior.scopes] : [];
      const granted = typeof data.scope === "string" ? data.scope.trim() : "";
      if (!scopes.includes(granted)) scopes.push(granted);
      states.set(key, { state: "approved", scope: data.scope ?? undefined, scopes });
    } else {
      states.set(key, { state: "revoked", scopes: [] });
    }
  }
  return states;
}

function appendEvent(packetDir: string, event: ApprovalEvent) {
  const idStem = `${event.type.split(".").pop()}_${sourceKey(event.source_id)}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const record = {
    specversion: "0.1",
    id: `evt_source_${idStem}`,
    source: "agent://foo/source",
    type: event.type,
    subject: `source:${event.source_id.provider}/${event.source_id.connection_id}`,
    time: event.at,
    actor: { type: "human", id: event.by, mode: "human-in-loop" },
    // Payload-free provenance only (B1): identity, packet, scope, who — no source content.
    data:
      event.type === "com.adaptivespec.source.approved"
        ? { source_id: event.source_id, packet: event.packet, scope: event.scope ?? null, approved_by: event.by, at: event.at }
        : { source_id: event.source_id, packet: event.packet, prior_scope: event.prior_scope ?? null, revoked_by: event.by, at: event.at },
    extensions: {},
  };
  appendFileSync(eventsPath(packetDir), `${JSON.stringify(record)}\n`);
  return record;
}

// --- Discovery (R-001) ------------------------------------------------------

// The runtime hands the accessible tool surface in as JSON. Each entry is the
// minimal identity the runtime knows; classification and approval state are
// derived here. Discovery is read-only and never reads source content.
export type DiscoveredServer = { ingress_path?: IngressPath; provider: string; connection_id: string };

export type DiscoverRow = SourceId & {
  source_category: string;
  evidence_class: EvidenceClass;
  evidence_class_label: string;
  sensitivity: Sensitivity;
  approval_state: ApprovalState;
  registered: boolean;
  discovered_at: string;
};

export function loadSurface(surfacePath: string): DiscoveredServer[] {
  if (!existsSync(surfacePath)) throw new Error(`discovered-surface file not found: ${surfacePath}`);
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(surfacePath);
  } catch {
    throw new Error(`discovered-surface file is not valid JSON: ${surfacePath}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(list)) throw new Error("discovered-surface must be an array of servers (or {servers: [...]})");
  return list.map((raw) => {
    const s = (raw ?? {}) as Partial<DiscoveredServer>;
    if (!s.provider || !s.connection_id) throw new Error("each discovered server needs provider and connection_id");
    return { ingress_path: s.ingress_path ?? "mcp", provider: s.provider, connection_id: s.connection_id };
  });
}

export function discover(packetDir: string, servers: DiscoveredServer[], at: string): DiscoverRow[] {
  const states = approvalStates(packetDir);
  // Idempotent + dedupe on {provider, connection_id} (R-008): one entity is one row.
  const seen = new Map<string, DiscoverRow>();
  for (const server of servers) {
    const ingress = server.ingress_path ?? "mcp";
    let classification: Classification;
    try {
      classification = classifyProvider(server.provider);
    } catch {
      classification = { ...MOST_RESTRICTIVE_DEFAULT }; // fail-closed on any classify error
    }
    const key = sourceKey(server);
    const approval = states.get(key)?.state ?? "excluded";
    const row: DiscoverRow = {
      ingress_path: ingress,
      provider: server.provider,
      connection_id: server.connection_id,
      source_category: classification.source_category,
      evidence_class: classification.evidence_class,
      evidence_class_label: EVIDENCE_CLASS_GLOSS[classification.evidence_class],
      sensitivity: classification.sensitivity,
      approval_state: approval,
      registered: classification.registered,
      discovered_at: at,
    };
    seen.set(key, row);
  }
  return [...seen.values()];
}

// --- Approve / revoke (R-003, R-005) ---------------------------------------

// A requested scope is covered by an exact (trimmed) match or by a stored
// wildcard "*". Deliberately conservative: prefix/alias overlap is NOT treated
// as covered — the worst case is one extra, harmless accumulating approval
// event, never a false "already approved" no-op on a consent surface (#528).
function scopeAlreadyApproved(approvedScopes: string[], requested: string): boolean {
  const want = requested.trim();
  return approvedScopes.some((granted) => granted === "*" || granted === want);
}

export function approve(
  packetDir: string,
  id: SourceId,
  opts: { packet: string; scope: string; by: string; at: string },
): { approved: boolean; idempotent: boolean } {
  // Ownership seam (R-002): when the source is governed by a persisted
  // company/tenant connection, only a current workspace member may register a
  // target against it; a removed member's approval rights have lapsed. No
  // connection state (the V0 default) leaves this path unchanged.
  const governing = connectionStateForMutation(packetDir, id, opts.by);
  // #889: the accountable administrator's revoke is not undone by a member.
  // A revoked connection (connected: false) takes no new approvals until the
  // administrator reconnects it; otherwise the ledger would show the source
  // approved again right after its owner revoked it.
  if (governing && !governing.connected) {
    throw new GateBlock(
      `this connection was revoked by its accountable administrator; it takes no new approvals until the administrator reconnects it (${id.provider} ${id.connection_id})`,
      "E_GATE_BLOCKED",
    );
  }
  const states = approvalStates(packetDir);
  const existing = states.get(sourceKey(id));
  // Idempotency is per (source, scope), not per source (#528): re-approving is
  // a no-op ONLY when the requested scope is already covered by the stored
  // approval (same scope granted before, or a stored wildcard "*"). Otherwise
  // the approval is scope-additive — a new event carries the new scope — so one
  // connection can hold many deliberately-bounded scopes and the CLI never
  // reports success while writing nothing (R-008 idempotency, narrowed).
  if (existing?.state === "approved" && scopeAlreadyApproved(existing.scopes, opts.scope)) {
    return { approved: true, idempotent: true };
  }
  appendEvent(packetDir, { type: "com.adaptivespec.source.approved", source_id: id, packet: opts.packet, scope: opts.scope, by: opts.by, at: opts.at });
  return { approved: true, idempotent: false };
}

export function revoke(
  packetDir: string,
  id: SourceId,
  opts: { packet: string; by: string; at: string; priorScope?: string },
): { revoked: boolean; purged: number; event_digest: string } {
  // Ownership seam (R-002): revoking a source governed by a company/tenant
  // connection is the accountable administrator's action — the existing
  // revocation guard refuses a member (MemberConnectionRefusal) before any
  // ledger event is written, and the tenant-wide invalidation it returns is
  // persisted so the connection state cannot claim to outlive its revoke.
  const connectionState = connectionStateForMutation(packetDir, id, opts.by);
  if (connectionState) {
    const invalidated = isTeamsTenantConnection(connectionState) ? revokeTeamsTenantConnection(connectionState, opts.by) : revokeCompanyConnection(connectionState, opts.by);
    savePacketConnectionState(packetDir, id, invalidated);
  }
  const event = appendEvent(packetDir, {
    type: "com.adaptivespec.source.revoked",
    source_id: id,
    packet: opts.packet,
    prior_scope: opts.priorScope,
    by: opts.by,
    at: opts.at,
  });
  const purged = purgeSummaries(packetDir, id, opts.at);
  // The authenticated local revocation event digest (nango-discovery-connector-v0
  // R-008): binds any discovery_suspend_target fan-out to the exact, content-free
  // revocation event, so the hosted service can verify the suspension request
  // against a real local revoke. The immediate local revoke above is already
  // applied and is never weakened by what callers do with this digest.
  const event_digest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
  return { revoked: true, purged, event_digest };
}

// Tombstone + redaction over the local-only summary ledger, preserving the
// append-only line count (R-005): summaries from the revoked source are
// rewritten to a payload-free tombstone, never deleted.
function purgeSummaries(packetDir: string, id: SourceId, at: string): number {
  const file = integrationLedgerPath(packetDir);
  if (!existsSync(file)) return 0;
  const key = sourceKey(id);
  let purged = 0;
  const rewritten = readJsonl(file).map((entry) => {
    const sid = entry.source_id as SourceId | undefined;
    if (sid && sourceKey(sid) === key && entry.tombstoned !== true) {
      purged += 1;
      return { source_id: sid, tombstoned: true, revoked_at: at };
    }
    return entry;
  });
  writeFileSync(file, rewritten.map((e) => JSON.stringify(e)).join("\n") + (rewritten.length ? "\n" : ""));
  return purged;
}

// --- Browser-initiated connects (logged-in-experience-v0 T-009, OQ-010) -----
//
// OQ-010 decision: a browser OAuth handshake emits NO packet-ledger event.
// The only event-shaped fact a connect produces is the payload-free readiness
// provenance the nango contract already defines (DiscoveryConnectionReady,
// workspace-owned) — handed to the caller as a value, never appended to
// events.jsonl. The packet ledger keeps exactly two content-relevant event
// types (approved/revoked): a "connected" event would invite readers to treat
// connection as permission — the exact G-4 conflation — and the web app has
// no ledger write path by design (deployed hosts have no repo checkout, B1;
// the web drift-guard forbids sourceIngress imports there).
//
// What the handshake may never imply (pinned in test/browserConnectIngress.test.ts):
//  - it does not create or imply a per-packet approval: after a connect the
//    source's ledger state is unchanged and discover() reports it `excluded`;
//  - it does not admit content: browser-path ingress must pass
//    browserIngressDecision — live connection AND explicit per-packet
//    `approved` ledger state, both required (C-017);
//  - it does not change classification: ingress_path "browser" is provenance
//    only (R-008); unknown providers keep the most-restrictive default, and
//    prospect/opportunity classes stay sensitivity high or inherit it (G-4);
//  - the OAuth granted-scope string is not a ledger scope: the approval's
//    scope is chosen per packet at approval time by approve(); nothing
//    derives it from the grant.

// A browser connection as stored by web/foo-site (team_connections): the
// grant identity is per-grant — a re-connect after a revoke mints a fresh
// row — and both refs are opaque (uuids): no emails, no display names.
export type BrowserConnection = {
  provider: string;
  team_ref: string;
  connection_ref: string;
  revoked_at?: string | null;
};

// The opaque, stable per-grant ledger key: team-scoped so two teams' grants
// never share gate state, and per-grant so a re-connect after revoke is a NEW
// source to every packet ledger — stale approvals cannot ride a fresh
// credential (the structural half of C-018).
export function browserConnectionRef(input: { team_ref: string; connection_ref: string }): string {
  return assertOpaqueRef(
    `${assertOpaqueRef(input.team_ref, "team_ref")}/${assertOpaqueRef(input.connection_ref, "connection_ref")}`,
    "browser connection ref",
  );
}

export function browserConnectionSourceId(conn: BrowserConnection): SourceId {
  return { ingress_path: "browser", provider: conn.provider.toLowerCase(), connection_id: browserConnectionRef(conn) };
}

// The handshake's ONLY emission: payload-free readiness provenance reusing
// the nango contract's closed shape. Team connects are workspace-owned; the
// accountable ref is the account that completed the OAuth consent. This is a
// fact about identity, not content — it never implies approval (G-4).
export function browserConnectionReady(conn: BrowserConnection, admin_ref: string): DiscoveryConnectionReady {
  return companyConnectionReady({ connection_ref: browserConnectionRef(conn), admin_ref });
}

export type BrowserIngressStage = "liveness" | "approval";
export type BrowserIngressDecision =
  | { allowed: true; classification: Classification; approval_state: "approved" }
  | { allowed: false; stage: BrowserIngressStage; reason: string; classification: Classification; approval_state: ApprovalState };

// The gate any browser-path ingress must pass before touching packet content.
// Read-only over the ledger — approve()/revoke() remain the only ledger
// writers, so no decision path can mint its own permission. Three refusals:
//  - liveness: a revoked connection refuses even where a stale `approved` row
//    lingers in some packet's ledger (C-018);
//  - approval: this packet's own events.jsonl must carry an explicit approved
//    event for this source key — connecting alone leaves the source `excluded`
//    (C-017; G-4: connection ≠ approval);
//  - classification is always computed and reported so callers surface honest
//    provenance; unregistered providers carry the most-restrictive default.
export function browserIngressDecision(packetDir: string, conn: BrowserConnection): BrowserIngressDecision {
  const classification = classifyProvider(conn.provider);
  const id = browserConnectionSourceId(conn);
  const approval_state = approvalStates(packetDir).get(sourceKey(id))?.state ?? "excluded";
  if (conn.revoked_at) {
    return {
      allowed: false,
      stage: "liveness",
      reason: "connection revoked — ingress from this source is stopped (C-018)",
      classification,
      approval_state,
    };
  }
  if (approval_state !== "approved") {
    return {
      allowed: false,
      stage: "approval",
      reason: `source not approved in this packet (state: ${approval_state}) — connecting is not approval (G-4)`,
      classification,
      approval_state,
    };
  }
  return { allowed: true, classification, approval_state: "approved" };
}

// Write a PII-minimized summary for an approved selection into the local-only
// ledger. Refuses if the source is not currently approved (fail-closed gate,
// R-003). No raw payload ever lands in a committed file (B1).
export function recordSummary(
  packetDir: string,
  id: SourceId,
  opts: { selection: string; summary: string; at: string },
): { recorded: boolean; reason?: string } {
  const state = approvalStates(packetDir).get(sourceKey(id))?.state ?? "excluded";
  if (state !== "approved") return { recorded: false, reason: `source not approved (state: ${state})` };
  mkdirSync(path.dirname(integrationLedgerPath(packetDir)), { recursive: true });
  const entry = {
    source_id: id,
    selection: opts.selection,
    summary: minimizeSummary(opts.summary),
    evidence_class: classifyProvider(id.provider).evidence_class,
    at: opts.at,
    tombstoned: false,
  };
  appendFileSync(integrationLedgerPath(packetDir), `${JSON.stringify(entry)}\n`);
  return { recorded: true };
}

// A reviewer-actionable evidence claim (R-004/C-008/C-009): unlike a summary,
// a claim is reconciliation-shaped — it cites a specific packet task and says
// whether the source evidence supports or contradicts that task's completion.
// Fail-closed twice: the source must be approved, AND the selection must fall
// inside the approved scope (an approved connection does not surface
// unapproved tables). The claim text is PII-minimized; the raw payload never
// lands anywhere. A payload-free provenance event goes to committed
// events.jsonl; the claim body stays in the local-only integration ledger.
export type ClaimDirection = "supports" | "contradicts";

export function recordClaim(
  packetDir: string,
  id: SourceId,
  opts: { selection: string; claim: string; cites_task: string; direction: ClaimDirection; at: string },
): { recorded: boolean; reason?: string } {
  const approval = approvalStates(packetDir).get(sourceKey(id));
  const state = approval?.state ?? "excluded";
  if (state !== "approved") return { recorded: false, reason: `source not approved (state: ${state})` };
  // Approvals accumulate per scope (#528): the selection is admitted when ANY
  // approved scope covers it. An empty stored scope or "*" is unrestricted —
  // unchanged single-approval semantics.
  const scopes = approval?.scopes ?? [];
  const unrestricted = scopes.length === 0 || scopes.some((s) => !s || s === "*");
  if (!unrestricted && !scopes.some((s) => selectionWithinScope(opts.selection, s))) {
    const listed = scopes.map((s) => `"${s}"`).join(", ");
    return { recorded: false, reason: `selection "${opts.selection}" is outside the approved scope${scopes.length === 1 ? "" : "s"} ${listed} — unapproved tables do not surface` };
  }
  mkdirSync(path.dirname(integrationLedgerPath(packetDir)), { recursive: true });
  const entry = {
    kind: "claim",
    source_id: id,
    selection: opts.selection,
    claim: minimizeSummary(opts.claim),
    cites_task: opts.cites_task,
    direction: opts.direction,
    evidence_class: classifyProvider(id.provider).evidence_class,
    at: opts.at,
    tombstoned: false,
  };
  appendFileSync(integrationLedgerPath(packetDir), `${JSON.stringify(entry)}\n`);
  // Committed provenance is ids-only: which source, which selection, which
  // task, which way — never the claim text (B1/R-008 keeps source-derived
  // content in the local-only ledger). Same actor shape as the conflict event:
  // productfoo's deterministic CLI, not an LLM.
  const record = {
    specversion: "0.1",
    id: `evt_source_claim_${sourceKey(id)}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    source: "agent://foo/source",
    type: "com.adaptivespec.source.claim",
    subject: `source:${id.provider}/${id.connection_id}`,
    time: opts.at,
    actor: { type: "agent", id: "foo-cli", provider: "foo", model: "deterministic", persona: "tool", skills: [], adapter: "cli", mode: "human-in-loop" },
    data: { source_id: id, selection: opts.selection, cites_task: opts.cites_task, direction: opts.direction, evidence_class: entry.evidence_class },
    extensions: {},
  };
  appendFileSync(eventsPath(packetDir), `${JSON.stringify(record)}\n`);
  return { recorded: true };
}

// Scope containment for V0 selections (schema.table strings): the selection is
// in scope when it equals the scope or descends from it (scope "app_data"
// admits "app_data.orders"; it never admits "analytics.events").
function selectionWithinScope(selection: string, scope: string): boolean {
  return selection === scope || selection.startsWith(`${scope}.`);
}

// Generic payload-free conflict-event writer the GitHub verdict engine reuses
// (github-integration-v0 R-005/C-006): a contradicted done_when criterion records
// a `com.adaptivespec.conflict.detected` event carrying only ids/kinds the agent
// derived — never raw source payload (B1). The actor is productfoo's deterministic CLI,
// not an LLM, so its identity carries no model id.
export function appendSourceConflictEvent(
  packetDir: string,
  opts: { source_id: SourceId; conflicts: Array<{ criterion_id: string; status?: string; check_kind?: string }>; note: string },
  at: string,
): void {
  const record = {
    specversion: "0.1",
    id: `evt_source_conflict_${opts.source_id.provider}_${sourceKey(opts.source_id)}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    source: "agent://foo/source",
    type: "com.adaptivespec.conflict.detected",
    subject: `source:${opts.source_id.provider}/${opts.source_id.connection_id}`,
    time: at,
    actor: { type: "agent", id: "foo-cli", provider: "foo", model: "deterministic", persona: "tool", skills: [], adapter: "cli", mode: "human-in-loop" },
    data: { source_id: opts.source_id, conflicts: opts.conflicts, note: opts.note },
    extensions: {},
  };
  appendFileSync(eventsPath(packetDir), `${JSON.stringify(record)}\n`);
}

// Append a record to the packet's LOCAL-ONLY, gitignored integration ledger
// (`integration-events.jsonl`, B1 / R-008). Source-derived receipts and summaries
// live here, never in committed packet files; only payload-free provenance is
// committed to events.jsonl.
export function appendIntegrationRecord(packetDir: string, record: Record<string, unknown>): void {
  mkdirSync(path.dirname(integrationLedgerPath(packetDir)), { recursive: true });
  appendFileSync(integrationLedgerPath(packetDir), `${JSON.stringify(record)}\n`);
}

// --- Coverage-honest receipt (R-006) ---------------------------------------

export type Receipt = {
  schema_version: "0.1";
  packet: string;
  generated_at: string;
  discovered: DiscoverRow[];
  selected_and_read: Array<{ source_id: SourceId; selection: string; evidence_class_label: string }>;
  // Reviewer-actionable claims (C-009): each cites a packet task and a
  // direction, so a reviewer can act on it during reconciliation. Ids and
  // selection only — the claim text stays in the local-only ledger.
  claims: Array<{ source_id: SourceId; selection: string; cites_task: string; direction: ClaimDirection; evidence_class_label: string }>;
  out_of_selection_scope: string;
  excluded_after_evaluation: Array<{ source_id: SourceId; reason: string }>;
  summarized: number;
  revoked: SourceId[];
  coverage_note: string;
};

export function buildReceipt(packetDir: string, servers: DiscoveredServer[], at: string): Receipt {
  const discovered = discover(packetDir, servers, at);
  const states = approvalStates(packetDir);
  const summaries = readJsonl(integrationLedgerPath(packetDir));

  const selected_and_read = summaries
    .filter((e) => e.tombstoned !== true)
    .map((e) => {
      const sid = e.source_id as SourceId;
      return {
        source_id: sid,
        selection: String(e.selection ?? ""),
        evidence_class_label: EVIDENCE_CLASS_GLOSS[(e.evidence_class as EvidenceClass) ?? "context_only"],
      };
    });

  const claims = summaries
    .filter((e) => e.kind === "claim" && e.tombstoned !== true)
    .map((e) => ({
      source_id: e.source_id as SourceId,
      selection: String(e.selection ?? ""),
      cites_task: String(e.cites_task ?? ""),
      direction: (e.direction as ClaimDirection) ?? "supports",
      evidence_class_label: EVIDENCE_CLASS_GLOSS[(e.evidence_class as EvidenceClass) ?? "context_only"],
    }));

  const excluded_after_evaluation = discovered
    .filter((row) => (states.get(sourceKey(row))?.state ?? "excluded") !== "approved")
    .map((row) => ({
      source_id: { ingress_path: row.ingress_path, provider: row.provider, connection_id: row.connection_id },
      reason: states.get(sourceKey(row))?.state === "revoked" ? "revoked" : "not approved for this packet",
    }));

  const revoked = [...states.entries()]
    .filter(([, v]) => v.state === "revoked")
    .map(([key]) => {
      // Keys may carry a third `external_id` segment for per-PR providers (R-011);
      // keep it so a revoked GitHub PR reconstructs to the right source.
      const [provider, connection_id, ...rest] = key.split("::");
      const external_id = rest.length ? rest.join("::") : undefined;
      return { ingress_path: "mcp" as IngressPath, provider, connection_id, ...(external_id ? { external_id } : {}) };
    });

  return {
    schema_version: "0.1",
    packet: path.basename(packetDir),
    generated_at: at,
    discovered,
    selected_and_read,
    claims,
    // Coverage honesty: the receipt reports only what was selected-and-read and
    // never implies the full source was read.
    out_of_selection_scope: "Only explicitly selected items were read; the rest of each source was not accessed.",
    excluded_after_evaluation,
    summarized: selected_and_read.length,
    revoked,
    coverage_note: "Read-only V0. This receipt covers selected reads only and does not claim full-source coverage.",
  };
}

// --- Linear issue/project → seed mapping (linear_integration_v0 R-002/R-004) -

// V0 admits Linear evidence at per-issue and per-project granularity only.
// Team/label/cycle bulk-pull is a non-goal (a far larger blast radius for one
// approval); reaching for it is refused, not silently widened.
const LINEAR_ADMITTED_UNITS = new Set(["issue", "project"]);

export type LinearSelection = { unit: "issue" | "project"; connection_id: string; external_id: string; url: string };

// Parse a `linear:<url>` selector (or a bare linear.app URL) into a selection.
// Rejects any unit outside per-issue / per-project (R-004).
export function parseLinearSource(spec: string): LinearSelection {
  const raw = spec.startsWith("linear:") ? spec.slice("linear:".length) : spec;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid Linear URL: ${raw}`);
  }
  if (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) {
    throw new Error(`not a linear.app URL: ${raw}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [workspace, unit, externalId] = parts;
  if (!workspace || !unit || !externalId) throw new Error(`unrecognized Linear URL shape: ${raw}`);
  if (!LINEAR_ADMITTED_UNITS.has(unit)) {
    // The caller asked for something productfoo does not admit. A bad invocation, not a defect —
    // it prints guidance and must never page anyone.
    throw new UsageError(
      `Linear selection unit '${unit}' is out of scope for V0 — only per-issue and per-project are admitted (linear-integration-v0 R-004)`,
      "E_BAD_FLAG",
    );
  }
  return { unit: unit as "issue" | "project", connection_id: workspace, external_id: externalId, url: raw };
}

// The small, agent-legible candidate a verified Linear selection becomes. It
// carries only shape-consumable fields, PII-minimized, keyed by the substrate's
// durable source identity plus the Linear external_id. It is approved-private-
// context: directional, not yet a packet requirement (verification is R-003/T-003).
export type LinearCandidate = {
  source_id: SourceId & { external_id: string };
  evidence_authority: "approved-private-context";
  title: string;
  intent: string;
  url: string;
  state: string;
};

export type LinearPayload = { title?: string; description?: string; state?: string };

export function buildLinearCandidate(selection: LinearSelection, payload: LinearPayload): LinearCandidate {
  return {
    source_id: {
      ingress_path: "mcp",
      provider: "linear",
      connection_id: selection.connection_id,
      external_id: selection.external_id,
    },
    evidence_authority: "approved-private-context",
    title: minimizeSummary(payload.title ?? ""),
    intent: minimizeSummary(payload.description ?? payload.title ?? ""),
    url: selection.url,
    state: payload.state ?? "unknown",
  };
}

// Read-only Linear MCP tools the ingest path may call (linear_integration_v0
// R-005). This is a DEFAULT-DENY allow-list, not a denylist: a tool not listed
// here is refused, so any mutating or outbound Linear tool — including ones not
// yet invented — is structurally unreachable from a context holding Linear
// issue/comment content, rather than merely discouraged by a prompt.
export const LINEAR_READONLY_TOOLS = new Set<string>([
  "list_issues",
  "get_issue",
  "list_projects",
  "get_project",
  "list_comments",
  "get_comment",
  "list_issue_labels",
  "search_issues",
]);

// The single choke point the Linear-ingest path must route every tool call
// through. Refuses anything off the read-only allow-list via the substrate's
// read-only guard (R-007), so the refusal is one testable place.
export function assertLinearReadOnlyTool(toolName: string): void {
  const bare = toolName.split("__").pop() ?? toolName;
  if (!LINEAR_READONLY_TOOLS.has(bare)) {
    refuseSourceWrite(`linear tool '${toolName}' is not on the read-only allow-list`);
  }
}

// --- Jira work-system source (jira-source-connector-v0) ---------------------

// Jira enters as a substrate source beside Linear (jira-source-connector-v0
// D-001): issue state is work-system truth, not customer voice, so it copies
// the Linear shape — parse + candidate builders and a default-deny read-only
// allowlist — never the Gong session-adapter path. Jira-specific endpoint
// names, JQL semantics, and pagination stay inside this parse layer (R-001);
// nothing downstream reads the raw issue shape.

// The closed raw issue shape the runtime hands in (Contracts). Only the parse
// layer reads it. `status` is the tracker's own status NAME — Jira workflows
// are site-configurable, so done-category detection at reconcile time matches
// a small documented name set and reports its basis instead of pretending to
// know the site's workflow.
export type JiraRawIssue = {
  key: string;
  summary: string;
  status: string;
  assignee_display?: string;
  updated: string;
  remote_links?: Array<{ url?: string; title?: string }>;
};

// Standard Jira Cloud issue key: `<PROJECT KEY>-<number>`. The project key
// starts with a letter; the closed raw shape carries no separate project
// field, and scope containment (R-004) needs one — it is derived here or the
// issue is refused, never guessed from summary text.
const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function jiraIssueProject(key: string): string {
  const m = key.trim().match(JIRA_ISSUE_KEY);
  if (!m) throw new Error(`not a standard Jira issue key (expected <PROJECT>-<number>): ${key}`);
  return key.trim().split("-")[0];
}

// Accepts `acme`, `acme.atlassian.net`, or a site URL; returns the site host.
// Jira Cloud only in V0 — Data Center/Server hosts are refused, not adapted.
export function jiraSiteHost(site: string): string {
  const host = site
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!host.endsWith(".atlassian.net")) {
    throw new Error(`not a Jira Cloud site (expected <site>.atlassian.net): ${site}`);
  }
  return host;
}

// Validates one raw issue into the closed shape. Unknown top-level fields are
// REFUSED, not ignored: a new provider field (say, a description body) would
// otherwise silently ride past the parse layer into downstream consumers.
export function parseJiraSource(raw: unknown): JiraRawIssue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`jira issue must be a JSON object, got ${raw === null ? "null" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(["key", "summary", "status", "assignee_display", "updated", "remote_links"]);
  for (const field of Object.keys(obj)) {
    if (!allowed.has(field)) {
      throw new Error(`jira issue shape is closed — unknown field '${field}' is refused; only the parse layer reads raw payloads`);
    }
  }
  const str = (v: unknown, label: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`jira issue ${label} is required`);
    return v.trim();
  };
  const key = str(obj.key, "key");
  jiraIssueProject(key); // refused above if the key is not the standard form
  const summary = str(obj.summary, "summary");
  const status = str(obj.status, "status");
  const updated = str(obj.updated, "updated");
  if (Number.isNaN(Date.parse(updated))) throw new Error(`jira issue updated is not an ISO timestamp: ${updated}`);
  let assignee_display: string | undefined;
  if (obj.assignee_display !== undefined && obj.assignee_display !== null) {
    assignee_display = str(obj.assignee_display, "assignee_display");
  }
  let remote_links: JiraRawIssue["remote_links"];
  if (obj.remote_links !== undefined && obj.remote_links !== null) {
    if (!Array.isArray(obj.remote_links)) throw new Error("jira issue remote_links must be an array");
    remote_links = obj.remote_links.map((link) => {
      if (!link || typeof link !== "object" || Array.isArray(link)) throw new Error("jira remote link must be an object");
      const l = link as Record<string, unknown>;
      for (const field of Object.keys(l)) {
        if (field !== "url" && field !== "title") throw new Error(`jira remote link shape is closed — unknown field '${field}'`);
      }
      const out: { url?: string; title?: string } = {};
      if (l.url !== undefined && l.url !== null) {
        const url = str(l.url, "remote link url");
        if (!/^https:\/\//.test(url)) throw new Error(`jira remote link url must be https: ${url}`);
        out.url = url;
      }
      if (l.title !== undefined && l.title !== null) out.title = str(l.title, "remote link title");
      return out;
    });
  }
  return { key, summary, status, ...(assignee_display ? { assignee_display } : {}), updated, ...(remote_links ? { remote_links } : {}) };
}

// The approved-scope shape for jira (Contracts): explicit projects and/or a
// bounded JQL the approver can read, inside a bounded window. Empty selections
// are invalid, and there is no wildcard — a site-wide listing is refused
// (R-004, RISK-002). Parsing validates and bounds; it never widens the JQL
// (RISK-003).
export type JiraScope = { projects: string[]; jql?: string; window: string };

// A bounded window: an explicit ISO date range or a rolling `Nd` window. An
// open-ended window is the site-wide blast radius R-004 forbids.
const JIRA_WINDOW = /^(?:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}|\d{1,4}d)$/;
// The approver reads the JQL in the scope (RISK-003); the cap keeps it readable.
const JIRA_JQL_MAX = 512;
const JIRA_PROJECTS_MAX = 25;

export function parseJiraScope(raw: unknown): JiraScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`jira scope must be an object {projects, jql?, window}`, "E_BAD_FLAG");
  }
  const obj = raw as Record<string, unknown>;
  for (const field of Object.keys(obj)) {
    if (field !== "projects" && field !== "jql" && field !== "window") {
      throw new UsageError(`jira scope shape is closed — unknown field '${field}'`, "E_BAD_FLAG");
    }
  }
  let projects: string[] = [];
  if (obj.projects !== undefined && obj.projects !== null) {
    if (!Array.isArray(obj.projects)) throw new UsageError(`jira scope projects must be an array of project keys`, "E_BAD_FLAG");
    projects = [...new Set((obj.projects as unknown[]).map((p) => {
      if (typeof p !== "string" || !p.trim()) throw new UsageError(`jira scope projects must be non-empty project keys`, "E_BAD_FLAG");
      const key = p.trim();
      if (key === "*") throw new UsageError(`jira scope refuses '*' — a site-wide listing is not approvable (jira-source-connector-v0 R-004); name explicit projects`, "E_BAD_FLAG");
      return key;
    }))];
  }
  let jql: string | undefined;
  if (obj.jql !== undefined && obj.jql !== null) {
    if (typeof obj.jql !== "string" || !obj.jql.trim()) throw new UsageError(`jira scope jql must be a non-empty bounded string the approver can read`, "E_BAD_FLAG");
    jql = obj.jql.trim();
    if (jql.length > JIRA_JQL_MAX) throw new UsageError(`jira scope jql exceeds ${JIRA_JQL_MAX} chars — the approver must be able to read it (RISK-003)`, "E_BAD_FLAG");
  }
  if (projects.length === 0 && !jql) {
    throw new UsageError(`jira scope is empty — name explicit projects or a bounded jql; a selector-less (site-wide) listing is refused (jira-source-connector-v0 R-004)`, "E_BAD_FLAG");
  }
  if (projects.length > JIRA_PROJECTS_MAX) throw new UsageError(`jira scope exceeds ${JIRA_PROJECTS_MAX} projects — narrow the selection (R-004)`, "E_BAD_FLAG");
  const window = typeof obj.window === "string" ? obj.window.trim() : "";
  if (!window || !JIRA_WINDOW.test(window)) {
    throw new UsageError(`jira scope needs a bounded window: 'YYYY-MM-DD..YYYY-MM-DD' or 'Nd' rolling days`, "E_BAD_FLAG");
  }
  return { projects, ...(jql ? { jql } : {}), window };
}

// Canonical ledger string for an approved jira scope: stable, approver-readable
// JSON. Approval accumulation is EXACT-match on this string (the substrate never
// does fuzzy scope coverage), so the form is pinned here and nowhere else.
export function jiraScopeString(scope: JiraScope): string {
  return JSON.stringify({ projects: scope.projects, ...(scope.jql ? { jql: scope.jql } : {}), window: scope.window });
}

// Read a stored/declared scope string back into the closed shape. An
// unparseable scope is fail-closed: it refuses rather than admits anything.
export function parseJiraScopeString(scope: string): JiraScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    throw new UsageError(`jira scope is not the canonical shape ({projects, jql?, window} JSON): ${scope}`, "E_BAD_FLAG");
  }
  return parseJiraScope(parsed);
}

// A validated issue falls inside an approved scope: its derived project is in
// the scope's explicit projects, or the scope approved the (bounded) JQL the
// listing ran through. For a scope with projects, the project check is the
// whole rule — the JQL (if any) only narrowed that same selection.
export function jiraScopeCoversIssue(scope: JiraScope, issue: JiraRawIssue): boolean {
  if (scope.projects.length === 0) return true; // jql-only scope: the read IS the approved JQL
  return scope.projects.includes(jiraIssueProject(issue.key));
}

// The small, agent-legible candidate a verified Jira issue becomes — the Jira
// analog of LinearCandidate (jira-source-connector-v0 T-003), keyed by the
// substrate's durable source identity plus the issue key. PII-minimized by
// construction: no assignee display name survives the parse layer, and summary
// text runs through minimizeSummary. The raw shape is closed, so there is no
// description in V0 — intent is the summary.
export type JiraCandidate = {
  source_id: SourceId & { external_id: string };
  evidence_authority: "approved-private-context";
  title: string;
  intent: string;
  url: string;
  status: string;
  // Observed work-system timestamp — reconcile derives freshness from it
  // (R-006); it is never asserted.
  updated: string;
};

export function buildJiraCandidate(input: { site: string; issue: JiraRawIssue }): JiraCandidate {
  const site = jiraSiteHost(input.site);
  return {
    source_id: {
      ingress_path: "nango",
      provider: "jira",
      connection_id: site,
      external_id: input.issue.key,
    },
    evidence_authority: "approved-private-context",
    title: minimizeSummary(input.issue.summary),
    intent: minimizeSummary(input.issue.summary),
    url: `https://${site}/browse/${input.issue.key}`,
    status: input.issue.status,
    updated: input.issue.updated,
  };
}

// Read-only Jira tools the ingest path may call (jira-source-connector-v0
// T-004, beside LINEAR_READONLY_TOOLS). DEFAULT-DENY like Linear's: a tool not
// listed is refused, so every mutating Jira operation — transitions, comments,
// link edits, issue creation, anything added later — is structurally
// unreachable (R-005).
export const JIRA_READONLY_TOOLS = new Set<string>([
  "search_issues", // the only listing entry — bounded JQL/project reads (R-004)
  "get_issue",
  "list_projects",
  "get_project",
  "list_issue_comments",
  "get_issue_comment",
  "list_issue_remote_links",
  "list_fields", // issue-field metadata: status/assignee/updated (R-003)
]);

// The single choke point the Jira-ingest path must route every tool call
// through; refuses via the substrate's read-only guard (R-005).
export function assertJiraReadOnlyTool(toolName: string): void {
  const bare = toolName.split("__").pop() ?? toolName;
  if (!JIRA_READONLY_TOOLS.has(bare)) {
    refuseSourceWrite(`jira tool '${toolName}' is not on the read-only allow-list`);
  }
}

// --- GitHub source identity + selection (github-integration-v0 R-003/R-011) --

// V0 admits per-PR and per-repo granularity only. Org/user/multi-repo selection
// is a non-goal (a far larger blast radius for one approval); reaching for it is
// refused, not silently widened (R-003).
export type GithubSelection = {
  unit: "pr" | "repo";
  connection_id: string; // "<owner>/<repo>" — the repo is the connection (R-011)
  external_id: string; // "pr/<n>" for per-PR, "repo" for whole-repo
  owner: string;
  repo: string;
  pr?: number;
  url: string;
};

// Parse a `github:<url>` selector (or a bare github.com URL) into a selection,
// mapping it to the substrate source identity (R-011): connection_id="<owner>/<repo>",
// external_id="pr/<n>"|"repo". A `.../pull/<n>` URL selects per-PR; a bare repo
// URL selects per-repo. Org/user pages and any other unit (issues, tree, ...) are
// refused so one approval cannot silently widen its blast radius (R-003).
export function parseGithubSource(spec: string): GithubSelection {
  const raw = spec.startsWith("github:") ? spec.slice("github:".length) : spec;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid GitHub URL: ${raw}`);
  }
  if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) {
    throw new Error(`not a github.com URL: ${raw}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, number] = parts;
  if (!owner || !repo) {
    throw new Error(
      `GitHub selection must name a repo or a PR — org/user-level selection is out of scope for V0 (github-integration-v0 R-003): ${raw}`,
    );
  }
  const connection_id = `${owner}/${repo}`;
  if (kind === undefined) {
    return { unit: "repo", connection_id, external_id: "repo", owner, repo, url: raw };
  }
  if (kind === "pull" && number && /^\d+$/.test(number)) {
    return { unit: "pr", connection_id, external_id: `pr/${number}`, owner, repo, pr: Number(number), url: raw };
  }
  throw new Error(
    `unrecognized GitHub URL shape — admit a repo URL or a .../pull/<n> URL; team/issue/other units are out of scope (github-integration-v0 R-003): ${raw}`,
  );
}

// The substrate source identity for a GitHub selection (R-011). Ingress is mcp
// (MCP-first, R-002); the repo is the connection and the PR/repo is the
// external_id, so the gate (sourceKey) distinguishes two PRs in one repo.
export function githubSourceId(selection: GithubSelection): SourceId {
  return {
    ingress_path: "mcp",
    provider: "github",
    connection_id: selection.connection_id,
    external_id: selection.external_id,
  };
}

// PR→criterion linkage authority (github-integration-v0 D-009): the Foo-Spec
// commit trailer is authoritative; branch name and PR-body references are
// corroborating signals only (attacker-/typo-prone) — agent-inference that may
// never be the sole basis for a verdict. A criterion with no authoritative
// linkage trips not-verified condition (1), no-linkage (R-006).
export type GithubLinkage = {
  linked: boolean;
  authority: "foo-spec-trailer" | "none";
  corroborating: string[];
};

export function githubLinkageForSpec(opts: {
  specId: string;
  commitMessages: string[];
  branch?: string;
  prBody?: string;
}): GithubLinkage {
  const linked = opts.commitMessages.some((m) => specIdFromFooSpecTrailer(m) === opts.specId);
  const corroborating: string[] = [];
  if (opts.branch && opts.branch.includes(opts.specId)) corroborating.push(`branch:${opts.branch}`);
  if (opts.prBody && opts.prBody.includes(opts.specId)) corroborating.push("pr-body");
  return { linked, authority: linked ? "foo-spec-trailer" : "none", corroborating };
}

// --- GitHub read-only allow-list (github-integration-v0 R-007/R-012) ---------

// Read-only GitHub MCP tools the reconcile path may call. Unlike the small Linear
// allow-list, GitHub's ~90-tool surface hides side-effecting tools behind
// read-looking verbs, so this list is matched on the FULLY-QUALIFIED
// `mcp__github__<tool>` name (not a bare verb) and is DEFAULT-DENY: anything not
// listed — every create_/update_/merge_/delete_/add_*_comment write, every
// `actions_*` CI trigger, `request_copilot_review`, `*_auto_merge`,
// `run_secret_scanning`, AND every cross-account `search_*` (a scope break, R-003)
// — is refused, including tools the MCP server adds later (drift guard).
export const GITHUB_READONLY_TOOLS = new Set<string>([
  "mcp__github__pull_request_read",
  "mcp__github__get_commit",
  "mcp__github__list_commits",
  "mcp__github__get_check_run",
  "mcp__github__get_job_logs",
  "mcp__github__get_file_contents",
  "mcp__github__list_pull_requests",
]);

// The single choke point the GitHub-reconcile path routes every tool call
// through. Fully-qualified, default-deny; refuses via the substrate guard (R-007).
export function assertGithubReadOnlyTool(toolName: string): void {
  if (!GITHUB_READONLY_TOOLS.has(toolName)) {
    refuseSourceWrite(`github tool '${toolName}' is not on the read-only allow-list`);
  }
}

// --- GitHub selection report (github-integration-v0 T-002) ------------------

// Offline-supplied evidence for a GitHub selection (the standalone CLI has no
// live MCP). A PR carries its commits/branch/body; a repo carries its candidate
// PRs. Only the fields needed to compute packet-linkage (D-009) are read here;
// the done_when verdict is the next slice (T-003).
export type GithubPrEvidence = {
  number?: number;
  external_id?: string;
  branch?: string;
  body?: string;
  title?: string;
  commits?: Array<{ message?: string; files?: string[] }>;
  merged?: boolean;
  state?: string;
  checks?: Array<{ name?: string; conclusion?: string }>;
  files_changed?: string[];
};
export type GithubFixture = GithubPrEvidence & { pulls?: GithubPrEvidence[] };

export type GithubSelectionReport = {
  schema_version: "0.1";
  packet: string;
  source_id: SourceId;
  unit: "pr" | "repo";
  approval_state: ApprovalState;
  linked: Array<{ external_id: string; authority: GithubLinkage["authority"]; corroborating: string[] }>;
  unlinked_excluded: number;
  note: string;
};

function prLinkage(specId: string, ev: GithubPrEvidence): GithubLinkage {
  return githubLinkageForSpec({
    specId,
    commitMessages: (ev.commits ?? []).map((c) => c.message ?? ""),
    branch: ev.branch,
    prBody: ev.body,
  });
}

// Admit a GitHub selection (T-002): per-PR or per-repo only (the parser refuses
// org/multi-repo, R-003). A repo selection exposes only packet-linked PRs
// (D-009/R-003) — unlinked PRs are excluded, never discovered via search. This
// stops at admission + linkage; the done_when verdict is T-003.
export function githubSelectionReport(opts: {
  packet: string;
  selection: GithubSelection;
  approvalState: ApprovalState;
  specId: string;
  fixture?: GithubFixture;
}): GithubSelectionReport {
  const linked: GithubSelectionReport["linked"] = [];
  let unlinked_excluded = 0;
  if (opts.fixture) {
    if (opts.selection.unit === "pr") {
      const lk = prLinkage(opts.specId, opts.fixture);
      if (lk.linked) linked.push({ external_id: opts.selection.external_id, authority: lk.authority, corroborating: lk.corroborating });
      else unlinked_excluded += 1;
    } else {
      for (const pr of opts.fixture.pulls ?? []) {
        const ext = pr.external_id ?? (pr.number != null ? `pr/${pr.number}` : "pr/?");
        const lk = prLinkage(opts.specId, pr);
        if (lk.linked) linked.push({ external_id: ext, authority: lk.authority, corroborating: lk.corroborating });
        else unlinked_excluded += 1;
      }
    }
  }
  return {
    schema_version: "0.1",
    packet: opts.packet,
    source_id: githubSourceId(opts.selection),
    unit: opts.selection.unit,
    approval_state: opts.approvalState,
    linked,
    unlinked_excluded,
    note: "Selection admitted; only packet-linked PRs are exposed (Foo-Spec trailer, D-009). The done_when verdict is github-integration-v0 T-003 (next slice).",
  };
}
