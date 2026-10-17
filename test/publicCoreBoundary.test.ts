import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Reintroducing the retired dispatcher would make an unrelated database setting
// change this command from an unknown domain into a database/control operation.
test("retired sales commands remain unknown regardless of database configuration", () => {
  const work = mkdtempSync(join(tmpdir(), "productfoo-core-boundary-"));
  try {
    const env = { PATH: process.env.PATH, HOME: work, TMPDIR: tmpdir(), NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_HANDOFF: "never", FOO_STATE_DIR: join(work, ".foo") };
    for (const config of [{}, { DATABASE_URL: "postgresql://127.0.0.1:1/synthetic" }]) {
      const result = spawnSync(process.execPath, [resolve("bin/foo"), "sdr", "status", "synthetic-account"], { cwd: work, env: { ...env, ...config }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unknown domain: sdr/);
    }
    const help = spawnSync(process.execPath, [resolve("bin/foo"), "--help", "--all"], { cwd: work, env, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.doesNotMatch(help.stdout, /foo sdr\b/);
    assert.deepEqual(readdirSync(work), [], "unsupported command must not create project/database state");
  } finally { rmSync(work, { recursive: true, force: true }); }
});
