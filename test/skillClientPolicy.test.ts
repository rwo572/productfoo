import assert from "node:assert/strict";
import { test } from "node:test";
import * as policy from "../src/skillClientPolicy.js";

test("skill release policy contains only the local bundled tree anchor", () => {
  assert.deepEqual(Object.keys(policy).sort(), ["BUNDLED_SKILL_TREE", "BUNDLED_SKILL_TREE_DOMAIN"]);
  assert.ok(policy.BUNDLED_SKILL_TREE.skill_count > 0);
  assert.match(policy.BUNDLED_SKILL_TREE.tree_sha256, /^[0-9a-f]{64}$/);
});
