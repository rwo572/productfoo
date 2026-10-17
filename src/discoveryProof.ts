import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { approvalStates, sourceKey, notionScopeAllowsSelection } from "./sourceIngress.js";
import { sourceFingerprint } from "./discoveryMatching.js";
import { loadDiscoveryRun, type DiscoveryLifecycle } from "./discoveryArtifacts.js";
import type { DiscoverySession } from "./discoverySources.js";
import {
  discoveryEnvelopeDigest,
  verifyDiscoveryProcessingReceipt,
  type DiscoveryProcessingReceipt,
  type DiscoveryReceiptExpectation,
} from "./discoveryProcess.js";
import { loadDiscoveryRegisteredTargets, type DiscoveryRegisteredTarget } from "./discoveryConnections.js";
import {
  HOSTED_SOURCE_FINGERPRINT,
  validateDiscoveryEvidence,
  type DiscoveryEvidenceEnvelope,
  type EvidenceContext,
} from "./discoveryEvidence.js";
import type { TrustStore, TrustedSigningKey } from "./trustEnvelope.js";

export type DiscoveryProofStatus =
  | "ready_to_synthesize"
  | "awaiting_match"
  | "ambiguous_match"
  | "needs_source_approval"
  | "needs_provider_access"
  | "needs_provider_connector"
  | "needs_research_proof"
  | "invalid";

export type AuthorizationInput = {
  study_dir: string;
  local_root: string;
  study_id: string;
  study_state: DiscoveryLifecycle;
  match_status: "none" | "unique" | "ambiguous";
  session: DiscoverySession;
  now: string;
};

export type AuthorizationResult = {
  status: DiscoveryProofStatus;
  source_fingerprint: string;
  proof_ref?: string;
  handoff?: string;
};

type ProofReceipt = {
  schema_version: "0.1";
  kind: "discovery_research_proof";
  study_id: string;
  provider: string;
  connection_alias: string;
  source_fingerprint: string;
  approval_digest: string;
  issued_at: string;
  expires_at: string;
  phase: "ready" | "opened";
  opened_at?: string;
  capabilities: { open_transcript: true; stable_link: boolean; timestamps: boolean };
};

function safeDiscoveryTarget(targetId: string): string {
  if (/^study_[a-z0-9_]+$/.test(targetId)) return targetId;
  if (/^inbox:[a-z0-9_]+$/.test(targetId)) return targetId.replace(":", "_");
  if (/^docs_[a-z0-9_]+$/.test(targetId)) return targetId;
  throw new Error("invalid discovery target id");
}

function receiptPath(localRoot: string, studyId: string): string {
  return path.join(path.resolve(localRoot), safeDiscoveryTarget(studyId), "proof.json");
}

function approvalDigest(studyDir: string): string {
  const events = path.join(studyDir, "events.jsonl");
  const text = existsSync(events)
    ? readFileSync(events, "utf8").split("\n").filter((line) => /com\.adaptivespec\.source\.(?:approved|revoked)/.test(line)).join("\n")
    : "";
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// Exported for the docs evidence class (notion-discovery-connector-v0 T-004):
// the same approval-ledger digest, bound into an approved-source proof so the
// one content read is pinned to the exact ledger the approval lives in.
export const approvalLedgerDigest = approvalDigest;

function scopeAllowsStudy(scope: string | undefined, studyId: string): boolean {
  const value = (scope ?? "").trim();
  if (studyId.startsWith("inbox:")) {
    const scopeId = studyId.slice("inbox:".length);
    return value === "*" || value === scopeId || value === `scope:${scopeId}`;
  }
  return value === "*" || value === studyId || value === `study:${studyId}`;
}

function currentApproval(input: Pick<AuthorizationInput, "study_dir" | "study_id" | "session">): { ok: boolean; digest: string } {
  const state = approvalStates(input.study_dir).get(sourceKey({ provider: input.session.provider, connection_id: input.session.connection_alias }));
  // Approvals accumulate per scope (#528): ANY approved scope on the connection
  // may authorize this study/inbox target — one connection, many bounded scopes.
  const ok = state?.state === "approved" && state.scopes.some((scope) => scopeAllowsStudy(scope, input.study_id));
  return { ok, digest: approvalDigest(input.study_dir) };
}

function sourceWasRevoked(studyDir: string, fingerprint: string): boolean {
  const events = path.join(studyDir, "events.jsonl");
  if (!existsSync(events)) return false;
  for (const line of readFileSync(events, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { source_fingerprint?: string } };
      if (event.type === "com.adaptivespec.discovery.source_revoked" && event.data?.source_fingerprint === fingerprint) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function mintDiscoveryProof(localRoot: string, input: {
  study_id: string;
  session: DiscoverySession;
  approval_digest: string;
  now: string;
}): ProofReceipt {
  if (!input.approval_digest.startsWith("sha256:")) throw new Error("discovery proof requires source approval");
  if (!input.session.capabilities.open_transcript || input.session.access !== "available") throw new Error("discovery proof requires transcript capability and access");
  const issued = new Date(input.now);
  if (!Number.isFinite(issued.getTime())) throw new Error("discovery proof requires a valid timestamp");
  const receipt: ProofReceipt = {
    schema_version: "0.1",
    kind: "discovery_research_proof",
    study_id: input.study_id,
    provider: input.session.provider,
    connection_alias: input.session.connection_alias,
    source_fingerprint: sourceFingerprint(input.session),
    approval_digest: input.approval_digest,
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + 10 * 60_000).toISOString(),
    phase: "ready",
    capabilities: {
      open_transcript: true,
      stable_link: input.session.capabilities.stable_link,
      timestamps: input.session.capabilities.timestamps,
    },
  };
  const file = receiptPath(localRoot, input.study_id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

export function authorizeDiscoverySource(input: AuthorizationInput): AuthorizationResult {
  const fingerprint = sourceFingerprint(input.session);
  if (input.study_state === "revoked") return { status: "invalid", source_fingerprint: fingerprint, handoff: "This study is revoked; future ingestion is blocked." };
  if (sourceWasRevoked(input.study_dir, fingerprint)) return { status: "invalid", source_fingerprint: fingerprint, handoff: "This source was revoked; future ingestion is blocked." };
  if (input.match_status === "none") return { status: "awaiting_match", source_fingerprint: fingerprint };
  if (input.match_status === "ambiguous") return { status: "ambiguous_match", source_fingerprint: fingerprint, handoff: "Select one source before transcript access." };
  if (!input.session.capabilities.list_sessions || !input.session.capabilities.open_transcript) {
    return { status: "needs_provider_connector", source_fingerprint: fingerprint, handoff: "The provider connector cannot open transcripts." };
  }
  if (input.session.access !== "available") {
    return { status: "needs_provider_access", source_fingerprint: fingerprint, handoff: input.session.stable_url ? `Request full transcript access from ${input.session.stable_url}` : "Request full transcript access from the provider." };
  }
  const approval = currentApproval(input);
  if (!approval.ok) {
    const approvalScope = input.study_id.startsWith("inbox:")
      ? `scope:${input.study_id.slice("inbox:".length)}`
      : `study:${input.study_id}`;
    return {
      status: "needs_source_approval",
      source_fingerprint: fingerprint,
      handoff: `foo source approve ${path.relative(process.cwd(), input.study_dir) || input.study_dir} --provider ${input.session.provider} --connection ${input.session.connection_alias} --scope ${approvalScope} --by <person>`,
    };
  }
  try {
    mintDiscoveryProof(input.local_root, { study_id: input.study_id, session: input.session, approval_digest: approval.digest, now: input.now });
  } catch {
    return { status: "needs_research_proof", source_fingerprint: fingerprint, handoff: "productfoo could not establish the discovery proof; no transcript was opened." };
  }
  return { status: "ready_to_synthesize", source_fingerprint: fingerprint, proof_ref: receiptPath(input.local_root, input.study_id) };
}

function readReceipt(localRoot: string, studyId: string): ProofReceipt {
  const file = receiptPath(localRoot, studyId);
  if (!existsSync(file)) throw new Error("authorized discovery proof is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("authorized discovery proof is invalid");
  }
  const receipt = parsed as Partial<ProofReceipt>;
  if (receipt.schema_version !== "0.1" || receipt.kind !== "discovery_research_proof" || receipt.study_id !== studyId) throw new Error("authorized discovery proof is invalid");
  return receipt as ProofReceipt;
}

export function assertOpenedDiscoveryProof(localRoot: string, studyId: string, fingerprint: string, now: string): void {
  const receipt = readReceipt(localRoot, studyId);
  if (receipt.phase !== "opened") throw new Error("discovery research proof has not opened the selected source");
  if (receipt.source_fingerprint !== fingerprint) throw new Error("opened discovery proof does not match the evidence source");
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) > Date.parse(receipt.expires_at)) throw new Error("opened discovery proof expired");
}

function readyReceipt(input: { study_dir: string; local_root: string; study_id: string; source_fingerprint: string; now: string }): ProofReceipt {
  const receipt = readReceipt(input.local_root, input.study_id);
  if (receipt.phase !== "ready") throw new Error("authorized discovery proof was already opened");
  if (receipt.source_fingerprint !== input.source_fingerprint) throw new Error("authorized discovery proof does not match the selected source");
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || now > Date.parse(receipt.expires_at)) throw new Error("authorized discovery proof expired");
  const state = approvalStates(input.study_dir).get(sourceKey({ provider: receipt.provider, connection_id: receipt.connection_alias }));
  // Same accumulated-scope check as authorization (#528): any approved scope
  // that admits this target keeps the proof valid; the digest still pins the
  // exact approval ledger the proof was minted against.
  if (state?.state !== "approved" || !state.scopes.some((scope) => scopeAllowsStudy(scope, input.study_id)) || approvalDigest(input.study_dir) !== receipt.approval_digest) {
    throw new Error("authorized discovery proof no longer matches source approval");
  }
  return receipt;
}

export function markDiscoveryProofOpened(input: { study_dir: string; local_root: string; study_id: string; source_fingerprint: string; now: string }): void {
  const receipt = readyReceipt(input);
  const opened: ProofReceipt = { ...receipt, phase: "opened", opened_at: new Date(input.now).toISOString() };
  writeFileSync(receiptPath(input.local_root, input.study_id), `${JSON.stringify(opened, null, 2)}\n`, { mode: 0o600 });
}

export async function openAuthorizedTranscript<T>(input: {
  study_dir: string;
  local_root: string;
  study_id: string;
  source_fingerprint: string;
  now: string;
}, open: () => Promise<T>): Promise<T> {
  readyReceipt(input);
  try {
    const value = await open();
    markDiscoveryProofOpened(input);
    return value;
  } catch {
    rmSync(receiptPath(input.local_root, input.study_id), { force: true });
    throw new Error("provider transcript access failed; no source content was retained");
  }
}

// --- Approved-source proof (docs evidence class, notion-discovery-connector-v0 T-004) ---
//
// Documents are not sessions: the same one-time proof boundary — ten minutes,
// single open, purge on failure, zero residue — but bound to an explicitly
// selected page or database from an approved connection scope instead of a
// session id. The receipt carries hashes and ids only, never content, so a
// leftover receipt is metadata, not leakage.

export type ApprovedSourceProofReceipt = {
  schema_version: "0.1";
  kind: "approved_source_proof";
  target_id: string;
  provider: string;
  connection_alias: string;
  selection_fingerprint: string;
  approval_digest: string;
  issued_at: string;
  expires_at: string;
  phase: "ready" | "opened";
  opened_at?: string;
};

function readSourceReceipt(localRoot: string, targetId: string): ApprovedSourceProofReceipt {
  const file = receiptPath(localRoot, targetId);
  if (!existsSync(file)) throw new Error("authorized source proof is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("authorized source proof is invalid");
  }
  const receipt = parsed as Partial<ApprovedSourceProofReceipt>;
  if (receipt.schema_version !== "0.1" || receipt.kind !== "approved_source_proof" || receipt.target_id !== targetId) throw new Error("authorized source proof is invalid");
  return receipt as ApprovedSourceProofReceipt;
}

// Same accumulated-scope check as authorization (#528), through the docs
// boundary: an admitted selection is one the stored approved scope explicitly
// names — never a wildcard, never a crawler listing.
function currentDocsApproval(input: { packet_dir: string; provider: string; connection_alias: string; selection: { page_id?: string; database_id?: string } }): { ok: boolean; digest: string } {
  const state = approvalStates(input.packet_dir).get(sourceKey({ provider: input.provider, connection_id: input.connection_alias }));
  const ok = state?.state === "approved" && state.scopes.some((scope) => notionScopeAllowsSelection(scope, input.selection));
  return { ok, digest: approvalDigest(input.packet_dir) };
}

export function mintApprovedSourceProof(localRoot: string, input: {
  target_id: string;
  provider: string;
  connection_alias: string;
  selection_fingerprint: string;
  approval_digest: string;
  now: string;
}): ApprovedSourceProofReceipt {
  if (!input.approval_digest.startsWith("sha256:")) throw new Error("approved-source proof requires source approval");
  if (!input.selection_fingerprint.startsWith("sha256:")) throw new Error("approved-source proof requires a selection fingerprint");
  const issued = new Date(input.now);
  if (!Number.isFinite(issued.getTime())) throw new Error("approved-source proof requires a valid timestamp");
  const receipt: ApprovedSourceProofReceipt = {
    schema_version: "0.1",
    kind: "approved_source_proof",
    target_id: input.target_id,
    provider: input.provider,
    connection_alias: input.connection_alias,
    selection_fingerprint: input.selection_fingerprint,
    approval_digest: input.approval_digest,
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + 10 * 60_000).toISOString(),
    phase: "ready",
  };
  const file = receiptPath(localRoot, input.target_id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

function readySourceReceipt(input: { packet_dir: string; local_root: string; target_id: string; selection_fingerprint: string; selection: { page_id?: string; database_id?: string }; now: string }): ApprovedSourceProofReceipt {
  const receipt = readSourceReceipt(input.local_root, input.target_id);
  if (receipt.phase !== "ready") throw new Error("authorized source proof was already opened");
  if (receipt.selection_fingerprint !== input.selection_fingerprint) throw new Error("authorized source proof does not match the selected source");
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || now > Date.parse(receipt.expires_at)) throw new Error("authorized source proof expired");
  const approval = currentDocsApproval({ packet_dir: input.packet_dir, provider: receipt.provider, connection_alias: receipt.connection_alias, selection: input.selection });
  if (!approval.ok || approval.digest !== receipt.approval_digest) throw new Error("authorized source proof no longer matches source approval");
  return receipt;
}

/**
 * The single authorized open of an approved source's content (R-005): the
 * receipt must be ready and inside its ten-minute window, and the packet's
 * approval ledger must still admit this exact selection at the moment of the
 * read — a revocation between mint and open invalidates the proof. On any
 * failure the receipt is purged and the error is replaced by a bounded
 * message, so neither content nor provider errors survive the boundary.
 */
export async function openApprovedSourceContent<T>(input: { packet_dir: string; local_root: string; target_id: string; selection_fingerprint: string; selection: { page_id?: string; database_id?: string }; now: string }, open: () => Promise<T>): Promise<T> {
  readySourceReceipt(input);
  try {
    const value = await open();
    const receipt = readSourceReceipt(input.local_root, input.target_id);
    writeFileSync(receiptPath(input.local_root, input.target_id), `${JSON.stringify({ ...receipt, phase: "opened", opened_at: new Date(input.now).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return value;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("source approval") || error.message.includes("already opened") || error.message.includes("expired") || error.message.includes("invalid"))) throw error;
    // Typed runtime errors (byte ceilings, auth, rate limits) carry bounded,
    // content-free messages — re-throw them so callers can classify; only
    // untyped failures are replaced by the bounded boundary message.
    if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
      rmSync(receiptPath(input.local_root, input.target_id), { force: true });
      throw error;
    }
    rmSync(receiptPath(input.local_root, input.target_id), { force: true });
    throw new Error("provider content access failed; no source content was retained");
  }
}

// Single-use close-out: once the summary is recorded the proof is consumed so
// no receipt lingers (zero residue).
//
// Consumption must be atomic under concurrent local invocation (audit F12):
// rmSync alone cannot tell two consumers apart — both succeed and the one-time
// proof is used twice. The claim is an exclusive rename: exactly one
// concurrent consumer can move the receipt; every loser finds it gone and
// fails instead of re-consuming. A consumer that crashes between claim and
// delete leaves only a .consuming copy — receipt metadata, never content.
function consumeReceiptFile(file: string, missing: string): void {
  const claimed = `${file}.consuming-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(file, claimed);
  } catch {
    throw new Error(missing);
  }
  rmSync(claimed, { force: true });
}

// Single-use close-out (docs boundary): once the summary is recorded the proof
// is consumed so no receipt lingers (zero residue).
export function consumeApprovedSourceProof(localRoot: string, targetId: string, fingerprint: string, now: string): void {
  const receipt = readSourceReceipt(localRoot, targetId);
  if (receipt.phase !== "opened") throw new Error("approved-source proof has not opened the selected source");
  if (receipt.selection_fingerprint !== fingerprint) throw new Error("opened source proof does not match the evidence source");
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) > Date.parse(receipt.expires_at)) throw new Error("opened source proof expired");
  consumeReceiptFile(receiptPath(localRoot, targetId), "authorized source proof is missing");
  try { rmSync(path.dirname(receiptPath(localRoot, targetId)), { recursive: false }); } catch { /* other minimum local state may remain */ }
}

export function consumeDiscoveryProof(localRoot: string, studyId: string, fingerprint: string, now: string): void {
  assertOpenedDiscoveryProof(localRoot, studyId, fingerprint, now);
  consumeReceiptFile(receiptPath(localRoot, studyId), "authorized discovery proof is missing");
  const dir = path.dirname(receiptPath(localRoot, studyId));
  try { rmSync(dir, { recursive: false }); } catch { /* other minimum local state may remain */ }
}

export function purgeDiscoveryLocalState(localRoot: string, studyId: string): { removed: boolean; path: string } {
  const target = path.join(path.resolve(localRoot), safeDiscoveryTarget(studyId));
  const removed = existsSync(target);
  if (removed) rmSync(target, { recursive: true, force: true });
  return { removed, path: target };
}

export function purgeDiscoveryLocalFingerprint(localRoot: string, fingerprint: string): string[] {
  const root = path.resolve(localRoot);
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const files = ["match.json", "proof.json"].map((name) => path.join(dir, name)).filter(existsSync);
    if (!files.some((file) => readFileSync(file, "utf8").includes(fingerprint))) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

export type DiscoveryRetentionResult = {
  removed: string[];
  retained: string[];
  failures: string[];
};

export function purgeDiscoveryRetention(root: string, now: string, retentionDays = 30): DiscoveryRetentionResult {
  const resolvedRoot = path.resolve(root);
  const discoveryRoot = path.join(resolvedRoot, "discovery");
  const localRoot = path.join(resolvedRoot, ".foo", "discovery");
  const removed: string[] = [];
  const retained: string[] = [];
  const failures: string[] = [];
  const current = Date.parse(now);
  if (!Number.isFinite(current) || !Number.isFinite(retentionDays) || retentionDays < 0) {
    return { removed, retained, failures: ["retention requires a valid timestamp and non-negative day count"] };
  }
  if (!existsSync(discoveryRoot)) return { removed, retained, failures };
  for (const entry of readdirSync(discoveryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "inbox") continue;
    let run;
    try {
      run = loadDiscoveryRun(path.join(discoveryRoot, entry.name));
    } catch {
      failures.push(`${entry.name}: discovery run could not be read; local state was retained`);
      continue;
    }
    if (run.state !== "complete" && run.state !== "revoked") continue;
    const localRelative = `.foo/discovery/${run.study_id}`;
    const localDir = path.join(localRoot, run.study_id);
    if (!existsSync(localDir)) continue;
    let due = run.state === "revoked";
    if (run.state === "complete") {
      const updatedAt = Date.parse(run.updated_at);
      if (!Number.isFinite(updatedAt)) {
        failures.push(`${run.study_id}: invalid updated_at; ${localRelative} was retained`);
        retained.push(localRelative);
        continue;
      }
      due = current - updatedAt >= retentionDays * 24 * 60 * 60_000;
    }
    if (!due) {
      retained.push(localRelative);
      continue;
    }
    try {
      const result = purgeDiscoveryLocalState(localRoot, run.study_id);
      if (result.removed && !existsSync(result.path)) removed.push(localRelative);
      else failures.push(`${run.study_id}: cleanup incomplete; ${localRelative} remains`);
    } catch {
      failures.push(`${run.study_id}: cleanup failed; ${localRelative} remains`);
    }
  }
  return { removed: removed.sort(), retained: retained.sort(), failures };
}

// --- Receipt-verified local apply (nango-discovery-connector-v0 T-005) ------
//
// Hosted processing (T-004) returns a signed payload-free receipt beside the
// sanitized envelope as the needs_local_apply portable bundle. Applying that
// bundle locally re-verifies everything locally checkable — bundle shape,
// signature, signing key, expiry, envelope hash, subject/workspace/target/
// lane bindings, source fingerprint family, the CURRENT approval digest, and
// local revocation/suspension state — and only then asks the service
// `discovery_receipt_status` immediately before writing. Every refusal leaves
// disk untouched (R-007, RISK-012, C-009).

export const DISCOVERY_PORTABLE_BUNDLE_SCHEMA_VERSION = "0.1";

export type DiscoveryPortableBundle = {
  schema_version: "0.1";
  kind: "discovery_portable_bundle";
  envelope: DiscoveryEvidenceEnvelope;
  processing_receipt: DiscoveryProcessingReceipt;
};

const BUNDLE_KEYS = new Set(["schema_version", "kind", "envelope", "processing_receipt"]);

export type DiscoveryBundleVerification =
  | { ok: true; bundle: DiscoveryPortableBundle; receipt_hash: string; registry: DiscoveryRegisteredTarget }
  | { ok: false; message: string };

// The pinned productfoo verification keys for discovery receipts (D-012: published
// through the authenticated productfoo service). A missing or malformed file yields
// an EMPTY store — verification fails closed on unknown keys, never open.
export function loadDiscoveryReceiptTrustStore(root: string): TrustStore<"foo"> {
  const file = path.join(path.resolve(root), ".foo", "discovery", "trust.json");
  if (!existsSync(file)) return { namespace: "foo", keys: [] };
  const empty: TrustStore<"foo"> = { namespace: "foo", keys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const raw = parsed as { schema_version?: unknown; kind?: unknown; keys?: unknown };
  if (raw.schema_version !== "0.1" || raw.kind !== "discovery_receipt_trust_store" || !Array.isArray(raw.keys)) return empty;
  const keys = raw.keys.filter((entry): entry is TrustedSigningKey => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const key = entry as Partial<TrustedSigningKey>;
    return (
      typeof key.key_id === "string" &&
      typeof key.public_key_pem === "string" &&
      (key.status === "active" || key.status === "retired" || key.status === "revoked") &&
      typeof key.valid_from === "string" &&
      (key.valid_until === null || typeof key.valid_until === "string")
    );
  });
  return { namespace: "foo", keys };
}

export function verifyDiscoveryBundleForApply(input: {
  bundle: unknown;
  target_id: string;
  root: string; // repo root: registry and trust-store base
  study_dir: string; // approval ledger and source-revocation events
  trust_store?: TrustStore<"foo">;
  now: string;
}): DiscoveryBundleVerification {
  if (!input.bundle || typeof input.bundle !== "object" || Array.isArray(input.bundle)) {
    return { ok: false, message: "the portable bundle is not an object" };
  }
  const raw = input.bundle as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!BUNDLE_KEYS.has(key)) return { ok: false, message: `the portable bundle carries an unknown field: ${key}` };
  }
  if (raw.schema_version !== DISCOVERY_PORTABLE_BUNDLE_SCHEMA_VERSION || raw.kind !== "discovery_portable_bundle") {
    return { ok: false, message: "the portable bundle is not a 0.1 discovery_portable_bundle" };
  }

  // A hosted bundle may only be applied against a locally registered,
  // human-confirmed target (T-002 registration; T-006 boundary). No local
  // registration record means there is no one to hold the grant — fail closed.
  const registry = loadDiscoveryRegisteredTargets(input.root).find((record) => record.target_id === input.target_id);
  if (!registry) {
    return { ok: false, message: "no locally registered, human-confirmed target exists for this bundle; nothing can be applied" };
  }
  if (registry.suspension) {
    return { ok: false, message: "this target's hosted access is suspended locally; re-register the target before applying hosted evidence" };
  }
  if (registry.lane === "study") {
    const run = loadDiscoveryRun(input.study_dir);
    if (run.study_id !== input.target_id) return { ok: false, message: "the registered target does not match the study being applied" };
    if (run.state === "revoked") return { ok: false, message: "this study is revoked; no evidence can be applied" };
  }

  const lane = registry.lane === "inbox" ? "unassigned_call_evidence" : "study_linked";
  const context: EvidenceContext = { expected_study_id: input.target_id, expected_lane: lane };
  let envelope: DiscoveryEvidenceEnvelope;
  try {
    envelope = validateDiscoveryEvidence(raw.envelope, context);
  } catch (error) {
    return { ok: false, message: `the bundle's evidence envelope failed the closed contract — ${error instanceof Error ? error.message : "unknown error"}` };
  }

  // A hosted-registered target's evidence carries the hosted fingerprint
  // family; a local sha256 fingerprint here is a family substitution (the
  // local proof path binds local fingerprints to the proof, not the bundle).
  if (!HOSTED_SOURCE_FINGERPRINT.test(envelope.source.source_fingerprint)) {
    return { ok: false, message: "the bundle's evidence carries a non-hosted source fingerprint; nothing was applied" };
  }
  if (sourceWasRevoked(input.study_dir, envelope.source.source_fingerprint)) {
    return { ok: false, message: "this source was revoked locally; no evidence can be applied" };
  }

  // The receipt must have been minted against the approval digest that is
  // current RIGHT NOW — an approval or revocation recorded locally after
  // processing invalidates the bundle (stale approval, C-009).
  const expectation: DiscoveryReceiptExpectation = {
    subject_ref: registry.subject_ref,
    workspace_ref: registry.workspace_ref,
    connection_ref: registry.connection_ref,
    target_ref: registry.target_ref,
    target_id: registry.target_id,
    lane: registry.lane,
    source_fingerprint: envelope.source.source_fingerprint,
    approval_digest: approvalDigest(input.study_dir),
    revocation_epoch: registry.revocation_epoch,
    envelope_hash: discoveryEnvelopeDigest(envelope),
  };
  const verdict = verifyDiscoveryProcessingReceipt({
    receipt: raw.processing_receipt,
    trust_store: input.trust_store ?? loadDiscoveryReceiptTrustStore(input.root),
    expectation,
    now: input.now,
  });
  if (!verdict.ok) return { ok: false, message: `the processing receipt failed verification — ${verdict.message}` };

  return {
    ok: true,
    bundle: { schema_version: "0.1", kind: "discovery_portable_bundle", envelope, processing_receipt: raw.processing_receipt as DiscoveryProcessingReceipt },
    receipt_hash: verdict.receipt_hash,
    registry,
  };
}
