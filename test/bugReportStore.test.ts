import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseBugCapsule, parseDeliveryReceipt, payloadDigest, type BugCapsule, type DeliveryReceipt } from "../src/bugCapsule.js";
import {
  archiveAccepted,
  confirmRemoteDeletion,
  deletePending,
  getLocalBugRecord,
  getRemoteDeletionConfirmation,
  listLocalBugRecords,
  markPreviewed,
  savePending,
} from "../src/bugReportStore.js";

const FIXTURE_DIR = "test/fixtures/bug-capsule";
const NOW = "2026-07-19T00:00:01.000Z";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-bug-store-"));
}

function fixedCapsule(): BugCapsule {
  return parseBugCapsule(JSON.parse(readFileSync(path.join(FIXTURE_DIR, "capsule.valid.json"), "utf8")));
}

function acceptedReceipt(capsule: BugCapsule): DeliveryReceipt {
  const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "receipt.accepted.json"), "utf8"));
  return parseDeliveryReceipt({ ...fixture, capsule_id: capsule.capsule_id, payload_digest: payloadDigest(capsule) });
}

function pendingDir(root: string): string {
  return path.join(root, ".foo", "reports", "pending");
}

function archiveDir(root: string): string {
  return path.join(root, ".foo", "reports", "archive");
}

function recordFile(directory: string, capsuleId: string): string {
  return path.join(directory, `${capsuleId}.json`);
}

function previewDir(root: string): string {
  return path.join(root, ".foo", "reports", "previews");
}

function deletedDir(root: string): string {
  return path.join(root, ".foo", "reports", "deleted");
}

function remoteDeletedDir(root: string): string {
  return path.join(root, ".foo", "reports", "remote-deleted");
}

test("remote deletion confirmation is exposed as safe metadata for digest-bound replay", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(saved.capsule);
  archiveAccepted(root, saved.capsule.capsule_id, receipt);
  confirmRemoteDeletion(root, saved.capsule.capsule_id, saved.payload_digest);

  assert.deepEqual(getRemoteDeletionConfirmation(root, saved.capsule.capsule_id), {
    schema_version: "0.1",
    kind: "remote_deletion_confirmed",
    capsule_id: saved.capsule.capsule_id,
    payload_digest: saved.payload_digest,
    receipt_id: receipt.receipt_id,
    destination: receipt.destination,
  });
  assert.throws(
    () => getRemoteDeletionConfirmation(root, saved.capsule.capsule_id, `sha256:${"f".repeat(64)}`),
    /digest mismatch/,
  );
});

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function childResult(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

test("savePending writes one private record and preserves unknown capsule extensions", () => {
  const root = tempRoot();
  const capsule = parseBugCapsule({
    ...fixedCapsule(),
    extensions: {
      ...fixedCapsule().extensions,
      "example.future": { enabled: true, nested: { revision: 2 } },
    },
  });

  const saved = savePending(root, capsule);
  const file = recordFile(pendingDir(root), capsule.capsule_id);

  assert.equal(saved.payload_digest, payloadDigest(capsule));
  assert.deepEqual(saved.capsule.extensions["example.future"], { enabled: true, nested: { revision: 2 } });
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(pendingDir(root)), [`${capsule.capsule_id}.json`]);
  assert.deepEqual(getLocalBugRecord(root, capsule.capsule_id), saved);
  assert.throws(() => savePending(root, capsule), /capsule already exists/);
});

test("markPreviewed binds the exact immutable ID and digest", () => {
  const root = tempRoot();
  const first = savePending(root, fixedCapsule());
  const pendingFile = recordFile(pendingDir(root), first.capsule.capsule_id);
  const pendingBytes = readFileSync(pendingFile);

  const previewed = markPreviewed(root, first.capsule.capsule_id, first.payload_digest, "foo-owner-relay:bug-capsules/v0", NOW);

  assert.deepEqual(previewed.preview, {
    payload_digest: first.payload_digest,
    destination: "foo-owner-relay:bug-capsules/v0",
    previewed_at: NOW,
  });
  assert.deepEqual(readFileSync(pendingFile), pendingBytes);
  assert.equal(lstatSync(recordFile(previewDir(root), first.capsule.capsule_id)).mode & 0o777, 0o600);
  assert.throws(
    () => markPreviewed(root, first.capsule.capsule_id, `sha256:${"0".repeat(64)}`, "foo-owner-relay:bug-capsules/v0", NOW),
    /digest changed/,
  );
  assert.equal(
    markPreviewed(root, first.capsule.capsule_id, first.payload_digest, "foo-owner-relay:bug-capsules/v0", "2026-07-19T00:00:02.000Z").preview?.previewed_at,
    NOW,
  );
  assert.deepEqual(getLocalBugRecord(root, first.capsule.capsule_id), previewed);
});

test("changed capsule bytes require a new capsule ID", () => {
  const root = tempRoot();
  const original = fixedCapsule();
  savePending(root, original);
  const changedWithSameId = parseBugCapsule({
    ...original,
    report: { ...original.report, actual: { state: "collected", value: "different bytes" } },
  });

  assert.throws(() => savePending(root, changedWithSameId), /capsule already exists/);

  const changedWithNewId = parseBugCapsule({ ...changedWithSameId, capsule_id: "0198c5d8-12c0-7abc-9234-56789abcdef0" });
  const saved = savePending(root, changedWithNewId);
  assert.notEqual(saved.capsule.capsule_id, original.capsule_id);
  assert.notEqual(saved.payload_digest, payloadDigest(original));
});

test("corrupt files are listed as metadata only and never returned as payload", () => {
  const root = tempRoot();
  mkdirSync(pendingDir(root), { recursive: true });
  writeFileSync(path.join(pendingDir(root), "broken.json"), '{"private":"do-not-echo"');

  const listed = listLocalBugRecords(root);

  assert.deepEqual(listed.records, []);
  assert.deepEqual(listed.corrupt, ["broken.json"]);
  assert.equal(JSON.stringify(listed).includes("do-not-echo"), false);
});

test("getLocalBugRecord reports corrupt JSON without echoing its contents", () => {
  const root = tempRoot();
  const id = fixedCapsule().capsule_id;
  mkdirSync(pendingDir(root), { recursive: true });
  writeFileSync(recordFile(pendingDir(root), id), '{"private":"do-not-echo","broken":}');

  assert.throws(
    () => getLocalBugRecord(root, id),
    (error: unknown) => {
      assert.match(String(error), /corrupt local bug record/);
      assert.equal(String(error).includes("do-not-echo"), false);
      return true;
    },
  );
});

test("listLocalBugRecords returns metadata rather than capsule payloads", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());

  const listed = listLocalBugRecords(root);

  assert.deepEqual(listed, {
    records: [{
      capsule_id: saved.capsule.capsule_id,
      payload_digest: saved.payload_digest,
      state: "pending",
      previewed_at: null,
      receipt_id: null,
    }],
    corrupt: [],
  });
  assert.equal("capsule" in listed.records[0], false);
});

test("archiveAccepted archives only an exact accepted receipt", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(pending.capsule);

  const archived = archiveAccepted(root, pending.capsule.capsule_id, receipt);

  assert.equal(archived.state, "accepted");
  assert.deepEqual(archived.receipt, receipt);
  assert.equal(existsSync(recordFile(pendingDir(root), pending.capsule.capsule_id)), false);
  const archiveFile = recordFile(archiveDir(root), pending.capsule.capsule_id);
  assert.equal(lstatSync(archiveFile).mode & 0o777, 0o600);
  assert.deepEqual(getLocalBugRecord(root, pending.capsule.capsule_id), archived);
});

test("archiveAccepted replay returns the original accepted record after pending is gone", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(pending.capsule);
  const first = archiveAccepted(root, pending.capsule.capsule_id, receipt);

  const replay = archiveAccepted(root, pending.capsule.capsule_id, receipt);

  assert.deepEqual(replay, first);
  assert.equal(existsSync(recordFile(pendingDir(root), pending.capsule.capsule_id)), false);
});

test("accepted archive wins over a retained pending duplicate everywhere", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const pendingFile = recordFile(pendingDir(root), pending.capsule.capsule_id);
  const pendingBytes = readFileSync(pendingFile);
  const receipt = acceptedReceipt(pending.capsule);
  const archived = archiveAccepted(root, pending.capsule.capsule_id, receipt);
  writeFileSync(pendingFile, pendingBytes, { mode: 0o600 });

  assert.deepEqual(getLocalBugRecord(root, pending.capsule.capsule_id), archived);
  assert.deepEqual(listLocalBugRecords(root), {
    records: [{
      capsule_id: archived.capsule.capsule_id,
      payload_digest: archived.payload_digest,
      state: "accepted",
      previewed_at: null,
      receipt_id: receipt.receipt_id,
    }],
    corrupt: [],
  });
  assert.throws(() => deletePending(root, pending.capsule.capsule_id), /accepted capsule/);
  assert.equal(existsSync(pendingFile), true);
});

test("accepted archive suppresses a corrupt lower-precedence pending duplicate in list", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(pending.capsule);
  const archived = archiveAccepted(root, pending.capsule.capsule_id, receipt);
  writeFileSync(recordFile(pendingDir(root), pending.capsule.capsule_id), '{"private":"do-not-echo","broken":}', { mode: 0o600 });

  assert.deepEqual(listLocalBugRecords(root), {
    records: [{
      capsule_id: archived.capsule.capsule_id,
      payload_digest: archived.payload_digest,
      state: "accepted",
      previewed_at: null,
      receipt_id: receipt.receipt_id,
    }],
    corrupt: [],
  });
});

test("deleted decision suppresses a corrupt lower-precedence pending duplicate in list", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  deletePending(root, pending.capsule.capsule_id);
  writeFileSync(recordFile(pendingDir(root), pending.capsule.capsule_id), '{"private":"do-not-echo","broken":}', { mode: 0o600 });

  assert.deepEqual(listLocalBugRecords(root), { records: [], corrupt: [] });
});

test("archiveAccepted replay completes an accepted archive with a retained pending duplicate", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const pendingFile = recordFile(pendingDir(root), pending.capsule.capsule_id);
  const pendingBytes = readFileSync(pendingFile);
  const receipt = acceptedReceipt(pending.capsule);
  const archived = archiveAccepted(root, pending.capsule.capsule_id, receipt);
  writeFileSync(pendingFile, pendingBytes, { mode: 0o600 });

  assert.deepEqual(archiveAccepted(root, pending.capsule.capsule_id, receipt), archived);
  assert.equal(existsSync(pendingFile), false);
});

test("archiveAccepted mismatch retains a pending duplicate beside an accepted archive", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const pendingFile = recordFile(pendingDir(root), pending.capsule.capsule_id);
  const pendingBytes = readFileSync(pendingFile);
  const receipt = acceptedReceipt(pending.capsule);
  archiveAccepted(root, pending.capsule.capsule_id, receipt);
  writeFileSync(pendingFile, pendingBytes, { mode: 0o600 });
  const mismatch = parseDeliveryReceipt({ ...receipt, payload_digest: `sha256:${"0".repeat(64)}` });

  assert.throws(() => archiveAccepted(root, pending.capsule.capsule_id, mismatch), /archive conflict/);
  assert.equal(existsSync(pendingFile), true);
  assert.equal(getLocalBugRecord(root, pending.capsule.capsule_id)?.state, "accepted");
});

test("archiveAccepted retains pending on a receipt capsule ID mismatch", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = parseDeliveryReceipt({
    ...acceptedReceipt(pending.capsule),
    capsule_id: "0198c5d8-12c0-7abc-9234-56789abcdef0",
  });

  assert.throws(() => archiveAccepted(root, pending.capsule.capsule_id, receipt), /capsule ID mismatch/);
  assert.deepEqual(getLocalBugRecord(root, pending.capsule.capsule_id), pending);
  assert.equal(existsSync(recordFile(archiveDir(root), pending.capsule.capsule_id)), false);
});

test("archiveAccepted retains pending on a receipt digest mismatch", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = parseDeliveryReceipt({
    ...acceptedReceipt(pending.capsule),
    payload_digest: `sha256:${"0".repeat(64)}`,
  });

  assert.throws(() => archiveAccepted(root, pending.capsule.capsule_id, receipt), /payload digest mismatch/);
  assert.deepEqual(getLocalBugRecord(root, pending.capsule.capsule_id), pending);
  assert.equal(existsSync(recordFile(archiveDir(root), pending.capsule.capsule_id)), false);
});

test("archiveAccepted retains pending when the receipt was not accepted", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const receipt = parseDeliveryReceipt({
    ...acceptedReceipt(pending.capsule),
    status: "retryable",
    error: { code: "E_IO", message: "try again" },
  });

  assert.throws(() => archiveAccepted(root, pending.capsule.capsule_id, receipt), /receipt was not accepted/);
  assert.deepEqual(getLocalBugRecord(root, pending.capsule.capsule_id), pending);
  assert.equal(existsSync(recordFile(archiveDir(root), pending.capsule.capsule_id)), false);
});

test("archiveAccepted retains pending when the archive path is unsafe", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  const outside = mkdtempSync(path.join(tmpdir(), "foo-bug-store-outside-"));
  symlinkSync(outside, archiveDir(root));

  assert.throws(() => archiveAccepted(root, pending.capsule.capsule_id, acceptedReceipt(pending.capsule)), /symbolic link/);
  assert.equal(existsSync(recordFile(pendingDir(root), pending.capsule.capsule_id)), true);
  assert.equal(JSON.parse(readFileSync(recordFile(pendingDir(root), pending.capsule.capsule_id), "utf8")).state, "pending");
  assert.deepEqual(readdirSync(outside), []);
});

test("a dangling archive-directory symlink fails closed for get and delete", () => {
  const root = tempRoot();
  const pending = savePending(root, fixedCapsule());
  symlinkSync(path.join(root, "missing-archive-target"), archiveDir(root));

  assert.throws(() => getLocalBugRecord(root, pending.capsule.capsule_id), /symbolic link/);
  assert.throws(() => deletePending(root, pending.capsule.capsule_id), /symbolic link/);
  assert.equal(existsSync(recordFile(pendingDir(root), pending.capsule.capsule_id)), true);
});

test("deletePending removes only a pending capsule and refuses accepted state", () => {
  const firstRoot = tempRoot();
  const pending = savePending(firstRoot, fixedCapsule());
  deletePending(firstRoot, pending.capsule.capsule_id);
  assert.equal(getLocalBugRecord(firstRoot, pending.capsule.capsule_id), null);

  const secondRoot = tempRoot();
  const accepted = savePending(secondRoot, fixedCapsule());
  archiveAccepted(secondRoot, accepted.capsule.capsule_id, acceptedReceipt(accepted.capsule));
  assert.throws(() => deletePending(secondRoot, accepted.capsule.capsule_id), /accepted capsule/);
  assert.equal(getLocalBugRecord(secondRoot, accepted.capsule.capsule_id)?.state, "accepted");
});

test("confirmRemoteDeletion publishes a metadata-only winner before removing accepted rich data and replays cleanup", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  markPreviewed(root, saved.capsule.capsule_id, saved.payload_digest, "foo-owner-relay:bug-capsules/v0", NOW);
  const accepted = archiveAccepted(root, saved.capsule.capsule_id, acceptedReceipt(saved.capsule));

  confirmRemoteDeletion(root, saved.capsule.capsule_id, saved.payload_digest);

  const markerFile = recordFile(remoteDeletedDir(root), saved.capsule.capsule_id);
  const markerText = readFileSync(markerFile, "utf8");
  const marker = JSON.parse(markerText);
  assert.deepEqual(marker, {
    schema_version: "0.1",
    kind: "remote_deletion_confirmed",
    capsule_id: saved.capsule.capsule_id,
    payload_digest: saved.payload_digest,
    receipt_id: accepted.receipt?.receipt_id,
    destination: accepted.receipt?.destination,
  });
  assert.doesNotMatch(markerText, /EACCES|permission denied|failure|report|evidence/);
  assert.equal(existsSync(recordFile(archiveDir(root), saved.capsule.capsule_id)), false);
  assert.equal(getLocalBugRecord(root, saved.capsule.capsule_id), null);
  assert.deepEqual(listLocalBugRecords(root).records, []);

  // A crash after marker publication can leave lower-precedence rich state. Exact
  // replay must finish cleanup without changing the durable confirmation.
  writeFileSync(recordFile(archiveDir(root), saved.capsule.capsule_id), `${JSON.stringify(accepted, null, 2)}\n`);
  confirmRemoteDeletion(root, saved.capsule.capsule_id, saved.payload_digest);
  assert.equal(existsSync(recordFile(archiveDir(root), saved.capsule.capsule_id)), false);
  assert.equal(readFileSync(markerFile, "utf8"), `${JSON.stringify(marker, null, 2)}\n`);
  assert.throws(() => savePending(root, saved.capsule), /already exists|deleted/);
});

test("confirmRemoteDeletion refuses a digest mismatch and keeps the accepted rich archive", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  archiveAccepted(root, saved.capsule.capsule_id, acceptedReceipt(saved.capsule));

  assert.throws(
    () => confirmRemoteDeletion(root, saved.capsule.capsule_id, `sha256:${"f".repeat(64)}`),
    /digest mismatch/,
  );
  assert.equal(getLocalBugRecord(root, saved.capsule.capsule_id)?.state, "accepted");
  assert.equal(existsSync(recordFile(remoteDeletedDir(root), saved.capsule.capsule_id)), false);
});

test("capsule IDs cannot traverse out of the local report store", () => {
  const root = tempRoot();
  const outside = path.join(root, "outside.json");

  assert.throws(() => getLocalBugRecord(root, "../../outside"), /UUIDv7/);
  assert.throws(() => deletePending(root, "../../outside"), /UUIDv7/);
  assert.equal(existsSync(outside), false);
});

test("a stale preview can leave only ignored metadata after accepted archival", async () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(saved.capsule);
  const ready = path.join(root, "preview-ready");
  const release = path.join(root, "release-preview");
  const pendingFile = recordFile(pendingDir(root), saved.capsule.capsule_id);
  const previewFile = recordFile(previewDir(root), saved.capsule.capsule_id);
  const previewScript = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.PREVIEW_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    store.markPreviewed(process.env.ROOT, process.env.CAPSULE_ID, process.env.DIGEST, "foo-owner-relay:bug-capsules/v0", process.env.NOW);
  `;
  const preview = spawn(process.execPath, ["--input-type=module", "-e", previewScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: saved.capsule.capsule_id,
      DIGEST: saved.payload_digest,
      NOW,
      PREVIEW_FILE: previewFile,
      READY: ready,
      RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const previewCompletion = childResult(preview);
  await waitForFile(ready);
  const archived = archiveAccepted(root, saved.capsule.capsule_id, receipt);
  writeFileSync(release, "release");
  const previewResult = await previewCompletion;

  assert.deepEqual(previewResult, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(getLocalBugRecord(root, saved.capsule.capsule_id), archived);
  assert.equal(existsSync(pendingFile), false);
  assert.equal(lstatSync(previewFile).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(previewFile, "utf8"))).sort(), ["capsule_id", "destination", "payload_digest", "previewed_at", "schema_version"]);
  assert.deepEqual(archiveAccepted(root, saved.capsule.capsule_id, receipt), archived);
  assert.equal(existsSync(previewFile), false);
});

test("one immutable archive wins concurrent conflicting accepted receipts", async () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const firstReceipt = acceptedReceipt(saved.capsule);
  const secondReceipt = parseDeliveryReceipt({
    ...firstReceipt,
    receipt_id: "018f05d4-54fc-72ab-aa2a-2a2a2a2a2a2b",
    accepted_at: "2026-07-19T00:00:02.000Z",
  });
  const archiveFile = recordFile(archiveDir(root), saved.capsule.capsule_id);
  const ready = path.join(root, "first-archive-ready");
  const release = path.join(root, "release-first-archive");
  const outcome = path.join(root, "first-outcome");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.ARCHIVE_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.archiveAccepted(process.env.ROOT, process.env.CAPSULE_ID, JSON.parse(process.env.RECEIPT));
      fs.writeFileSync(process.env.OUTCOME, "accepted");
    } catch (error) {
      fs.writeFileSync(process.env.OUTCOME, "error:" + error.message);
    }
  `;
  const first = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: saved.capsule.capsule_id,
      RECEIPT: JSON.stringify(firstReceipt),
      ARCHIVE_FILE: archiveFile,
      READY: ready,
      RELEASE: release,
      OUTCOME: outcome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const firstCompletion = childResult(first);
  await waitForFile(ready);
  let secondError: unknown;
  try {
    archiveAccepted(root, saved.capsule.capsule_id, secondReceipt);
  } catch (error) {
    secondError = error;
  } finally {
    writeFileSync(release, "release");
  }
  const firstResult = await firstCompletion;

  assert.deepEqual(firstResult, { code: 0, stdout: "", stderr: "" });
  assert.match(String(secondError), /archive conflict/);
  assert.equal(readFileSync(outcome, "utf8"), "accepted");
  assert.deepEqual(getLocalBugRecord(root, saved.capsule.capsule_id)?.receipt, firstReceipt);
});

test("delete tombstone wins a stale preview and exact replay removes the orphan sidecar", async () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const previewFile = recordFile(previewDir(root), saved.capsule.capsule_id);
  const deletedFile = recordFile(deletedDir(root), saved.capsule.capsule_id);
  const ready = path.join(root, "delete-preview-ready");
  const release = path.join(root, "delete-preview-release");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.PREVIEW_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    store.markPreviewed(process.env.ROOT, process.env.CAPSULE_ID, process.env.DIGEST, "foo-owner-relay:bug-capsules/v0", process.env.NOW);
  `;
  const preview = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: saved.capsule.capsule_id,
      DIGEST: saved.payload_digest,
      NOW,
      PREVIEW_FILE: previewFile,
      READY: ready,
      RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = childResult(preview);
  await waitForFile(ready);
  deletePending(root, saved.capsule.capsule_id);
  writeFileSync(release, "release");
  assert.deepEqual(await completion, { code: 0, stdout: "", stderr: "" });

  assert.equal(getLocalBugRecord(root, saved.capsule.capsule_id), null);
  assert.deepEqual(listLocalBugRecords(root).records, []);
  assert.equal(existsSync(previewFile), true);
  const tombstone = JSON.parse(readFileSync(deletedFile, "utf8"));
  assert.deepEqual(Object.keys(tombstone).sort(), ["capsule_id", "kind", "payload_digest", "schema_version"]);
  assert.equal(tombstone.kind, "deleted");
  assert.equal(JSON.stringify(tombstone).includes("message"), false);
  deletePending(root, saved.capsule.capsule_id);
  assert.equal(existsSync(previewFile), false);
  assert.throws(() => savePending(root, saved.capsule), /deleted|already exists/);
});

test("accepting decision preserves the full capsule when archive publication fails", async () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(saved.capsule);
  const pendingFile = recordFile(pendingDir(root), saved.capsule.capsule_id);
  const archiveFile = recordFile(archiveDir(root), saved.capsule.capsule_id);
  const decisionFile = recordFile(deletedDir(root), saved.capsule.capsule_id);
  const ready = path.join(root, "failed-archive-ready");
  const release = path.join(root, "release-failed-archive");
  const outcome = path.join(root, "failed-archive-outcome");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.ARCHIVE_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        const error = new Error("injected archive publication failure");
        error.code = "EIO";
        throw error;
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.archiveAccepted(process.env.ROOT, process.env.CAPSULE_ID, JSON.parse(process.env.RECEIPT));
      fs.writeFileSync(process.env.OUTCOME, "unexpected-success");
    } catch (error) {
      fs.writeFileSync(process.env.OUTCOME, String(error.code) + ":" + error.message);
    }
  `;
  const archive = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: saved.capsule.capsule_id,
      RECEIPT: JSON.stringify(receipt),
      ARCHIVE_FILE: archiveFile,
      READY: ready,
      RELEASE: release,
      OUTCOME: outcome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = childResult(archive);
  await waitForFile(ready);
  let deleteError: unknown;
  try {
    deletePending(root, saved.capsule.capsule_id);
  } catch (error) {
    deleteError = error;
  } finally {
    writeFileSync(release, "release");
  }
  assert.deepEqual(await completion, { code: 0, stdout: "", stderr: "" });

  assert.match(String(deleteError), /accepted capsule/);
  assert.match(readFileSync(outcome, "utf8"), /^EIO:injected archive publication failure$/);
  assert.equal(existsSync(archiveFile), false);
  assert.equal(existsSync(pendingFile), true);
  assert.deepEqual(readdirSync(deletedDir(root)), [`${saved.capsule.capsule_id}.json`]);
  const decision = JSON.parse(readFileSync(decisionFile, "utf8"));
  assert.equal(decision.kind, "accepting");
  assert.deepEqual(decision.receipt, receipt);

  const recoverable = getLocalBugRecord(root, saved.capsule.capsule_id);
  assert.equal(recoverable?.state, "accepted");
  assert.deepEqual(recoverable?.receipt, receipt);
  assert.deepEqual(recoverable?.capsule, saved.capsule);
  assert.deepEqual(listLocalBugRecords(root), {
    records: [{
      capsule_id: saved.capsule.capsule_id,
      payload_digest: saved.payload_digest,
      state: "accepted",
      previewed_at: null,
      receipt_id: receipt.receipt_id,
    }],
    corrupt: [],
  });

  const archived = archiveAccepted(root, saved.capsule.capsule_id, receipt);
  assert.equal(archived.state, "accepted");
  assert.deepEqual(archived.receipt, receipt);
  assert.equal(existsSync(archiveFile), true);
  assert.equal(existsSync(pendingFile), false);
});

test("a concurrent save cannot clean the rich source of an accepting decision", async () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  const receipt = acceptedReceipt(capsule);
  const pendingFile = recordFile(pendingDir(root), capsule.capsule_id);
  const archiveFile = recordFile(archiveDir(root), capsule.capsule_id);
  const decisionFile = recordFile(deletedDir(root), capsule.capsule_id);
  const saveReady = path.join(root, "save-published-pending");
  const releaseSave = path.join(root, "release-save");
  const saveOutcome = path.join(root, "save-outcome");
  const archiveOutcome = path.join(root, "save-race-archive-outcome");
  const saveScript = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      const result = originalLink.call(this, source, destination);
      if (path.resolve(String(destination)) === path.resolve(process.env.PENDING_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return result;
    };
    syncBuiltinESMExports();
    const capsuleModule = await import("./dist/src/bugCapsule.js");
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.savePending(process.env.ROOT, capsuleModule.parseBugCapsule(JSON.parse(process.env.CAPSULE)));
      fs.writeFileSync(process.env.OUTCOME, "unexpected-success");
    } catch (error) {
      fs.writeFileSync(process.env.OUTCOME, "error:" + error.message);
    }
  `;
  const save = spawn(process.execPath, ["--input-type=module", "-e", saveScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE: JSON.stringify(capsule),
      PENDING_FILE: pendingFile,
      READY: saveReady,
      RELEASE: releaseSave,
      OUTCOME: saveOutcome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const saveCompletion = childResult(save);
  await waitForFile(saveReady);

  const archiveScript = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.ARCHIVE_FILE)) {
        const error = new Error("injected archive publication failure");
        error.code = "EIO";
        throw error;
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.archiveAccepted(process.env.ROOT, process.env.CAPSULE_ID, JSON.parse(process.env.RECEIPT));
      fs.writeFileSync(process.env.OUTCOME, "unexpected-success");
    } catch (error) {
      fs.writeFileSync(process.env.OUTCOME, String(error.code) + ":" + error.message);
    }
  `;
  const archive = spawn(process.execPath, ["--input-type=module", "-e", archiveScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: capsule.capsule_id,
      RECEIPT: JSON.stringify(receipt),
      ARCHIVE_FILE: archiveFile,
      OUTCOME: archiveOutcome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(await childResult(archive), { code: 0, stdout: "", stderr: "" });
  writeFileSync(releaseSave, "release");
  assert.deepEqual(await saveCompletion, { code: 0, stdout: "", stderr: "" });

  assert.match(readFileSync(saveOutcome, "utf8"), /^error:capsule already exists/);
  assert.match(readFileSync(archiveOutcome, "utf8"), /^EIO:injected archive publication failure$/);
  assert.equal(JSON.parse(readFileSync(decisionFile, "utf8")).kind, "accepting");
  assert.equal(existsSync(pendingFile), true);
  assert.equal(getLocalBugRecord(root, capsule.capsule_id)?.state, "accepted");
  assert.equal(archiveAccepted(root, capsule.capsule_id, receipt).state, "accepted");
  assert.equal(existsSync(pendingFile), false);
});

test("deleted decision wins before a later accepted archive", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const decisionFile = recordFile(deletedDir(root), saved.capsule.capsule_id);

  deletePending(root, saved.capsule.capsule_id);

  const decision = JSON.parse(readFileSync(decisionFile, "utf8"));
  assert.equal(decision.kind, "deleted");
  assert.equal(decision.payload_digest, saved.payload_digest);
  assert.equal(existsSync(recordFile(pendingDir(root), saved.capsule.capsule_id)), false);
  assert.throws(
    () => archiveAccepted(root, saved.capsule.capsule_id, acceptedReceipt(saved.capsule)),
    /deleted/,
  );
  assert.equal(existsSync(recordFile(archiveDir(root), saved.capsule.capsule_id)), false);
  deletePending(root, saved.capsule.capsule_id);
});

test("accepted is authoritative when archive and delete markers race", async () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const receipt = acceptedReceipt(saved.capsule);
  const archiveFile = recordFile(archiveDir(root), saved.capsule.capsule_id);
  const deletedFile = recordFile(deletedDir(root), saved.capsule.capsule_id);
  const ready = path.join(root, "archive-delete-ready");
  const release = path.join(root, "archive-delete-release");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (path.resolve(String(destination)) === path.resolve(process.env.ARCHIVE_FILE)) {
        fs.writeFileSync(process.env.READY, "ready");
        while (!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const store = await import("./dist/src/bugReportStore.js");
    store.archiveAccepted(process.env.ROOT, process.env.CAPSULE_ID, JSON.parse(process.env.RECEIPT));
  `;
  const archive = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE_ID: saved.capsule.capsule_id,
      RECEIPT: JSON.stringify(receipt),
      ARCHIVE_FILE: archiveFile,
      READY: ready,
      RELEASE: release,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = childResult(archive);
  await waitForFile(ready);
  let deleteError: unknown;
  try {
    deletePending(root, saved.capsule.capsule_id);
  } catch (error) {
    deleteError = error;
  } finally {
    writeFileSync(release, "release");
  }
  assert.deepEqual(await completion, { code: 0, stdout: "", stderr: "" });

  assert.match(String(deleteError), /accepted capsule/);
  assert.equal(JSON.parse(readFileSync(deletedFile, "utf8")).kind, "accepting");
  assert.equal(getLocalBugRecord(root, saved.capsule.capsule_id)?.state, "accepted");
  assert.equal(listLocalBugRecords(root).records[0]?.state, "accepted");
  assert.throws(() => deletePending(root, saved.capsule.capsule_id), /accepted capsule/);
  assert.equal(existsSync(archiveFile), true);
});

test("preview sidecar directories refuse symbolic links", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const outside = mkdtempSync(path.join(tmpdir(), "foo-preview-outside-"));
  symlinkSync(outside, previewDir(root));

  assert.throws(() => markPreviewed(root, saved.capsule.capsule_id, saved.payload_digest, "foo-owner-relay:bug-capsules/v0", NOW), /symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
});

test("record reads refuse symbolic links", () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  mkdirSync(pendingDir(root), { recursive: true });
  const outside = path.join(root, "outside.json");
  writeFileSync(outside, JSON.stringify({ private: "do-not-read" }));
  symlinkSync(outside, recordFile(pendingDir(root), capsule.capsule_id));

  assert.throws(() => getLocalBugRecord(root, capsule.capsule_id), /symbolic link/);
  const listed = listLocalBugRecords(root);
  assert.deepEqual(listed.corrupt, [`${capsule.capsule_id}.json`]);
  assert.equal(JSON.stringify(listed).includes("do-not-read"), false);
});

test("valid JSON semantic corruption is reported without echoing keys or values", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const file = recordFile(pendingDir(root), saved.capsule.capsule_id);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored["private-key-do-not-echo"] = "private-value-do-not-echo";
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });

  assert.throws(
    () => getLocalBugRecord(root, saved.capsule.capsule_id),
    (error: unknown) => {
      const message = String(error);
      assert.match(message, /corrupt local bug record/);
      assert.equal(message.includes("private-key-do-not-echo"), false);
      assert.equal(message.includes("private-value-do-not-echo"), false);
      return true;
    },
  );
});

test("tampered stored capsule bytes cannot be previewed", () => {
  const root = tempRoot();
  const saved = savePending(root, fixedCapsule());
  const file = recordFile(pendingDir(root), saved.capsule.capsule_id);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.capsule.extensions["example.tampered"] = { private: "not outbound" };
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });

  assert.throws(
    () => markPreviewed(root, saved.capsule.capsule_id, saved.payload_digest, "foo-owner-relay:bug-capsules/v0", NOW),
    /corrupt local bug record/,
  );
});

test("store directories are private and each newly created parent entry is synced", async () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  const secondCapsule = parseBugCapsule({ ...capsule, capsule_id: "018f05d4-54fb-72aa-aa2a-2a2a2a2a2a2b" });
  const receipt = acceptedReceipt(capsule);
  const auditFile = path.join(root, "fsync-audit.json");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const opened = new Map();
    const synced = [];
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalFsync = fs.fsyncSync;
    fs.openSync = function(target, ...args) {
      const fd = originalOpen.call(this, target, ...args);
      if (typeof target === "string") opened.set(fd, path.resolve(target));
      return fd;
    };
    fs.fsyncSync = function(fd) {
      const target = opened.get(fd);
      if (target) synced.push(target);
      return originalFsync.call(this, fd);
    };
    fs.closeSync = function(fd) {
      const result = originalClose.call(this, fd);
      opened.delete(fd);
      return result;
    };
    syncBuiltinESMExports();
    const capsuleModule = await import("./dist/src/bugCapsule.js");
    const store = await import("./dist/src/bugReportStore.js");
    const first = store.savePending(process.env.ROOT, capsuleModule.parseBugCapsule(JSON.parse(process.env.CAPSULE)));
    store.markPreviewed(process.env.ROOT, first.capsule.capsule_id, first.payload_digest, "foo-owner-relay:bug-capsules/v0", process.env.NOW);
    store.archiveAccepted(process.env.ROOT, first.capsule.capsule_id, JSON.parse(process.env.RECEIPT));
    const second = store.savePending(process.env.ROOT, capsuleModule.parseBugCapsule(JSON.parse(process.env.SECOND_CAPSULE)));
    store.deletePending(process.env.ROOT, second.capsule.capsule_id);
    fs.writeFileSync(process.env.AUDIT, JSON.stringify(synced));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE: JSON.stringify(capsule),
      SECOND_CAPSULE: JSON.stringify(secondCapsule),
      RECEIPT: JSON.stringify(receipt),
      NOW,
      AUDIT: auditFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await childResult(child);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });

  const synced = new Set(JSON.parse(readFileSync(auditFile, "utf8")) as string[]);
  for (const directory of [
    path.join(root, ".foo"),
    path.join(root, ".foo", "reports"),
    pendingDir(root),
    previewDir(root),
    archiveDir(root),
    deletedDir(root),
  ]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(synced.has(directory), true, `new directory itself was not synced: ${directory}`);
    assert.equal(synced.has(path.dirname(directory)), true, `new directory parent was not synced: ${directory}`);
  }
});

test("a directory replaced after descriptor hardening fails closed before publication", async () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  const outside = path.join(root, "outside-pending");
  mkdirSync(outside, { mode: 0o700 });
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const opened = new Map();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalFchmod = fs.fchmodSync;
    let pendingHardens = 0;
    fs.openSync = function(target, ...args) {
      const fd = originalOpen.call(this, target, ...args);
      if (typeof target === "string") opened.set(fd, path.resolve(target));
      return fd;
    };
    fs.closeSync = function(fd) {
      const result = originalClose.call(this, fd);
      opened.delete(fd);
      return result;
    };
    fs.fchmodSync = function(fd, mode) {
      const result = originalFchmod.call(this, fd, mode);
      if (opened.get(fd) === path.resolve(process.env.PENDING) && ++pendingHardens === 2) {
        fs.renameSync(process.env.PENDING, process.env.DISPLACED);
        fs.symlinkSync(process.env.OUTSIDE, process.env.PENDING);
      }
      return result;
    };
    syncBuiltinESMExports();
    const capsuleModule = await import("./dist/src/bugCapsule.js");
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.savePending(process.env.ROOT, capsuleModule.parseBugCapsule(JSON.parse(process.env.CAPSULE)));
      process.exitCode = 2;
    } catch (error) {
      if (!/directory (?:changed|cannot be a symbolic link)/.test(String(error?.message))) throw error;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE: JSON.stringify(capsule),
      PENDING: pendingDir(root),
      DISPLACED: path.join(root, "displaced-pending"),
      OUTSIDE: outside,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await childResult(child);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(readdirSync(outside), []);
});

test("normal archive and exact replay sync the pending directory after unlink", async () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  const receipt = acceptedReceipt(capsule);
  const auditFile = path.join(root, "unlink-fsync-audit.json");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const opened = new Map();
    const synced = [];
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalFsync = fs.fsyncSync;
    fs.openSync = function(target, ...args) {
      const fd = originalOpen.call(this, target, ...args);
      if (typeof target === "string") opened.set(fd, path.resolve(target));
      return fd;
    };
    fs.fsyncSync = function(fd) {
      const target = opened.get(fd);
      if (target) synced.push(target);
      return originalFsync.call(this, fd);
    };
    fs.closeSync = function(fd) {
      const result = originalClose.call(this, fd);
      opened.delete(fd);
      return result;
    };
    syncBuiltinESMExports();
    const capsuleModule = await import("./dist/src/bugCapsule.js");
    const store = await import("./dist/src/bugReportStore.js");
    const capsule = capsuleModule.parseBugCapsule(JSON.parse(process.env.CAPSULE));
    const saved = store.savePending(process.env.ROOT, capsule);
    const pendingFile = path.join(process.env.ROOT, ".foo", "reports", "pending", capsule.capsule_id + ".json");
    const pendingBytes = fs.readFileSync(pendingFile);
    synced.length = 0;
    store.archiveAccepted(process.env.ROOT, capsule.capsule_id, JSON.parse(process.env.RECEIPT));
    const normal = [...synced];
    fs.writeFileSync(pendingFile, pendingBytes, { mode: 0o600 });
    synced.length = 0;
    store.archiveAccepted(process.env.ROOT, capsule.capsule_id, JSON.parse(process.env.RECEIPT));
    fs.writeFileSync(process.env.AUDIT, JSON.stringify({ normal, replay: synced }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ROOT: root,
      CAPSULE: JSON.stringify(capsule),
      RECEIPT: JSON.stringify(receipt),
      AUDIT: auditFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await childResult(child);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  const audit = JSON.parse(readFileSync(auditFile, "utf8")) as { normal: string[]; replay: string[] };
  assert.equal(audit.normal.includes(pendingDir(root)), true);
  assert.equal(audit.replay.includes(pendingDir(root)), true);
});

test("failed atomic publication removes only its capsule-specific temporary file", async () => {
  const root = tempRoot();
  const capsule = fixedCapsule();
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originalLink = fs.linkSync;
    fs.linkSync = function(source, destination) {
      if (String(destination).endsWith(process.env.CAPSULE_ID + ".json")) {
        const error = new Error("injected publication failure");
        error.code = "EIO";
        throw error;
      }
      return originalLink.call(this, source, destination);
    };
    syncBuiltinESMExports();
    const capsuleModule = await import("./dist/src/bugCapsule.js");
    const store = await import("./dist/src/bugReportStore.js");
    try {
      store.savePending(process.env.ROOT, capsuleModule.parseBugCapsule(JSON.parse(process.env.CAPSULE)));
      process.exitCode = 2;
    } catch (error) {
      if (error.code !== "EIO") throw error;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, ROOT: root, CAPSULE: JSON.stringify(capsule), CAPSULE_ID: capsule.capsule_id },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await childResult(child);
  assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(readdirSync(pendingDir(root)), []);
});
