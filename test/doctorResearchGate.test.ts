// foo doctor's research-gate line reports what is ACTUALLY wired, per harness.
//
// The line used to key off core.hooksPath — git's COMMIT-hook wiring — and told
// a machine with six freshly wired harness gates "not wired in this harness
// yet" (found live 2026-07-22). B5's contract is explicit: doctor reports what
// the harness can see and never calls partial integration enforced. These
// tests pin the probe to the files the gate actually lives in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { currentHarnessLabel, researchGateDoctorLine, researchGateWiring } from "../src/commands/setup.js";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-doctor-gate-"));
}

function write(base: string, relative: string, content: string): void {
  const full = path.join(base, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test("wiring is read from the harness gate files, never from git config", () => {
  const bare = root();
  assert.ok(researchGateWiring(bare).every((entry) => !entry.wired), "an empty repo has nothing verifiably wired");

  const wiredRepo = root();
  write(wiredRepo, ".claude/settings.json", '{"hooks":{"PreToolUse":[{"hooks":[{"command":"sh .githooks/guard-research.sh"}]}]}}');
  write(wiredRepo, ".cursor/hooks.json", '{"hooks":{"beforeShellExecution":"./.githooks/guard-research.sh"}}');
  const wiring = researchGateWiring(wiredRepo);
  assert.equal(wiring.find((entry) => entry.label === "Claude Code")?.wired, true);
  assert.equal(wiring.find((entry) => entry.label === "Cursor")?.wired, true);
  assert.equal(wiring.find((entry) => entry.label === "Codex")?.wired, false);

  // A settings file that exists but never references the gate is NOT wiring —
  // presence alone was the old line's category error, in file form.
  const decoy = root();
  write(decoy, ".claude/settings.json", '{"hooks":{}}');
  assert.equal(researchGateWiring(decoy).find((entry) => entry.label === "Claude Code")?.wired, false);
});

test("the current harness comes from the shell markers harnesses actually set", () => {
  assert.equal(currentHarnessLabel({ CLAUDECODE: "1" }), "Claude Code");
  assert.equal(currentHarnessLabel({ CODEX_SANDBOX: "1" }), "Codex");
  assert.equal(currentHarnessLabel({}), null);
});

test("the doctor line claims enforcement only where a gate file is verifiably wired", () => {
  const wiredHere = [
    { label: "Claude Code", format: "claude", wired: true },
    { label: "Cursor", format: "cursor", wired: false },
  ];
  assert.match(researchGateDoctorLine(wiredHere, "Claude Code"), /enforced here in Claude Code/);
  assert.match(researchGateDoctorLine(wiredHere, "Claude Code"), /not wired: Cursor/);

  const notHere = researchGateDoctorLine(wiredHere, "Cursor");
  assert.match(notHere, /not wired in Cursor yet/);
  assert.match(notHere, /does not count/);
  assert.doesNotMatch(notHere, /enforced here/);

  // No harness marker: enforcement is not claimable from a bare terminal.
  const terminal = researchGateDoctorLine(wiredHere, null);
  assert.match(terminal, /no coding agent detected/);
  assert.doesNotMatch(terminal, /enforced here/);

  // An unknown harness has no verified gate adapter.
  const unknown = researchGateDoctorLine(wiredHere, "Unknown agent");
  assert.match(unknown, /cannot enforce tool hooks/);
  assert.doesNotMatch(unknown, /install-gate`. Until then/);
});
