// The argv helpers replace a dozen inline `args.indexOf("--flag")` reads. These
// pin the exact semantics those call sites depended on, including the two edge
// cases (flag as the final token; repeated flags take the first).
import test from "node:test";
import assert from "node:assert/strict";
import { hasFlag, flagValue, surplusArgs } from "../src/cliArgs.js";
// The command modules re-export the same helpers; a stale re-export would be a
// silent regression, so assert they are the very same functions.
import { hasFlag as sharedHasFlag, flagValue as sharedFlagValue } from "../src/commands/shared.js";

test("hasFlag detects a bare flag's presence", () => {
  assert.equal(hasFlag(["a", "--json", "b"], "--json"), true);
  assert.equal(hasFlag(["a", "b"], "--json"), false);
});

test("flagValue returns the token immediately after the flag", () => {
  assert.equal(flagValue(["--port", "4020"], "--port"), "4020");
  assert.equal(flagValue(["x", "--dir", "store", "y"], "--dir"), "store");
});

test("flagValue is undefined when the flag is absent", () => {
  assert.equal(flagValue(["--other", "v"], "--dir"), undefined);
});

test("flagValue is undefined when the flag is the final token", () => {
  assert.equal(flagValue(["--dir"], "--dir"), undefined);
});

test("flagValue takes the first occurrence of a repeated flag", () => {
  assert.equal(flagValue(["--by", "a", "--by", "b"], "--by"), "a");
});

// surplusArgs is the answer flagValue cannot give: "what did I never look at?"
// (alpha_tester_fixes_v0 R-001 — the blind spot that dropped an event summary).
test("surplusArgs sees nothing when every token is a known flag or its value", () => {
  assert.deepEqual(surplusArgs(["--summary", "one", "--json"], { value: ["--summary"], boolean: ["--json"] }), []);
});

test("surplusArgs reports a bare positional a flag-reader would have dropped", () => {
  assert.deepEqual(surplusArgs(["a summary"], { value: ["--summary"] }), ["a summary"]);
});

test("surplusArgs reports a flag the command does not have", () => {
  assert.deepEqual(surplusArgs(["--nope", "x"], { value: ["--summary"] }), ["--nope", "x"]);
});

test("surplusArgs never mistakes a flag's value for a positional, even a flag-shaped one", () => {
  assert.deepEqual(surplusArgs(["--summary", "--help"], { value: ["--summary"] }), []);
});

test("commands/shared re-exports the same helper functions", () => {
  assert.equal(sharedHasFlag, hasFlag);
  assert.equal(sharedFlagValue, flagValue);
});
