import assert from "node:assert/strict";
import test from "node:test";

import { buildArxivQuery } from "../src/social/arxiv.js";
import { settleStatus } from "../src/social/types.js";

// productfoo fabricated evidence. `foo research gather "zxqvwj nonexistent flarbnorg
// protocol"` — pure gibberish — reported `arxiv available — returned 25 paper(s)`
// and offered "Lean-QIT: Towards a Formal Infrastructure for Quantum Information
// Theory" as a finding. Twenty-five sources, for a topic that does not exist, all
// eligible to be typed as evidence in a research paper.
//
// Cause: arXiv SILENTLY REWRITES BARE SPACES INTO `OR`. productfoo sent
// `all:kubernetes operator patterns`; arXiv echoed back, in its own response,
// `all:kubernetes OR all:operator OR all:patterns`. "Operator" is one of the most
// common words in mathematics, so a Kubernetes question returned quantum physics.
//
// For a tool whose entire claim is that it types its evidence honestly, inventing
// sources is the worst failure available. Worse than returning nothing — nothing is
// at least true.

test("the arXiv query ANDs its terms — bare spaces are how arXiv was reading OR", () => {
  const q = buildArxivQuery("kubernetes operator patterns");
  assert.equal(q, "all:kubernetes AND all:operator AND all:patterns");
  // The regression, stated as the thing that must never come back.
  assert.ok(!q.includes(" OR "), "an OR-joined query is what returned quantum physics for a Kubernetes question");
});

test("stopwords are dropped rather than ANDed into irrelevance", () => {
  assert.equal(buildArxivQuery("what is the state of the art in RAG"), "all:state AND all:art AND all:rag");
});

test("a query with nothing usable falls back to a QUOTED phrase, never a bare one", () => {
  // Bare is the bug. Quoting is what stops arXiv reading the spaces as OR.
  const q = buildArxivQuery("!!! ???");
  assert.match(q, /^all:"/);
});

// --- the second defect: "available" meant "the adapter ran", not "it found anything"

test("the pure status normalizer still calls zero findings `empty`, never `available`", () => {
  // What foo used to print, verbatim:
  //   hackernews  available — HN Algolia returned 0 story(ies) within 30d.
  // A reader scanning that column sees a source that contributed. It contributed
  // nothing. "It ran" and "it found something" are the two facts a research tool
  // exists to keep apart, and this collapsed them into one word.
  assert.equal(settleStatus("available", 0), "empty");
  assert.notEqual(settleStatus("available", 0), "available", "zero items is not a contribution");
});

test("the pure status normalizer preserves an actual contribution", () => {
  assert.equal(settleStatus("available", 3), "available");
});
