import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalBytes, parseBugCapsule, parseDeliveryReceipt, payloadDigest, uuidV7 } from "../src/bugCapsule.js";

const capsule = JSON.parse(readFileSync("test/fixtures/bug-capsule/capsule.valid.json", "utf8"));
const canonical = readFileSync("test/fixtures/bug-capsule/capsule.valid.canonical.json");
const receipt = JSON.parse(readFileSync("test/fixtures/bug-capsule/receipt.accepted.json", "utf8"));

test("BugCapsule 0.1 has byte-stable RFC 8785 serialization", () => {
  assert.deepEqual(canonicalBytes(parseBugCapsule(capsule)), canonical);
  assert.match(payloadDigest(parseBugCapsule(capsule)), /^sha256:[0-9a-f]{64}$/);
  assert.equal(payloadDigest(parseBugCapsule(capsule)), payloadDigest(parseBugCapsule({ ...capsule, extensions: { foo: capsule.extensions.foo } })));
});

test("unknown extension namespaces survive parsing and canonically bind the payload", () => {
  const futureCapsule = {
    ...capsule,
    extensions: { ...capsule.extensions, "example.future": { migration: "v1", enabled: true } },
  };
  const parsed = parseBugCapsule(futureCapsule);
  const reordered = parseBugCapsule({
    ...capsule,
    extensions: { "example.future": { enabled: true, migration: "v1" }, ...capsule.extensions },
  });

  assert.deepEqual(parsed.extensions["example.future"], { migration: "v1", enabled: true });
  assert.deepEqual(canonicalBytes(parsed), canonicalBytes(reordered));
  assert.equal(payloadDigest(parsed), payloadDigest(reordered));
  assert.notDeepEqual(canonicalBytes(parsed), canonicalBytes(parseBugCapsule(capsule)));
  assert.notEqual(payloadDigest(parsed), payloadDigest(parseBugCapsule(capsule)));
});

test("UUIDv7 carries the requested millisecond and RFC variant", () => {
  const id = uuidV7(1_721_350_000_123, Buffer.alloc(10, 0x2a));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16), 1_721_350_000_123);
});

test("receipt and capsule reject unknown top-level fields and illegal states", () => {
  assert.throws(() => parseBugCapsule(null), /BugCapsule must be an object/);
  assert.throws(() => parseBugCapsule({ ...capsule, surprise: true }), /unknown BugCapsule field: surprise/);
  assert.throws(() => parseBugCapsule({ ...capsule, schema_version: "1.0" }), /schema_version must be 0.1/);
  assert.throws(() => parseBugCapsule({ ...capsule, capsule_id: "not-a-uuid" }), /UUIDv7/);
  assert.throws(() => parseBugCapsule({ ...capsule, report: { ...capsule.report, expected: { state: "collected" } } }), /collected field requires value/);
  assert.throws(() => parseBugCapsule({ ...capsule, report: { ...capsule.report, expected: { state: "withheld", value: "secret" } } }), /non-collected field cannot contain value/);
  assert.throws(() => parseBugCapsule({ ...capsule, occurred_at: "2026-07-19" }), /RFC 3339 UTC/);
  assert.throws(() => parseBugCapsule({ ...capsule, evidence: Array.from({ length: 101 }, () => capsule.evidence[0]) }), /at most 100 entries/);
  assert.throws(() => parseBugCapsule({ ...capsule, producer: { ...capsule.producer, name: "x".repeat(4097) } }), /at most 4096 characters/);
  assert.throws(() => parseDeliveryReceipt({ ...receipt, surprise: true }), /unknown DeliveryReceipt field: surprise/);
  assert.throws(() => parseDeliveryReceipt({ ...receipt, payload_digest: "sha256:bad" }), /payload_digest must be a lowercase SHA-256 digest/);
  assert.throws(() => parseDeliveryReceipt({ ...receipt, error: { code: "E_IO", message: "no" } }), /accepted receipt requires error to be null/);
  assert.deepEqual(parseDeliveryReceipt(receipt), receipt);
  assert.equal(parseDeliveryReceipt(receipt).payload_digest, payloadDigest(parseBugCapsule(capsule)));
});

test("BugCapsule accepts RFC 3339 UTC timestamps without fractional seconds", () => {
  assert.equal(parseBugCapsule({ ...capsule, occurred_at: "2026-07-19T00:00:00Z" }).occurred_at, "2026-07-19T00:00:00Z");
});
