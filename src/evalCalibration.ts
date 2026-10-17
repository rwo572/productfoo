import { createHash } from "node:crypto";

import { JUDGE_PROMPT_PROTOCOL } from "./evalJudge.js";
import type { EvalJudgeSpec } from "./evalRecord.js";

// Judge calibration (foo-eval-system-v0 R-003). A judge's verdicts count only
// after a blind, binary, owner-labelled validation clears the bar — and the
// bar is per-class: min(TPR, TNR), with a floor on real-failure labels, so an
// always-pass judge cannot clear it on a good-artifact corpus. Calibration is
// keyed to hash(effective prompt protocol, judge prompt, judge model): any drift voids it.

export const CALIBRATION_LABEL_COUNT = 30;
export const CALIBRATION_MIN_RATE = 0.9;
export const CALIBRATION_MIN_FAIL_LABELS = 10;

export type OwnerLabel = {
  /** Content hash of the labelled artifact — the corpus itself stays private. */
  artifact: string;
  verdict: "pass" | "fail";
  /** True only for labels given blind (no critique context, anonymised). */
  blind: boolean;
  labeled_at: string;
  /** Free-text capture note: actionable description, no root-cause analysis. */
  note?: string;
  /** How the label was given; a dispute relabel supersedes by later append. */
  origin?: "capture" | "dispute";
  /** For a relabel: what surfaced the dispute. */
  provenance?: string;
};

/**
 * A blind dispute relabel that disagreed with the judge (or refined an earlier
 * label): a refinement signal for the record's criterion or the judge prompt,
 * never a gate input — the relabel already replaced the scored label.
 */
export type DisputeSignal = {
  /** Content hash of the disputed artifact (private corpus pointer). */
  artifact: string;
  /** The owner's blind relabel — supersedes the original by later append. */
  owner_verdict: "pass" | "fail";
  /** The judge sample's verdict on the same artifact, when one exists. */
  judge_verdict?: "pass" | "fail";
  /** The owner's note, when one accompanied the relabel. */
  note?: string;
};

export type JudgeSample = {
  artifact: string;
  verdict: "pass" | "fail";
  /** Verdict from the order-swapped second call, when taken. */
  swapped_verdict?: "pass" | "fail";
};

export type CalibrationReport = {
  schema_version: "0.1";
  /** hash(effective prompt protocol, judge prompt, judge model) — the validity key. */
  judge_key: string;
  labels: { total: number; pass: number; fail: number; non_blind_excluded: number };
  tpr: number | null;
  tnr: number | null;
  /** Share of double-called samples where the order swap flipped the verdict. */
  flip_rate: number | null;
  /** The gate: min(TPR, TNR) ≥ bar AND label floors met, on blind labels only. */
  certified: boolean;
  reasons: string[];
  /** Dispute relabels — refinement signals, reported but never gating. */
  disputes: DisputeSignal[];
  /**
   * Cohen's kappa over the blind labels that have a judge sample —
   * chance-corrected owner/judge agreement. Diagnostic only: `certified`
   * never consults it, and the gate is untouched by it.
   */
  kappa: number | null;
};

export function judgeKey(judge: Pick<EvalJudgeSpec, "prompt" | "model">): string {
  return createHash("sha256").update(JUDGE_PROMPT_PROTOCOL).update("\u0000").update(judge.prompt).update("\u0000").update(judge.model).digest("hex");
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Cohen's kappa over the blind∩sampled agreement set. po is the observed
 * agreement; pe is what two independent raters would agree on by chance,
 * from BOTH marginals of the same set — the owner-label distribution and
 * the judge-verdict distribution. Null when the set is empty or pe === 1
 * (a single class: nothing left for chance to explain away). Diagnostic
 * only — the gate never reads it.
 */
function cohenKappa(counts: {
  agree: number;
  total: number;
  ownerPass: number;
  judgePass: number;
}): number | null {
  const { agree, total, ownerPass, judgePass } = counts;
  if (total === 0) return null;
  const po = agree / total;
  const ownerFail = total - ownerPass;
  const judgeFail = total - judgePass;
  const pe = (ownerPass * judgePass + ownerFail * judgeFail) / (total * total);
  if (pe === 1) return null;
  return round((po - pe) / (1 - pe));
}

/**
 * Score a judge's samples against the owner's labels. Non-blind labels are
 * excluded from the measurement, never silently: the report counts them.
 * Loop-round rulings arrive with blind:false and therefore can never certify
 * a judge (D-007).
 */
export function computeCalibration(
  judge: Pick<EvalJudgeSpec, "prompt" | "model">,
  labels: OwnerLabel[],
  samples: JudgeSample[],
): CalibrationReport {
  const blind = labels.filter((label) => label.blind);
  const nonBlindExcluded = labels.length - blind.length;
  const byArtifact = new Map(samples.map((sample) => [sample.artifact, sample]));

  let truePass = 0;
  let falseFail = 0;
  let trueFail = 0;
  let falsePass = 0;
  let doubleCalled = 0;
  let flipped = 0;
  let unsampled = 0;
  let kappaAgree = 0;
  let kappaTotal = 0;
  let ownerPassCount = 0;
  let judgePassCount = 0;

  for (const label of blind) {
    const sample = byArtifact.get(label.artifact);
    if (!sample) {
      unsampled += 1;
      continue;
    }
    kappaTotal += 1;
    if (label.verdict === "pass") ownerPassCount += 1;
    if (sample.verdict === "pass") judgePassCount += 1;
    if (label.verdict === sample.verdict) kappaAgree += 1;
    if (sample.swapped_verdict !== undefined) {
      doubleCalled += 1;
      if (sample.swapped_verdict !== sample.verdict) flipped += 1;
    }
    if (label.verdict === "pass") {
      if (sample.verdict === "pass") truePass += 1;
      else falseFail += 1;
    } else {
      if (sample.verdict === "fail") trueFail += 1;
      else falsePass += 1;
    }
  }

  const passLabels = truePass + falseFail;
  const failLabels = trueFail + falsePass;
  const tpr = passLabels > 0 ? round(truePass / passLabels) : null;
  const tnr = failLabels > 0 ? round(trueFail / failLabels) : null;
  const flipRate = doubleCalled > 0 ? round(flipped / doubleCalled) : null;

  const reasons: string[] = [];
  const measured = passLabels + failLabels;
  if (measured < CALIBRATION_LABEL_COUNT) {
    reasons.push(
      `Only ${measured} blind labels measured; certification needs ${CALIBRATION_LABEL_COUNT}.`,
    );
  }
  if (failLabels < CALIBRATION_MIN_FAIL_LABELS) {
    reasons.push(
      `Only ${failLabels} fail-class labels; the floor is ${CALIBRATION_MIN_FAIL_LABELS} — without real failures the false-pass rate is unmeasured.`,
    );
  }
  if (tpr !== null && tpr < CALIBRATION_MIN_RATE) {
    reasons.push(`TPR ${tpr} is below the ${CALIBRATION_MIN_RATE} bar.`);
  }
  if (tnr !== null && tnr < CALIBRATION_MIN_RATE) {
    reasons.push(`TNR ${tnr} is below the ${CALIBRATION_MIN_RATE} bar.`);
  }
  if (unsampled > 0) {
    reasons.push(`${unsampled} blind label(s) have no judge sample yet.`);
  }
  if (nonBlindExcluded > 0) {
    reasons.push(
      `${nonBlindExcluded} non-blind label(s) excluded from measurement (loop rulings are provisional signal, never calibration).`,
    );
  }

  const certified =
    measured >= CALIBRATION_LABEL_COUNT &&
    failLabels >= CALIBRATION_MIN_FAIL_LABELS &&
    tpr !== null &&
    tnr !== null &&
    Math.min(tpr, tnr) >= CALIBRATION_MIN_RATE &&
    unsampled === 0;

  const disputes: DisputeSignal[] = blind
    .filter((label) => label.origin === "dispute")
    .map((label) => {
      const sample = byArtifact.get(label.artifact);
      return {
        artifact: label.artifact,
        owner_verdict: label.verdict,
        ...(sample ? { judge_verdict: sample.verdict } : {}),
        ...(label.note ? { note: label.note } : {}),
      };
    });

  return {
    schema_version: "0.1",
    judge_key: judgeKey(judge),
    labels: { total: blind.length, pass: passLabels, fail: failLabels, non_blind_excluded: nonBlindExcluded },
    tpr,
    tnr,
    flip_rate: flipRate,
    certified,
    reasons,
    disputes,
    kappa: cohenKappa({
      agree: kappaAgree,
      total: kappaTotal,
      ownerPass: ownerPassCount,
      judgePass: judgePassCount,
    }),
  };
}

/**
 * May this judge gate a run? Only with a certified report whose key matches
 * the judge's current effective prompt+model — an edited judge is an uncalibrated judge
 * until re-validated (against the same labels; no new labeling needed).
 */
export function judgeMayGate(
  judge: Pick<EvalJudgeSpec, "prompt" | "model">,
  report: CalibrationReport | undefined,
): { allowed: boolean; reason: string } {
  if (!report) {
    return { allowed: false, reason: "No calibration report — the judge runs advisory-only." };
  }
  if (report.judge_key !== judgeKey(judge)) {
    return {
      allowed: false,
      reason:
        "The judge's prompt, request protocol, or model changed since calibration — re-run the blind validation with fresh judge samples against the existing labels before it gates.",
    };
  }
  if (!report.certified) {
    return {
      allowed: false,
      reason: `Calibration did not certify: ${report.reasons.join(" ")}`,
    };
  }
  return { allowed: true, reason: "Certified against the owner's blind labels." };
}
