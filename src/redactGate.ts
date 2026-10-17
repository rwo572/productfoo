// Prompt Redaction Safety V0 — T-003 (R-004): the fail-closed commit gate.
// `foo self gate` scans staged content and hard-blocks high-confidence secrets
// before they can be committed (the irreversible egress, D-001). Calibrated
// (D-003): only HIGH confidence blocks; lower confidence is advisory and never
// gates. Bypass requires a human-set, recorded reason (R-007 human-only).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { gitRun, gitRunBuffer, type GitRunOptions, type GitRunResult } from "./gitRun.js";
import { scanText } from "./redactEngine.js";
import { loadRepoAllowlist } from "./redactConfig.js";

export type StagedFile = { file: string; text: string };
export type UnscannableReason =
  | "git-index-unavailable"
  | "unsupported-file-type"
  | "blob-unreadable"
  | "blob-too-large"
  | "binary-or-nul"
  | "decode-failed";
export type UnscannableStagedFile = { file: string; reason: UnscannableReason };
export type StagedRead = { scanned: StagedFile[]; unscannable: UnscannableStagedFile[] };
export type RedactGateGitSeams = {
  gitRun: (args: string[], opts: GitRunOptions) => GitRunResult;
  gitRunBuffer: (args: string[], opts: GitRunOptions) => { ok: boolean; stdout: Buffer };
};
// Metadata-only (R-007): a gate finding never carries the secret value.
export type GateFinding = { file: string; line: number; column: number; detector: string };
export type GateDecision = { blocked: boolean; overridden: boolean; high: GateFinding[]; reason?: string };

// Pure decision: block iff a high-confidence secret is present and no override
// reason was supplied. Deterministic and side-effect-free for testability.
export function decideGate(staged: StagedFile[], opts: { allowlist?: string[]; overrideReason?: string } = {}): GateDecision {
  const high: GateFinding[] = [];
  for (const f of staged) {
    for (const finding of scanText(f.text, { allowlist: opts.allowlist }).findings) {
      if (finding.confidence === "high") high.push({ file: f.file, line: finding.line, column: finding.column, detector: finding.detector });
    }
  }
  if (high.length === 0) return { blocked: false, overridden: false, high: [] };
  const reason = (opts.overrideReason ?? "").trim();
  if (reason) return { blocked: false, overridden: true, high, reason };
  return { blocked: true, overridden: false, high };
}

const AUDIT_DIR = ".foo";
const AUDIT_FILE = "redaction-overrides.jsonl";
const MAX_STAGED_BYTES = 16 * 1024 * 1024;
const SCANNER_GIT_OPTIONS: GitRunOptions = { stdio: ["ignore", "pipe", "pipe"] };
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);

type StagedIndexEntry = { file: string; mode: string };

// With -z, raw diff records are:
//   :<old-mode> <new-mode> <old-oid> <new-oid> <status>\0<path>\0
// Rename/copy records carry both old and new paths after the header. Reject the
// entire listing if Git returns anything incomplete or ambiguous: a partial
// index view cannot support a clean result.
function parseStagedIndex(raw: string): StagedIndexEntry[] | null {
  if (raw.length === 0) return [];
  if (!raw.endsWith("\0")) return null;
  const fields = raw.slice(0, -1).split("\0");
  const entries: StagedIndexEntry[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < fields.length) {
    const header = fields[cursor++];
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header ?? "");
    if (!match) return null;
    const sourcePath = fields[cursor++];
    if (!sourcePath) return null;
    const status = match[5] as string;
    const file = status === "R" || status === "C" ? fields[cursor++] : sourcePath;
    if (!file || seen.has(file)) return null;
    seen.add(file);
    entries.push({ file, mode: match[2] as string });
  }
  return entries;
}

function isProbablyText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) return false;
  }
  return true;
}

// Read the staged (index) content of files about to be committed. Every entry
// either becomes scannable UTF-8 text or a metadata-only refusal record.
export function readStaged(root: string, seams: Partial<RedactGateGitSeams> = {}): StagedRead {
  const run = seams.gitRun ?? gitRun;
  const runBuffer = seams.gitRunBuffer ?? gitRunBuffer;
  const listed = run(["diff", "--cached", "--raw", "--diff-filter=d", "-M", "-z"], { ...SCANNER_GIT_OPTIONS, cwd: root });
  if (!listed.ok) return { scanned: [], unscannable: [{ file: "[git-index]", reason: "git-index-unavailable" }] };
  const entries = parseStagedIndex(listed.stdout);
  if (!entries) return { scanned: [], unscannable: [{ file: "[git-index]", reason: "git-index-unavailable" }] };
  const scanned: StagedFile[] = [];
  const unscannable: UnscannableStagedFile[] = [];
  for (const { file, mode } of entries) {
    if (!REGULAR_BLOB_MODES.has(mode)) {
      unscannable.push({ file, reason: "unsupported-file-type" });
      continue;
    }
    // Ask git for size before reading bytes, so arbitrarily large blobs never
    // enter this process merely to learn that they exceed the scanner bound.
    const sized = run(["cat-file", "-s", `:${file}`], { ...SCANNER_GIT_OPTIONS, cwd: root });
    const sizeText = sized.stdout.endsWith("\n") ? sized.stdout.slice(0, -1) : sized.stdout;
    if (!sized.ok || !/^(?:0|[1-9]\d*)$/.test(sizeText)) {
      unscannable.push({ file, reason: "blob-unreadable" });
      continue;
    }
    const bytes = Number(sizeText);
    if (!Number.isSafeInteger(bytes)) {
      unscannable.push({ file, reason: "blob-unreadable" });
      continue;
    }
    if (bytes > MAX_STAGED_BYTES) {
      unscannable.push({ file, reason: "blob-too-large" });
      continue;
    }
    const blob = runBuffer(["show", `:${file}`], { ...SCANNER_GIT_OPTIONS, cwd: root, maxBuffer: MAX_STAGED_BYTES + 1 });
    if (!blob.ok) {
      unscannable.push({ file, reason: "blob-unreadable" });
      continue;
    }
    if (blob.stdout.length !== bytes) {
      unscannable.push({ file, reason: "blob-unreadable" });
      continue;
    }
    if (!isProbablyText(blob.stdout)) {
      unscannable.push({ file, reason: "binary-or-nul" });
      continue;
    }
    try {
      scanned.push({ file, text: new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout) });
    } catch {
      unscannable.push({ file, reason: "decode-failed" });
    }
  }
  return { scanned, unscannable };
}

function recordOverride(root: string, decision: GateDecision, at: string): void {
  mkdirSync(path.join(root, AUDIT_DIR), { recursive: true });
  // Metadata-only audit record — reason + locations, never a secret value.
  const byFile = new Map<string, GateFinding[]>();
  for (const f of decision.high) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const record = {
    time: at,
    reason: decision.reason,
    total_high: decision.high.length,
    files: [...byFile.entries()].map(([file, findings]) => ({
      file,
      findings: findings.map((x) => ({ line: x.line, column: x.column, detector: x.detector })),
    })),
  };
  appendFileSync(path.join(root, AUDIT_DIR, AUDIT_FILE), `${JSON.stringify(record)}\n`);
}

// An unscannable staged file is an ordinary input problem with an ordinary fix,
// not a trust boundary being rebuilt: the gate names the files it could not
// read and what to do about them. The JSON shape stays stable for callers.
export type UnscannableRefusal = {
  schema_version: "0.1";
  status: "refused";
  reason_code: "staged_file_unscannable";
  message: string;
  safe_next_action: string;
};

export const UNSCANNABLE_REFUSAL: UnscannableRefusal = Object.freeze({
  schema_version: "0.1",
  status: "refused",
  reason_code: "staged_file_unscannable",
  message: "Staged scanning could not verify every staged file.",
  safe_next_action: "Remove, replace, or convert each listed file to scannable UTF-8 text under 16 MiB, restage, and retry.",
});

export type RedactGateResult =
  | { output: string; exitCode: 0 | 1; unscannable: false }
  | { output: string; exitCode: 1; unscannable: true; refusal: UnscannableRefusal; files: UnscannableStagedFile[] };

function safeFilename(file: string): string {
  return safeJson(file);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0")}`);
}

function renderUnscannable(unscannable: UnscannableStagedFile[], machine: boolean): string {
  if (machine) return safeJson({ ...UNSCANNABLE_REFUSAL, unscannable });
  const files = unscannable.map(({ file, reason }) => `${safeFilename(file)} (${reason})`).join(", ");
  return `blocked — ${UNSCANNABLE_REFUSAL.message} ${files}. ${UNSCANNABLE_REFUSAL.safe_next_action}`;
}

export function runRedactGate(
  root: string,
  opts: { overrideReason?: string; at?: string; machine?: boolean; seams?: Partial<RedactGateGitSeams> } = {},
): RedactGateResult {
  const staged = readStaged(root, opts.seams);
  if (staged.unscannable.length > 0) {
    const machine = opts.machine ?? !process.stdout.isTTY;
    return {
      output: `${renderUnscannable(staged.unscannable, machine)}\n`,
      exitCode: 1,
      unscannable: true,
      refusal: UNSCANNABLE_REFUSAL,
      files: staged.unscannable,
    };
  }
  const allowlist = loadRepoAllowlist(root);
  const overrideReason = opts.overrideReason ?? process.env.FOO_REDACT_ALLOW;
  const decision = decideGate(staged.scanned, { allowlist, overrideReason });

  if (decision.blocked) {
    const lines = [
      "foo self gate — BLOCKED: high-confidence secret(s) in staged changes",
      "",
      ...decision.high.map((f) => `  ${f.file}:${f.line}:${f.column}  [high] ${f.detector}`),
      "",
      "Fix: redact before committing — `foo redact <file> --write` (review the diff), or remove the secret.",
      'Override (human, audited): FOO_REDACT_ALLOW="why this is safe" git commit ...',
      "Secret values are never shown or stored (R-007).",
      "",
    ];
    return { output: lines.join("\n"), exitCode: 1, unscannable: false };
  }

  if (decision.overridden) {
    recordOverride(root, decision, opts.at ?? new Date().toISOString());
    const lines = [
      `foo self gate — OVERRIDE: ${decision.high.length} high-confidence finding(s) bypassed`,
      `  reason: ${decision.reason}`,
      `  recorded to ${AUDIT_DIR}/${AUDIT_FILE} (metadata-only)`,
      ...decision.high.map((f) => `  ${f.file}:${f.line} [high] ${f.detector}`),
      "",
    ];
    return { output: lines.join("\n"), exitCode: 0, unscannable: false };
  }

  return { output: `foo self gate — ok: no high-confidence secrets in ${staged.scanned.length} staged file(s).\n`, exitCode: 0, unscannable: false };
}
