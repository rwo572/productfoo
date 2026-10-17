// packet-grammar-v1 T-002: the grammar module's three profiles. The fixture
// corpus (T-003) pins whole real files; these tests pin the token-table
// behaviors the corpus can't isolate — separators, wrappers, section homes,
// lint narrowness, and the canonical writers.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initPacket } from "../src/packetWrite.js";
import {
  formatAnchorBullet,
  formatRequirementHeading,
  lintAnchors,
  migrateSpecText,
  nextAnchorId,
  parseAnchors,
  parseHypotheses,
  parseOpenQuestions,
  requirementIds,
} from "../src/specSections.js";

const spec = (body: string) => body.replace(/^\n/, "");

test("requirement headings: all separator spellings parse to the same anchor shape (R-002 input-liberal)", () => {
  const text = spec(`
## Requirements
### R-001: Colon form
### R-002 — Em-dash form
### R-003 -- Double-hyphen form
### R-004 - Hyphen form
### R-005 Bare form
### R6 — Unpadded legacy form
`);
  // `--` reads as separator `-` plus a leading `-` on the title; the ID is
  // what matters and the title must not keep separator residue beyond that.
  const anchors = parseAnchors(text).filter((a) => a.kind === "R");
  assert.deepEqual(
    anchors.map((a) => a.id),
    ["R-001", "R-002", "R-003", "R-004", "R-005", "R6"],
  );
  assert.equal(anchors[0].title, "Colon form");
  assert.equal(anchors[1].title, "Em-dash form");
  assert.equal(anchors[4].title, "Bare form");
  assert.equal(anchors[5].title, "Unpadded legacy form");
  assert.ok(anchors.every((a) => a.form === "heading"));
});

test("bullet requirements parse inside Requirements only (legacy corpus form)", () => {
  const text = spec(`
## Requirements
- **R-001** One row per thread of work.
- **R2 — Engineered independence.** Ideators run hidden.
## Decisions
- **R-003** not a requirement here
`);
  const rs = parseAnchors(text).filter((a) => a.kind === "R");
  assert.deepEqual(rs.map((a) => a.id), ["R-001", "R2"]);
  assert.ok(rs.every((a) => a.form === "bullet"));
  assert.equal(rs[0].title, "One row per thread of work.");
  assert.deepEqual(requirementIds(text), ["R-001", "R2"]);
});

test("full anchor set: OQ, D, V, RISK bullets parse in their home sections (R-002)", () => {
  const text = spec(`
## Decisions
- D-001 (owner, 2026-07-19) Bulk migration.
## Risks
- RISK-001 — Grep becomes untrustworthy.
## Validation
- V-001 — Corpus pins.
- **V-002 (data-backed)** one dogfood run.
## Open Questions
- OQ-001 — Task-ref backfill.
`);
  const anchors = parseAnchors(text);
  const ids = (kind: string) => anchors.filter((a) => a.kind === kind).map((a) => a.id);
  assert.deepEqual(ids("D"), ["D-001"]);
  assert.deepEqual(ids("RISK"), ["RISK-001"]);
  assert.deepEqual(ids("V"), ["V-001", "V-002"]);
  assert.deepEqual(ids("OQ"), ["OQ-001"]);
});

test("optional hypotheses use the shared tolerant reader and keep their authored proof fields", () => {
  const text = spec(`
## Hypotheses
- H1: If the legacy path stays visible, then readers can compare it.
  - State: untested
  - Validated by: V-001, V-002
  - Evidence: Comparison fixture.
- **H-002 — If the table stays stable, then context survives.**
  - State: supported
  - Validated by: V-003
  - Evidence: Browser geometry receipt.
`);
  const anchors = parseAnchors(text).filter((anchor) => anchor.kind === "H");
  assert.deepEqual(anchors.map((anchor) => anchor.id), ["H1", "H-002"]);
  assert.deepEqual(parseHypotheses(text), [
    {
      id: "H1",
      statement: "If the legacy path stays visible, then readers can compare it.",
      state: "untested",
      validationRefs: ["V-001", "V-002"],
      evidence: "Comparison fixture.",
      line: 2,
    },
    {
      id: "H-002",
      statement: "If the table stays stable, then context survives.",
      state: "supported",
      validationRefs: ["V-003"],
      evidence: "Browser geometry receipt.",
      line: 6,
    },
  ]);
});

test("hypotheses are optional, while present duplicate and malformed H ids lint through shared grammar", () => {
  assert.deepEqual(lintAnchors(spec(`
## Intent
No hypotheses yet.
`)), []);

  const findings = lintAnchors(spec(`
## Hypotheses
- H-001 — First statement.
- H1 — Duplicate spelling.
- H-02x — Malformed statement.
`));
  assert.deepEqual(findings.map((finding) => finding.code), [
    "grammar.duplicate_id",
    "grammar.malformed_id",
  ]);
});

test("fenced syntax examples never become authored anchors or lint findings", () => {
  const text = spec(`
## Hypotheses
- H-001 — The real hypothesis.
  - State: untested
  - Validated by: V-001
  - Evidence: Real evidence.

\`\`\`markdown
- H-001 — Syntax example only.
  - State: supported
  - Validated by: V-999
  - Evidence: Example evidence.
\`\`\`
`);

  assert.deepEqual(parseHypotheses(text), [
    {
      id: "H-001",
      statement: "The real hypothesis.",
      state: "untested",
      validationRefs: ["V-001"],
      evidence: "Real evidence.",
      line: 2,
    },
  ]);
  assert.deepEqual(lintAnchors(text), []);
});

test("section homes tolerate heading suffixes — '## Validation Bar' is still Validation (T-001 audit)", () => {
  const text = spec(`
## Validation Bar
- V-001 — scored blind.
## Open Questions and Parking Lot
- OQ-1 — still counts.
`);
  const anchors = parseAnchors(text);
  assert.equal(anchors.find((a) => a.kind === "V")?.id, "V-001");
  assert.equal(parseOpenQuestions(text).length, 1);
  assert.equal(parseOpenQuestions(text)[0].id, "OQ-1");
});

test("lint: duplicate detection compares numeric identity across spellings", () => {
  const text = spec(`
## Requirements
### R-001 — First
### R1 — Same anchor, different spelling
### R-002 — Fine
`);
  const findings = lintAnchors(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "grammar.duplicate_id");
  assert.match(findings[0].detail, /R1 duplicates R-001/);
});

test("lint: malformed IDs need digits — prose words starting with R are never flagged (the override-on-sight rule)", () => {
  const clean = spec(`
## Requirements
### Risk mitigation approach
### Rendering pipeline notes
- **Reliability** as a theme
`);
  // Prose R-words must produce no malformed finding.
  assert.ok(lintAnchors(clean).every((f) => f.code !== "grammar.malformed_id"));

  const broken = spec(`
## Requirements
### R-01a — broken tail
### R- dangling
`);
  const codes = lintAnchors(broken).map((f) => f.code);
  assert.deepEqual(codes, ["grammar.malformed_id", "grammar.malformed_id"]);
});

test("lint: the sixth-grammar catcher — requirement-shaped lines with no anchor are loud (R-004, V-003)", () => {
  const text = spec(`
## Requirements
### [REQ-7] a format nobody agreed to
### R-001 — a fine one
`);
  const candidates = lintAnchors(text).filter((f) => f.code === "grammar.unparsed_candidate");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].line, 2);
});

test("candidacy follows the packet's own grammar — body bullets under heading-form requirements are prose, never findings or stamps", () => {
  // The signals-over-gates pattern: requirement R1 is a heading; the bold
  // B1-B4 bullets inside its body are content. Flagging or stamping them is
  // the false positive that kills a gate's credibility.
  const headingStyle = spec(`
## Requirements
### R1 — Two-tier contract taxonomy
- **B1 Safety**: never commit raw private source material.
- **B2 Spec identity**: unique Spec ID.
`);
  assert.ok(lintAnchors(headingStyle).every((f) => f.code !== "grammar.unparsed_candidate"));
  assert.deepEqual(migrateSpecText(headingStyle).insertions, []);

  // In a bullet-grammar packet an unanchored bold bullet IS a candidate.
  const bulletStyle = spec(`
## Requirements
- **R-001** One row per thread.
- **A new bullet nobody stamped** yet.
`);
  const finds = lintAnchors(bulletStyle).filter((f) => f.code === "grammar.unparsed_candidate");
  assert.equal(finds.length, 1);
  assert.equal(migrateSpecText(bulletStyle).insertions.map((i) => i.id)[0], "R-002");
});

test("migrate stamps an indented requirement bullet after its marker, so the minted ID is a real anchor and not lost as prose", () => {
  // Indented bold bullets are requirement candidates in a bullet-grammar
  // packet (candidacy and parseAnchors both accept the leading whitespace).
  // The minted token must land after the marker, never at column 0 — otherwise
  // the line reads as `R-002 —   - **...**`, which parseAnchors cannot anchor.
  const text = spec(`
## Requirements
- **R-001** Top-level requirement.
  - **Indented sub-requirement** nobody stamped.
`);
  const result = migrateSpecText(text);
  assert.equal(result.proofOk, true);
  assert.deepEqual(result.insertions.map((i) => i.id), ["R-002"]);
  // The stamp is placed inside the bullet, keeping the indentation.
  assert.ok(result.text.includes("  - **R-002 — Indented sub-requirement**"));
  // And the minted ID round-trips as a real requirement anchor.
  const rs = parseAnchors(result.text).filter((a) => a.kind === "R");
  assert.deepEqual(rs.map((a) => a.id).sort(), ["R-001", "R-002"]);
});

test("the scaffold is born conformant: asp init output lints clean and migrate has nothing to insert (R-008, V-005)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-scaffold-"));
  const { packetDir } = initPacket({ root, name: "fresh-v0", now: new Date("2026-07-19T00:00:00Z") });
  const scaffold = readFileSync(path.join(packetDir, "spec.md"), "utf8");
  assert.deepEqual(lintAnchors(scaffold), []);
  assert.deepEqual(migrateSpecText(scaffold).insertions, []);
  // Full anchor set present from birth.
  const kinds = new Set(parseAnchors(scaffold).map((a) => a.kind));
  assert.deepEqual([...kinds].sort(), ["D", "R", "RISK", "V"]);
  assert.deepEqual(parseOpenQuestions(scaffold), [], "a fresh packet must not manufacture a live question");
  assert.match(scaffold, /State: needs-decision/, "the ignored canonical example keeps authoring discoverable");
});

test("V0/V1 release words in Validation prose are not anchors — V requires the dash (caught in catalog migration)", () => {
  const text = spec(`
## Validation
- V-001 — A real anchor.
- V0 adds no public command.
- V0 does not depend on hooks.
`);
  const vs = parseAnchors(text).filter((a) => a.kind === "V");
  assert.deepEqual(vs.map((a) => a.id), ["V-001"]);
  // No duplicate finding from the two V0 prose bullets…
  assert.deepEqual(lintAnchors(text).filter((f) => f.code === "grammar.duplicate_id"), []);
  // …and migrate stamps them as the validation items they are.
  assert.deepEqual(migrateSpecText(text).insertions.map((i) => i.id), ["V-002", "V-003"]);
});

test("canonical write: mint never reuses a number in any spelling; requirement output is bare-heading zero-padded (R-002 output-strict)", () => {
  const anchors = parseAnchors(spec(`
## Requirements
### R1 — legacy
### R-007 — modern
`));
  assert.equal(nextAnchorId("R", anchors), "R-008");
  assert.equal(nextAnchorId("V", anchors), "V-001");
  assert.equal(formatRequirementHeading("R-008", "New one"), "### R-008 New one");
  assert.equal(formatAnchorBullet("V-001", "Corpus pins."), "- V-001 — Corpus pins.");
});
