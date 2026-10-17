import { createHash, randomBytes } from "node:crypto";
import type { ErrorClass, ErrorCode } from "./errorTaxonomy.js";

export type FieldValue =
  | { state: "collected"; value: string }
  | { state: "not_collected" | "withheld" | "unavailable"; reason: string };

export type BugCapsule = {
  schema_version: "0.1";
  capsule_id: string;
  occurred_at: string;
  producer: { name: string; version: string };
  product: { name: string; component: string; version: string };
  invocation: { command: string; runtime: { node: string; platform: string; arch: string } };
  failure: {
    class: ErrorClass;
    code: ErrorCode;
    classifier_version: "0.1";
    classification: "known" | "fallback";
    message: FieldValue;
    stack: FieldValue;
  };
  report: { expected: FieldValue; actual: FieldValue; reproduction: FieldValue };
  evidence: Array<{ kind: "diagnostic" | "user_report"; state: FieldValue["state"]; content_type: string }>;
  similarity: { version: "0.1"; signals: Array<{ kind: "error_fingerprint"; value: string }> };
  links: Array<{ relation: string; provider: string; external_id: string; provenance: "reporter_observed"; authority: "reference" }>;
  extensions: Record<string, unknown> & { foo?: { spec_context?: { spec_id: string; packet_path: string; revision?: string; requirement_ids: string[]; task_ids: string[]; provenance: "reporter_observed" } } };
};

/** Historical delivery metadata retained so existing local archives remain readable. */
export type DeliveryReceipt = {
  schema_version: "0.1";
  receipt_id: string;
  capsule_id: string;
  payload_digest: string;
  accepted_at: string;
  destination: string;
  status: "accepted" | "rejected" | "retryable";
  error: null | { code: string; message: string; retry_after?: string };
};

const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_LENGTH = 100;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC_3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const SHA_256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ERROR_CLASSES = new Set<ErrorClass>(["none", "usage_error", "gate_block", "not_found", "io_error", "command_error"]);
const ERROR_CODES = new Set<ErrorCode>([
  "E_COMMAND_MISSING", "E_PACKET_DIR_MISSING", "E_SWARM_TARGET_MISSING", "E_IDEATE_IDEA_MISSING", "E_SPEC_WORK_MISSING", "E_UNKNOWN_DOMAIN", "E_BAD_FLAG", "E_NOT_A_RESEARCH_PAPER",
  "E_PACKET_NOT_FOUND", "E_SPEC_NOT_FOUND", "E_SKILL_NOT_FOUND",
  "E_GATE_B1_SECRET", "E_GATE_B2_SPEC_ID", "E_GATE_B4_BUDGET", "E_GATE_B5_UNGOVERNED", "E_GATE_B5_CLAIM_UNLABELED", "E_GATE_BLOCKED", "E_GATE_INTERVIEW", "E_CONTRACT_DRIFT",
  "E_IO", "E_UNKNOWN",
]);

function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${jcs(source[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON refuses ${typeof value}`);
}

export function canonicalBytes(capsule: BugCapsule): Buffer {
  return Buffer.from(jcs(capsule), "utf8");
}

export function payloadDigest(capsule: BugCapsule): string {
  return `sha256:${createHash("sha256").update(canonicalBytes(capsule)).digest("hex")}`;
}

export function uuidV7(nowMs = Date.now(), entropy: Buffer = randomBytes(10)): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) throw new Error("UUIDv7 timestamp must fit in 48 bits");
  if (entropy.length !== 10) throw new Error("UUIDv7 entropy must be 10 bytes");
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  entropy.copy(bytes, 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function closedObject(value: unknown, label: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  const source = object(value, label);
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
  for (const key of required) {
    if (!(key in source)) throw new Error(`${label} field is required: ${key}`);
  }
  return source;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > MAX_STRING_LENGTH) throw new Error(`${label} must be at most ${MAX_STRING_LENGTH} characters`);
  return value;
}

function boundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_ARRAY_LENGTH) throw new Error(`${label} must contain at most ${MAX_ARRAY_LENGTH} entries`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = boundedString(value, label);
  if (!UUID_V7.test(parsed)) throw new Error(`${label} must be a UUIDv7`);
  return parsed;
}

function rfc3339(value: unknown, label: string): string {
  const parsed = boundedString(value, label);
  const match = RFC_3339_UTC.exec(parsed);
  const date = new Date(parsed);
  if (
    match === null ||
    Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(`${label} must be RFC 3339 UTC`);
  }
  return parsed;
}

function fieldValue(value: unknown, label: string): FieldValue {
  const source = object(value, label);
  const state = source.state;
  if (state === "collected") {
    if (!("value" in source)) throw new Error("collected field requires value");
    const collected = closedObject(source, label, ["state", "value"]);
    return { state, value: boundedString(collected.value, `${label}.value`) };
  }
  if (state === "not_collected" || state === "withheld" || state === "unavailable") {
    if ("value" in source) throw new Error("non-collected field cannot contain value");
    const absent = closedObject(source, label, ["state", "reason"]);
    return { state, reason: boundedString(absent.reason, `${label}.reason`) };
  }
  throw new Error(`${label}.state is invalid`);
}

function requiredStringFields(value: unknown, label: string, fields: readonly string[]): void {
  const source = closedObject(value, label, fields);
  for (const field of fields) boundedString(source[field], `${label}.${field}`);
}

export function parseBugCapsule(value: unknown): BugCapsule {
  const capsule = closedObject(value, "BugCapsule", [
    "schema_version", "capsule_id", "occurred_at", "producer", "product", "invocation", "failure", "report", "evidence", "similarity", "links", "extensions",
  ]);
  if (capsule.schema_version !== "0.1") throw new Error("BugCapsule.schema_version must be 0.1");
  uuid(capsule.capsule_id, "BugCapsule.capsule_id");
  rfc3339(capsule.occurred_at, "BugCapsule.occurred_at");
  requiredStringFields(capsule.producer, "BugCapsule.producer", ["name", "version"]);
  requiredStringFields(capsule.product, "BugCapsule.product", ["name", "component", "version"]);
  const invocation = closedObject(capsule.invocation, "BugCapsule.invocation", ["command", "runtime"]);
  boundedString(invocation.command, "BugCapsule.invocation.command");
  requiredStringFields(invocation.runtime, "BugCapsule.invocation.runtime", ["node", "platform", "arch"]);

  const failure = closedObject(capsule.failure, "BugCapsule.failure", ["class", "code", "classifier_version", "classification", "message", "stack"]);
  if (!ERROR_CLASSES.has(failure.class as ErrorClass)) throw new Error("BugCapsule.failure.class is invalid");
  if (!ERROR_CODES.has(failure.code as ErrorCode)) throw new Error("BugCapsule.failure.code is invalid");
  if (failure.classifier_version !== "0.1") throw new Error("BugCapsule.failure.classifier_version must be 0.1");
  if (failure.classification !== "known" && failure.classification !== "fallback") throw new Error("BugCapsule.failure.classification is invalid");
  fieldValue(failure.message, "BugCapsule.failure.message");
  fieldValue(failure.stack, "BugCapsule.failure.stack");

  const report = closedObject(capsule.report, "BugCapsule.report", ["expected", "actual", "reproduction"]);
  fieldValue(report.expected, "BugCapsule.report.expected");
  fieldValue(report.actual, "BugCapsule.report.actual");
  fieldValue(report.reproduction, "BugCapsule.report.reproduction");

  for (const [index, entry] of boundedArray(capsule.evidence, "BugCapsule.evidence").entries()) {
    const evidence = closedObject(entry, `BugCapsule.evidence[${index}]`, ["kind", "state", "content_type"]);
    if (evidence.kind !== "diagnostic" && evidence.kind !== "user_report") throw new Error(`BugCapsule.evidence[${index}].kind is invalid`);
    if (!["collected", "not_collected", "withheld", "unavailable"].includes(String(evidence.state))) throw new Error(`BugCapsule.evidence[${index}].state is invalid`);
    boundedString(evidence.content_type, `BugCapsule.evidence[${index}].content_type`);
  }

  const similarity = closedObject(capsule.similarity, "BugCapsule.similarity", ["version", "signals"]);
  if (similarity.version !== "0.1") throw new Error("BugCapsule.similarity.version must be 0.1");
  for (const [index, signal] of boundedArray(similarity.signals, "BugCapsule.similarity.signals").entries()) {
    const parsed = closedObject(signal, `BugCapsule.similarity.signals[${index}]`, ["kind", "value"]);
    if (parsed.kind !== "error_fingerprint") throw new Error(`BugCapsule.similarity.signals[${index}].kind is invalid`);
    boundedString(parsed.value, `BugCapsule.similarity.signals[${index}].value`);
  }

  for (const [index, link] of boundedArray(capsule.links, "BugCapsule.links").entries()) {
    const parsed = closedObject(link, `BugCapsule.links[${index}]`, ["relation", "provider", "external_id", "provenance", "authority"]);
    boundedString(parsed.relation, `BugCapsule.links[${index}].relation`);
    boundedString(parsed.provider, `BugCapsule.links[${index}].provider`);
    boundedString(parsed.external_id, `BugCapsule.links[${index}].external_id`);
    if (parsed.provenance !== "reporter_observed") throw new Error(`BugCapsule.links[${index}].provenance is invalid`);
    if (parsed.authority !== "reference") throw new Error(`BugCapsule.links[${index}].authority is invalid`);
  }

  const extensions = object(capsule.extensions, "BugCapsule.extensions");
  if (extensions.foo !== undefined) {
    const foo = closedObject(extensions.foo, "BugCapsule.extensions.foo", ["spec_context"], []);
    if (foo.spec_context !== undefined) {
      const context = closedObject(
        foo.spec_context,
        "BugCapsule.extensions.foo.spec_context",
        ["spec_id", "packet_path", "revision", "requirement_ids", "task_ids", "provenance"],
        ["spec_id", "packet_path", "requirement_ids", "task_ids", "provenance"],
      );
      boundedString(context.spec_id, "BugCapsule.extensions.foo.spec_context.spec_id");
      boundedString(context.packet_path, "BugCapsule.extensions.foo.spec_context.packet_path");
      if (context.revision !== undefined) boundedString(context.revision, "BugCapsule.extensions.foo.spec_context.revision");
      for (const [index, requirement] of boundedArray(context.requirement_ids, "BugCapsule.extensions.foo.spec_context.requirement_ids").entries()) boundedString(requirement, `BugCapsule.extensions.foo.spec_context.requirement_ids[${index}]`);
      for (const [index, task] of boundedArray(context.task_ids, "BugCapsule.extensions.foo.spec_context.task_ids").entries()) boundedString(task, `BugCapsule.extensions.foo.spec_context.task_ids[${index}]`);
      if (context.provenance !== "reporter_observed") throw new Error("BugCapsule.extensions.foo.spec_context.provenance is invalid");
    }
  }
  return capsule as BugCapsule;
}

export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  const receipt = closedObject(value, "DeliveryReceipt", ["schema_version", "receipt_id", "capsule_id", "payload_digest", "accepted_at", "destination", "status", "error"]);
  if (receipt.schema_version !== "0.1") throw new Error("DeliveryReceipt.schema_version must be 0.1");
  uuid(receipt.receipt_id, "DeliveryReceipt.receipt_id");
  uuid(receipt.capsule_id, "DeliveryReceipt.capsule_id");
  const digest = boundedString(receipt.payload_digest, "DeliveryReceipt.payload_digest");
  if (!SHA_256_DIGEST.test(digest)) throw new Error("DeliveryReceipt.payload_digest must be a lowercase SHA-256 digest");
  rfc3339(receipt.accepted_at, "DeliveryReceipt.accepted_at");
  boundedString(receipt.destination, "DeliveryReceipt.destination");
  if (receipt.status !== "accepted" && receipt.status !== "rejected" && receipt.status !== "retryable") throw new Error("DeliveryReceipt.status is invalid");
  if (receipt.status === "accepted") {
    if (receipt.error !== null) throw new Error("accepted receipt requires error to be null");
  } else {
    const error = closedObject(receipt.error, "DeliveryReceipt.error", ["code", "message", "retry_after"], ["code", "message"]);
    boundedString(error.code, "DeliveryReceipt.error.code");
    boundedString(error.message, "DeliveryReceipt.error.message");
    if (error.retry_after !== undefined) rfc3339(error.retry_after, "DeliveryReceipt.error.retry_after");
  }
  return receipt as DeliveryReceipt;
}
