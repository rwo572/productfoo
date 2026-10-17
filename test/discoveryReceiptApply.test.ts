import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReceiptVerifiedDiscoveryBundle } from "../src/discoveryReconcile.js";
import { approvalLedgerDigest } from "../src/discoveryProof.js";
import {
  recordDiscoveryTargetRegistration,
  type DiscoveryServiceGrant,
  type DiscoveryTargetManifest,
} from "../src/discoveryConnections.js";
import {
  createInMemoryDiscoveryReceiptSigner,
  discoveryEnvelopeDigest,
  type DiscoveryProcessingReceiptPayload,
  type DiscoveryReceiptStatusEndpoint,
  type DiscoveryReceiptStatusResult,
} from "../src/discoveryProcess.js";
import { seedDiscoveryFixture, validEnvelope } from "./discoveryFixtures.js";

const STUDY_ID = "study_granola_shape_up_20260720";
const NOW = "2026-09-24T12:00:00.000Z";
const HOSTED_FINGERPRINT = `hmac-sha256:v1:${"a".repeat(64)}`;

// Every refusal must leave the tree byte-identical (C-009): snapshot every
// file under the fixture root before the call and compare afterwards.
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join("/"), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(root);
  return files;
}

function fixture(): { root: string; studyDir: string; approvalDigest: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-receipt-"));
  const studyDir = seedDiscoveryFixture(root);
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8").replace("state: awaiting_interview", "state: ready_to_synthesize");
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  return { root, studyDir, approvalDigest: approvalLedgerDigest(studyDir) };
}

function writeTrustStore(root: string, entries: unknown[]): void {
  mkdirSync(path.join(root, ".foo", "discovery"), { recursive: true });
  writeFileSync(path.join(root, ".foo", "discovery", "trust.json"), `${JSON.stringify({ schema_version: "0.1", kind: "discovery_receipt_trust_store", keys: entries }, null, 2)}\n`);
}

function manifestFixture(studyDir: string): DiscoveryTargetManifest {
  return {
    schema_version: "0.1",
    kind: "discovery_target_manifest",
    packet: "nango-discovery-connector-v0",
    spec_id: "nango_discovery_connector_v0",
    workspace_ref: "ws_test_workspace",
    target_id: STUDY_ID,
    lane: "study",
    connection_ref: `conn:${"1".repeat(32)}`,
    approved_selectors: ["customer:acme"],
    approval_digest: approvalLedgerDigest(studyDir),
    revocation_epoch: 3,
  };
}

function grantFixture(manifest: DiscoveryTargetManifest): DiscoveryServiceGrant {
  return {
    schema_version: "0.1",
    kind: "discovery_service_grant",
    subject_ref: "subj_alice",
    workspace_ref: manifest.workspace_ref,
    target_ref: `dtarget:${"2".repeat(32)}`,
    target_id: manifest.target_id,
    lane: manifest.lane,
    connection_ref: manifest.connection_ref,
    approved_selectors: [...manifest.approved_selectors],
    approval_digest: manifest.approval_digest,
    revocation_epoch: manifest.revocation_epoch,
    issued_at: "2026-09-24T10:00:00.000Z",
    expires_at: "2026-09-25T10:00:00.000Z",
    budget: { max_operations: 10, window: "day" },
  };
}

function registerTarget(root: string, manifest: DiscoveryTargetManifest, overrides: { subject_ref?: string } = {}): void {
  recordDiscoveryTargetRegistration(root, {
    manifest,
    confirmation: { confirmed_by: "taylor", confirmed_at: "2026-09-24T10:00:00.000Z", confirmed_via: "fixture-confirmation" },
    result: { target_ref: `dtarget:${"2".repeat(32)}`, grant: grantFixture(manifest) },
    local: { subject_ref: overrides.subject_ref ?? "subj_alice", provider: "granola", connection_id: "primary" },
    at: NOW,
  });
}

function statusEndpoint(result: DiscoveryReceiptStatusResult | "unreachable", calls: { count: number } = { count: 0 }): DiscoveryReceiptStatusEndpoint {
  return {
    async receiptStatus() {
      calls.count += 1;
      if (result === "unreachable") throw new Error("connection refused");
      return result;
    },
  };
}

function bundleFixture(input: {
  studyDir: string;
  signer: ReturnType<typeof createInMemoryDiscoveryReceiptSigner>;
  approvalDigest: string;
}): { envelope: ReturnType<typeof validEnvelope>; payload: DiscoveryProcessingReceiptPayload; receipt: unknown } {
  const envelope = validEnvelope();
  envelope.source.source_fingerprint = HOSTED_FINGERPRINT;
  const payload: DiscoveryProcessingReceiptPayload = {
    kind: "discovery_processing_receipt",
    receipt_version: "v1",
    subject_ref: "subj_alice",
    workspace_ref: "ws_test_workspace",
    connection_ref: `conn:${"1".repeat(32)}`,
    target_ref: `dtarget:${"2".repeat(32)}`,
    target_id: STUDY_ID,
    lane: "study",
    source_fingerprint: HOSTED_FINGERPRINT,
    approval_digest: input.approvalDigest,
    grant_digest: `sha256:${"b".repeat(64)}`,
    revocation_epoch: 3,
    envelope_hash: discoveryEnvelopeDigest(envelope),
    attempt_id: `att:${"ab".repeat(20)}`,
    processing: { processing_version: "discovery-process-0.1", prompt_version: "prompt-0.1", policy_version: "policy-0.1", synthesizer_model: "fixture-model", envelope_schema_version: "0.1" },
    limits: { max_response_bytes: 8388608, fetch_timeout_ms: 90000, max_model_input_tokens: 100000 },
  };
  const receipt = input.signer.signReceipt({ payload, issued_at: "2026-09-24T11:00:00.000Z", expires_at: "2026-09-24T13:00:00.000Z" });
  return { envelope, payload, receipt: JSON.parse(JSON.stringify(receipt)) };
}

const ACTIVE: DiscoveryReceiptStatusResult = { receipt_status: "active", revocation_epoch: 3 };

test("a valid signed bundle applies, verifies online, and stops at needs_review", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const calls = { count: 0 };

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE, calls),
    now: NOW,
  });

  assert.equal(applied.status, "needs_review");
  if (applied.status !== "needs_review") return;
  assert.ok(applied.writes.length >= 3);
  assert.ok(applied.writes.every((write) => write.path.startsWith("discovery/") || write.path.startsWith(".foo/discovery/")));
  assert.equal(calls.count, 1);
  const run = readFileSync(path.join(f.studyDir, "run.yaml"), "utf8");
  assert.match(run, /state: needs_review/);
});

test("a tampered envelope is refused before any write or status check (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const tamperedEnvelope = structuredClone(parts.envelope);
  tamperedEnvelope.findings[0].paraphrase = "The participant was substituted after signing.";
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: tamperedEnvelope, processing_receipt: parts.receipt };
  const calls = { count: 0 };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE, calls),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.equal(calls.count, 0, "the online check never runs for a locally refuted bundle");
  assert.deepEqual(snapshot(f.root), before);
});

test("a tampered receipt payload is refused and writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const tamperedReceipt = structuredClone(parts.receipt) as { payload: DiscoveryProcessingReceiptPayload };
  tamperedReceipt.payload.envelope_hash = `sha256:${"f".repeat(64)}`;
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: tamperedReceipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("cross-tenant substitution: another user's bundle against this registry is refused (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir), { subject_ref: "subj_bob" });
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /subject_ref/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a stale approval digest (ledger moved after processing) is refused and writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  // The local approval ledger gains an event after the receipt was minted.
  appendFileSync(path.join(f.studyDir, "events.jsonl"), `${JSON.stringify({ type: "com.adaptivespec.source.approved", data: { scope: "customer:acme" } })}\n`);
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("an unknown signer key is refused (C-009)", async () => {
  const f = fixture();
  const stranger = createInMemoryDiscoveryReceiptSigner({ key_id: "discovery-receipt-stranger" });
  writeTrustStore(f.root, [stranger.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer: createInMemoryDiscoveryReceiptSigner(), approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /unknown key/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a revoked signer key is refused (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry({ status: "revoked" })]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("a missing trust store fails closed on unknown keys (C-009)", async () => {
  const f = fixture();
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer: createInMemoryDiscoveryReceiptSigner(), approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("an offline verifier reports needs_service_verification and writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint("unreachable"),
    now: NOW,
  });

  assert.equal(applied.status, "needs_service_verification");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("the V0 default (no endpoint wired) fails closed like an offline verifier", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    now: NOW,
  });

  assert.equal(applied.status, "needs_service_verification");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("a post-process revoke reported by the service writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint({ receipt_status: "revoked", revocation_epoch: 3 }),
    now: NOW,
  });

  assert.equal(applied.status, "needs_service_verification");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("a service-side revocation epoch ahead of the local registry writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint({ receipt_status: "active", revocation_epoch: 4 }),
    now: NOW,
  });

  assert.equal(applied.status, "needs_service_verification");
  assert.deepEqual(applied.writes, []);
  assert.deepEqual(snapshot(f.root), before);
});

test("a local-side revocation epoch ahead of the receipt is refused before the status check (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  // Revoke locally after registration: the fan-out bumps the registry epoch.
  const registryPath = path.join(f.root, ".foo", "discovery", STUDY_ID, "target.json");
  const record = JSON.parse(readFileSync(registryPath, "utf8")) as { revocation_epoch: number };
  record.revocation_epoch = 4;
  writeFileSync(registryPath, `${JSON.stringify(record, null, 2)}\n`);
  const calls = { count: 0 };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE, calls),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.equal(calls.count, 0);
  assert.deepEqual(snapshot(f.root), before);
});

test("an expired receipt is refused and writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: "2026-09-24T14:00:00.000Z",
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /expired/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a locally revoked source (by fingerprint) is refused and writes nothing (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  appendFileSync(path.join(f.studyDir, "events.jsonl"), `${JSON.stringify({ type: "com.adaptivespec.discovery.source_revoked", data: { source_fingerprint: HOSTED_FINGERPRINT } })}\n`);
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /revoked/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a suspended target record refuses every bundle (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const registryPath = path.join(f.root, ".foo", "discovery", STUDY_ID, "target.json");
  const record = JSON.parse(readFileSync(registryPath, "utf8")) as { suspension: unknown };
  record.suspension = { state: "acknowledged", revocation_epoch: 4, requested_at: NOW, acknowledged_at: NOW };
  writeFileSync(registryPath, `${JSON.stringify(record, null, 2)}\n`);
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /suspended/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a bundle with no locally registered target is refused (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: parts.envelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /registered/);
  assert.deepEqual(snapshot(f.root), before);
});

test("a local sha256 fingerprint cannot ride the hosted bundle path (C-009)", async () => {
  const f = fixture();
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  registerTarget(f.root, manifestFixture(f.studyDir));
  const parts = bundleFixture({ studyDir: f.studyDir, signer, approvalDigest: f.approvalDigest });
  const localEnvelope = structuredClone(parts.envelope);
  localEnvelope.source.source_fingerprint = `sha256:${"c".repeat(64)}`;
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: localEnvelope, processing_receipt: parts.receipt };
  const before = snapshot(f.root);

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: STUDY_ID,
    studyDir: f.studyDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "invalid");
  assert.deepEqual(applied.writes, []);
  assert.match(applied.reason, /non-hosted source fingerprint/);
  assert.deepEqual(snapshot(f.root), before);
});

test("an inbox-lane bundle applies through the inbox apply path", async () => {
  const f = fixture();
  const inboxDir = path.join(f.root, "discovery", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  for (const name of ["findings.yaml", "proposals.yaml", "events.jsonl"]) {
    if (!readdirSync(inboxDir).includes(name)) writeFileSync(path.join(inboxDir, name), name === "events.jsonl" ? "" : `${name === "findings.yaml" ? "schema_version: \"0.1\"\nfindings" : "schema_version: \"0.1\"\nproposals"}: []\n`);
  }
  const inboxManifest = { ...manifestFixture(f.studyDir), target_id: "inbox:customers", lane: "inbox" as const };
  const signer = createInMemoryDiscoveryReceiptSigner();
  writeTrustStore(f.root, [signer.trustEntry()]);
  recordDiscoveryTargetRegistration(f.root, {
    manifest: inboxManifest,
    confirmation: { confirmed_by: "taylor", confirmed_at: NOW, confirmed_via: "fixture-confirmation" },
    result: { target_ref: `dtarget:${"3".repeat(32)}`, grant: grantFixture(inboxManifest) },
    local: { subject_ref: "subj_alice", provider: "granola", connection_id: "primary" },
    at: NOW,
  });
  const inboxEnvelope = validEnvelope();
  inboxEnvelope.study_id = "inbox:customers";
  inboxEnvelope.lane = "unassigned_call_evidence";
  for (const finding of inboxEnvelope.findings) delete finding.hypothesis_id; // inbox lane: no retrospective study hypothesis
  inboxEnvelope.source.source_fingerprint = HOSTED_FINGERPRINT;
  const payload: DiscoveryProcessingReceiptPayload = {
    kind: "discovery_processing_receipt",
    receipt_version: "v1",
    subject_ref: "subj_alice",
    workspace_ref: "ws_test_workspace",
    connection_ref: `conn:${"1".repeat(32)}`,
    target_ref: `dtarget:${"3".repeat(32)}`,
    target_id: "inbox:customers",
    lane: "inbox",
    source_fingerprint: HOSTED_FINGERPRINT,
    approval_digest: approvalLedgerDigest(inboxDir),
    grant_digest: `sha256:${"b".repeat(64)}`,
    revocation_epoch: 3,
    envelope_hash: discoveryEnvelopeDigest(inboxEnvelope),
    attempt_id: `att:${"cd".repeat(20)}`,
    processing: { processing_version: "discovery-process-0.1", prompt_version: "prompt-0.1", policy_version: "policy-0.1", synthesizer_model: "fixture-model", envelope_schema_version: "0.1" },
    limits: { max_response_bytes: 8388608, fetch_timeout_ms: 90000, max_model_input_tokens: 100000 },
  };
  const receipt = signer.signReceipt({ payload, issued_at: "2026-09-24T11:00:00.000Z", expires_at: "2026-09-24T13:00:00.000Z" });
  const bundle = { schema_version: "0.1", kind: "discovery_portable_bundle", envelope: inboxEnvelope, processing_receipt: JSON.parse(JSON.stringify(receipt)) };

  const applied = await applyReceiptVerifiedDiscoveryBundle({
    root: f.root,
    target_id: "inbox:customers",
    studyDir: inboxDir,
    bundle,
    receipt_status: statusEndpoint(ACTIVE),
    now: NOW,
  });

  assert.equal(applied.status, "needs_review");
});
