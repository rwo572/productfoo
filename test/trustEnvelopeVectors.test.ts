import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalJson,
  envelopeHash,
  envelopeSigningBytes,
  signEnvelope,
  type EnvelopeFailureReason,
  type EnvelopeInput,
  type JsonValue,
  type SignedEnvelope,
  verifyEnvelope,
} from "../src/trustEnvelope.js";

interface CanonicalVector {
  name: string;
  value: JsonValue;
  canonical: string;
}

interface NumberVectorCorpus {
  source: string;
  vectors: Array<{
    ieee754_hex: string;
    canonical: string;
  }>;
}

interface PublishedVector {
  vector_version: "1";
  test_key_derivation: { algorithm: string; label: string };
  public_key_pem: string;
  canonical_unsigned_json: string;
  signing_bytes_base64: string;
  envelope_hash: string;
  envelope: SignedEnvelope;
}

interface HostileCase {
  id: string;
  expected_reason: EnvelopeFailureReason;
}

const FIXTURE_ROOT = "test/fixtures/trust-envelope";

test("published JCS vectors cover nesting, Unicode, field order, and numbers", () => {
  const vectors = JSON.parse(readFileSync(`${FIXTURE_ROOT}/jcs-vectors.json`, "utf8")) as CanonicalVector[];
  assert.deepEqual(vectors.map((vector) => vector.name), [
    "nested-field-order-and-unicode",
    "arrays-and-ecmascript-numbers",
  ]);
  for (const vector of vectors) assert.equal(canonicalJson(vector.value), vector.canonical, vector.name);
});

test("published RFC 8785 Appendix B number samples match the TypeScript implementation", () => {
  const corpus = JSON.parse(
    readFileSync(`${FIXTURE_ROOT}/jcs-number-vectors.json`, "utf8"),
  ) as NumberVectorCorpus;
  assert.match(corpus.source, /RFC 8785 Appendix B/);
  assert.equal(corpus.vectors.length, 24);
  for (const vector of corpus.vectors) {
    const bytes = Buffer.from(vector.ieee754_hex, "hex");
    assert.equal(bytes.length, 8, vector.ieee754_hex);
    assert.equal(canonicalJson(bytes.readDoubleBE(0)), vector.canonical, vector.ieee754_hex);
  }
});

test("published signed-envelope vector is deterministic and verifies through the productfoo namespace", () => {
  const vector = JSON.parse(readFileSync(`${FIXTURE_ROOT}/signed-envelope-v1.json`, "utf8")) as PublishedVector;
  const seed = createHash("sha256").update(vector.test_key_derivation.label).digest();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  assert.equal(publicKeyPem, vector.public_key_pem);

  const { signature: _signature, schema_version: _schema, signature_algorithm: _algorithm, ...input } = vector.envelope;
  const reproduced = signEnvelope(input as EnvelopeInput, privateKeyPem);
  assert.deepEqual(reproduced, vector.envelope);
  assert.equal(canonicalJson({ ...input, schema_version: "1", signature_algorithm: "Ed25519" }), vector.canonical_unsigned_json);
  assert.equal(envelopeSigningBytes(vector.envelope).toString("base64"), vector.signing_bytes_base64);
  assert.equal(envelopeHash(vector.envelope), vector.envelope_hash);

  const verified = verifyEnvelope(vector.envelope, {
    expected_namespace: "foo",
    expected_artifact_kind: "canonical-skill",
    expected_artifact_id: "foo-roast@0.1.25",
    trust_stores: {
      customer: { namespace: "customer", keys: [] },
      foo: {
        namespace: "foo",
        keys: [{
          key_id: "foo-vector-2026-01",
          public_key_pem: vector.public_key_pem,
          status: "active",
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_until: "2028-01-01T00:00:00.000Z",
        }],
      },
    },
    accepted_state: null,
    verification_mode: "accept",
    now: "2026-07-20T00:00:00.000Z",
  });
  assert.equal(verified.ok, true);
});

test("an independent Python implementation reproduces all JCS vectors, signing bytes, and signature", () => {
  const result = spawnSync("python3", [
    `${FIXTURE_ROOT}/verify_vector.py`,
    `${FIXTURE_ROOT}/signed-envelope-v1.json`,
    `${FIXTURE_ROOT}/jcs-vectors.json`,
    `${FIXTURE_ROOT}/jcs-number-vectors.json`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "trust-envelope vectors ok\n");
});

test("the published hostile substitution matrix names every required refusal", () => {
  const matrix = JSON.parse(readFileSync(`${FIXTURE_ROOT}/hostile-substitution-matrix.json`, "utf8")) as HostileCase[];
  assert.deepEqual(matrix, [
    { id: "same-shaped-nested-mutation", expected_reason: "signature_invalid" },
    { id: "security-metadata-mutation", expected_reason: "signature_invalid" },
    { id: "cross-namespace-substitution", expected_reason: "wrong_namespace" },
    { id: "cross-artifact-substitution", expected_reason: "wrong_artifact_kind" },
    { id: "unknown-key", expected_reason: "unknown_key" },
    { id: "revoked-key", expected_reason: "revoked_key" },
    { id: "expired-key", expected_reason: "key_expired" },
    { id: "expired-envelope", expected_reason: "envelope_expired" },
    { id: "retired-key-advance", expected_reason: "retired_key_for_new_acceptance" },
    { id: "replay", expected_reason: "replay" },
    { id: "rollback", expected_reason: "rollback" },
    { id: "wrong-predecessor", expected_reason: "previous_hash_mismatch" },
    { id: "embedded-public-key", expected_reason: "malformed_envelope" },
  ]);
});

test("the public envelope micro-spec pins domains, authority, and lifecycle semantics", () => {
  const contract = readFileSync("docs/reference/TRUST-ENVELOPE-V1.md", "utf8");
  assert.match(contract, /foo\.signed-envelope\.v1\\0<namespace>\\0<artifact_kind>\\0/);
  assert.match(contract, /customer.*productfoo.*separate trust namespaces/is);
  assert.match(contract, /embedded public key.*never.*trust/is);
  assert.match(contract, /revoked.*refused.*unconditionally/is);
  assert.match(contract, /replay.*rollback.*sequence.*previous_hash/is);
  assert.match(contract, /signed-envelope-v1\.json/);
  assert.match(contract, /verify_vector\.py/);
});
