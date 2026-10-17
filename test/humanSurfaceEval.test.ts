import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HumanSurfaceLeakError,
  evaluateHumanSurface,
  guardHumanSurface,
  renderHumanSurfaceEval,
} from "../src/humanSurfaceEval.js";

const REPORTED_LEAK = [
  "THE NEXT STEP",
  "Decide: **OQ1**: How is the drift queue triaged when a real codebase yields hundreds of `DRIFT`?",
  "An open question is the main thing blocking a clean next step.",
  "",
  "WHAT THE ASSISTANT SEES",
  "THINKS",
  "Open questions need your call",
  "BASED ON",
  "0 of 5 tasks done, 4 open question(s)",
  "WOULD DO",
  "NEEDS YOU",
  "you decide",
  "A read-only view of the agent's judgment ledger — the human is the decider.",
].join("\n");

test("the reported decision surfaces fail for the internal id, process chrome, and judgment-ledger narration", () => {
  const result = evaluateHumanSurface(REPORTED_LEAK);

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === "HS-001" && finding.phrase === "OQ1"));
  assert.ok(result.findings.some((finding) => finding.rule === "HS-003" && /assistant sees/i.test(finding.phrase)));
  assert.ok(result.findings.some((finding) => finding.rule === "HS-004" && /judgment ledger/i.test(finding.phrase)));
  assert.ok(result.findings.every((finding) => finding.line > 0));
  assert.ok(result.findings.every((finding) => finding.rewrite.length > 0));
});

test("productfoo filing labels and packet schema fields fail even without an internal id", () => {
  const result = evaluateHumanSurface([
    "The Shape Brief must return:",
    "- The product bet",
    "- Source and approval boundaries",
    "- MVP scope and the validation bar",
    "Packet handoff: copy next_action from tasks.yaml and its done_when field.",
    "State: needs-decision",
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === "HS-002" && finding.phrase === "next_action"));
  assert.ok(result.findings.some((finding) => finding.rule === "HS-002" && finding.phrase === "State: needs-decision"));
  assert.ok(result.findings.some((finding) => finding.rule === "HS-004" && finding.phrase === "Shape Brief"));
  assert.ok(result.findings.some((finding) => finding.rule === "HS-004" && finding.phrase === "validation bar"));
});

test("ordinary decision copy passes, including drift language that belongs to the user's problem", () => {
  const text = [
    "The drift queue can grow to hundreds of items.",
    "Which three signals should determine what gets reviewed first?",
    "I recommend starting with customer impact, frequency, and ease of reversal.",
    "You can also pause this work.",
  ].join("\n");

  assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] });
  assert.equal(guardHumanSurface(text), text);
});

test("commands and examples in Markdown code are outside the human-prose scan", () => {
  const text = [
    "Run `foo asp validate specs/example` after the edit.",
    "",
    "```yaml",
    "spec_id: example_v0",
    "done_when:",
    "  - OQ-001",
    "```",
    "A grasp of the decision is enough to continue.",
  ].join("\n");

  assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] });
});

test("multi-backtick code spans keep user-supplied productfoo terms outside the scan", () => {
  const text = "Ready to plan: ``replace the `done_when` field without OQ1``";
  assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] });
});

test("rules use token boundaries instead of matching nearby substrings", () => {
  const text = "The asp-scoped adapter can grasp an opaque next_actionable value without showing it.";
  assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] });
});

test("common letter-number terms are not mistaken for productfoo identifiers", () => {
  const text = "Use an AWS T3 instance, report the R2 score, retain vitamin D3, and group C4 photosynthesis.";
  assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] });
});

test("canonical productfoo identifiers are caught independently", () => {
  for (const identifier of ["OQ1", "OQ-001", "T-001", "R-007", "C-004", "D-003"]) {
    const result = evaluateHumanSurface(identifier);
    assert.equal(result.ok, false, identifier);
    assert.ok(
      result.findings.some((finding) => finding.rule === "HS-001" && finding.phrase === identifier),
      identifier,
    );
  }
});

test("decorated process headings and the DRIFT state label are caught independently", () => {
  for (const label of [
    "**WHAT THE ASSISTANT SEES**",
    "## WHAT THE ASSISTANT SEES",
    "What the assistant sees:",
    "__THINKS__",
    "DRIFT",
    "**DRIFT**",
  ]) {
    const result = evaluateHumanSurface(label);
    assert.equal(result.ok, false, label);
    assert.ok(result.findings.some((finding) => finding.rule === "HS-003"), label);
  }
});

test("ordinary lowercase or title-case drift labels remain valid user language", () => {
  for (const text of ["drift", "Drift:", "## Drift"]) {
    assert.deepEqual(evaluateHumanSurface(text), { ok: true, findings: [] }, text);
  }
});

test("a different fence marker cannot close a fenced code block", () => {
  const text = [
    "```yaml",
    "~~~",
    "spec_id: safe_inside_the_example",
    "```",
    "**WHAT THE ASSISTANT SEES**",
  ].join("\n");
  const result = evaluateHumanSurface(text);

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === "HS-003"));
  assert.ok(!result.findings.some((finding) => finding.rule === "HS-002"));
});

test("a shorter fence cannot close a longer fenced code block", () => {
  const text = [
    "````markdown",
    "```",
    "done_when: safe inside the example",
    "```",
    "````",
    "What the agent sees:",
  ].join("\n");
  const result = evaluateHumanSurface(text);

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === "HS-003"));
  assert.ok(!result.findings.some((finding) => finding.rule === "HS-002"));
});

test("findings render as line-specific rewrite instructions without echoing the full candidate", () => {
  const unrelatedTail = "private-customer-detail-that-must-not-be-echoed";
  const result = evaluateHumanSurface(`Capability: foo spec ${unrelatedTail}\nSkill adapter: interview-me`);
  const rendered = renderHumanSurfaceEval(result);

  assert.match(rendered, /User-facing copy needs a rewrite/);
  assert.match(rendered, /Line 1/);
  assert.match(rendered, /Capability:/);
  assert.match(rendered, /Line 2/);
  assert.doesNotMatch(rendered, new RegExp(unrelatedTail));
});

test("an empty candidate is an input error, not a clean pass", () => {
  const result = evaluateHumanSurface("  \n");
  assert.equal(result.ok, false);
  assert.equal(result.error, "empty-input");
  assert.deepEqual(result.findings, []);
  assert.match(renderHumanSurfaceEval(result), /No user-facing copy was provided/);
});

test("the runtime guard refuses leaking copy", () => {
  assert.throws(
    () => guardHumanSurface("A read-only view of the agent's judgment ledger."),
    (error: unknown) =>
      error instanceof HumanSurfaceLeakError &&
      error.result.findings[0]?.rule === "HS-004" &&
      /could not prepare clear user-facing copy/i.test(error.message) &&
      !/judgment ledger/i.test(error.message),
  );
});
