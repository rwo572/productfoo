// The JSON-file read helpers factor out productfoo's most repeated I/O idiom. These
// lock the two contracts every call site relied on: readJson propagates a
// failure; readJsonSafe never throws and hands back the fallback instead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJson, readJsonSafe } from "../src/jsonFile.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-jsonfile-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readJson parses a well-formed file into the requested shape", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ version: "1.2.3", nested: { n: 1 } }));
    const parsed = readJson<{ version?: string; nested?: { n?: number } }>(file);
    assert.equal(parsed.version, "1.2.3");
    assert.equal(parsed.nested?.n, 1);
  });
});

test("readJson throws on a missing file", () => {
  withTempDir((dir) => {
    assert.throws(() => readJson(path.join(dir, "nope.json")));
  });
});

test("readJson throws on malformed JSON", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => readJson(file));
  });
});

test("readJsonSafe returns the fallback when the file is missing", () => {
  withTempDir((dir) => {
    assert.deepEqual(readJsonSafe(path.join(dir, "nope.json"), { a: 1 }), { a: 1 });
  });
});

test("readJsonSafe returns the fallback when the file is corrupt", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "}{");
    assert.deepEqual(readJsonSafe(file, []), []);
  });
});

test("readJsonSafe returns parsed content when the file is valid", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ ok: true }));
    assert.deepEqual(readJsonSafe(file, { ok: false }), { ok: true });
  });
});
