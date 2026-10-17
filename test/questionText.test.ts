import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { defineQuestion } from "../src/questionModel.js";
import type { QuestionInput } from "../src/questionModel.js";
import { renderQuestion, renderQuestionText } from "../src/questionText.js";

const FOO_BIN = path.resolve("bin/foo");

function sampleInput(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    header: "Surface",
    prompt: "Which render surface should the branded question use?",
    options: [
      { id: "widget", label: "Inline widget MCP", description: "sendPrompt round-trip" },
      { id: "native", label: "Native AskUserQuestion", description: "chrome unbrandable" },
      { id: "plain", label: "Plain MCP tool", description: "no UI" },
    ],
    recommendedOptionId: "native",
    judgment: {
      belief: "Native is unbrandable; the widget is the only branded path",
      evidence: "verified against Claude Code docs",
      confidence: "high",
    },
    ...overrides,
  };
}

// C-005: numbered text, recommendation first and marked, judgment visible.
test("renderQuestionText puts the recommendation first and marks it, numbered (C-005)", () => {
  const text = renderQuestionText(defineQuestion(sampleInput()));
  const lines = text.split("\n");
  // recommended option (native) is first and marked
  assert.match(lines.find((line) => line.startsWith("  1."))!, /1\. Native AskUserQuestion {2}\(recommended\)/);
  assert.ok(lines.some((line) => line.startsWith("  2. Inline widget MCP")));
  assert.ok(lines.some((line) => line.startsWith("  3. Plain MCP tool")));
});

test("renderQuestionText shows the legible judgment and a reply prompt (C-005)", () => {
  const text = renderQuestionText(defineQuestion(sampleInput()));
  assert.match(text, /Why this pick: Native is unbrandable/);
  assert.match(text, /Evidence: {6}verified against Claude Code docs/);
  assert.match(text, /Confidence: {4}high/);
  assert.match(text, /Reply with a number \(1-3\)\./);
});

test("renderQuestionText shows dissent only when present", () => {
  assert.doesNotMatch(renderQuestionText(defineQuestion(sampleInput())), /Dissent:/);
  const withDissent = renderQuestionText(
    defineQuestion(
      sampleInput({
        judgment: {
          belief: "b",
          evidence: "e",
          confidence: "medium",
          dissent: "a widget could win on a capable TTY",
        },
      }),
    ),
  );
  assert.match(withDissent, /Dissent: {7}a widget could win/);
});

// C-006: the text path renders identical content even when the widget surface resolves.
test("renderQuestion falls back to text even when the surface resolves to widget (C-006)", () => {
  const model = defineQuestion(sampleInput());
  const result = renderQuestion(model, { env: { CLAUDECODE: "1" }, isTTY: true });
  assert.equal(result.surface, "widget"); // surface detected as widget...
  assert.equal(result.text, renderQuestionText(model)); // ...but the text path renders (widget unavailable)
});

test("the text path loses no option content (C-006)", () => {
  const model = defineQuestion(sampleInput());
  const text = renderQuestionText(model);
  for (const option of model.options) {
    assert.ok(text.includes(option.label), `missing option label: ${option.label}`);
    if (option.description) assert.ok(text.includes(option.description), `missing description: ${option.description}`);
  }
});

// C-005 via the real CLI (non-TTY -> text path renders the canonical format).
test("`foo elicitation render` prints the canonical numbered text (C-005)", () => {
  const result = spawnSync("node", [FOO_BIN, "elicitation", "render"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(recommended\)/);
  assert.match(result.stdout, /^ {2}1\. /m);
  assert.match(result.stdout, /Reply with a number/);
});
