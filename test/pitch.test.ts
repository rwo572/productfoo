import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runPitchCommand } from "../src/pitch.js";
import { runDetect } from "../src/productDetect.js";

test("pitch produces a Working-Backwards plan for an opportunity", () => {
  const result = runPitchCommand(".", ["faster onboarding so trials convert"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /faster onboarding so trials convert/);
  assert.match(result.output, /Press Release/);
  assert.match(result.output, /Recommendation/);
});

test("retained Pitch templates keep typed evidence out of reader-facing prose (issue #461)", () => {
  const fixture = "test/fixtures/pitch/reader-facing-evidence.md";
  const paper = readFileSync(fixture, "utf8");
  const narrative = paper.split("## Evidence")[0];

  assert.doesNotMatch(narrative, /\[(?:vendor|primary(?:\(repo\))?|social|call)\b|\[hypothesis\]/i);
  assert.match(narrative, /\[DoorDash case study\]\(https:\/\/www\.appliedcompute\.com\/case-studies\/doordash\)/);
  assert.doesNotMatch(narrative, /`[^`]*DoorDash case study[^`]*`/);
  assert.match(paper, /\| Claim \| Source type \| Confidence \| Citation \|/);
  assert.deepEqual(runDetect(process.cwd(), fixture).findings, []);

  for (const file of [
    "skills/pitch/references/prfaq-template.md",
    "skills/pitch/references/opportunity-assessment.md",
  ]) {
    const surface = readFileSync(file, "utf8");
    assert.match(surface, /Evidence ledger/i);
    assert.doesNotMatch(surface, /Label every claim \[source · confidence\]/i);
    assert.doesNotMatch(surface, /every claim typed \[source · confidence\]/i);
  }
});
