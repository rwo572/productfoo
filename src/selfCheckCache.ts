import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { machineStateDir } from "./machineState.js";

// The self-check scan cache (cli_performance_v0 R-003, D-003): per-file scan
// results keyed on git HEAD + per-file (mtime, size) + detector-set version, so
// a warm `foo self check` rescans only changed, new, or unknown files instead of
// regex-scanning the whole tracked corpus on every run.
//
// Correctness is the bar (B1): a secret added to any tracked file MUST still be
// reported on the next run. The cache never weakens that — a changed file has a
// different (mtime, size); a changed HEAD or allowlist or detector set
// invalidates everything; anything unreadable is treated as cold.
//
// The cache holds scan METADATA only — detector names, line numbers, mtime, and
// size. Never file contents, never matched values (the redaction engine itself
// carries no secret material either). It lives under the machine state dir
// (~/.foo), which is untracked by construction.

// Bump when anything that can change a scan result changes: redactEngine
// detectors, scan options (minEntropyLen), the PII feedback rule, or this
// cache's own entry shape. Bumping forces every cache to a full rescan.
export const SCAN_DETECTOR_VERSION = "self-check-scan-cache-v1";

export type CachedFinding = { detector: string; line: number };

// `pii` mirrors the two-outcome contract of isFeedbackContent: null = the file
// is not feedback content (no pii scan ran); an array = feedback content with
// its high-confidence pii findings (possibly empty).
export type ScanCacheEntry = {
  mtimeMs: number;
  size: number;
  // Present when the file was skipped without scanning ("large" > 512 KiB,
  // "binary" NUL byte in the first chunk) — the scan outcome, cached so the
  // warm path can skip the read too.
  skipped?: "large" | "binary";
  findings: CachedFinding[];
  pii: CachedFinding[] | null;
};

export type ScanCache = {
  schema_version: 1;
  repo: string;
  head: string;
  detector_version: string;
  allowlist_digest: string | null;
  entries: Record<string, ScanCacheEntry>;
};

// Bounds (RISK-004): one file per repo root under <state>/self-check/, each
// trimmed to these caps on save, and the directory pruned to the most recently
// used MAX_CACHE_FILES repos. Entries beyond a cap are simply dropped — those
// files get rescanned next run (cold), never reported clean from stale data.
export const MAX_CACHE_ENTRIES = 50_000;
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_CACHE_FILES = 128;

// One file per repo root, so concurrent checkouts of different repos never
// race and per-repo caps stay per-repo. Resolve the root so the same repo
// reached as "." and as an absolute path shares one cache; reached via a
// different cwd-relative path it correctly reads as a different key.
export function scanCachePath(root: string): string {
  const repoKey = path.resolve(root);
  const hash = createHash("sha1").update(repoKey).digest("hex");
  return path.join(machineStateDir(), "self-check", `${hash}.json`);
}

// sha1 of the allowlist file's raw bytes. The allowlist decides what counts as
// a finding, so any change to it must invalidate the cache even when HEAD has
// not moved yet (an uncommitted allowlist edit).
export function allowlistDigest(root: string, allowFile: string): string | null {
  const file = path.join(root, allowFile);
  if (!existsSync(file)) return null;
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// Returns the cache only when everything it was keyed on still matches; any
// mismatch, corruption, or unreadable file reads as cold (a full scan).
export function loadScanCache(root: string, head: string | null, detectorVersion: string, allowlistDigestValue: string | null): ScanCache | null {
  if (head === null) return null; // no HEAD: cannot key safely, never cache
  const file = scanCachePath(root);
  if (!existsSync(file)) return null;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as ScanCache;
    if (
      cache?.schema_version !== 1 ||
      cache.repo !== path.resolve(root) ||
      cache.head !== head ||
      cache.detector_version !== detectorVersion ||
      cache.allowlist_digest !== allowlistDigestValue ||
      typeof cache.entries !== "object" ||
      cache.entries === null
    ) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

// Keeps the lexicographically first maxEntries keys — deterministic, and with
// the entries map rebuilt from the tracked list each run, order carries no
// staleness risk: a dropped entry just means a cold rescan for that file.
export function capScanCacheEntries(entries: Record<string, ScanCacheEntry>, maxEntries: number): Record<string, ScanCacheEntry> {
  const keys = Object.keys(entries).sort();
  if (keys.length <= maxEntries) return entries;
  const kept: Record<string, ScanCacheEntry> = {};
  for (const key of keys.slice(0, maxEntries)) kept[key] = entries[key];
  return kept;
}

// Halve the entry set until the serialized cache fits the byte cap. Also
// deterministic; again only costs a cold rescan for dropped files. A single
// entry too large to halve further (a pathological file can carry ~250k
// findings) is dropped entirely — under-reporting is never an option, so an
// entry the cap cannot hold is simply rescanned next run.
function capSerializedSize(cache: ScanCache): ScanCache {
  let capped = cache;
  while (JSON.stringify(capped).length > MAX_CACHE_BYTES && Object.keys(capped.entries).length > 1) {
    capped = {
      ...capped,
      entries: capScanCacheEntries(capped.entries, Math.max(1, Math.floor(Object.keys(capped.entries).length / 2))),
    };
  }
  if (JSON.stringify(capped).length > MAX_CACHE_BYTES && Object.keys(capped.entries).length > 0) {
    return { ...capped, entries: {} };
  }
  return capped;
}

// Keeps the MAX_CACHE_FILES most recently written repo caches so ephemeral
// repos (test temp dirs get a fresh root every run) cannot accumulate forever
// in the state dir.
export function pruneScanCacheDir(dir: string, maxFiles: number): void {
  let files: { name: string; mtimeMs: number }[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, mtimeMs: statSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return; // the dir does not exist, or cannot be read — nothing to prune
  }
  if (files.length <= maxFiles) return;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(maxFiles)) {
    try {
      unlinkSync(path.join(dir, stale.name));
    } catch {
      // another process already pruned it — fine
    }
  }
}

// Best-effort. A failed cache write must never turn self check red or silent
// about a finding — it only costs the next run its warm path. The run's findings
// are already in memory by the time this is called.
export function saveScanCache(cache: ScanCache): boolean {
  const file = scanCachePath(cache.repo);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(capSerializedSize({ ...cache, entries: capScanCacheEntries(cache.entries, MAX_CACHE_ENTRIES) })));
    pruneScanCacheDir(path.dirname(file), MAX_CACHE_FILES);
    return true;
  } catch {
    return false;
  }
}
