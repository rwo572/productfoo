// `foo eval` — foo-eval-system-v0's front door.
//
// The contract, the deterministic checks, the judge runner and the calibration
// gate all shipped before this file existed, and none of them could be reached:
// no command imported them, so 891 lines of eval system had zero callers and
// never even made it into the packaged build. A capability nobody can invoke is
// indistinguishable from one that was never written.
//
// This is the surface that makes them real. It stays thin on purpose — every
// judgement lives in the modules it calls; this file parses arguments, resolves
// a packet, and renders.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parse as parseYaml } from "../vendorYaml.js";
import { UsageError } from "../errorTaxonomy.js";
import { EVAL_CORPUS_HOME, loadEvalSuite, type EvalRecord } from "../evalRecord.js";
import { compileSuite, runSuite } from "../evalCompile.js";
import { computeCalibration, judgeKey, type CalibrationReport } from "../evalCalibration.js";
import {
  compileRoastRun,
  parseRoastRun,
  renderApprovalRequest,
  setApproval,
  writeCompiledSuite,
} from "../evalRoast.js";
import { appendEvent } from "../packetWrite.js";
import {
  appendLabel,
  judgeSamplesPath,
  labelsPath,
  loadCorpusArtifacts,
  loadJudgeSamples,
  loadOwnerLabels,
  runCaptureSession,
  stratifiedSample,
  suiteArtifactsDir,
} from "../evalLabels.js";
import { withGlyph } from "../statusGlyphs.js";
import { flagValue, resolvePacketDir } from "./shared.js";

import { EVAL_SUBCOMMANDS, EVAL_USAGE_LINES } from "../commandUsage.js";

function usage(): string {
  return `${EVAL_USAGE_LINES.join("\n")}\n`;
}

/** Calibration reports live beside the records; absent means advisory-only. */
function calibrationResolver(packetDir: string): (record: EvalRecord) => CalibrationReport | undefined {
  return (record) => {
    const ref = record.judge?.calibration;
    if (!ref) return undefined;
    const file = path.join(packetDir, "evals", ref);
    if (!existsSync(file)) return undefined;
    try {
      return parseYaml(readFileSync(file, "utf8")) as CalibrationReport;
    } catch {
      return undefined;
    }
  };
}

export async function runEvalCommand(
  root: string,
  args: string[],
  glyphs: boolean,
): Promise<{ output: string; exitCode: number }> {
  const sub = args[0];
  const json = args.includes("--json");
  if (!sub || sub === "help" || sub === "--help") return { output: usage(), exitCode: 0 };
  if (!(EVAL_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`unknown eval subcommand: ${sub}`, "E_BAD_FLAG");
  }

  const { packetDir } = resolvePacketDir(root, args[1]);

  if (sub === "validate") {
    const result = loadEvalSuite(packetDir);
    if (json) return { output: `${JSON.stringify(result, null, 2)}\n`, exitCode: result.ok ? 0 : 1 };
    if (result.records.length === 0) {
      return { output: "no eval records in this packet — compile some with `foo eval compile`.\n", exitCode: 0 };
    }
    const approved = result.records.filter((record) => record.approved).length;
    const lines = [
      result.ok
        ? withGlyph("proven", `eval records ok: ${result.records.length} record(s), ${approved} approved.`, glyphs)
        : withGlyph("blocked", `eval records refused: ${result.findings.length} finding(s).`, glyphs),
    ];
    for (const finding of result.findings) {
      lines.push(`  ${finding.record} ${finding.field}: ${finding.message}`);
    }
    return { output: `${lines.join("\n")}\n`, exitCode: result.ok ? 0 : 1 };
  }

  if (sub === "compile") {
    const roastPath = flagValue(args, "--roast");
    if (!roastPath) throw new UsageError("foo eval compile needs --roast <run.json>", "E_BAD_FLAG");
    const file = path.resolve(root, roastPath);
    if (!existsSync(file)) throw new UsageError(`no roast run record at ${roastPath}`, "E_BAD_FLAG");

    // Malformed JSON in the --roast file is the caller's typo, not productfoo's bug:
    // convert the raw SyntaxError to a UsageError so it exits as a usage error
    // and files no Bug Capsule (#778). The read itself stays outside the catch so
    // a filesystem failure still classifies as io_error.
    let roastJson: unknown;
    try {
      roastJson = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new UsageError(`--roast file ${roastPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, "E_BAD_FLAG");
    }
    const parsed = parseRoastRun(roastJson);
    if (!parsed.run) {
      const lines = parsed.findings.map((finding) => `  ${finding.message}`);
      return {
        output: `${withGlyph("blocked", "that is not a usable roast run record.", glyphs)}\n${lines.join("\n")}\n`,
        exitCode: 1,
      };
    }

    // Continue the packet's existing numbering so ids are minted once and never
    // renumbered, even across several roasts of the same target.
    const existing = loadEvalSuite(packetDir).records;
    const highest = existing.reduce((max, record) => Math.max(max, Number(record.id.slice(2)) || 0), 0);
    const compiled = compileRoastRun(parsed.run, path.basename(packetDir), { startAt: highest + 1 });

    if (compiled.records.length > 0) {
      writeCompiledSuite(packetDir, compiled.records);
      appendEvent({
        packetDir,
        type: "eval_suite_compiled",
        data: {
          run: compiled.run,
          compiled: compiled.records.map((record) => record.id),
          refused: compiled.findings.length,
        },
      });
    }

    if (json) return { output: `${JSON.stringify(compiled, null, 2)}\n`, exitCode: compiled.ok ? 0 : 1 };
    return { output: `${renderApprovalRequest(compiled, glyphs)}\n`, exitCode: 0 };
  }

  if (sub === "approve" || sub === "reject") {
    const id = flagValue(args, "--check");
    const by = flagValue(args, "--by");
    if (!id) throw new UsageError(`foo eval ${sub} needs --check <E-xxx>`, "E_BAD_FLAG");
    if (!by) throw new UsageError(`foo eval ${sub} needs --by <who>`, "E_BAD_FLAG");
    const reason = flagValue(args, "--reason");
    if (sub === "reject" && !reason) {
      // A rejection is early signal about the suite, so it has to say why.
      throw new UsageError("foo eval reject needs --reason <why> — a rejection without a reason teaches nothing", "E_BAD_FLAG");
    }

    const updated = setApproval(packetDir, id, sub === "approve");
    if (!updated) {
      return { output: `${withGlyph("blocked", `no eval record ${id} in ${path.basename(packetDir)}.`, glyphs)}\n`, exitCode: 1 };
    }
    appendEvent({
      packetDir,
      type: sub === "approve" ? "eval_check_approved" : "eval_check_rejected",
      actor: { type: "human", id: by },
      data: { check: id, ...(reason ? { reason } : {}) },
    });
    const word = sub === "approve" ? "approved" : "rejected";
    return {
      output: `${withGlyph(sub === "approve" ? "proven" : "claimed", `${id} ${word} by ${by}.`, glyphs)}\n`,
      exitCode: 0,
    };
  }

  if (sub === "label") {
    const suite = labelFlag(args, "--suite") ?? path.basename(packetDir);
    const rawCount = labelFlag(args, "--count");
    const count = rawCount === undefined ? 10 : Number(rawCount);
    if (!Number.isInteger(count) || count <= 0) {
      throw new UsageError("--count wants a positive whole number of artifacts (default 10)", "E_BAD_FLAG");
    }
    const judge = labelFlag(args, "--judge");
    const dispute = labelFlag(args, "--dispute");
    if (dispute !== undefined) return relabelDisputed(root, packetDir, suite, dispute, judge, glyphs);
    return captureBlindLabels(root, packetDir, suite, count, judge, glyphs);
  }

  // run
  const targetArg = flagValue(args, "--target");
  if (!targetArg) throw new UsageError("foo eval run needs --target <file>", "E_BAD_FLAG");
  const targetPath = path.resolve(root, targetArg);
  if (!existsSync(targetPath)) throw new UsageError(`no artifact at ${targetArg}`, "E_BAD_FLAG");

  const suite = loadEvalSuite(packetDir);
  if (!suite.ok) {
    return {
      output: `${withGlyph("blocked", "refusing to run: the records do not validate. Run `foo eval validate`.", glyphs)}\n`,
      exitCode: 1,
    };
  }

  const compiled = compileSuite(suite.records);
  const artifact = readFileSync(targetPath, "utf8");
  const result = await runSuite(compiled, artifact, {
    strict: args.includes("--strict"),
    calibration: calibrationResolver(packetDir),
  });

  const ranCount = compiled.deterministic.length + compiled.judges.length;
  if (json) return { output: `${JSON.stringify({ ...result, ran: ranCount }, null, 2)}\n`, exitCode: ranCount === 0 ? 1 : result.ok ? 0 : 1 };

  // A suite with nothing approved ran nothing, and "passes" would be a lie of
  // exactly the kind this system exists to catch: a check that reports success
  // when it reported nothing. Say what actually happened.
  const ran = ranCount;
  const lines: string[] = [
    ran === 0
      ? withGlyph("needs_input", `no approved checks — nothing ran against ${targetArg}.`, glyphs)
      : result.status === "advisory_only"
        ? withGlyph("claimed", `only advisory judges ran against ${targetArg}: ${ran} check(s); no gating checks evaluated.`, glyphs)
      : result.ok
        ? withGlyph("proven", `eval suite passes on ${targetArg}: ${ran} check(s).`, glyphs)
        : withGlyph("blocked", `eval suite fails on ${targetArg}.`, glyphs),
    "",
  ];
  for (const finding of result.deterministic.findings) {
    lines.push(`  ${finding.severity === "fail" ? "FAIL" : "warn"}  ${finding.check}:${finding.line}  ${finding.message}`);
  }
  for (const judge of result.judges) {
    const tag = judge.advisory ? "advisory" : judge.verdict === "pass" ? "ok  " : "FAIL";
    lines.push(`  ${tag}  ${judge.id}  ${judge.reason ?? judge.verdict}`);
    if (judge.advisory) lines.push(`          ${judge.gating_reason}`);
  }
  if (result.skippedUnapproved.length > 0) {
    lines.push("");
    lines.push(`Not run — never approved: ${result.skippedUnapproved.join(", ")}`);
    lines.push("Approve with: foo eval approve <packet-dir> --check <E-xxx> --by <who>");
  }
  return { output: `${lines.join("\n")}\n`, exitCode: ran === 0 ? 1 : result.ok ? 0 : 1 };
}

// ── foo eval label — blind capture (W-2) ────────────────────────────────────

/** `--flag=value` and `--flag value` both resolve; the blueprint's examples use the first. */
function labelFlag(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  return flagValue(args, name);
}

/**
 * Line reader for the capture session. Works piped (each line an answer) and
 * on a terminal (line-buffered); end of input is null, never an answer.
 */
function stdinLineReader(): () => Promise<string | null> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const iterator = rl[Symbol.asyncIterator]();
  let closed = false;
  return async () => {
    if (closed) return null;
    const next = await iterator.next();
    if (next.done) {
      closed = true;
      rl.close();
      return null;
    }
    return next.value;
  };
}

async function captureBlindLabels(
  root: string,
  packetDir: string,
  suite: string,
  count: number,
  judgeFlag: string | undefined,
  glyphs: boolean,
): Promise<{ output: string; exitCode: number }> {
  const artifacts = loadCorpusArtifacts(root, suite);
  if (artifacts.length === 0) {
    return {
      output: `${withGlyph("blocked", `no corpus artifacts for suite ${suite} — nothing to label.`, glyphs)}\nArtifacts live under ${suiteArtifactsDir(".", suite)} and never enter git (R-008).\n`,
      exitCode: 1,
    };
  }

  const load = loadOwnerLabels(root, suite);
  const labeled = new Set(load.current.map((label) => label.artifact));
  const remaining = artifacts.filter((view) => !labeled.has(view.hash));
  if (remaining.length === 0) {
    const lines = [
      withGlyph("needs_input", `every artifact in suite ${suite} already has a blind label — nothing to sample.`, glyphs),
      `Relabel after a dispute: foo eval label ${path.basename(packetDir)} --dispute <hash-prefix>`,
      ...reportLines(root, packetDir, suite, judgeFlag, glyphs),
    ];
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  const sampled = stratifiedSample(remaining, (view) => view.shape, count);
  // Each label lands the moment it is answered — a Ctrl-C mid-session keeps
  // everything captured so far instead of losing the batch.
  const { labels, abandoned } = await runCaptureSession(suite, sampled, {
    readLine: stdinLineReader(),
    write: (text) => process.stdout.write(text),
  }, {
    origin: "capture",
    onLabel: (label) => appendLabel(root, label),
  });

  const lines: string[] = [];
  if (load.malformed > 0) {
    lines.push(withGlyph("drift", `${load.malformed} malformed label line(s) ignored — the file is never repaired in place.`, glyphs));
  }
  if (labels.length === 0) {
    lines.push(withGlyph("blocked", "nothing recorded — an empty capture is not a labeling session.", glyphs));
    return { output: `${lines.join("\n")}\n`, exitCode: 1 };
  }
  const pass = labels.filter((label) => label.verdict === "pass").length;
  lines.push(withGlyph("proven", `recorded ${labels.length} blind label(s) for ${suite}: ${pass} pass, ${labels.length - pass} fail.`, glyphs));
  lines.push(`  → ${path.relative(root, labelsPath(root))} — private corpus, never in git, never packed (R-008).`);
  if (sampled.length < count) {
    lines.push(`  asked for ${count}; ${remaining.length} unlabeled artifact(s) available.`);
  }
  if (abandoned) {
    lines.push(`Input ended after ${labels.length} of ${sampled.length} — rerun \`foo eval label ${path.basename(packetDir)}\` to continue; the remainder stays available.`);
  }
  lines.push(...reportLines(root, packetDir, suite, judgeFlag, glyphs));
  return { output: `${lines.join("\n")}\n`, exitCode: 0 };
}

async function relabelDisputed(
  root: string,
  packetDir: string,
  suite: string,
  dispute: string,
  judgeFlag: string | undefined,
  glyphs: boolean,
): Promise<{ output: string; exitCode: number }> {
  const prefix = dispute.trim().toLowerCase();
  const matches = loadCorpusArtifacts(root, suite).filter((view) => view.hash.startsWith(prefix));
  if (matches.length === 0) {
    return {
      output: `${withGlyph("blocked", `no corpus artifact matches hash prefix "${dispute}" in suite ${suite}.`, glyphs)}\nLabels key on content hashes; the artifact bytes must exist under ${EVAL_CORPUS_HOME}/${suite}/artifacts/ to present blind.\n`,
      exitCode: 1,
    };
  }
  if (matches.length > 1) {
    return {
      output: `${withGlyph("blocked", `hash prefix "${dispute}" matches ${matches.length} artifacts — use a longer prefix.`, glyphs)}\n${matches.map((match) => `  ${match.hash.slice(0, 12)} ${match.file}`).join("\n")}\n`,
      exitCode: 1,
    };
  }

  const view = matches[0]!;
  const { labels } = await runCaptureSession(suite, [view], {
    readLine: stdinLineReader(),
    write: (text) => process.stdout.write(text),
  }, {
    origin: "dispute",
    provenance: `dispute relabel via foo eval label --dispute (${view.hash.slice(0, 12)})`,
    onLabel: (label) => appendLabel(root, label),
  });
  if (labels.length === 0) {
    return { output: `${withGlyph("blocked", "nothing recorded — the relabel needs a verdict.", glyphs)}\n`, exitCode: 1 };
  }
  const label = labels[0]!;
  const lines = [
    withGlyph("proven", `relabeled ${label.artifact.slice(0, 12)} (${view.file}) as ${label.verdict}, blind — the relabel supersedes by later append; history is kept.`, glyphs),
    `  → ${path.relative(root, labelsPath(root))}`,
    ...reportLines(root, packetDir, suite, judgeFlag, glyphs),
  ];
  return { output: `${lines.join("\n")}\n`, exitCode: 0 };
}

// ── the calibration section the label verb prints after a session ───────────

/** Lines to append to a successful label-verb run: the calibration report. */
function reportLines(
  root: string,
  packetDir: string,
  suite: string,
  judgeFlag: string | undefined,
  glyphs: boolean,
): string[] {
  const section = calibrationSection(root, packetDir, suite, judgeFlag, glyphs);
  if (section.blocked) return [`  calibration report not shown: ${section.blocked}`];
  return section.lines;
}

/**
 * Resolve which judge record the report is about: --judge names one explicitly;
 * a unique judge record for the suite stands in on its own. The report is
 * informational — a mis-named judge can never undo a recorded label, so it
 * downgrades to a note instead of failing the capture.
 */
function calibrationSection(
  root: string,
  packetDir: string,
  suite: string,
  judgeFlag: string | undefined,
  glyphs: boolean,
): { blocked?: string; lines: string[] } {
  const records = loadEvalSuite(packetDir).records.filter(
    (record) => record.kind === "judge" && record.suite === suite,
  );
  if (judgeFlag !== undefined) {
    const named = records.find((record) => record.id.toUpperCase() === judgeFlag.toUpperCase());
    if (!named) {
      return {
        blocked: `no judge record ${judgeFlag} for suite ${suite} — --judge names a judge record in ${path.basename(packetDir)}.`,
        lines: [],
      };
    }
    return judgeReportSection(root, named, suite, glyphs);
  }
  if (records.length === 1) return judgeReportSection(root, records[0]!, suite, glyphs);
  if (records.length === 0) return { lines: [] };
  return {
    blocked: `suite ${suite} has ${records.length} judge records (${records.map((record) => record.id).join(", ")}) — name one with --judge <E-xxx>.`,
    lines: [],
  };
}

/** The live report for one judge record: the blueprint's "then print the
 * calibration report". Needs stored judge samples; without them it says
 * exactly what is missing instead of pretending the math ran. */
function judgeReportSection(
  root: string,
  record: EvalRecord,
  suite: string,
  glyphs: boolean,
): { blocked?: string; lines: string[] } {
  if (!record.judge) {
    return { blocked: `record ${record.id} carries no judge spec.`, lines: [] };
  }
  const judge = record.judge;
  const { samples: stored, malformed } = loadJudgeSamples(root, suite);
  const key = judgeKey(judge);
  const current = stored.filter((sample) => sample.judge_key === key);
  const drifted = stored.length - current.length;
  if (current.length === 0) {
    const lines = [
      "",
      `no judge samples stored under this judge_key — the calibration report needs judge verdicts keyed by artifact hash.`,
      `  samples live at ${path.relative(root, judgeSamplesPath(root, suite))} (private corpus, R-008).`,
    ];
    if (malformed > 0) lines.push(`  ${malformed} malformed sample line(s) ignored.`);
    if (drifted > 0) lines.push(`  ${drifted} sample(s) from an earlier judge_key excluded — drift voids them until revalidation against the same labels.`);
    return { lines };
  }

  const { current: labels, malformed: labelMalformed } = loadOwnerLabels(root, suite);
  const report = computeCalibration(judge, labels, current);
  const lines = [
    "",
    `calibration for ${record.id} (${judge.model}): ${report.certified ? "certified" : "not certified"} — ${report.labels.total} blind label(s), TPR ${report.tpr ?? "—"}, TNR ${report.tnr ?? "—"}.`,
    `  kappa ${report.kappa ?? "—"} (chance-corrected owner/judge agreement — diagnostic, never gating).`,
  ];
  if (labelMalformed > 0) lines.push(`  ${labelMalformed} malformed label line(s) ignored.`);
  for (const reason of report.reasons) lines.push(`  · ${reason}`);
  if (report.disputes.length > 0) {
    lines.push("  dispute relabels — refinement signals for the criterion or the judge prompt (never gate inputs):");
    for (const dispute of report.disputes) {
      const judged = dispute.judge_verdict ? `judge ${dispute.judge_verdict}` : "no judge sample";
      lines.push(`    ${dispute.artifact.slice(0, 12)}  owner ${dispute.owner_verdict} · ${judged}${dispute.note ? ` — "${dispute.note}"` : ""}`);
    }
    lines.push("  a dispute asks for a closer look: refine the record's criterion, or the judge prompt — an edited prompt changes the judge_key and voids calibration until revalidated against the same labels.");
  }
  return { lines };
}
