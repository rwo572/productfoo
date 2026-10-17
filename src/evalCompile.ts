import { judgeMayGate, type CalibrationReport } from "./evalCalibration.js";
import { runDeterministicChecks, type EvalChecksResult } from "./evalChecks.js";
import { callJudgeWithSwap, type JudgeTransport } from "./evalJudge.js";
import type { EvalRecord } from "./evalRecord.js";

// Suite planner and runner (foo-eval-system-v0 R-001). Records carry productfoo's
// contract; this module turns an approved suite into a plan and runs it.
//
// There is no third-party eval engine behind this any more (owner ruling on
// issue #705, 2026-08-27): deterministic checks run natively and judges are one
// direct model call each. R-001's engine-neutrality still holds and still
// matters — the record schema names no runner, so the judge transport is
// swappable without touching a single eval record.

export type CompiledJudge = {
  id: string;
  /** The criterion the judge scores, verbatim from the record. */
  criterion: string;
  /** The judge model pinned by the record — calibration is keyed to it. */
  model: string;
};

export type CompiledSuite = {
  /** Deterministic records, run natively. */
  deterministic: EvalRecord[];
  judges: EvalRecord[];
  /** The judge plan: what will be asked, of which model. */
  judgePlan: CompiledJudge[];
  /** Approved-only is the rule (R-004); what was skipped stays visible. */
  skippedUnapproved: string[];
};

export type JudgeOutcome = {
  id: string;
  verdict: "pass" | "fail" | "error";
  /** True until the judge's calibration report exists and holds (D-007). */
  advisory: boolean;
  /** Why the judge is (or is not) allowed to gate. */
  gating_reason: string;
  /** The order-swap check disagreed with itself on this artifact. */
  flipped?: boolean;
  /** Verdict from the required confirmation; absent if the first call errored. */
  swapped?: "pass" | "fail" | "error";
  reason?: string;
};

export type SuiteRunResult = {
  /** True means no gating check failed, not that any gating check passed. Read status. */
  ok: boolean;
  /** Coverage: zero approved checks is not_run; only uncalibrated judges is advisory_only. */
  status: "passed" | "failed" | "not_run" | "advisory_only";
  deterministic: EvalChecksResult;
  judges: JudgeOutcome[];
  skippedUnapproved: string[];
};

/** Plan an approved suite: split kinds and render each judge's ask. */
export function compileSuite(records: EvalRecord[]): CompiledSuite {
  const approved = records.filter((record) => record.approved);
  const skippedUnapproved = records
    .filter((record) => !record.approved)
    .map((record) => record.id);
  const deterministic = approved.filter((record) => record.kind === "deterministic");
  const judges = approved.filter((record) => record.kind === "judge");

  return {
    deterministic,
    judges,
    judgePlan: judges.map((record) => ({
      id: record.id,
      criterion: record.judge!.prompt,
      model: record.judge!.model,
    })),
    skippedUnapproved,
  };
}

/**
 * Run a compiled suite over an artifact. Deterministic checks gate; judge
 * verdicts gate only when calibrated — uncalibrated judges are advisory-only
 * and can never fail the run (R-003/D-007).
 */
export async function runSuite(
  compiled: CompiledSuite,
  artifactText: string,
  options: {
    strict?: boolean;
    /** Resolve a judge record's calibration reference to its report. */
    calibration?: (record: EvalRecord) => CalibrationReport | undefined;
    /** Injected for tests; defaults to the real model call. */
    transport?: JudgeTransport;
  } = {},
): Promise<SuiteRunResult> {
  const deterministic = runDeterministicChecks(
    artifactText,
    compiled.deterministic.map((record) => ({
      id: record.check!.id,
      params: record.check!.params,
    })),
    options,
  );

  const judges: JudgeOutcome[] = [];
  for (const record of compiled.judges) {
    const gate = judgeMayGate(
      record.judge!,
      record.judge?.calibration ? options.calibration?.(record) : undefined,
    );
    const call = await callJudgeWithSwap(
      { prompt: record.judge!.prompt, model: record.judge!.model, artifact: artifactText },
      options.transport,
    );
    judges.push({
      id: record.id,
      verdict: call.verdict,
      advisory: !gate.allowed,
      gating_reason: gate.reason,
      flipped: call.flipped,
      swapped: call.swapped,
      reason: call.error ?? call.note,
    });
  }

  const gatingJudgeFailed = judges.some(
    (judge) => !judge.advisory && judge.verdict !== "pass",
  );
  const ran = compiled.deterministic.length + judges.length;
  const gating = compiled.deterministic.length + judges.filter(judge => !judge.advisory).length;
  const ok = ran > 0 && deterministic.ok && !gatingJudgeFailed;
  return {
    ok,
    status: ran === 0 ? "not_run" : gating === 0 ? "advisory_only" : ok ? "passed" : "failed",
    deterministic,
    judges,
    skippedUnapproved: compiled.skippedUnapproved,
  };
}
