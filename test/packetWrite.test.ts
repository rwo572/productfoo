import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UsageError } from "../src/errorTaxonomy.js";
import { updateTask } from "../src/packetWrite.js";

const STATUS_CHANGED = "com.adaptivespec.task.status_changed";
const NOW = new Date("2026-09-24T00:00:00Z");

// A task id wrapped in quotes is valid YAML the reader accepts; the writer's
// block locator used to reject it and desync the ledger (#776).
const QUOTED_TASKS = `schema_version: "0.1"
spec_id: pw_demo
tasks:
  - id: "T-001"
    title: Quoted id task
    status: doing
    done_when:
      - check: proof exists
`;

function makePacket(tasksYaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-packet-write-"));
  writeFileSync(path.join(dir, "tasks.yaml"), tasksYaml);
  writeFileSync(path.join(dir, "events.jsonl"), "");
  return dir;
}

function events(dir: string): JsonObjectish[] {
  return readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

type JsonObjectish = Record<string, unknown>;

// scalar() quotes a ULID (it starts with a digit), so the reference may be quoted.
function eventRef(id: string): RegExp {
  return new RegExp(`event: "?${id}"?`);
}

test("updateTask moves a plain unquoted id end to end", () => {
  const dir = makePacket(`schema_version: "0.1"\nspec_id: pw_demo\ntasks:\n  - id: T-001\n    title: Plain task\n    status: doing\n`);

  const { event, from, to } = updateTask({ packetDir: dir, taskId: "T-001", status: "blocked", reason: "Waiting on review.", now: NOW });

  assert.equal(from, "doing");
  assert.equal(to, "blocked");
  const written = readFileSync(path.join(dir, "tasks.yaml"), "utf8");
  assert.match(written, /status: blocked/);
  assert.match(written, eventRef(String(event.id)));
  assert.equal(events(dir).length, 1);
});

test("a valid quoted id updates successfully and appends one event (#776)", () => {
  const dir = makePacket(QUOTED_TASKS);

  const { event, from, to } = updateTask({ packetDir: dir, taskId: "T-001", status: "done", summary: "Shipped.", now: NOW });

  assert.equal(from, "doing");
  assert.equal(to, "done");
  const written = readFileSync(path.join(dir, "tasks.yaml"), "utf8");
  assert.match(written, /status: done/);
  assert.match(written, /id: T-001/);
  assert.match(written, eventRef(String(event.id)), "the task block references the appended event id");
  const ledger = events(dir);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].type, STATUS_CHANGED);
});

test("updating a quoted-id task by its pasted quoted form throws a usage error and writes nothing (#776)", () => {
  const dir = makePacket(QUOTED_TASKS);
  const before = readFileSync(path.join(dir, "tasks.yaml"), "utf8");

  assert.throws(
    () => updateTask({ packetDir: dir, taskId: '"T-001"', status: "done", summary: "Shipped.", now: NOW }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError, "a UsageError (never a Bug Capsule), not a bare Error");
      assert.match(error.message, /"T-001"/);
      assert.match(error.message, /tasks\.yaml/);
      return true;
    },
  );

  // Nothing written: the ledger must not claim a transition the file never carried.
  assert.equal(readFileSync(path.join(dir, "events.jsonl"), "utf8"), "");
  assert.equal(readFileSync(path.join(dir, "tasks.yaml"), "utf8"), before);
});

test("a corrected retry after a failed update appends exactly one event — no double-counted transition (#776)", () => {
  const dir = makePacket(QUOTED_TASKS);

  assert.throws(
    () => updateTask({ packetDir: dir, taskId: '"T-001"', status: "done", summary: "Shipped.", now: NOW }),
    UsageError,
  );
  updateTask({ packetDir: dir, taskId: "T-001", status: "done", summary: "Shipped.", now: NOW });

  const ledger = events(dir);
  assert.equal(ledger.length, 1, "exactly one status_changed event across both attempts");
  assert.equal(ledger[0].type, STATUS_CHANGED);
  const written = readFileSync(path.join(dir, "tasks.yaml"), "utf8");
  assert.match(written, eventRef((ledger[0] as { id: string }).id), "the file carries the one real transition");
});

test("updateTask accepts a trailing-comment id the reader always accepted (#776)", () => {
  const dir = makePacket(`schema_version: "0.1"\nspec_id: pw_demo\ntasks:\n  - id: T-001 # pending review\n    title: Commented id task\n    status: doing\n`);

  const { from, to } = updateTask({ packetDir: dir, taskId: "T-001", status: "done", summary: "Shipped.", now: NOW });

  assert.equal(from, "doing");
  assert.equal(to, "done");
  assert.equal(events(dir).length, 1);
});

test("a quoted id the locator still cannot place fails cleanly before any write (#776)", () => {
  // The reader parses the plain scalar `T-003#tag` whole; the locator's unquoted
  // branch stops at `#`, exercising the reader-finds/writer-rejects path.
  const dir = makePacket(`schema_version: "0.1"\nspec_id: pw_demo\ntasks:\n  - id: T-003#tag\n    title: Hash id task\n    status: doing\n`);
  const before = readFileSync(path.join(dir, "tasks.yaml"), "utf8");

  assert.throws(
    () => updateTask({ packetDir: dir, taskId: "T-003#tag", status: "done", now: NOW }),
    (error: unknown) => {
      assert.ok(error instanceof UsageError, "a UsageError (never a Bug Capsule), not a bare Error");
      assert.match(error.message, /T-003#tag/);
      return true;
    },
  );

  assert.equal(readFileSync(path.join(dir, "events.jsonl"), "utf8"), "");
  assert.equal(readFileSync(path.join(dir, "tasks.yaml"), "utf8"), before);
});
