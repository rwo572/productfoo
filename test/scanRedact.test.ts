// #777 — collectScanTargets used lstat and pushed only isFile/isDirectory
// results, so symlinked files were silently dropped (a secret-detection
// blindspot) and broken links vanished instead of surfacing as skips. These
// tests pin the contract: a linked file's secrets get scanned, and every path
// the walk declines to scan shows up in the skipped list with a reason.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runScanCommand } from "../src/commands/scanRedact.js";
import type { ScanResult } from "../src/redactEngine.js";

// Canonical AWS example access key id: matches the aws_access_key_id detector
// (high confidence) without being a live-shaped value. The literal is split so
// the source never contains a contiguous secret-shaped string — the repo's own
// self check (B1) scans tracked files and would block the commit otherwise.
const SECRET = "AKIA" + "IOSFODNN7EXAMPLE";

type ScanPayload = {
  scanned: number;
  skipped: { file: string; reason: string }[];
  results: { file: string; result: ScanResult }[];
};

function scanJson(target: string): ScanPayload {
  const { output } = runScanCommand(["--json", target]);
  return JSON.parse(output) as ScanPayload;
}

test("scan follows a symlinked file and reports its secrets (#777)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scan-symlink-"));
  writeFileSync(path.join(root, "real.env"), `AWS_ACCESS_KEY_ID=${SECRET}\n`);
  symlinkSync(path.join(root, "real.env"), path.join(root, "linked.env"));

  const payload = scanJson(root);

  const linked = payload.results.filter((r) => path.basename(r.file) === "linked.env");
  assert.equal(linked.length, 1, `expected the symlink to be scanned, got: ${JSON.stringify(payload.results.map((r) => r.file))}`);
  assert.ok(
    linked[0].result.findings.some((f) => f.detector === "aws_access_key_id"),
    "the secret behind the symlink was not reported",
  );
  assert.deepEqual(payload.skipped, []);
});

test("scan follows a symlinked file passed directly as the target (#777)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scan-symlink-arg-"));
  writeFileSync(path.join(root, "real.env"), `AWS_ACCESS_KEY_ID=${SECRET}\n`);
  const link = path.join(root, "linked.env");
  symlinkSync(path.join(root, "real.env"), link);

  const payload = scanJson(link);

  assert.equal(payload.scanned, 1);
  assert.ok(payload.results[0].result.findings.some((f) => f.detector === "aws_access_key_id"));
  assert.deepEqual(payload.skipped, []);
});

test("scan surfaces a dangling symlink as a broken-symlink skip (#777)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scan-dangling-"));
  writeFileSync(path.join(root, "plain.txt"), "nothing secret here\n");
  symlinkSync("gone.txt", path.join(root, "dangling.txt"));

  const payload = scanJson(root);

  assert.equal(payload.scanned, 1);
  assert.deepEqual(payload.skipped, [
    { file: path.relative(process.cwd(), path.join(root, "dangling.txt")), reason: "broken-symlink" },
  ]);
});

test("scan reports a symlink loop as a broken symlink instead of crashing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scan-loop-"));
  symlinkSync("loop", path.join(root, "loop"));

  const payload = scanJson(root);

  assert.equal(payload.scanned, 0);
  assert.deepEqual(payload.skipped, [
    { file: path.relative(process.cwd(), path.join(root, "loop")), reason: "broken-symlink" },
  ]);
});

test("scan skips a symlinked directory without dropping it silently", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scan-dirlink-"));
  mkdirSync(path.join(root, "real-dir"));
  writeFileSync(path.join(root, "real-dir", "nested.env"), `AWS_ACCESS_KEY_ID=${SECRET}\n`);
  symlinkSync(path.join(root, "real-dir"), path.join(root, "dirlink"));

  const payload = scanJson(root);

  // The real directory is still walked; the link is surfaced, not followed
  // (following could cycle) and not dropped.
  assert.deepEqual(payload.skipped, [
    { file: path.relative(process.cwd(), path.join(root, "dirlink")), reason: "symlinked-directory" },
  ]);
  assert.ok(payload.results.some((r) => r.file.endsWith(path.join("real-dir", "nested.env"))));
});
