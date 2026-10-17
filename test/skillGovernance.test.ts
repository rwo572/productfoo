import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

interface RegistrySkill {
  id: string;
  path: string;
  status: string;
}

interface Registry {
  skills: RegistrySkill[];
}

function readRegistry(): Registry {
  return YAML.parse(readFileSync("skills/skill-registry.yaml", "utf8")) as Registry;
}

test("customer discovery uses only its proof-gated in-memory path", () => {
  const registry = readRegistry();
  const customerDiscovery = registry.skills.find((skill) => skill.id === "customer-discovery");
  const skill = readFileSync("skills/customer-discovery/SKILL.md", "utf8");
  const governance = readFileSync("skills/README.md", "utf8");

  assert.equal(customerDiscovery?.status, "active");
  assert.match(skill, /foo discovery match/);
  assert.match(skill, /ready_to_synthesize/);
  assert.doesNotMatch(skill, /hand the transcript to `study-digest`/i);
  for (const line of governance.split(/\r?\n/).filter((candidate) => candidate.includes("customer-discovery"))) {
    assert.match(line, /proof-gated|in-memory/i, `skill governance advertises customer-discovery: ${line}`);
  }
});

test("every canonical skill has exactly one registry row", () => {
  const registryIds = readRegistry().skills.map((skill) => skill.id).sort();
  const skillDirs = readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try { return readFileSync(`skills/${entry.name}/SKILL.md`, "utf8").length >= 0; }
      catch { return false; }
    })
    .map((entry) => entry.name)
    .sort();

  assert.equal(new Set(registryIds).size, registryIds.length, "registry IDs must be unique");
  assert.deepEqual(registryIds, skillDirs);
});

test("canonical related-skill references name registered skills", () => {
  const registry = readRegistry();
  const registered = new Set(registry.skills.map((skill) => skill.id));

  for (const skill of registry.skills) {
    const related = readFileSync(skill.path, "utf8")
      .split("## Related Skills", 2)[1]
      ?.split(/\n## /, 1)[0];
    if (!related) continue;
    for (const line of related.split(/\r?\n/).filter((candidate) => /^-\s+/.test(candidate))) {
      const name = /^-\s+`?([a-z0-9]+(?:-[a-z0-9]+)+)`?(?:\s|$)/.exec(line)?.[1];
      if (!name) continue;
      assert.ok(registered.has(name), `${skill.id} names an unregistered related skill ${name}: ${line}`);
    }
  }
});
