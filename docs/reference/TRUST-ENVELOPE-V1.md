# productfoo Signed Envelope V1

productfoo Signed Envelope V1 defines a shared cryptographic container: canonical bytes, signatures, trust namespaces, and acceptance state. It is a protocol reference, not a deployment or service-availability claim. A valid envelope does not activate a capability, approve evidence for a decision, or establish the safety of its contents.

## Canonical bytes

The unsigned envelope is serialized with RFC 8785 JSON Canonicalization Scheme semantics: object keys sort recursively by UTF-16 code units, array order is retained, strings are UTF-8 JSON strings, and finite numbers use ECMAScript JSON serialization. Non-JSON values, non-finite numbers, sparse arrays, accessors, non-plain objects, and unpaired Unicode surrogates are refused.

The Ed25519 signing bytes are:

```text
foo.signed-envelope.v1\0<namespace>\0<artifact_kind>\0<JCS(unsigned-envelope)>
```

The NUL-separated prefix is domain separation. Both `namespace` and `artifact_kind` are also inside the canonical envelope, so changing either changes the signed bytes. The stable envelope hash is SHA-256 over:

```text
foo.signed-envelope-hash.v1\0<JCS(signed-envelope)>
```

## Envelope fields

Every signed envelope binds exactly these unsigned fields:

- `schema_version`: `"1"`
- `namespace`: `customer` or `foo`
- `artifact_kind` and `artifact_id`
- the complete nested `payload`
- `key_id`
- `issued_at`, `not_before`, and `expires_at` as canonical UTC timestamps
- positive integer `sequence`
- `previous_hash`, which is `null` only for sequence 1
- `signature_algorithm`: `"Ed25519"`

`signature` is canonical base64 for the 64-byte Ed25519 signature. Unknown fields are refused, so an embedded public key can never appoint itself as a trust root. There is no `public_key` or `signer_public_key` field.

## Authority split and key lifecycle

Customer/install-controlled artifacts and productfoo-issued artifacts use separate trust namespaces. A customer key is resolved only from the configured `customer` store. A canonical-skill or research-receipt key is resolved only from the configured `foo` store. Reusing a key id across stores does not join their authority.

Trust configuration is external to the envelope. Each key has an issuance-validity interval and one status:

- `active`: verifies artifacts issued during the key interval and may be selected by an operator for new signatures.
- `retired`: revalidates only an already-accepted exact envelope from the key interval; it cannot create an initial acceptance or advance a chain.
- `revoked`: artifacts are refused unconditionally, regardless of issue time.

An unknown key is refused. An artifact issued before the key interval is `key_not_yet_valid`; one issued at or after its end is `key_expired`. Envelope validity is checked independently. Rotation adds a new active key and retires the prior key; it never copies a key across namespaces. Verification has two explicit modes: `accept` requires an active key and checks the next chain position, while `revalidate` requires the envelope's identity, sequence, and hash to exactly match externally persisted acceptance state. A backdated envelope from a retired key therefore cannot advance a chain.

## Replay and rollback

Acceptance state is external, immutable input to verification and is scoped to namespace, artifact kind, and artifact id. The first accepted envelope is sequence 1 with `previous_hash: null`. Every advance must be exactly the next sequence and must bind the accepted envelope hash in `previous_hash`.

A duplicate sequence is refused as replay. A lower sequence is refused as rollback. A higher gap is refused as `sequence_gap`; a wrong `previous_hash` is refused as `previous_hash_mismatch`. Successful verification returns an owned, deeply frozen envelope snapshot plus the next state; consumers must use that authenticated snapshot rather than reread caller-owned input. Verification never persists state. The consuming capability owns atomic persistence before it can reactivate.

## Published vectors

- [`test/fixtures/trust-envelope/jcs-vectors.json`](../../test/fixtures/trust-envelope/jcs-vectors.json) covers nested objects, arrays, Unicode, field order, and ECMAScript number forms.
- [`test/fixtures/trust-envelope/jcs-number-vectors.json`](../../test/fixtures/trust-envelope/jcs-number-vectors.json) reproduces every finite RFC 8785 Appendix B number sample from its IEEE 754 bytes, including negative zero, exponent thresholds, and rounding edges.
- [`test/fixtures/trust-envelope/signed-envelope-v1.json`](../../test/fixtures/trust-envelope/signed-envelope-v1.json) publishes the exact unsigned JSON, domain-separated signing bytes, public test key, signature, and envelope hash.
- [`test/fixtures/trust-envelope/hostile-substitution-matrix.json`](../../test/fixtures/trust-envelope/hostile-substitution-matrix.json) pins required refusal outcomes.
- [`test/fixtures/trust-envelope/verify_vector.py`](../../test/fixtures/trust-envelope/verify_vector.py) is an independent Python canonicalizer and Ed25519 verifier. It uses Python `cryptography` when present and OpenSSL 3 as a fallback.

Run the independent check with:

```sh
python3 test/fixtures/trust-envelope/verify_vector.py \
  test/fixtures/trust-envelope/signed-envelope-v1.json \
  test/fixtures/trust-envelope/jcs-vectors.json \
  test/fixtures/trust-envelope/jcs-number-vectors.json
```
