// Provider-neutral readiness and bounded metadata listing
// (nango-discovery-connector-v0 T-003, R-004/R-011/R-013).
//
// Before reading meetings, every host can call a provider-neutral readiness
// operation; inside an approved study or inbox scope the service may list
// only the completed metadata the existing strict matcher needs. Everything
// on a surface this module produces is content-free: opaque references,
// observed capability booleans, state names, digests, and signed references.
// No provider note, summary, raw identifier, credential, response body,
// query string, fragment, or unrecognized field ever rides through.
//
// Two seams carry the hosted/provider split (foo-mcp-server-v0 is unbuilt —
// hosted tiers stay contract_only, D-012):
//
//   DiscoveryReadinessService — the hosted state this module reports but
//   never fabricates: service reachability (unreachability throws the T-002
//   error type), the hosted connection record, the target's service grant
//   with its operation count, and the tenant-scoped canonical connection key.
//
//   DiscoveryListingSource<TRaw> — the provider side: observed per-connection
//   capabilities (never asserted from a fixture) and a bounded listing of raw
//   records the provider adapter normalizes. Implementations exist per
//   provider; the conformance suite runs ONE contract against Granola and a
//   structurally different fake provider (V-006).
//
// The signed-and-encrypted session_ref, the hosted source fingerprint, and
// the service policy are real code here, not seams: the hosted service
// supplies the server-held key, and everything else about the references —
// self-contained binding, opacity, expiry, tamper-evidence — is enforced in
// this module because it is the contract, not the transport.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  DiscoveryServiceUnreachableError,
  type DiscoveryBoundaryFailureReason,
  type DiscoveryConnectionRef,
  type DiscoveryHandoff,
  type DiscoveryLane,
  type DiscoveryServiceGrant,
  type DiscoverySubjectRef,
  type DiscoveryTargetRef,
  recheckDiscoveryAccessBoundary,
  validateDiscoveryServiceGrant,
} from "./discoveryConnections.js";
import {
  sanitizeDiscoveryStableUrl,
  validateNormalizedSession,
  type DiscoveryCapabilities,
  type DiscoverySession,
  type DiscoverySourceAdapter,
} from "./discoverySources.js";

export const READINESS_SCHEMA_VERSION = "0.1";
// The wire contract this module speaks. A listing source built for a older
// contract version is reported as `adapter_stale` with the exact repair
// command (R-013) — it is never silently invoked.
export const READINESS_CONTRACT_VERSION = "discovery-contract-0.1";

// --- Versioned service policy (R-005) ----------------------------------------

// Hard ceilings carried as versioned readiness fields so a later change is
// explicit rather than silently host-dependent. The values are the ones the
// Gong local worker already proves in-repo (gongNango.ts GONG_POLICY); this
// constant is the provider-neutral hosted form of the same policy.
export const DISCOVERY_SERVICE_POLICY = {
  policy_version: "discovery-service-0.1",
  max_response_bytes: 8 * 1024 * 1024,
  fetch_timeout_ms: 90_000,
  max_model_input_tokens: 100_000,
  // Bound on one listing. A source's own page/window ceilings apply first;
  // when the bound would be exceeded the listing reports truncation instead
  // of widening the read (R-004/R-010).
  max_list_sessions: 50,
} as const;

// A listed session_ref expires quickly: it exists so a host can hand back
// exactly one bounded read, not to seed a long-lived handle. Never longer
// than the grant it was minted under.
export const SESSION_REF_TTL_MS = 15 * 60_000;

// --- Typed failures (R-004) ---------------------------------------------------

// The closed failure vocabulary. Codes travel in `errors[].code`; the result
// status stays inside the packet's closed service-state union. The host gets
// an opaque trace id and an exact resume action — never a provider body or a
// private provider error.
export type DiscoveryServiceFailureCode =
  | "adapter_stale"
  | "not_connected"
  | "auth_expired"
  | "capability_missing"
  | "approval_missing"
  | "access_denied"
  | "network"
  | "provider_failure"
  | "service_bug";

export type DiscoveryServiceError = { code: DiscoveryServiceFailureCode; message: string; trace_id?: string };

export type DiscoveryServiceFailure = {
  code: DiscoveryServiceFailureCode;
  message: string;
  // Opaque and per-failure: correlate a refusal without learning anything
  // about what the provider or the service did internally.
  trace_id: string;
  resume_action: string;
};

let failureCounter = 0;
function newTraceId(): string {
  failureCounter += 1;
  return `tr:${randomBytes(8).toString("hex")}${failureCounter.toString(16).padStart(4, "0")}`;
}

function failure(code: DiscoveryServiceFailureCode, message: string, resume_action: string): DiscoveryServiceFailure {
  return { code, message, trace_id: newTraceId(), resume_action };
}

// One typed outcome per boundary reason: the status stays inside the closed
// service-state union, the failure code carries the vocabulary, and the
// resume action is exact. Exhaustive over DiscoveryBoundaryFailureReason, so
// a new reason in discoveryConnections breaks compilation here instead of
// silently mapping to a vague refusal.
const BOUNDARY_FAILURES: Record<DiscoveryBoundaryFailureReason, { status: DiscoveryServiceStatus; code: DiscoveryServiceFailureCode; message: string; resume: string }> = {
  unknown_grant: { status: "needs_service_grant", code: "approval_missing", message: "no active service grant exists for this target", resume: "Register and re-confirm the target to mint a grant." },
  subject_mismatch: { status: "invalid", code: "service_bug", message: "the authenticated subject is not the grant's subject", resume: "Retry with the target's own authenticated subject." },
  connection_mismatch: { status: "invalid", code: "service_bug", message: "the connection reference does not match the grant", resume: "Retry with the target's own connection reference." },
  workspace_mismatch: { status: "invalid", code: "service_bug", message: "the workspace reference does not match the grant", resume: "Retry with the target's own workspace reference." },
  target_mismatch: { status: "invalid", code: "service_bug", message: "the discovery target does not match the grant", resume: "Retry with the registered target reference." },
  lane_mismatch: { status: "invalid", code: "service_bug", message: "the discovery lane does not match the grant", resume: "Retry with the registered lane." },
  approval_mismatch: { status: "needs_source_approval", code: "approval_missing", message: "the local source approval no longer matches the service grant", resume: "Run the local resume command from needs_source_approval, then re-register and re-confirm the target." },
  stale_revocation_epoch: { status: "revoked", code: "approval_missing", message: "the local source was revoked after this grant was minted; the grant is dead", resume: "Re-approve the source and re-register the target if hosted reads are wanted again." },
  grant_expired: { status: "needs_service_grant", code: "approval_missing", message: "the service grant has expired", resume: "Register and re-confirm the target to mint a fresh grant." },
  selector_out_of_scope: { status: "invalid", code: "approval_missing", message: "the requested window or selector is outside the grant's approved scope", resume: "Narrow the request to the approved selectors and retry." },
  budget_exhausted: { status: "budget_exhausted", code: "approval_missing", message: "the grant's operation budget is exhausted for its window", resume: "A person authorizes a fresh budget; productfoo never silently exceeds one." },
};

export function boundaryFailureFor(reason: DiscoveryBoundaryFailureReason): { status: DiscoveryServiceStatus; code: DiscoveryServiceFailureCode; message: string; resume: string } {
  return BOUNDARY_FAILURES[reason];
}

// --- Closed service states (Contracts section of the packet spec) -------------

// The packet's stable service states. This build never adds or renames one;
// operations here emit the subset that readiness and listing can honestly
// reach and the full union stays closed for the packet's other operations.
export type DiscoveryServiceStatus =
  | "ready"
  | "processed"
  | "clean_no_op"
  | "not_connected"
  | "auth_expired"
  | "needs_source_approval"
  | "needs_service_grant"
  | "needs_service_verification"
  | "needs_provider_access"
  | "needs_provider_connector"
  | "awaiting_match"
  | "ambiguous_match"
  | "needs_research_proof"
  | "needs_local_apply"
  | "needs_review"
  | "result_lost"
  | "transcript_too_large"
  | "provider_timeout"
  | "revocation_pending"
  | "revoked"
  | "budget_exhausted"
  | "invalid";

// R-011: provider support is a tested state, not a configuration claim. The
// claimed state comes from the governed provider registry; readiness overrides
// it downward from observation and this module can never mint `verified_live`
// — that state requires the human dogfood bar (T-008), not a flag.
export type DiscoverySupportState = "contract_only" | "verified_live" | "degraded" | "unavailable";

// --- Result skeleton (every variant carries exactly these common fields) ------

export type DiscoveryServiceResult = {
  schema_version: "0.1";
  operation: "discovery_connection_ready" | "discovery_list_sessions";
  status: DiscoveryServiceStatus;
  errors: DiscoveryServiceError[];
  handoff: DiscoveryHandoff | null;
  next_actions: string[];
  coverage: Record<string, unknown>;
};

const SERVICE_RESULT_KEYS = new Set(["schema_version", "operation", "status", "errors", "handoff", "next_actions", "coverage"]);

// Closure assertion for every result this module returns: no variant may grow
// extra top-level fields here. Operation-specific payloads (capabilities,
// sessions, refs) are carried inside the fields the packet names for the op —
// readiness's `capabilities`, listing's `sessions` — declared below.
function closedResult<T extends DiscoveryServiceResult>(result: T): T {
  for (const key of Object.keys(result)) {
    if (!SERVICE_RESULT_KEYS.has(key) && key !== "capabilities" && key !== "connection_ref" && key !== "target_ref" && key !== "sessions") {
      throw new Error(`discovery service result carries a field outside the closed contract: ${key}`);
    }
  }
  return result;
}

function commonResult(operation: DiscoveryServiceResult["operation"], status: DiscoveryServiceStatus, options: Partial<Omit<DiscoveryServiceResult, "schema_version" | "operation" | "status">> = {}): DiscoveryServiceResult {
  return closedResult({
    schema_version: READINESS_SCHEMA_VERSION,
    operation,
    status,
    errors: [],
    handoff: null,
    next_actions: [],
    coverage: {},
    ...options,
  });
}

function errorOf(f: DiscoveryServiceFailure): DiscoveryServiceError {
  return { code: f.code, message: f.message, trace_id: f.trace_id };
}

// --- Observed capabilities -----------------------------------------------------

// Connection-level observed capability (R-004): what THIS connection could
// actually do at its latest observation. Every path that fills these reads an
// observation; none asserts a fixture default.
export type ObservedConnectionCapabilities = DiscoveryCapabilities;

export type ObservedProviderConnection =
  | { state: "connected"; capabilities: ObservedConnectionCapabilities }
  | { state: "not_connected" }
  | { state: "auth_expired" }
  | { state: "revoked" };

// --- Provider listing source seam ----------------------------------------------

// The provider-side seam. The adapter does the raw→normalized mapping; the
// source adds what only the connection knows: the observed capabilities and
// the bounded raw listing. V0 implementations are fixtures; live listing
// waits for the hosted service (contract_only).
export interface DiscoveryListingSource<TRaw> {
  readonly provider: string;
  // The user's own alias for the connection being listed — one source is one
  // connection, and the alias is the normalized session field the strict
  // matcher's fingerprint is keyed on.
  readonly connection_alias: string;
  // Fail-closed: a source that does not declare the exact contract version
  // this module speaks is treated as stale (R-013).
  readonly contract_version: string;
  // The governed registry claim (R-011). Readiness downgrades it from
  // observation; it never upgrades anything to verified_live.
  readonly claimed_support_state: Exclude<DiscoverySupportState, "degraded" | "unavailable">;
  // The provider adapter that maps raw records into the closed session shape.
  readonly adapter: DiscoverySourceAdapter<TRaw>;
  // Observed on this connection — never hard-coded from a fixture.
  observeConnection(): Promise<ObservedProviderConnection> | ObservedProviderConnection;
  // Bounded listing inside the granted window. The source enforces its own
  // ceilings and reports truncation instead of widening the read.
  listWithin(input: { window: { from: string; to: string }; limit: number }): Promise<{ records: TRaw[]; truncated: boolean }>;
}

// --- Hosted service seam --------------------------------------------------------

export type DiscoveryHostedConnectionState = "connected" | "not_connected" | "auth_expired" | "revoked";

export type DiscoveryHostedConnection =
  | { state: "connected"; canonical_connection_key: string }
  | { state: "not_connected" }
  | { state: "auth_expired" }
  | { state: "revoked" };

export type DiscoveryGrantLookup = { grant: DiscoveryServiceGrant | null; operations_used: number };

// The hosted state this module reports but never invents. Unreachability is
// signalled by throwing DiscoveryServiceUnreachableError (the T-002 type), so
// "the service said nothing" can never be dressed up as "the service said
// everything is fine".
export interface DiscoveryReadinessService {
  connectionState(input: { subject_ref: DiscoverySubjectRef; connection_ref: DiscoveryConnectionRef }): Promise<DiscoveryHostedConnection>;
  grantForTarget(input: { subject_ref: DiscoverySubjectRef; target_ref: DiscoveryTargetRef }): Promise<DiscoveryGrantLookup>;
}

// --- Server-held keys and the hosted source fingerprint (R-004) -----------------

export type DiscoveryServiceKeys = {
  source_fingerprint_key: string;
  session_ref_key: Buffer;
};

// Derives the two domain-separated keys the hosted service holds from one
// root secret. The root never leaves the service; the derived keys never
// appear on any surface this module produces.
export function deriveDiscoveryServiceKeys(root_key: string): DiscoveryServiceKeys {
  const root = Buffer.from(root_key, "utf8");
  return {
    source_fingerprint_key: createHmac("sha256", root).update("foo_discovery_source_fingerprint_key/v1").digest("base64"),
    session_ref_key: createHmac("sha256", root).update("foo_discovery_session_ref_key/v1").digest(),
  };
}

// The hosted source fingerprint grammar: `hmac-sha256:v1:<hex>` over the
// canonical {foo_subject, provider, canonical_connection_key,
// provider_session_identity} with a server-held domain-separated key. It is
// derived from identity, never from transcript text, titles, participants,
// URLs, or host aliases (R-004).
export function hostedDiscoverySourceFingerprint(
  input: { subject_ref: DiscoverySubjectRef; provider: string; canonical_connection_key: string; provider_session_identity: string },
  fingerprint_key: string,
): string {
  for (const [field, value] of [
    ["subject", input.subject_ref],
    ["provider", input.provider],
    ["canonical connection key", input.canonical_connection_key],
    ["provider session identity", input.provider_session_identity],
  ] as const) {
    if (!value?.trim()) throw new Error(`hosted source fingerprint requires a ${field}`);
  }
  const mac = createHmac("sha256", fingerprint_key).update(
    ["foo_discovery_source_fingerprint/v1", input.subject_ref, input.provider.trim().toLowerCase(), input.canonical_connection_key, input.provider_session_identity].join("\n"),
  );
  return `hmac-sha256:v1:${mac.digest("hex")}`;
}

// --- The signed-and-encrypted session_ref ----------------------------------------

// Self-contained per R-004: binds authenticated subject, canonical source,
// target, grant digest, provider session identity, revocation epoch, and
// expiry — requires no meeting-metadata lookup store, and reveals none of
// those values to the host. The raw provider session identity exists only
// inside the sealed ciphertext.
export type DiscoverySessionRefPayload = {
  kind: "discovery_session_ref";
  version: "v1";
  subject_ref: DiscoverySubjectRef;
  canonical_connection_key: string;
  provider: string;
  target_ref: DiscoveryTargetRef;
  grant_digest: string;
  provider_session_identity: string;
  hosted_source_fingerprint: string;
  revocation_epoch: number;
  expires_at: string;
};

const SESSION_REF_PREFIX = "sref:v1:";
const SESSION_REF_PAYLOAD_KEYS = new Set([
  "kind",
  "version",
  "subject_ref",
  "canonical_connection_key",
  "provider",
  "target_ref",
  "grant_digest",
  "provider_session_identity",
  "hosted_source_fingerprint",
  "revocation_epoch",
  "expires_at",
]);

// Authenticated encryption (AES-256-GCM with a server-held key): the payload
// is unreadable without the key and tampering with any byte breaks the tag.
function sealDiscoverySessionRef(payload: DiscoverySessionRefPayload, key: Buffer): string {
  for (const key_of_payload of Object.keys(payload)) {
    if (!SESSION_REF_PAYLOAD_KEYS.has(key_of_payload)) throw new Error(`session_ref payload carries an unknown field: ${key_of_payload}`);
  }
  if (payload.kind !== "discovery_session_ref" || payload.version !== "v1") throw new Error("session_ref payload must be a v1 discovery_session_ref");
  if (!Number.isInteger(payload.revocation_epoch) || payload.revocation_epoch < 0) throw new Error("session_ref payload revocation_epoch must be a non-negative integer");
  if (!Number.isFinite(Date.parse(payload.expires_at))) throw new Error("session_ref payload expires_at must be an ISO timestamp");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return SESSION_REF_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export type DiscoverySessionRefOpen =
  | { ok: true; payload: DiscoverySessionRefPayload }
  | { ok: false; reason: "malformed" | "wrong_key" | "tampered" | "expired" | "not_a_session_ref" };

// Service-side verification. A ref that fails for ANY reason opens nothing —
// the reasons are for service logs and traces, never for the host.
export function openDiscoverySessionRef(session_ref: string, key: Buffer, now: string): DiscoverySessionRefOpen {
  if (!session_ref.startsWith(SESSION_REF_PREFIX)) return { ok: false, reason: "not_a_session_ref" };
  let raw: Buffer;
  try {
    raw = Buffer.from(session_ref.slice(SESSION_REF_PREFIX.length), "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (raw.length < 12 + 16 + 2) return { ok: false, reason: "malformed" };
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Wrong keys and tampered bytes are indistinguishable by design (GCM).
    return { ok: false, reason: "tampered" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  for (const field of Object.keys(parsed as Record<string, unknown>)) {
    if (!SESSION_REF_PAYLOAD_KEYS.has(field)) return { ok: false, reason: "malformed" };
  }
  const payload = parsed as DiscoverySessionRefPayload;
  if (payload.kind !== "discovery_session_ref" || payload.version !== "v1") return { ok: false, reason: "malformed" };
  if (Date.parse(now) > Date.parse(payload.expires_at)) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

// --- Readiness report (the facets R-004 names, carried in coverage) ---------------

export type DiscoveryReadinessReport = {
  service_reachable: boolean;
  capability_source: "observed";
  connection_state: DiscoveryHostedConnectionState;
  support_state: DiscoverySupportState;
  synthesis: { available: boolean };
  approval: { state: "approved" | "missing" | "unregistered"; matches_grant: boolean | null };
  grant: {
    state: "active" | "missing" | "expired" | "stale_revocation_epoch" | "approval_mismatch" | "unregistered";
    expires_at?: string;
    budget?: { max_operations: number; used: number; window: "day" };
  };
  scheduler: { mode: "manual"; armed: false };
  policy: typeof DISCOVERY_SERVICE_POLICY;
};

// --- Readiness operation (`discovery_connection_ready`) ----------------------------

export type DiscoveryConnectionReadyInput = {
  subject_ref: DiscoverySubjectRef;
  connection_ref: DiscoveryConnectionRef;
  // Readiness works before any target is registered (target_ref absent) and
  // reports target-local approval/grant states once a target is bound.
  target_ref?: DiscoveryTargetRef;
  // The CURRENT local ledger state for the bound target — what the local
  // approval and revocation say right now, never what the grant was minted
  // with. Required when target_ref is present.
  local?: {
    approval_digest: string | null;
    revocation_epoch: number;
    workspace_ref: string;
    target_id: string;
    lane: DiscoveryLane;
  };
  synthesis: { available: boolean };
  now: string;
};

export type DiscoveryReadinessDeps<TRaw> = {
  service: DiscoveryReadinessService;
  listing: DiscoveryListingSource<TRaw>;
  keys: DiscoveryServiceKeys;
};

export type DiscoveryReadinessResult = DiscoveryServiceResult & {
  operation: "discovery_connection_ready";
  connection_ref?: DiscoveryConnectionRef;
  target_ref?: DiscoveryTargetRef;
  // Exactly the four observed capability booleans R-004 names — never
  // meetings, never provider payloads.
  capabilities?: ObservedConnectionCapabilities;
};

type Probe =
  | { ok: true; hosted: DiscoveryHostedConnection; observed: ObservedProviderConnection }
  | { ok: false; failure: DiscoveryServiceFailure; status: DiscoveryServiceStatus; handoff?: DiscoveryHandoff };

// One probe of both sides, typed. Service unreachability is honest and
// specific: nothing is verified, so nothing is claimed (needs_service_
// verification), and the failure code is `network`.
async function probeConnection<TRaw>(input: { subject_ref: DiscoverySubjectRef; connection_ref: DiscoveryConnectionRef }, deps: DiscoveryReadinessDeps<TRaw>): Promise<Probe> {
  try {
    const hosted = await deps.service.connectionState({ subject_ref: input.subject_ref, connection_ref: input.connection_ref });
    const observed = await deps.listing.observeConnection();
    return { ok: true, hosted, observed };
  } catch (error) {
    if (error instanceof DiscoveryServiceUnreachableError) {
      const f = failure("network", "the productfoo discovery service is unreachable; hosted connection state could not be verified", "Retry when the productfoo discovery service is reachable; nothing was read and nothing was written.");
      return { ok: false, failure: f, status: "needs_service_verification" };
    }
    const f = failure("service_bug", "the readiness probe failed inside the productfoo service; the failure was recorded for its trace id", "Retry the readiness operation; if it repeats, report the trace id to productfoo.");
    return { ok: false, failure: f, status: "invalid" };
  }
}

function observedCaps(connection: ObservedProviderConnection): ObservedConnectionCapabilities | null {
  return connection.state === "connected" ? connection.capabilities : null;
}

// Observed, never asserted: `verified_live` cannot be produced here even if a
// registry claims it and the observation is clean — the verified-live state is
// minted by the governed registry after the T-008 dogfood bar, not by code.
function supportStateFor(claimed: DiscoverySupportState, caps: ObservedConnectionCapabilities): DiscoverySupportState {
  if (!caps.list_sessions || !caps.open_transcript) return "unavailable";
  if (!caps.stable_link || !caps.timestamps) return "degraded";
  return claimed === "verified_live" ? "contract_only" : claimed;
}

function readinessHandoff(status: DiscoveryServiceStatus, observed: ObservedProviderConnection): DiscoveryHandoff | null {
  switch (status) {
    case "not_connected":
      return { kind: "provider_connect", requires_human: true };
    case "auth_expired":
      return { kind: "provider_reconnect", requires_human: true };
    case "needs_provider_access":
      // Preserve the sanitized provider surface when the observation carries
      // one (a stable link), per the packet's human workflow step 4.
      return { kind: "provider_access_request", requires_human: true };
    default:
      void observed;
      return null;
  }
}

// The readiness operation: report productfoo-service reachability, the authenticated
// connection state, observed capabilities, server-side-synthesis
// availability, target-local source-approval and service-grant states, and
// scheduler/budget state. It never lists meetings and never returns provider
// payloads. The status is the first blocker in a fixed order; the full report
// rides in coverage.readiness either way.
export async function discoverConnectionReady<TRaw>(input: DiscoveryConnectionReadyInput, deps: DiscoveryReadinessDeps<TRaw>): Promise<DiscoveryReadinessResult> {
  const report: DiscoveryReadinessReport = {
    service_reachable: true,
    capability_source: "observed",
    connection_state: "not_connected",
    support_state: "unavailable",
    synthesis: { available: Boolean(input.synthesis?.available) },
    approval: { state: "unregistered", matches_grant: null },
    grant: { state: "unregistered" },
    scheduler: { mode: "manual", armed: false },
    policy: { ...DISCOVERY_SERVICE_POLICY },
  };
  const common = { operation: "discovery_connection_ready" as const, connection_ref: input.connection_ref, ...(input.target_ref ? { target_ref: input.target_ref } : {}) };

  if (!input.subject_ref?.trim() || !input.connection_ref?.trim() || !Number.isFinite(Date.parse(input.now))) {
    const f = failure("service_bug", "the readiness request is malformed; nothing was probed", "Retry with an authenticated subject, a connection reference, and the current time.");
    return {
      ...commonResult("discovery_connection_ready", "invalid", { errors: [errorOf(f)], next_actions: [f.resume_action], coverage: { readiness: report } }),
      ...common,
    } as DiscoveryReadinessResult;
  }

  const probe = await probeConnection({ subject_ref: input.subject_ref, connection_ref: input.connection_ref }, deps);
  if (!probe.ok) {
    return {
      ...commonResult("discovery_connection_ready", probe.status, {
        errors: [errorOf(probe.failure)],
        next_actions: [probe.failure.resume_action],
        handoff: probe.handoff ?? null,
        coverage: { readiness: { ...report, service_reachable: probe.failure.code !== "network" } },
      }),
      ...common,
    } as DiscoveryReadinessResult;
  }

  const caps = observedCaps(probe.observed);
  const hostedState = probe.hosted.state;
  const observedState = probe.observed.state;

  // Compose the authenticated connection state honestly: the worse of the
  // hosted record and the provider observation wins, revoked worst of all.
  const connection_state: DiscoveryHostedConnectionState =
    hostedState === "revoked" || observedState === "revoked"
      ? "revoked"
      : hostedState === "auth_expired" || observedState === "auth_expired"
        ? "auth_expired"
        : hostedState === "not_connected" || observedState === "not_connected"
          ? "not_connected"
          : "connected";
  report.connection_state = connection_state;

  const finish = (status: DiscoveryServiceStatus, extra: Partial<DiscoveryReadinessResult> = {}): DiscoveryReadinessResult =>
    closedResult({ ...commonResult("discovery_connection_ready", status, extra), ...common, coverage: { ...extra.coverage, readiness: report } }) as DiscoveryReadinessResult;

  if (connection_state === "revoked") {
    const f = failure("not_connected", "the connection was revoked; a new connection must be created before any hosted read", "Reconnect the provider through productfoo's connect page to create a new connection.");
    return finish("revoked", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_connect", requires_human: true } });
  }
  if (connection_state === "auth_expired") {
    const f = failure("auth_expired", "the connection's provider authorization expired or was withdrawn", "A person reconnects the provider through productfoo; a non-interactive agent relays this and stops.");
    return finish("auth_expired", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: readinessHandoff("auth_expired", probe.observed) });
  }
  if (connection_state === "not_connected") {
    const f = failure("not_connected", "no provider connection is registered for this subject", "A person connects the provider through productfoo's connect landing page; a non-interactive agent relays this and stops.");
    return finish("not_connected", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: readinessHandoff("not_connected", probe.observed) });
  }

  if (!caps) {
    // Connected on both sides but the observation carries no capabilities —
    // an adapter that cannot describe the connection is stale by definition.
    const f = failure("adapter_stale", "the provider adapter did not report an observable capability set", `Upgrade the provider adapter to a build declaring ${READINESS_CONTRACT_VERSION}.`);
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }

  // C-006: missing required capabilities degrade honestly and stop the flow.
  if (!caps.list_sessions) {
    report.support_state = "unavailable";
    const f = failure("capability_missing", "the provider connection cannot list completed sessions, so no metadata read is possible", "Connect the provider through a connector that supports bounded session listing, or ask the provider for one.");
    return finish("needs_provider_connector", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_connector_missing", requires_human: true } });
  }
  if (!caps.open_transcript) {
    report.support_state = "unavailable";
    const f = failure("capability_missing", "the provider connection has no transcript access, so server-side synthesis cannot run; metadata listing still works", "Request full transcript access for the connection, then rerun readiness.");
    return finish("needs_provider_access", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: readinessHandoff("needs_provider_access", probe.observed) });
  }
  report.support_state = supportStateFor(deps.listing.claimed_support_state, caps);

  // Target-local approval and service-grant states: reported whenever a
  // target is bound; they gate the status only for a bound target.
  if (input.target_ref) {
    const local = input.local;
    if (!local) {
      const f = failure("service_bug", "a bound target was presented without the local approval state the boundary recheck requires", "Retry with the current local approval digest and revocation epoch for this target.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    let lookup: DiscoveryGrantLookup;
    try {
      lookup = await deps.service.grantForTarget({ subject_ref: input.subject_ref, target_ref: input.target_ref });
    } catch (error) {
      if (error instanceof DiscoveryServiceUnreachableError) {
        const f = failure("network", "the productfoo discovery service is unreachable; the target's service-grant state could not be verified", "Retry when the productfoo discovery service is reachable; nothing was read and nothing was written.");
        return finish("needs_service_verification", { errors: [errorOf(f)], next_actions: [f.resume_action] });
      }
      const f = failure("service_bug", "the grant lookup failed inside the productfoo service; the failure was recorded for its trace id", "Retry the readiness operation; if it repeats, report the trace id to productfoo.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!lookup.grant) {
      report.approval = { state: local.approval_digest ? "approved" : "missing", matches_grant: null };
      report.grant = { state: "missing" };
      const f = failure("approval_missing", "no active service grant exists for this target; hosted reads stay locked", "Register the target manifest and have the same person confirm it out of band to mint a grant.");
      return finish("needs_service_grant", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    const check = recheckDiscoveryAccessBoundary({
      grant: lookup.grant,
      expected: {
        subject_ref: input.subject_ref,
        connection_ref: input.connection_ref,
        workspace_ref: local.workspace_ref,
        target_id: local.target_id,
        lane: local.lane,
        approval_digest: local.approval_digest ?? "",
        revocation_epoch: local.revocation_epoch,
      },
      operations_used: lookup.operations_used,
      now: input.now,
    });
    const grant = lookup.grant;
    report.grant = {
      state: check.ok ? "active" : check.reason === "grant_expired" ? "expired" : check.reason === "stale_revocation_epoch" ? "stale_revocation_epoch" : check.reason === "approval_mismatch" ? "approval_mismatch" : "missing",
      expires_at: grant.expires_at,
      budget: { max_operations: grant.budget.max_operations, used: lookup.operations_used, window: grant.budget.window },
    };
    report.approval = { state: local.approval_digest ? "approved" : "missing", matches_grant: check.ok ? true : check.reason === "approval_mismatch" ? false : null };
    if (!check.ok && check.reason === "approval_mismatch") {
      const f = failure("approval_missing", "the local source approval no longer matches the service grant; approve the current scope and register the target again", "Run the local resume command from needs_source_approval, then re-register and re-confirm the target.");
      return finish("needs_source_approval", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!check.ok && check.reason === "stale_revocation_epoch") {
      const f = failure("approval_missing", "the local source was revoked after this grant was minted; the grant is dead", "Re-approve the source and re-register the target if hosted reads are wanted again.");
      return finish("revoked", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!check.ok && check.reason === "grant_expired") {
      const f = failure("approval_missing", "the service grant has expired", "Register and re-confirm the target to mint a fresh grant.");
      return finish("needs_service_grant", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!check.ok && check.reason === "budget_exhausted") {
      const f = failure("approval_missing", "the grant's operation budget is exhausted for its window", "A person authorizes a fresh budget; productfoo never silently exceeds one.");
      return finish("budget_exhausted", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!check.ok) {
      const f = failure("service_bug", "the service grant does not match the presented target identity", "Retry with the target's own subject, workspace, and connection references.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
  } else if (input.local?.approval_digest != null) {
    report.approval = { state: "approved", matches_grant: null };
  } else if (input.local) {
    report.approval = { state: "missing", matches_grant: null };
  }

  const caveats: string[] = [];
  if (!caps.stable_link || !caps.timestamps) {
    caveats.push(!caps.stable_link ? "no stable provider link is available for this connection" : "timestamp locators are not available for this connection");
  }
  if (report.support_state === "degraded") caveats.push("the connection reports degraded capability coverage");
  return finish("ready", {
    capabilities: { ...caps },
    next_actions: [
      ...caveats.map((caveat) => `Degraded capability: ${caveat}.`),
      ...(input.target_ref ? ["Run the bounded listing inside the approved scope when a match is wanted."] : ["Register and confirm a target manifest before any hosted read."]),
    ],
  });
}

// --- Bounded metadata listing (`discovery_list_sessions`) ----------------------------

export type DiscoveryListSessionsInput = {
  subject_ref: DiscoverySubjectRef;
  connection_ref: DiscoveryConnectionRef;
  target_ref: DiscoveryTargetRef;
  // A bounded time window already covered by the grant (Contracts section).
  window: { from: string; to: string };
  local: {
    approval_digest: string;
    revocation_epoch: number;
    workspace_ref: string;
    target_id: string;
    lane: DiscoveryLane;
  };
  now: string;
};

export type DiscoveryListSessionsResult = DiscoveryServiceResult & {
  operation: "discovery_list_sessions";
  connection_ref: DiscoveryConnectionRef;
  target_ref: DiscoveryTargetRef;
  sessions: DiscoveryListedSession[];
};

// What a listed session looks like on the host surface: the normalized
// metadata the strict matcher needs, with the provider handle REPLACED by the
// signed session_ref. The closed key set below is the whole surface — a raw
// record field cannot ride through because the builder refuses unknown keys.
export type DiscoveryListedSession = {
  schema_version: "0.1";
  provider: string;
  connection_alias: string;
  completed_at: string;
  completion_state: "completed";
  title: string;
  participants: string[];
  stable_url?: string;
  capabilities: DiscoveryCapabilities;
  access: "available" | "denied";
  session_ref: string;
};

const LISTED_SESSION_KEYS = new Set([
  "schema_version",
  "provider",
  "connection_alias",
  "completed_at",
  "completion_state",
  "title",
  "participants",
  "stable_url",
  "capabilities",
  "access",
  "session_ref",
]);

const FORBIDDEN_LISTED_KEY = /transcript|content|note|summary|runtime_handle|token|secret|credential|password|nango|query|fragment/i;
const EMAIL_SHAPE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

// Privacy-minimized participant labels (R-004): the strict matcher compares
// names, so names survive; anything email-shaped collapses to its @domain
// label and the local part never leaves the service.
function minimizeParticipantLabel(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (EMAIL_SHAPE.test(trimmed)) {
    const at = trimmed.lastIndexOf("@");
    return at > 0 && at < trimmed.length - 1 ? `@${trimmed.slice(at + 1).toLowerCase()}` : null;
  }
  return trimmed;
}

function buildListedSession(session: DiscoverySession, session_ref: string, transcript_access: boolean): DiscoveryListedSession {
  const listed: DiscoveryListedSession = {
    schema_version: "0.1",
    provider: session.provider,
    connection_alias: session.connection_alias,
    completed_at: session.completed_at,
    completion_state: "completed",
    title: session.title,
    participants: [...new Set(session.participants.map(minimizeParticipantLabel).filter((label): label is string => label !== null))],
    capabilities: { ...session.capabilities },
    access: transcript_access ? "available" : "denied",
    session_ref,
  };
  if (session.stable_url) listed.stable_url = sanitizeDiscoveryStableUrl(session.provider, session.stable_url);
  for (const key of Object.keys(listed)) {
    if (!LISTED_SESSION_KEYS.has(key)) throw new Error(`listed session carries a field outside the closed contract: ${key}`);
    if (FORBIDDEN_LISTED_KEY.test(key)) throw new Error(`listed session carries a forbidden field: ${key}`);
  }
  return listed;
}

// The bounded listing operation: inside an approved study or inbox scope,
// list only completed metadata the existing strict matcher needs, each entry
// carrying a signed session_ref instead of a provider handle. Every gate
// fails closed BEFORE any provider call; an empty bounded listing is
// `awaiting_match` with `sessions: []`, not an error.
export async function discoverListSessions<TRaw>(input: DiscoveryListSessionsInput, deps: DiscoveryReadinessDeps<TRaw>): Promise<DiscoveryListSessionsResult> {
  const common = { operation: "discovery_list_sessions" as const, connection_ref: input.connection_ref, target_ref: input.target_ref };
  const finish = (status: DiscoveryServiceStatus, extra: Partial<DiscoveryListSessionsResult> = {}): DiscoveryListSessionsResult =>
    closedResult({ ...commonResult("discovery_list_sessions", status, extra), ...common, sessions: extra.sessions ?? [] }) as DiscoveryListSessionsResult;

  const shapeOk =
    input.subject_ref?.trim() &&
    input.connection_ref?.trim() &&
    input.target_ref?.trim() &&
    input.local?.approval_digest &&
    Number.isFinite(Date.parse(input.now)) &&
    Number.isFinite(Date.parse(input.window?.from)) &&
    Number.isFinite(Date.parse(input.window?.to)) &&
    Date.parse(input.window.from) < Date.parse(input.window.to);
  if (!shapeOk) {
    const f = failure("service_bug", "the listing request is malformed or its window is empty; nothing was probed", "Retry with opaque references, the current local approval state, and a bounded non-empty window.");
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }

  // Gate 1 — hosted connection state (zero provider calls before it passes).
  let hosted: DiscoveryHostedConnection;
  try {
    hosted = await deps.service.connectionState({ subject_ref: input.subject_ref, connection_ref: input.connection_ref });
  } catch (error) {
    if (error instanceof DiscoveryServiceUnreachableError) {
      const f = failure("network", "the productfoo discovery service is unreachable; hosted connection state could not be verified", "Retry when the productfoo discovery service is reachable; nothing was read and nothing was written.");
      return finish("needs_service_verification", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    const f = failure("service_bug", "the connection lookup failed inside the productfoo service; the failure was recorded for its trace id", "Retry the listing; if it repeats, report the trace id to productfoo.");
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  if (hosted.state === "revoked") {
    const f = failure("not_connected", "the connection was revoked; no hosted read is possible", "Reconnect the provider through productfoo to create a new connection.");
    return finish("revoked", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_connect", requires_human: true } });
  }
  if (hosted.state === "auth_expired") {
    const f = failure("auth_expired", "the connection's provider authorization expired or was withdrawn", "A person reconnects the provider through productfoo; a non-interactive agent relays this and stops.");
    return finish("auth_expired", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_reconnect", requires_human: true } });
  }
  if (hosted.state === "not_connected" || !hosted.state) {
    const f = failure("not_connected", "no provider connection is registered for this subject", "A person connects the provider through productfoo's connect landing page; a non-interactive agent relays this and stops.");
    return finish("not_connected", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_connect", requires_human: true } });
  }

  // Gate 2 — the service grant for this target, then the full boundary
  // recheck against the CURRENT local ledger state.
  let lookup: DiscoveryGrantLookup;
  try {
    lookup = await deps.service.grantForTarget({ subject_ref: input.subject_ref, target_ref: input.target_ref });
  } catch (error) {
    const f = failure("network", "the productfoo discovery service is unreachable; the target's service-grant state could not be verified", "Retry when the productfoo discovery service is reachable; nothing was read and nothing was written.");
    return finish("needs_service_verification", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  if (!lookup.grant) {
    const f = failure("approval_missing", "no active service grant exists for this target; hosted reads stay locked", "Register the target manifest and have the same person confirm it out of band to mint a grant.");
    return finish("needs_service_grant", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  const grantCheck = validateDiscoveryServiceGrant(lookup.grant);
  if (!grantCheck.ok) {
    const f = failure("service_bug", "the stored service grant is not a valid closed grant", "Report the trace id to productfoo; nothing was read.");
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  const grant = grantCheck.grant;
  const boundary = recheckDiscoveryAccessBoundary({
    grant,
    expected: {
      subject_ref: input.subject_ref,
      connection_ref: input.connection_ref,
      workspace_ref: input.local.workspace_ref,
      target_id: input.local.target_id,
      lane: input.local.lane,
      approval_digest: input.local.approval_digest,
      revocation_epoch: input.local.revocation_epoch,
    },
    operations_used: lookup.operations_used,
    now: input.now,
  });
  if (!boundary.ok) {
    const mappedFailure = boundaryFailureFor(boundary.reason);
    const f = failure(mappedFailure.code, mappedFailure.message, mappedFailure.resume);
    return finish(mappedFailure.status, { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }

  // Gate 3 — observed capabilities. Listing is the metadata read; a missing
  // transcript capability degrades the entries (access: "denied") instead of
  // blocking the bounded listing, and the readiness operation is where the
  // needs_provider_access stop lives (C-006).
  let observed: ObservedProviderConnection;
  try {
    observed = await deps.listing.observeConnection();
  } catch {
    const f = failure("provider_failure", "the provider connection could not be observed; nothing was read", "Retry the listing; if it repeats, report the trace id to productfoo.");
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  if (observed.state !== "connected") {
    const f = failure("not_connected", "the provider connection is no longer usable for listing", "Reconnect or refresh the provider connection through productfoo, then retry.");
    return finish(observed.state === "revoked" ? "revoked" : observed.state === "auth_expired" ? "auth_expired" : "not_connected", {
      errors: [errorOf(f)],
      next_actions: [f.resume_action],
      handoff: { kind: "provider_connect", requires_human: true },
    });
  }
  if (!observed.capabilities.list_sessions) {
    const f = failure("capability_missing", "the provider connection cannot list completed sessions, so no metadata read is possible", "Connect the provider through a connector that supports bounded session listing, or ask the provider for one.");
    return finish("needs_provider_connector", { errors: [errorOf(f)], next_actions: [f.resume_action], handoff: { kind: "provider_connector_missing", requires_human: true } });
  }

  // The read itself: one bounded call inside the granted window. Provider
  // errors are typed and content-free — the underlying message (which could
  // carry a provider body) is never forwarded.
  let listed: { records: TRaw[]; truncated: boolean };
  try {
    listed = await deps.listing.listWithin({ window: input.window, limit: DISCOVERY_SERVICE_POLICY.max_list_sessions });
  } catch (error) {
    if (error instanceof DiscoveryServiceUnreachableError) {
      const f = failure("network", "the provider could not be reached for the bounded listing; nothing was read", "Retry when the provider is reachable; nothing was written.");
      return finish("needs_service_verification", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    const f = failure("provider_failure", "the provider listing failed inside the bounded read; nothing was read", "Retry the listing; if it repeats, report the trace id to productfoo.");
    return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }
  if (listed.truncated) {
    const f = failure("provider_failure", "the approved window holds more sessions than the bounded listing allows", "Narrow the approved window or selectors and list again; productfoo never widens a window and never auto-retries.");
    return finish("budget_exhausted", { errors: [errorOf(f)], next_actions: [f.resume_action] });
  }

  // Normalize through the provider adapter, keep only completed sessions.
  const sessions: DiscoveryListedSession[] = [];
  for (const record of listed.records) {
    let normalized: DiscoverySession;
    try {
      normalized = deps.listing.adapter.normalizeSession(record, deps.listing.connection_alias);
    } catch {
      const f = failure("service_bug", "a provider record could not be normalized into the closed session shape", "Report the trace id to productfoo; nothing was read.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (normalized.completion_state !== "completed") continue;
    const problems = validateNormalizedSession(normalized);
    if (problems.length) {
      const f = failure("service_bug", "a normalized session failed the closed validation; nothing was exposed", "Report the trace id to productfoo; nothing was read.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    if (!normalized.runtime_handle?.trim()) {
      const f = failure("service_bug", "a normalized session lacks the private session identity needed to mint its reference", "Report the trace id to productfoo; nothing was read.");
      return finish("invalid", { errors: [errorOf(f)], next_actions: [f.resume_action] });
    }
    const hosted_fingerprint = hostedDiscoverySourceFingerprint(
      { subject_ref: input.subject_ref, provider: normalized.provider, canonical_connection_key: hosted.canonical_connection_key, provider_session_identity: normalized.runtime_handle },
      deps.keys.source_fingerprint_key,
    );
    const expires_at = new Date(Math.min(Date.parse(input.now) + SESSION_REF_TTL_MS, Date.parse(grant.expires_at))).toISOString();
    const sealed = sealDiscoverySessionRef(
      {
        kind: "discovery_session_ref",
        version: "v1",
        subject_ref: input.subject_ref,
        canonical_connection_key: hosted.canonical_connection_key,
        provider: normalized.provider,
        target_ref: input.target_ref,
        grant_digest: grant.approval_digest,
        provider_session_identity: normalized.runtime_handle,
        hosted_source_fingerprint: hosted_fingerprint,
        revocation_epoch: input.local.revocation_epoch,
        expires_at,
      },
      deps.keys.session_ref_key,
    );
    sessions.push(buildListedSession(normalized, sealed, observed.capabilities.open_transcript));
  }

  if (sessions.length === 0) {
    // An empty bounded listing is `awaiting_match` with `sessions: []`, never
    // an error (Contracts section).
    return finish("awaiting_match", { next_actions: ["No completed sessions were listed inside the approved window; widen nothing — wait for completed sessions or adjust the approved scope."], coverage: { window: input.window, listed_records: listed.records.length, sessions: 0 } });
  }

  return finish("ready", {
    coverage: {
      window: input.window,
      listed_records: listed.records.length,
      sessions: sessions.length,
      support_state: supportStateFor(deps.listing.claimed_support_state, observed.capabilities),
      transcript_access: observed.capabilities.open_transcript ? "granted" : "missing",
      policy_version: DISCOVERY_SERVICE_POLICY.policy_version,
      session_ref_ttl_ms: SESSION_REF_TTL_MS,
    },
    sessions,
  });
}
