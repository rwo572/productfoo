import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPricing } from "../src/loopBudget.js";
import { loadModelRoster } from "../src/activeModel.js";
import { loadRoutingPolicy } from "../src/routingPolicy.js";

const files = ["pricing.yaml", "routing-policy.yaml"];

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "foo-config-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "config"));
  for (const name of files) copyFileSync(path.join("config", name), path.join(root, "config", name));
  return root;
}

test("bundled configuration loads from config/ for pricing, models, routing", (t) => {
  const root = fixture(t);
  assert.equal(loadPricing(root).available, true);
  assert.equal(loadModelRoster(root).available, true);
  assert.equal(loadRoutingPolicy(root).available, true);
});

test("existing root configuration takes precedence, including invalid overrides", (t) => {
  const root = fixture(t);
  for (const name of files) writeFileSync(path.join(root, name), "[]\n");
  assert.throws(() => loadPricing(root), /must be an object/);
  assert.equal(loadModelRoster(root).available, false);
  assert.equal(loadRoutingPolicy(root).available, false);
});

test("missing configuration stays unavailable without falling back to another project", (t) => {
  const root = fixture(t);
  rmSync(path.join(root, "config"), { recursive: true });
  assert.equal(loadPricing(root).available, false);
  assert.equal(loadModelRoster(root).available, false);
  assert.equal(loadRoutingPolicy(root).available, false);
});
