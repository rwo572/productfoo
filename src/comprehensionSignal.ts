// comprehension-loop-v0 — the comprehension scoreboard and the shipped-surface
// jargon lint. Both are SIGNALS, never gates (R-004): nothing here blocks,
// rewrites, or judges output with a model. The scoreboard records when the
// human had to ask for a translation; the lint reports foo-internal vocabulary
// on the surfaces that ship to a customer's agent context (commands/, skills/).
//
// Boundary, stated where a builder will read it (T-005): comprehension is a
// signal. Do not add a runtime gate that blocks or rewrites output based on a
// model's judgment of whether a human understood — that gates on fluency, the
// exact property that made the bad messages dangerous, and it retypes a
// surface that produced zero of the nineteen observed complaints. If you are
// tempted, read specs/comprehension-loop-v0/spec.md R-004 and D-001 first.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PM_SURFACE_FORBIDDEN } from "./initCommand.js";

// --- the translation-request detector (R-001) --------------------------------

// Deterministic, no model call. Each pattern names the complaint shape it
// catches; precision is measured against evals/comprehension/, never asserted.
// Token boundaries are (?<![\w-]) / (?![\w-]) — the researchGate lesson: a
// substring test is how `cite` once matched "excited".
const MISS_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "in-english", re: /(?<![\w-])in (?:plain )?english(?![\w-])/i },
  { name: "plain-english", re: /(?<![\w-])plain english(?![\w-])/i },
  { name: "what-does-that-mean", re: /(?<![\w-])what does (?:that|this|it) mean(?![\w-])/i },
  { name: "translate-that", re: /(?<![\w-])translate (?:that|this|it)(?![\w-])/i },
  { name: "dont-understand", re: /(?<![\w-])(?:i )?don'?t understand what(?![\w-])/i },
];

export interface TurnClassification {
  miss: boolean;
  matched: string | null;
}

export function classifyTurn(text: string): TurnClassification {
  for (const p of MISS_PATTERNS) {
    if (p.re.test(text)) return { miss: true, matched: p.name };
  }
  return { miss: false, matched: null };
}

// --- the local scoreboard (D-003: this machine only, no rewrite authority) ---

const EVENTS_DIR = path.join(".foo", "comprehension");
const EVENTS_FILE = "events.jsonl";

export function observeTurn(root: string, turnText: string, at = new Date().toISOString()): TurnClassification {
  const result = classifyTurn(turnText);
  const dir = path.join(root, EVENTS_DIR);
  mkdirSync(dir, { recursive: true });
  const event: Record<string, unknown> = {
    schema_version: "0.1",
    type: result.miss ? "comprehension_miss" : "turn_observed",
    at,
  };
  if (result.miss) {
    event.matched = result.matched;
    // Enough of the turn to audit a false positive later; local-only (.foo/ is
    // gitignored) and never shipped anywhere.
    event.excerpt = turnText.slice(0, 160);
  }
  appendFileSync(path.join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
  return result;
}

export interface MissRate {
  turns: number;
  misses: number;
  rate: number | null; // null when no turns observed yet
}

export function missRate(root: string): MissRate {
  const file = path.join(root, EVENTS_DIR, EVENTS_FILE);
  if (!existsSync(file)) return { turns: 0, misses: 0, rate: null };
  let turns = 0;
  let misses = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "comprehension_miss") {
        turns += 1;
        misses += 1;
      } else if (event.type === "turn_observed") {
        turns += 1;
      }
    } catch {
      // A corrupt line is a log problem, not a reason to fail the scoreboard.
    }
  }
  return { turns, misses, rate: turns === 0 ? null : misses / turns };
}

// --- the shipped-surface jargon lint (R-002; a signal, never a block) --------

// Legitimate internal uses go here, narrowest scope that works: a relative
// path prefix plus the term it may use. Keep this list short and honest — an
// allowlist that grows faster than the fixes is the lint being ignored.
const LINT_ALLOWLIST: ReadonlyArray<{ pathPrefix: string; term: string }> = [];

const LINT_ROOTS = ["commands", "skills"];

export interface LintFinding {
  file: string;
  term: string;
  line: number;
  text: string;
}

function lintFile(root: string, rel: string, findings: LintFinding[]): void {
  const text = readFileSync(path.join(root, rel), "utf8");
  const lines = text.split("\n");
  for (const term of PM_SURFACE_FORBIDDEN) {
    if (LINT_ALLOWLIST.some((a) => rel.startsWith(a.pathPrefix) && a.term === term)) continue;
    const re = new RegExp(`(?<![\\w-])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        findings.push({ file: rel, term, line: i + 1, text: lines[i].trim().slice(0, 120) });
        break; // one finding per (file, term) keeps the signal readable
      }
    }
  }
}

function walk(root: string, rel: string, acc: string[]): void {
  const full = path.join(root, rel);
  if (!existsSync(full)) return;
  // lstat, never stat: skills/ carries adapter symlinks (.codex/ links back
  // into the repo) and following them walks a loop forever. Dot-entries are
  // adapter surfaces, not canonical shipped files — skip both.
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (rel.endsWith(".md")) acc.push(rel);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(full).sort()) {
    if (entry.startsWith(".")) continue;
    walk(root, path.join(rel, entry), acc);
  }
}

// comprehension-loop-v0 R-004 — the boundary, written where the next person to
// extend this lint will read it. Comprehension is a SIGNAL, never a gate. Do not
// give it a blocking verdict path and do not add a model-judged
// "did the human understand?" chokepoint: that gates on fluency, which is the exact
// property that made the observed bad messages dangerous. Signals over gates —
// a lint that blocks at this detector's precision is switched off within a week,
// and a signal that keeps its audience beats a gate that loses it.
export function lintShippedSurfaces(root: string): LintFinding[] {
  const files: string[] = [];
  for (const dir of LINT_ROOTS) walk(root, dir, files);
  const findings: LintFinding[] = [];
  for (const rel of files) lintFile(root, rel, findings);
  return findings;
}

const LINT_DETAIL_CAP = 20;

export function renderLint(findings: LintFinding[]): string {
  if (findings.length === 0) return "shipped surfaces carry no flagged internal vocabulary\n";
  // A 3,000-line dump is noise wearing a signal's clothes — summarize by file,
  // show the worst offenders in detail, and NAME what was dropped (no silent
  // caps): the full list stays one --json away.
  const byFile = new Map<string, number>();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  const worst = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `signal: ${findings.length} internal-vocabulary use(s) across ${byFile.size} shipped file(s) (commands/, skills/) — advisory, never a build failure.`,
    `Worst files first:`,
  ];
  for (const [file, count] of worst.slice(0, 10)) lines.push(`  ${file} — ${count} term(s)`);
  lines.push(`First ${Math.min(LINT_DETAIL_CAP, findings.length)} finding(s) in detail:`);
  for (const f of findings.slice(0, LINT_DETAIL_CAP)) lines.push(`  ${f.file}:${f.line} says "${f.term}" — ${f.text}`);
  if (findings.length > LINT_DETAIL_CAP) {
    lines.push(`  …and ${findings.length - LINT_DETAIL_CAP} more — run \`foo comprehension lint --json\` for the full list.`);
  }
  lines.push("Fix by saying it in the reader's words, or add the narrowest allowlist entry with a reason.");
  return `${lines.join("\n")}\n`;
}
