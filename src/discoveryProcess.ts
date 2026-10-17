// One server-enforced processing operation (nango-discovery-connector-v0
// T-004; R-005/R-006/R-007/R-012).
//
// processDiscoverySession is the whole privileged surface in one operation:
// authorization gates → exactly one transcript fetch → untrusted-text
// synthesis behind the isolated processor seam → deterministic
// privacy/injection/schema screening → raw disposal → a signed payload-free
// processing receipt. The transcript exists only inside this one request:
// it crosses no log, no queue, no cache, no backup, and no diagnostic —
// errors and coverage are content-free, trace ids are opaque, and there is
// no automatic retry or alternate source (a second body call is structurally
// impossible: one guarded call site, no loop).
//
// At-most-once (D-013): the content-free attempt ledger claims every attempt;
// a repeat claim in any state returns `result_lost` without a provider call,
// a lost success response is reported `result_lost` and never recovered from
// a store, and a new process attempt needs fresh human-confirmed budget
// authorization. Hosted deployment stays out of scope (contract_only): the
// operation is proven by fixtures and the published closed-union schemas,
// with the real transport/identity/confirmation stack owned by
// foo-mcp-server-v0 (T-002's seams, never rebuilt here).

import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  screenDiscoveryServiceEnvelope,
  type DiscoveryEvidenceEnvelope,
  type DiscoveryLane as DiscoveryEvidenceLane,
  type EvidenceContext,
} from "./discoveryEvidence.js";
import {
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  SYNTHESIS_SYSTEM_PROMPT,
  constructEnvelopeFromSynthesis,
  extractSynthesisJsonObject,
  synthesisUserMessage,
  type SynthesisInput,
} from "./discoverySynthesis.js";
import {
  boundaryFailureFor,
  DISCOVERY_SERVICE_POLICY,
  hostedDiscoverySourceFingerprint,
  openDiscoverySessionRef,
  type DiscoveryGrantLookup,
  type DiscoveryHostedConnection,
  type DiscoveryReadinessService,
  type DiscoveryServiceError,
  type DiscoveryServiceFailureCode,
  type DiscoveryServiceKeys,
  type DiscoveryServiceStatus,
  type DiscoverySessionRefPayload,
  type ObservedProviderConnection,
} from "./discoveryReadiness.js";
import {
  guardedDiscoveryAccess,
  recheckDiscoveryAccessBoundary,
  type DiscoveryBoundaryExpectation,
  type DiscoveryConnectionRef,
  type DiscoveryHandoff,
  type DiscoveryLane,
  type DiscoveryServiceGrant,
  type DiscoverySubjectRef,
  type DiscoveryTargetRef,
} from "./discoveryConnections.js";
import {
  canonicalJson,
  signEnvelope,
  verifyEnvelope,
  type EnvelopeFailureReason,
  type JsonValue,
  type SignedEnvelope,
  type SigningKeyStatus,
  type SplitTrustStores,
  type TrustedSigningKey,
  type TrustStore,
} from "./trustEnvelope.js";
import { sanitizeDiscoveryStableUrl } from "./discoverySources.js";

// --- Versioned identity -------------------------------------------------------

export const PROCESSING_VERSION = "discovery-process-0.1";
export const PROMPT_VERSION = "discovery-process-prompt-0.1";
export const RECEIPT_VERSION = "v1";
export const RECEIPT_ARTIFACT_KIND = "discovery-processing-receipt";

// A processing receipt lives long enough for a local apply session to verify
// it online (D-014); after expiry the apply fails closed and the work is
// re-requested under a fresh budget, never recovered from a store.
export const RECEIPT_TTL_MS = 24 * 60 * 60_000;

// Ceilings: the hosted service policy T-003 already ported from the Gong
// worker's GONG_POLICY (R-001 — one versioned policy, not new magic numbers).
// The module re-verifies every ceiling itself before synthesis or release;
// the source seam enforces the same values while reading.
export const DISCOVERY_PROCESSING_LIMITS = {
  max_response_bytes: DISCOVERY_SERVICE_POLICY.max_response_bytes,
  fetch_timeout_ms: DISCOVERY_SERVICE_POLICY.fetch_timeout_ms,
  max_model_input_tokens: DISCOVERY_SERVICE_POLICY.max_model_input_tokens,
} as const;

// D-015's closed mutation allowlist for SERVICE CONNECTION state. The
// processing operation performs none of these — it only claims and finishes
// content-free ledger rows and records budget spend. The conformance fixtures
// (V-016) journal every service call and prove exactly that.
export const DISCOVERY_CONNECTION_MUTATION_ALLOWLIST = [
  "connect",
  "credential_refresh",
  "target_suspend",
  "target_grant_revoke",
  "disconnect_revoke",
] as const;

const ATTEMPT_ID = /^att:[a-f0-9]{16,64}$/;
const CONNECTION_REF_SHAPE = /^conn:[a-z0-9][a-z0-9.-]*$/;
const TARGET_REF_SHAPE = /^dtarget:[a-z0-9][a-z0-9.-]*$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

const NO_STABLE_LINK_CAVEAT = "The provider did not supply a stable link for this call; the evidence cites in-transcript locators only.";
const NO_TIMESTAMPS_CAVEAT = "The provider's transcript carried no usable timestamps; findings cannot cite in-transcript locators.";
const UNTRUSTED_FAILURE = "the isolated synthesis processor failed; no evidence was produced";
const SCREEN_FAILURE = "the synthesized evidence failed deterministic screening";
const UNPARSEABLE_FAILURE = "synthesis did not return parseable JSON";

// --- Typed transcript-source failures (content-free) --------------------------

export class DiscoveryTranscriptOversizeError extends Error {
  constructor(readonly limit_bytes: number) {
    super(`the transcript response exceeded the ${limit_bytes}-byte policy ceiling`);
    this.name = "DiscoveryTranscriptOversizeError";
  }
}

export class DiscoveryTranscriptTimeoutError extends Error {
  constructor(readonly timeout_ms: number) {
    super(`the transcript fetch exceeded the ${timeout_ms}-ms policy ceiling`);
    this.name = "DiscoveryTranscriptTimeoutError";
  }
}

export class DiscoveryTranscriptCancelledError extends Error {
  constructor() {
    super("the transcript fetch was cancelled before completion");
    this.name = "DiscoveryTranscriptCancelledError";
  }
}

// --- The content-free attempt ledger (D-013) ----------------------------------

export type DiscoveryAttemptState = "claimed" | "receipt_issued" | "lost";

// Exactly the packet's idempotency row: identity refs and digests only —
// never the envelope, never source text, never provider content.
export type DiscoveryProcessingAttemptRow = {
  subject_ref: DiscoverySubjectRef;
  target_ref: DiscoveryTargetRef;
  source_fingerprint: string;
  processing_version: string;
  attempt_id: string;
  state: DiscoveryAttemptState;
};

export type DiscoveryProcessingAttemptClaim = Omit<DiscoveryProcessingAttemptRow, "state">;

export interface DiscoveryProcessingLedger {
  beginAttempt(row: DiscoveryProcessingAttemptClaim): { accepted: true } | { accepted: false; existing_state: DiscoveryAttemptState };
  finishAttempt(attempt_id: string, state: "receipt_issued" | "lost"): void;
}

export function createInMemoryDiscoveryLedger(): DiscoveryProcessingLedger & { rows(): DiscoveryProcessingAttemptRow[] } {
  const byAttempt = new Map<string, DiscoveryProcessingAttemptRow>();
  const activeBySource = new Map<string, string>();
  return {
    beginAttempt(row) {
      const repeated = byAttempt.get(row.attempt_id);
      if (repeated) return { accepted: false, existing_state: repeated.state };
      const sourceKey = [row.subject_ref, row.target_ref, row.source_fingerprint].join("\n");
      const activeAttempt = activeBySource.get(sourceKey);
      if (activeAttempt) return { accepted: false, existing_state: byAttempt.get(activeAttempt)!.state };
      byAttempt.set(row.attempt_id, { ...row, state: "claimed" });
      activeBySource.set(sourceKey, row.attempt_id);
      return { accepted: true };
    },
    finishAttempt(attempt_id, state) {
      const row = byAttempt.get(attempt_id);
      if (!row) throw new Error(`attempt ${attempt_id} was never claimed`);
      row.state = state;
    },
    rows() {
      return [...byAttempt.values()];
    },
  };
}

// --- Seams (T-002/T-003 shapes, extended only where the operation needs them) --

// The read-side service, plus the two things the operation needs that
// readiness did not: budget accounting for the target's grant, and the
// study's own hypotheses — productfoo study content the service may hold, unlike
// meeting metadata, which it never sees.
export type DiscoveryProcessingService = DiscoveryReadinessService & {
  recordOperation(target_ref: DiscoveryTargetRef): void;
  studyHypotheses(input: { subject_ref: DiscoverySubjectRef; target_ref: DiscoveryTargetRef }): Promise<Array<{ id: string; text: string }>>;
};

// The provider-side seam. observeConnection is a metadata probe, never a body
// call; fetchTranscript is the ONLY path to transcript bytes and is reached
// exactly once per operation, behind the guarded boundary.
export interface DiscoveryTranscriptSource {
  readonly provider: string;
  observeConnection(input: { subject_ref: DiscoverySubjectRef; connection_ref: DiscoveryConnectionRef }): Promise<ObservedProviderConnection>;
  fetchTranscript(request: { subject_ref: DiscoverySubjectRef; provider_session_identity: string; limits: typeof DISCOVERY_PROCESSING_LIMITS }): Promise<DiscoveryTranscriptFetch>;
}

export type DiscoveryTranscriptFetch = {
  transcript_text: string;
  transcript_complete: boolean;
  completed_at: string;
  stable_url?: string;
};

// The isolated-processor seam: the only component that renders transcript
// bytes into a model request. The module builds the prompt from the shared
// synthesis framing (R-001); the processor returns raw model output and is
// replaced by fixtures in tests. Real deployments run this on the isolated
// synthesis processor foo-mcp-server-v0 provisions.
export interface DiscoverySynthesisProcessor {
  readonly synthesizer_model: string;
  process(request: { system: string; prompt: string; max_output_tokens: number }): Promise<{ raw_output: string }>;
}

// --- Signed payload-free processing receipt (R-007) ---------------------------

// Binds the sanitized envelope to the authorization and source identity. No
// evidence payload, no source text, no provider content — only refs, digests,
// epochs, versions, and the enforced limits.
export type DiscoveryProcessingReceiptPayload = {
  kind: "discovery_processing_receipt";
  receipt_version: "v1";
  subject_ref: DiscoverySubjectRef;
  workspace_ref: string;
  connection_ref: DiscoveryConnectionRef;
  target_ref: DiscoveryTargetRef;
  target_id: string;
  lane: DiscoveryLane;
  source_fingerprint: string;
  approval_digest: string;
  grant_digest: string;
  revocation_epoch: number;
  envelope_hash: string;
  attempt_id: string;
  processing: {
    processing_version: string;
    prompt_version: string;
    policy_version: string;
    synthesizer_model: string;
    envelope_schema_version: "0.1";
  };
  limits: { max_response_bytes: number; fetch_timeout_ms: number; max_model_input_tokens: number };
};

export type DiscoveryProcessingReceipt = SignedEnvelope<DiscoveryProcessingReceiptPayload>;

const RECEIPT_PAYLOAD_KEYS = new Set([
  "kind",
  "receipt_version",
  "subject_ref",
  "workspace_ref",
  "connection_ref",
  "target_ref",
  "target_id",
  "lane",
  "source_fingerprint",
  "approval_digest",
  "grant_digest",
  "revocation_epoch",
  "envelope_hash",
  "attempt_id",
  "processing",
  "limits",
]);
const RECEIPT_PROCESSING_KEYS = new Set(["processing_version", "prompt_version", "policy_version", "synthesizer_model", "envelope_schema_version"]);
const RECEIPT_LIMITS_KEYS = new Set(["max_response_bytes", "fetch_timeout_ms", "max_model_input_tokens"]);

export interface DiscoveryReceiptSigner {
  readonly key_id: string;
  signReceipt(input: { payload: DiscoveryProcessingReceiptPayload; issued_at: string; expires_at: string }): DiscoveryProcessingReceipt;
  trustEntry(options?: { status?: SigningKeyStatus; valid_from?: string; valid_until?: string | null }): TrustedSigningKey;
}

// The ed25519 pattern of src/researchSigningKey.ts, scoped to discovery
// receipts: machine-local private key material is the deployer's concern and
// is accepted as a PEM or generated for fixtures; only the public entry is
// ever published into the trust store.
export function createInMemoryDiscoveryReceiptSigner(options: { private_key_pem?: string; key_id?: string } = {}): DiscoveryReceiptSigner {
  let privatePem: string;
  let publicPem: string;
  if (options.private_key_pem) {
    const key = createPrivateKey(options.private_key_pem);
    privatePem = key.export({ type: "pkcs8", format: "pem" }).toString();
    publicPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  } else {
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  }
  const keyId = options.key_id ?? `discovery-receipt-${createHash("sha256").update(publicPem).digest("hex").slice(0, 12)}`;
  return {
    key_id: keyId,
    signReceipt({ payload, issued_at, expires_at }) {
      return signEnvelope(
        {
          namespace: "foo",
          artifact_kind: RECEIPT_ARTIFACT_KIND,
          artifact_id: payload.attempt_id,
          payload,
          key_id: keyId,
          issued_at,
          not_before: issued_at,
          expires_at,
          sequence: 1,
          previous_hash: null,
        },
        privatePem,
      );
    },
    trustEntry(entry = {}) {
      return {
        key_id: keyId,
        public_key_pem: publicPem,
        status: entry.status ?? "active",
        valid_from: entry.valid_from ?? new Date(0).toISOString(),
        valid_until: entry.valid_until ?? null,
      };
    },
  };
}

export type DiscoveryReceiptExpectation = {
  subject_ref?: DiscoverySubjectRef;
  workspace_ref?: string;
  connection_ref?: DiscoveryConnectionRef;
  target_ref?: DiscoveryTargetRef;
  target_id?: string;
  lane?: DiscoveryLane;
  source_fingerprint?: string;
  approval_digest?: string;
  revocation_epoch?: number;
  envelope_hash?: string;
  attempt_id?: string;
};

export type DiscoveryReceiptVerification =
  | { ok: true; payload: DiscoveryProcessingReceiptPayload; receipt_hash: string; key_status: SigningKeyStatus }
  | { ok: false; reason: EnvelopeFailureReason | "malformed_payload" | "binding_mismatch"; message: string };

const RECEIPT_FAILURE_MESSAGES: Record<EnvelopeFailureReason, string> = {
  malformed_envelope: "the receipt is not a well-formed signed envelope",
  wrong_namespace: "the receipt was not signed in the foo namespace",
  wrong_artifact_kind: "the receipt is not a discovery-processing-receipt",
  wrong_artifact_id: "the receipt does not belong to this attempt",
  invalid_trust_store: "the trust store is unusable; verification fails closed",
  unknown_key: "the receipt was signed by an unknown key",
  revoked_key: "the receipt was signed by a revoked key",
  retired_key_for_new_acceptance: "the receipt was signed by a retired key",
  key_not_yet_valid: "the signing key was not valid when the receipt was issued",
  key_expired: "the signing key had expired when the receipt was issued",
  envelope_not_yet_valid: "the receipt is not yet within its validity interval",
  envelope_expired: "the receipt has expired",
  signature_invalid: "the receipt signature does not verify",
  invalid_sequence_state: "the receipt's sequence state is invalid",
  replay: "this receipt was already accepted",
  rollback: "the receipt's sequence rolls back an accepted state",
  sequence_gap: "the receipt's sequence does not continue the accepted state",
  previous_hash_mismatch: "the receipt's hash chain does not connect",
};

// The apply-side verifier T-005 consumes. Fail-closed by construction: an
// unknown or revoked key, an expired receipt, a closed-payload violation, or
// any mismatched binding returns ok: false and nothing else.
export function verifyDiscoveryProcessingReceipt(input: {
  receipt: unknown;
  trust_store: TrustStore<"foo">;
  expectation?: DiscoveryReceiptExpectation;
  now: string;
}): DiscoveryReceiptVerification {
  const receipt = input.receipt as SignedEnvelope | undefined;
  const selfArtifactId = receipt && typeof receipt.artifact_id === "string" ? receipt.artifact_id : "";
  const verdict = verifyEnvelope(input.receipt, {
    expected_namespace: "foo",
    expected_artifact_kind: RECEIPT_ARTIFACT_KIND,
    expected_artifact_id: input.expectation?.attempt_id ?? selfArtifactId,
    trust_stores: { customer: { namespace: "customer", keys: [] }, foo: input.trust_store } satisfies SplitTrustStores,
    accepted_state: null,
    verification_mode: "accept",
    now: input.now,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason, message: RECEIPT_FAILURE_MESSAGES[verdict.reason] };
  const payloadCheck = validateReceiptPayload((verdict.verified_envelope as { payload: unknown }).payload);
  if (!payloadCheck.ok) return { ok: false, reason: "malformed_payload", message: payloadCheck.message };
  const payload = payloadCheck.payload;
  if (input.expectation) {
    for (const [field, expected] of Object.entries(input.expectation)) {
      const actual = (payload as unknown as Record<string, unknown>)[field];
      if (expected !== actual) return { ok: false, reason: "binding_mismatch", message: `the receipt's ${field} does not match the envelope being applied` };
    }
  }
  return { ok: true, payload, receipt_hash: verdict.envelope_hash, key_status: verdict.key_status };
}

// --- discovery_receipt_status (nango-discovery-connector-v0 T-005) -----------

// The content-free online check receipt-verified local apply performs
// immediately before writing (R-007, RISK-012): is the receipt's grant still
// active at the service, and at which revocation epoch. The response carries
// no envelope, session, or provider field — receipt_status and
// revocation_epoch only.
export type DiscoveryReceiptStatusState = "active" | "revoked" | "unknown";
export type DiscoveryReceiptStatusResult = { receipt_status: DiscoveryReceiptStatusState; revocation_epoch: number };
export interface DiscoveryReceiptStatusEndpoint {
  receiptStatus(input: { receipt_hash: string; target_ref: DiscoveryTargetRef }): Promise<DiscoveryReceiptStatusResult>;
}

export class DiscoveryReceiptServiceUnreachableError extends Error {
  constructor() {
    super("the discovery service is unreachable; receipt status could not be verified");
    this.name = "DiscoveryReceiptServiceUnreachableError";
  }
}

// The V0 default endpoint: foo-mcp-server-v0 owns the transport and identity
// stack, so every status query fails closed until it exists — callers report
// needs_service_verification and write nothing.
export function createUnreachableDiscoveryReceiptStatus(): DiscoveryReceiptStatusEndpoint {
  return {
    receiptStatus: async () => {
      throw new DiscoveryReceiptServiceUnreachableError();
    },
  };
}

function validateReceiptPayload(value: unknown): { ok: true; payload: DiscoveryProcessingReceiptPayload } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "receipt payload must be an object" };
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!RECEIPT_PAYLOAD_KEYS.has(key)) return { ok: false, message: `receipt payload carries an unknown field: ${key}` };
  for (const key of RECEIPT_PAYLOAD_KEYS) if (!(key in raw)) return { ok: false, message: `receipt payload is missing ${key}` };
  if (raw.kind !== "discovery_processing_receipt" || raw.receipt_version !== "v1") return { ok: false, message: "receipt payload must be a v1 discovery_processing_receipt" };
  for (const key of ["subject_ref", "workspace_ref", "connection_ref", "target_ref", "target_id", "lane", "source_fingerprint", "approval_digest", "grant_digest", "envelope_hash", "attempt_id"] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) return { ok: false, message: `receipt payload ${key} must be a non-empty string` };
  }
  if (!CONNECTION_REF_SHAPE.test(raw.connection_ref as string)) return { ok: false, message: "receipt payload connection_ref must be an opaque conn: reference" };
  if (!TARGET_REF_SHAPE.test(raw.target_ref as string)) return { ok: false, message: "receipt payload target_ref must be an opaque dtarget: reference" };
  if (raw.lane !== "study" && raw.lane !== "inbox") return { ok: false, message: "receipt payload lane must be study or inbox" };
  if (!SHA256_DIGEST.test(raw.approval_digest as string)) return { ok: false, message: "receipt payload approval_digest must be sha256:<hex>" };
  if (!SHA256_DIGEST.test(raw.envelope_hash as string)) return { ok: false, message: "receipt payload envelope_hash must be sha256:<hex>" };
  if (typeof raw.revocation_epoch !== "number" || !Number.isInteger(raw.revocation_epoch) || raw.revocation_epoch < 0) return { ok: false, message: "receipt payload revocation_epoch must be a non-negative integer" };
  if (!ATTEMPT_ID.test(raw.attempt_id as string)) return { ok: false, message: "receipt payload attempt_id must be an opaque att: reference" };
  const processing = raw.processing as Record<string, unknown> | undefined;
  if (!processing || typeof processing !== "object" || Array.isArray(processing)) return { ok: false, message: "receipt payload processing must be an object" };
  for (const key of Object.keys(processing)) if (!RECEIPT_PROCESSING_KEYS.has(key)) return { ok: false, message: `receipt payload processing carries an unknown field: ${key}` };
  for (const key of RECEIPT_PROCESSING_KEYS) if (typeof processing[key] !== "string" || !(processing[key] as string).trim()) return { ok: false, message: `receipt payload processing.${key} must be a non-empty string` };
  const limits = raw.limits as Record<string, unknown> | undefined;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return { ok: false, message: "receipt payload limits must be an object" };
  for (const key of Object.keys(limits)) if (!RECEIPT_LIMITS_KEYS.has(key)) return { ok: false, message: `receipt payload limits carries an unknown field: ${key}` };
  for (const key of RECEIPT_LIMITS_KEYS) if (typeof limits[key] !== "number" || (limits[key] as number) <= 0) return { ok: false, message: `receipt payload limits.${key} must be a positive number` };
  return { ok: true, payload: raw as unknown as DiscoveryProcessingReceiptPayload };
}

// sha256 over the canonical serialization of the sanitized envelope — the
// binding the local apply re-computes before trusting the receipt (D-014).
export function discoveryEnvelopeDigest(envelope: DiscoveryEvidenceEnvelope): string {
  return `sha256:${createHash("sha256").update(canonicalJson(envelope as JsonValue), "utf8").digest("hex")}`;
}

export function discoveryGrantDigest(grant: DiscoveryServiceGrant): string {
  return `sha256:${createHash("sha256").update(canonicalJson(grant as JsonValue), "utf8").digest("hex")}`;
}

// --- The operation ------------------------------------------------------------

export type DiscoveryProcessSessionInput = {
  subject_ref: DiscoverySubjectRef;
  workspace_ref: string;
  connection_ref: DiscoveryConnectionRef;
  target_ref: DiscoveryTargetRef;
  session_ref: string;
  // The CURRENT local ledger state: the recheck compares the grant against
  // these, not against what the grant was minted with (R-008).
  approval_digest: string;
  revocation_epoch: number;
  // Optional idempotent re-presentation of a prior attempt id. A repeat in
  // any state returns result_lost without a provider call.
  attempt_id?: string;
};

export type DiscoveryProcessSessionResult = {
  schema_version: "0.1";
  operation: "discovery_process_session";
  status: DiscoveryServiceStatus;
  errors: DiscoveryServiceError[];
  handoff: DiscoveryHandoff | null;
  next_actions: string[];
  coverage: {
    provider_metadata_probes: number;
    transcript_body_calls: number;
    synthesis_requests: number;
    receipts_issued: number;
    raw_content_retained: false;
    attempt_id?: string;
    recorded_attempt_state?: DiscoveryAttemptState;
  };
  connection_ref?: DiscoveryConnectionRef;
  target_ref?: DiscoveryTargetRef;
  stable_url?: string;
  envelope?: DiscoveryEvidenceEnvelope;
  processing_receipt?: DiscoveryProcessingReceipt;
};

export type DiscoveryProcessDeps = {
  service: DiscoveryProcessingService;
  keys: DiscoveryServiceKeys;
  ledger: DiscoveryProcessingLedger;
  signer: DiscoveryReceiptSigner;
  source: DiscoveryTranscriptSource;
  processor: DiscoverySynthesisProcessor;
  delivery?: (result: DiscoveryProcessSessionResult) => Promise<DiscoveryProcessSessionResult>;
  now: string;
};

const RESULT_KEYS = new Set(["schema_version", "operation", "status", "errors", "handoff", "next_actions", "coverage", "connection_ref", "target_ref", "stable_url", "envelope", "processing_receipt"]);

function closedResult(result: DiscoveryProcessSessionResult): DiscoveryProcessSessionResult {
  for (const key of Object.keys(result)) {
    if (!RESULT_KEYS.has(key)) throw new Error(`discovery service result carries a field outside the closed contract: ${key}`);
  }
  return result;
}

type Coverage = DiscoveryProcessSessionResult["coverage"];

function coverage(counts: { metadata: number; body: number; synthesis: number; receipts: number }, extras: { attempt_id?: string; recorded_attempt_state?: DiscoveryAttemptState } = {}): Coverage {
  return {
    provider_metadata_probes: counts.metadata,
    transcript_body_calls: counts.body,
    synthesis_requests: counts.synthesis,
    receipts_issued: counts.receipts,
    raw_content_retained: false,
    ...(extras.attempt_id ? { attempt_id: extras.attempt_id } : {}),
    ...(extras.recorded_attempt_state ? { recorded_attempt_state: extras.recorded_attempt_state } : {}),
  };
}

function failureOf(code: DiscoveryServiceFailureCode, message: string, trace_id: string): DiscoveryServiceError[] {
  return [{ code, message, trace_id }];
}

function withTimeout<T>(promise: Promise<T>, timeout_ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DiscoveryTranscriptTimeoutError(timeout_ms)), timeout_ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function processDiscoverySession(input: DiscoveryProcessSessionInput, deps: DiscoveryProcessDeps): Promise<DiscoveryProcessSessionResult> {
  const counts = { metadata: 0, body: 0, synthesis: 0, receipts: 0 };
  const trace = `tr:${randomBytes(8).toString("hex")}`;
  const attempt_id = input.attempt_id ?? `att:${randomBytes(16).toString("hex")}`;
  const common = { connection_ref: input.connection_ref, target_ref: input.target_ref };
  const base: Coverage = coverage(counts, { attempt_id });

  const shapeFailure = (
    message: string,
    code: DiscoveryServiceFailureCode = "service_bug",
    status: DiscoveryProcessSessionResult["status"] = "invalid",
    recorded: { attempt_id: string; recorded_attempt_state: DiscoveryAttemptState } | undefined = undefined,
  ): DiscoveryProcessSessionResult =>
    closedResult({
      schema_version: "0.1",
      operation: "discovery_process_session",
      status,
      errors: failureOf(code, message, trace),
      handoff: null,
      next_actions: [],
      coverage: recorded ? coverage(counts, recorded) : base,
      ...common,
    });

  // 1. Shape gate — malformed requests cost zero provider calls and zero
  // ledger rows.
  if (!input.subject_ref?.trim()) return shapeFailure("subject_ref is required");
  if (!input.workspace_ref?.trim()) return shapeFailure("workspace_ref is required");
  if (!CONNECTION_REF_SHAPE.test(input.connection_ref ?? "")) return shapeFailure("connection_ref must be an opaque conn: reference");
  if (!TARGET_REF_SHAPE.test(input.target_ref ?? "")) return shapeFailure("target_ref must be an opaque dtarget: reference");
  if (!ATTEMPT_ID.test(attempt_id)) return shapeFailure("attempt_id must be an opaque att: reference");

  // 2. Connection gate. Unreachability is never dressed up as a state.
  let connection: DiscoveryHostedConnection;
  try {
    connection = await deps.service.connectionState({ subject_ref: input.subject_ref, connection_ref: input.connection_ref });
  } catch {
    return closedResult({
      ...shapeFailure("the discovery service is unreachable; hosted state is unchanged", "network"),
      status: "needs_service_verification",
    });
  }
  if (connection.state === "revoked") return shapeFailure("the connection has been revoked", "access_denied");
  if (connection.state === "auth_expired") return shapeFailure("the connection's credentials have expired; reconnect the provider", "auth_expired");
  if (connection.state === "not_connected") return shapeFailure("the connection is not established for this subject", "not_connected");
  if (!connection.canonical_connection_key.trim()) return shapeFailure("the connected connection carries no canonical key");

  // 3. Session-reference gate: open, then bind every identity the ref claims.
  const opened = openDiscoverySessionRef(input.session_ref, deps.keys.session_ref_key, deps.now);
  if (!opened.ok) return shapeFailure(`the session reference could not be opened (${opened.reason})`, "access_denied");
  const ref: DiscoverySessionRefPayload = opened.payload;
  if (ref.subject_ref !== input.subject_ref) return shapeFailure("the session reference belongs to a different subject", "access_denied");
  if (ref.target_ref !== input.target_ref) return shapeFailure("the session reference does not belong to this target", "access_denied");
  if (ref.provider !== deps.source.provider) return shapeFailure("the session reference cannot be processed through this provider source", "access_denied");
  if (input.revocation_epoch > ref.revocation_epoch) {
    return closedResult({
      ...shapeFailure("the session reference predates a local revocation", "approval_missing"),
      status: "revoked",
      next_actions: ["Re-approve the source and re-register the target if hosted reads are wanted again."],
    });
  }
  if (input.revocation_epoch < ref.revocation_epoch) return shapeFailure("the session reference carries a revocation epoch from another ledger", "access_denied");
  if (ref.canonical_connection_key !== connection.canonical_connection_key) {
    return shapeFailure("the session reference does not belong to this connection", "access_denied");
  }
  const recomputedFingerprint = hostedDiscoverySourceFingerprint(
    { subject_ref: ref.subject_ref, provider: ref.provider, canonical_connection_key: ref.canonical_connection_key, provider_session_identity: ref.provider_session_identity },
    deps.keys.source_fingerprint_key,
  );
  if (recomputedFingerprint !== ref.hosted_source_fingerprint) return shapeFailure("the session reference failed source-identity verification", "access_denied");

  // 4. Grant lookup + boundary recheck (R-008): subject, workspace, target,
  // lane, connection, CURRENT approval digest and revocation epoch, expiry,
  // and budget — first mismatch wins, all before any provider call.
  let lookup: DiscoveryGrantLookup;
  try {
    lookup = await deps.service.grantForTarget({ subject_ref: input.subject_ref, target_ref: input.target_ref });
  } catch {
    return closedResult({
      ...shapeFailure("the discovery service is unreachable; hosted state is unchanged", "network"),
      status: "needs_service_verification",
    });
  }
  const expected: DiscoveryBoundaryExpectation = {
    subject_ref: input.subject_ref,
    connection_ref: input.connection_ref,
    workspace_ref: input.workspace_ref,
    target_id: lookup.grant?.target_id ?? "",
    lane: lookup.grant?.lane ?? "study",
    approval_digest: input.approval_digest,
    revocation_epoch: input.revocation_epoch,
  };
  const boundary = recheckDiscoveryAccessBoundary({ grant: lookup.grant, expected, operations_used: lookup.operations_used, now: deps.now });
  if (!boundary.ok) {
    const mapped = boundaryFailureFor(boundary.reason);
    return closedResult({
      ...shapeFailure(mapped.message, mapped.code),
      status: mapped.status,
      next_actions: [mapped.resume],
    });
  }
  const grant = lookup.grant as DiscoveryServiceGrant;
  if (ref.grant_digest !== grant.approval_digest) {
    return closedResult({
      ...shapeFailure("the session reference was not minted under the target's current grant", "approval_missing"),
      status: "needs_service_grant",
      next_actions: ["List the source again under the confirmed target to mint a fresh session reference."],
    });
  }

  // 5. Study-hypothesis gate. Study-linked synthesis must bind every finding
  // to a pre-existing hypothesis; without them the operation refuses before
  // spending the fetch.
  const evidenceLane: DiscoveryEvidenceLane = grant.lane === "study" ? "study_linked" : "unassigned_call_evidence";
  let hypotheses: Array<{ id: string; text: string }> = [];
  if (grant.lane === "study") {
    hypotheses = await deps.service.studyHypotheses({ subject_ref: input.subject_ref, target_ref: input.target_ref });
    if (hypotheses.length === 0) return shapeFailure("the study target has no recorded hypotheses; study-linked synthesis cannot bind findings", "service_bug");
  }

  // 6. Pre-fetch recheck (revocation may have landed between the grant lookup
  // and now), then the at-most-once claim, then the budget spend. A repeat
  // claim returns result_lost with the recorded state and zero provider calls.
  const preFetch = recheckDiscoveryAccessBoundary({ grant: lookup.grant, expected, operations_used: lookup.operations_used, now: deps.now });
  if (!preFetch.ok) {
    const mapped = boundaryFailureFor(preFetch.reason);
    return closedResult({
      ...shapeFailure(mapped.message, mapped.code),
      status: mapped.status,
      next_actions: [mapped.resume],
    });
  }
  const claim = deps.ledger.beginAttempt({
    subject_ref: input.subject_ref,
    target_ref: input.target_ref,
    source_fingerprint: ref.hosted_source_fingerprint,
    processing_version: PROCESSING_VERSION,
    attempt_id,
  });
  if (!claim.accepted) {
    return closedResult({
      ...shapeFailure(`this source was already processed in attempt ${claim.existing_state === "receipt_issued" ? "and its receipt was issued" : "whose result was not delivered"}; productfoo never re-runs a claimed attempt or recovers a lost result`, "network"),
      status: "result_lost",
      coverage: coverage(counts, { attempt_id, recorded_attempt_state: claim.existing_state }),
    });
  }
  deps.service.recordOperation(input.target_ref);

  // 7. Capability probe — a metadata observation, never a body call.
  counts.metadata += 1;
  const observed = await deps.source.observeConnection({ subject_ref: input.subject_ref, connection_ref: input.connection_ref });
  if (observed.state !== "connected") {
    deps.ledger.finishAttempt(attempt_id, "lost");
    const status: DiscoveryServiceStatus = observed.state === "revoked" ? "revoked" : observed.state === "auth_expired" ? "auth_expired" : "not_connected";
    return closedResult({
      ...shapeFailure(`the connection is no longer connected for processing (${observed.state})`, "access_denied", "invalid", { attempt_id, recorded_attempt_state: "lost" }),
      status,
    });
  }
  if (!observed.capabilities.open_transcript) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return closedResult({
      ...shapeFailure("the connection's observed capabilities do not include transcript access", "capability_missing", "needs_provider_access", { attempt_id, recorded_attempt_state: "lost" }),
      status: "needs_provider_access",
      next_actions: ["Connect a provider plan that includes transcript access, then retry."],
    });
  }

  // 8. THE one transcript fetch — the operation's only body call, behind the
  // guarded boundary, with the versioned ceilings enforced in-band.
  counts.body += 1;
  let fetched: DiscoveryTranscriptFetch;
  try {
    fetched = await withTimeout(
      guardedDiscoveryAccess(preFetch, () =>
        deps.source.fetchTranscript({
          subject_ref: input.subject_ref,
          provider_session_identity: ref.provider_session_identity,
          limits: DISCOVERY_PROCESSING_LIMITS,
        }),
      ),
      DISCOVERY_PROCESSING_LIMITS.fetch_timeout_ms,
    );
  } catch (error) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    if (error instanceof DiscoveryTranscriptOversizeError) return shapeFailure("the transcript response exceeded the policy ceiling; nothing was retained", "provider_failure", "transcript_too_large", { attempt_id, recorded_attempt_state: "lost" });
    if (error instanceof DiscoveryTranscriptTimeoutError) return shapeFailure("the transcript fetch exceeded the policy ceiling; nothing was retained", "provider_failure", "provider_timeout", { attempt_id, recorded_attempt_state: "lost" });
    if (error instanceof DiscoveryTranscriptCancelledError) return shapeFailure("the transcript fetch was cancelled before completion; nothing was retained", "provider_failure", "invalid", { attempt_id, recorded_attempt_state: "lost" });
    return shapeFailure("the transcript fetch failed; nothing was retained", "provider_failure", "invalid", { attempt_id, recorded_attempt_state: "lost" });
  }
  // Ceiling re-verification before synthesis or release — the module enforces
  // the policy itself, independent of what the seam reports.
  if (Buffer.byteLength(fetched.transcript_text, "utf8") > DISCOVERY_PROCESSING_LIMITS.max_response_bytes) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure("the transcript response exceeded the policy ceiling; nothing was retained", "provider_failure", "transcript_too_large", { attempt_id, recorded_attempt_state: "lost" });
  }
  const estimatedTokens = Math.ceil(fetched.transcript_text.length / 4);
  if (estimatedTokens > DISCOVERY_PROCESSING_LIMITS.max_model_input_tokens) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure("the transcript exceeds the model-input-token ceiling; nothing was retained", "provider_failure", "transcript_too_large", { attempt_id, recorded_attempt_state: "lost" });
  }
  if (!Number.isFinite(Date.parse(fetched.completed_at))) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure("the transcript fetch reported an unusable completion time", "service_bug");
  }

  // 9. Untrusted-text synthesis behind the isolated processor seam.
  let stableUrl: string | undefined;
  const caveats: string[] = [];
  if (fetched.stable_url !== undefined) {
    try {
      stableUrl = sanitizeDiscoveryStableUrl(deps.source.provider, fetched.stable_url);
    } catch {
      stableUrl = undefined;
      caveats.push("The provider's stable link failed sanitization and was not attached.");
    }
  }
  const locatorCapability = observed.capabilities.timestamps ? ("timestamp" as const) : ("none" as const);
  if (!stableUrl) caveats.push(NO_STABLE_LINK_CAVEAT);
  if (locatorCapability === "none") caveats.push(NO_TIMESTAMPS_CAVEAT);
  const synthesisInput: SynthesisInput = {
    target_id: grant.target_id,
    lane: evidenceLane,
    source: {
      provider: ref.provider,
      ...(stableUrl ? { stable_url: stableUrl } : {}),
      source_fingerprint: ref.hosted_source_fingerprint,
      completed_at: fetched.completed_at,
      locator_capability: locatorCapability,
    },
    title: "",
    hypotheses,
    transcript_text: fetched.transcript_text,
    transcript_complete: fetched.transcript_complete,
    caveats,
  };
  counts.synthesis += 1;
  let rawOutput: string;
  try {
    rawOutput = (await deps.processor.process({ system: SYNTHESIS_SYSTEM_PROMPT, prompt: synthesisUserMessage(synthesisInput), max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS })).raw_output;
  } catch {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure(UNTRUSTED_FAILURE, "service_bug", "invalid", { attempt_id, recorded_attempt_state: "lost" });
  }

  // 10. Raw disposal + deterministic reduction and screening. The transcript
  // and the raw processor output are dropped here; nothing downstream of this
  // block ever sees them.
  let envelope: DiscoveryEvidenceEnvelope;
  let parsed: Record<string, unknown>;
  try {
    parsed = extractSynthesisJsonObject(rawOutput);
  } catch {
    // JSON.parse errors can quote input fragments — the fixed message keeps
    // them off the result surface.
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure(UNPARSEABLE_FAILURE, "service_bug", "invalid", { attempt_id, recorded_attempt_state: "lost" });
  }
  try {
    const context: EvidenceContext = { expected_study_id: grant.target_id, expected_lane: evidenceLane };
    envelope = screenDiscoveryServiceEnvelope(constructEnvelopeFromSynthesis(synthesisInput, parsed), context);
  } catch (error) {
    // Reduction and screening failures are fixed-vocabulary messages (no
    // content) — safe to surface verbatim.
    deps.ledger.finishAttempt(attempt_id, "lost");
    return shapeFailure(`${SCREEN_FAILURE}: ${(error as Error).message}`, "service_bug", "invalid", { attempt_id, recorded_attempt_state: "lost" });
  }
  fetched = null as never;
  rawOutput = "";

  // 11. Post-screen recheck: authorization must still hold at release time.
  let postLookup: DiscoveryGrantLookup;
  try {
    postLookup = await deps.service.grantForTarget({ subject_ref: input.subject_ref, target_ref: input.target_ref });
  } catch {
    deps.ledger.finishAttempt(attempt_id, "lost");
    return closedResult({
      ...shapeFailure("the discovery service is unreachable; hosted state is unchanged", "network"),
      status: "needs_service_verification",
      coverage: coverage(counts, { attempt_id, recorded_attempt_state: "lost" }),
    });
  }
  const postCheck = recheckDiscoveryAccessBoundary({ grant: postLookup.grant, expected, operations_used: Math.max(postLookup.operations_used - 1, 0), now: deps.now });
  if (!postCheck.ok) {
    deps.ledger.finishAttempt(attempt_id, "lost");
    const mapped = boundaryFailureFor(postCheck.reason);
    return closedResult({
      ...shapeFailure(mapped.message, mapped.code, "invalid", { attempt_id, recorded_attempt_state: "lost" }),
      status: mapped.status,
      next_actions: [mapped.resume],
    });
  }

  // 12. Signed payload-free receipt + at-most-once finish.
  counts.receipts += 1;
  const issuedAt = new Date(deps.now).toISOString();
  const receipt = deps.signer.signReceipt({
    payload: {
      kind: "discovery_processing_receipt",
      receipt_version: RECEIPT_VERSION,
      subject_ref: input.subject_ref,
      workspace_ref: input.workspace_ref,
      connection_ref: input.connection_ref,
      target_ref: input.target_ref,
      target_id: grant.target_id,
      lane: grant.lane,
      source_fingerprint: ref.hosted_source_fingerprint,
      approval_digest: input.approval_digest,
      grant_digest: ref.grant_digest,
      revocation_epoch: input.revocation_epoch,
      envelope_hash: discoveryEnvelopeDigest(envelope),
      attempt_id,
      processing: {
        processing_version: PROCESSING_VERSION,
        prompt_version: PROMPT_VERSION,
        policy_version: DISCOVERY_SERVICE_POLICY.policy_version,
        synthesizer_model: deps.processor.synthesizer_model,
        envelope_schema_version: "0.1",
      },
      limits: { ...DISCOVERY_PROCESSING_LIMITS },
    },
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(deps.now) + RECEIPT_TTL_MS).toISOString(),
  });
  deps.ledger.finishAttempt(attempt_id, "receipt_issued");
  const success: DiscoveryProcessSessionResult = closedResult({
    schema_version: "0.1",
    operation: "discovery_process_session",
    status: "processed",
    errors: [],
    handoff: null,
    next_actions: ["Review the evidence and apply it in the local productfoo workspace; the receipt verifies at apply time."],
    coverage: coverage(counts, { attempt_id, recorded_attempt_state: "receipt_issued" }),
    ...common,
    ...(stableUrl ? { stable_url: stableUrl } : {}),
    envelope,
    processing_receipt: receipt,
  });

  // 13. Delivery seam: a lost success response is reported result_lost and
  // never recovered (D-013) — the receipt stays issued in the ledger, and no
  // envelope rides the loss.
  if (deps.delivery) {
    try {
      return await deps.delivery(success);
    } catch {
      return closedResult({
        schema_version: "0.1",
        operation: "discovery_process_session",
        status: "result_lost",
        errors: failureOf("network", "the processing result could not be delivered; productfoo never re-runs a claimed attempt or recovers a lost result", trace),
        handoff: null,
        next_actions: [],
        coverage: coverage(counts, { attempt_id, recorded_attempt_state: "receipt_issued" }),
        ...common,
      });
    }
  }
  return success;
}
