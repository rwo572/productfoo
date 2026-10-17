import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  asksLookLikeInterview,
  clearInterviewAsks,
  evaluateInterviewGate,
  questionCount,
  recordInterviewAsk,
} from "../src/interviewGate.js";

const tmpRoot = (): string => mkdtempSync(path.join(tmpdir(), "foo-interview-gate-"));

// The call that was actually denied. An agent had found the three lines it was asked to
// edit and wanted to settle ONE thing before editing them. The old gate refused it as a
// "vanilla AskUserQuestion interview". If this ever denies again, the gate is back to
// matching the tool instead of the behaviour.
const REAL_MISS = {
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Should the answer lines keep the 'productfoo —' prefix?",
        header: "Prefix",
        options: [{ label: "Keep it" }, { label: "Drop it" }],
        multiSelect: false,
      },
    ],
  },
};

const batch = (n: number) => ({
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: Array.from({ length: n }, (_, i) => ({
      question: `Question ${i + 1}?`,
      header: "H",
      options: [{ label: "a" }, { label: "b" }],
    })),
  },
});

test("one clarifying question is allowed — the regression the gate exists for", () => {
  const root = tmpRoot();
  try {
    const decision = evaluateInterviewGate(REAL_MISS, root, {});
    assert.equal(decision.allow, true, decision.reason?.agent ?? "should allow a single question");
    assert.equal(decision.note, "clarification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch of questions is a questionnaire and is denied", () => {
  const root = tmpRoot();
  try {
    const decision = evaluateInterviewGate(batch(3), root, {});
    assert.equal(decision.allow, false);
    assert.equal(decision.note, "batch");
    assert.match(String(decision.reason?.agent), /bin\/foo spec start/);
    assert.match(String(decision.reason?.agent), /interview-me/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Nth question in the window is an interview by accretion, whatever it was called", () => {
  const root = tmpRoot();
  try {
    const now = 1_000_000;
    // Two single questions stay free — a clarification, and a follow-up.
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}, now).allow, true);
    recordInterviewAsk(root, now);
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}, now + 1_000).allow, true);
    recordInterviewAsk(root, now + 1_000);

    // The third is a run.
    const denied = evaluateInterviewGate(REAL_MISS, root, {}, now + 2_000);
    assert.equal(denied.allow, false);
    assert.equal(denied.note, "accretion");
    assert.match(String(denied.reason?.agent), /BEHAVIOUR, not on wording/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("asks age out of the window — this morning's question is not this conversation", () => {
  const root = tmpRoot();
  try {
    const now = 1_000_000;
    recordInterviewAsk(root, now);
    recordInterviewAsk(root, now + 1_000);
    assert.equal(asksLookLikeInterview(root, now + 2_000), true);

    // 10 minutes later the counter is empty again.
    const later = now + 601_000;
    assert.equal(asksLookLikeInterview(root, later), false);
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}, later).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a governed interview does not trip its own gate — foo spec clears the counter", () => {
  const root = tmpRoot();
  try {
    const now = 1_000_000;
    recordInterviewAsk(root, now);
    recordInterviewAsk(root, now + 1_000);
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}, now + 2_000).allow, false);

    clearInterviewAsks(root); // what `foo spec` / `foo spec start` does
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}, now + 3_000).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the override is honoured, and non-ask tools are never touched", () => {
  const root = tmpRoot();
  try {
    const override = evaluateInterviewGate(batch(4), root, { FOO_ALLOW_VANILLA_INTERVIEW: "1" });
    assert.equal(override.allow, true);
    assert.equal(override.note, "override");

    const unrelated = evaluateInterviewGate({ tool_name: "Edit", tool_input: {} }, root, {});
    assert.equal(unrelated.allow, true);
    assert.equal(unrelated.note, "not-an-ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload with no questions array counts as one question, not zero", () => {
  // Fail open on shape: an unfamiliar payload must not be read as a batch and denied.
  assert.equal(questionCount({ tool_name: "AskUserQuestion", tool_input: {} }), 1);
  const root = tmpRoot();
  try {
    assert.equal(evaluateInterviewGate({ tool_name: "AskUserQuestion", tool_input: {} }, root, {}).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt counter never denies a question", () => {
  const root = tmpRoot();
  try {
    mkdirSync(path.join(root, ".foo"), { recursive: true });
    writeFileSync(path.join(root, ".foo", "interview-asks.json"), "{not json");
    assert.equal(evaluateInterviewGate(REAL_MISS, root, {}).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
