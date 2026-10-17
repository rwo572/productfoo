// The self-check scan cache (cli_performance_v0 R-003) — the tests that own its
// correctness bar. B1 is the contract: a secret added to ANY tracked file is
// reported on the next run, cached or not. RISK-001 (a stale cache misses a new
// secret) is the dominant risk of the whole packet, so these tests attack the
// cache directly: mutation with a size change, mutation with an UNCHANGED size
// (mtime-only), stale key fields, and over-cap caches — every one of which must
// end in a rescan or a report, never a silent pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSelfCheck } from "../src/selfCheck.js";
import {
  allowlistDigest,
  capScanCacheEntries,
  MAX_CACHE_ENTRIES,
  saveScanCache,
  scanCachePath,
  type CachedFinding,
  type ScanCache,
  type ScanCacheEntry,
} from "../src/selfCheckCache.js";

// Canonical AWS example access key id: matches the aws_access_key_id detector
// (high confidence) without being a live-shaped value. The literal is split so
// the source never contains a contiguous secret-shaped string — the repo's own
// self check (B1) scans tracked files and would block the commit otherwise.
const SECRET = "AKIA" + "IOSFODNN7EXAMPLE";

// Each test scopes the machine state dir to its own temp home, so cache files
// never leak between tests (FOO_STATE_DIR overrides for tests, R-005).
function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-selfcheck-cache-"));
  process.env.FOO_STATE_DIR = dir;
  return dir;
}

// A small real git repo: one tracked text file, one commit (so HEAD exists and
// the cache is keyable).
function tempRepo(content: string): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-selfcheck-repo-"));
  const file = path.join(root, "a.txt");
  writeFileSync(file, content);
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["add", "a.txt"]);
  git(["commit", "-m", "init"]);
  return { root, file };
}

function check(root: string, args: string[] = []): { blocked: boolean; messages: string[]; output: string } {
  // JSON mode: the rendered text form goes through different formatting, and
  // the equivalence test compares text separately via textOutput().
  const { output } = runSelfCheck(root, "check", [...args, "--json"]);
  const payload = JSON.parse(output) as { blocked: boolean; boundaries: { id: string; message: string }[] };
  return { blocked: payload.blocked, messages: payload.boundaries.map((b) => b.message), output };
}

function textOutput(root: string, args: string[] = []): string {
  return runSelfCheck(root, "check", args).output;
}

function loadCache(root: string): ScanCache | null {
  const file = scanCachePath(root);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as ScanCache;
}

function entry(mtimeMs: number, size: number, findings: CachedFinding[]): ScanCacheEntry {
  return { mtimeMs, size, findings, pii: null };
}

// --- C-006: cache invalidation — a secret added to a tracked file is still reported ---

test("a secret added to a tracked file is reported on the next run (size change)", () => {
  const { root, file } = tempRepo("clean file\n");
  tempStateDir();
  assert.equal(check(root).blocked, false, "baseline run is clean");
  assert.ok(loadCache(root), "the first run wrote a scan cache");

  writeFileSync(file, `clean file\ntoken = "${SECRET}"\n`);
  const second = check(root);
  assert.equal(second.blocked, true, "the next run MUST report the secret (B1)");
  assert.ok(
    second.messages.some((m) => m.includes("a.txt:2") && m.includes("aws_access_key_id")),
    `expected an a.txt B1 finding, got: ${JSON.stringify(second.messages)}`,
  );
  // And the warm run after it (finding now cached) still reports it.
  assert.equal(check(root).blocked, true, "the warm run still reports the finding");
});

test("a secret swapped in at the same file size is still reported (mtime-only change)", () => {
  // The (mtime, size) key must catch edits that preserve size — a size-only
  // cache would silently wave a secret through. The padding is exactly the
  // secret's length, so the mutation changes no byte count.
  const padding = "A".repeat(SECRET.length);
  const { root, file } = tempRepo(`value = "${padding}"\n`);
  tempStateDir();
  assert.equal(check(root).blocked, false);
  writeFileSync(file, `value = "${SECRET}"\n`);
  const next = check(root);
  assert.equal(next.blocked, true, "same-size mutation must rescan via mtime");
  assert.ok(next.messages.some((m) => m.includes("a.txt:1")), `expected the finding, got: ${JSON.stringify(next.messages)}`);
});

test("removing the secret clears the finding on the next run", () => {
  const { root, file } = tempRepo("clean file\n");
  tempStateDir();
  check(root);
  writeFileSync(file, `clean file\ntoken = "${SECRET}"\n`);
  assert.equal(check(root).blocked, true);
  writeFileSync(file, "clean file\n");
  assert.equal(check(root).blocked, false, "a cleaned file must clear its B1 finding");
});

// --- C-006: full-mode equivalence — --full output is byte-identical to a plain run ---

test("--full output is byte-identical to plain runs, cold and warm, text and JSON", () => {
  const { root } = tempRepo("clean file\n");
  writeFileSync(path.join(root, "b.txt"), `token = "${SECRET}"\n`);
  spawnSync("git", ["add", "b.txt"], { cwd: root });

  // Cold plain run in a fresh state dir — exactly what origin/main does on
  // every run (no cache to read).
  tempStateDir();
  const coldPlain = check(root);
  // Warm plain run in the same state dir — cache hits on every file.
  const warmPlain = check(root);
  // --full in a fresh state dir — bypasses cache reads entirely.
  tempStateDir();
  const full = check(root, ["--full"]);

  assert.equal(coldPlain.blocked, true, "the scan reports the secret in b.txt");
  assert.equal(coldPlain.output, full.output, "--full (cold) matches the baseline plain run byte for byte");
  assert.equal(warmPlain.output, full.output, "--full matches a warm cached run byte for byte");
  assert.equal(
    textOutput(root, []),
    textOutput(root, ["--full"]),
    "--full matches the plain run in rendered-text mode too",
  );
  assert.ok(loadCache(root), "a --full run refreshes the cache for the next warm run");
});

test("a plain run trusts a cache entry whose key fields match; --full does not", () => {
  // RISK-001 stated outright: a cache entry that claims a secret file is clean.
  // The key gates (head, detector version) are what protect a plain run from
  // STALE entries; a hand-poisoned entry with matching keys is trusted (the
  // cache lives in the user's own state dir) — and --full is the escape hatch.
  const { root, file } = tempRepo("clean file\n");
  tempStateDir();
  check(root); // warm the cache with the clean content
  const cache = loadCache(root);
  assert.ok(cache, "cache exists");

  writeFileSync(file, `token = "${SECRET}"\n`);
  const st = statSync(file);
  // Poison: claim the secret file is clean at its current (mtime, size), with
  // every key field intact.
  const poisoned: ScanCache = { ...cache, entries: { ...cache.entries, "a.txt": entry(st.mtimeMs, st.size, []) } };
  assert.equal(saveScanCache(poisoned), true);
  assert.equal(check(root).blocked, false, "a matching poisoned entry is trusted on a plain run");

  tempStateDir();
  assert.equal(check(root, ["--full"]).blocked, true, "--full rescans and reports the secret");
});

// --- Stale-key gates: every key component invalidates the whole cache (RISK-001) ---

test("a cache with a stale detector version or head is rejected and rescanned", () => {
  const { root, file } = tempRepo("clean file\n");
  tempStateDir();
  check(root);
  writeFileSync(file, `token = "${SECRET}"\n`);
  const st = statSync(file);
  const clean = entry(st.mtimeMs, st.size, []); // lies: says the secret file is clean

  // Stale detector version (what a detector-set change produces until the
  // constant is bumped — and the bump is what forces the rescan).
  const staleVersion = loadCache(root);
  assert.ok(staleVersion);
  saveScanCache({ ...staleVersion, detector_version: "self-check-scan-cache-v0", entries: { "a.txt": clean } });
  assert.equal(check(root).blocked, true, "a version-mismatched cache is rejected — the secret is found");

  // Stale head (what a commit produces): the cache is keyed on HEAD precisely
  // because commits can rewrite content without touching mtimes.
  const staleHead = loadCache(root);
  assert.ok(staleHead);
  saveScanCache({ ...staleHead, head: "0000000000000000000000000000000000000000", entries: { "a.txt": clean } });
  assert.equal(check(root).blocked, true, "a head-mismatched cache is rejected — the secret is found");
});

test("a corrupted cache file reads as cold, never as a crash", () => {
  const { root } = tempRepo("clean file\n");
  tempStateDir();
  check(root);
  const file = scanCachePath(root);
  assert.ok(existsSync(file));
  writeFileSync(file, "{not json at all");
  const result = check(root);
  assert.equal(result.blocked, false, "the run completes with a full rescan");
  assert.ok(JSON.parse(readFileSync(file, "utf8")), "and rewrites a valid cache");
});

// --- RISK-004: the cache is bounded ---

test("capScanCacheEntries keeps a deterministic subset under the cap", () => {
  const entries: Record<string, ScanCacheEntry> = {
    "e/5.txt": entry(1, 1, []),
    "a/1.txt": entry(1, 1, []),
    "c/3.txt": entry(1, 1, []),
    "b/2.txt": entry(1, 1, []),
    "d/4.txt": entry(1, 1, []),
  };
  const capped = capScanCacheEntries(entries, 2);
  assert.deepEqual(Object.keys(capped).sort(), ["a/1.txt", "b/2.txt"]);
  assert.equal(capScanCacheEntries(entries, 5), entries, "under the cap, the map is returned as-is");
});

test("saveScanCache trims a cache over the entry cap", () => {
  tempStateDir();
  const entries: Record<string, ScanCacheEntry> = {};
  for (let i = 0; i < MAX_CACHE_ENTRIES + 1; i++) {
    entries[`f/${String(i).padStart(6, "0")}.txt`] = entry(1, 1, []);
  }
  assert.equal(
    saveScanCache({ schema_version: 1, repo: "/cap-test-repo", head: "head", detector_version: "v1", allowlist_digest: null, entries }),
    true,
  );
  const reloaded = JSON.parse(readFileSync(scanCachePath("/cap-test-repo"), "utf8")) as ScanCache;
  assert.ok(Object.keys(reloaded.entries).length <= MAX_CACHE_ENTRIES, "the saved cache is under the entry cap");
});

test("saveScanCache drops an entry too large for the byte cap", () => {
  tempStateDir();
  // One pathological entry (a 512KB file can carry ~250k findings) over the
  // 8 MiB byte cap cannot be halved — it is dropped entirely, which costs a
  // cold rescan next run, never a stale result.
  const hugeFindings: CachedFinding[] = Array.from({ length: 300_000 }, (_, i) => ({ detector: "entropy", line: i + 1 }));
  assert.equal(
    saveScanCache({
      schema_version: 1,
      repo: "/byte-cap-repo",
      head: "head",
      detector_version: "v1",
      allowlist_digest: null,
      entries: { "big.txt": entry(1, 512 * 1024, hugeFindings) },
    }),
    true,
    "an over-cap cache must not fail the run",
  );
  const reloaded = JSON.parse(readFileSync(scanCachePath("/byte-cap-repo"), "utf8")) as ScanCache;
  assert.ok(JSON.stringify(reloaded).length <= 8 * 1024 * 1024, "the saved cache is under the byte cap");
});

test("a warm run over an unchanged tree does not rewrite the cache", () => {
  const { root } = tempRepo("clean file\n");
  tempStateDir();
  check(root);
  check(root); // ensure the saved cache is already settled
  const file = scanCachePath(root);
  const before = { mtimeMs: statSync(file).mtimeMs, content: readFileSync(file, "utf8") };
  check(root);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs, "no rewrite: the warm run stays read-only");
  assert.equal(readFileSync(file, "utf8"), before.content);
});

// --- allowlist digest: an uncommitted allowlist edit invalidates ---

test("allowlistDigest tracks the allowlist file's content", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-selfcheck-allow-"));
  assert.equal(allowlistDigest(root, ".foo-redact-allow"), null, "no allowlist file digests to null");
  writeFileSync(path.join(root, ".foo-redact-allow"), "literal-one\n");
  const first = allowlistDigest(root, ".foo-redact-allow");
  assert.ok(first && /^[0-9a-f]{40}$/.test(first), "digest is a sha1 hex");
  writeFileSync(path.join(root, ".foo-redact-allow"), "literal-two\n");
  assert.notEqual(allowlistDigest(root, ".foo-redact-allow"), first, "a content change changes the digest");
});
