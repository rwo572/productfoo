import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { EVAL_CORPUS_HOME } from "./evalRecord.js";
import type { JudgeSample, OwnerLabel } from "./evalCalibration.js";

// Blind label capture (foo-eval-system-v0 W-2 — the T-004 leftover).
//
// The calibration math in evalCalibration.ts is pure and shipped long before
// anything could produce its inputs: no code read or wrote an OwnerLabel, so
// the R-003 blind pass could never actually run. This module is the producer —
// the storage layout, the shape-stratified sampler, and the blind presentation
// surface the owner labels against.
//
// Layout, all under EVAL_CORPUS_HOME, which never enters git or a package
// payload (R-008, pinned by tests):
//
//   .foo/eval-corpus/<suite>/artifacts/           corpus artifacts, one file each
//   .foo/eval-corpus/<suite>/judge-samples.jsonl  stored judge verdicts, per artifact
//   .foo/eval-corpus/labels.jsonl                 appended owner labels, one suite per line
//
// Labels key on the artifact's content hash. The labels file is append-only:
// a relabel appends a new line for the same hash, the latest line wins on
// read, and nothing is ever rewritten — supersession without history loss.

/** An OwnerLabel as stored: the measurement fields plus the suite it scored. */
export type StoredOwnerLabel = OwnerLabel & { suite: string };

/**
 * The capture view of a corpus artifact. Deliberately carries no `input` or
 * `context`: those are the private trace fields an artifact file may hold for
 * reconstruction (W-2), and the blind surface is type-enforced not to show
 * them — a renderer that cannot receive the trace cannot leak it.
 */
export type CorpusArtifactView = {
  /** File name inside the suite's artifacts home — stable and human-readable. */
  file: string;
  /** sha256 of the exact file bytes — the label key; the corpus stays private. */
  hash: string;
  bytes: number;
  /** What the user actually saw, when the artifact recorded it. */
  rendered?: string;
  /** The raw emitted artifact: the envelope's `payload`, or the file itself. */
  payload: unknown;
  /** Coarse structural class, used to stratify sampling. */
  shape: string;
};

/** How a capture session talks to its human: line in, text out. */
export type CaptureIo = {
  /** Next line from the labeler, or null at end of input. */
  readLine: () => Promise<string | null>;
  write: (text: string) => void;
};

export function suiteArtifactsDir(root: string, suite: string): string {
  return path.join(root, EVAL_CORPUS_HOME, suite, "artifacts");
}

/** The one labels file, at the corpus home; every line carries its suite. */
export function labelsPath(root: string): string {
  return path.join(root, EVAL_CORPUS_HOME, "labels.jsonl");
}

/** Where a judge's stored verdicts live for a suite, when they exist. */
export function judgeSamplesPath(root: string, suite: string): string {
  return path.join(root, EVAL_CORPUS_HOME, suite, "judge-samples.jsonl");
}

/** A stored judge verdict: keyed by the judge_key it was produced under. */
export type StoredJudgeSample = JudgeSample & { judge_key: string };

const VERDICTS = new Set(["pass", "fail"]);

function asStoredJudgeSample(value: unknown): StoredJudgeSample | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.judge_key !== "string" || record.judge_key === "") return undefined;
  if (typeof record.artifact !== "string" || record.artifact === "") return undefined;
  if (typeof record.verdict !== "string" || !VERDICTS.has(record.verdict)) return undefined;
  if (
    record.swapped_verdict !== undefined &&
    (typeof record.swapped_verdict !== "string" || !VERDICTS.has(record.swapped_verdict))
  ) {
    return undefined;
  }
  return {
    judge_key: record.judge_key,
    artifact: record.artifact,
    verdict: record.verdict as JudgeSample["verdict"],
    ...(record.swapped_verdict !== undefined
      ? { swapped_verdict: record.swapped_verdict as JudgeSample["verdict"] }
      : {}),
  };
}

/**
 * Load a suite's stored judge samples. Malformed lines are counted, never
 * silently dropped — the same honesty rule the labels file follows.
 */
export function loadJudgeSamples(root: string, suite: string): { samples: StoredJudgeSample[]; malformed: number } {
  const file = judgeSamplesPath(root, suite);
  if (!existsSync(file)) return { samples: [], malformed: 0 };

  const samples: StoredJudgeSample[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      malformed += 1;
      continue;
    }
    const sample = asStoredJudgeSample(parsed);
    if (sample) samples.push(sample);
    else malformed += 1;
  }
  return { samples, malformed };
}

/** The label key: content-addressed, so identical bytes share a label history. */
export function artifactHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The shape class of an artifact's payload — structure, not content: an
 * object's sorted key set, an array, plain text, or a scalar. Stratification
 * clusters on this, so a labeling batch meets each payload shape before it
 * meets more of any one shape.
 */
export function shapeClassOf(payload: unknown): string {
  if (Array.isArray(payload)) return "json:array";
  if (typeof payload === "string") return "text";
  if (payload !== null && typeof payload === "object") {
    return `json:{${Object.keys(payload as Record<string, unknown>).sort().join(",")}}`;
  }
  return "json:scalar";
}

/**
 * The rendered-vs-raw envelope. An artifact file may hold the surface the user
 * saw under `rendered` (relay notices: `notice`), with the emitted payload
 * under `payload`; without an explicit payload the object itself is it — minus
 * the private trace fields, which never render. A file that does not parse as
 * JSON is a text artifact — the corpus is owner-authored, so the reader stays
 * liberal rather than refusing to label.
 */
const TRACE_FIELDS = ["input", "context"] as const;

function envelopeOf(value: unknown): { rendered?: string; payload: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { payload: value };
  const record = value as Record<string, unknown>;
  const renderedField = ["rendered", "notice"].find((field) => typeof record[field] === "string");
  const payload =
    "payload" in record
      ? record.payload
      : Object.fromEntries(
          Object.entries(record).filter(([field]) => !(TRACE_FIELDS as readonly string[]).includes(field)),
        );
  return {
    ...(renderedField ? { rendered: record[renderedField] as string } : {}),
    payload,
  };
}

/** Load a suite's corpus artifacts in stable (filename) order. */
export function loadCorpusArtifacts(root: string, suite: string): CorpusArtifactView[] {
  const home = suiteArtifactsDir(root, suite);
  if (!existsSync(home)) return [];
  const views: CorpusArtifactView[] = [];
  for (const entry of readdirSync(home).sort()) {
    const file = path.join(home, entry);
    if (!statSync(file).isFile()) continue;
    const content = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = content;
    }
    const { rendered, payload } = envelopeOf(parsed);
    views.push({
      file: entry,
      hash: artifactHash(content),
      bytes: Buffer.byteLength(content, "utf8"),
      ...(rendered !== undefined ? { rendered } : {}),
      payload,
      shape: shapeClassOf(payload),
    });
  }
  return views;
}

/**
 * Shape-stratified sample: one representative per shape class first, in
 * first-appearance order, then random fill from the remainder until the count
 * is met. The rng is injectable so tests can pin the fill order; production
 * uses Math.random.
 */
export function stratifiedSample<T>(
  items: T[],
  shapeOf: (item: T) => string,
  count: number,
  rng: () => number = Math.random,
): T[] {
  if (count <= 0 || items.length === 0) return [];
  const representatives: T[] = [];
  const rest: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const shape = shapeOf(item);
    if (!seen.has(shape)) {
      seen.add(shape);
      representatives.push(item);
    } else {
      rest.push(item);
    }
  }
  if (representatives.length >= count) return representatives.slice(0, count);
  const picked = [...representatives];
  const pool = [...rest];
  while (picked.length < count && pool.length > 0) {
    picked.push(...pool.splice(Math.floor(rng() * pool.length), 1));
  }
  return picked;
}

/**
 * The blind presentation surface: the artifact as the user saw it, its raw
 * payload, and shape metadata — never a record criterion, never a judge
 * verdict, never the private trace. The view type cannot carry any of those,
 * so the blind rule holds by construction (R-003).
 */
export function renderBlindArtifact(view: CorpusArtifactView): string {
  const raw = typeof view.payload === "string" ? view.payload : JSON.stringify(view.payload, null, 2);
  const lines: string[] = [];
  lines.push(`file: ${view.file} · shape: ${view.shape} · ${view.bytes} bytes`);
  if (view.rendered !== undefined && view.rendered !== raw) {
    lines.push("");
    lines.push("as the user saw it:");
    lines.push(view.rendered);
  }
  lines.push("");
  lines.push("raw payload:");
  lines.push(raw);
  return lines.join("\n");
}

/** Append one label. The file is append-only history; the latest line wins. */
export function appendLabel(root: string, label: StoredOwnerLabel): void {
  const file = labelsPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(label)}\n`);
}

export type OwnerLabelLoad = {
  /** Latest label per artifact — the measurement surface. */
  current: StoredOwnerLabel[];
  /** Every stored line for this suite, in append order. */
  history: StoredOwnerLabel[];
  /** Lines that were not parseable labels — counted, never silently dropped. */
  malformed: number;
};

/** Load a suite's labels from the corpus home, resolving supersession. */
export function loadOwnerLabels(root: string, suite: string): OwnerLabelLoad {
  const file = labelsPath(root);
  if (!existsSync(file)) return { current: [], history: [], malformed: 0 };

  const history: StoredOwnerLabel[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: StoredOwnerLabel;
    try {
      parsed = JSON.parse(text) as StoredOwnerLabel;
    } catch {
      malformed += 1;
      continue;
    }
    if (parsed?.suite !== suite || typeof parsed.artifact !== "string") continue;
    if (parsed.verdict !== "pass" && parsed.verdict !== "fail") {
      malformed += 1;
      continue;
    }
    history.push(parsed);
  }

  const byArtifact = new Map<string, StoredOwnerLabel>();
  for (const label of history) byArtifact.set(label.artifact, label);
  return { current: [...byArtifact.values()], history, malformed };
}

const NOTE_GUIDANCE =
  "describe the failure so a colleague could act on it — no root-cause analysis, failures first";

/** Ask one verdict until it is well-formed. Null means end of input, not an answer. */
async function askVerdict(io: CaptureIo): Promise<"pass" | "fail" | null> {
  for (;;) {
    io.write("verdict? [pass|fail] ");
    const line = await io.readLine();
    if (line === null) return null;
    const answer = line.trim().toLowerCase();
    if (answer === "pass" || answer === "fail") return answer;
    io.write("  answer pass or fail — nothing is recorded yet.\n");
  }
}

/**
 * One blind capture session: present each sampled artifact, collect a verdict
 * and an optional note, and return the labels to persist. Nothing here knows
 * a record criterion or a judge verdict exists — the surface stays blind by
 * construction (R-003). `abandoned` reports an early end of input honestly, so
 * the caller can say exactly how much of the batch was answered.
 */
export async function runCaptureSession(
  suite: string,
  views: CorpusArtifactView[],
  io: CaptureIo,
  options: {
    origin?: OwnerLabel["origin"];
    provenance?: string;
    /** Called with each label the moment it is answered (persistence hook). */
    onLabel?: (label: StoredOwnerLabel) => void;
  } = {},
): Promise<{ labels: StoredOwnerLabel[]; abandoned: boolean }> {
  io.write(`\nBlind label capture — suite ${suite}, ${views.length} artifact(s).\n`);
  io.write(
    "You see each artifact the way the user saw it: no criteria, no judge verdicts, no context — that is the blind rule.\n",
  );
  io.write(`Notes are optional: ${NOTE_GUIDANCE}.\n`);

  const labels: StoredOwnerLabel[] = [];
  let abandoned = false;
  for (const [index, view] of views.entries()) {
    io.write(`\n── artifact ${index + 1} of ${views.length} ──\n`);
    io.write(`${renderBlindArtifact(view)}\n`);
    const verdict = await askVerdict(io);
    if (verdict === null) {
      abandoned = true;
      break;
    }
    io.write(`note? (enter to skip) — ${NOTE_GUIDANCE}:\n`);
    const note = await io.readLine();
    const noteText = note === null ? undefined : note.trim() || undefined;
    const label: StoredOwnerLabel = {
      suite,
      artifact: view.hash,
      verdict,
      blind: true,
      labeled_at: new Date().toISOString(),
      ...(noteText ? { note: noteText } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.provenance ? { provenance: options.provenance } : {}),
    };
    labels.push(label);
    options.onLabel?.(label);
    if (note === null) {
      abandoned = true;
      break;
    }
  }
  return { labels, abandoned };
}
