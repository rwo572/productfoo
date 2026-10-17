// thin-harness-launchers-v0 — the launcher is a pointer, the CLI handoff is the
// contract. These lock the two halves of that split: nothing productfoo needs the agent
// to do may hide in a launcher (a harness that expands a slash command prints it
// straight into the user's chat), and nothing may be silently dropped on the way
// out of one (every step still reaches the agent, and a human, through the CLI).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMAND_HANDOFF_ALWAYS,
  FOO_COMMAND_CONTRACT,
  FOO_COMMAND_MARKER,
  handoffEnabled,
  renderCommandHandoff,
  renderLauncher,
  validateCommandDocs,
  withCommandHandoff,
} from "../src/commandContract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The ceiling that makes this a pointer rather than a prompt. The fat launchers
// this replaced ran 330–810 words; OpenCode renders every one of them as the
// user's own message.
const LAUNCHER_WORD_CEILING = 200;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

test("every launcher stays a pointer: under the word ceiling, and it points at the CLI", () => {
  for (const entry of FOO_COMMAND_CONTRACT) {
    const launcher = renderLauncher(entry);
    assert.ok(
      words(launcher) <= LAUNCHER_WORD_CEILING,
      `${entry.id} launcher is ${words(launcher)} words (ceiling ${LAUNCHER_WORD_CEILING}) — it is turning back into a prompt`,
    );
    assert.match(launcher, new RegExp(`Run \`${entry.invocation}`), `${entry.id} launcher must invoke the CLI`);
    assert.ok(launcher.includes(FOO_COMMAND_MARKER), `${entry.id} launcher must stay productfoo-managed (setup prunes and overwrites on this marker)`);
  }
});

test("the bug launcher is a thin pointer to the canonical per-capsule report flow", () => {
  const bug = FOO_COMMAND_CONTRACT.find((entry) => entry.id === "bug");
  assert.ok(bug, "bug command contract is missing");
  assert.equal(bug.invocation, "foo report add");
  const launcher = renderLauncher(bug);
  assert.match(launcher, /Run `foo report add/);
  assert.match(launcher, /--expected/);
  assert.match(launcher, /--actual/);
  assert.match(launcher, /--reproduction/);
  assert.match(launcher, /exact argument tokens/i);
  assert.doesNotMatch(launcher, /\$ARGUMENTS|single quoted argument|then follow the handoff it prints/i);
  for (const step of bug.agent_steps) {
    assert.ok(launcher.includes(step), "every consent and authority step must reach launcher-only runtime agents");
  }
  assert.doesNotMatch(launcher, /GitHub|redact|fetch|repository/i);
  const withoutBoundary = launcher.replace(bug.agent_steps[2], "");
  assert.doesNotMatch(withoutBoundary, /triage|\bfix\b|Issue URL|repair agent/i);
});

test("the bug skill structurally enforces exact review, local deletion approval, and limited reporting authority", () => {
  const skillPath = path.join(ROOT, "skills/bug/SKILL.md");
  assert.ok(existsSync(skillPath), "skills/bug/SKILL.md is missing");
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\nname: bug\ndescription: Use when /);
  assert.match(skill, /^## Usage$/m);
  assert.match(skill, /foo report add/);
  assert.match(skill, /foo report show <capsule-id> --json/);
  assert.match(skill, /foo report delete <capsule-id> --approve <payload-digest> --json/);
  assert.match(skill, /exact capsule/i);
  assert.match(skill, /fresh|once/i);
  assert.match(skill, /ID\+digest/);
  assert.match(skill, /does not (?:promise|mean).*triage/is);
  assert.match(skill, /Sending is unavailable/);
  assert.match(skill, /^## Error Handling$/m);
  assert.doesNotMatch(skill, /gh issue|GitHub credential|start (?:a |the )?repair agent|dispatch (?:a |the )?repair agent/i);
});

test("ordinary command operating steps stay in their CLI handoff", () => {
  for (const entry of FOO_COMMAND_CONTRACT) {
    if (entry.id === "bug") continue;
    const launcher = renderLauncher(entry);
    for (const step of entry.agent_steps) {
      assert.ok(!launcher.includes(step), `${entry.id}: an operating step is shipping inside the launcher`);
    }
  }
});

test("a command that takes an argument tells the agent what to ask for when it is missing", () => {
  for (const entry of FOO_COMMAND_CONTRACT) {
    if (!entry.argument_hint) continue;
    assert.ok(entry.missing_argument_ask.length > 0, `${entry.id} takes an argument but never says what to ask for`);
    assert.ok(renderLauncher(entry).includes(entry.missing_argument_ask), `${entry.id} launcher must carry the missing-argument ask`);
  }
});

test("every step reaches the agent through the CLI handoff, plus the always-on posture", () => {
  for (const entry of FOO_COMMAND_CONTRACT) {
    const handoff = renderCommandHandoff(entry);
    for (const step of entry.agent_steps) {
      assert.ok(handoff.includes(step), `${entry.id}: step dropped from the handoff`);
    }
    for (const always of COMMAND_HANDOFF_ALWAYS) {
      assert.ok(handoff.includes(always), `${entry.id}: shared posture dropped from the handoff`);
    }
    assert.match(handoff, /do not improvise/i, `${entry.id}: the handoff must claim authority over the agent's default behavior`);
  }
});

test("the spec handoff gates every drafted user message with the local human-surface evaluator", () => {
  const spec = FOO_COMMAND_CONTRACT.find((entry) => entry.id === "spec")!;
  const handoff = renderCommandHandoff(spec);

  assert.match(handoff, /every user-facing message/i);
  assert.match(handoff, /foo detect --human-surface/);
  assert.match(handoff, /exit 0/);
  assert.match(handoff, /exit 2 means rewrite/i);
  assert.match(handoff, /never show the checker or its findings to the user/i);
});

test("a runtime step (init's profile ask) rides along without displacing the contract", () => {
  const init = FOO_COMMAND_CONTRACT.find((c) => c.id === "init")!;
  const handoff = renderCommandHandoff(init, ["Ask the four onboarding questions first."]);
  assert.match(handoff, /1\. Ask the four onboarding questions first\./);
  assert.ok(handoff.includes(init.agent_steps[0]), "contract steps must survive an injected runtime step");
});

test("--json output never carries the handoff — machine output stays contract-pure", () => {
  const json = '{"ok":true}\n';
  const agent = { isTTY: false, env: {} as NodeJS.ProcessEnv };
  assert.equal(withCommandHandoff("spec", json, ["some work", "--json"], [], agent), json);
  assert.notEqual(withCommandHandoff("spec", json, ["some work"], [], agent), json);
});

test("the handoff reaches the agent and stays off the human's screen", () => {
  // A person at a terminal: they typed `foo spec`, so they read productfoo's answer —
  // not productfoo's instructions to their agent.
  assert.equal(handoffEnabled({ isTTY: true, env: {} as NodeJS.ProcessEnv }), false);
  // An agent reading piped output: the contract is the whole point.
  assert.equal(handoffEnabled({ isTTY: false, env: {} as NodeJS.ProcessEnv }), true);
  // A harness that hands its agent a pty still looks like a TTY. Without this,
  // the agent would silently lose the contract and improvise.
  assert.equal(handoffEnabled({ isTTY: true, env: { CLAUDECODE: "1" } as NodeJS.ProcessEnv }), true);
  assert.equal(handoffEnabled({ isTTY: true, env: { OPENCODE: "1" } as NodeJS.ProcessEnv }), true);
  assert.equal(handoffEnabled({ isTTY: true, env: { CODEX_SANDBOX: "seatbelt" } as NodeJS.ProcessEnv }), true);
  // And either way, a human or a script can force it.
  assert.equal(handoffEnabled({ isTTY: true, env: { FOO_HANDOFF: "always" } as NodeJS.ProcessEnv }), true);
  assert.equal(handoffEnabled({ isTTY: false, env: { FOO_HANDOFF: "never" } as NodeJS.ProcessEnv }), false);
});

test("the docs still carry every operating step a human would look for", () => {
  const result = validateCommandDocs(ROOT);
  assert.ok(result.ok, `command docs drifted from the contract: ${JSON.stringify(result.drift, null, 2)}`);
});
