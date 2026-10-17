import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  envelopeHash,
  signEnvelope,
  type SplitTrustStores,
  type TrustNamespace,
  type TrustedSigningKey,
  verifyEnvelope,
} from "../src/trustEnvelope.js";

function keyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function trustedKey(
  keyId: string,
  publicKeyPem: string,
  overrides: Partial<TrustedSigningKey> = {},
): TrustedSigningKey {
  return {
    key_id: keyId,
    public_key_pem: publicKeyPem,
    status: "active",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function stores(
  customerKeys: readonly TrustedSigningKey[],
  fooKeys: readonly TrustedSigningKey[],
): SplitTrustStores {
  return {
    customer: { namespace: "customer", keys: customerKeys },
    foo: { namespace: "foo", keys: fooKeys },
  };
}

const CUSTOMER_KIND = "policy-pack";
const CUSTOMER_ID = "policy/acme/default";
const NOW = "2026-07-19T12:00:00.000Z";

function customerInput(
  keyId: string,
  overrides: Partial<Parameters<typeof signEnvelope>[0]> = {},
): Parameters<typeof signEnvelope>[0] {
  return {
    namespace: "customer",
    artifact_kind: CUSTOMER_KIND,
    artifact_id: CUSTOMER_ID,
    payload: {
      checks: [
        { id: "unit", config: { command: "npm test", required: true } },
        { id: "coverage", config: { floor: 0.8, required: false } },
      ],
      policy: { owner: "acme", labels: ["main", "release"] },
    },
    key_id: keyId,
    issued_at: "2026-07-19T10:00:00.000Z",
    not_before: "2026-07-19T10:00:00.000Z",
    expires_at: "2026-07-20T10:00:00.000Z",
    sequence: 1,
    previous_hash: null,
    ...overrides,
  };
}

function verifyCustomer(
  envelope: unknown,
  trustStores: SplitTrustStores,
  acceptedState: Parameters<typeof verifyEnvelope>[1]["accepted_state"] = null,
  verificationMode: "accept" | "revalidate" = "accept",
) {
  return verifyEnvelope(envelope, {
    expected_namespace: "customer",
    expected_artifact_kind: CUSTOMER_KIND,
    expected_artifact_id: CUSTOMER_ID,
    trust_stores: trustStores,
    accepted_state: acceptedState,
    verification_mode: verificationMode,
    now: NOW,
  });
}

test("canonical JSON recursively sorts objects and preserves array order and Unicode", () => {
  const value = {
    z: { b: 2, a: [3, { "β": "雪", a: true }] },
    a: "€",
  };
  assert.equal(
    canonicalJson(value),
    "{\"a\":\"€\",\"z\":{\"a\":[3,{\"a\":true,\"β\":\"雪\"}],\"b\":2}}",
  );
  assert.equal(
    canonicalJson({ n: [-0, 1e-7, 1e-6, 1e20, 1e21, 333333333.33333329, 4.50] }),
    "{\"n\":[0,1e-7,0.000001,100000000000000000000,1e+21,333333333.3333333,4.5]}",
  );
});

test("canonical JSON refuses values outside the RFC 8785 JSON domain", () => {
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /finite JSON number/i);
  assert.throws(() => canonicalJson({ bad: Number.POSITIVE_INFINITY }), /finite JSON number/i);
  assert.throws(() => canonicalJson({ bad: undefined } as never), /JSON value/i);
  assert.throws(() => canonicalJson({ bad: "\ud800" }), /Unicode scalar/i);
  const sparse: unknown[] = [];
  sparse.length = 1;
  assert.throws(() => canonicalJson(sparse as never), /sparse array/i);
});

test("a configured customer key verifies a complete nested envelope", () => {
  const customer = keyPair();
  const foo = keyPair();
  const envelope = signEnvelope(customerInput("customer-2026-01"), customer.privateKeyPem);
  const result = verifyCustomer(
    envelope,
    stores(
      [trustedKey("customer-2026-01", customer.publicKeyPem)],
      [trustedKey("foo-2026-01", foo.publicKeyPem)],
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.key_status, "active");
  assert.deepEqual(result.next_state, {
    namespace: "customer",
    artifact_kind: CUSTOMER_KIND,
    artifact_id: CUSTOMER_ID,
    sequence: 1,
    envelope_hash: envelopeHash(envelope),
  });
  assert.equal("public_key" in envelope, false);
  assert.equal("signer_public_key" in envelope, false);
});

test("successful verification returns an owned deeply frozen authenticated snapshot", () => {
  const customer = keyPair();
  const envelope = signEnvelope(customerInput("customer-2026-01"), customer.privateKeyPem);
  const result = verifyCustomer(
    envelope,
    stores([trustedKey("customer-2026-01", customer.publicKeyPem)], []),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const snapshot = (result as unknown as { verified_envelope: typeof envelope }).verified_envelope;
  assert.notEqual(snapshot, envelope);
  assert.notEqual(snapshot.payload, envelope.payload);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.payload), true);
  assert.equal(Object.isFrozen((snapshot.payload as { checks: unknown[] }).checks), true);

  const mutablePayload = envelope.payload as { checks: Array<{ config: { command: string } }> };
  mutablePayload.checks[0].config.command = "curl https://attacker.invalid";
  const authenticatedPayload = snapshot.payload as { checks: Array<{ config: { command: string } }> };
  assert.equal(authenticatedPayload.checks[0].config.command, "npm test");
  assert.throws(() => {
    authenticatedPayload.checks[0].config.command = "curl https://attacker.invalid";
  }, TypeError);
});

test("same-shaped nested mutation and signed security-metadata mutation fail", () => {
  const customer = keyPair();
  const trustStores = stores([trustedKey("customer-1", customer.publicKeyPem)], []);
  const envelope = signEnvelope(customerInput("customer-1"), customer.privateKeyPem);

  const nestedMutation = structuredClone(envelope);
  nestedMutation.payload = structuredClone(envelope.payload);
  const payload = nestedMutation.payload as { checks: Array<{ config: { command: string } }> };
  payload.checks[0].config.command = "curl https://attacker.invalid";
  assert.deepEqual(verifyCustomer(nestedMutation, trustStores), { ok: false, reason: "signature_invalid" });

  const sequenceMutation = { ...envelope, sequence: 2, previous_hash: "0".repeat(64) };
  assert.deepEqual(verifyCustomer(sequenceMutation, trustStores), { ok: false, reason: "signature_invalid" });
});

test("namespace and artifact domains cannot substitute for each other", () => {
  const customer = keyPair();
  const foo = keyPair();
  const trustStores = stores(
    [trustedKey("shared-id", customer.publicKeyPem)],
    [trustedKey("shared-id", foo.publicKeyPem)],
  );
  const envelope = signEnvelope(customerInput("shared-id"), customer.privateKeyPem);

  assert.deepEqual(verifyEnvelope(envelope, {
    expected_namespace: "foo",
    expected_artifact_kind: CUSTOMER_KIND,
    expected_artifact_id: CUSTOMER_ID,
    trust_stores: trustStores,
    accepted_state: null,
    verification_mode: "accept",
    now: NOW,
  }), { ok: false, reason: "wrong_namespace" });

  assert.deepEqual(verifyEnvelope(envelope, {
    expected_namespace: "customer",
    expected_artifact_kind: "attestation",
    expected_artifact_id: CUSTOMER_ID,
    trust_stores: trustStores,
    accepted_state: null,
    verification_mode: "accept",
    now: NOW,
  }), { ok: false, reason: "wrong_artifact_kind" });

  const relabeled = { ...envelope, artifact_kind: "attestation" };
  assert.deepEqual(verifyEnvelope(relabeled, {
    expected_namespace: "customer",
    expected_artifact_kind: "attestation",
    expected_artifact_id: CUSTOMER_ID,
    trust_stores: trustStores,
    accepted_state: null,
    verification_mode: "accept",
    now: NOW,
  }), { ok: false, reason: "signature_invalid" });
});

test("customer and productfoo trust roots are separate even when key ids collide", () => {
  const customer = keyPair();
  const foo = keyPair();
  const trustStores = stores(
    [trustedKey("current", customer.publicKeyPem)],
    [trustedKey("current", foo.publicKeyPem)],
  );
  const fooEnvelope = signEnvelope({
    ...customerInput("current"),
    namespace: "foo",
    artifact_kind: "canonical-skill",
    artifact_id: "foo-roast@0.1.25",
  }, foo.privateKeyPem);

  assert.deepEqual(verifyCustomer(fooEnvelope, trustStores), { ok: false, reason: "wrong_namespace" });

  const forgedForFoo = signEnvelope({
    ...customerInput("current"),
    namespace: "foo",
    artifact_kind: "canonical-skill",
    artifact_id: "foo-roast@0.1.25",
  }, customer.privateKeyPem);
  assert.deepEqual(verifyEnvelope(forgedForFoo, {
    expected_namespace: "foo",
    expected_artifact_kind: "canonical-skill",
    expected_artifact_id: "foo-roast@0.1.25",
    trust_stores: trustStores,
    accepted_state: null,
    verification_mode: "accept",
    now: NOW,
  }), { ok: false, reason: "signature_invalid" });
});

test("unknown, revoked, retired, and expired key lifecycle is explicit", () => {
  const oldKey = keyPair();
  const newKey = keyPair();
  const envelope = signEnvelope(customerInput("old"), oldKey.privateKeyPem);

  assert.deepEqual(verifyCustomer(envelope, stores([], [])), { ok: false, reason: "unknown_key" });
  assert.deepEqual(verifyCustomer(envelope, stores([
    trustedKey("old", oldKey.publicKeyPem, { status: "revoked" }),
  ], [])), { ok: false, reason: "revoked_key" });
  assert.deepEqual(verifyCustomer(envelope, stores([
    trustedKey("old", oldKey.publicKeyPem, { valid_until: "2026-07-01T00:00:00.000Z" }),
  ], [])), { ok: false, reason: "key_expired" });

  const rotatedStores = stores([
    trustedKey("old", oldKey.publicKeyPem, { status: "retired" }),
    trustedKey("new", newKey.publicKeyPem),
  ], []);
  assert.deepEqual(verifyCustomer(envelope, rotatedStores), {
    ok: false,
    reason: "retired_key_for_new_acceptance",
  });

  const originallyAccepted = verifyCustomer(
    envelope,
    stores([trustedKey("old", oldKey.publicKeyPem)], []),
  );
  assert.equal(originallyAccepted.ok, true);
  if (!originallyAccepted.ok) return;
  const revalidated = verifyCustomer(envelope, rotatedStores, originallyAccepted.next_state, "revalidate");
  assert.equal(revalidated.ok, true);
  if (revalidated.ok) assert.equal(revalidated.key_status, "retired");

  const retiredAdvance = signEnvelope(customerInput("old", {
    sequence: 2,
    previous_hash: originallyAccepted.next_state.envelope_hash,
    issued_at: "2026-07-19T11:00:00.000Z",
    not_before: "2026-07-19T11:00:00.000Z",
  }), oldKey.privateKeyPem);
  assert.deepEqual(verifyCustomer(retiredAdvance, rotatedStores, originallyAccepted.next_state), {
    ok: false,
    reason: "retired_key_for_new_acceptance",
  });

  const newEnvelope = signEnvelope(customerInput("new", {
    sequence: 2,
    previous_hash: originallyAccepted.next_state.envelope_hash,
  }), newKey.privateKeyPem);
  assert.equal(verifyCustomer(newEnvelope, rotatedStores, originallyAccepted.next_state).ok, true);
});

test("envelope validity rejects future and expired artifacts before acceptance", () => {
  const customer = keyPair();
  const trustStores = stores([trustedKey("customer", customer.publicKeyPem)], []);
  const future = signEnvelope(customerInput("customer", {
    issued_at: "2026-07-20T11:00:00.000Z",
    not_before: "2026-07-20T11:00:00.000Z",
    expires_at: "2026-07-21T11:00:00.000Z",
  }), customer.privateKeyPem);
  assert.deepEqual(verifyCustomer(future, trustStores), { ok: false, reason: "envelope_not_yet_valid" });

  const expired = signEnvelope(customerInput("customer", {
    issued_at: "2026-07-17T10:00:00.000Z",
    not_before: "2026-07-17T10:00:00.000Z",
    expires_at: "2026-07-18T10:00:00.000Z",
  }), customer.privateKeyPem);
  assert.deepEqual(verifyCustomer(expired, trustStores), { ok: false, reason: "envelope_expired" });
});

test("accepted sequence state rejects replay, rollback, gaps, and wrong predecessors", () => {
  const customer = keyPair();
  const trustStores = stores([trustedKey("customer", customer.publicKeyPem)], []);
  const first = signEnvelope(customerInput("customer"), customer.privateKeyPem);
  const acceptedFirst = verifyCustomer(first, trustStores);
  assert.equal(acceptedFirst.ok, true);
  if (!acceptedFirst.ok) return;

  assert.deepEqual(verifyCustomer(first, trustStores, acceptedFirst.next_state), { ok: false, reason: "replay" });
  const revalidatedFirst = verifyCustomer(first, trustStores, acceptedFirst.next_state, "revalidate");
  assert.equal(revalidatedFirst.ok, true);

  const second = signEnvelope(customerInput("customer", {
    sequence: 2,
    previous_hash: acceptedFirst.next_state.envelope_hash,
    payload: { revision: 2, nested: { enabled: true } },
  }), customer.privateKeyPem);
  const acceptedSecond = verifyCustomer(second, trustStores, acceptedFirst.next_state);
  assert.equal(acceptedSecond.ok, true);
  if (!acceptedSecond.ok) return;

  assert.deepEqual(verifyCustomer(first, trustStores, acceptedSecond.next_state), { ok: false, reason: "rollback" });

  const gap = signEnvelope(customerInput("customer", {
    sequence: 4,
    previous_hash: acceptedSecond.next_state.envelope_hash,
  }), customer.privateKeyPem);
  assert.deepEqual(verifyCustomer(gap, trustStores, acceptedSecond.next_state), { ok: false, reason: "sequence_gap" });

  const wrongPredecessor = signEnvelope(customerInput("customer", {
    sequence: 3,
    previous_hash: "0".repeat(64),
  }), customer.privateKeyPem);
  assert.deepEqual(verifyCustomer(wrongPredecessor, trustStores, acceptedSecond.next_state), {
    ok: false,
    reason: "previous_hash_mismatch",
  });
});

test("an embedded public key never appoints itself as trusted", () => {
  const attacker = keyPair();
  const envelope = signEnvelope(customerInput("attacker"), attacker.privateKeyPem);
  const selfAppointing = { ...envelope, signer_public_key: attacker.publicKeyPem };
  assert.deepEqual(verifyCustomer(selfAppointing, stores([], [])), { ok: false, reason: "malformed_envelope" });
});

test("trust-store namespace mismatch and duplicate key ids fail closed", () => {
  const customer = keyPair();
  const envelope = signEnvelope(customerInput("customer"), customer.privateKeyPem);
  const mismatched = {
    customer: { namespace: "foo", keys: [trustedKey("customer", customer.publicKeyPem)] },
    foo: { namespace: "foo", keys: [] },
  } as unknown as SplitTrustStores;
  assert.deepEqual(verifyCustomer(envelope, mismatched), { ok: false, reason: "invalid_trust_store" });

  const duplicate = trustedKey("customer", customer.publicKeyPem);
  assert.deepEqual(verifyCustomer(envelope, stores([duplicate, duplicate], [])), {
    ok: false,
    reason: "invalid_trust_store",
  });
});

test("trust namespaces remain a closed two-value authority split", () => {
  const namespaces: readonly TrustNamespace[] = ["customer", "foo"];
  assert.deepEqual(namespaces, ["customer", "foo"]);
});
