// first-move-two-facts: productfoo's first read should uncover a NON-OBVIOUS TENSION
// hidden in plain sight — two facts the repo already holds, pointing opposite
// directions — not a hygiene count ("you have 3 TODOs"). Design from the
// 2026-07-12 ideate (five blind pools converged): collide two facts, show the
// receipts, name it in the user's own words, and NEVER fabricate — a tension
// only fires when real git/filesystem signal grounds it; otherwise foo says so
// and falls back to the honest floor.
//
// Architecture: this gathers cheap, grounded signals only. The CLI can render a
// good-enough two-facts line deterministically (works in a bare terminal); a
// harness agent can enrich the phrasing. No LLM here.
import path from "node:path";
import { gitRunOrNull } from "./gitRun.js";

export type Tension = {
  id: string;
  // The two facts, in tension. Rendered stacked so the friction sits in the gap.
  factA: string;
  factB: string;
  // A question the user answers — a hypothesis, not a verdict (keeps foo honest
  // when it might be wrong about code the user knows better).
  ask: string;
  // A plain-language title for when this becomes a shaped spec.
  title: string;
  // The receipts — the concrete facts foo read, so the user can verify at a glance.
  evidence: string[];
  // high | medium — only high/medium tensions surface; low never fires (anti-slop).
  confidence: "high" | "medium";
};

const IGNORED_TOP = new Set(["node_modules", "dist", "build", "out", "vendor", "coverage", ".git", "docs", ".github", "examples", "specs"]);
const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i;
const SOURCE_RE = /\.(ts|tsx|js|jsx|py|go|rb|rs|java|kt|swift|php|cs|scala|c|cc|cpp|h|hpp|m|mm)$/i;

function git(root: string, args: string[]): string | null {
  return gitRunOrNull(args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
}

// A generic top-level container (src/, lib/, app/) isn't a meaningful "area" —
// everything's under it. Descend one level so the tension names the real room
// (src/payments) rather than the whole house (src).
const CONTAINER = new Set(["src", "lib", "app", "pkg", "packages", "internal", "cmd", "source", "sources", "components", "modules"]);
function topDir(file: string): string | null {
  const parts = file.split("/");
  if (parts.length < 2) return null; // a root-level file has no owning dir
  if (CONTAINER.has(parts[0]) && parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

// Churn × test-gap: the area you change most, held against whether anything
// tests it. Two facts the repo holds; the tension is that the busiest code is
// the least-covered. Universal (git only), cheap, low false-positive.
function churnVsTests(root: string): Tension | null {
  // Last 100 non-merge commits — robust for low-velocity repos where a date
  // window would be nearly empty.
  const raw = git(root, ["log", "-n", "100", "--no-merges", "--name-only", "--format=%x00%H"]);
  if (raw === null) return null;

  const commits = raw.split("\0").filter((c) => c.trim() !== "");
  const M = commits.length;
  if (M < 12) return null; // too little history to claim a pattern (anti-slop floor)

  const commitsTouchingDir = new Map<string, number>();
  for (const block of commits) {
    const files = block.split(/\r?\n/).slice(1).filter(Boolean);
    const dirs = new Set<string>();
    for (const f of files) {
      if (!SOURCE_RE.test(f) || TEST_RE.test(f)) continue;
      const d = topDir(f);
      if (d && !IGNORED_TOP.has(d)) dirs.add(d);
    }
    for (const d of dirs) commitsTouchingDir.set(d, (commitsTouchingDir.get(d) ?? 0) + 1);
  }
  if (commitsTouchingDir.size === 0) return null;

  const [busiest, count] = [...commitsTouchingDir.entries()].sort((a, b) => b[1] - a[1])[0];
  // Must be genuinely dominant, not just "an area that got touched".
  if (count < 5 || count < M * 0.2) return null;

  // Does any test reference the busiest dir? A test file under it, or one whose
  // path names it. (Path heuristic — never a coverage claim, just evidence.)
  const tracked = (git(root, ["ls-files"]) ?? "").split(/\r?\n/).filter(Boolean);
  const testFiles = tracked.filter((f) => TEST_RE.test(f));
  // The area may be "src/payments"; a test that covers it is one UNDER it, or one
  // whose path/name references the leaf ("payments") — match the leaf, not the path.
  const leaf = busiest.split("/").pop() ?? busiest;
  const covered = testFiles.some((t) => t.startsWith(`${busiest}/`) || t.toLowerCase().includes(leaf.toLowerCase()));
  if (covered) return null; // the busiest area IS tested — no tension here

  const noTestsAnywhere = testFiles.length === 0;
  return {
    id: "churn-vs-tests",
    factA: `You've changed ${busiest}/ in ${count} of your last ${M} commits — it's the busiest room in the house.`,
    factB: noTestsAnywhere ? `There isn't a test anywhere in the project.` : `Nothing in your test suite references ${busiest}/.`,
    ask: `Which of those two are you not comfortable with?`,
    title: `A safety net for ${busiest}/ — the code you change most, with no test under it`,
    evidence: [`${busiest}/ touched in ${count}/${M} recent commits`, noTestsAnywhere ? "no test files found in the repo" : `${testFiles.length} test file(s), none referencing ${busiest}/`],
    confidence: count >= M * 0.35 ? "high" : "medium",
  };
}

// Ordered by grounding strength. First non-null wins as the headline tension;
// the rest stay available as "also saw" (future). Only add detectors that are
// cheap, grounded, and low-false-positive — a wrong first-run insight is worse
// than a boring one.
const DETECTORS: Array<(root: string) => Tension | null> = [churnVsTests];

export function detectTensions(root: string): Tension[] {
  const found: Tension[] = [];
  for (const detect of DETECTORS) {
    try {
      const t = detect(root);
      if (t) found.push(t);
    } catch {
      // a detector that throws must never break the first read — skip it.
    }
  }
  // High-confidence first; a tension foo isn't sure of never leads.
  return found.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));
}
