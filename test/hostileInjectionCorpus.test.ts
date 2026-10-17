import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SplitTrustStores } from "../src/trustEnvelope.js";
import {
  mintCompletionReceipt,
  verifyCompletionReceipt,
  type CompletionReceiptInput,
} from "../src/researchReceipt.js";
import { validateClaims, type Claim } from "../src/research.js";

// The hostile-injection corpus (salvaged from the security-trust-research lane,
// PR #479) exercises the reactivated research path with adversarial content:
// direct/indirect instructions, Unicode homoglyphs, HTML with an exfil handler,
// base64-encoded orders, a tool-call-shaped source title, and model output that
// is itself a tool call. Content is data here — nothing in these strings may
// gain authority, break byte binding, or leak whole into an error message.

interface CorpusCase {
  id: string;
  kind: string;
  text: string;
}
const corpus = JSON.parse(readFileSync("examples/research/hostile-injection-corpus.json", "utf8")) as {
  schema_version: string;
  cases: CorpusCase[];
};

function fooKeypair(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const NOW = "2026-07-21T12:00:00.000Z";

function trustStores(keys: Array<{ keyId: string; publicKeyPem: string }>): SplitTrustStores {
  return {
    customer: { namespace: "customer", keys: [] },
    foo: {
      namespace: "foo",
      keys: keys.map((k) => ({
        key_id: k.keyId,
        public_key_pem: k.publicKeyPem,
        status: "active",
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      })),
    },
  };
}

function inputFor(topic: string, paperSha: string): CompletionReceiptInput {
  return {
    run_id: "r-hostile-corpus-1",
    topic,
    state: "completed",
    sources: [{ source_class: "web_free", reached: true, item_count: 1 }],
    evidence_sha256: createHash("sha256").update("evidence-set", "utf8").digest("hex"),
    provider: { adapter: "single-model", model: "claude-opus-4-8" },
    evaluator_version: "research-format-v1",
    paper_sha256: paperSha,
    issued_at: NOW,
    sequence: 1,
    previous_hash: null,
  };
}

test("hostile corpus: fixture is intact — seven distinct cases over the three ingress kinds", () => {
  assert.equal(corpus.schema_version, "1");
  assert.equal(corpus.cases.length, 7);
  assert.equal(new Set(corpus.cases.map((c) => c.id)).size, 7);
  for (const c of corpus.cases) {
    assert.ok(["source-body", "source-title", "model-output"].includes(c.kind), `${c.id}: unknown kind ${c.kind}`);
    assert.ok(c.text.length > 0, `${c.id}: empty payload`);
  }
});

test("hostile corpus: receipt byte-binding is content-blind — hostile bytes sign, verify, and still refuse a one-byte alteration", () => {
  const key = fooKeypair("foo-research-2026");
  for (const c of corpus.cases) {
    const paper = `# topic\n\nsource excerpt:\n${c.text}\n`;
    const paperSha = createHash("sha256").update(paper, "utf8").digest("hex");
    const receipt = mintCompletionReceipt(inputFor(`faster onboarding ${c.text}`, paperSha), key.privateKeyPem, key.keyId);
    const genuine = verifyCompletionReceipt(receipt, {
      paper_bytes: Buffer.from(paper, "utf8"),
      trust_stores: trustStores([key]),
      accepted_state: null,
      now: NOW,
    });
    assert.equal(genuine.ok, true, `${c.id}: hostile content must not break signing or canonicalization`);
    const altered = verifyCompletionReceipt(receipt, {
      paper_bytes: Buffer.from(`${paper} `, "utf8"),
      trust_stores: trustStores([key]),
      accepted_state: null,
      now: NOW,
    });
    assert.equal(altered.ok, false, `${c.id}: binding must stay exact under hostile content`);
  }
});

test("hostile corpus: content never substitutes for evidence labels, and refusals truncate the payload", () => {
  for (const c of corpus.cases) {
    // Unlabeled hostile claim: refused for the missing label, never adopted.
    const unlabeled = validateClaims([{ text: c.text, source_class: "attacker" as never, confidence: "high", dissent: null } as Claim]);
    assert.equal(unlabeled.ok, false, `${c.id}: hostile text must not pass without a valid label`);
    for (const message of unlabeled.errors) {
      assert.ok(!message.includes(c.text.slice(0, 60)) || c.text.length <= 48, `${c.id}: error echoes the full hostile payload`);
    }
    // Labeled: the claim is carried as inert text — the label came from the
    // caller, and nothing in the content changed the verdict.
    const labeled = validateClaims([{ text: c.text, source_class: "vendor", confidence: "low", dissent: null } as Claim]);
    assert.equal(labeled.ok, true, `${c.id}: a labeled claim's content is data, not policy`);
  }
});
