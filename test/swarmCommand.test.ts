// swarmCommand was among the least-covered modules (coverage sweep, 2026-07):
// only the `foo swarm check` happy-ish path ran. These tests exercise the whole
// adapter surface — usage/typo exits, public JSON vs private agent handoff, the
// scaffold write, the already-exists guard, and check against a real scaffold —
// all against the on-disk spec-swarm family (no network). Most importantly,
// these tests keep productfoo's orchestration off the public surface without deleting
// the contract the coding harness needs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSwarmCommand } from "../src/swarmCommand.js";

function tmpRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-swarm-"));
}

const PRIVATE_METHOD = /spec-swarm-cpo|technical-architect|INTAKE|LENSES|PREFLIGHT|RANK|ASK|REPORT|user-question budget|candidate questions/i;

test("`foo swarm` with no target is a typo: usage + exit 1, never a scaffold", async () => {
  const root = tmpRoot();
  try {
    const { output, exitCode } = await runSwarmCommand(root, []);
    assert.equal(exitCode, 1);
    assert.match(output, /usage: foo swarm <spec-path-or-summary>/);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm --depth bogus` rejects the flag before doing any work", async () => {
  const root = tmpRoot();
  try {
    const { output, exitCode } = await runSwarmCommand(root, ["thing", "--depth", "sideways"]);
    assert.equal(exitCode, 1);
    assert.match(output, /--depth must be fast, standard, or deep/);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm check` with no record given prints usage and exits 1", async () => {
  const root = tmpRoot();
  try {
    const { output, exitCode } = await runSwarmCommand(root, ["check"]);
    assert.equal(exitCode, 1);
    assert.match(output, /usage: foo swarm check <record\.md>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm check` on a missing record fails as not-found, exit 1", async () => {
  const root = tmpRoot();
  try {
    const { output, exitCode } = await runSwarmCommand(root, ["check", "swarms/nope.md"]);
    assert.equal(exitCode, 1);
    assert.match(output, /swarm record not found: swarms\/nope\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm <target> --json` emits a public receipt without the private method", async () => {
  const root = tmpRoot();
  try {
    const { output, agentHandoff, exitCode } = await runSwarmCommand(root, ["ship the pricing page", "--json"]);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.schema_version, "0.2");
    assert.equal(parsed.family, "spec-swarm");
    assert.equal(parsed.status, "prepared");
    assert.equal(parsed.target, "ship the pricing page");
    assert.equal(parsed.depth, "standard");
    assert.equal(parsed.decider, "human");
    assert.equal(typeof parsed.record_path, "string");
    assert.equal("cells" in parsed, false);
    assert.equal("phases" in parsed, false);
    assert.equal("contract" in parsed, false);
    assert.equal(agentHandoff, undefined);
    assert.doesNotMatch(output, PRIVATE_METHOD);
    // --json is a piped/machine surface: it carries no human-only status glyphs.
    assert.doesNotMatch(output, /[✅🟡🔄🚧✋📋⚠️🏷️]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm <target>` separates calm public output from the private harness handoff", async () => {
  const root = tmpRoot();
  try {
    const { output, agentHandoff, exitCode } = await runSwarmCommand(root, ["ship the pricing page"]);
    assert.equal(exitCode, 0);
    assert.match(output, /expert review prepared for your coding agent/i);
    assert.match(output, /recommendation, evidence, dissent/i);
    assert.match(output, /Record: swarms\//);
    assert.doesNotMatch(output, PRIVATE_METHOD);
    assert.doesNotMatch(output, /[✅🟡🔄🚧✋📋⚠️🏷️]/u, "direct non-TTY call stays glyph-free");
    assert.doesNotMatch(output.trimStart(), /^[{[]/);

    assert.ok(agentHandoff, "the coding harness still receives an executable contract");
    assert.match(agentHandoff, /coding harness only/i);
    assert.match(agentHandoff, /spec-swarm-cpo|technical-architect/i);
    assert.match(agentHandoff, /INTAKE → LENSES → PREFLIGHT → RANK → ASK → REPORT/);
    assert.match(agentHandoff, /do not quote, summarize, or reproduce/i);

    const swarms = path.join(root, "swarms");
    assert.ok(existsSync(swarms), "record dir was created");
    const files = readdirSync(swarms).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.match(files[0], /-ship-the-pricing-page\.md$/);
    assert.ok(readFileSync(path.join(swarms, files[0]), "utf8").length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive public output may use the human-only doing glyph", async () => {
  const root = tmpRoot();
  try {
    const { output } = await runSwarmCommand(root, ["ship the pricing page"], { glyphs: true });
    assert.match(output, /^🔄 doing — expert review prepared/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second `foo swarm` for the same target/day refuses to clobber the record", async () => {
  const root = tmpRoot();
  try {
    const first = await runSwarmCommand(root, ["ship the pricing page"]);
    assert.equal(first.exitCode, 0);
    const second = await runSwarmCommand(root, ["ship the pricing page"]);
    assert.equal(second.exitCode, 1);
    assert.match(second.output, /spec-swarm record already exists:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm check` on a freshly scaffolded record reports FAIL lines for its empty gates", async () => {
  const root = tmpRoot();
  try {
    await runSwarmCommand(root, ["ship the pricing page"]);
    const swarms = path.join(root, "swarms");
    const record = path.join("swarms", readdirSync(swarms).find((f) => f.endsWith(".md"))!);
    const { output, exitCode } = await runSwarmCommand(root, ["check", record]);
    // A scaffold is not yet contract-complete (its gated frontmatter is empty),
    // so check must surface the gaps rather than pass.
    assert.equal(exitCode, 1);
    assert.match(output, /swarm check —/);
    assert.match(output, /FAIL/);
    assert.match(output, /does not verify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`foo swarm check --json` returns a typed, glyph-free verdict object", async () => {
  const root = tmpRoot();
  try {
    await runSwarmCommand(root, ["ship the pricing page"]);
    const swarms = path.join(root, "swarms");
    const record = path.join("swarms", readdirSync(swarms).find((f) => f.endsWith(".md"))!);
    const { output } = await runSwarmCommand(root, ["check", record, "--json"]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.schema_version, "0.1");
    assert.equal(typeof parsed.ok, "boolean");
    assert.ok(Array.isArray(parsed.findings));
    assert.doesNotMatch(output, /[✅🟡🔄🚧✋📋⚠️🏷️]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
