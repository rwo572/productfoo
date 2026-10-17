import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePacket } from "../src/packetValidation.js";

// discovery-review-verbs-v0 R-004/V-004: `evidence.yaml` is the packet home for
// inbox evidence attached by `foo discovery review <F-id> attach --packet` and
// `asp validate` must know it — absent stays valid, present is checked, and a
// malformed file fails with a teaching message.

function packetFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-packet-evidence-"));
  writeFileSync(path.join(dir, "spec.md"), "---\nspec_id: evidence_home_v0\n---\n\n# Evidence Home V0\n");
  writeFileSync(path.join(dir, "tasks.yaml"), [
    'schema_version: "0.1"',
    "spec_id: evidence_home_v0",
    "spec_ref: specs/evidence-home-v0/spec.md",
    'updated: "2026-07-22T00:00:00.000Z"',
    "defaults: {}",
    "tasks:",
    "  - id: T-001",
    "    title: One task",
    "    status: todo",
    "    agreement: agreed",
    "    stage: build",
    "    refs: []",
    "    depends_on: []",
    "    owner: agent:any",
    "    autonomy: human-in-loop",
    "    do: []",
    "    done_when: []",
    "    completed: null",
    "    blocked: null",
    "    review: null",
    "    extensions: {}",
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({
    specversion: "1.0",
    id: "evt_test_1",
    source: "test",
    type: "com.adaptivespec.packet.created",
    subject: "packet:evidence_home_v0",
    time: "2026-07-22T00:00:00.000Z",
    actor: { type: "human", id: "test" },
    data: {},
  })}\n`);
  return dir;
}

function validEvidence(): string {
  return [
    'schema_version: "0.1"',
    "findings:",
    "  - finding_id: F-001",
    "    original_finding_id: F-INBOX-901",
    "    original_lane: unassigned_call_evidence",
    "    review_state: needs_review",
    "    paraphrase: A customer wants attach to be reversible.",
    "",
  ].join("\n");
}

test("a packet without evidence.yaml still validates", () => {
  const dir = packetFixture();
  assert.equal(validatePacket({ packetDir: dir, label: "evidence-home-v0" }), "evidence-home-v0 ok");
});

test("a packet carrying well-formed attached evidence validates", () => {
  const dir = packetFixture();
  writeFileSync(path.join(dir, "evidence.yaml"), validEvidence());
  assert.equal(validatePacket({ packetDir: dir, label: "evidence-home-v0" }), "evidence-home-v0 ok");
});

test("malformed evidence.yaml fails validation with a teaching message", () => {
  const dir = packetFixture();
  writeFileSync(path.join(dir, "evidence.yaml"), 'schema_version: "0.1"\nfindings: not-a-list\n');
  assert.throws(
    () => validatePacket({ packetDir: dir, label: "evidence-home-v0" }),
    (error: Error) => /evidence\.yaml\.findings must be an array/.test(error.message) && /Fix:/.test(error.message),
  );
});

test("attached evidence missing provenance fields fails validation", () => {
  const dir = packetFixture();
  writeFileSync(path.join(dir, "evidence.yaml"), [
    'schema_version: "0.1"',
    "findings:",
    "  - finding_id: F-001",
    "    review_state: needs_review",
    "",
  ].join("\n"));
  assert.throws(
    () => validatePacket({ packetDir: dir, label: "evidence-home-v0" }),
    /evidence\.yaml\.findings\[0\] missing original_finding_id/,
  );
});

test("duplicate evidence finding ids fail validation", () => {
  const dir = packetFixture();
  writeFileSync(path.join(dir, "evidence.yaml"), [
    'schema_version: "0.1"',
    "findings:",
    "  - finding_id: F-001",
    "    original_finding_id: F-INBOX-901",
    "    original_lane: unassigned_call_evidence",
    "    review_state: needs_review",
    "  - finding_id: F-001",
    "    original_finding_id: F-INBOX-902",
    "    original_lane: unassigned_call_evidence",
    "    review_state: needs_review",
    "",
  ].join("\n"));
  assert.throws(
    () => validatePacket({ packetDir: dir, label: "evidence-home-v0" }),
    /evidence\.yaml\.findings\[1\]\.finding_id duplicated/,
  );
});
