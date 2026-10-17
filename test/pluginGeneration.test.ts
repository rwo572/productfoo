import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FOO_COMMAND_CONTRACT, renderLauncher } from "../src/commandContract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generator = path.join(root, "scripts/build-anthropic-plugin.mjs");

test("marketplace launchers use the installed command contract, including discovery, bug and init", () => {
  execFileSync(process.execPath, [generator, "--check"], { cwd: root });
  for (const entry of FOO_COMMAND_CONTRACT) {
    const actual = readFileSync(path.join(root, "plugins/foo-anthropic/skills", entry.id, "SKILL.md"), "utf8");
    assert.equal(actual, renderLauncher(entry).replace(/^---\n/, `---\nname: ${entry.id}\n`), entry.id);
  }
  const launcher = (id: string) => readFileSync(path.join(root, "plugins/foo-anthropic/skills", id, "SKILL.md"), "utf8");
  assert.match(launcher("discovery"), /Run `foo discovery \$ARGUMENTS`/);
  assert.doesNotMatch(launcher("discovery"), /foo source approve/);
  assert.match(launcher("init"), /Run `foo init`/);
  assert.doesNotMatch(launcher("init"), /--template|--skip-hooks/);
  assert.match(launcher("bug"), /Run `foo report add`/);
  assert.match(launcher("bug"), /Reports stay on this machine/);
  assert.match(launcher("bug"), /ID\+digest/);
});

test("plugin check rejects body drift and a missing launcher without repairing either", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "foo-plugin-generation-"));
  try {
    execFileSync(process.execPath, [generator, "--output-dir", temp], { cwd: root });
    const bug = path.join(temp, "bug/SKILL.md");
    writeFileSync(bug, readFileSync(bug, "utf8").replace("Reports stay on this machine", "Reports should be uploaded"));
    const discovery = path.join(temp, "discovery/SKILL.md");
    rmSync(discovery);
    const retired = path.join(temp, "retired/SKILL.md");
    mkdirSync(path.dirname(retired));
    writeFileSync(retired, "A retired command must not remain in the marketplace.\n");
    const result = spawnSync(process.execPath, [generator, "--check", "--output-dir", temp], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /changed launcher: bug\/SKILL.md/);
    assert.match(result.stderr, /missing launcher: discovery\/SKILL.md/);
    assert.match(result.stderr, /unexpected launcher: retired\/SKILL.md/);
    assert.match(readFileSync(bug, "utf8"), /Reports should be uploaded/);
    assert.throws(() => readFileSync(discovery), { code: "ENOENT" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("plugin generator explains the build prerequisite in a fresh checkout", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "foo-plugin-unbuilt-"));
  try {
    const script = path.join(temp, "scripts/build-anthropic-plugin.mjs");
    mkdirSync(path.dirname(script));
    copyFileSync(generator, script);
    const result = spawnSync(process.execPath, [script, "--check"], { cwd: temp, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compiled command contract is missing/);
    assert.match(result.stderr, /Run npm run build/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
