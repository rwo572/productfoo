import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TrustNamespace = "customer" | "foo";
export type SigningKeyStatus = "active" | "retired" | "revoked";
export type EnvelopeVerificationMode = "accept" | "revalidate";

export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface TrustedSigningKey {
  key_id: string;
  public_key_pem: string;
  status: SigningKeyStatus;
  valid_from: string;
  valid_until: string | null;
}

export interface TrustStore<N extends TrustNamespace = TrustNamespace> {
  namespace: N;
  keys: readonly TrustedSigningKey[];
}

export interface SplitTrustStores {
  customer: TrustStore<"customer">;
  foo: TrustStore<"foo">;
}

export interface EnvelopeInput<T extends JsonValue = JsonValue> {
  namespace: TrustNamespace;
  artifact_kind: string;
  artifact_id: string;
  payload: T;
  key_id: string;
  issued_at: string;
  not_before: string;
  expires_at: string;
  sequence: number;
  previous_hash: string | null;
}

export interface UnsignedEnvelope<T extends JsonValue = JsonValue> extends EnvelopeInput<T> {
  schema_version: "1";
  signature_algorithm: "Ed25519";
}

export interface SignedEnvelope<T extends JsonValue = JsonValue> extends UnsignedEnvelope<T> {
  signature: string;
}

export interface AcceptedEnvelopeState {
  readonly namespace: TrustNamespace;
  readonly artifact_kind: string;
  readonly artifact_id: string;
  readonly sequence: number;
  readonly envelope_hash: string;
}

export type EnvelopeFailureReason =
  | "malformed_envelope"
  | "wrong_namespace"
  | "wrong_artifact_kind"
  | "wrong_artifact_id"
  | "invalid_trust_store"
  | "unknown_key"
  | "revoked_key"
  | "retired_key_for_new_acceptance"
  | "key_not_yet_valid"
  | "key_expired"
  | "envelope_not_yet_valid"
  | "envelope_expired"
  | "signature_invalid"
  | "invalid_sequence_state"
  | "replay"
  | "rollback"
  | "sequence_gap"
  | "previous_hash_mismatch";

export interface VerifyEnvelopeOptions<N extends TrustNamespace = TrustNamespace> {
  expected_namespace: N;
  expected_artifact_kind: string;
  expected_artifact_id: string;
  trust_stores: SplitTrustStores;
  accepted_state: AcceptedEnvelopeState | null;
  verification_mode: EnvelopeVerificationMode;
  now: string;
}

export type VerifyEnvelopeResult =
  | {
      ok: true;
      key_status: "active" | "retired";
      envelope_hash: string;
      next_state: Readonly<AcceptedEnvelopeState>;
      verified_envelope: DeepReadonly<SignedEnvelope>;
    }
  | { ok: false; reason: EnvelopeFailureReason };

const ENVELOPE_SCHEMA_VERSION = "1";
const SIGNATURE_ALGORITHM = "Ed25519";
const SIGNING_DOMAIN = "foo.signed-envelope.v1";
const HASH_DOMAIN = "foo.signed-envelope-hash.v1";
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_KIND = /^[a-z0-9][a-z0-9.-]{0,127}$/;

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JSON strings and property names must contain Unicode scalar values");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("JSON strings and property names must contain Unicode scalar values");
    }
  }
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires a finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("canonical JSON refuses a sparse array");
      parts.push(canonicalize(value[index]));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("canonical JSON requires a JSON value");

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("canonical JSON requires a plain JSON object");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("canonical JSON requires string property names");
  }
  const keys = ownKeys as string[];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("canonical JSON requires enumerable data properties");
    }
    assertUnicodeScalars(key);
  }
  keys.sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** RFC 8785 JCS serialization for JSON-domain values. */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value);
}

export function canonicalJsonBytes(value: JsonValue): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string") throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical RFC 3339 timestamp`);
  }
  return parsed;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  assertUnicodeScalars(value);
  return value;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError("signed envelope has missing or unknown fields");
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("signed envelope fields must be enumerable data properties");
    }
  }
}

function assertUnsignedEnvelope(value: UnsignedEnvelope): void {
  if (value.schema_version !== ENVELOPE_SCHEMA_VERSION) throw new TypeError("unsupported envelope schema_version");
  if (value.signature_algorithm !== SIGNATURE_ALGORITHM) throw new TypeError("unsupported signature algorithm");
  if (value.namespace !== "customer" && value.namespace !== "foo") throw new TypeError("invalid trust namespace");
  if (!ARTIFACT_KIND.test(value.artifact_kind)) throw new TypeError("invalid artifact_kind");
  boundedString(value.artifact_id, "artifact_id", 256);
  if (!KEY_ID.test(value.key_id)) throw new TypeError("invalid key_id");
  canonicalJson(value.payload);

  const issuedAt = timestamp(value.issued_at, "issued_at");
  const notBefore = timestamp(value.not_before, "not_before");
  const expiresAt = timestamp(value.expires_at, "expires_at");
  if (notBefore > issuedAt || expiresAt <= issuedAt) throw new TypeError("invalid envelope validity interval");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new TypeError("sequence must be a positive safe integer");
  if (value.sequence === 1 && value.previous_hash !== null) throw new TypeError("first envelope must have no previous_hash");
  if (value.sequence > 1 && (typeof value.previous_hash !== "string" || !HEX_SHA256.test(value.previous_hash))) {
    throw new TypeError("subsequent envelope needs a lowercase SHA-256 previous_hash");
  }
}

const UNSIGNED_FIELDS = [
  "schema_version",
  "namespace",
  "artifact_kind",
  "artifact_id",
  "payload",
  "key_id",
  "issued_at",
  "not_before",
  "expires_at",
  "sequence",
  "previous_hash",
  "signature_algorithm",
] as const;

function parseSignedEnvelope(value: unknown): SignedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("signed envelope must be an object");
  const record = value as Record<string, unknown>;
  exactObjectKeys(record, [...UNSIGNED_FIELDS, "signature"]);
  if (typeof record.signature !== "string") throw new TypeError("signature must be base64");
  const envelope = record as unknown as SignedEnvelope;
  assertUnsignedEnvelope(envelope);
  decodeSignature(envelope.signature);
  return envelope;
}

function deepFreezeOwned<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      deepFreezeOwned((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function ownedSignedEnvelope(value: unknown): SignedEnvelope {
  const parsed = parseSignedEnvelope(value);
  const owned = JSON.parse(canonicalJson(parsed as unknown as JsonValue)) as unknown;
  return parseSignedEnvelope(owned);
}

function unsignedEnvelope(envelope: SignedEnvelope | UnsignedEnvelope): UnsignedEnvelope {
  const { signature: _signature, ...unsigned } = envelope as SignedEnvelope;
  exactObjectKeys(unsigned as unknown as Record<string, unknown>, UNSIGNED_FIELDS);
  assertUnsignedEnvelope(unsigned);
  return unsigned;
}

export function envelopeSigningBytes(envelope: SignedEnvelope | UnsignedEnvelope): Buffer {
  const unsigned = unsignedEnvelope(envelope);
  const prefix = `${SIGNING_DOMAIN}\0${unsigned.namespace}\0${unsigned.artifact_kind}\0`;
  return Buffer.concat([Buffer.from(prefix, "utf8"), canonicalJsonBytes(unsigned as unknown as JsonValue)]);
}

export function envelopeHash(envelope: SignedEnvelope): string {
  const parsed = parseSignedEnvelope(envelope);
  const bytes = Buffer.concat([
    Buffer.from(`${HASH_DOMAIN}\0`, "utf8"),
    canonicalJsonBytes(parsed as unknown as JsonValue),
  ]);
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeSignature(signature: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 !== 0) {
    throw new TypeError("signature must be canonical base64");
  }
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signature) {
    throw new TypeError("signature must be a canonical Ed25519 signature");
  }
  return bytes;
}

export function signEnvelope<T extends JsonValue>(input: EnvelopeInput<T>, privateKeyPem: string): SignedEnvelope<T> {
  const unsigned: UnsignedEnvelope<T> = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    namespace: input.namespace,
    artifact_kind: input.artifact_kind,
    artifact_id: input.artifact_id,
    payload: input.payload,
    key_id: input.key_id,
    issued_at: input.issued_at,
    not_before: input.not_before,
    expires_at: input.expires_at,
    sequence: input.sequence,
    previous_hash: input.previous_hash,
    signature_algorithm: SIGNATURE_ALGORITHM,
  };
  assertUnsignedEnvelope(unsigned);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("signing key must be Ed25519");
  const signature = ed25519Sign(null, envelopeSigningBytes(unsigned), privateKey).toString("base64");
  return { ...unsigned, signature };
}

function validateTrustStore(store: TrustStore, expectedNamespace: TrustNamespace): Map<string, TrustedSigningKey> {
  if (!store || store.namespace !== expectedNamespace || !Array.isArray(store.keys)) {
    throw new TypeError("trust store namespace does not match its configured slot");
  }
  const keys = new Map<string, TrustedSigningKey>();
  for (const key of store.keys) {
    if (!key || typeof key !== "object") throw new TypeError("invalid trusted key");
    exactObjectKeys(key as unknown as Record<string, unknown>, [
      "key_id",
      "public_key_pem",
      "status",
      "valid_from",
      "valid_until",
    ]);
    if (!KEY_ID.test(key.key_id) || keys.has(key.key_id)) throw new TypeError("duplicate or invalid trusted key id");
    if (key.status !== "active" && key.status !== "retired" && key.status !== "revoked") {
      throw new TypeError("invalid trusted key status");
    }
    timestamp(key.valid_from, "trusted key valid_from");
    if (key.valid_until !== null) {
      if (timestamp(key.valid_until, "trusted key valid_until") <= timestamp(key.valid_from, "trusted key valid_from")) {
        throw new TypeError("invalid trusted key validity interval");
      }
    }
    const publicKey = createPublicKey(key.public_key_pem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("trusted key must be Ed25519");
    keys.set(key.key_id, key);
  }
  return keys;
}

function validateAcceptedState(
  state: AcceptedEnvelopeState | null,
  envelope: SignedEnvelope,
): EnvelopeFailureReason | null {
  if (state === null) {
    if (envelope.sequence !== 1) return "sequence_gap";
    if (envelope.previous_hash !== null) return "previous_hash_mismatch";
    return null;
  }
  const shapeFailure = validateAcceptedStateShape(state, envelope);
  if (shapeFailure) return shapeFailure;
  if (envelope.sequence < state.sequence) return "rollback";
  if (envelope.sequence === state.sequence) return "replay";
  if (envelope.sequence !== state.sequence + 1) return "sequence_gap";
  if (envelope.previous_hash !== state.envelope_hash) return "previous_hash_mismatch";
  return null;
}

function validateRevalidationState(
  state: AcceptedEnvelopeState | null,
  envelope: SignedEnvelope,
  hash: string,
): EnvelopeFailureReason | null {
  if (state === null) return "invalid_sequence_state";
  const shapeFailure = validateAcceptedStateShape(state, envelope);
  if (shapeFailure) return shapeFailure;
  if (state.sequence !== envelope.sequence || state.envelope_hash !== hash) return "invalid_sequence_state";
  return null;
}

function validateAcceptedStateShape(
  state: AcceptedEnvelopeState,
  envelope: SignedEnvelope,
): EnvelopeFailureReason | null {
  try {
    exactObjectKeys(state as unknown as Record<string, unknown>, [
      "namespace",
      "artifact_kind",
      "artifact_id",
      "sequence",
      "envelope_hash",
    ]);
  } catch {
    return "invalid_sequence_state";
  }
  if ((state.namespace !== "customer" && state.namespace !== "foo")
    || !ARTIFACT_KIND.test(state.artifact_kind)
    || typeof state.artifact_id !== "string"
    || !Number.isSafeInteger(state.sequence) || state.sequence < 1
    || !HEX_SHA256.test(state.envelope_hash)) {
    return "invalid_sequence_state";
  }
  if (state.namespace !== envelope.namespace
    || state.artifact_kind !== envelope.artifact_kind
    || state.artifact_id !== envelope.artifact_id) {
    return "invalid_sequence_state";
  }
  return null;
}

export function verifyEnvelope(envelopeValue: unknown, options: VerifyEnvelopeOptions): VerifyEnvelopeResult {
  let envelope: SignedEnvelope;
  try {
    envelope = ownedSignedEnvelope(envelopeValue);
    timestamp(options.now, "verification now");
  } catch {
    return { ok: false, reason: "malformed_envelope" };
  }

  if (envelope.namespace !== options.expected_namespace) return { ok: false, reason: "wrong_namespace" };
  if (envelope.artifact_kind !== options.expected_artifact_kind) return { ok: false, reason: "wrong_artifact_kind" };
  if (envelope.artifact_id !== options.expected_artifact_id) return { ok: false, reason: "wrong_artifact_id" };

  let keys: Map<string, TrustedSigningKey>;
  try {
    const customerKeys = validateTrustStore(options.trust_stores.customer, "customer");
    const fooKeys = validateTrustStore(options.trust_stores.foo, "foo");
    keys = options.expected_namespace === "customer" ? customerKeys : fooKeys;
  } catch {
    return { ok: false, reason: "invalid_trust_store" };
  }
  const trustedKey = keys.get(envelope.key_id);
  if (!trustedKey) return { ok: false, reason: "unknown_key" };
  if (trustedKey.status === "revoked") return { ok: false, reason: "revoked_key" };

  const issuedAt = Date.parse(envelope.issued_at);
  const now = Date.parse(options.now);
  if (issuedAt < Date.parse(trustedKey.valid_from)) return { ok: false, reason: "key_not_yet_valid" };
  if (trustedKey.valid_until !== null && issuedAt >= Date.parse(trustedKey.valid_until)) {
    return { ok: false, reason: "key_expired" };
  }
  if (now < Date.parse(envelope.not_before) || now < issuedAt) return { ok: false, reason: "envelope_not_yet_valid" };
  if (now >= Date.parse(envelope.expires_at)) return { ok: false, reason: "envelope_expired" };

  let signatureOk = false;
  try {
    const publicKey = createPublicKey(trustedKey.public_key_pem);
    signatureOk = ed25519Verify(null, envelopeSigningBytes(envelope), publicKey, decodeSignature(envelope.signature));
  } catch {
    return { ok: false, reason: "invalid_trust_store" };
  }
  if (!signatureOk) return { ok: false, reason: "signature_invalid" };

  const hash = envelopeHash(envelope);
  let sequenceFailure: EnvelopeFailureReason | null;
  if (options.verification_mode === "accept") {
    if (trustedKey.status === "retired") return { ok: false, reason: "retired_key_for_new_acceptance" };
    sequenceFailure = validateAcceptedState(options.accepted_state, envelope);
  } else if (options.verification_mode === "revalidate") {
    sequenceFailure = validateRevalidationState(options.accepted_state, envelope, hash);
  } else {
    return { ok: false, reason: "invalid_sequence_state" };
  }
  if (sequenceFailure) return { ok: false, reason: sequenceFailure };

  const nextState = Object.freeze({
    namespace: envelope.namespace,
    artifact_kind: envelope.artifact_kind,
    artifact_id: envelope.artifact_id,
    sequence: envelope.sequence,
    envelope_hash: hash,
  });
  const verifiedEnvelope = deepFreezeOwned(envelope);
  return Object.freeze({
    ok: true,
    key_status: trustedKey.status,
    envelope_hash: hash,
    next_state: nextState,
    verified_envelope: verifiedEnvelope,
  });
}
