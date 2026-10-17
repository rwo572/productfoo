import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Exercise the shipped experiment as a process, without a server or private packet.
const script = path.resolve("examples/true-c-spike/analyze.mjs");
function capture(wire: unknown[], canaries: unknown, check: (dir: string, result: SpawnSyncReturns<string>) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-egress-example-"));
  try {
    writeFileSync(path.join(dir, "wire-log.jsonl"), wire.map((row) => JSON.stringify(row)).join("\n"));
    writeFileSync(path.join(dir, "canaries.json"), JSON.stringify(canaries));
    check(dir, spawnSync(process.execPath, [script, dir], { encoding: "utf8", cwd: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const request = { url: "/mcp", headers: { authorization: "Bearer synthetic-disposable-value" }, body: "prompts/get" };

test("egress example creates a scoped local report without a private packet", () => {
  capture([request], [{ value: "synthetic-value-absent-from-request" }], (dir, result) => {
    assert.equal(result.status, 0, String(result.stderr));
    const report = readFileSync(path.join(dir, ".foo", "egress-inventory.md"), "utf8");
    assert.match(report, /NO CANARY MATCHES/);
    assert.match(report, /not proof that no private data left/);
    assert.doesNotMatch(report, /synthetic-disposable-value|synthetic-value-absent-from-request/);
    assert.equal(existsSync(path.join(dir, "specs")), false);
  });
});

test("egress example rejects a positive control without copying payloads into its report", () => {
  capture([request], [{ value: "synthetic-disposable-value", label: "private-label-canary" }], (dir, result) => {
    assert.equal(result.status, 1);
    const report = readFileSync(path.join(dir, ".foo", "egress-inventory.md"), "utf8");
    assert.match(report, /Request 1: canary 1 matched/);
    assert.doesNotMatch(report, /private-label-canary|synthetic-disposable-value/);
  });
});

test("egress example refuses empty evidence and malformed canaries", () => {
  for (const [wire, canaries] of [
    [[], [{ value: "synthetic-canary" }]],
    [[request], []],
    [[request], [{ value: "" }]],
    [[request], [{ value: "   " }]],
    [[{ url: "/mcp" }], [{ value: "synthetic-canary" }]],
  ] as Array<[unknown[], unknown]>) {
    capture(wire, canaries, (dir, result) => {
      assert.equal(result.status, 2);
      assert.equal(existsSync(path.join(dir, ".foo", "egress-inventory.md")), false);
    });
  }
});
