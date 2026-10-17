import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalBytes, parseBugCapsule, parseDeliveryReceipt, payloadDigest } from "../src/bugCapsule.js";

test("standalone schemas are shipped and close the public top level", () => {
  const capsuleSchema = JSON.parse(readFileSync("schemas/bug-capsule.schema.json", "utf8"));
  const receiptSchema = JSON.parse(readFileSync("schemas/bug-capsule-receipt.schema.json", "utf8"));
  assert.equal(capsuleSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(receiptSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(capsuleSchema.additionalProperties, false);
  assert.equal(receiptSchema.additionalProperties, false);
  assert.ok((JSON.parse(readFileSync("package.json", "utf8")).files as string[]).includes("schemas"));
});

test("independent local sink preserves exact bytes and digest", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-capsule-sink-"));
  const capsule = parseBugCapsule(JSON.parse(readFileSync("test/fixtures/bug-capsule/capsule.valid.json", "utf8")));
  const file = path.join(dir, `${capsule.capsule_id}.json`);
  writeFileSync(file, canonicalBytes(capsule));
  assert.deepEqual(readFileSync(file), canonicalBytes(capsule));
  assert.equal(`sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`, payloadDigest(capsule));
});

test("independent local sink preserves and validates a delivery receipt", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-receipt-sink-"));
  const receipt = parseDeliveryReceipt(JSON.parse(readFileSync("test/fixtures/bug-capsule/receipt.accepted.json", "utf8")));
  const bytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const file = path.join(dir, `${receipt.receipt_id}.json`);
  writeFileSync(file, bytes);
  const restoredBytes = readFileSync(file);
  assert.deepEqual(restoredBytes, bytes);
  assert.deepEqual(parseDeliveryReceipt(JSON.parse(restoredBytes.toString("utf8"))), receipt);
});
