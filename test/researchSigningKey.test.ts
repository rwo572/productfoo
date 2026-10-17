import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadOrCreateFooSigningKey, loadFooResearchTrustStores } from "../src/researchSigningKey.js";
import { mintCompletionReceipt, verifyCompletionReceipt } from "../src/researchReceipt.js";

const NOW = "2026-07-20T12:00:00.000Z";

function dirs() {
  const root = mkdtempSync(path.join(tmpdir(), "foo-root-"));
  const keyDir = mkdtempSync(path.join(tmpdir(), "foo-keys-"));
  return { root, keyDir };
}

test("first use generates a machine-local private key and publishes the public key", () => {
  const { root, keyDir } = dirs();
  const key = loadOrCreateFooSigningKey(root, { keyDir, now: NOW });
  assert.match(key.keyId, /^foo-research-[0-9a-f]{16}$/);
  // private key is stored 0600, machine-local
  const priv = path.join(keyDir, "research-signing.pem");
  assert.ok(existsSync(priv));
  assert.equal(statSync(priv).mode & 0o777, 0o600);
  // public key is published into the tracked, repo-local trust store
  const store = path.join(root, "research", ".trust", "foo-research.json");
  assert.ok(existsSync(store));
  assert.match(readFileSync(store, "utf8"), new RegExp(key.keyId));
});

test("subsequent use loads the same key, does not regenerate", () => {
  const { root, keyDir } = dirs();
  const a = loadOrCreateFooSigningKey(root, { keyDir, now: NOW });
  const b = loadOrCreateFooSigningKey(root, { keyDir, now: NOW });
  assert.equal(a.keyId, b.keyId);
  assert.equal(a.privateKeyPem, b.privateKeyPem);
});

test("end-to-end: a receipt minted with the key verifies against the published trust store", () => {
  const { root, keyDir } = dirs();
  const key = loadOrCreateFooSigningKey(root, { keyDir, now: NOW });

  const paper = "# Faster onboarding\n\nresearch_run: r-live-0001\n";
  const paperBytes = Buffer.from(paper, "utf8");
  const receipt = mintCompletionReceipt(
    {
      run_id: "r-live-0001", topic: "faster onboarding", state: "completed",
      sources: [{ source_class: "repo", reached: true, item_count: 3 }],
      evidence_sha256: createHash("sha256").update("ev").digest("hex"),
      provider: { adapter: "single-model", model: "claude-opus-4-8" },
      evaluator_version: "research-format-v1",
      paper_sha256: createHash("sha256").update(paperBytes).digest("hex"),
      issued_at: NOW, sequence: 1, previous_hash: null,
    },
    key.privateKeyPem,
    key.keyId,
  );

  // a verifier loads only the published trust store — no private material
  const result = verifyCompletionReceipt(receipt, {
    paper_bytes: paperBytes,
    trust_stores: loadFooResearchTrustStores(root),
    accepted_state: null,
    now: NOW,
  });
  assert.equal(result.ok, true);
});

test("a fresh clone with no trust store verifies nothing (default-safe)", () => {
  const { root } = dirs();
  const stores = loadFooResearchTrustStores(root); // never provisioned here
  assert.equal(stores.foo.keys.length, 0);
});
