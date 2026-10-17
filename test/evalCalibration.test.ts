import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  CALIBRATION_LABEL_COUNT,
  CALIBRATION_MIN_FAIL_LABELS,
  computeCalibration,
  judgeKey,
  judgeMayGate,
  type JudgeSample,
  type OwnerLabel,
} from "../src/evalCalibration.js";

const JUDGE = { prompt: "Does bold-only reading yield the value prop?", model: "claude-sonnet-5" };

function corpus(options: {
  passLabels: number;
  failLabels: number;
  judgeWrongOnPass?: number;
  judgeWrongOnFail?: number;
  blind?: boolean;
  flips?: number;
}): { labels: OwnerLabel[]; samples: JudgeSample[] } {
  const labels: OwnerLabel[] = [];
  const samples: JudgeSample[] = [];
  const blind = options.blind ?? true;
  let flipsLeft = options.flips ?? 0;
  let wrongPassLeft = options.judgeWrongOnPass ?? 0;
  let wrongFailLeft = options.judgeWrongOnFail ?? 0;

  for (let index = 0; index < options.passLabels + options.failLabels; index += 1) {
    const artifact = `sha-${index}`;
    const truth: "pass" | "fail" = index < options.passLabels ? "pass" : "fail";
    labels.push({ artifact, verdict: truth, blind, labeled_at: "2026-08-27T00:00:00Z" });

    let verdict: "pass" | "fail" = truth;
    if (truth === "pass" && wrongPassLeft > 0) {
      verdict = "fail";
      wrongPassLeft -= 1;
    } else if (truth === "fail" && wrongFailLeft > 0) {
      verdict = "pass";
      wrongFailLeft -= 1;
    }
    const swapped: "pass" | "fail" =
      flipsLeft > 0 ? (verdict === "pass" ? "fail" : "pass") : verdict;
    if (flipsLeft > 0) flipsLeft -= 1;
    samples.push({ artifact, verdict, swapped_verdict: swapped });
  }
  return { labels, samples };
}

test("a judge agreeing on 30 blind labels with enough real failures certifies", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.certified, true);
  assert.equal(report.tpr, 1);
  assert.equal(report.tnr, 1);
  assert.equal(report.labels.fail, CALIBRATION_MIN_FAIL_LABELS);
});

test("an always-pass judge cannot certify on a pass-skewed corpus — the per-class bar catches it", () => {
  // 26 passes, 4 fails, judge passes everything: 26+4=30 labels, overall
  // agreement 26/30 ≈ 87% — but the real refusals are the fail floor and TNR.
  const { labels, samples } = corpus({ passLabels: 26, failLabels: 4, judgeWrongOnFail: 4 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.certified, false);
  assert.equal(report.tnr, 0);
  assert.ok(report.reasons.some((reason) => reason.includes("fail-class")));
});

test("non-blind labels are excluded from measurement, visibly — loop rulings never certify (D-007)", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10, blind: false });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.certified, false);
  assert.equal(report.labels.non_blind_excluded, 30);
  assert.ok(report.reasons.some((reason) => reason.includes("provisional signal")));
});

test("under 30 measured labels does not certify even with perfect agreement", () => {
  const { labels, samples } = corpus({ passLabels: 15, failLabels: 10 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.certified, false);
  assert.ok(report.reasons.some((reason) => reason.includes(String(CALIBRATION_LABEL_COUNT))));
});

test("the order-swap double call reports the judge's flip rate", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10, flips: 6 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.flip_rate, 0.2);
});

test("gating: no report means advisory; a certified matching report gates", () => {
  const none = judgeMayGate(JUDGE, undefined);
  assert.equal(none.allowed, false);
  assert.match(none.reason, /advisory/);

  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(judgeMayGate(JUDGE, report).allowed, true);
});

test("editing the judge prompt or model voids calibration until re-validated (R-003 drift key)", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const report = computeCalibration(JUDGE, labels, samples);

  const editedPrompt = judgeMayGate({ ...JUDGE, prompt: "Grade the skim, but nicer." }, report);
  assert.equal(editedPrompt.allowed, false);
  assert.match(editedPrompt.reason, /changed since calibration/);

  const rotatedModel = judgeMayGate({ ...JUDGE, model: "claude-fable-5" }, report);
  assert.equal(rotatedModel.allowed, false);

  // Re-validation against the same labels re-certifies without new labeling.
  const revalidated = computeCalibration({ ...JUDGE, model: "claude-fable-5" }, labels, samples);
  assert.equal(revalidated.certified, true);
  assert.notEqual(revalidated.judge_key, judgeKey(JUDGE));
});

test("dispute relabels surface as refinement signals — reported, never gating (W-2)", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const clean = computeCalibration(JUDGE, labels, samples);
  assert.deepEqual(clean.disputes, []);

  const withDispute = labels.map((label, index) =>
    index === 4
      ? { ...label, origin: "dispute" as const, note: "the criterion reads as requiring a headline even on empty payloads" }
      : label,
  );
  const report = computeCalibration(JUDGE, withDispute, samples);
  assert.equal(report.disputes.length, 1);
  assert.equal(report.disputes[0]!.artifact, "sha-4");
  assert.equal(report.disputes[0]!.owner_verdict, "pass");
  assert.equal(report.disputes[0]!.judge_verdict, "pass");
  assert.match(report.disputes[0]!.note ?? "", /criterion/);
  // Diagnostic only: the dispute flag changed nothing about the measurement.
  assert.equal(report.certified, clean.certified);
  assert.equal(report.tpr, clean.tpr);
  assert.equal(report.tnr, clean.tnr);
});

test("a dispute whose artifact has no judge sample still surfaces — judge_verdict stays unset", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const disputed = labels[0]!;
  const report = computeCalibration(
    JUDGE,
    [{ ...disputed, origin: "dispute", provenance: "dispute relabel" }, ...labels.slice(1)],
    samples.filter((sample) => sample.artifact !== disputed.artifact),
  );
  assert.equal(report.disputes.length, 1);
  assert.equal(report.disputes[0]!.owner_verdict, "pass");
  assert.equal(report.disputes[0]!.judge_verdict, undefined);
});

// ── Cohen's kappa — reported diagnostic, never gating (W-2) ─────────────────

/** A 2×2 rater table: the classic 50-item example with known κ = 0.4. */
function raterTable(ownerPassJudgePass: number, ownerPassJudgeFail: number, ownerFailJudgePass: number, ownerFailJudgeFail: number): {
  labels: OwnerLabel[];
  samples: JudgeSample[];
} {
  const cells = [
    { owner: "pass" as const, judge: "pass" as const, count: ownerPassJudgePass },
    { owner: "pass" as const, judge: "fail" as const, count: ownerPassJudgeFail },
    { owner: "fail" as const, judge: "pass" as const, count: ownerFailJudgePass },
    { owner: "fail" as const, judge: "fail" as const, count: ownerFailJudgeFail },
  ];
  const labels: OwnerLabel[] = [];
  const samples: JudgeSample[] = [];
  let index = 0;
  for (const cell of cells) {
    for (let i = 0; i < cell.count; i += 1, index += 1) {
      labels.push({ artifact: `sha-${index}`, verdict: cell.owner, blind: true, labeled_at: "2026-09-24T00:00:00Z" });
      samples.push({ artifact: `sha-${index}`, verdict: cell.judge });
    }
  }
  return { labels, samples };
}

test("kappa matches the textbook 2x2 agreement example (po 0.7, pe 0.5 → κ 0.4)", () => {
  const { labels, samples } = raterTable(20, 5, 10, 15);
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.kappa, 0.4);
});

test("kappa is symmetric in the two raters — swapping the marginals changes nothing", () => {
  const straight = raterTable(20, 5, 10, 15);
  const swapped = raterTable(20, 10, 5, 15); // owner and judge marginals exchanged
  const a = computeCalibration(JUDGE, straight.labels, straight.samples);
  const b = computeCalibration(JUDGE, swapped.labels, swapped.samples);
  assert.equal(a.kappa, 0.4);
  assert.equal(b.kappa, a.kappa);
});

test("kappa is null when nothing pairs or only one class exists", () => {
  // A single class: everyone passes — pe degenerates to 1.
  const unanimous = computeCalibration(JUDGE, corpus({ passLabels: 5, failLabels: 0 }).labels, [
    ...corpus({ passLabels: 5, failLabels: 0 }).samples,
  ]);
  assert.equal(unanimous.kappa, null);

  // No blind label has a judge sample: the agreement set is empty.
  const { labels } = corpus({ passLabels: 2, failLabels: 2 });
  const unsampled = computeCalibration(JUDGE, labels, []);
  assert.equal(unsampled.kappa, null);
});

test("kappa never gates — perfect agreement on too few labels still refuses certification", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 2 });
  const report = computeCalibration(JUDGE, labels, samples);
  assert.equal(report.kappa, 1);
  assert.equal(report.certified, false);
  assert.ok(report.reasons.length > 0);
});

test("reports from the old judge request protocol cannot gate the corrected order swap", () => {
  const { labels, samples } = corpus({ passLabels: 20, failLabels: 10 });
  const report = computeCalibration(JUDGE, labels, samples);
  // This is the legacy key algorithm, independent of the corrected runner.
  report.judge_key = createHash("sha256").update(JUDGE.prompt).update("\u0000").update(JUDGE.model).digest("hex");
  assert.equal(judgeMayGate(JUDGE, report).allowed, false);
  assert.match(judgeMayGate(JUDGE, report).reason, /re-run/);
});
