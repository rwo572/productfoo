// foo-eval-system-v0 T-006 (R-005): the critique-and-improve loop, budgeted.
//
// The loop is roast → apply the roast's next prompt → re-score, and its danger
// is obvious once named: a scoring loop optimises whatever it can measure, so
// the cheapest way to raise a score is to delete the substance the score does
// not look at. A round that scores better by cutting the counter-case, the
// citations, or the estimate flags has not improved the artifact; it has eaten
// it. Those cuts are refused here, by name, rather than celebrated.
//
// Everything else is budget and honesty: at most three rounds, early stop when
// nothing is failing or nothing changed, uncalibrated judges never allowed to
// stop or extend a round, and a landing report every run that says where it
// stopped and why.

import { withGlyph } from "./statusGlyphs.js";
import type { SuiteRunResult } from "./evalCompile.js";

/** R-005's agreed budget. A loop without one is the B4 boundary. */
export const IMPROVE_MAX_ROUNDS = 3;

/**
 * The substance a round may never trade for a better score. Each guard is a
 * countable property of the artifact, because "did it keep the counter-case"
 * has to be decidable without asking a judge — a judge is exactly the thing
 * that might be gamed here.
 */
export type ConservationGuard = {
  id: "citations" | "estimate-flags" | "counter-case";
  label: string;
  /** How many instances the artifact carries. Never allowed to fall. */
  count: (artifact: string) => number;
};

const CITATION = /\[[^\]\n]*·[^\]\n]*\]|\[\d+\]|\(https?:\/\/[^)\s]+\)/g;
const ESTIMATE_FLAG = /(?<![\w-])(?:estimate|estimated|approx\.?|approximately|~\d|assumption|assumed)(?![\w-])/gi;
const COUNTER_CASE = /(?<![\w-])(?:however|but |counter-case|on the other hand|the case against|dissent|objection|risk[s]? (?:i|we)['’]d flag)(?![\w-])/gi;

export const CONSERVATION_GUARDS: readonly ConservationGuard[] = [
  { id: "citations", label: "citations", count: (text) => (text.match(CITATION) ?? []).length },
  { id: "estimate-flags", label: "estimate flags", count: (text) => (text.match(ESTIMATE_FLAG) ?? []).length },
  { id: "counter-case", label: "counter-case", count: (text) => (text.match(COUNTER_CASE) ?? []).length },
];

export type ConservationBreach = {
  guard: ConservationGuard["id"];
  label: string;
  before: number;
  after: number;
};

/**
 * Compare a proposed revision against the artifact it replaces. A guard breaks
 * when its count falls; holding steady or rising is fine, because the loop is
 * guarding against removal, not against editing.
 */
export function conservationBreaches(before: string, after: string): ConservationBreach[] {
  const breaches: ConservationBreach[] = [];
  for (const guard of CONSERVATION_GUARDS) {
    const had = guard.count(before);
    const has = guard.count(after);
    if (has < had) breaches.push({ guard: guard.id, label: guard.label, before: had, after: has });
  }
  return breaches;
}

export type ImproveStop =
  | "all-checks-pass"
  | "evaluation-error"
  | "not-run"
  | "no-change"
  | "budget-spent"
  | "conservation-refused";

export type ImproveRound = {
  round: number;
  /** Gating failures after this round: deterministic misses plus calibrated judge fails. */
  failing: string[];
  /** Judge verdicts that were reported but could not gate. */
  advisory: string[];
  /** Present when the round's revision was refused. */
  refused?: ConservationBreach[];
};

export type ImproveResult = {
  rounds: ImproveRound[];
  stop: ImproveStop;
  /** The artifact the loop landed on — the last accepted revision. */
  artifact: string;
};

/** Produce the next revision. Returns null when it has nothing further to try. */
export type ImproveReviser = (artifact: string, failing: string[], round: number) => Promise<string | null>;

/** Score an artifact. Injected so the loop is testable without a model call. */
export type ImproveScorer = (artifact: string) => Promise<SuiteRunResult>;

function gatingFailures(result: SuiteRunResult): string[] {
  const failures: string[] = [];
  for (const finding of result.deterministic.findings) {
    // Only unambiguous misses gate; advisory findings are reported, never fatal
    // (R-002, carrying the research-format-gate posture).
    if (finding.severity === "fail") failures.push(`${finding.check}: ${finding.message}`);
  }
  for (const judge of result.judges) {
    // An uncalibrated judge is reported and ignored. It may not stop the loop
    // and it may not extend it — being wrong in either direction is expensive.
    if (judge.advisory) continue;
    if (judge.verdict === "fail") failures.push(`${judge.id}: ${judge.reason ?? "judge failed"}`);
  }
  return failures;
}

function advisoryNotes(result: SuiteRunResult): string[] {
  return result.judges
    .filter((judge) => judge.advisory && judge.verdict !== "pass")
    .map((judge) => `${judge.id}: ${judge.verdict} (advisory — ${judge.gating_reason})`);
}

/** Missing checks or a failed calibrated judge cannot authorize improvement. */
function unavailableEvaluation(result: SuiteRunResult): { stop: "not-run" | "evaluation-error"; reasons: string[] } | undefined {
  if (result.status === "not_run") return { stop: "not-run", reasons: ["No approved checks ran."] };
  if (result.status === "advisory_only") return { stop: "not-run", reasons: ["No gating checks ran — judge results are advisory only."] };
  const errors = result.judges.filter(judge => !judge.advisory && judge.verdict === "error");
  if (errors.length) return {
    stop: "evaluation-error",
    reasons: errors.map(judge => `${judge.id}: ${judge.reason ?? "judge error"}`),
  };
  return undefined;
}

/**
 * Run the loop.
 *
 * A calibrated judge that would stop the loop is asked twice: a single
 * stochastic flip should not end a run, so the failure stands only if it
 * repeats (R-005). Deterministic checks are never re-asked — they do not flip.
 */
export async function runImproveLoop(
  artifact: string,
  score: ImproveScorer,
  revise: ImproveReviser,
  options: { maxRounds?: number } = {},
): Promise<ImproveResult> {
  const budget = Math.max(1, Math.min(options.maxRounds ?? IMPROVE_MAX_ROUNDS, IMPROVE_MAX_ROUNDS));
  const rounds: ImproveRound[] = [];
  let current = artifact;

  for (let round = 1; round <= budget; round += 1) {
    let result = await score(current);
    const unavailable = unavailableEvaluation(result);
    if (unavailable) {
      rounds.push({ round, failing: unavailable.reasons, advisory: advisoryNotes(result) });
      return { rounds, stop: unavailable.stop, artifact: current };
    }
    let failing = gatingFailures(result);

    // Re-ask once before a judge verdict is allowed to end the run.
    if (failing.length > 0 && result.judges.some((judge) => !judge.advisory && judge.verdict === "fail")) {
      const second = await score(current);
      const unavailable = unavailableEvaluation(second);
      if (unavailable) {
        rounds.push({ round, failing: unavailable.reasons, advisory: advisoryNotes(second) });
        return { rounds, stop: unavailable.stop, artifact: current };
      }
      const stillFailing = gatingFailures(second);
      if (stillFailing.length === 0) {
        result = second;
        failing = stillFailing;
      }
    }

    if (failing.length === 0) {
      rounds.push({ round, failing: [], advisory: advisoryNotes(result) });
      return { rounds, stop: "all-checks-pass", artifact: current };
    }

    const proposed = await revise(current, failing, round);
    if (proposed === null || proposed === current) {
      rounds.push({ round, failing, advisory: advisoryNotes(result) });
      return { rounds, stop: "no-change", artifact: current };
    }

    const breaches = conservationBreaches(current, proposed);
    if (breaches.length > 0) {
      // The round is refused, not scored. Accepting it and reporting the breach
      // afterwards would still leave the cut substance in the landed artifact.
      rounds.push({ round, failing, advisory: advisoryNotes(result), refused: breaches });
      return { rounds, stop: "conservation-refused", artifact: current };
    }

    rounds.push({ round, failing, advisory: advisoryNotes(result) });
    current = proposed;
  }

  return { rounds, stop: "budget-spent", artifact: current };
}

/** Where it landed and why it stopped — printed every run, human surfaces only. */
export function renderImproveLanding(result: ImproveResult, glyphsOn: boolean): string {
  const lines: string[] = [];
  const last = result.rounds.at(-1);

  switch (result.stop) {
    case "all-checks-pass":
      lines.push(withGlyph("proven", `improve loop — every gating check passes after ${result.rounds.length} round(s).`, glyphsOn));
      break;
    case "evaluation-error":
      lines.push(withGlyph("blocked", "improve loop — evaluation failed to produce a verdict; the artifact was kept.", glyphsOn));
      break;
    case "not-run":
      lines.push(withGlyph("needs_input", "improve loop — no gating checks ran; the artifact was kept.", glyphsOn));
      break;
    case "no-change":
      lines.push(withGlyph("claimed", `improve loop — stopped at round ${result.rounds.length}: the round changed nothing.`, glyphsOn));
      break;
    case "budget-spent":
      lines.push(withGlyph("needs_input", `improve loop — spent its ${result.rounds.length}-round budget with checks still failing.`, glyphsOn));
      break;
    case "conservation-refused":
      lines.push(withGlyph("blocked", `improve loop — refused round ${result.rounds.length}: it raised the score by cutting guarded substance.`, glyphsOn));
      break;
  }

  if (last?.refused) {
    lines.push("");
    for (const breach of last.refused) {
      lines.push(`  ${breach.label}: ${breach.before} → ${breach.after} — a round may not trade this for a better score.`);
    }
  }

  if (last && last.failing.length > 0 && result.stop !== "all-checks-pass") {
    lines.push("");
    lines.push("Still failing:");
    for (const failure of last.failing) lines.push(`  ${failure}`);
  }

  const advisory = last?.advisory ?? [];
  if (advisory.length > 0) {
    lines.push("");
    lines.push("Advisory (reported, never counted):");
    for (const note of advisory) lines.push(`  ${note}`);
  }

  return lines.join("\n");
}
