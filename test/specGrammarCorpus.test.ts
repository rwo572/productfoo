// packet-grammar-v1 T-003 / V-001: the frozen legacy corpus. One real
// exemplar spec.md per measured grammar, copied verbatim from specs/ on
// 2026-07-19 and pinned with hand-counted totals — exact numbers, never
// "> 0", because a parser that mis-splits or double-IDs also produces
// non-zero counts (swarm, Applied AI/Eval lens). Legacy forms are legal
// forever (R-003), so these fixtures never rot: if a parser change breaks
// one, the parser is wrong.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  lintAnchors,
  migrateSpecText,
  parseOpenQuestions,
  requirementIds,
  stripInsertions,
} from "../src/specSections.js";

const fixtureDir = path.resolve("test/fixtures/packet-grammar");
const fixture = (name: string) => readFileSync(path.join(fixtureDir, name), "utf8");

// grammar → { fixture, source packet, hand-counted requirement total }
const CORPUS: Array<{ file: string; source: string; requirements: number; firstId: string }> = [
  { file: "colon-form.spec.md", source: "adaptive-spec-packet-v0", requirements: 20, firstId: "R-001" },
  { file: "emdash-form.spec.md", source: "foo-status-glyphs-v0", requirements: 7, firstId: "R-001" },
  { file: "bare-form.spec.md", source: "cli-first-run-v0", requirements: 13, firstId: "R-001" },
  { file: "bullet-form.spec.md", source: "work-queue-across-stages-v0", requirements: 10, firstId: "R-001" },
  { file: "unpadded-form.spec.md", source: "signals-over-gates-v0", requirements: 4, firstId: "R1" },
];

for (const { file, source, requirements, firstId } of CORPUS) {
  test(`corpus: ${source} parses to exactly ${requirements} requirements (hand-counted)`, () => {
    const ids = requirementIds(fixture(file));
    assert.equal(ids.length, requirements, `expected ${requirements}, parsed ${ids.length}: ${ids.join(", ")}`);
    assert.equal(ids[0], firstId);
  });

  test(`corpus: ${source} lints clean — legacy is legal, not a finding (R-003)`, () => {
    const findings = lintAnchors(fixture(file)).filter(
      (f) => f.code === "grammar.duplicate_id" || f.code === "grammar.malformed_id",
    );
    assert.deepEqual(findings, []);
  });
}

for (const { file, source, requirements } of CORPUS) {
  test(`corpus: ${source} migrate round-trip — stripping inserted tokens restores the original byte-for-byte (V-002)`, () => {
    const original = fixture(file);
    const result = migrateSpecText(original);
    assert.equal(result.proofOk, true);
    assert.equal(stripInsertions(result.text, result.insertions), original);
    // Migration never changes the requirement count: existing IDs are
    // untouchable (R-003), and newly minted ones only attach to lines the
    // lint already called requirement candidates.
    assert.ok(requirementIds(result.text).length >= requirements);
  });

  test(`corpus: ${source} migrate is idempotent — a second run inserts nothing`, () => {
    const once = migrateSpecText(fixture(file));
    const twice = migrateSpecText(once.text);
    assert.deepEqual(twice.insertions, []);
    assert.equal(twice.text, once.text);
  });
}

test("migrate stamps every anchor kind in its home section and skips metadata bullets", () => {
  const text = [
    "## Requirements",
    "### R-001 — already anchored",
    "- Priority: P1",
    "### A bare heading needing an ID",
    "## Decisions",
    "- Record decisions as they are made.",
    "## Risks",
    "- The dominant risk.",
    "## Validation",
    "- How a reviewer confirms.",
    "## Open Questions",
    "- The first thing needing judgment.",
    "",
  ].join("\n");
  const result = migrateSpecText(text);
  assert.equal(result.proofOk, true);
  assert.deepEqual(
    result.insertions.map((i) => i.id),
    ["R-002", "D-001", "RISK-001", "V-001", "OQ-001"],
  );
  // `- Priority: P1` must never become a requirement.
  assert.ok(!result.text.includes("Priority: P1 —") && !/R-\d+ — Priority/.test(result.text));
  assert.ok(result.text.includes("### R-002 A bare heading needing an ID"));
  assert.ok(result.text.includes("- OQ-001 — The first thing needing judgment."));
});

test("corpus: bullet-form packet's ID'd open questions parse with their IDs intact", () => {
  // work-queue writes `- **OQ-1 — title.** text` — the hand-rolled convention
  // that motivated OQ anchors in the first place.
  const oqs = parseOpenQuestions(fixture("bullet-form.spec.md"));
  assert.equal(oqs.length, 4);
  assert.deepEqual(oqs.map((q) => q.id), ["OQ-1", "OQ-2", "OQ-3", "OQ-4"]);
});
