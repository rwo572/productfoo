import assert from "node:assert/strict";
import { test } from "node:test";
import { defineQuestion, projectQuestion } from "../src/questionModel.js";
import type { Confidence, QuestionInput } from "../src/questionModel.js";

function sampleInput(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    header: "Surface",
    prompt: "Which render surface should the branded question use?",
    options: [
      { label: "Inline widget MCP", description: "sendPrompt round-trip" },
      { label: "Native AskUserQuestion", description: "chrome unbrandable" },
    ],
    judgment: {
      belief: "The widget MCP is the only brandable path",
      evidence: "verified against Claude Code docs",
      confidence: "high",
    },
    ...overrides,
  };
}

// C-003: the model carries options with stable ids, a recommendation pointer, judgment.
test("defineQuestion builds a model with stable ids, a recommendation, and judgment (C-003)", () => {
  const model = defineQuestion(sampleInput());
  assert.deepEqual(model.options.map((option) => option.id), ["opt-1", "opt-2"]);
  assert.equal(model.recommendedOptionId, "opt-1"); // defaults to the first option
  assert.equal(model.judgment.confidence, "high");
  assert.equal(model.multiSelect, false);
});

test("defineQuestion preserves caller-provided stable ids", () => {
  const model = defineQuestion(
    sampleInput({
      options: [
        { id: "widget", label: "Inline widget MCP" },
        { id: "native", label: "Native AskUserQuestion" },
      ],
      recommendedOptionId: "widget",
    }),
  );
  assert.deepEqual(model.options.map((option) => option.id), ["widget", "native"]);
  assert.equal(model.recommendedOptionId, "widget");
});

test("defineQuestion rejects malformed questions", () => {
  assert.throws(() => defineQuestion(sampleInput({ options: [{ label: "only one" }] })), /at least two/);
  assert.throws(() => defineQuestion(sampleInput({ header: "  " })), /header/);
  assert.throws(() => defineQuestion(sampleInput({ prompt: "" })), /prompt/);
  assert.throws(() => defineQuestion(sampleInput({ recommendedOptionId: "nope" })), /does not match/);
  assert.throws(
    () => defineQuestion(sampleInput({ options: [{ id: "x", label: "a" }, { id: "x", label: "b" }] })),
    /unique/,
  );
  assert.throws(
    () => defineQuestion(sampleInput({ judgment: { belief: "", evidence: "e", confidence: "high" } })),
    /belief/,
  );
  assert.throws(
    () =>
      defineQuestion(
        sampleInput({ judgment: { belief: "b", evidence: "e", confidence: "certain" as Confidence } }),
      ),
    /confidence/,
  );
});

// recommend-one-then-number: projection puts the recommended option first and numbers 1..n.
test("projectQuestion puts the recommended option first and numbers options (R-005)", () => {
  const model = defineQuestion(
    sampleInput({
      options: [
        { id: "widget", label: "Inline widget MCP" },
        { id: "native", label: "Native AskUserQuestion" },
        { id: "plain", label: "Plain MCP tool" },
      ],
      recommendedOptionId: "native",
    }),
  );
  const projected = projectQuestion(model);
  assert.deepEqual(
    projected.options.map((option) => [option.number, option.id, option.recommended]),
    [
      [1, "native", true],
      [2, "widget", false],
      [3, "plain", false],
    ],
  );
});

// C-004: the projection is the single render source — a renderer reading only it has
// every option, all wording, the recommendation, and the judgment, so neither the text
// renderer nor the widget renderer needs to hold its own copy.
test("projectQuestion is the single, faithful render source (C-004)", () => {
  const model = defineQuestion(sampleInput());
  const projected = projectQuestion(model);

  assert.equal(projected.options.length, model.options.length);
  for (const option of model.options) {
    const rendered = projected.options.find((candidate) => candidate.id === option.id);
    assert.equal(rendered?.label, option.label);
    assert.equal(rendered?.description, option.description);
  }
  assert.equal(projected.options.filter((option) => option.recommended).length, 1);
  assert.equal(projected.recommendedOptionId, model.recommendedOptionId);
  assert.equal(projected.judgment.belief, model.judgment.belief);
  assert.equal(projected.judgment.confidence, model.judgment.confidence);
});
