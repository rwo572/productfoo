import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { appendLedgerEvent, isFlagOnlyDomain, LEDGER_MAX_BYTES } from "../src/agentState.js";

// Repo root: this file compiles to dist/test/, so the root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FOO_BIN = path.join(REPO_ROOT, "bin", "foo");

// Rotation (cli-performance-v0 C-009): at the cap, the live file becomes the
// single backup and the append starts fresh — the corpus is renamed, never
// rewritten, and the next rotation replaces the previous backup.
test("appendLedgerEvent rotates the ledger at the size cap and keeps one backup generation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-ledger-rotate-"));
  const logPath = path.join(dir, "agent-events.jsonl");
  const cap = 128;

  appendLedgerEvent(logPath, `${"a".repeat(50)}\n`, cap);
  appendLedgerEvent(logPath, `${"b".repeat(100)}\n`, cap);
  assert.ok(!existsSync(`${logPath}.1`), "no rotation while the file is under the cap");

  appendLedgerEvent(logPath, "fresh\n", cap);
  assert.equal(
    readFileSync(`${logPath}.1`, "utf8"),
    `${"a".repeat(50)}\n${"b".repeat(100)}\n`,
    "the pre-rotation corpus moves to the backup intact",
  );
  assert.equal(readFileSync(logPath, "utf8"), "fresh\n", "the live ledger starts fresh after rotation");

  appendLedgerEvent(logPath, `${"c".repeat(200)}\n`, cap);
  appendLedgerEvent(logPath, "newest\n", cap);
  assert.equal(
    readFileSync(`${logPath}.1`, "utf8"),
    `fresh\n${"c".repeat(200)}\n`,
    "the next rotation replaces the previous backup with the full live corpus",
  );
  assert.equal(readFileSync(logPath, "utf8"), "newest\n");
});

test("appendLedgerEvent defaults to the module cap and creates parent directories", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-ledger-default-"));
  const logPath = path.join(dir, "nested", "agent-events.jsonl");
  assert.ok(LEDGER_MAX_BYTES > 0, "the default cap is positive");
  appendLedgerEvent(logPath, "one\n");
  assert.equal(readFileSync(logPath, "utf8"), "one\n");
});

test("isFlagOnlyDomain matches exactly the flag-only commands (--version, help)", () => {
  assert.equal(isFlagOnlyDomain("version"), true);
  assert.equal(isFlagOnlyDomain("help"), true);
  assert.equal(isFlagOnlyDomain("doctor"), false);
  assert.equal(isFlagOnlyDomain("unknown"), false);
  assert.equal(isFlagOnlyDomain(""), false);
});

function runFoo(root: string, ...args: string[]) {
  return spawnSync("node", [FOO_BIN, "--root", root, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FOO_HANDOFF: "never", FOO_STATE_DIR: path.join(root, "state") },
  });
}

function usageEvents(root: string): Array<Record<string, unknown>> {
  const log = path.join(root, "state", "agent-events.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event_type === "cli_usage");
}

// C-009 (cli-performance-v0 R-004): flag-only invocations append a spurious
// cli_usage event to every machine's ledger. They must write nothing; a real
// command under the same env must still record exactly one event.
test("flag-only commands write no ledger event; a real command still does (C-009)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-ledger-flagonly-"));
  try {
    const version = runFoo(root, "--version");
    assert.equal(version.status, 0, version.stderr);
    const help = runFoo(root, "help");
    assert.equal(help.status, 0, help.stderr);
    assert.equal(usageEvents(root).length, 0, "--version and help append no cli_usage event");

    const doctor = runFoo(root, "doctor", "--json");
    assert.equal(doctor.status, 0, doctor.stderr);
    const events = usageEvents(root);
    assert.equal(events.length, 1, "a real command still appends exactly one event");
    assert.equal(events[0]?.domain, "doctor");
    assert.equal(events[0]?.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
