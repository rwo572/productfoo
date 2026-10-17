import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInitInteractive } from "../src/initCommand.js";

for (const tty of [false, true]) {
  test(`init --json stays local with legacy credentials (TTY=${tty})`, async (t) => {
    const state = mkdtempSync(path.join(tmpdir(), "foo-init-local-"));
    const originalEnv = { ...process.env };
    t.after(() => { process.env = originalEnv; rmSync(state, { recursive: true, force: true }); });
    process.env.FOO_STATE_DIR = state;
    process.env.FOO_SKILL_TOKEN = ["legacy", "synthetic", "credential"].join("-");
    process.env.FOO_SKILL_SERVER = "https://legacy.invalid";
    writeFileSync(path.join(state, "credentials.json"), JSON.stringify({ skill_token: process.env.FOO_SKILL_TOKEN }));
    const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network request"); });
    const output = new PassThrough();
    const result = await runInitInteractive(state, ["--json"], {
      input: new PassThrough(), output, inputTTY: tty, outputTTY: tty,
    });
    assert.doesNotThrow(() => JSON.parse(result));
    assert.doesNotMatch(result, /access_required|access_rejected|token-stdin|signed.delivery/);
    assert.equal(output.read(), null, "JSON mode must never prompt for a credential");
    assert.equal(network.mock.callCount(), 0);
  });
}
