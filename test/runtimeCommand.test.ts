// runRuntimeCommand was among the least-covered modules (coverage sweep, 2026-07):
// only the --json path ran via the CLI smoke test. These tests drive the human
// text surface — native vs routed model notes, the drift/classification glyph
// gating, roster findings — plus the machine (--json) surface, and assert the
// glyph accessibility + human-surface-only rules from AGENTS.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runRuntimeCommand } from "../src/commands/runtime.js";

// resolveActiveModel/detectRuntimeId read process.env directly, so drive the
// command by setting env, and always restore it.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // Clear the routing vars a prior test/shell may have set so cases don't bleed.
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "FOO_MODEL"]) {
    if (!(k in vars)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("--json reports runtime + active model and never emits a glyph", () => {
  const out = withEnv({ CLAUDECODE: "1" }, () => runRuntimeCommand(["--json"], true));
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.runtime, "string");
  assert.ok(parsed.active, "active model is present");
  assert.doesNotMatch(out, /[⚠️🏷️]/u);
});

test("native harness prints the native line, no active-model note", () => {
  const out = withEnv({ CLAUDECODE: "1" }, () => runRuntimeCommand([], true));
  assert.match(out, /Runtime \(harness\):/);
  assert.match(out, /Active model:\s+native/);
});

test("an inferred (assumed) routed model surfaces the ⚠️ drift note when glyphs are on", () => {
  const out = withEnv(
    { CLAUDECODE: "1", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "redacted" },
    () => runRuntimeCommand([], true),
  );
  assert.match(out, /Active model:/);
  // Inferred-from-endpoint → assumed → drift glyph, always paired with its text.
  assert.match(out, /⚠️/u);
  assert.match(out, /Runtime identity and branch prefix are unchanged/);
});

test("a confirmed routed model (explicit FOO_MODEL) surfaces the 🏷️ classification note", () => {
  const out = withEnv(
    { CLAUDECODE: "1", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", FOO_MODEL: "glm-5.2" },
    () => runRuntimeCommand([], true),
  );
  assert.match(out, /Active model:/);
  // Explicitly declared + routed → confirmed → classification glyph, not drift.
  assert.match(out, /🏷️/u);
  assert.doesNotMatch(out, /⚠️/u);
});

test("the same routed model is glyph-free when glyphs are off (piped/human-gated)", () => {
  const withGlyphs = withEnv(
    { CLAUDECODE: "1", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "redacted" },
    () => runRuntimeCommand([], true),
  );
  const withoutGlyphs = withEnv(
    { CLAUDECODE: "1", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "redacted" },
    () => runRuntimeCommand([], false),
  );
  assert.match(withGlyphs, /⚠️/u);
  assert.doesNotMatch(withoutGlyphs, /[⚠️🏷️]/u);
  // The wording (the note itself) is preserved either way — only the glyph is gated.
  assert.match(withoutGlyphs, /Active model:/);
});
