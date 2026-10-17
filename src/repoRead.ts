import { gitRunOrNull } from "./gitRun.js";
import type { Tension } from "./firstMoveTensions.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// foo init's deterministic repo read. It gathers only safe, tracked signals and
// turns them into candidate first moves. Every move is gated on a concrete repo
// fact, so a move is never shown without evidence — that is the guardrail
// against fake precision. When a runtime agent is present it composes sharper
// options from the same signals (see the agent contract in initCommand.ts); the
// deterministic moves here are the standalone floor.

export type RepoSignals = {
  languages: string[];
  hasTests: boolean;
  hasCI: boolean;
  readmeBytes: number;
  bigFile: { path: string; lines: number } | null;
  sourceFileCount: number;
};

export type Move = {
  id: string;
  // Plain-language title — the user's words, not productfoo's.
  title: string;
  // Concrete repo facts that justify showing this move at all.
  evidence: string[];
  // Heuristic scores (1 low – 3 high) used only to rank and to phrase the
  // comparative "why this, not the others".
  risk: number;
  leverage: number;
  effort: number;
  // first-move-two-facts: when present, this move is a TENSION (two facts the
  // repo already holds, in conflict) and renders as the headline first move —
  // above any hygiene chore. Absent = an ordinary hygiene move.
  tension?: Tension;
};

function git(root: string, args: string[]): string | null {
  return gitRunOrNull(args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
}

// Tracked files only — never walks untracked or ignored paths, so secrets and
// build output stay unread.
function trackedFiles(root: string): string[] {
  const out = git(root, ["ls-files"]);
  if (out !== null) return out.split(/\r?\n/).filter((l) => l.trim() !== "");
  // Non-git fallback: a shallow read of the top level only.
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".java": "Java",
};

const SOURCE_EXTS = new Set(Object.keys(LANG_BY_EXT));

// Skip vendored, pinned, generated, or minified paths — they are not the
// developer's own code and would make the read point at noise (e.g. a pinned
// helper bundle or a 10k-line minified file).
function isVendored(file: string): boolean {
  if (file.startsWith(".")) return true; // .agents/, .github/, dotfiles
  if (/(^|\/)(vendor|third_party|node_modules|dist|build|generated)(\/|$)/.test(file)) return true;
  if (/\.min\.[a-z]+$/.test(file)) return true;
  return false;
}

function isTestPath(file: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(file) || /\.(test|spec)\.[a-z]+$/i.test(file);
}

function countLines(root: string, file: string): number {
  try {
    return readFileSync(path.join(root, file), "utf8").split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

export function gatherRepoSignals(root: string): RepoSignals {
  const files = trackedFiles(root);

  const langCounts = new Map<string, number>();
  let sourceFileCount = 0;
  let hasTests = false;
  let bigFile: RepoSignals["bigFile"] = null;

  for (const file of files) {
    if (isVendored(file)) continue;
    const ext = path.extname(file);
    if (SOURCE_EXTS.has(ext)) {
      sourceFileCount += 1;
      const lang = LANG_BY_EXT[ext];
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      if (isTestPath(file)) hasTests = true;
    }
  }

  // Largest tracked source file (a documentation / decomposition candidate).
  for (const file of files) {
    if (isVendored(file) || !SOURCE_EXTS.has(path.extname(file)) || isTestPath(file)) continue;
    const lines = countLines(root, file);
    if (!bigFile || lines > bigFile.lines) bigFile = { path: file, lines };
  }

  const readmePath = ["README.md", "README", "readme.md"].map((r) => path.join(root, r)).find(existsSync);
  const readmeBytes = readmePath ? statSync(readmePath).size : 0;

  const languages = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);

  return {
    languages,
    hasTests,
    hasCI: existsSync(path.join(root, ".github", "workflows")),
    readmeBytes,
    bigFile,
    sourceFileCount,
  };
}

// Generate candidate moves, each gated on a concrete fact. Order here is the
// pre-ranking; scoreMoves decides the recommendation.
export function generateMoves(signals: RepoSignals): Move[] {
  const moves: Move[] = [];

  if (signals.sourceFileCount > 0 && !signals.hasTests) {
    moves.push({
      id: "add-tests",
      title: "Add a test safety net",
      evidence: [`${signals.sourceFileCount} source file(s) and no tests found`],
      risk: 3,
      leverage: 3,
      effort: 2,
    });
  }

  if (!signals.hasCI && signals.sourceFileCount > 0) {
    moves.push({
      id: "add-ci",
      title: "Set up CI so changes get checked automatically",
      evidence: ["no .github/workflows — nothing runs on push"],
      risk: 2,
      leverage: 2,
      effort: 1,
    });
  }

  if (signals.readmeBytes < 400) {
    moves.push({
      id: "write-readme",
      title: signals.readmeBytes === 0 ? "Write a README" : "Expand the thin README",
      evidence: [signals.readmeBytes === 0 ? "no README found" : `README is only ${signals.readmeBytes} bytes`],
      risk: 1,
      leverage: 1,
      effort: 1,
    });
  }

  if (signals.bigFile && signals.bigFile.lines > 600) {
    moves.push({
      id: "tame-big-file",
      title: `Break up ${signals.bigFile.path}`,
      evidence: [`${signals.bigFile.path} is ${signals.bigFile.lines} lines — hard to change safely`],
      risk: 2,
      leverage: 2,
      effort: 3,
    });
  }

  return moves;
}

function score(move: Move): number {
  // Favor high risk + high leverage, discount effort. Risk and leverage matter
  // more than effort, so a risky-but-pricey fix can still win.
  return move.risk * 2 + move.leverage * 2 - move.effort;
}

export type RankedMoves = {
  recommended: Move | null;
  rest: Move[];
  // A comparative, fact-grounded reason the top move beats the runner-up.
  why: string | null;
};

export function rankMoves(moves: Move[]): RankedMoves {
  const sorted = [...moves].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const recommended = sorted[0] ?? null;
  const rest = sorted.slice(1);
  // The why adds comparative reasoning — it does not restate the evidence line
  // shown above it. Grounded in the ranking: top wins on leverage-per-effort.
  let why: string | null = null;
  if (recommended) {
    why = rest.length
      ? "it's the most leverage for the least effort of the options here, so the rest can wait"
      : "it's the highest-leverage thing to settle before anything else";
  }
  return { recommended, rest, why };
}
