// foo-open-source-transition-v0 T-003 — the anchor drift tripwire.
//
// The bundled-skill trust anchor (BUNDLED_SKILL_TREE) is what makes an
// installed package run its own skills with no hosted call and no per-machine
// approval, so it must name the tree this checkout actually ships. A review
// that edits skills/ without re-anchoring ships a client that refuses its own
// bundled skills on every clean install. This test fails that build; the
// generator is `node scripts/skill-tree-anchor.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLED_SKILL_TREE, BUNDLED_SKILL_TREE_DOMAIN } from "../src/skillClientPolicy.js";
import { PACKAGE_ROOT } from "../src/skillLocal.js";
import { skillTreeSnapshot, topLevelSkillFolderCount } from "../src/skillTreeDigest.js";

// Mirrors DEV_TREE_HASH_DOMAIN in skillLocal.ts, which is module-private on
// purpose: the test quotes it to pin the two digest namespaces apart.
const DEV_TREE_HASH_DOMAIN = "foo.development-skill-tree.v1";

test("the committed bundled-skill anchor names the tree this build ships", () => {
  const snapshot = skillTreeSnapshot(PACKAGE_ROOT, BUNDLED_SKILL_TREE_DOMAIN);
  assert.equal(
    snapshot.hash,
    BUNDLED_SKILL_TREE.tree_sha256,
    "skills/ changed without re-anchoring — run `node scripts/skill-tree-anchor.mjs` and commit the anchor with the tree",
  );
  assert.equal(topLevelSkillFolderCount(PACKAGE_ROOT), BUNDLED_SKILL_TREE.skill_count);
});

test("the bundled anchor digest is domain-separated from the development-trust digest", () => {
  // Same walk, different hash domain: a development record and the release
  // anchor must never be interchangeable proofs for the same tree.
  const bundled = skillTreeSnapshot(PACKAGE_ROOT, BUNDLED_SKILL_TREE_DOMAIN);
  const development = skillTreeSnapshot(PACKAGE_ROOT, DEV_TREE_HASH_DOMAIN);
  assert.notEqual(bundled.hash, development.hash);
  assert.equal(bundled.hash, BUNDLED_SKILL_TREE.tree_sha256);
});
