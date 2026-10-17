import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";

// foo detect — the deterministic, no-LLM "product slop" linter.
//
// Impeccable made design quality demoable with 44 deterministic detector rules
// that catch AI design tells (gradient text, purple palettes, bounce easing)
// with zero model calls. foo detect is the product-management analogue: it
// reads spec packets and flags the *product* tells — confidence theater, claims
// with no proof, quantified claims with no source, vibe words, placeholders —
// the things that make a spec read as authoritative while hiding that the work
// is unproven.
//
// Deliberate divergence from Impeccable (signals_over_gates_v0): Impeccable's
// `detect` exits non-zero by default. productfoo surfaces by default (exit 0) and only
// blocks when asked (`--exit-code`), because a slop finding is a *signal* for
// judgment, not a boundary. The two real boundaries (B1 safety, B2 spec
// identity) stay in `foo self check`. detect never blocks a commit on its own.

export type DetectSeverity = "error" | "warn";

export type DetectCategory =
  | "confidence-theater"
  | "proof-gap"
  | "evidence-gap"
  | "acceptance-gap"
  | "scope-drift"
  | "jargon";

export type Finding = {
  rule: string;
  category: DetectCategory;
  severity: DetectSeverity;
  file: string;
  line: number;
  message: string;
  snippet: string;
};

export type DetectResult = {
  scanned: string[];
  findings: Finding[];
  counts: { error: number; warn: number; total: number };
};

type ProseRule = {
  id: string;
  category: DetectCategory;
  severity: DetectSeverity;
  pattern: RegExp;
  message: string;
};

// Prose rules run line-by-line over spec.md (and any scanned .md). Patterns are
// case-insensitive and word-bounded so they fire on the tell, not on substrings.
const PROSE_RULES: ProseRule[] = [
  {
    id: "CT-001",
    category: "confidence-theater",
    severity: "error",
    pattern:
      /\b(100%\s+(?:reliable|accurate|safe)|guaranteed|never fails?|zero risk|fully solved|completely eliminat\w*|bullet-?proof|fool-?proof|always works)\b/i,
    message: "absolute-certainty claim — a spec states a probability, not a guarantee; bound it with proof.",
  },
  {
    id: "CT-002",
    category: "confidence-theater",
    severity: "warn",
    pattern:
      /\b(world-?class|best-?in-?class|cutting-?edge|state-of-the-art|revolutionary|game-?chang\w*|seamless\w*|magical|delightful|frictionless|blazing(?:ly)?|next-?gen\w*)\b/i,
    message: "marketing adjective in a spec — describe the behavior and its proof, not the vibe.",
  },
  {
    id: "CT-003",
    category: "confidence-theater",
    severity: "warn",
    pattern: /\b(just works|obviously|clearly|simply put|it'?s trivial|no-brainer|of course)\b/i,
    message: "hand-wave — 'obvious/just works' hides an unstated assumption; name it.",
  },
  {
    id: "EG-001",
    category: "evidence-gap",
    severity: "warn",
    // Weasel attributions: a claim leaning on an unnamed authority.
    pattern:
      /\b(studies show|research shows|experts? (?:say|agree)|everyone knows|it'?s well[- ]known|users? (?:want|love|hate|expect)|the data shows)\b/i,
    message: "unsourced authority — attribute the claim to a named source (link, R-id, or evidence ref).",
  },
  {
    id: "SD-001",
    category: "scope-drift",
    severity: "warn",
    // Case-sensitive: the leftover-marker convention is uppercase. This avoids
    // flagging specs that legitimately discuss the lowercase task statuses
    // ("todo", "doing") or the concept word "placeholder".
    pattern: /(\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b|\?\?\?)/,
    message: "unresolved leftover marker in a committed spec — resolve or move to scratch.",
  },
  {
    id: "SD-002",
    category: "scope-drift",
    severity: "warn",
    pattern: /\b(lorem ipsum|fill in later|to be written|coming soon)\b/i,
    message: "unfinished filler in a committed spec — write it or move it to scratch.",
  },
];

// A quantified claim (40%, 2x, 3.5 points) carries authority; on its own line it
// should sit next to a source. These markers count as "sourced enough".
const QUANT_CLAIM = /(?<![\w.])(\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?x\b|\d+(?:\.\d+)?\s?(?:ms|x faster|x fewer|points?|percent)\b)/i;
const SOURCE_MARKER = /(https?:\/\/|source:|evidence|\bref\b|cite|\[\d+\]|§|\bR-\d+\b|\bC-\d+\b|footnote|per\s)/i;

// JN-001 (jargon-supply-chain-v0 R-003): foo-internal vocabulary on a SHIPPED
// surface — commands/ and skills/ prose gets pulled into the customer's agent's
// context and relayed into their chat, so jargon here reaches a customer, not a
// contributor. The list is the same one the PM surface bans (single source of
// truth); the match is case-insensitive (the old check was beaten by the Shift
// key) and token-bounded with the B5 lesson applied — `(?<![\w-])`, not `\b`,
// because a hyphen joins a compound word rather than starting a new one.
// Signal only: JN findings are warns, and detect never blocks on its own.
const SHIPPED_SURFACE = /^(commands|skills)\//;
// Canonical banned-word list. The PM surface (initCommand.ts) re-exports this
// as PM_SURFACE_FORBIDDEN — one list, two consumers, no drift.
export const JARGON_TERMS = ["packet", "asp", "spec_id", "tasks.yaml", "events.jsonl", "done_when", "reconcile", "loop contract"] as const;
const JARGON_PATTERN = new RegExp(
  `(?<![\\w-])(${JARGON_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`,
  "i",
);

// A command invocation must name the command (`foo asp validate` cannot avoid
// "asp"), so inline code spans don't count as prose jargon. Blank the span
// content, keep length, so match indexes still point at the real line.
function blankInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => "`".padEnd(m.length - 1, " ") + "`");
}

function isFrontmatterFence(line: string): boolean {
  return line.trim() === "---";
}

// Scan markdown prose. Skips YAML frontmatter and fenced code blocks so a code
// sample that contains "TODO" or a URL-less number does not trip a rule.
function scanProse(rel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let inCodeFence = false;
  let inFrontmatter = false;
  let frontmatterClosed = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Frontmatter: only the leading block, only at file start.
    if (i === 0 && isFrontmatterFence(raw)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (isFrontmatterFence(raw)) {
        inFrontmatter = false;
        frontmatterClosed = true;
      }
      continue;
    }
    void frontmatterClosed;

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    // HTML comments are spec scaffolding, not committed product claims.
    if (trimmed.startsWith("<!--")) continue;

    const lineNo = i + 1;

    // Jargon fires only on shipped surfaces; a spec is allowed its own words.
    if (SHIPPED_SURFACE.test(rel)) {
      const prose = blankInlineCode(raw);
      const jargonMatch = JARGON_PATTERN.exec(prose);
      if (jargonMatch) {
        findings.push({
          rule: "JN-001",
          category: "jargon",
          severity: "warn",
          file: rel,
          line: lineNo,
          message: "foo-internal vocabulary on a shipped surface — this prose reaches the customer's chat; use the plain word.",
          snippet: snippetAround(raw, jargonMatch.index),
        });
      }
    }

    for (const rule of PROSE_RULES) {
      const match = rule.pattern.exec(raw);
      if (match) {
        findings.push({
          rule: rule.id,
          category: rule.category,
          severity: rule.severity,
          file: rel,
          line: lineNo,
          message: rule.message,
          snippet: snippetAround(raw, match.index),
        });
      }
    }

    // EG-002: quantified claim with no nearby source marker (this line or the
    // line before/after, to allow a citation on the next line).
    if (QUANT_CLAIM.test(raw)) {
      const context = `${lines[i - 1] ?? ""}\n${raw}\n${lines[i + 1] ?? ""}`;
      if (!SOURCE_MARKER.test(context)) {
        const m = QUANT_CLAIM.exec(raw);
        findings.push({
          rule: "EG-002",
          category: "evidence-gap",
          severity: "warn",
          file: rel,
          line: lineNo,
          message: "quantified claim with no source — put a link, R-id, or evidence ref beside the number.",
          snippet: snippetAround(raw, m ? m.index : 0),
        });
      }
    }
  }

  // AG-001: a spec.md with no acceptance surface at all. Shipped command docs
  // are exempt — commands/spec.md is the /foo:spec command's doc, not a spec.
  if (path.basename(rel) === "spec.md" && !SHIPPED_SURFACE.test(rel)) {
    const hasAcceptance = /(##\s*(acceptance|done[- ]when|validation|success)|done_when|acceptance criteria)/i.test(text);
    if (!hasAcceptance) {
      findings.push({
        rule: "AG-001",
        category: "acceptance-gap",
        severity: "error",
        file: rel,
        line: 1,
        message: "no acceptance/validation surface — a spec without a testable 'done' is a wish, not a contract.",
        snippet: "(whole file)",
      });
    }
  }

  return findings;
}

function snippetAround(line: string, index: number): string {
  const start = Math.max(0, index - 12);
  const end = Math.min(line.length, index + 48);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

type TaskNode = {
  id?: unknown;
  status?: unknown;
  proof?: unknown;
  done_when?: unknown;
  completed?: { proof?: unknown } | unknown;
};

type DoneWhenCriterion = { id?: unknown; text?: unknown; done?: unknown; proof?: unknown };

/** #884: done_when as criteria. A string is one unproven criterion; an array
 *  keeps its object entries; anything else is no criteria. */
function doneWhenCriteria(value: unknown): DoneWhenCriterion[] {
  if (typeof value === "string") return value.trim() ? [{ text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is DoneWhenCriterion => entry !== null && typeof entry === "object");
}

function hasValue(v: unknown): boolean {
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

// Structural rules over tasks.yaml: a claim of "done" with no receipt is the
// purest form of product slop. These are errors — "Done is a claim. Proof is a
// receipt." (foo voice).
function scanTasks(rel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  let parsed: { tasks?: TaskNode[] };
  try {
    parsed = parseYaml(text) as { tasks?: TaskNode[] };
  } catch {
    return findings; // a malformed tasks.yaml is asp-validate's job, not detect's.
  }
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];

  // Line lookup so a finding points at the offending task id.
  const lineOf = (needle: string): number => {
    const idx = text.split(/\r?\n/).findIndex((l) => l.includes(needle));
    return idx === -1 ? 1 : idx + 1;
  };

  for (const task of tasks) {
    const id = typeof task.id === "string" ? task.id : "(unnamed task)";
    // #884: done_when is a list of criteria, but hand-written packets carry a
    // plain string (a single criterion) and other shapes. Read it defensively —
    // a malformed packet is `asp validate`'s finding, never a detect crash.
    const doneWhen = doneWhenCriteria(task.done_when);
    const status = typeof task.status === "string" ? task.status : "";
    // A task is proven if it carries a receipt anywhere the contract allows:
    // a top-level proof, a completed.proof block, or proof on its done_when
    // criteria. Only "done with no receipt at all" is slop.
    const completedProof =
      task.completed && typeof task.completed === "object"
        ? hasValue((task.completed as { proof?: unknown }).proof)
        : false;
    const doneWhenProof = doneWhen.some((dw) => hasValue(dw.proof));
    const hasProof = hasValue(task.proof) || completedProof || doneWhenProof;

    if (status === "done" && !hasProof) {
      findings.push({
        rule: "PG-001",
        category: "proof-gap",
        severity: "error",
        file: rel,
        line: lineOf(`id: ${id}`),
        message: `${id} is done with no proof — done is a claim; attach the receipt (proof:).`,
        snippet: `${id}: status: done`,
      });
    }

    for (const dw of doneWhen) {
      const dwId = typeof dw.id === "string" ? dw.id : id;
      const dwDone = dw.done === true;
      const dwProof = typeof dw.proof === "string" ? dw.proof.trim().length > 0 : Boolean(dw.proof);
      if (dwDone && !dwProof) {
        findings.push({
          rule: "PG-002",
          category: "proof-gap",
          severity: "error",
          file: rel,
          line: lineOf(`id: ${dwId}`),
          message: `${dwId} (done_when) is checked done with no proof — every passed criterion needs a receipt.`,
          snippet: `${dwId}: done: true`,
        });
      }
    }
  }

  return findings;
}

const SCAN_SKIP_DIRS = new Set([".git", "node_modules", "dist", ".worktrees", "docs"]);

// Resolve a target into the concrete files detect reads. A packet dir → its
// spec.md + tasks.yaml; a directory of packets → each packet's pair; a single
// file → that file.
function collectTargets(target: string, acc: string[]): void {
  if (!existsSync(target)) throw new Error(`detect target not found: ${target}`);
  const stat = lstatSync(target);

  if (stat.isFile()) {
    acc.push(target);
    return;
  }
  if (!stat.isDirectory()) return;
  if (SCAN_SKIP_DIRS.has(path.basename(target))) return;

  const spec = path.join(target, "spec.md");
  const tasks = path.join(target, "tasks.yaml");
  const isPacket = existsSync(spec);
  if (isPacket) {
    acc.push(spec);
    if (existsSync(tasks)) acc.push(tasks);
    return;
  }

  // Not a packet itself — recurse into sub-packets / markdown. Any .md counts:
  // shipped prose (commands/, skills/) is exactly the surface the jargon signal
  // exists for, and a stray .md in a packet home is still committed prose.
  for (const entry of readdirSync(target).sort()) {
    const full = path.join(target, entry);
    const s = lstatSync(full);
    if (s.isDirectory()) collectTargets(full, acc);
    else if (entry.endsWith(".md") || entry === "tasks.yaml") acc.push(full);
  }
}

export function runDetect(root: string, target: string): DetectResult {
  const resolved = path.resolve(root, target);
  const files: string[] = [];
  collectTargets(resolved, files);

  const findings: Finding[] = [];
  const scanned: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/") || file;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanned.push(rel);
    const base = path.basename(file);
    if (base === "tasks.yaml") findings.push(...scanTasks(rel, text));
    else if (base.endsWith(".md")) findings.push(...scanProse(rel, text));
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const counts = {
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    total: findings.length,
  };

  return { scanned, findings, counts };
}

const CATEGORY_LABEL: Record<DetectCategory, string> = {
  "confidence-theater": "confidence theater",
  "proof-gap": "proof gap",
  "evidence-gap": "evidence gap",
  "acceptance-gap": "acceptance gap",
  "scope-drift": "scope drift",
  jargon: "jargon",
};

// Render the report. exitCode mirrors `foo scan`: 0 by default (pure signal),
// and 2 when `--exit-code` is set and an error-severity finding exists, so CI
// can opt into blocking on product slop. --strict makes warns count too.
export function renderDetect(
  result: DetectResult,
  opts: { json: boolean; exitOnFindings: boolean; strict: boolean },
): { output: string; exitCode: number } {
  const blockingCount = opts.strict ? result.counts.total : result.counts.error;
  const exitCode = opts.exitOnFindings && blockingCount > 0 ? 2 : 0;

  if (opts.json) {
    const payload = {
      schema_version: "0.1",
      scanned: result.scanned,
      counts: result.counts,
      findings: result.findings,
    };
    return { output: `${JSON.stringify(payload, null, 2)}\n`, exitCode };
  }

  const lines: string[] = ["foo detect", ""];
  if (result.findings.length === 0) {
    lines.push(`  no product-slop tells across ${result.scanned.length} file(s).`);
    lines.push("");
    return { output: lines.join("\n"), exitCode };
  }

  let lastFile = "";
  for (const f of result.findings) {
    if (f.file !== lastFile) {
      lines.push(`  ${f.file}`);
      lastFile = f.file;
    }
    const tag = f.severity === "error" ? "error" : "warn ";
    lines.push(`    ${f.line}:${tag} [${f.rule}] ${CATEGORY_LABEL[f.category]} — ${f.message}`);
    if (f.snippet) lines.push(`         ${f.snippet}`);
  }
  lines.push("");
  lines.push(
    `  ${result.counts.error} error · ${result.counts.warn} warn across ${result.scanned.length} file(s).`,
  );
  lines.push(
    "  Signal, not a boundary: detect never blocks on its own. Add --exit-code to block CI on errors (--strict to include warns).",
  );
  lines.push("");
  return { output: lines.join("\n"), exitCode };
}
