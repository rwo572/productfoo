import assert from "node:assert/strict";
import test from "node:test";
import { findProbableDiscoveryDuplicates, matchDiscoverySessions, sourceFingerprint, type DiscoveryMatchTarget } from "../src/discoveryMatching.js";
import type { DiscoverySession } from "../src/discoverySources.js";

const TARGET: DiscoveryMatchTarget = {
  provider: "granola",
  expected_local_date: "2026-07-20",
  timezone: "America/Los_Angeles",
  required_participants: [" Casey   Sample "],
  required_title_tokens: ["shape up"],
};

function session(overrides: Partial<DiscoverySession> = {}): DiscoverySession {
  return {
    schema_version: "0.1",
    provider: "granola",
    connection_alias: "primary",
    runtime_handle: "private-1",
    completed_at: "2026-07-20T16:00:00.000Z",
    completion_state: "completed",
    title: "Granola — SHAPE   UP workflow",
    participants: ["casey sample", "Product partner"],
    stable_url: "https://app.granola.ai/meeting/abc",
    capabilities: { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true },
    access: "available",
    ...overrides,
  };
}

test("strict matching normalizes case and whitespace but requires every configured field", () => {
  const one = matchDiscoverySessions(TARGET, [session()]);
  assert.equal(one.status, "unique");
  assert.equal(one.matches.length, 1);

  assert.equal(matchDiscoverySessions(TARGET, [session({ title: "Another workflow" })]).status, "none");
  assert.equal(matchDiscoverySessions(TARGET, [session({ participants: ["Someone else"] })]).status, "none");
  assert.equal(matchDiscoverySessions(TARGET, [session({ completed_at: "2026-07-21T16:00:00.000Z" })]).status, "none");
  assert.equal(matchDiscoverySessions(TARGET, [session({ completion_state: "in_progress" })]).status, "none");
});

test("matching returns deterministic zero, one, and many outcomes without transcript fields", () => {
  assert.equal(matchDiscoverySessions(TARGET, []).status, "none");
  const unique = matchDiscoverySessions(TARGET, [session()]);
  assert.deepEqual(unique.candidates, [{ candidate_index: 1, source_fingerprint: sourceFingerprint(session()) }]);
  assert.equal(matchDiscoverySessions(TARGET, [session(), session({ runtime_handle: "private-2", stable_url: "https://app.granola.ai/meeting/def" })]).status, "ambiguous");
  assert.doesNotMatch(JSON.stringify(unique.candidates), /private-1|Casey|Shape Up/i);
});

test("source fingerprints are stable and change with source identity", () => {
  assert.equal(sourceFingerprint(session()), sourceFingerprint(session({ title: "  granola — shape up WORKFLOW " })));
  assert.notEqual(sourceFingerprint(session()), sourceFingerprint(session({ runtime_handle: "private-2" })));
  assert.match(sourceFingerprint(session()), /^sha256:[a-f0-9]{64}$/);
});

test("probable cross-provider duplicates are proposals, never silent merges", () => {
  const duplicates = findProbableDiscoveryDuplicates([
    session(),
    session({ provider: "fakecalls", connection_alias: "work", runtime_handle: "other-1", stable_url: "https://review.fakecalls.test/c/9", completed_at: "2026-07-20T16:03:00.000Z" }),
  ]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].action, "review-canonical-source");
  assert.equal(duplicates[0].confidence, "high");
  assert.notEqual(duplicates[0].left_fingerprint, duplicates[0].right_fingerprint);
});
