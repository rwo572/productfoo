import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sealPaperReceipt, verifyPaperReceipt, publishPaperReceipt } from "../src/researchCompletion.js";

import { createResearchPolicy } from "../src/researchExecution.js";

const NOW = "2026-07-20T12:00:00.000Z";
const RUN = "r-live-abcd01";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "foo-root-"));
  const keyDir = mkdtempSync(path.join(tmpdir(), "foo-keys-"));
  return { root, keyDir };
}
function seal(root: string, keyDir: string, paper: string) {
  createResearchPolicy(root, RUN, "faster onboarding", { keyDir, now: NOW, env: { FOO_STATE_DIR: path.join(root, "state"), FIRECRAWL_API_KEY: "" } });
  return sealPaperReceipt(root, {
    runId: RUN,
    topic: "faster onboarding",
    paperBytes: Buffer.from(paper, "utf8"),
    sources: [{ source_class: "repo", reached: true, item_count: 3 }],
    provider: { adapter: "single-model", model: "claude-opus-4-8" },
    evaluatorVersion: "research-format-v1",
    now: NOW,
    keyDir,
  });
}

test("seal then verify: the sealed paper verifies", () => {
  const { root, keyDir } = setup();
  const paper = "# Onboarding\n\nresearch_run: r-live-abcd01\n";
  seal(root, keyDir, paper);
  const r = verifyPaperReceipt(root, RUN, Buffer.from(paper, "utf8"), { now: NOW });
  assert.equal(r.ok, true);
});

test("a paper altered after sealing does not verify", () => {
  const { root, keyDir } = setup();
  const paper = "# Onboarding\n\nresearch_run: r-live-abcd01\n";
  seal(root, keyDir, paper);
  const r = verifyPaperReceipt(root, RUN, Buffer.from(paper + "\nsmuggled claim\n", "utf8"), { now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "paper_mismatch");
});

test("a paper naming a run that was never sealed does not verify", () => {
  const { root } = setup();
  const r = verifyPaperReceipt(root, "r-never-sealed01", Buffer.from("x"), { now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no_receipt");
});

test("published receipt verifies from the tracked store alone (fresh-clone shape)", () => {
  const { root, keyDir } = setup();
  const paper = "# Onboarding\n\nresearch_run: r-live-abcd01\n";
  seal(root, keyDir, paper);
  assert.equal(publishPaperReceipt(root, RUN), "sealed");
  assert.equal(publishPaperReceipt(root, RUN), "already-sealed");
  // drop the working store to simulate a reviewer who only has the committed repo
  rmSync(path.join(root, ".foo"), { recursive: true, force: true });
  const r = verifyPaperReceipt(root, RUN, Buffer.from(paper, "utf8"), { now: NOW });
  assert.equal(r.ok, true);
});
