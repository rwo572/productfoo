import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import path from "node:path";
import { parseAllowlist, redactText, scanText, type RedactionReceipt, type RedactThreshold, type ScanResult } from "../redactEngine.js";
// Argument validation throws UsageError, never a bare Error: a mistyped flag is a
// typo, and a bare Error classifies as command_error — which pages and files a Bug
// Capsule. See src/errorTaxonomy.ts.
import { UsageError } from "../errorTaxonomy.js";

// --- foo scan (prompt_redaction_safety_v0 T-001) -----------------------------
// Thin IO wrapper over the pure redactEngine: walk files/dirs/stdin, scan each,
// print metadata-only findings. The engine never returns secret values (R-007).

const SCAN_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".worktrees"]);

// Crude binary guard: a NUL byte in the first chunk means skip (not text).
function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

type ScanSkipReason = "binary" | "unreadable" | "broken-symlink" | "symlinked-directory" | "symlinked-special";
type ScanSkip = { file: string; reason: ScanSkipReason };

// A path the walk declines to scan is surfaced, never silently dropped.
function skipScanTarget(target: string, skipped: ScanSkip[], reason: ScanSkipReason): void {
  skipped.push({ file: path.relative(process.cwd(), target) || target, reason });
}

function collectScanTargets(target: string, acc: string[], skipped: ScanSkip[]): void {
  const stat = lstatSync(target);
  // lstat sees a symlink as neither file nor directory, which is how #777
  // silently dropped linked files — a secret-detection blindspot. Resolve one
  // hop with statSync so the real file gets scanned; an unresolvable link
  // (dangling, looped) surfaces as a broken-symlink skip. Links to directories
  // are not followed (a cycle would not terminate) and special files (fifo,
  // socket) cannot be read as text — both surface as skips so the contract at
  // the skipped list below holds for every path the walk visits.
  if (stat.isSymbolicLink()) {
    let resolved: Stats;
    try {
      resolved = statSync(target);
    } catch {
      skipScanTarget(target, skipped, "broken-symlink");
      return;
    }
    if (resolved.isFile()) acc.push(target);
    else skipScanTarget(target, skipped, resolved.isDirectory() ? "symlinked-directory" : "symlinked-special");
    return;
  }
  if (stat.isDirectory()) {
    if (SCAN_SKIP_DIRS.has(path.basename(target))) return;
    for (const entry of readdirSync(target).sort()) collectScanTargets(path.join(target, entry), acc, skipped);
  } else if (stat.isFile()) {
    acc.push(target);
  }
}

type ScanFileResult = { file: string; result: ScanResult };

export function runScanCommand(args: string[]): { output: string; exitCode: number } {
  const json = args.includes("--json");
  const exitOnFindings = args.includes("--exit-code");
  let minEntropyLen = 20;
  let profiles: string[] | undefined;
  const allowlist: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--exit-code") continue;
    if (arg === "--profile") {
      const value = args[++i];
      if (value) profiles = value.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--allow") {
      const file = args[++i];
      if (!file) throw new UsageError("--allow needs a file path", "E_BAD_FLAG");
      allowlist.push(...parseAllowlist(readFileSync(path.resolve(process.cwd(), file), "utf8")));
      continue;
    }
    if (arg === "--min-entropy-len") {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) minEntropyLen = n;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`unknown scan flag: ${arg}`, "E_BAD_FLAG");
    positionals.push(arg);
  }

  const opts = { allowlist, minEntropyLen, profiles };
  const results: ScanFileResult[] = [];

  const targets = positionals.filter((p) => p !== "-");
  const wantStdin = positionals.includes("-") || (positionals.length === 0 && !process.stdin.isTTY);
  if (positionals.length === 0 && process.stdin.isTTY) {
    throw new UsageError("scan target missing: pass a file, a directory, or - for stdin", "E_BAD_FLAG");
  }
  if (wantStdin) results.push({ file: "<stdin>", result: scanText(readFileSync(0, "utf8"), opts) });

  const files: string[] = [];
  const skipped: ScanSkip[] = [];
  for (const p of targets) {
    const resolved = path.resolve(process.cwd(), p);
    if (!existsSync(resolved)) throw new Error(`scan target not found: ${p}`);
    collectScanTargets(resolved, files, skipped);
  }
  // A skipped file is surfaced, never silently dropped: an unscanned path is a
  // coverage gap the caller must be able to see (blindspot: NUL-early binaries).
  for (const file of files.sort()) {
    const rel = path.relative(process.cwd(), file) || file;
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      skipped.push({ file: rel, reason: "unreadable" });
      continue;
    }
    if (!isProbablyText(buf)) {
      skipped.push({ file: rel, reason: "binary" });
      continue;
    }
    results.push({ file: rel, result: scanText(buf.toString("utf8"), opts) });
  }

  const totals = { high: 0, medium: 0, low: 0, total: 0 };
  for (const r of results) {
    totals.high += r.result.counts.high;
    totals.medium += r.result.counts.medium;
    totals.low += r.result.counts.low;
    totals.total += r.result.counts.total;
  }
  // Pure reporting by default (exit 0). --exit-code makes high-confidence
  // findings non-zero for scripting; the blocking gate proper is T-003.
  const exitCode = exitOnFindings && totals.high > 0 ? 2 : 0;

  if (json) {
    const payload = { schema_version: "0.1", scanned: results.length, skipped, totals, results };
    return { output: `${JSON.stringify(payload, null, 2)}\n`, exitCode };
  }

  const lines: string[] = ["foo scan", ""];
  const withFindings = results.filter((r) => r.result.findings.length > 0);
  if (withFindings.length === 0) {
    lines.push(`  no secrets detected across ${results.length} file(s).`);
  } else {
    for (const r of withFindings) {
      lines.push(r.file);
      for (const f of r.result.findings) {
        const ent = f.entropy !== undefined ? ` entropy=${f.entropy}` : "";
        lines.push(`  ${f.line}:${f.column}  [${f.confidence}] ${f.detector} (len ${f.length})${ent}`);
      }
      lines.push("");
    }
  }
  lines.push(
    `Totals: ${totals.high} high · ${totals.medium} medium · ${totals.low} low (${totals.total} findings, ${results.length} file(s))`,
  );
  if (skipped.length > 0) {
    lines.push(`Skipped (not scanned): ${skipped.length} file(s)`);
    for (const s of skipped) lines.push(`  ${s.file} — ${s.reason}`);
  }
  lines.push("Note: scan reports; the fail-closed commit gate (T-003) decides what blocks. Secret values are never shown (R-007).");
  lines.push("");
  return { output: lines.join("\n"), exitCode };
}

// --- foo redact (prompt_redaction_safety_v0 T-002) ---------------------------
// Replace detected secrets with consistent, irreversible placeholders and emit
// a metadata-only receipt (R-002, R-003). Default prints redacted output to
// stdout (non-mutating); --write overwrites the file (explicit), --dry-run
// previews the receipt and changed lines without writing.

function renderRedactionReceipt(receipt: RedactionReceipt): string[] {
  const lines: string[] = [
    `Redactions: ${receipt.redactions}  (${receipt.by_confidence.high} high · ${receipt.by_confidence.medium} medium · ${receipt.by_confidence.low} low)`,
  ];
  const types = Object.keys(receipt.by_type).sort();
  if (types.length) lines.push(`  by type: ${types.map((t) => `${t}=${receipt.by_type[t]}`).join(", ")}`);
  if (receipt.placeholders.length) lines.push(`  placeholders: ${receipt.placeholders.join(", ")}`);
  if (receipt.kept.length) {
    lines.push(`  kept for review (below threshold): ${receipt.kept.length}`);
    for (const k of receipt.kept) lines.push(`    ${k.line}:${k.column} ${k.detector} [${k.confidence}] — ${k.reason}`);
  }
  return lines;
}

export function runRedactCommand(args: string[]): { output: string; exitCode: number } {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  let threshold: RedactThreshold = "medium";
  if (args.includes("--high-only")) threshold = "high";
  if (args.includes("--include-low")) threshold = "low";
  let minEntropyLen = 20;
  let profiles: string[] | undefined;
  const allowlist: string[] = [];
  const positionals: string[] = [];
  const flags = new Set(["--json", "--dry-run", "--write", "--high-only", "--include-low"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) continue;
    if (arg === "--profile") {
      const value = args[++i];
      if (value) profiles = value.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--allow") {
      const file = args[++i];
      if (!file) throw new UsageError("--allow needs a file path", "E_BAD_FLAG");
      allowlist.push(...parseAllowlist(readFileSync(path.resolve(process.cwd(), file), "utf8")));
      continue;
    }
    if (arg === "--min-entropy-len") {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) minEntropyLen = n;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`unknown redact flag: ${arg}`, "E_BAD_FLAG");
    positionals.push(arg);
  }
  if (positionals.length > 1) throw new UsageError("redact accepts one file or - for stdin", "E_BAD_FLAG");
  const target = positionals[0];
  const fromStdin = !target || target === "-";
  if (write && fromStdin) throw new UsageError("--write needs a file target (not stdin)", "E_BAD_FLAG");
  if (!target && process.stdin.isTTY) throw new UsageError("redact target missing: pass a file or - for stdin", "E_BAD_FLAG");

  const inputPath = fromStdin ? null : path.resolve(process.cwd(), target as string);
  if (inputPath && !existsSync(inputPath)) throw new Error(`redact target not found: ${target}`);
  const text = fromStdin ? readFileSync(0, "utf8") : readFileSync(inputPath as string, "utf8");

  const { redactedText, receipt } = redactText(text, { allowlist, minEntropyLen, threshold, profiles });

  if (json) {
    return { output: `${JSON.stringify({ schema_version: "0.1", receipt, redactedText }, null, 2)}\n`, exitCode: 0 };
  }

  if (dryRun) {
    const origLines = text.split("\n");
    const redLines = redactedText.split("\n");
    const changed: string[] = [];
    for (let i = 0; i < redLines.length; i++) {
      if (origLines[i] !== redLines[i]) changed.push(`  ${i + 1}: ${redLines[i]}`);
    }
    const lines = ["foo redact --dry-run", "", ...renderRedactionReceipt(receipt), ""];
    if (changed.length) lines.push("Preview (redacted lines — secret values already removed):", ...changed, "");
    lines.push("(--dry-run: no output emitted, no file written. Drop --dry-run to emit; add --write to overwrite the file.)");
    lines.push("");
    return { output: lines.join("\n"), exitCode: 0 };
  }

  if (write && inputPath) {
    writeFileSync(inputPath, redactedText);
    const rel = path.relative(process.cwd(), inputPath) || (target as string);
    return { output: [`foo redact — wrote ${rel}`, "", ...renderRedactionReceipt(receipt), ""].join("\n"), exitCode: 0 };
  }

  // Default: emit redacted content to stdout (non-mutating).
  return { output: redactedText, exitCode: 0 };
}
