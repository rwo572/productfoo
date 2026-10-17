// Nango-backed discovery connections (nango-discovery-connector-v0 T-002).
//
// The connection-identity and service-grant foundation: opaque per-user
// connection references, tenant-scoped canonical source identity, closed
// content-free target manifests, pending-request state, target references
// minted only after out-of-band human confirmation, service grants bound to
// the local approval digest and revocation epoch, and the boundary recheck
// every access must pass before any provider call.
//
// productfoo's MCP service (foo-mcp-server-v0) is unbuilt, so everything that needs a
// hosted service sits behind two explicit seams this module defines but never
// impersonates:
//
//   DiscoveryConnectionDirectory — server-side resolution of a connection_ref
//   to {foo_subject, provider, nango_connection_id}. Hosts never mint, hold,
//   or choose Nango identifiers; they receive only the opaque ref.
//
//   DiscoveryServiceEndpoint / DiscoveryConfirmationSeam — where the pending
//   target request is stored and where the out-of-band human confirmation
//   happens. A target_ref exists only after the seam reports a human
//   confirmation; no text-only or model action can mint one, and the in-repo
//   implementations are fixtures for tests, never a parallel identity, OAuth,
//   or confirmation stack (D-012/RISK-011). Hosted tiers stay contract_only.
//
// Content discipline (C-004): every type and result here is content-free —
// opaque references, digests, epochs, selectors, and state. No Nango
// connection id, provider account id, provider session id, credential, or
// transcript-derived text ever appears on a surface this module produces.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONNECTIONS_SCHEMA_VERSION = "0.1";

// --- Opaque identity (R-003) -------------------------------------------------

export type DiscoveryConnectionRef = string; // "conn:<hex>" — opaque, non-enumerable
export type DiscoveryTargetRef = string; // "dtarget:<hex>" — minted only on confirmed registration
export type DiscoverySubjectRef = string; // productfoo's opaque per-user subject reference

export type CanonicalSourceIdentity = {
  foo_subject: DiscoverySubjectRef;
  provider: string;
  canonical_connection_key: string; // "cck:<hex>" — tenant-scoped, content-free
};

const REF_DOMAIN = "foo_discovery_connections/v1";
const CANONICAL_DOMAIN = "foo_discovery_connections/canonical/v1";
const TARGET_REF_DOMAIN = "foo_discovery_target_ref/v1";

function opaqueRef(domain: string, parts: string[], length = 32): string {
  // Domain-separated digest of the identity inputs. Hosted services salt this
  // with a server-held key so refs cannot even be confirmed offline; the V0
  // fixture implementations pass no salt. A ref is non-enumerable: without
  // every input (including the subject) it cannot be derived or listed.
  return createHash("sha256").update([domain, ...parts].join("\n")).digest("hex").slice(0, length);
}

export function isConnectionRef(value: unknown): value is DiscoveryConnectionRef {
  return typeof value === "string" && /^conn:[a-f0-9]{32}$/.test(value);
}

export function isTargetRef(value: unknown): value is DiscoveryTargetRef {
  return typeof value === "string" && /^dtarget:[a-f0-9]{32}$/.test(value);
}

// The tenant-scoped canonical source identity (R-003): {foo_subject, provider,
// canonical_connection_key}. `provider_account_identity` is whatever stable
// provider-side account identifier the delivery path carries (for Nango, its
// connection id); it is digested here and never surfaces again. One provider
// account reached through two ingress paths maps to one canonical identity
// only after the same authenticated user links them and the service verifies
// the stable identity — this function derives, it never guesses equivalence.
export function canonicalSourceIdentity(input: {
  foo_subject: DiscoverySubjectRef;
  provider: string;
  provider_account_identity: string;
}): CanonicalSourceIdentity {
  if (!input.foo_subject?.trim()) throw new Error("canonical source identity requires a productfoo subject");
  if (!input.provider?.trim()) throw new Error("canonical source identity requires a provider");
  if (!input.provider_account_identity?.trim()) throw new Error("canonical source identity requires a provider account identity");
  return {
    foo_subject: input.foo_subject,
    provider: input.provider.toLowerCase(),
    canonical_connection_key: `cck:${opaqueRef(CANONICAL_DOMAIN, [input.foo_subject, input.provider.toLowerCase(), input.provider_account_identity])}`,
  };
}

export type ConnectionRefMint = {
  connection_ref: DiscoveryConnectionRef;
  canonical: CanonicalSourceIdentity;
};

// Mint a non-enumerable connection_ref for one verified productfoo user's connection.
// V0 supports one connection per provider per subject (R-003): the subject is
// part of the digest, so two users with the same provider alias get different
// refs and neither can derive or resolve the other's.
export function mintConnectionRef(input: {
  foo_subject: DiscoverySubjectRef;
  provider: string;
  nango_connection_id: string;
  server_salt?: string;
}): ConnectionRefMint {
  const subject = input.foo_subject?.trim();
  const provider = input.provider?.trim().toLowerCase();
  const nangoId = input.nango_connection_id?.trim();
  if (!subject || !provider || !nangoId) throw new Error("connection_ref minting requires subject, provider, and nango connection id");
  const canonical = canonicalSourceIdentity({ foo_subject: subject, provider, provider_account_identity: nangoId });
  return {
    connection_ref: `conn:${opaqueRef(REF_DOMAIN, [subject, provider, nangoId, input.server_salt ?? ""])}`,
    canonical,
  };
}

// --- Server-side resolution seam --------------------------------------------

export type ResolvedConnection = {
  foo_subject: DiscoverySubjectRef;
  provider: string;
  nango_connection_id: string;
  canonical: CanonicalSourceIdentity;
};

export type DiscoveryResolution =
  | { resolved: true; identity: ResolvedConnection }
  | { resolved: false; reason: "unknown_connection_ref" | "subject_mismatch" };

// The directory is server-side state mapping refs back to identities. Hosts
// resolve through it and never see the mapping itself; the acting subject is
// always verified against the resolved record so one user cannot enumerate,
// substitute, or use another user's connection (C-003).
export interface DiscoveryConnectionDirectory {
  register(input: { foo_subject: DiscoverySubjectRef; provider: string; nango_connection_id: string; at: string }): ConnectionRefMint;
  resolve(connection_ref: DiscoveryConnectionRef, acting: { foo_subject: DiscoverySubjectRef }): DiscoveryResolution;
}

// In-repo fixture/V0 implementation: content-free in-memory mapping. The real
// directory is productfoo service state (foo-mcp-server-v0); this exists so the
// contract is executable and testable before that packet lands.
export function createInMemoryConnectionDirectory(): DiscoveryConnectionDirectory {
  const byRef = new Map<DiscoveryConnectionRef, ResolvedConnection>();
  return {
    register(input) {
      const mint = mintConnectionRef(input);
      if (!byRef.has(mint.connection_ref)) {
        byRef.set(mint.connection_ref, {
          foo_subject: input.foo_subject,
          provider: input.provider.toLowerCase(),
          nango_connection_id: input.nango_connection_id,
          canonical: mint.canonical,
        });
      }
      return mint;
    },
    resolve(connection_ref, acting) {
      const record = byRef.get(connection_ref);
      if (!record) return { resolved: false, reason: "unknown_connection_ref" };
      if (record.foo_subject !== acting.foo_subject) return { resolved: false, reason: "subject_mismatch" };
      return { resolved: true, identity: record };
    },
  };
}

// --- Closed content-free target manifest (R-003) -----------------------------

export type DiscoveryLane = "study" | "inbox";

// Exactly the fields R-003 lists for the local CLI's closed, content-free
// manifest: packet/spec identity, study-or-inbox target, lane, connection
// reference, approved selectors, approval digest, current local revocation
// epoch. No meeting metadata, no provider ids, no scope text beyond selectors.
export type DiscoveryTargetManifest = {
  schema_version: "0.1";
  kind: "discovery_target_manifest";
  packet: string;
  spec_id: string;
  workspace_ref: string;
  target_id: string; // "study_<slug>" or "inbox:<slug>"
  lane: DiscoveryLane;
  connection_ref: DiscoveryConnectionRef;
  approved_selectors: string[];
  approval_digest: string; // "sha256:<hex>" over the local approval ledger
  revocation_epoch: number;
};

const MANIFEST_KEYS = new Set([
  "schema_version",
  "kind",
  "packet",
  "spec_id",
  "workspace_ref",
  "target_id",
  "lane",
  "connection_ref",
  "approved_selectors",
  "approval_digest",
  "revocation_epoch",
]);

// Same discipline as the evidence envelope: content-bearing field names are
// refused even when the values would have been empty. A manifest is identity,
// not payload.
const FORBIDDEN_MANIFEST_KEY = /transcript|content|note|summary|attendee|participant|token|secret|credential|password/i;

const STUDY_TARGET = /^study_[a-z0-9_]+$/;
const INBOX_TARGET = /^inbox:[a-z0-9_]+$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type DiscoveryManifestCheck =
  | { ok: true; manifest: DiscoveryTargetManifest }
  | { ok: false; reason: string };

export function validateDiscoveryTargetManifest(value: unknown): DiscoveryManifestCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "target manifest must be an object" };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_MANIFEST_KEY.test(key)) return { ok: false, reason: `target manifest forbids content-bearing field ${key}` };
    if (!MANIFEST_KEYS.has(key)) return { ok: false, reason: `target manifest field ${key} is not part of the closed manifest` };
  }
  if (raw.schema_version !== CONNECTIONS_SCHEMA_VERSION) return { ok: false, reason: "target manifest schema_version must be 0.1" };
  if (raw.kind !== "discovery_target_manifest") return { ok: false, reason: "target manifest kind must be discovery_target_manifest" };
  for (const field of ["packet", "spec_id", "workspace_ref"] as const) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) return { ok: false, reason: `target manifest ${field} must be a non-empty string` };
  }
  const targetId = raw.target_id;
  if (typeof targetId !== "string" || (!STUDY_TARGET.test(targetId) && !INBOX_TARGET.test(targetId))) {
    return { ok: false, reason: "target manifest target_id must be study_<slug> or inbox:<slug>" };
  }
  const lane = raw.lane;
  if (lane !== "study" && lane !== "inbox") return { ok: false, reason: "target manifest lane must be study or inbox" };
  if ((lane === "study" && !STUDY_TARGET.test(targetId)) || (lane === "inbox" && !INBOX_TARGET.test(targetId))) {
    return { ok: false, reason: "target manifest lane does not match the target id" };
  }
  if (!isConnectionRef(raw.connection_ref)) return { ok: false, reason: "target manifest connection_ref must be an opaque conn: reference" };
  const selectors = raw.approved_selectors;
  if (!Array.isArray(selectors) || selectors.length === 0 || !selectors.every((s) => typeof s === "string" && s.trim().length > 0)) {
    return { ok: false, reason: "target manifest approved_selectors must be a non-empty string array" };
  }
  if (typeof raw.approval_digest !== "string" || !SHA256_DIGEST.test(raw.approval_digest)) {
    return { ok: false, reason: "target manifest approval_digest must be sha256:<hex>" };
  }
  if (typeof raw.revocation_epoch !== "number" || !Number.isInteger(raw.revocation_epoch) || raw.revocation_epoch < 0) {
    return { ok: false, reason: "target manifest revocation_epoch must be a non-negative integer" };
  }
  return { ok: true, manifest: raw as unknown as DiscoveryTargetManifest };
}

// --- Service endpoint, pending requests, confirmation seam -------------------

export type DiscoveryHandoff = {
  kind: string;
  url?: string;
  resume_command?: string;
  requires_human: boolean;
};

export type DiscoveryPendingTargetRequest = {
  schema_version: "0.1";
  kind: "discovery_target_pending_request";
  subject_ref: DiscoverySubjectRef;
  manifest: DiscoveryTargetManifest;
  requested_at: string;
  state: "pending";
};

export type DiscoveryRegisterTargetResult =
  | {
      status: "needs_service_grant";
      pending_request_id: string;
      handoff: DiscoveryHandoff;
      next_actions: string[];
    }
  | { status: "invalid"; errors: Array<{ code: string; message: string }> };

export type DiscoveryConfirmationDecision =
  | { confirmed: true; confirmed_by: string; confirmed_at: string; confirmed_via: string }
  | { confirmed: false; reason: "deferred" | "refused"; note?: string };

// The out-of-band confirmation surface (the reused productfoo/MCP authenticated
// approval infrastructure foo-mcp-server-v0 owns). This seam is the ONLY path
// to a target_ref: the human confirms the exact manifest, and nothing in this
// module or the CLI can substitute for that confirmation.
export interface DiscoveryConfirmationSeam {
  confirmTargetManifest(manifest: DiscoveryTargetManifest): Promise<DiscoveryConfirmationDecision>;
}

export type DiscoverySuspendTargetAck =
  | { suspended: true; target_ref: DiscoveryTargetRef; revocation_epoch: number }
  | { suspended: false; target_ref: string; reason: "unknown_target_ref" | "subject_mismatch" | "service_unreachable" | "invalid_request"; message: string };

// The authenticated service ops T-002 owns. Register stores the manifest as a
// pending request only; suspension is privilege-reducing, needs no second
// confirmation, and increments the revocation epoch before acknowledging.
export interface DiscoveryServiceEndpoint {
  registerPendingTarget(input: { subject_ref: DiscoverySubjectRef; manifest: DiscoveryTargetManifest; requested_at: string }): Promise<{ stored: true; pending_request_id: string } | { stored: false; reason: string; message: string }>;
  confirmTargetRegistration(input: { manifest: DiscoveryTargetManifest; confirmation: DiscoveryConfirmationDecision; at: string }): Promise<{ confirmed_registration: true; target_ref: DiscoveryTargetRef; grant: DiscoveryServiceGrant } | { confirmed_registration: false; reason: string; message: string }>;
  suspendTarget(input: { target_ref: string; acting_subject: DiscoverySubjectRef; revocation_event_digest: string; requested_by: string; at: string }): Promise<DiscoverySuspendTargetAck>;
}

// Typed unreachability: until foo-mcp-server-v0 exists, every service call
// fails closed to this. Callers record revocation_pending; nothing pretends
// the hosted state changed.
export class DiscoveryServiceUnreachableError extends Error {
  constructor(public readonly op: "register" | "confirm" | "suspend") {
    super(`discovery service unreachable (${op}); hosted state is unchanged`);
    this.name = "DiscoveryServiceUnreachableError";
  }
}

export function createUnreachableDiscoveryService(): DiscoveryServiceEndpoint {
  const refuse = async (op: "register" | "confirm" | "suspend"): Promise<never> => {
    throw new DiscoveryServiceUnreachableError(op);
  };
  return {
    registerPendingTarget: () => refuse("register"),
    confirmTargetRegistration: () => refuse("confirm"),
    suspendTarget: () => refuse("suspend"),
  };
}

// The local runtime's register step: validate the manifest, hand it to the
// service as a pending request, and return needs_service_grant with the
// productfoo-owned approval handoff. Never returns a target_ref — that requires the
// out-of-band confirmation (see confirmDiscoveryTargetRegistration).
export async function registerDiscoveryTarget(input: {
  subject_ref: DiscoverySubjectRef;
  service: DiscoveryServiceEndpoint;
  manifest: unknown;
  at: string;
}): Promise<DiscoveryRegisterTargetResult> {
  const check = validateDiscoveryTargetManifest(input.manifest);
  if (!check.ok) return { status: "invalid", errors: [{ code: "E_DISCOVERY_MANIFEST_INVALID", message: check.reason }] };
  if (!input.subject_ref?.trim()) return { status: "invalid", errors: [{ code: "E_DISCOVERY_SUBJECT_REQUIRED", message: "target registration requires the authenticated subject reference" }] };
  try {
    const stored = await input.service.registerPendingTarget({ subject_ref: input.subject_ref, manifest: check.manifest, requested_at: input.at });
    if (!stored.stored) return { status: "invalid", errors: [{ code: "E_DISCOVERY_SERVICE_REFUSED", message: stored.message }] };
    return {
      status: "needs_service_grant",
      pending_request_id: stored.pending_request_id,
      handoff: {
        kind: "service_grant_approval",
        requires_human: true,
      },
      next_actions: [
        "A person must confirm this exact target manifest through productfoo's authenticated out-of-band confirmation surface before any hosted read is possible.",
      ],
    };
  } catch (error) {
    if (error instanceof DiscoveryServiceUnreachableError) {
      return { status: "invalid", errors: [{ code: "E_DISCOVERY_SERVICE_UNREACHABLE", message: error.message }] };
    }
    throw error;
  }
}

export type DiscoveryConfirmTargetResult =
  | { status: "ready"; target_ref: DiscoveryTargetRef; grant: DiscoveryServiceGrant; next_actions: string[] }
  | { status: "needs_service_grant"; reason: string; handoff: DiscoveryHandoff }
  | { status: "invalid"; errors: Array<{ code: string; message: string }> };

// The confirmation flow: the seam reports the out-of-band human decision for
// the exact manifest; only a confirmed decision reaches the service, which
// mints the target_ref and activates the service grant. Anything else stays
// pending (needs_service_grant) — a deferred or refused manifest never
// becomes usable, and no local path can mint the ref itself.
export async function confirmDiscoveryTargetRegistration(input: {
  service: DiscoveryServiceEndpoint;
  seam: DiscoveryConfirmationSeam;
  manifest: unknown;
  at: string;
}): Promise<DiscoveryConfirmTargetResult> {
  const check = validateDiscoveryTargetManifest(input.manifest);
  if (!check.ok) return { status: "invalid", errors: [{ code: "E_DISCOVERY_MANIFEST_INVALID", message: check.reason }] };
  let decision: DiscoveryConfirmationDecision;
  try {
    decision = await input.seam.confirmTargetManifest(check.manifest);
  } catch (error) {
    if (error instanceof DiscoveryServiceUnreachableError) {
      return { status: "needs_service_grant", reason: "service_unreachable", handoff: { kind: "service_grant_approval", requires_human: true } };
    }
    throw error;
  }
  if (!decision.confirmed) {
    return {
      status: "needs_service_grant",
      reason: decision.reason,
      handoff: { kind: "service_grant_approval", requires_human: true },
    };
  }
  const confirmed = await input.service.confirmTargetRegistration({ manifest: check.manifest, confirmation: decision, at: input.at });
  if (!confirmed.confirmed_registration) {
    return { status: "invalid", errors: [{ code: "E_DISCOVERY_CONFIRM_REFUSED", message: confirmed.message }] };
  }
  return {
    status: "ready",
    target_ref: confirmed.target_ref,
    grant: confirmed.grant,
    next_actions: ["Run the hosted readiness operation before any listing; local source approval is still required for repository apply."],
  };
}

// --- Service grants (R-005/R-008) --------------------------------------------

export type DiscoveryGrantBudget = {
  max_operations: number;
  window: "day";
};

// Server-side state binding the confirmed target to its bounded authorization.
// The grant carries no credential and is never a bearer token: every boundary
// rechecks it against the CURRENT local approval digest and revocation epoch,
// so a local revoke invalidates hosted access even while old grant objects
// exist.
export type DiscoveryServiceGrant = {
  schema_version: "0.1";
  kind: "discovery_service_grant";
  subject_ref: DiscoverySubjectRef;
  workspace_ref: string;
  target_ref: DiscoveryTargetRef;
  target_id: string;
  lane: DiscoveryLane;
  connection_ref: DiscoveryConnectionRef;
  approved_selectors: string[];
  approval_digest: string;
  revocation_epoch: number;
  issued_at: string;
  expires_at: string;
  budget: DiscoveryGrantBudget;
};

const GRANT_KEYS = new Set([
  "schema_version",
  "kind",
  "subject_ref",
  "workspace_ref",
  "target_ref",
  "target_id",
  "lane",
  "connection_ref",
  "approved_selectors",
  "approval_digest",
  "revocation_epoch",
  "issued_at",
  "expires_at",
  "budget",
]);

export type DiscoveryGrantCheck =
  | { ok: true; grant: DiscoveryServiceGrant }
  | { ok: false; reason: string };

export function validateDiscoveryServiceGrant(value: unknown): DiscoveryGrantCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "service grant must be an object" };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_MANIFEST_KEY.test(key)) return { ok: false, reason: `service grant forbids content-bearing field ${key}` };
    if (!GRANT_KEYS.has(key)) return { ok: false, reason: `service grant field ${key} is not part of the closed grant` };
  }
  if (raw.schema_version !== CONNECTIONS_SCHEMA_VERSION) return { ok: false, reason: "service grant schema_version must be 0.1" };
  if (raw.kind !== "discovery_service_grant") return { ok: false, reason: "service grant kind must be discovery_service_grant" };
  if (typeof raw.subject_ref !== "string" || !(raw.subject_ref as string).trim()) return { ok: false, reason: "service grant subject_ref must be a non-empty string" };
  if (typeof raw.workspace_ref !== "string" || !(raw.workspace_ref as string).trim()) return { ok: false, reason: "service grant workspace_ref must be a non-empty string" };
  if (!isTargetRef(raw.target_ref)) return { ok: false, reason: "service grant target_ref must be an opaque dtarget: reference" };
  if (typeof raw.target_id !== "string" || (!STUDY_TARGET.test(raw.target_id) && !INBOX_TARGET.test(raw.target_id))) {
    return { ok: false, reason: "service grant target_id must be study_<slug> or inbox:<slug>" };
  }
  if (raw.lane !== "study" && raw.lane !== "inbox") return { ok: false, reason: "service grant lane must be study or inbox" };
  if (!isConnectionRef(raw.connection_ref)) return { ok: false, reason: "service grant connection_ref must be an opaque conn: reference" };
  const selectors = raw.approved_selectors;
  if (!Array.isArray(selectors) || selectors.length === 0 || !selectors.every((s) => typeof s === "string" && s.trim().length > 0)) {
    return { ok: false, reason: "service grant approved_selectors must be a non-empty string array" };
  }
  if (typeof raw.approval_digest !== "string" || !SHA256_DIGEST.test(raw.approval_digest)) return { ok: false, reason: "service grant approval_digest must be sha256:<hex>" };
  if (typeof raw.revocation_epoch !== "number" || !Number.isInteger(raw.revocation_epoch) || raw.revocation_epoch < 0) {
    return { ok: false, reason: "service grant revocation_epoch must be a non-negative integer" };
  }
  for (const field of ["issued_at", "expires_at"] as const) {
    if (typeof raw[field] !== "string" || !Number.isFinite(Date.parse(raw[field] as string))) {
      return { ok: false, reason: `service grant ${field} must be an ISO timestamp` };
    }
  }
  const budget = raw.budget as DiscoveryGrantBudget | undefined;
  if (!budget || typeof budget !== "object" || typeof budget.max_operations !== "number" || !Number.isInteger(budget.max_operations) || budget.max_operations <= 0 || budget.window !== "day") {
    return { ok: false, reason: "service grant budget must be {max_operations: positive integer, window: \"day\"}" };
  }
  return { ok: true, grant: raw as unknown as DiscoveryServiceGrant };
}

// --- Boundary recheck (R-008) ------------------------------------------------

// What the caller believes the access is for. Every field must match the
// grant exactly; the approval digest and epoch must match the CURRENT local
// ledger, not the ones the grant was minted with.
export type DiscoveryBoundaryExpectation = {
  subject_ref: DiscoverySubjectRef;
  connection_ref: DiscoveryConnectionRef;
  workspace_ref: string;
  target_id: string;
  lane: DiscoveryLane;
  approval_digest: string;
  revocation_epoch: number;
  selector?: string;
};

export type DiscoveryBoundaryFailureReason =
  | "unknown_grant"
  | "subject_mismatch"
  | "connection_mismatch"
  | "workspace_mismatch"
  | "target_mismatch"
  | "lane_mismatch"
  | "approval_mismatch"
  | "stale_revocation_epoch"
  | "grant_expired"
  | "selector_out_of_scope"
  | "budget_exhausted";

export type DiscoveryBoundaryCheck = { ok: true } | { ok: false; reason: DiscoveryBoundaryFailureReason; message: string };

// The recheck invoked at every access boundary: subject, workspace, target,
// lane, approval digest, revocation epoch, expiry, selector scope, and budget,
// fail-closed, first mismatch wins. Pure — no I/O — so every surface can run
// it exactly where the access happens.
export function recheckDiscoveryAccessBoundary(input: {
  grant?: DiscoveryServiceGrant | unknown;
  expected: DiscoveryBoundaryExpectation;
  operations_used?: number;
  now: string;
}): DiscoveryBoundaryCheck {
  const grantCheck = validateDiscoveryServiceGrant(input.grant);
  if (!grantCheck.ok) return { ok: false, reason: "unknown_grant", message: "no active service grant: verify the target was registered and confirmed out of band" };
  const grant = grantCheck.grant;
  const e = input.expected;
  if (grant.subject_ref !== e.subject_ref) return { ok: false, reason: "subject_mismatch", message: "the authenticated subject is not the grant's subject" };
  if (grant.connection_ref !== e.connection_ref) return { ok: false, reason: "connection_mismatch", message: "the connection reference does not match the grant" };
  if (grant.workspace_ref !== e.workspace_ref) return { ok: false, reason: "workspace_mismatch", message: "the workspace reference does not match the grant" };
  if (grant.target_id !== e.target_id) return { ok: false, reason: "target_mismatch", message: "the discovery target does not match the grant" };
  if (grant.lane !== e.lane) return { ok: false, reason: "lane_mismatch", message: "the discovery lane does not match the grant" };
  if (grant.approval_digest !== e.approval_digest) return { ok: false, reason: "approval_mismatch", message: "the local approval digest no longer matches the grant" };
  if (grant.revocation_epoch !== e.revocation_epoch) return { ok: false, reason: "stale_revocation_epoch", message: "the grant predates the current revocation epoch" };
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || now > Date.parse(grant.expires_at)) return { ok: false, reason: "grant_expired", message: "the service grant has expired" };
  if (e.selector !== undefined && !grant.approved_selectors.includes(e.selector)) {
    return { ok: false, reason: "selector_out_of_scope", message: "the requested selector is outside the grant's approved selectors" };
  }
  if (typeof input.operations_used === "number" && input.operations_used >= grant.budget.max_operations) {
    return { ok: false, reason: "budget_exhausted", message: "the grant's operation budget is exhausted" };
  }
  return { ok: true };
}

export class DiscoveryBoundaryRefused extends Error {
  constructor(public readonly check: DiscoveryBoundaryCheck & { ok: false }) {
    super(`discovery access boundary refused (${check.reason}): ${check.message}`);
    this.name = "DiscoveryBoundaryRefused";
  }
}

// Turns a failed recheck into a typed refusal; ok passes through silently.
export function assertDiscoveryBoundary(check: DiscoveryBoundaryCheck): void {
  if (!check.ok) throw new DiscoveryBoundaryRefused(check);
}

// The structural guarantee behind C-019: the guarded access (the transcript
// fetch) CANNOT run unless the boundary recheck passes. Every access boundary
// wraps its provider call in this, so a forged digest, stale epoch,
// unconfirmed manifest, or unregistered target costs zero provider calls.
export async function guardedDiscoveryAccess<T>(
  check: DiscoveryBoundaryCheck,
  access: () => Promise<T>,
): Promise<T> {
  assertDiscoveryBoundary(check);
  return access();
}

// --- In-repo service fixture (V0) --------------------------------------------

// A working service endpoint for tests and the contract's executable proof.
// It is NOT a hosted service and never leaves process memory: the real
// implementation of these ops is foo-mcp-server-v0's, behind authenticated
// identity and transport this repo does not build (hosted tiers stay
// contract_only). It demonstrates the exact semantics the packet requires:
// pending-only registration, target_ref + grant minted only on a confirmed
// out-of-band decision, privilege-reducing suspension that increments the
// revocation epoch before acknowledging, and subject checks on every call.
export function createInMemoryDiscoveryService(opts?: {
  server_salt?: string;
  directory?: DiscoveryConnectionDirectory;
  grant_ttl_ms?: number;
  default_budget?: DiscoveryGrantBudget;
}): DiscoveryServiceEndpoint & {
  currentRevocationEpoch(target_ref: DiscoveryTargetRef): number | null;
  operationsUsed(target_ref: DiscoveryTargetRef): number | null;
  recordOperation(target_ref: DiscoveryTargetRef): void;
  pendingRequests(): DiscoveryPendingTargetRequest[];
} {
  const salt = opts?.server_salt ?? "";
  const ttl = opts?.grant_ttl_ms ?? 24 * 60 * 60_000;
  const budget = opts?.default_budget ?? { max_operations: 4, window: "day" as const };
  const pending = new Map<string, DiscoveryPendingTargetRequest>();
  type TargetRecord = {
    manifest: DiscoveryTargetManifest;
    subject_ref: DiscoverySubjectRef;
    target_ref: DiscoveryTargetRef;
    grant: DiscoveryServiceGrant;
    revocation_epoch: number;
    suspended: boolean;
    operations_used: number;
  };
  const targets = new Map<DiscoveryTargetRef, TargetRecord>();

  const digestIsAuthenticated = (digest: string): boolean => SHA256_DIGEST.test(digest);

  return {
    async registerPendingTarget({ subject_ref, manifest, requested_at }) {
      if (!subject_ref.trim()) return { stored: false, reason: "invalid_subject", message: "registering a target requires the authenticated productfoo subject reference" };
      const id = `dpr:${opaqueRef("foo_discovery_pending/v1", [subject_ref, manifest.target_id, manifest.connection_ref, requested_at, String(pending.size)])}`;
      pending.set(id, { schema_version: CONNECTIONS_SCHEMA_VERSION, kind: "discovery_target_pending_request", subject_ref, manifest, requested_at, state: "pending" });
      return { stored: true, pending_request_id: id };
    },

    async confirmTargetRegistration({ manifest, confirmation, at }) {
      if (!confirmation.confirmed) {
        return { confirmed_registration: false, reason: "not_confirmed", message: `the out-of-band confirmation did not approve this manifest (${confirmation.reason})` };
      }
      const request = [...pending.values()].find((req) => JSON.stringify(req.manifest) === JSON.stringify(manifest));
      if (!request) {
        return { confirmed_registration: false, reason: "unknown_pending_request", message: "no pending target request matches this manifest; register it first" };
      }
      if (!confirmation.confirmed_by.trim() || !Number.isFinite(Date.parse(confirmation.confirmed_at))) {
        return { confirmed_registration: false, reason: "invalid_confirmation", message: "the confirmation decision lacks a person and a time" };
      }
      // The ref binds the exact confirmed manifest plus who/when confirmed it:
      // the same manifest confirmed by the same person yields the same ref,
      // and no ref exists without a confirmation record.
      const target_ref = `dtarget:${opaqueRef(TARGET_REF_DOMAIN, [JSON.stringify(manifest), confirmation.confirmed_by, confirmation.confirmed_at, salt])}`;
      const grant: DiscoveryServiceGrant = {
        schema_version: CONNECTIONS_SCHEMA_VERSION,
        kind: "discovery_service_grant",
        subject_ref: request.subject_ref,
        workspace_ref: manifest.workspace_ref,
        target_ref,
        target_id: manifest.target_id,
        lane: manifest.lane,
        connection_ref: manifest.connection_ref,
        approved_selectors: [...manifest.approved_selectors],
        approval_digest: manifest.approval_digest,
        revocation_epoch: manifest.revocation_epoch,
        issued_at: new Date(at).toISOString(),
        expires_at: new Date(Date.parse(at) + ttl).toISOString(),
        budget: { ...budget },
      };
      targets.set(target_ref, { manifest, subject_ref: request.subject_ref, target_ref, grant, revocation_epoch: manifest.revocation_epoch, suspended: false, operations_used: 0 });
      return { confirmed_registration: true, target_ref, grant };
    },

    async suspendTarget({ target_ref, acting_subject, revocation_event_digest, requested_by, at }) {
      if (!digestIsAuthenticated(revocation_event_digest)) {
        return { suspended: false, target_ref, reason: "invalid_request", message: "target suspension requires the authenticated local revocation event digest" };
      }
      const record = targets.get(target_ref as DiscoveryTargetRef);
      if (!record) return { suspended: false, target_ref, reason: "unknown_target_ref", message: "no registered target for this reference" };
      if (record.subject_ref !== acting_subject) return { suspended: false, target_ref, reason: "subject_mismatch", message: "the acting subject is not the target's registered subject" };
      if (!requested_by.trim()) return { suspended: false, target_ref, reason: "invalid_request", message: "target suspension requires the requesting actor" };
      record.revocation_epoch += 1;
      record.suspended = true;
      record.grant = { ...record.grant, revocation_epoch: record.revocation_epoch };
      void at;
      return { suspended: true, target_ref: record.target_ref, revocation_epoch: record.revocation_epoch };
    },

    currentRevocationEpoch(target_ref) {
      return targets.get(target_ref)?.revocation_epoch ?? null;
    },
    operationsUsed(target_ref) {
      return targets.get(target_ref)?.operations_used ?? null;
    },
    recordOperation(target_ref) {
      const record = targets.get(target_ref);
      if (record) record.operations_used += 1;
    },
    pendingRequests() {
      return [...pending.values()];
    },
  };
}

// --- Local registered-target lookup (C-023's fan-out substrate) ---------------

export type DiscoveryTargetSuspensionState = {
  epoch: number;
  state: "acknowledged" | "revocation_pending";
  recorded_at: string;
};

// The content-free record of one confirmed hosted target, written to
// `.foo/discovery/<target>/target.json` (the discoveryProof.ts local-state
// pattern). This is the approval-to-registered-target lookup the revoke
// fan-out needs: keyed on the LOCAL approval identity {provider,
// connection_id} — the same key `foo source approve/revoke` uses — while
// carrying only opaque hosted references. No Nango id, provider account id,
// credential, or session identity ever lands in this file.
export type DiscoveryRegisteredTarget = {
  schema_version: "0.1";
  kind: "discovery_registered_target";
  subject_ref: DiscoverySubjectRef;
  target_ref: DiscoveryTargetRef;
  workspace_ref: string;
  target_id: string;
  lane: DiscoveryLane;
  packet: string;
  spec_id: string;
  provider: string;
  connection_id: string;
  connection_ref: DiscoveryConnectionRef;
  approved_selectors: string[];
  approval_digest: string;
  revocation_epoch: number;
  registered_at: string;
  suspension: DiscoveryTargetSuspensionState | null;
};

function safeDiscoveryTargetDir(targetId: string): string {
  if (STUDY_TARGET.test(targetId)) return targetId;
  if (INBOX_TARGET.test(targetId)) return targetId.replace(":", "_");
  throw new Error("invalid discovery target id");
}

function registeredTargetPath(localRoot: string, targetId: string): string {
  return path.join(path.resolve(localRoot), ".foo", "discovery", safeDiscoveryTargetDir(targetId), "target.json");
}

// Persists the registry record for a confirmed registration. `local` supplies
// the local approval linkage the manifest intentionally does not carry
// (the manifest references the connection only by its opaque ref).
export function recordDiscoveryTargetRegistration(localRoot: string, input: {
  manifest: DiscoveryTargetManifest;
  confirmation: { confirmed_by: string; confirmed_at: string; confirmed_via: string };
  result: { target_ref: DiscoveryTargetRef; grant: DiscoveryServiceGrant };
  local: { subject_ref: DiscoverySubjectRef; provider: string; connection_id: string };
  at: string;
}): DiscoveryRegisteredTarget {
  const record: DiscoveryRegisteredTarget = {
    schema_version: CONNECTIONS_SCHEMA_VERSION,
    kind: "discovery_registered_target",
    subject_ref: input.local.subject_ref,
    target_ref: input.result.target_ref,
    workspace_ref: input.manifest.workspace_ref,
    target_id: input.manifest.target_id,
    lane: input.manifest.lane,
    packet: input.manifest.packet,
    spec_id: input.manifest.spec_id,
    provider: input.local.provider.toLowerCase(),
    connection_id: input.local.connection_id,
    connection_ref: input.manifest.connection_ref,
    approved_selectors: [...input.manifest.approved_selectors],
    approval_digest: input.manifest.approval_digest,
    revocation_epoch: input.manifest.revocation_epoch,
    registered_at: input.at,
    suspension: null,
  };
  const file = registeredTargetPath(localRoot, record.target_id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function parseRegisteredTarget(file: string): DiscoveryRegisteredTarget | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // fail-closed: an unparseable record is skipped, never trusted
  }
  const raw = parsed as Partial<DiscoveryRegisteredTarget> | null;
  if (!raw || raw.schema_version !== CONNECTIONS_SCHEMA_VERSION || raw.kind !== "discovery_registered_target" || !isTargetRef(raw.target_ref)) return null;
  return raw as DiscoveryRegisteredTarget;
}

export function loadDiscoveryRegisteredTargets(localRoot: string): DiscoveryRegisteredTarget[] {
  const root = path.join(path.resolve(localRoot), ".foo", "discovery");
  if (!existsSync(root)) return [];
  const records: DiscoveryRegisteredTarget[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = parseRegisteredTarget(path.join(root, entry.name, "target.json"));
    if (record) records.push(record);
  }
  return records;
}

// The approval→registered-target lookup: every hosted target registered from
// the local approval `foo source revoke` is about to tear down.
export function findDiscoveryTargetsForApproval(localRoot: string, approval: { provider: string; connection_id: string }): DiscoveryRegisteredTarget[] {
  const provider = approval.provider.trim().toLowerCase();
  return loadDiscoveryRegisteredTargets(localRoot).filter(
    (record) => record.provider === provider && record.connection_id === approval.connection_id,
  );
}

// --- Revoke fan-out (R-008) ---------------------------------------------------

export type DiscoverySuspendFanOutOutcome =
  | { target_ref: DiscoveryTargetRef; target_id: string; status: "suspended"; revocation_epoch: number }
  | { target_ref: DiscoveryTargetRef; target_id: string; status: "revocation_pending"; reason: string; message: string };

export type DiscoverySuspendFanOutResult = {
  registered: number;
  acknowledged: number;
  pending: number;
  outcomes: DiscoverySuspendFanOutOutcome[];
};

// Fans a local source revoke out to every registered hosted target as
// privilege-reducing discovery_suspend_target calls. Ordering and honesty
// rules (R-008):
//
//   - the caller has ALREADY applied the immediate local revoke before this
//     runs, and nothing here can weaken or undo it — a service failure never
//     raises, it records revocation_pending;
//   - an acknowledgement means the service incremented the target's
//     revocation epoch and blocked hosted reads at the new epoch;
//   - unreachability (the V0 default, since foo-mcp-server-v0 is unbuilt)
//     records revocation_pending and never claims the hosted grant or
//     connection was revoked.
export async function fanOutDiscoveryTargetSuspension(input: {
  localRoot: string;
  provider: string;
  connection_id: string;
  /** Limit the fan-out to one target (a single study's revoke, #898);
   *  omitted, every target registered from the approval is suspended. */
  target_id?: string;
  revocation_event_digest: string;
  requested_by: string;
  service?: DiscoveryServiceEndpoint;
  at: string;
}): Promise<DiscoverySuspendFanOutResult> {
  const records = findDiscoveryTargetsForApproval(input.localRoot, { provider: input.provider, connection_id: input.connection_id })
    .filter((record) => input.target_id === undefined || record.target_id === input.target_id);
  const outcomes: DiscoverySuspendFanOutOutcome[] = [];
  let acknowledged = 0;
  let pending = 0;

  if (!SHA256_DIGEST.test(input.revocation_event_digest)) {
    // Fail closed: without the authenticated revocation event digest the
    // suspension request is never sent, and the honest state is pending.
    for (const record of records) {
      pending += 1;
      outcomes.push({ target_ref: record.target_ref, target_id: record.target_id, status: "revocation_pending", reason: "invalid_request", message: "the local revocation event digest is missing or malformed; the suspension request was not sent" });
    }
    return { registered: records.length, acknowledged, pending, outcomes };
  }

  for (const record of records) {
    try {
      const ack = await (input.service ?? createUnreachableDiscoveryService()).suspendTarget({
        target_ref: record.target_ref,
        acting_subject: record.subject_ref,
        revocation_event_digest: input.revocation_event_digest,
        requested_by: input.requested_by,
        at: input.at,
      });
      if (ack.suspended) {
        acknowledged += 1;
        record.suspension = { epoch: ack.revocation_epoch, state: "acknowledged", recorded_at: input.at };
        outcomes.push({ target_ref: record.target_ref, target_id: record.target_id, status: "suspended", revocation_epoch: ack.revocation_epoch });
      } else {
        pending += 1;
        record.suspension = { epoch: record.revocation_epoch, state: "revocation_pending", recorded_at: input.at };
        outcomes.push({ target_ref: record.target_ref, target_id: record.target_id, status: "revocation_pending", reason: ack.reason, message: ack.message });
      }
    } catch (error) {
      pending += 1;
      record.suspension = { epoch: record.revocation_epoch, state: "revocation_pending", recorded_at: input.at };
      const reason = error instanceof DiscoveryServiceUnreachableError ? "service_unreachable" : "service_error";
      const message = error instanceof DiscoveryServiceUnreachableError
        ? "the discovery service is unreachable; hosted suspension is not yet acknowledged and hosted reads may continue until it confirms"
        : "the discovery service could not acknowledge the suspension; hosted suspension is not yet acknowledged";
      outcomes.push({ target_ref: record.target_ref, target_id: record.target_id, status: "revocation_pending", reason, message });
    }
    // Persist the acknowledgement/pending state on the record — the fan-out
    // never deletes or rewrites the rest of the registry entry.
    const file = registeredTargetPath(input.localRoot, record.target_id);
    if (existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return { registered: records.length, acknowledged, pending, outcomes };
}
