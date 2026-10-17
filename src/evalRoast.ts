// foo-eval-system-v0 T-005 (R-004): roast is the authoring front door.
//
// A roast already ends by naming what the next generation should be judged
// against. That naming was prose, so it evaporated: nothing carried a candidate
// check from the roast that found it to the suite that would run it, and the
// only way to get an eval was to hand-author one — which R-001 forbids reaching
// engine configuration, and which nobody does twice.
//
// So `foo roast --deep` mints a run id, the roast emits a machine-readable
// candidate block beside its prose, and this module compiles that block into
// eval records whose provenance points back at the run. The prose stays the
// approval and provenance surface: a candidate arrives unapproved, is shown to
// the owner in the roast's own words with its origin, and only an explicit
// per-check approval lets it run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import {
  EVAL_RECORD_SCHEMA_VERSION,
  type EvalCheckKind,
  type EvalRecord,
} from "./evalRecord.js";
import { DETERMINISTIC_CHECK_IDS } from "./evalChecks.js";

/** A roast run, durable enough that a compiled eval can cite it years later. */
export type RoastRunRecord = {
  schema_version: string;
  /** `roast-YYYY-MM-DD-<slug>`; minted by `foo roast --deep`, never by hand. */
  run: string;
  /** Artifact path or named behavior the roast examined. */
  target: string;
  at: string;
  candidates: RoastCandidate[];
};

/**
 * One candidate check as the roast named it. Deliberately three fields: the
 * roast decides WHAT to judge, never how it is scored (R-001).
 */
export type RoastCandidate = {
  kind: EvalCheckKind;
  /** Binary pass definition, plain language. This is what the owner approves. */
  pass: string;
  /** Optional narrower target; defaults to the run's target. */
  target?: string;
  /** Deterministic only: which registered check, and its params. */
  check?: { id: string; params?: Record<string, unknown> };
  /** Judge only: the criterion and the pinned model. */
  judge?: { prompt: string; model: string };
};

export type RoastCompileFinding = {
  rule: "RC-001" | "RC-002" | "RC-003" | "RC-004";
  candidate: number;
  message: string;
};

export type RoastCompileResult = {
  ok: boolean;
  run: string;
  /** Compiled records, always unapproved: approval is a separate human act. */
  records: EvalRecord[];
  findings: RoastCompileFinding[];
};

const RUN_ID = /^roast-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/**
 * Mint a run id from the target and the day. Content-derived rather than
 * random so the same roast of the same artifact on the same day is the same
 * run — a re-roast that finds the same check should not fork provenance.
 */
export function mintRoastRunId(target: string, at: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const slugSource = path.basename(target).toLowerCase();
  const slug = slugSource
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stable = slug || createHash("sha256").update(target).digest("hex").slice(0, 8);
  return `roast-${day}-${stable}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a roast run record. The candidate block is data the roast emitted, so it
 * is parsed defensively: a malformed block is a finding, never a throw that
 * loses the rest of the run.
 */
export function parseRoastRun(raw: unknown): { run: RoastRunRecord | null; findings: RoastCompileFinding[] } {
  const findings: RoastCompileFinding[] = [];
  if (!isRecord(raw)) {
    findings.push({ rule: "RC-001", candidate: -1, message: "roast run record is not an object" });
    return { run: null, findings };
  }
  const run = typeof raw.run === "string" ? raw.run : "";
  if (!RUN_ID.test(run)) {
    findings.push({
      rule: "RC-001",
      candidate: -1,
      message: `roast run id "${run}" is not a minted id (expected roast-YYYY-MM-DD-<slug>; run \`foo roast --deep\` to mint one)`,
    });
    return { run: null, findings };
  }
  if (typeof raw.target !== "string" || raw.target.trim() === "") {
    findings.push({ rule: "RC-001", candidate: -1, message: "roast run record names no target" });
    return { run: null, findings };
  }
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  return {
    run: {
      schema_version: typeof raw.schema_version === "string" ? raw.schema_version : EVAL_RECORD_SCHEMA_VERSION,
      run,
      target: raw.target,
      at: typeof raw.at === "string" ? raw.at : new Date().toISOString(),
      candidates: candidates as RoastCandidate[],
    },
    findings,
  };
}

/**
 * Compile a roast run's candidates into eval records.
 *
 * Every record comes out `approved: false`. That is the whole point of the
 * separation: compiling is mechanical, approving is judgment, and a suite that
 * grows without anyone saying yes is the sprawl R-004 is guarding against.
 */
export function compileRoastRun(
  run: RoastRunRecord,
  suite: string,
  options: { startAt?: number } = {},
): RoastCompileResult {
  const findings: RoastCompileFinding[] = [];
  const records: EvalRecord[] = [];
  let next = options.startAt ?? 1;

  run.candidates.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      findings.push({ rule: "RC-002", candidate: index, message: "candidate is not an object" });
      return;
    }
    if (candidate.kind !== "deterministic" && candidate.kind !== "judge") {
      findings.push({ rule: "RC-002", candidate: index, message: `candidate kind must be deterministic or judge, got "${String(candidate.kind)}"` });
      return;
    }
    if (typeof candidate.pass !== "string" || candidate.pass.trim() === "") {
      findings.push({ rule: "RC-002", candidate: index, message: "candidate has no binary pass definition — the roast must say what passing means" });
      return;
    }

    if (candidate.kind === "deterministic") {
      const id = candidate.check?.id;
      if (!id) {
        findings.push({ rule: "RC-003", candidate: index, message: "deterministic candidate names no registered check id" });
        return;
      }
      if (!DETERMINISTIC_CHECK_IDS.includes(id as (typeof DETERMINISTIC_CHECK_IDS)[number])) {
        findings.push({
          rule: "RC-003",
          candidate: index,
          message: `"${id}" is not a registered deterministic check (registered: ${DETERMINISTIC_CHECK_IDS.join(", ")})`,
        });
        return;
      }
    } else {
      if (!candidate.judge?.prompt || !candidate.judge.model) {
        findings.push({ rule: "RC-004", candidate: index, message: "judge candidate needs both a criterion and a pinned model" });
        return;
      }
    }

    records.push({
      schema_version: EVAL_RECORD_SCHEMA_VERSION,
      id: `E-${String(next).padStart(3, "0")}`,
      suite,
      target: candidate.target ?? run.target,
      kind: candidate.kind,
      pass: candidate.pass,
      ...(candidate.kind === "deterministic" ? { check: candidate.check } : {}),
      // A compiled judge is uncalibrated by construction: no calibration
      // reference is minted here, so R-005 keeps its verdicts advisory-only
      // until a real blind pass certifies it.
      ...(candidate.kind === "judge" ? { judge: { prompt: candidate.judge!.prompt, model: candidate.judge!.model } } : {}),
      provenance: { source: "roast-run", run: run.run },
      approved: false,
    });
    next += 1;
  });

  return { ok: findings.length === 0, run: run.run, records, findings };
}

/**
 * The approval surface: each check in the roast's own words, with where it came
 * from. Rendered for a human to read and answer, never for a machine to parse.
 */
export function renderApprovalRequest(result: RoastCompileResult, glyphsOn: boolean): string {
  const lines: string[] = [];
  const mark = glyphsOn ? "✋ needs your input" : "needs your input";
  lines.push(`${mark} — ${result.records.length} check(s) compiled from ${result.run}. Nothing runs until you approve it.`);
  lines.push("");
  for (const record of result.records) {
    lines.push(`  ${record.id}  [${record.kind}]  ${record.target}`);
    lines.push(`      passes when: ${record.pass}`);
    lines.push(`      from your roast: ${result.run}`);
    lines.push("");
  }
  if (result.findings.length > 0) {
    lines.push("Not compiled:");
    for (const finding of result.findings) {
      const which = finding.candidate >= 0 ? `candidate ${finding.candidate + 1}` : "the run record";
      lines.push(`  ${which}: ${finding.message}`);
    }
    lines.push("");
  }
  lines.push("Approve one:  foo eval approve <packet-dir> --check E-001 --by <who>");
  lines.push("Reject one:   foo eval reject <packet-dir> --check E-001 --by <who> --reason <why>");
  return lines.join("\n");
}

const SUITE_FILE = "compiled.yaml";

/** Where a packet keeps its eval records. Matches loadEvalSuite's home. */
export function evalHome(packetDir: string): string {
  return path.join(packetDir, "evals");
}

/**
 * Write compiled records into the packet, merging by id so a re-compile of the
 * same roast never silently drops an approval the owner already gave.
 */
export function writeCompiledSuite(packetDir: string, records: EvalRecord[]): { written: number; kept: number } {
  const home = evalHome(packetDir);
  mkdirSync(home, { recursive: true });
  const file = path.join(home, SUITE_FILE);

  const existing: EvalRecord[] = existsSync(file)
    ? ((parseYaml(readFileSync(file, "utf8")) as EvalRecord[] | null) ?? [])
    : [];
  const byId = new Map(existing.map((record) => [record.id, record]));

  let written = 0;
  let kept = 0;
  for (const record of records) {
    const prior = byId.get(record.id);
    if (prior) {
      // An approval is a human act; re-compiling must never revoke or re-grant it.
      byId.set(record.id, { ...record, approved: prior.approved });
      kept += 1;
      continue;
    }
    byId.set(record.id, record);
    written += 1;
  }

  const merged = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  writeFileSync(file, `${merged.map((record) => yamlRecord(record)).join("\n")}\n`);
  return { written, kept };
}

/** Minimal, stable YAML emission — no dependency on a writer's formatting. */
function yamlRecord(record: EvalRecord): string {
  const lines = [
    `- schema_version: "${record.schema_version}"`,
    `  id: "${record.id}"`,
    `  suite: "${record.suite}"`,
    `  target: ${JSON.stringify(record.target)}`,
    `  kind: "${record.kind}"`,
    `  pass: ${JSON.stringify(record.pass)}`,
  ];
  if (record.check) {
    lines.push(`  check:`);
    lines.push(`    id: "${record.check.id}"`);
    if (record.check.params) lines.push(`    params: ${JSON.stringify(record.check.params)}`);
  }
  if (record.judge) {
    lines.push(`  judge:`);
    lines.push(`    prompt: ${JSON.stringify(record.judge.prompt)}`);
    lines.push(`    model: "${record.judge.model}"`);
    if (record.judge.calibration) lines.push(`    calibration: "${record.judge.calibration}"`);
  }
  lines.push(`  provenance:`);
  if (record.provenance.source === "roast-run") {
    lines.push(`    source: "roast-run"`);
    lines.push(`    run: "${record.provenance.run}"`);
  } else {
    lines.push(`    source: "observed-failure"`);
    lines.push(`    ref: ${JSON.stringify(record.provenance.ref)}`);
  }
  lines.push(`  approved: ${record.approved}`);
  return lines.join("\n");
}

/** Flip one record's approval. Returns null when the id is not in the suite. */
export function setApproval(
  packetDir: string,
  id: string,
  approved: boolean,
): { record: EvalRecord } | null {
  const file = path.join(evalHome(packetDir), SUITE_FILE);
  if (!existsSync(file)) return null;
  const records = ((parseYaml(readFileSync(file, "utf8")) as EvalRecord[] | null) ?? []);
  const target = records.find((record) => record.id === id);
  if (!target) return null;
  target.approved = approved;
  writeFileSync(file, `${records.map((record) => yamlRecord(record)).join("\n")}\n`);
  return { record: target };
}
