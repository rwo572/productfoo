import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";

// The eval contract (foo-eval-system-v0 R-001). An eval is a typed foo record
// that states its criterion in plain language; how a criterion gets scored is
// the runner's business, not the record's. The lint below keeps runner and
// template vocabulary out of records, which is what lets the judge transport
// change without rewriting a corpus.

export const EVAL_RECORD_SCHEMA_VERSION = "0.1";

/**
 * Where golden sets, owner labels, and seeded artifacts live (R-008).
 *
 * The harness is open source; the corpus is not, and it never enters git
 * history at all — committed records reference it by pointer and content hash
 * only. This path sits under the already-ignored `.foo/`, and two pinned tests
 * hold the line: nothing under it may be tracked, and the published payload may
 * never contain it. Path exclusion cannot rest on the secret scanner, which
 * waves ordinary prose through by design.
 */
export const EVAL_CORPUS_HOME = ".foo/eval-corpus";

export type EvalCheckKind = "deterministic" | "judge";

export type EvalProvenance =
  | { source: "roast-run"; run: string }
  | { source: "observed-failure"; ref: string };

export type EvalJudgeSpec = {
  /** The judge's instruction. Owned by the record, rendered by the compiler. */
  prompt: string;
  /** Pinned judge model id. Calibration is keyed to hash(prompt, model). */
  model: string;
  /** Calibration report reference; absent means uncalibrated (advisory-only). */
  calibration?: string;
};

export type EvalRecord = {
  schema_version: string;
  /** Unique within the owning suite, E-001 style. Minted once, never renumbered. */
  id: string;
  suite: string;
  /** Artifact path or named behavior this eval scores. */
  target: string;
  kind: EvalCheckKind;
  /** Binary pass definition in plain language — the approval surface. */
  pass: string;
  /** Deterministic only: registered check id plus its params. */
  check?: { id: string; params?: Record<string, unknown> };
  /** Judge only. */
  judge?: EvalJudgeSpec;
  provenance: EvalProvenance;
  /** Per-check owner approval (R-004). Unapproved records never run. */
  approved: boolean;
};

export type EvalRecordFinding = {
  rule: "ER-001" | "ER-002" | "ER-003";
  record: string;
  field: string;
  phrase: string;
  message: string;
};

export type EvalRecordResult = {
  ok: boolean;
  records: EvalRecord[];
  findings: EvalRecordFinding[];
};

// Runner vocabulary that must never appear in a record (V-006). A record
// states a criterion; the moment it carries a runner's config format, changing
// how evals are scored becomes a corpus migration. Token boundaries follow the
// humanSurfaceEval lesson: a substring is not evidence the phrase is present.
const ENGINE_VOCABULARY: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\{\{\s*[\w.]+\s*\}\}/, label: "template placeholder syntax" },
  { pattern: /(?<![\w-])llm-rubric(?![\w-])/i, label: "third-party assertion type" },
  { pattern: /(?<![\w-])(?:model-graded-closedqa|answer-relevance|context-faithfulness)(?![\w-])/i, label: "third-party assertion type" },
  { pattern: /(?<![\w-])assert(?:ions)?\s*:/i, label: "runner config key" },
  { pattern: /(?<![\w-])(?:providers|defaultTest|testCases)\s*:/, label: "runner config key" },
  { pattern: /(?<![\w-])promptfoo(?![\w-])/i, label: "third-party engine name" },
];

const RECORD_ID = /^E-\d{3,4}$/;

function lintEngineVocabulary(record: EvalRecord, findings: EvalRecordFinding[]): void {
  const surfaces: Array<[string, string | undefined]> = [
    ["pass", record.pass],
    ["target", record.target],
    ["judge.prompt", record.judge?.prompt],
  ];
  for (const [field, text] of surfaces) {
    if (!text) continue;
    for (const { pattern, label } of ENGINE_VOCABULARY) {
      const match = text.match(pattern);
      if (match) {
        findings.push({
          rule: "ER-002",
          record: record.id ?? "(missing id)",
          field,
          phrase: match[0],
          message: `Engine vocabulary (${label}) belongs only in compiler output; state the check in productfoo's contract terms.`,
        });
      }
    }
  }
}

function validateRecord(raw: unknown, findings: EvalRecordFinding[]): EvalRecord | undefined {
  if (typeof raw !== "object" || raw === null) {
    findings.push({
      rule: "ER-001",
      record: "(unparsed)",
      field: "(root)",
      phrase: String(raw),
      message: "An eval record must be a mapping.",
    });
    return undefined;
  }
  const record = raw as EvalRecord;
  const problems: Array<[string, string]> = [];

  if (record.schema_version !== EVAL_RECORD_SCHEMA_VERSION) {
    problems.push(["schema_version", `expected ${EVAL_RECORD_SCHEMA_VERSION}`]);
  }
  if (typeof record.id !== "string" || !RECORD_ID.test(record.id)) {
    problems.push(["id", "expected an E-001 style id"]);
  }
  if (typeof record.suite !== "string" || record.suite.length === 0) {
    problems.push(["suite", "required"]);
  }
  if (typeof record.target !== "string" || record.target.length === 0) {
    problems.push(["target", "required"]);
  }
  if (record.kind !== "deterministic" && record.kind !== "judge") {
    problems.push(["kind", "expected deterministic or judge"]);
  }
  if (typeof record.pass !== "string" || record.pass.length === 0) {
    problems.push(["pass", "a binary pass definition is required"]);
  }
  if (record.kind === "deterministic" && typeof record.check?.id !== "string") {
    problems.push(["check", "a deterministic record names its registered check"]);
  }
  if (record.kind === "judge") {
    if (typeof record.judge?.prompt !== "string" || record.judge.prompt.length === 0) {
      problems.push(["judge.prompt", "required"]);
    }
    if (typeof record.judge?.model !== "string" || record.judge.model.length === 0) {
      problems.push(["judge.model", "a judge pins its model"]);
    }
  }
  const provenance = record.provenance as EvalProvenance | undefined;
  const provenanceOk =
    (provenance?.source === "roast-run" && typeof provenance.run === "string") ||
    (provenance?.source === "observed-failure" && typeof provenance.ref === "string");
  if (!provenanceOk) {
    problems.push(["provenance", "every eval names the roast run or observed failure that produced it"]);
  }
  if (typeof record.approved !== "boolean") {
    problems.push(["approved", "required — unapproved records never run"]);
  }

  for (const [field, message] of problems) {
    findings.push({
      rule: "ER-001",
      record: typeof record.id === "string" ? record.id : "(missing id)",
      field,
      phrase: "",
      message,
    });
  }
  if (problems.length > 0) return undefined;

  lintEngineVocabulary(record, findings);
  return record;
}

/** Validate a set of parsed records: shape, unique ids, engine-boundary lint. */
export function validateEvalRecords(rawRecords: unknown[]): EvalRecordResult {
  const findings: EvalRecordFinding[] = [];
  const records: EvalRecord[] = [];
  const seen = new Set<string>();

  for (const raw of rawRecords) {
    const record = validateRecord(raw, findings);
    if (!record) continue;
    if (seen.has(record.id)) {
      findings.push({
        rule: "ER-003",
        record: record.id,
        field: "id",
        phrase: record.id,
        message: "Duplicate eval id — ids are minted once and never reused.",
      });
      continue;
    }
    seen.add(record.id);
    records.push(record);
  }

  return { ok: findings.length === 0, records, findings };
}

/**
 * Load a packet's eval suite from `specs/<packet>/evals/*.yaml` (R-001: records
 * live in the target's packet). Missing directory is an empty suite, not an error.
 */
export function loadEvalSuite(packetDir: string): EvalRecordResult {
  const home = path.join(packetDir, "evals");
  if (!existsSync(home)) return { ok: true, records: [], findings: [] };

  const rawRecords: unknown[] = [];
  for (const entry of readdirSync(home).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const parsed = parseYaml(readFileSync(path.join(home, entry), "utf8"));
    if (Array.isArray(parsed)) rawRecords.push(...parsed);
    else if (parsed != null) rawRecords.push(parsed);
  }
  return validateEvalRecords(rawRecords);
}
