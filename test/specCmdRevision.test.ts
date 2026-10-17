// Security audit F9: the revision argument handed to `git diff` must never be
// parsed as an option. A revision beginning with "-" is refused at the boundary
// rather than disambiguated with "--", because inside `git diff` everything
// after `--` is a pathspec — the guarded form would silently produce an empty
// diff for every real revision (verified against git: `git diff -- HEAD~1..HEAD`
// exits 0 with empty output while the plain form returns the full diff).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSpecCommand } from "../src/commands/specCmd.js";
import { UsageError } from "../src/errorTaxonomy.js";

test("a dash-prefixed revision is refused before it can reach git as an option (F9)", () => {
  // Not a git repository: if the guard failed to fire, git would run and the
  // panel would render from an empty diff instead of throwing.
  const root = mkdtempSync(path.join(tmpdir(), "foo-spec-rev-"));
  assert.throws(
    () => runSpecCommand(root, "panel", "--output=/tmp/evil-diff.txt", []),
    (error: unknown) => error instanceof UsageError && /must not begin with "-"/.test(error.message),
  );
});

test("a normal revision still reaches git and renders the QA panel (the F9 guard is not over-broad)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-spec-rev-git-"));
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "fixture@example.com"]);
  git(["config", "user.name", "fixture"]);
  writeFileSync(path.join(root, "a.txt"), "first line\n");
  git(["add", "."]);
  git(["commit", "-m", "first"]);
  writeFileSync(path.join(root, "a.txt"), "first line\nsecond: handle the empty case\n");
  git(["add", "."]);
  git(["commit", "-m", "second"]);

  const output = runSpecCommand(root, "panel", "HEAD", []);
  assert.match(output, /^QA panel/);
});
