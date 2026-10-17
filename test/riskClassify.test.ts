import assert from "node:assert/strict";
import test from "node:test";

import { classifyWork, isGovernedFrame } from "../src/riskClassify.js";

// The misfire. `foo classify` called this risky with the rationale "Matched agentic
// (agent)" — it matched the WORD "agent". The work is one script and one JSON entry,
// fully reversible, nothing outbound. It is the thing that STOPS agents.
const THE_MISFIRE =
  "add a PreToolUse hook that denies open-ended research via raw Agent/WebSearch subagents " +
  "and routes it to bin/foo research";

test("work that governs agents is not agentic work", () => {
  const c = classifyWork(THE_MISFIRE);
  assert.equal(c.risky, false, "a hook that blocks agents does not act agentically");
  assert.equal(c.confidence, "low");
  assert.equal(c.governed_frame, true);
  // The downgrade is never silent: the evidence and the reasoning both survive.
  assert.match(c.rationale, /agent/);
  assert.match(c.rationale, /governing or testing/);
});

test("a governed frame does not hide a real behaviour", () => {
  // The hole the dampener could have opened. This work CREATES an autonomous actor;
  // "monitors" reads like governance but a loop is still a loop.
  const c = classifyWork("add a background loop that monitors deploys and automatically rolls back");
  assert.equal(c.risky, true);
  assert.equal(c.confidence, "high");
  assert.equal(c.governed_frame, false);
  assert.match(c.rationale, /acts on its own/);
});

test("genuinely risky work still blocks", () => {
  for (const work of [
    "delete the production users table",
    "deploy the new schema to prod",
    "send the launch email to every customer",
    "build an autonomous agent that posts to slack unattended",
    "add a cron job that charges customers nightly",
  ]) {
    assert.equal(classifyWork(work).risky, true, `should be risky: ${work}`);
  }
});

test("testing and documenting a risky path is not doing it", () => {
  for (const work of [
    "add a test for the delete path",
    "document the refund flow",
    "add a lint check that blocks deploys on a Friday",
  ]) {
    const c = classifyWork(work);
    assert.equal(c.risky, false, `should be routine: ${work}`);
    assert.equal(c.confidence, "low");
  }
});

test("--strict restores the blunt instrument", () => {
  const c = classifyWork(THE_MISFIRE, undefined, { strict: true });
  assert.equal(c.risky, true, "strict blocks on any keyword hit");
  assert.equal(c.governed_frame, true, "and still says the frame looked governed");
});

test("an override is still a recorded waiver, not a silent skip", () => {
  const c = classifyWork("delete the production users table", "owner approved in #ops");
  assert.equal(c.risky, true, "the work is still risky — the override waives the gate, not the fact");
  assert.equal(c.spec_first_required, false);
  assert.equal(c.override, "owner approved in #ops");
});

test("clean work matches nothing", () => {
  const c = classifyWork("rename the parseSpec helper to parsePacket");
  assert.equal(c.risky, false);
  assert.equal(c.dimensions.agentic.length, 0);
});

test("the governed frame needs a build verb AND a governing construct", () => {
  // "delete the production table" names no guard and opens with no build verb.
  assert.equal(isGovernedFrame("delete the production table"), false);
  // A build verb alone is not enough — this one really does deploy.
  assert.equal(isGovernedFrame("add a script that deploys to production"), false);
  assert.equal(isGovernedFrame("add a hook that blocks deploys to production"), true);
});
