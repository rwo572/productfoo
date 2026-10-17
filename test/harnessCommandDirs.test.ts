// harness-command-dirs-v0 — the resolver is the single source of truth for
// "where + what do I write for this harness at this scope, or why can't I?".
// These lock each verified binding (R-002/R-003) and each honest no-op (R-004).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_GATES } from "../src/harnessGates.js";

import { HARNESS_COMMAND_ADAPTERS, resolveHarnessCommandTarget } from "../src/agentAdapters.js";
import { typedCommand } from "../src/commands/agent.js";

function target(id: keyof typeof HARNESS_COMMAND_ADAPTERS, scope: "global" | "project") {
  return resolveHarnessCommandTarget(HARNESS_COMMAND_ADAPTERS[id], scope);
}

function typed(id: keyof typeof HARNESS_COMMAND_ADAPTERS, command: string) {
  return typedCommand(HARNESS_COMMAND_ADAPTERS[id], command);
}

// What the user actually types. A namespace and a filename prefix are
// independent, and both land in the typed name — namespacing used to swallow
// the prefix, which is how productfoo shipped `/foo-spec` for Codex (a command that
// matches nothing in Codex's menu) all the way through 0.1.10.
test("Codex plugin binds App /foo:* plus CLI $foo:*", () => {
  assert.equal(typed("codex", "spec"), "/foo:spec");
  assert.equal(HARNESS_COMMAND_ADAPTERS.codex.plugin?.name, "foo");
  assert.equal(HARNESS_COMMAND_ADAPTERS.codex.commandLayout, "skills");
  const codex = target("codex", "global");
  assert.ok(codex.supported);
  assert.equal(codex.dir, "plugins/foo/skills");
});

test("directory namespace and flat prefix each still type the way they always did", () => {
  assert.equal(typed("claude-code", "spec"), "/foo:spec");
  assert.equal(typed("opencode", "spec"), "/foo-spec");
  assert.equal(typed("cursor", "spec"), "/foo-spec");
});

test("no adapter still points at the retired aspirational .agents/commands", () => {
  for (const a of Object.values(HARNESS_COMMAND_ADAPTERS)) {
    assert.notEqual(a.commandsDir.global, ".agents/commands", `${a.id} global`);
    assert.notEqual(a.commandsDir.project, ".agents/commands", `${a.id} project`);
  }
});

test("Claude Code: native commands dir with a foo/ namespace subdir, no prefix, .md, both scopes", () => {
  for (const scope of ["global", "project"] as const) {
    const t = target("claude-code", scope);
    assert.ok(t.supported);
    // Subdirectory namespacing (/foo:spec) with zero registration — the retired
    // plugin dir (.claude/skills/foo) never auto-loaded in Claude Code.
    assert.equal(t.dir, ".claude/commands/foo");
    assert.equal(t.extension, ".md");
    assert.equal(t.prefix, "");
  }
  assert.equal(HARNESS_COMMAND_ADAPTERS["claude-code"].commandNamespace, "foo");
  assert.equal(HARNESS_COMMAND_ADAPTERS["claude-code"].legacyPluginDir, ".claude/skills/foo");
});

test("Codex: personal plugin is global-only; project scope is unsupported", () => {
  const g = target("codex", "global");
  assert.ok(g.supported);
  assert.equal(g.dir, "plugins/foo/skills");
  assert.equal(g.extension, ".md");
  assert.equal(g.prefix, "");
  const p = target("codex", "project");
  assert.equal(p.supported, false);
});

test("OpenCode: distinct global vs project dirs, .md, foo- prefix", () => {
  const g = target("opencode", "global");
  const p = target("opencode", "project");
  assert.ok(g.supported && p.supported);
  assert.equal(g.dir, ".config/opencode/commands");
  assert.equal(p.dir, ".opencode/commands");
  assert.equal(p.extension, ".md");
  assert.equal(p.prefix, "foo-");
});

test("Cursor: .cursor/commands both scopes, .md, foo- prefix", () => {
  for (const scope of ["global", "project"] as const) {
    const t = target("cursor", scope);
    assert.ok(t.supported);
    assert.equal(t.dir, ".cursor/commands");
    assert.equal(t.prefix, "foo-");
  }
});


const supportedAgents = ["claude-code", "codex", "cursor", "grok", "opencode"];
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("setup and gate registries expose exactly the selected five agents", () => {
  assert.deepEqual(Object.keys(HARNESS_COMMAND_ADAPTERS).sort(), supportedAgents);
  assert.deepEqual(HARNESS_GATES.map(g => g.format).sort(), ["claude", "codex", "cursor", "grok", "opencode"]);
  assert.equal(HARNESS_GATES.find(g => g.format === "grok")?.coverage.webRead, false);
});

test("all-agent project setup writes only selected native command directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-supported-agents-"));
  try {
    const run = (mode: string) => JSON.parse(execFileSync(process.execPath,
      [cli, "agent", "setup", "--agent", "all", "--scope", "project", mode, "--json"],
      { cwd: root, encoding: "utf8" }));
    const preview = run("--dry-run");
    assert.deepEqual(preview.agents.sort(), supportedAgents);
    assert.deepEqual(readdirSync(root), [], "dry run must not write files");
    assert.equal(preview.changes.find((c: { agent: string }) => c.agent === "codex").action, "unsupported");
    const applied = run("--yes");
    assert.deepEqual(applied.agents.sort(), supportedAgents);
    assert.deepEqual(readdirSync(root).sort(), [".claude", ".cursor", ".grok", ".opencode"]);
    assert.ok(readdirSync(path.join(root, ".grok", "commands")).includes("foo-spec.md"));
    assert.ok(!readdirSync(path.join(root, ".grok", "commands")).includes("foo-bug.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown agent selection fails before any configuration is written", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-unknown-agent-"));
  try {
    const result = spawnSync(process.execPath,
      [cli, "agent", "setup", "--agent", "unsupported-agent", "--scope", "project", "--yes", "--json"],
      { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /unknown agent/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
