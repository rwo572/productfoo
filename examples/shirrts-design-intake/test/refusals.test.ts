import { test } from "node:test";
import assert from "node:assert/strict";

import { checkRights } from "../src/refusals.js";
import { InterviewAgent } from "../src/interviewAgent.js";

// T-003 / C-003
test("a copyrighted character refuses, names the rule, and escalates to the owner", () => {
  const refusals = checkRights("Pikachu riding a skateboard through a city street");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].rule, "copyrighted-character");
  assert.equal(refusals[0].term, "pikachu");
  assert.equal(refusals[0].escalateTo, "shop-owner");
  assert.match(refusals[0].message, /copyrighted character/);
  assert.ok(refusals[0].alternative.length > 0, "a refusal must say what the customer CAN do");
});

test("a trademarked logo refuses, names the rule, and escalates to the owner", () => {
  const refusals = checkRights("just the Nike swoosh, big, on the back");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].rule, "trademarked-logo");
  assert.equal(refusals[0].escalateTo, "shop-owner");
  assert.match(refusals[0].message, /trademarked logo/);
});

test("an ordinary design produces no refusal", () => {
  assert.deepEqual(checkRights("A coiled red dragon, side view, breathing fire"), []);
  assert.deepEqual(checkRights("my dog Ripley, sitting, cartoon style"), []);
});

test("the interview stops on a rights problem instead of taking the order", () => {
  const agent = new InterviewAgent();
  agent.start();
  const turn = agent.answer("Spider-Man swinging between two buildings");
  assert.equal(turn.reAsking, true, "a rights problem must not advance the interview");
  assert.equal(turn.finished, false);
  assert.equal(turn.refusals.length, 1);
  assert.equal(turn.refusals[0].escalateTo, "shop-owner");
  assert.equal(agent.escalations().length, 1, "the owner sees it");
  assert.match(turn.say ?? "", /not licensed/);
});
