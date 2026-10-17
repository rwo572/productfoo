// packet-grammar-v1 R-005: the commit-time grammar gate, a B2 spec-identity
// extension. Blocks a STAGED spec.md whose anchors are duplicated or
// malformed; everything else the lint can say (missing IDs, unparsed
// candidates) stays advisory in `asp validate` and never gates.
//
// Fail direction copies the redact gate's split (guard-redaction.sh): any
// plumbing failure — git missing, blob unreadable, a bug in the linter —
// exits 0 with a note, because a broken gate must not brick every commit
// (V-006); the detection decision itself is fail-closed. It lints staged
// blobs (`git show :<path>`), never the working tree, so half-staged edits
// are judged only on what is actually being committed.
//
// One channel, said plainly: a pre-commit terminal has no separate agent/user
// surface, so the denial carries both halves — one calm line of what
// happened, then the exact fix and the override.

import { gitRun, gitRunBuffer } from "./gitRun.js";
import { lintAnchors, type GrammarFinding } from "./specSections.js";

export type StagedSpec = { file: string; text: string };

const BLOCKING = new Set(["grammar.duplicate_id", "grammar.malformed_id"]);

// Pure decision, side-effect-free: which staged specs carry blocking findings.
export function decideGrammarGate(staged: StagedSpec[]): Array<{ file: string; finding: GrammarFinding }> {
  const blocked: Array<{ file: string; finding: GrammarFinding }> = [];
  for (const s of staged) {
    for (const finding of lintAnchors(s.text)) {
      if (BLOCKING.has(finding.code)) blocked.push({ file: s.file, finding });
    }
  }
  return blocked;
}

const SPEC_PATH_RE = /^specs\/[^/]+\/spec\.md$/;

export function runGrammarGate(root: string): { output: string; exitCode: number } {
  try {
    if (process.env.FOO_ALLOW_GRAMMAR === "1") {
      return { output: "foo grammar gate — OVERRIDE: FOO_ALLOW_GRAMMAR=1, staged spec.md anchors not checked.\n", exitCode: 0 };
    }
    const listed = gitRun(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], { cwd: root });
    if (!listed.ok) {
      return { output: "foo grammar gate — skipped: git unavailable, cannot read staged content (fail-open).\n", exitCode: 0 };
    }
    const names = listed.stdout.split("\0").filter((n) => SPEC_PATH_RE.test(n));
    if (names.length === 0) return { output: "", exitCode: 0 };

    const staged: StagedSpec[] = [];
    for (const file of names) {
      const blob = gitRunBuffer(["show", `:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      if (!blob.ok) continue; // unreadable staged blob — fail-open, skip
      staged.push({ file, text: blob.stdout.toString("utf8") });
    }

    const blocked = decideGrammarGate(staged);
    if (blocked.length === 0) {
      return { output: `foo grammar gate — ok: ${staged.length} staged spec.md file(s) well-anchored.\n`, exitCode: 0 };
    }

    const byPacket = new Set(blocked.map((b) => b.file.split("/").slice(0, 2).join("/")));
    const lines = [
      "foo grammar gate — BLOCKED: a staged spec has ambiguous anchors (B2 spec identity).",
      "",
      ...blocked.map((b) => `  ${b.file}:${b.finding.line}  ${b.finding.code} — ${b.finding.detail}`),
      "",
      "Canonical form: `### R-001 Title` headings, `- V-001 — text` bullets.",
      ...[...byPacket].map((p) => `Fix (one paste): foo asp migrate ${p}   — or edit the line named above.`),
      'Override (deliberate): FOO_ALLOW_GRAMMAR=1 git commit ...',
      "",
    ];
    return { output: lines.join("\n"), exitCode: 1 };
  } catch (error) {
    // A bug in the linter must not brick every spec commit (R-005, V-006).
    const msg = error instanceof Error ? error.message : String(error);
    return { output: `foo grammar gate — skipped: internal error (fail-open): ${msg}\n`, exitCode: 0 };
  }
}
