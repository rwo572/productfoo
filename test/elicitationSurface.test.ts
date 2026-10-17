import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { detectElicitationSurface, detectRuntimeId } from "../src/elicitationSurface.js";

const FOO_BIN = path.resolve("bin/foo");

// --- detectRuntimeId -------------------------------------------------------

test("detectRuntimeId identifies Claude Code, Codex, and unknown runtimes", () => {
  assert.equal(detectRuntimeId({ CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectRuntimeId({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "claude-code");
  assert.equal(detectRuntimeId({ CODEX_HOME: "/x" }), "codex");
  assert.equal(detectRuntimeId({}), "unknown");
  assert.equal(detectRuntimeId({ FOO_RUNTIME: "my-runtime", CLAUDECODE: "1" }), "my-runtime");
});

// --- C-002: a non-widget runtime / non-interactive output -> text ----------

test("a non-widget runtime is routed to the numbered-text surface (C-002)", () => {
  const decision = detectElicitationSurface({ env: { FOO_RUNTIME: "codex" }, isTTY: true });
  assert.equal(decision.surface, "text");
  assert.equal(decision.runtime, "codex");
});

test("an unknown runtime on a TTY still defaults to text (C-002)", () => {
  assert.equal(detectElicitationSurface({ env: {}, isTTY: true }).surface, "text");
});

test("non-interactive output falls back to text even for a widget-capable runtime (R-004)", () => {
  const decision = detectElicitationSurface({ env: { CLAUDECODE: "1" }, isTTY: false });
  assert.equal(decision.surface, "text");
  assert.match(decision.reason, /non-interactive/);
});

test("a forced widget cannot be rendered into a non-interactive stream (R-004 precedence)", () => {
  const decision = detectElicitationSurface({
    env: { FOO_ELICITATION_SURFACE: "widget", CLAUDECODE: "1" },
    isTTY: false,
  });
  assert.equal(decision.surface, "text");
});

// --- the widget path -------------------------------------------------------

test("a widget-capable runtime on a TTY earns the widget surface", () => {
  const decision = detectElicitationSurface({ env: { CLAUDECODE: "1" }, isTTY: true });
  assert.equal(decision.surface, "widget");
  assert.equal(decision.runtime, "claude-code");
});

test("FOO_ELICITATION_SURFACE=text forces text on a capable TTY runtime", () => {
  const decision = detectElicitationSurface({
    env: { FOO_ELICITATION_SURFACE: "text", CLAUDECODE: "1" },
    isTTY: true,
  });
  assert.equal(decision.surface, "text");
});

test("FOO_ELICITATION_SURFACE=widget opts a non-capable runtime into the widget on a TTY", () => {
  const decision = detectElicitationSurface({
    env: { FOO_ELICITATION_SURFACE: "widget", FOO_RUNTIME: "codex" },
    isTTY: true,
  });
  assert.equal(decision.surface, "widget");
});

test("FOO_WIDGET_RUNTIMES extends the capable set", () => {
  const decision = detectElicitationSurface({
    env: { FOO_RUNTIME: "my-runtime", FOO_WIDGET_RUNTIMES: "my-runtime,other" },
    isTTY: true,
  });
  assert.equal(decision.surface, "widget");
});

// --- C-002 via the real CLI (stdout piped -> non-interactive -> text) ------

test("`foo elicitation surface --json` returns text when piped (C-002)", () => {
  const result = spawnSync("node", [FOO_BIN, "elicitation", "surface", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.surface, "text");
  assert.ok(typeof decision.reason === "string" && decision.reason.length > 0);
});
