import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  runShapeCommandWithHandoff,
} from "../src/commands/specCmd.js";

test("a missing bundled registry fails locally without a hosted skill fallback", async (t) => {
  const incompleteRoot = mkdtempSync(path.join(tmpdir(), "foo-incomplete-spec-"));
  t.after(() => rmSync(incompleteRoot, { recursive: true, force: true }));
  await assert.rejects(
    runShapeCommandWithHandoff(process.cwd(), ["add saved filters"], false, { packageRoot: incompleteRoot }),
    /Bundled skill registry is missing.*Rebuild or reinstall/,
  );
});
