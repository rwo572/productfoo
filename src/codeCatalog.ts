// code-catalog-rip-v0 engine, promoted to an importable module so spec-after
// can consume it (spec-after-capture-v0 R-003: import the behavior extractor,
// never fork it — one owner per behavior). Deterministic code->behavior-story
// extraction from a unified diff.
//
// The stories are CODE-DERIVED expectations: tagged `self_reported`, provenance
// no stronger than the extraction method, and NEVER gating. Code is evidence of
// behavior, never authority over intent (catalog R-003/R-005). This module reads
// text only; it never runs a test, applies a fix, or invokes a runner (R-005).
//
// V0a uses the deterministic `structural-diff` extractor below. V0b can swap in
// an LLM-backed extractor that emits the same `BehaviorStory` shape with
// provenance `agent-inference` — the type is the contract, the extractor is a
// slope-riding adapter (spec-after R-010).

export type StoryProvenance = "structural-diff" | "agent-inference" | "repo-truth";
export type ChangeKind = "added" | "modified" | "removed";

export interface BehaviorStory {
  id: string;
  file: string;
  change_kind: ChangeKind;
  title: string;
  /** The code-derived expectation: what the changed code does. Self-reported. */
  expected_behavior: string;
  /** Concrete code evidence (declaration names) behind the story. */
  evidence: string[];
  added_symbols: string[];
  removed_symbols: string[];
  added_lines: number;
  removed_lines: number;
  provenance: StoryProvenance;
  /** Code-derived expectations are non-authoritative over intent; always true here. */
  self_reported: boolean;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

/** R-007: enumeration coverage is reported so a missed feature is a visible gap. */
export interface ExtractionCoverage {
  scanned_files: number;
  story_files: number;
  stories: number;
  basis: string;
  skipped: SkippedFile[];
}

export interface CatalogResult {
  stories: BehaviorStory[];
  coverage: ExtractionCoverage;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

/**
 * productfoo's own bookkeeping — error reports, run caches, event logs it writes into the user's repo.
 *
 * These must never appear as a drift finding. A real run reported `added .foo/reports/err_*.json`
 * as "built but never asked for": foo wrote the file, then told the user they had built something
 * they never asked for. That is the tool littering someone's repo and then billing them for it —
 * and it is the same complaint an alpha tester already filed about files appearing in her checkout.
 */
function isFooArtifact(file: string): boolean {
  return /(^|\/)\.foo\//.test(file);
}

function isGeneratedPath(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  if (isFooArtifact(file)) return true;
  if (LOCKFILES.has(base)) return true;
  return /\.(min\.js|map|snap)$/.test(base);
}

// Deterministic declaration detection on added/removed lines. Intentionally
// conservative: it names symbols, it does not claim to understand them. Exported
// declarations count at any depth; bare (non-exported) declarations only count
// at top level so nested locals (loop vars, helpers' internals) stay out of the
// story.
const DECL_PATTERNS: { re: RegExp; exported: boolean }[] = [
  { re: /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, exported: true },
  { re: /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, exported: true },
  { re: /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, exported: true },
  { re: /\bexport\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, exported: true },
  { re: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, exported: false },
  { re: /\bclass\s+([A-Za-z_$][\w$]*)/, exported: false },
  { re: /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/, exported: false },
  { re: /\bdef\s+([A-Za-z_$][\w$]*)/, exported: false },
];

function symbolsFrom(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    const topLevel = /^\S/.test(line);
    for (const { re, exported } of DECL_PATTERNS) {
      if (!exported && !topLevel) continue;
      const m = re.exec(line);
      if (m && m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

interface RawFileSection {
  header: string;
  body: string[];
}

function splitFileSections(diff: string): RawFileSection[] {
  const sections: RawFileSection[] = [];
  let current: RawFileSection | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function pathFromSection(header: string, body: string[]): string {
  let plus: string | undefined;
  let minus: string | undefined;
  for (const line of body) {
    if (line.startsWith("+++ ")) plus = line.slice(4).trim();
    else if (line.startsWith("--- ")) minus = line.slice(4).trim();
  }
  const pick = (value?: string): string | undefined =>
    value && value !== "/dev/null" ? value.replace(/^[ab]\//, "") : undefined;
  const fromHeader = /a\/(.+) b\/(.+)$/.exec(header);
  return pick(plus) ?? pick(minus) ?? fromHeader?.[2] ?? header.replace("diff --git ", "");
}

function changeKind(body: string[]): ChangeKind {
  for (const line of body) {
    if (line.startsWith("new file mode")) return "added";
    if (line.startsWith("deleted file mode")) return "removed";
  }
  return "modified";
}

function isBinary(body: string[]): boolean {
  return body.some((line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"));
}

function buildTitle(kind: ChangeKind, file: string, added: string[]): string {
  if (!added.length) return `${kind} ${file}`;
  const head = added.slice(0, 3).join(", ");
  return `${kind} ${file} (+${head}${added.length > 3 ? ", …" : ""})`;
}

function listSymbols(symbols: string[], max = 8): string {
  const shown = symbols.slice(0, max).map((s) => `\`${s}\``).join(", ");
  return symbols.length > max ? `${shown}, +${symbols.length - max} more` : shown;
}

function buildExpectedBehavior(
  kind: ChangeKind,
  file: string,
  added: string[],
  removed: string[],
  addedLines: number,
  removedLines: number,
): string {
  const parts: string[] = [];
  if (kind === "added") parts.push(`New file \`${file}\` (+${addedLines})`);
  else if (kind === "removed") parts.push(`Removes \`${file}\` (-${removedLines})`);
  else parts.push(`Modifies \`${file}\` (+${addedLines}/-${removedLines})`);
  if (added.length) parts.push(`adds ${listSymbols(added)}`);
  if (removed.length) parts.push(`removes ${listSymbols(removed)}`);
  return `${parts.join("; ")}.`;
}

/**
 * Extract one code-derived behavior story per changed source file from a unified
 * diff. Pure and deterministic. Binary and lockfile/generated paths are skipped
 * and listed in coverage (R-007) rather than silently dropped. Never gates.
 */
export function extractBehaviorStories(diff: string): CatalogResult {
  const sections = splitFileSections(diff);
  const stories: BehaviorStory[] = [];
  const skipped: SkippedFile[] = [];
  let seq = 0;

  for (const section of sections) {
    const file = pathFromSection(section.header, section.body);
    // productfoo's own bookkeeping is dropped outright, not "skipped". The skipped list exists so no
    // file of YOURS is silently ignored (R-007) — but these are not your files, they are productfoo's,
    // and reporting them back to you is the tool making its own litter your problem.
    if (isFooArtifact(file)) continue;
    if (isBinary(section.body)) {
      skipped.push({ file, reason: "binary" });
      continue;
    }
    if (isGeneratedPath(file)) {
      skipped.push({ file, reason: "generated/lockfile" });
      continue;
    }

    const added = section.body.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const removed = section.body.filter((line) => line.startsWith("-") && !line.startsWith("---"));
    const addedSymbols = symbolsFrom(added.map((line) => line.slice(1)));
    const removedSymbols = symbolsFrom(removed.map((line) => line.slice(1))).filter(
      (symbol) => !addedSymbols.includes(symbol),
    );
    const kind = changeKind(section.body);

    seq += 1;
    stories.push({
      id: `bs-${String(seq).padStart(3, "0")}`,
      file,
      change_kind: kind,
      title: buildTitle(kind, file, addedSymbols),
      expected_behavior: buildExpectedBehavior(kind, file, addedSymbols, removedSymbols, added.length, removed.length),
      evidence: [...addedSymbols.map((s) => `+${s}`), ...removedSymbols.map((s) => `-${s}`)].slice(0, 12),
      added_symbols: addedSymbols,
      removed_symbols: removedSymbols,
      added_lines: added.length,
      removed_lines: removed.length,
      provenance: "structural-diff",
      self_reported: true,
    });
  }

  return {
    stories,
    coverage: {
      scanned_files: sections.length,
      story_files: stories.length,
      stories: stories.length,
      basis:
        "unified diff: one behavior story per changed source file; symbols via declaration regex. " +
        "Code-derived and self-reported (catalog R-001/R-003); binary and lockfile/generated paths skipped and listed.",
      skipped,
    },
  };
}
