import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalBytes,
  parseBugCapsule,
  parseDeliveryReceipt,
  payloadDigest,
  type BugCapsule,
  type DeliveryReceipt,
} from "./bugCapsule.js";

export type LocalBugRecord = {
  schema_version: "0.1";
  capsule: BugCapsule;
  payload_digest: string;
  state: "pending" | "accepted" | "delete_retryable";
  preview: null | { payload_digest: string; destination: string | null; previewed_at: string };
  receipt: DeliveryReceipt | null;
};

export type LocalBugRecordMetadata = {
  capsule_id: string;
  payload_digest: string;
  state: LocalBugRecord["state"];
  previewed_at: string | null;
  receipt_id: string | null;
};

export type LocalBugRecordList = {
  records: LocalBugRecordMetadata[];
  corrupt: string[];
};

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const RFC_3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function capsuleId(value: string): string {
  if (!UUID_V7.test(value)) throw new Error("capsule ID must be a UUIDv7");
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be RFC 3339 UTC`);
  const match = RFC_3339_UTC.exec(value);
  const date = new Date(value);
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
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const parsed = object(value, label);
  for (const key of Object.keys(parsed)) {
    if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
  for (const key of keys) {
    if (!(key in parsed)) throw new Error(`${label} field is required: ${key}`);
  }
  return parsed;
}

function revalidateDirectoryPath(directory: string, opened: ReturnType<typeof fstatSync>): void {
  let current;
  try {
    current = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`local report directory changed while in use: ${path.basename(directory)}`);
    }
    throw error;
  }
  if (current.isSymbolicLink()) throw new Error(`local report directory cannot be a symbolic link: ${path.basename(directory)}`);
  if (!current.isDirectory()) throw new Error(`local report path is not a directory: ${path.basename(directory)}`);
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error(`local report directory changed while in use: ${path.basename(directory)}`);
  }
}

function pathEntryExists(entryPath: string): boolean {
  try {
    lstatSync(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensurePrivateDirectory(directory: string): void {
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error(`local report path is not a directory: ${path.basename(directory)}`);
    fchmodSync(descriptor, 0o700);
    if (created) fsyncSync(descriptor);
    revalidateDirectoryPath(directory, opened);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error(`local report directory cannot be a symbolic link: ${path.basename(directory)}`);
    if (code === "ENOTDIR") throw new Error(`local report path is not a directory: ${path.basename(directory)}`);
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  if (created) durableDirectory(path.dirname(directory));
}

type StoreKind = "pending" | "previews" | "archive" | "deleted" | "remote-deleted";

function storeDirectory(root: string, kind: StoreKind, create: boolean): string | null {
  const base = path.resolve(root);
  const directories = [path.join(base, ".foo"), path.join(base, ".foo", "reports"), path.join(base, ".foo", "reports", kind)];
  for (const directory of directories) {
    if (!pathEntryExists(directory) && !create) return null;
    ensurePrivateDirectory(directory);
  }
  return directories.at(-1)!;
}

function recordPath(root: string, kind: StoreKind, id: string, createDirectory: boolean): string | null {
  const directory = storeDirectory(root, kind, createDirectory);
  return directory === null ? null : path.join(directory, `${capsuleId(id)}.json`);
}

function durableDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error(`local report path is not a directory: ${path.basename(directory)}`);
    fsyncSync(descriptor);
    revalidateDirectoryPath(directory, opened);
  } finally {
    closeSync(descriptor);
  }
}

function publishOnce(file: string, value: unknown): "created" | "exists" {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  let result: "created" | "exists" | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    try {
      linkSync(temporary, file);
      result = "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result = "exists";
    }
    unlinkSync(temporary);
    durableDirectory(path.dirname(file));
    return result;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function pathExists(file: string | null): file is string {
  if (file === null) return false;
  return pathEntryExists(file);
}

function readJsonWithoutFollowingLinks(file: string): unknown {
  const pathStat = lstatSync(file);
  if (pathStat.isSymbolicLink()) throw new Error(`local bug record cannot be a symbolic link: ${path.basename(file)}`);
  if (!pathStat.isFile()) throw new Error(`local bug record is not a regular file: ${path.basename(file)}`);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`local bug record is not a regular file: ${path.basename(file)}`);
    const serialized = readFileSync(descriptor, "utf8");
    try {
      return JSON.parse(serialized);
    } catch {
      throw new Error(`corrupt local bug record: ${path.basename(file)}`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseLocalBugRecord(value: unknown, expectedId?: string): LocalBugRecord {
  const source = exactObject(
    value,
    "LocalBugRecord",
    ["schema_version", "capsule", "payload_digest", "state", "preview", "receipt"],
  );
  if (source.schema_version !== "0.1") throw new Error("LocalBugRecord.schema_version must be 0.1");
  const capsule = parseBugCapsule(source.capsule);
  if (expectedId !== undefined && capsule.capsule_id !== expectedId) throw new Error("stored capsule ID mismatch");
  if (typeof source.payload_digest !== "string" || !SHA_256_DIGEST.test(source.payload_digest)) {
    throw new Error("LocalBugRecord.payload_digest must be a lowercase SHA-256 digest");
  }
  const computedDigest = payloadDigest(capsule);
  if (source.payload_digest !== computedDigest) throw new Error("stored payload digest mismatch");
  if (source.state !== "pending" && source.state !== "accepted" && source.state !== "delete_retryable") {
    throw new Error("LocalBugRecord.state is invalid");
  }

  let preview: LocalBugRecord["preview"] = null;
  if (source.preview !== null) {
    const loosePreview = object(source.preview, "LocalBugRecord.preview");
    const parsed = exactObject(
      source.preview,
      "LocalBugRecord.preview",
      "destination" in loosePreview ? ["payload_digest", "destination", "previewed_at"] : ["payload_digest", "previewed_at"],
    );
    if (parsed.payload_digest !== computedDigest) throw new Error("stored preview digest mismatch");
    if (parsed.destination !== undefined && (typeof parsed.destination !== "string" || parsed.destination.length === 0)) {
      throw new Error("stored preview destination is invalid");
    }
    preview = {
      payload_digest: parsed.payload_digest,
      destination: typeof parsed.destination === "string" ? parsed.destination : null,
      previewed_at: timestamp(parsed.previewed_at, "LocalBugRecord.preview.previewed_at"),
    } as LocalBugRecord["preview"];
  }

  const receipt = source.receipt === null ? null : parseDeliveryReceipt(source.receipt);
  if (source.state === "pending" && receipt !== null) throw new Error("pending record cannot contain a receipt");
  if (source.state !== "pending") {
    if (receipt === null || receipt.status !== "accepted") throw new Error(`${source.state} record requires an accepted receipt`);
    if (receipt.capsule_id !== capsule.capsule_id) throw new Error("stored receipt capsule ID mismatch");
    if (receipt.payload_digest !== computedDigest) throw new Error("stored receipt payload digest mismatch");
  }

  return {
    schema_version: "0.1",
    capsule,
    payload_digest: computedDigest,
    state: source.state,
    preview,
    receipt,
  };
}

function readRecord(file: string, expectedId: string): LocalBugRecord {
  const value = readJsonWithoutFollowingLinks(file);
  try {
    return parseLocalBugRecord(value, expectedId);
  } catch {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
}

function metadata(record: LocalBugRecord): LocalBugRecordMetadata {
  return {
    capsule_id: record.capsule.capsule_id,
    payload_digest: record.payload_digest,
    state: record.state,
    previewed_at: record.preview?.previewed_at ?? null,
    receipt_id: record.receipt?.receipt_id ?? null,
  };
}

type PreviewMetadata = {
  schema_version: "0.1";
  capsule_id: string;
  payload_digest: string;
  destination: string | null;
  previewed_at: string;
};

type AcceptingDecision = {
  schema_version: "0.1";
  kind: "accepting";
  capsule_id: string;
  payload_digest: string;
  receipt: DeliveryReceipt;
};

type DeletedDecision = {
  schema_version: "0.1";
  kind: "deleted";
  capsule_id: string;
  payload_digest: string;
};

type TerminalDecision = AcceptingDecision | DeletedDecision;

export type ArchiveDeletionMarker = {
  schema_version: "0.1";
  kind: "remote_deletion_confirmed" | "local_archive_deleted";
  capsule_id: string;
  payload_digest: string;
  receipt_id: string;
  destination: string;
};

export function getArchiveDeletionMarker(
  root: string,
  id: string,
  digest?: string,
): ArchiveDeletionMarker | null {
  capsuleId(id);
  if (digest !== undefined && !SHA_256_DIGEST.test(digest)) {
    throw new Error("payload digest must be a lowercase SHA-256 digest");
  }
  const file = recordPath(root, "remote-deleted", id, false);
  if (!pathExists(file)) return null;
  const confirmation = readRemoteDeletionConfirmation(file, id);
  if (digest !== undefined && confirmation.payload_digest !== digest) {
    throw new Error(`remote deletion digest mismatch: ${id}`);
  }
  return confirmation;
}

function readRemoteDeletionConfirmation(
  file: string,
  expectedId: string,
  expectedDigest?: string,
): ArchiveDeletionMarker {
  const value = readJsonWithoutFollowingLinks(file);
  try {
    const source = exactObject(value, "RemoteDeletionConfirmation", [
      "schema_version", "kind", "capsule_id", "payload_digest", "receipt_id", "destination",
    ]);
    if (source.schema_version !== "0.1") throw new Error("RemoteDeletionConfirmation.schema_version must be 0.1");
    if (source.kind !== "remote_deletion_confirmed" && source.kind !== "local_archive_deleted") throw new Error("RemoteDeletionConfirmation.kind is invalid");
    if (source.capsule_id !== expectedId) throw new Error("remote deletion capsule ID mismatch");
    if (typeof source.payload_digest !== "string" || !SHA_256_DIGEST.test(source.payload_digest)) {
      throw new Error("RemoteDeletionConfirmation.payload_digest must be a lowercase SHA-256 digest");
    }
    if (expectedDigest !== undefined && source.payload_digest !== expectedDigest) {
      throw new Error(`remote deletion digest mismatch: ${expectedId}`);
    }
    if (typeof source.receipt_id !== "string" || source.receipt_id.length === 0) {
      throw new Error("RemoteDeletionConfirmation.receipt_id must be a string");
    }
    if (typeof source.destination !== "string" || source.destination.length === 0) {
      throw new Error("RemoteDeletionConfirmation.destination must be a string");
    }
    return source as ArchiveDeletionMarker;
  } catch {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
}

function readPreviewMetadata(file: string, expectedId: string, expectedDigest: string): PreviewMetadata {
  const value = readJsonWithoutFollowingLinks(file);
  try {
    const loose = object(value, "PreviewMetadata");
    const source = exactObject(
      value,
      "PreviewMetadata",
      "destination" in loose
        ? ["schema_version", "capsule_id", "payload_digest", "destination", "previewed_at"]
        : ["schema_version", "capsule_id", "payload_digest", "previewed_at"],
    );
    if (source.schema_version !== "0.1") throw new Error("PreviewMetadata.schema_version must be 0.1");
    if (source.capsule_id !== expectedId) throw new Error("stored preview capsule ID mismatch");
    if (source.payload_digest !== expectedDigest) throw new Error("stored preview digest mismatch");
    if (source.destination !== undefined && (typeof source.destination !== "string" || source.destination.length === 0)) {
      throw new Error("stored preview destination is invalid");
    }
    return {
      schema_version: "0.1",
      capsule_id: expectedId,
      payload_digest: expectedDigest,
      destination: typeof source.destination === "string" ? source.destination : null,
      previewed_at: timestamp(source.previewed_at, "PreviewMetadata.previewed_at"),
    };
  } catch {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
}

function readTerminalDecision(file: string, expectedId: string, expectedDigest?: string): TerminalDecision {
  const value = readJsonWithoutFollowingLinks(file);
  try {
    const loose = object(value, "TerminalDecision");
    const keys = loose.kind === "accepting"
      ? ["schema_version", "kind", "capsule_id", "payload_digest", "receipt"]
      : ["schema_version", "kind", "capsule_id", "payload_digest"];
    const source = exactObject(value, "TerminalDecision", keys);
    if (source.schema_version !== "0.1") throw new Error("TerminalDecision.schema_version must be 0.1");
    if (source.kind !== "accepting" && source.kind !== "deleted") throw new Error("TerminalDecision.kind is invalid");
    if (source.capsule_id !== expectedId) throw new Error("stored terminal capsule ID mismatch");
    if (typeof source.payload_digest !== "string" || !SHA_256_DIGEST.test(source.payload_digest)) {
      throw new Error("TerminalDecision.payload_digest must be a lowercase SHA-256 digest");
    }
    if (expectedDigest !== undefined && source.payload_digest !== expectedDigest) {
      throw new Error("stored terminal digest mismatch");
    }
    if (source.kind === "accepting") {
      const receipt = parseDeliveryReceipt(source.receipt);
      if (receipt.status !== "accepted") throw new Error("accepting decision requires an accepted receipt");
      if (receipt.capsule_id !== expectedId) throw new Error("terminal receipt capsule ID mismatch");
      if (receipt.payload_digest !== source.payload_digest) throw new Error("terminal receipt payload digest mismatch");
      return {
        schema_version: "0.1",
        kind: "accepting",
        capsule_id: expectedId,
        payload_digest: source.payload_digest,
        receipt,
      };
    }
    return {
      schema_version: "0.1",
      kind: "deleted",
      capsule_id: expectedId,
      payload_digest: source.payload_digest,
    };
  } catch {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
}

function pendingRecord(root: string, id: string): { file: string; record: LocalBugRecord } {
  const file = recordPath(root, "pending", id, false);
  if (!pathExists(file)) throw new Error(`pending capsule not found: ${capsuleId(id)}`);
  const record = readRecord(file, id);
  if (record.state !== "pending" || record.preview !== null || record.receipt !== null) {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
  return { file, record };
}

function withPreview(root: string, record: LocalBugRecord): LocalBugRecord {
  const id = record.capsule.capsule_id;
  const previewFile = recordPath(root, "previews", id, false);
  if (!pathExists(previewFile)) return record;
  const preview = readPreviewMetadata(previewFile, id, record.payload_digest);
  return {
    ...record,
    preview: { payload_digest: preview.payload_digest, destination: preview.destination, previewed_at: preview.previewed_at },
  };
}

function recoverableAcceptedRecord(root: string, decision: AcceptingDecision): LocalBugRecord {
  const { file, record } = pendingRecord(root, decision.capsule_id);
  if (record.payload_digest !== decision.payload_digest) {
    throw new Error(`corrupt local bug record: ${path.basename(file)}`);
  }
  return {
    ...withPreview(root, record),
    state: "accepted",
    receipt: decision.receipt,
  };
}

function unlinkDurably(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  durableDirectory(path.dirname(file));
}

function cleanupPending(root: string, id: string, digest: string): void {
  const pendingFile = recordPath(root, "pending", id, false);
  if (!pathExists(pendingFile)) return;
  try {
    const pending = readRecord(pendingFile, id);
    if (pending.state !== "pending" || pending.preview !== null || pending.receipt !== null || pending.payload_digest !== digest) {
      throw new Error(`archive conflict for capsule: ${id}`);
    }
    unlinkDurably(pendingFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function cleanupPreview(root: string, id: string, digest: string): void {
  const previewFile = recordPath(root, "previews", id, false);
  if (!pathExists(previewFile)) return;
  try {
    readPreviewMetadata(previewFile, id, digest);
    unlinkDurably(previewFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function acceptedRecord(root: string, id: string): LocalBugRecord | null {
  const archiveFile = recordPath(root, "archive", id, false);
  if (!pathExists(archiveFile)) return null;
  const record = readRecord(archiveFile, id);
  if (record.state !== "accepted") throw new Error(`corrupt local bug record: ${path.basename(archiveFile)}`);
  return record;
}

export function savePending(root: string, capsule: BugCapsule): LocalBugRecord {
  const parsed = parseBugCapsule(capsule);
  const stableCapsule = parseBugCapsule(JSON.parse(canonicalBytes(parsed).toString("utf8")));
  const id = stableCapsule.capsule_id;
  const record: LocalBugRecord = {
    schema_version: "0.1",
    capsule: stableCapsule,
    payload_digest: payloadDigest(stableCapsule),
    state: "pending",
    preview: null,
    receipt: null,
  };
  const pendingFile = recordPath(root, "pending", id, true)!;
  const archiveFile = recordPath(root, "archive", id, false);
  const deletedFile = recordPath(root, "deleted", id, false);
  const remoteDeletedFile = recordPath(root, "remote-deleted", id, false);
  if (pathExists(pendingFile) || pathExists(archiveFile) || pathExists(deletedFile) || pathExists(remoteDeletedFile)) {
    throw new Error(`capsule already exists: ${id}`);
  }
  if (publishOnce(pendingFile, record) === "exists") throw new Error(`capsule already exists: ${id}`);

  const concurrentArchive = recordPath(root, "archive", id, false);
  const concurrentDecision = recordPath(root, "deleted", id, false);
  const concurrentRemoteDeletion = recordPath(root, "remote-deleted", id, false);
  if (pathExists(concurrentArchive) || pathExists(concurrentDecision) || pathExists(concurrentRemoteDeletion)) {
    const archive = pathExists(concurrentArchive) ? acceptedRecord(root, id) : null;
    const decision = pathExists(concurrentDecision) ? readTerminalDecision(concurrentDecision, id) : null;
    const remoteDeletion = pathExists(concurrentRemoteDeletion)
      ? readRemoteDeletionConfirmation(concurrentRemoteDeletion, id, record.payload_digest)
      : null;
    if (archive !== null || decision?.kind === "deleted" || remoteDeletion !== null) cleanupPending(root, id, record.payload_digest);
    throw new Error(`capsule already exists: ${id}`);
  }
  return record;
}

export function listLocalBugRecords(root: string): LocalBugRecordList {
  const records = new Map<string, LocalBugRecordMetadata>();
  const corrupt: string[] = [];
  const archiveIds = new Set<string>();
  const terminalIds = new Set<string>();
  const decisions = new Map<string, TerminalDecision>();
  const resolvedAccepting = new Set<string>();
  const remoteDeletedIds = new Set<string>();

  const remoteDeletedDirectory = storeDirectory(root, "remote-deleted", false);
  if (remoteDeletedDirectory !== null) {
    for (const entry of readdirSync(remoteDeletedDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!UUID_V7.test(id)) {
        corrupt.push(entry.name);
        continue;
      }
      remoteDeletedIds.add(id);
      if (!entry.isFile()) {
        corrupt.push(entry.name);
        continue;
      }
      try {
        readRemoteDeletionConfirmation(path.join(remoteDeletedDirectory, entry.name), id);
      } catch {
        corrupt.push(entry.name);
      }
    }
  }

  const archiveDirectory = storeDirectory(root, "archive", false);
  if (archiveDirectory !== null) {
    for (const entry of readdirSync(archiveDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!UUID_V7.test(id)) {
        corrupt.push(entry.name);
        continue;
      }
      archiveIds.add(id);
      if (remoteDeletedIds.has(id)) continue;
      if (!entry.isFile()) {
        corrupt.push(entry.name);
        continue;
      }
      try {
        const archived = readRecord(path.join(archiveDirectory, entry.name), id);
        if (archived.state !== "accepted") throw new Error("archive record is not accepted");
        records.set(id, metadata(archived));
      } catch {
        corrupt.push(entry.name);
      }
    }
  }

  const decisionDirectory = storeDirectory(root, "deleted", false);
  if (decisionDirectory !== null) {
    for (const entry of readdirSync(decisionDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!UUID_V7.test(id)) {
        corrupt.push(entry.name);
        continue;
      }
      if (archiveIds.has(id)) continue;
      if (remoteDeletedIds.has(id)) continue;
      terminalIds.add(id);
      if (!entry.isFile()) {
        corrupt.push(entry.name);
        continue;
      }
      try {
        decisions.set(id, readTerminalDecision(path.join(decisionDirectory, entry.name), id));
      } catch {
        corrupt.push(entry.name);
      }
    }
  }

  const pendingDirectory = storeDirectory(root, "pending", false);
  if (pendingDirectory !== null) {
    for (const entry of readdirSync(pendingDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!UUID_V7.test(id)) {
        corrupt.push(entry.name);
        continue;
      }
      if (archiveIds.has(id)) continue;
      if (remoteDeletedIds.has(id)) continue;
      const decision = decisions.get(id);
      if (decision?.kind === "deleted" || (decision === undefined && terminalIds.has(id))) continue;
      if (!entry.isFile()) {
        corrupt.push(entry.name);
        if (decision?.kind === "accepting") resolvedAccepting.add(id);
        continue;
      }
      try {
        const record = decision?.kind === "accepting"
          ? recoverableAcceptedRecord(root, decision)
          : withPreview(root, pendingRecord(root, id).record);
        records.set(id, metadata(record));
      } catch {
        corrupt.push(entry.name);
      }
      if (decision?.kind === "accepting") resolvedAccepting.add(id);
    }
  }

  for (const [id, decision] of decisions) {
    if (decision.kind === "accepting" && !resolvedAccepting.has(id)) corrupt.push(`${id}.json`);
  }

  const orderedRecords = [...records.values()].sort((left, right) => left.capsule_id.localeCompare(right.capsule_id));
  corrupt.sort();
  return { records: orderedRecords, corrupt };
}

export function getLocalBugRecord(root: string, id: string): LocalBugRecord | null {
  capsuleId(id);
  const remoteDeletedFile = recordPath(root, "remote-deleted", id, false);
  if (pathExists(remoteDeletedFile)) {
    readRemoteDeletionConfirmation(remoteDeletedFile, id);
    return null;
  }
  const archived = acceptedRecord(root, id);
  if (archived !== null) return archived;
  const decisionFile = recordPath(root, "deleted", id, false);
  if (pathExists(decisionFile)) {
    const decision = readTerminalDecision(decisionFile, id);
    return decision.kind === "deleted" ? null : recoverableAcceptedRecord(root, decision);
  }
  const pendingFile = recordPath(root, "pending", id, false);
  if (pathExists(pendingFile)) return withPreview(root, pendingRecord(root, id).record);
  return null;
}

export function markPreviewed(root: string, id: string, digest: string, destination: string, previewedAt: string): LocalBugRecord {
  const previewTime = timestamp(previewedAt, "previewed_at");
  if (!destination.trim()) throw new Error("preview destination must be a non-empty string");
  const remoteDeletedFile = recordPath(root, "remote-deleted", id, false);
  if (pathExists(remoteDeletedFile)) {
    readRemoteDeletionConfirmation(remoteDeletedFile, id, digest);
    throw new Error(`cannot preview deleted capsule: ${id}`);
  }
  const archived = acceptedRecord(root, id);
  if (archived !== null) throw new Error(`cannot preview accepted capsule: ${id}`);
  const decisionFile = recordPath(root, "deleted", id, false);
  if (pathExists(decisionFile)) {
    const decision = readTerminalDecision(decisionFile, id);
    throw new Error(`cannot preview ${decision.kind === "accepting" ? "accepted" : "deleted"} capsule: ${id}`);
  }

  const { record } = pendingRecord(root, id);
  const currentDigest = payloadDigest(record.capsule);
  if (digest !== currentDigest) throw new Error(`capsule digest changed: ${id}`);
  const previewFile = recordPath(root, "previews", id, true)!;
  const sidecar: PreviewMetadata = {
    schema_version: "0.1",
    capsule_id: id,
    payload_digest: currentDigest,
    destination,
    previewed_at: previewTime,
  };
  if (pathExists(previewFile)) {
    const existing = readPreviewMetadata(previewFile, id, currentDigest);
    if (existing.destination !== destination) unlinkDurably(previewFile);
  }
  const preview = publishOnce(previewFile, sidecar) === "created"
    ? sidecar
    : readPreviewMetadata(previewFile, id, currentDigest);
  if (preview.destination !== destination) throw new Error(`stored preview destination mismatch: ${id}`);
  return {
    ...record,
    preview: { payload_digest: preview.payload_digest, destination: preview.destination, previewed_at: preview.previewed_at },
  };
}

export function archiveAccepted(root: string, id: string, receipt: DeliveryReceipt): LocalBugRecord {
  const parsedReceipt = parseDeliveryReceipt(receipt);
  const remoteDeletedFile = recordPath(root, "remote-deleted", id, false);
  if (pathExists(remoteDeletedFile)) {
    readRemoteDeletionConfirmation(remoteDeletedFile, id, parsedReceipt.payload_digest);
    throw new Error(`capsule was deleted: ${id}`);
  }
  const existing = acceptedRecord(root, id);
  if (existing !== null) {
    if (!isDeepStrictEqual(existing.receipt, parsedReceipt)) throw new Error(`archive conflict for capsule: ${id}`);
    cleanupPending(root, id, existing.payload_digest);
    cleanupPreview(root, id, existing.payload_digest);
    return existing;
  }

  const decisionPath = recordPath(root, "deleted", id, false);
  let decision: TerminalDecision;
  if (pathExists(decisionPath)) {
    decision = readTerminalDecision(decisionPath, id);
  } else {
    const { record } = pendingRecord(root, id);
    if (parsedReceipt.status !== "accepted") throw new Error(`receipt was not accepted: ${id}`);
    if (parsedReceipt.capsule_id !== id) throw new Error(`receipt capsule ID mismatch: ${id}`);
    if (parsedReceipt.payload_digest !== record.payload_digest) throw new Error(`receipt payload digest mismatch: ${id}`);
    const proposed: AcceptingDecision = {
      schema_version: "0.1",
      kind: "accepting",
      capsule_id: id,
      payload_digest: record.payload_digest,
      receipt: parsedReceipt,
    };
    const createdDecisionPath = recordPath(root, "deleted", id, true)!;
    decision = publishOnce(createdDecisionPath, proposed) === "created"
      ? proposed
      : readTerminalDecision(createdDecisionPath, id);
  }

  if (decision.kind === "deleted") throw new Error(`capsule was deleted: ${id}`);
  if (!isDeepStrictEqual(decision.receipt, parsedReceipt)) throw new Error(`archive conflict for capsule: ${id}`);

  const concurrentArchive = acceptedRecord(root, id);
  if (concurrentArchive !== null) {
    if (!isDeepStrictEqual(concurrentArchive.receipt, parsedReceipt)) throw new Error(`archive conflict for capsule: ${id}`);
    cleanupPending(root, id, concurrentArchive.payload_digest);
    cleanupPreview(root, id, concurrentArchive.payload_digest);
    return concurrentArchive;
  }

  const archived = recoverableAcceptedRecord(root, decision);
  const archiveFile = recordPath(root, "archive", id, true)!;
  const result = publishOnce(archiveFile, archived);
  const winner = result === "created" ? archived : readRecord(archiveFile, id);
  if (winner.state !== "accepted" || !isDeepStrictEqual(winner.receipt, parsedReceipt)) {
    throw new Error(`archive conflict for capsule: ${id}`);
  }
  cleanupPending(root, id, winner.payload_digest);
  cleanupPreview(root, id, winner.payload_digest);
  return winner;
}

export function deletePending(root: string, id: string): void {
  capsuleId(id);
  if (acceptedRecord(root, id) !== null) throw new Error(`cannot delete accepted capsule: ${id}`);

  const decisionPath = recordPath(root, "deleted", id, false);
  let decision: TerminalDecision;
  if (pathExists(decisionPath)) {
    decision = readTerminalDecision(decisionPath, id);
  } else {
    const { record } = pendingRecord(root, id);
    const proposed: DeletedDecision = {
      schema_version: "0.1",
      kind: "deleted",
      capsule_id: id,
      payload_digest: record.payload_digest,
    };
    const createdDecisionPath = recordPath(root, "deleted", id, true)!;
    decision = publishOnce(createdDecisionPath, proposed) === "created"
      ? proposed
      : readTerminalDecision(createdDecisionPath, id, record.payload_digest);
  }

  if (decision.kind === "accepting") throw new Error(`cannot delete accepted capsule: ${id}`);
  if (acceptedRecord(root, id) !== null) {
    throw new Error(`cannot delete accepted capsule: ${id}`);
  }
  cleanupPending(root, id, decision.payload_digest);
  cleanupPreview(root, id, decision.payload_digest);
  if (acceptedRecord(root, id) !== null) throw new Error(`cannot delete accepted capsule: ${id}`);
}

/** Read historical server confirmations without creating or sending a request. */
export type RemoteDeletionConfirmation = ArchiveDeletionMarker & { kind: "remote_deletion_confirmed" };
export function getRemoteDeletionConfirmation(root: string, id: string, digest?: string): RemoteDeletionConfirmation | null {
  const marker = getArchiveDeletionMarker(root, id, digest);
  return marker?.kind === "remote_deletion_confirmed" ? marker as RemoteDeletionConfirmation : null;
}

/** Compatibility for legacy local-store consumers that already hold server confirmation. */
export function confirmRemoteDeletion(root: string, id: string, digest: string): void {
  deleteArchive(root, id, digest, "remote_deletion_confirmed");
}

/** Remove an archived report locally, recording no claim about its historical destination. */
export function deleteLocalArchive(root: string, id: string, digest: string): void {
  deleteArchive(root, id, digest, "local_archive_deleted");
}

/** Publish a metadata-only deletion marker before cleanup; exact replay finishes after a crash. */
function deleteArchive(root: string, id: string, digest: string, kind: ArchiveDeletionMarker["kind"]): void {
  capsuleId(id);
  if (!SHA_256_DIGEST.test(digest)) throw new Error("payload digest must be a lowercase SHA-256 digest");
  const markerFile = recordPath(root, "remote-deleted", id, false);
  let marker: ArchiveDeletionMarker;

  if (pathExists(markerFile)) {
    marker = readRemoteDeletionConfirmation(markerFile, id, digest);
  } else {
    const accepted = acceptedRecord(root, id) ?? (() => {
      const decisionFile = recordPath(root, "deleted", id, false);
      if (!pathExists(decisionFile)) return null;
      const decision = readTerminalDecision(decisionFile, id, digest);
      return decision.kind === "accepting" ? recoverableAcceptedRecord(root, decision) : null;
    })();
    if (accepted === null || accepted.state !== "accepted" || accepted.receipt === null) {
      throw new Error(`accepted capsule not found: ${id}`);
    }
    if (accepted.payload_digest !== digest) throw new Error(`remote deletion digest mismatch: ${id}`);
    marker = {
      schema_version: "0.1",
      kind,
      capsule_id: id,
      payload_digest: digest,
      receipt_id: accepted.receipt.receipt_id,
      destination: accepted.receipt.destination,
    };
    const createdMarkerFile = recordPath(root, "remote-deleted", id, true)!;
    marker = publishOnce(createdMarkerFile, marker) === "created"
      ? marker
      : readRemoteDeletionConfirmation(createdMarkerFile, id, digest);
  }

  const archiveFile = recordPath(root, "archive", id, false);
  if (pathExists(archiveFile)) {
    const archived = readRecord(archiveFile, id);
    if (archived.state !== "accepted" || archived.payload_digest !== marker.payload_digest) {
      throw new Error(`archive conflict for capsule: ${id}`);
    }
    unlinkDurably(archiveFile);
  }
  cleanupPending(root, id, marker.payload_digest);
  cleanupPreview(root, id, marker.payload_digest);

  const decisionFile = recordPath(root, "deleted", id, false);
  if (pathExists(decisionFile)) {
    const decision = readTerminalDecision(decisionFile, id, marker.payload_digest);
    if (decision.kind === "accepting") unlinkDurably(decisionFile);
  }
}
