import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveDevelopmentSkillTrust, developmentSkillTrustProposal, PACKAGE_ROOT,
  resolveSkill, SkillDeliveryError,
} from "../src/skillLocal.js";
import { BUNDLED_SKILL_TREE } from "../src/skillClientPolicy.js";
import { resolveFamilyPack } from "../src/conductor/familyDelivery.js";
import { renderDoctor } from "../src/commands/setup.js";

const skill = "capture-external-artifact";
const wrongAnchor = { ...BUNDLED_SKILL_TREE, tree_sha256: "0".repeat(64) };

test("ambient alpha credentials cannot redirect skills, supply missing skills, or cause requests", async (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-local-skill-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const token = ["legacy", "synthetic", "credential"].join("-");
  writeFileSync(path.join(state, "credentials.json"), JSON.stringify({ skill_token: token }));
  mkdirSync(path.join(state, "skills", skill), { recursive: true });
  writeFileSync(path.join(state, "skills", skill, "SKILL.md"), "caller repository shadow");
  const env = { FOO_STATE_DIR: state, FOO_SKILL_TOKEN: token, FOO_SKILL_SERVER: "https://legacy.invalid" };
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network request"); });
  const resolved = await resolveSkill(state, skill, env);
  assert.equal(resolved.source, "local");
  assert.equal(resolved.text, readFileSync(path.join(PACKAGE_ROOT, "skills", skill, "SKILL.md"), "utf8"));
  await assert.rejects(resolveSkill(state, "missing-synthetic-skill", env), (error: unknown) => {
    assert.ok(error instanceof SkillDeliveryError);
    assert.equal(error.kind, "not-found");
    assert.doesNotMatch(error.message, /server|login|token/);
    return true;
  });
  for (const name of ["ideate", "interview", "spec-swarm"]) {
    assert.ok(await resolveFamilyPack(name, "standard", false));
  }
  assert.equal(network.mock.callCount(), 0);
});

test("local authenticity still refuses an unapproved tree and honors exact development approval", async (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-skill-trust-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const record = path.join(state, "development.json");
  const trust = { development_trust_record: record, bundled_skill_tree: wrongAnchor };
  await assert.rejects(resolveSkill(state, skill, {}, trust), (error: unknown) => {
    assert.ok(error instanceof SkillDeliveryError);
    assert.equal(error.kind, "unapproved-source");
    return true;
  });
  const proposal = developmentSkillTrustProposal(PACKAGE_ROOT, { record_path: record });
  approveDevelopmentSkillTrust(PACKAGE_ROOT, proposal.skills_sha256, { record_path: record });
  assert.equal((await resolveSkill(state, skill, {}, trust)).source, "local");
  const expired = { ...JSON.parse(readFileSync(record, "utf8")), expires_at: "2000-01-01T00:00:00.000Z" };
  writeFileSync(record, JSON.stringify(expired));
  await assert.rejects(resolveSkill(state, skill, {}, trust), { kind: "unapproved-source" });
});

test("doctor ignores ambient alpha credentials and names a local repair for missing bundled skills", (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-doctor-local-"));
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; rmSync(state, { recursive: true, force: true }); });
  process.env.FOO_STATE_DIR = state;
  process.env.FOO_SKILL_TOKEN = ["legacy", "synthetic", "credential"].join("-");
  process.env.FOO_SKILL_SERVER = "https://legacy.invalid";
  delete process.env.FIRECRAWL_API_KEY;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network request"); });
  const bundled = JSON.parse(renderDoctor(PACKAGE_ROOT, "json", PACKAGE_ROOT, undefined, state));
  assert.equal(bundled.foo.skills_mode, "bundled");
  assert.equal(bundled.foo.firecrawl_key, false);
  assert.equal(bundled.foo.keyed, undefined);
  const missing = JSON.parse(renderDoctor(PACKAGE_ROOT, "json", state, undefined, state));
  assert.equal(missing.foo.skills_mode, "unavailable");
  assert.match(missing.next_command, /reinstall.*bundled skills/);
  assert.doesNotMatch(missing.next_command, /owner|canary|login/);
  assert.equal(network.mock.callCount(), 0);
});
