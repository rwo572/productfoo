import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderOrchestrationResult,
  validateOrchestrationResult,
  type OrchestrationResult,
} from "../src/orchestrationResult.js";

const VALID: OrchestrationResult = {
  recommendation: "Keep the work in the current agent and run the repository checks.",
  alternatives: [
    "Use shape-fast if intent remains unresolved.",
    "Choose deep-explicit for an exhaustive review.",
  ],
  falsified: ["A fixed panel is not needed for this reversible change."],
  dissent: "A cross-domain API change could still earn targeted review.",
  what_would_change_our_mind: "A failing safety fixture or meaningful rework in paired evaluation.",
  next_action: "Implement the change and run the focused tests.",
};

test("the compact result accepts exactly the six public decision fields", () => {
  assert.deepEqual(validateOrchestrationResult(VALID), []);

  const unknown = { ...VALID, agent_id: "agent-7" };
  assert.match(validateOrchestrationResult(unknown).join("\n"), /unknown field: agent_id/);

  const missing = { ...VALID, dissent: "" };
  assert.match(validateOrchestrationResult(missing).join("\n"), /dissent must be a non-empty string/);
});

test("the compact result refuses more than two alternatives", () => {
  const result = { ...VALID, alternatives: [...VALID.alternatives, "Run an unbounded panel."] };
  assert.match(validateOrchestrationResult(result).join("\n"), /at most 2 alternatives/);
});

test("rendering leads with the recommendation and carries proof without orchestration plumbing", () => {
  const rendered = renderOrchestrationResult(VALID);
  assert.ok(rendered.indexOf("Recommendation") < rendered.indexOf("Alternatives"));
  assert.match(rendered, /What was falsified/);
  assert.match(rendered, /Strongest dissent/);
  assert.match(rendered, /What would change this/);
  assert.match(rendered, /Next action/);
  assert.doesNotMatch(rendered, /agent tree|lens taxonomy|score matrix|agent_id|phase_id/i);
  assert.equal(rendered.endsWith("\n"), true);
});

test("rendering refuses an invalid result instead of producing a partial page", () => {
  assert.throws(
    () => renderOrchestrationResult({ ...VALID, alternatives: ["one", "two", "three"] }),
    /at most 2 alternatives/,
  );
});
