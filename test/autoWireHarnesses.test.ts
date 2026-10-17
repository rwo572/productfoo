// install-once-wire-all, ask-first (#913, #622): an installed client offers to
// wire its harness slash-commands once, for the agents the person named,
// remembers the answer, and refreshes consented agents after an upgrade.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { autoWireAgents, harnessStampPath, maybeAutoWireHarnesses } from "../src/commands/agent.js";

// A package root with no source (no src/cli.ts) = an installed client, whether
// or not it bundles skills/ (the public npm package does).
function installRoot(withSkills = false): string {
  const root = mkdtempSync(path.join(tmpdir(), "foo-install-root-"));
  if (withSkills) mkdirSync(path.join(root, "skills"), { recursive: true });
  return root;
}
const home = () => mkdtempSync(path.join(tmpdir(), "foo-home-"));
const say = (answer: boolean, asked: string[] = []) => async (question: string) => {
  asked.push(question);
  return answer;
};
const stampOf = (dir: string) => JSON.parse(readFileSync(harnessStampPath(dir), "utf8")) as { version: string; agents: string[]; consent: string };

test("first run with nobody to ask writes nothing and stamps nothing — the question waits for a person", async () => {
  const dir = home();
  assert.equal(await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: installRoot(), env: {} }), null);
  assert.ok(!existsSync(harnessStampPath(dir)), "no stamp: a later terminal run still asks");
  assert.ok(!existsSync(path.join(dir, ".claude")), "no harness file written");
});

test("first run asks once, naming the agents, and a yes wires them and stamps consent", async () => {
  const dir = home();
  const asked: string[] = [];
  const res = await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: installRoot(), env: {}, ask: say(true, asked) });
  assert.ok(res && res.reason === "first-run");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Set up productfoo's commands in .*Claude Code.*\? \[Y\/n\] $/, "the question names the agents; Enter means yes");
  assert.ok(res.wired.includes("claude-code") && res.wired.includes("opencode"), `wired: ${res.wired.join(",")}`);
  assert.ok(existsSync(path.join(dir, ".claude/commands/foo/ideate.md")), "claude-code ideate.md written");
  assert.deepEqual(stampOf(dir), { ...stampOf(dir), version: "9.9.9", consent: "yes" });
});

test("a no is remembered: nothing written, never asked again, even after an upgrade", async () => {
  const dir = home();
  const root = installRoot();
  const res = await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: root, env: {}, ask: say(false) });
  assert.ok(res && res.reason === "declined");
  assert.ok(!existsSync(path.join(dir, ".claude")), "declined: no harness file written");
  assert.equal(stampOf(dir).consent, "no");
  const asked: string[] = [];
  assert.equal(await maybeAutoWireHarnesses("9.9.10", { home: dir, packageRoot: root, env: {}, ask: say(true, asked) }), null);
  assert.equal(asked.length, 0, "a declined offer is not repeated on upgrade");
});

test("the profile's agents drive the offer (#622)", async () => {
  const dir = home();
  const asked: string[] = [];
  const res = await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: installRoot(), env: {}, preferred: ["cursor", "claude-code"], ask: say(true, asked) });
  assert.ok(res && res.reason === "first-run");
  assert.deepEqual([...res.wired].sort(), ["claude-code", "cursor"]);
  assert.doesNotMatch(asked[0], /OpenCode/, "an agent the person did not name is not offered");
  assert.ok(!existsSync(path.join(dir, ".config/opencode/commands/foo-ideate.md")), "opencode left alone");
});

test("Codex is never wired silently; a profile naming only Codex asks nothing", async () => {
  assert.ok(!autoWireAgents().some((agent) => agent.id === "codex"));
  const asked: string[] = [];
  assert.equal(await maybeAutoWireHarnesses("9.9.9", { home: home(), packageRoot: installRoot(), env: {}, preferred: ["codex"], ask: say(true, asked) }), null);
  assert.equal(asked.length, 0);
});

test("after a yes, the same version is a no-op and an upgrade refreshes exactly the consented agents without asking", async () => {
  const dir = home();
  const root = installRoot();
  await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: root, env: {}, preferred: ["claude-code"], ask: say(true) });
  assert.equal(await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: root, env: {} }), null, "fast path");
  const asked: string[] = [];
  const res = await maybeAutoWireHarnesses("9.9.10", { home: dir, packageRoot: root, env: {}, ask: say(false, asked) });
  assert.ok(res && res.reason === "upgrade");
  assert.deepEqual(res.wired, ["claude-code"]);
  assert.equal(asked.length, 0, "consent carries across upgrades");
  assert.equal(stampOf(dir).version, "9.9.10");
});

test("an older stamp without a consent field (a pre-ask-first alpha install) keeps refreshing on upgrade", async () => {
  const dir = home();
  mkdirSync(path.dirname(harnessStampPath(dir)), { recursive: true });
  writeFileSync(harnessStampPath(dir), JSON.stringify({ version: "0.1.36", agents: ["claude-code"] }));
  const res = await maybeAutoWireHarnesses("0.1.37", { home: dir, packageRoot: installRoot(), env: {} });
  assert.ok(res && res.reason === "upgrade");
  assert.deepEqual(res.wired, ["claude-code"]);
});

test("the public package (bundled skills/, no source) is offered setup too (#913)", async () => {
  const asked: string[] = [];
  const res = await maybeAutoWireHarnesses("9.9.9", { home: home(), packageRoot: installRoot(true), env: {}, ask: say(true, asked) });
  assert.ok(res && res.reason === "first-run", "bundled skills no longer read as a source checkout");
  assert.equal(asked.length, 1);
});

test("a source checkout (src/cli.ts) never self-wires — it manages harnesses by hand", async () => {
  const devRoot = installRoot(true);
  mkdirSync(path.join(devRoot, "src"), { recursive: true });
  writeFileSync(path.join(devRoot, "src", "cli.ts"), "");
  const asked: string[] = [];
  assert.equal(await maybeAutoWireHarnesses("9.9.9", { home: home(), packageRoot: devRoot, env: {}, ask: say(true, asked) }), null);
  assert.equal(asked.length, 0);
});

test("FOO_NO_AUTOWIRE=1 opts out entirely", async () => {
  const dir = home();
  assert.equal(await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: installRoot(), env: { FOO_NO_AUTOWIRE: "1" }, ask: say(true) }), null);
  assert.ok(!existsSync(harnessStampPath(dir)), "no stamp, nothing written");
});

test("the bare invocation is not eligible to wire — the front door answers before it writes", async () => {
  // FTUX defect: bare `foo` has no domain, so it missed the trivial-meta
  // exemption and the global wire ran BEFORE "domain missing" printed — foo
  // mutated a stranger's home directory before introducing itself. The bare
  // invocation and the meta commands are ineligible; real commands still wire.
  const { autoWireEligibleDomain } = await import("../src/commands/agent.js");
  assert.equal(autoWireEligibleDomain(undefined), false);
  for (const meta of ["--version", "-v", "version", "help", "--help", "-h"]) {
    assert.equal(autoWireEligibleDomain(meta), false, meta);
  }
  assert.equal(autoWireEligibleDomain("spec"), true);
  assert.equal(autoWireEligibleDomain("init"), true);
});

// #930: after the user accepts first-run setup (global scope), doctor must
// report those agents ready — not "missing (project)" with a project-setup hand-off.
test("doctor reports globally set-up agents as ready right after the user accepts setup", async () => {
  const { renderDoctor } = await import("../src/commands/setup.js");
  const dir = home();
  const project = mkdtempSync(path.join(tmpdir(), "foo-doctor-project-"));
  await maybeAutoWireHarnesses("9.9.9", { home: dir, packageRoot: installRoot(), env: {}, preferred: ["claude-code", "cursor"], ask: say(true) });
  const report = JSON.parse(renderDoctor(project, "json", installRoot(), undefined, dir)) as {
    companions: { set_up: boolean; adapters: Array<{ id: string; scope: string; status: string }> };
    next_command: string;
  };
  const byId = new Map(report.companions.adapters.map((adapter) => [adapter.id, adapter]));
  for (const id of ["claude-code", "cursor"]) {
    assert.equal(byId.get(id)?.status, "ready", `${id} is set up`);
    assert.equal(byId.get(id)?.scope, "global", `${id} is reported where it was set up`);
  }
  assert.equal(byId.get("opencode")?.status, "missing", "an agent the user did not pick stays missing");
  assert.equal(report.companions.set_up, true);
  assert.doesNotMatch(report.next_command, /--scope project/, "no hand-off to a different setup");
});
