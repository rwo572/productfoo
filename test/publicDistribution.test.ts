import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const library = pathToFileURL(resolve("scripts/lib/publicManifest.mjs")).href;

test("public source rules reject compiled output, local state and private service trees", async () => {
  const { sourceFindings } = await import(library);
  assert.deepEqual(sourceFindings(["src/cli.ts", "test/example.test.ts", "docs/README.md", "specs/example/spec.md", ".github/workflows/ci.yml"]), []);
  for (const file of ["dist/src/cli.js", "src/cli.js", "src/cli.d.ts", "src/cli.ts.map", ".foo/token.json", ".env", "web/foo-site/server.ts", "notes.txt", "docs/../.env"]) {
    assert.ok(sourceFindings([file]).length > 0, file);
  }
});

test("public package rules reject unexpected files and compiled modules without reviewed source", async () => {
  const { packageFindings } = await import(library);
  const source = ["src/cli.ts", "skills/spec/SKILL.md", "bin/foo", "package.json", "README.md", "LICENSE"];
  assert.deepEqual(packageFindings(["dist-public/src/cli.js", "dist-public/src/cli.d.ts", "skills/spec/SKILL.md", "bin/foo", "package.json", "README.md", "LICENSE"], source), []);
  for (const file of ["dist/src/cli.js", "dist-public/test/example.js", "dist-public/src/missing.js", "skills/.env", "skills/spec/secret.pem", "config/credentials.json", ".npmrc", "examples/data.json", "src/cli.ts"]) {
    assert.ok(packageFindings([file], source).length > 0, file);
  }
});

test("reviewed inventories fail for additions and deletions instead of silently regenerating", async () => {
  const { inventoryFindings } = await import(library);
  assert.deepEqual(inventoryFindings(["a", "b"], ["b", "a"]), []);
  assert.deepEqual(inventoryFindings(["a", "b"], ["a", "c"]), ["unreviewed: b", "missing: c"]);
  assert.ok(inventoryFindings(["a"], ["a", "a"]).some((s: string) => s.includes("duplicate")));
});
