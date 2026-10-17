import { test } from "node:test";
import assert from "node:assert/strict";

import { InterviewAgent } from "../src/interviewAgent.js";
import { CUT_CRITICAL_FIELDS, QUESTIONS, parseColors, parseSizeRun } from "../src/questions.js";
import { judgeDesignAnswer } from "../src/vagueness.js";
import { buildDesignBrief, openFields } from "../src/designBrief.js";

// T-001 / C-001
test("the five cut-critical questions are declared in ask order, each with a parser", () => {
  assert.deepEqual([...CUT_CRITICAL_FIELDS], ["garment", "sizeRun", "placement", "colors", "quantity"]);
  for (const field of CUT_CRITICAL_FIELDS) {
    const question = QUESTIONS.find((entry) => entry.field === field);
    assert.ok(question, `no question for ${field}`);
    assert.equal(typeof question!.parse, "function");
  }
  // A usable answer parses; an unusable one fails on that question alone.
  assert.equal(parseColors("three colors").ok, false);
  assert.equal(parseColors("red, black, cream").ok, true);
  assert.equal(parseSizeRun("no idea").ok, false);
  const run = parseSizeRun("12 medium, 6 large");
  assert.equal(run.ok, true);
  assert.deepEqual(run.ok ? run.value : null, [
    { size: "M", quantity: 12 },
    { size: "L", quantity: 6 },
  ]);
});

// T-002 / C-002
test("\"something cool\" is rejected and re-asked; a specific answer advances", () => {
  const agent = new InterviewAgent();
  const opening = agent.start();
  assert.match(opening, /What would you like us to print/);

  const vague = agent.answer("something cool");
  assert.equal(vague.reAsking, true, "a non-answer must not advance the interview");
  assert.match(vague.say ?? "", /what's actually in the picture/i);
  assert.equal(vague.finished, false);

  // Still on the same question — the interview loops, it does not move on.
  const stillVague = agent.answer("you decide");
  assert.equal(stillVague.reAsking, true);

  const concrete = agent.answer("A coiled red dragon, side view, mouth open, breathing a thin line of fire");
  assert.equal(concrete.reAsking, false, "a usable design answer must advance");
  assert.match(concrete.say ?? "", /What are we printing on/);

  assert.equal(judgeDesignAnswer("surprise me", "follow up").vague, true);
  assert.equal(judgeDesignAnswer("a coiled red dragon breathing fire", "follow up").vague, false);
});

// T-004 / C-004
test("the interview cannot finish while a cut-critical field is open, and names it", () => {
  const agent = new InterviewAgent();
  agent.start();
  agent.answer("A coiled red dragon, side view, mouth open");
  assert.deepEqual(agent.stillOpen(), ["garment", "sizeRun", "placement", "colors", "quantity"]);
  assert.equal(agent.isFinished(), false);

  agent.answer("hoodie");
  assert.deepEqual(agent.stillOpen(), ["sizeRun", "placement", "colors", "quantity"]);

  agent.answer("12 medium, 6 large, 2 XL");
  assert.deepEqual(agent.stillOpen(), ["placement", "colors", "quantity"]);
  assert.equal(agent.isFinished(), false, "an interview with placement open is not finished");

  agent.answer("back");
  agent.answer("red, black, cream");
  assert.deepEqual(agent.stillOpen(), ["quantity"]);
  assert.equal(agent.isFinished(), false);

  const last = agent.answer("20");
  assert.deepEqual(last.stillOpen, []);
  assert.equal(last.finished, true);
  assert.equal(last.say, null);
});

// T-005 / C-005
test("a finished interview emits a brief; an unfinished one emits none and lists what is open", () => {
  const partial = buildDesignBrief({ garment: "tee", artwork: "a red dragon" }, []);
  assert.equal(partial.complete, false);
  assert.equal(partial.brief, null);
  assert.deepEqual(partial.complete === false && partial.stillOpen, ["sizeRun", "placement", "colors", "quantity"]);
  assert.deepEqual(openFields({}), ["garment", "sizeRun", "placement", "colors", "quantity"]);

  const agent = new InterviewAgent();
  agent.start();
  agent.answer("A coiled red dragon, side view, mouth open, breathing a thin line of fire");
  agent.answer("hoodie");
  agent.answer("12 medium, 6 large, 2 XL");
  agent.answer("back");
  agent.answer("red, black, cream");
  agent.answer("20");

  const result = agent.brief();
  assert.equal(result.complete, true);
  const brief = result.complete ? result.brief : null;
  assert.ok(brief);
  assert.equal(brief!.garment, "hoodie");
  assert.deepEqual(brief!.sizeRun, [
    { size: "M", quantity: 12 },
    { size: "L", quantity: 6 },
    { size: "XL", quantity: 2 },
  ]);
  assert.equal(brief!.placement, "back-full");
  assert.deepEqual(brief!.colors, ["red", "black", "cream"]);
  assert.equal(brief!.quantity, 20);
  // The customer's own words, not our paraphrase.
  assert.equal(
    brief!.artworkInCustomerWords,
    "A coiled red dragon, side view, mouth open, breathing a thin line of fire",
  );
});
