import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { SplitTrustStores } from "../src/trustEnvelope.js";
import {
  mintCompletionReceipt,
  verifyCompletionReceipt,
  type CompletionReceiptInput,
} from "../src/researchReceipt.js";

// --- test fixtures ---------------------------------------------------------
// A completion receipt is a productfoo-signed terminal record. These tests are the
// C-002 corpus for T-005: a forged, planning-only, abandoned, source-mismatched,
// provider-mismatched, altered-paper, stale-key, or replayed record must fail.

function fooKeypair(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const NOW = "2026-07-20T12:00:00.000Z";
const PAPER = "# Faster onboarding\n\nEvery claim carries a source.\n";
const PAPER_SHA = createHash("sha256").update(PAPER, "utf8").digest("hex");

function trustStores(keys: Array<{ keyId: string; publicKeyPem: string; status?: "active" | "retired" | "revoked" }>): SplitTrustStores {
  return {
    customer: { namespace: "customer", keys: [] },
    foo: {
      namespace: "foo",
      keys: keys.map((k) => ({
        key_id: k.keyId,
        public_key_pem: k.publicKeyPem,
        status: k.status ?? "active",
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      })),
    },
  };
}

function baseInput(overrides: Partial<CompletionReceiptInput> = {}): CompletionReceiptInput {
  return {
    run_id: "r-abc123-def456",
    topic: "faster onboarding so trials convert",
    state: "completed",
    sources: [
      { source_class: "repo", reached: true, item_count: 4 },
      { source_class: "web_free", reached: true, item_count: 9 },
      { source_class: "connected", reached: false, item_count: 0 },
    ],
    evidence_sha256: createHash("sha256").update("evidence-set", "utf8").digest("hex"),
    provider: { adapter: "single-model", model: "claude-opus-4-8" },
    evaluator_version: "research-format-v1",
    paper_sha256: PAPER_SHA,
    issued_at: NOW,
    sequence: 1,
    previous_hash: null,
    ...overrides,
  };
}

// --- happy path ------------------------------------------------------------

test("a genuine completion receipt verifies against the paper it bound", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.receipt.run_id, "r-abc123-def456");
    assert.equal(result.receipt.state, "completed");
  }
});

// --- C-002 corpus: each of these must FAIL -------------------------------

test("forged: a receipt signed by an unknown key fails", () => {
  const real = fooKeypair("foo-research-2026");
  const attacker = fooKeypair("foo-research-2026"); // same id, different key
  const receipt = mintCompletionReceipt(baseInput(), attacker.privateKeyPem, attacker.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([real]),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "signature_invalid");
});

test("planning-only: a 'planned' state is refused as a completion", () => {
  const key = fooKeypair("foo-research-2026");
  // mint refuses to sign a non-terminal state at all
  assert.throws(() => mintCompletionReceipt(baseInput({ state: "planned" as never }), key.privateKeyPem, key.keyId));
});

test("abandoned: an 'abandoned' state is refused as a completion", () => {
  const key = fooKeypair("foo-research-2026");
  assert.throws(() => mintCompletionReceipt(baseInput({ state: "abandoned" as never }), key.privateKeyPem, key.keyId));
});

test("altered-paper: a receipt whose bound paper hash no longer matches fails", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER + "\ninjected line\n", "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "paper_mismatch");
});

test("provider-mismatched: an expected provider that differs fails", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: null,
    now: NOW,
    expected_provider: { adapter: "single-model", model: "some-other-model" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider_mismatch");
});

test("source-mismatched: an expected source set that differs fails", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: null,
    now: NOW,
    expected_sources: ["repo", "web_free", "web_firecrawl"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "source_mismatch");
});

test("stale-key: a revoked signing key fails", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([{ ...key, status: "revoked" }]),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "revoked_key");
});

test("replayed: reusing a receipt at or below an accepted sequence fails", () => {
  const key = fooKeypair("foo-research-2026");
  const receipt = mintCompletionReceipt(baseInput(), key.privateKeyPem, key.keyId);
  const first = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // replaying the same sequence against the now-accepted state must fail
  const replay = verifyCompletionReceipt(receipt, {
    paper_bytes: Buffer.from(PAPER, "utf8"),
    trust_stores: trustStores([key]),
    accepted_state: first.next_state,
    now: NOW,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.reason, "replay");
});
