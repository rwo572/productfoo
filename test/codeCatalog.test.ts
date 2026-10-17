import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBehaviorStories, type BehaviorStory } from "../src/codeCatalog.js";

const ADDED_FILE = `diff --git a/src/greet.ts b/src/greet.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/greet.ts
@@ -0,0 +1,3 @@
+export function greet(name: string) {
+  return \`hi \${name}\`;
+}
`;

const MODIFIED_FILE = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,4 +1,5 @@
 export function add(a: number, b: number) {
-  return a + b;
+  return a + b + 0;
 }
+export const PI = 3.14;
`;

const DELETED_FILE = `diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function oldHelper() {
-}
`;

const BINARY_FILE = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..4444444
Binary files /dev/null and b/logo.png differ
`;

const LOCKFILE = `diff --git a/package-lock.json b/package-lock.json
index 5555555..6666666 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-  "version": "1.0.0"
+  "version": "1.0.1"
`;

function only(stories: BehaviorStory[]): BehaviorStory {
  assert.equal(stories.length, 1, `expected exactly one story, got ${stories.length}`);
  return stories[0]!;
}

test("added file yields a self-reported, structural-diff story with its exports", () => {
  const { stories } = extractBehaviorStories(ADDED_FILE);
  const story = only(stories);
  assert.equal(story.file, "src/greet.ts");
  assert.equal(story.change_kind, "added");
  assert.ok(story.added_symbols.includes("greet"), "expected `greet` in added symbols");
  assert.equal(story.provenance, "structural-diff");
  assert.equal(story.self_reported, true, "code-derived stories must be self_reported");
  assert.match(story.expected_behavior, /greet/);
});

test("modified file is change_kind modified and counts added/removed lines", () => {
  const { stories } = extractBehaviorStories(MODIFIED_FILE);
  const story = only(stories);
  assert.equal(story.change_kind, "modified");
  assert.ok(story.added_symbols.includes("PI"), "expected the new `PI` export");
  assert.ok(story.added_lines >= 1 && story.removed_lines >= 1);
});

test("deleted file is change_kind removed", () => {
  const { stories } = extractBehaviorStories(DELETED_FILE);
  const story = only(stories);
  assert.equal(story.file, "src/legacy.ts");
  assert.equal(story.change_kind, "removed");
});

test("binary files are skipped and listed in coverage, not silently dropped (R-007)", () => {
  const result = extractBehaviorStories(BINARY_FILE);
  assert.equal(result.stories.length, 0);
  assert.equal(result.coverage.skipped.length, 1);
  assert.equal(result.coverage.skipped[0]!.reason, "binary");
  assert.equal(result.coverage.scanned_files, 1);
});

test("lockfiles are skipped as generated, with a visible reason", () => {
  const result = extractBehaviorStories(LOCKFILE);
  assert.equal(result.stories.length, 0);
  assert.equal(result.coverage.skipped[0]!.reason, "generated/lockfile");
});

test("multiple files get sequential stable ids and accurate coverage", () => {
  const { stories, coverage } = extractBehaviorStories(`${ADDED_FILE}${MODIFIED_FILE}${BINARY_FILE}`);
  assert.deepEqual(
    stories.map((s) => s.id),
    ["bs-001", "bs-002"],
  );
  assert.equal(coverage.scanned_files, 3, "all three sections were scanned");
  assert.equal(coverage.stories, 2, "two produced stories");
  assert.equal(coverage.skipped.length, 1, "one (binary) was skipped");
});

test("an empty diff yields no stories and does not throw (never gates)", () => {
  const result = extractBehaviorStories("");
  assert.equal(result.stories.length, 0);
  assert.equal(result.coverage.scanned_files, 0);
});

test("only top-level and exported declarations become symbols (nested locals excluded)", () => {
  const diff = `diff --git a/src/svc.ts b/src/svc.ts
new file mode 100644
index 0000000..ccccccc
--- /dev/null
+++ b/src/svc.ts
@@ -0,0 +1,5 @@
+export function handler() {
+  const local = 1;
+  return local;
+}
+const TOP = 2;
`;
  const story = only(extractBehaviorStories(diff).stories);
  assert.ok(story.added_symbols.includes("handler"), "exported function kept");
  assert.ok(story.added_symbols.includes("TOP"), "top-level const kept");
  assert.ok(!story.added_symbols.includes("local"), "nested local dropped");
});
