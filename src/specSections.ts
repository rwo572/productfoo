// One grammar for the spec.md structures every surface reads (packet-grammar-v1
// R-001). Three modules used to carry three private regexes that disagreed with
// each other AND with the packets on disk — packetCorrections required
// `### R-001:` (colon) while real packets also write `### R-001 — Title`, and it
// only saw open questions written as `- **OQ-1** ...` when most packets write
// plain `- ` bullets with no ID at all. A parser that disagrees with the corpus
// never fires, and a link that never fires looks like a working feature with
// nothing to say.
//
// The contract here is one token table, three profiles (R-001):
//   tolerant read    — parseAnchors/parseRequirementHeadings accept every form
//                      that lives in specs/ today; legacy forms are legal
//                      forever (R-003: read everything, rewrite nothing)
//   strict lint      — lintAnchors flags duplicate/malformed IDs and
//                      requirement-shaped lines the tolerant read cannot anchor
//                      (the sixth-grammar catcher, R-004); findings are
//                      advisory here — blocking is the commit gate's call
//   canonical write  — formatters + nextAnchorId emit the one blessed output
//                      form (`### R-001 Title`, `- V-001 — text`); writers are
//                      output-strict while the reader stays input-liberal
//
// Formats pinned by the legacy corpus (all live in specs/ today):
//   ### R-001: Title     ### R-001 — Title     ### R-001 Title     ### R1 — Title
//   - **R-001** Title    - **R1 — Title.** text
//   - Plain question with no ID
//   - **OQ-1** — text    - **OQ-1 — Title.** text    - ~~OQ-1~~ resolved
//   ## Validation Bar    (section headings may carry suffixes)

import { defineQuestion, projectQuestion, type ProjectedQuestion } from "./questionModel.js";
import { redactText } from "./redactEngine.js";

export const ANCHOR_KINDS = ["R", "OQ", "D", "V", "RISK", "H"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

// The token table: where each anchor kind lives and what its ID looks like.
// Both lint and write derive from this table — never from a second regex
// (packet-grammar-v1 RISK-004: two regexes drift apart).
interface AnchorSpec {
  // `## <home>` section whose bullets carry this kind (prefix match — a
  // heading like "## Validation Bar" still counts as home).
  home: string;
  // Tolerant ID matcher: dash optional, no zero-padding required.
  idRe: RegExp;
}

const ANCHOR_TABLE: Record<AnchorKind, AnchorSpec> = {
  R: { home: "Requirements", idRe: /R-?\d+/ },
  OQ: { home: "Open Questions", idRe: /OQ-?\d+/ },
  D: { home: "Decisions", idRe: /D-?\d+/ },
  // V is dash-MANDATORY, unlike the others: "V0"/"V1" are release words in
  // half the catalog's prose ("V0 adds no public command"), and the tolerant
  // form turned two such bullets into duplicate anchors — a blocking false
  // positive caught during the catalog migration. R keeps the tolerant form
  // because undashed R1-style anchors exist in real packets; undashed
  // V-anchors do not.
  V: { home: "Validation", idRe: /V-\d+/ },
  RISK: { home: "Risks", idRe: /RISK-?\d+/ },
  // Hypotheses are optional. When present they share the same tolerant reader
  // and lint authority as the older anchors, but their absence is never a
  // grammar finding and migration never manufactures them.
  H: { home: "Hypotheses", idRe: /H-?\d+/ },
};

// Separators accepted after an ID on input: colon, em/en dash, hyphen, or bare
// whitespace. Requirement writers use the visually quiet bare-heading form;
// the other anchor kinds keep their em-dash bullets (input-liberal,
// output-strict — R-002 as amended by the catalog-format normalization).
const SEPARATOR_CLASS = "[:—–-]";

export interface RequirementHeading {
  id: string;
  title: string;
}

export interface SpecAnchor {
  kind: AnchorKind;
  // The ID exactly as written (`R1` stays `R1` — R-003 forbids renumbering).
  id: string;
  // 1-indexed line in spec.md, for lint findings and gate denials.
  line: number;
  form: "heading" | "bullet";
  // Bullet/heading content after the ID and separator are stripped.
  title: string;
}

// `R-?\d+` (dash optional) is the tolerant form packetVerify already accepted.
const REQUIREMENT_HEADING_RE = new RegExp(
  `^###\\s+(R-?\\d+)\\b\\s*${SEPARATOR_CLASS}?\\s*(.*)$`,
);

// Bullet-form anchors as the corpus writes them: `- R-001 — text`,
// `- **R-001** text`, `- **OQ-1 — Title.** text`, `- ~~OQ-1~~ resolved`,
// `- D-001 (owner) text`. The wrapper and separator are both optional.
function bulletAnchorRe(kind: AnchorKind): RegExp {
  return new RegExp(
    `^\\s*-\\s+(?:\\*\\*|~~)?\\s*(${ANCHOR_TABLE[kind].idRe.source})\\b`,
    "i",
  );
}

function stripBulletDressing(text: string, idMatchLength: number): string {
  return text
    .slice(idMatchLength)
    .replace(new RegExp(`^(?:\\*\\*|~~)?\\s*${SEPARATOR_CLASS}?\\s*`), "")
    .replace(/\*\*|~~/g, "")
    .trim();
}

// Prefix section matching: `## Validation` claims "## Validation Bar" too —
// the T-001 audit found real packets titling sections with suffixes.
function sectionMatches(headingLine: string, home: string): boolean {
  return new RegExp(`^##\\s+${home}\\b`, "i").test(headingLine);
}

type MarkdownFence = { marker: "`" | "~"; length: number };

function fenceMarker(line: string): MarkdownFence | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  return match ? { marker: match[1][0] as MarkdownFence["marker"], length: match[1].length } : null;
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

/**
 * Tolerant read over the whole spec: every anchor of every kind, with line
 * numbers. Requirement headings count anywhere (historical behavior); bullet
 * anchors count only inside their home section.
 */
export function parseAnchors(specText: string): SpecAnchor[] {
  const lines = specText.split(/\r?\n/);
  const out: SpecAnchor[] = [];
  let section: string | null = null;
  let inComment = false;
  let inFence: MarkdownFence | null = null;

  lines.forEach((line, i) => {
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      return;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      return;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = marker;
      return;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      section = line;
      return;
    }
    const heading = line.match(REQUIREMENT_HEADING_RE);
    if (heading) {
      out.push({ kind: "R", id: heading[1], line: i + 1, form: "heading", title: heading[2].trim() });
      return;
    }
    if (!section) return;
    for (const kind of ANCHOR_KINDS) {
      if (!sectionMatches(section, ANCHOR_TABLE[kind].home)) continue;
      const m = line.match(bulletAnchorRe(kind));
      if (!m) continue;
      // Kinds cannot collide: each is matched only inside its own home
      // section, so `R-001` under Risks or `RISK-001` under Requirements
      // simply parses as nothing.
      out.push({
        kind,
        id: m[1],
        line: i + 1,
        form: "bullet",
        title: stripBulletDressing(line.replace(/^\s*-\s+/, ""), m[0].replace(/^\s*-\s+/, "").length),
      });
      break;
    }
  });
  return out;
}

/**
 * All requirements — heading form anywhere plus bullet form inside
 * `## Requirements`. Kept as the historical export name; every surface that
 * links or counts requirements goes through here (R-001: no private regexes).
 */
export function parseRequirementHeadings(specText: string): RequirementHeading[] {
  return parseAnchors(specText)
    .filter((a) => a.kind === "R")
    .map((a) => ({ id: a.id, title: a.title }));
}

export function requirementIds(specText: string): string[] {
  const ids = new Set<string>();
  for (const h of parseRequirementHeadings(specText)) ids.add(h.id);
  return [...ids];
}

export interface OpenQuestion {
  // Explicit `OQ-n` when the bullet carries one; null for plain bullets.
  id: string | null;
  // The raw bullet content, markdown and all (what packetStatus displays).
  text: string;
  // The content with any leading OQ id + markup stripped (what linking scores
  // and shows as the question's title).
  title: string;
}

// Bullets inside `## Open Questions` only — a plain `- ` bullet anywhere else
// in spec.md is not an open question. Continuation lines of multi-line bullets
// are ignored; the first line is the question.
export function parseOpenQuestions(specText: string): OpenQuestion[] {
  const lines = specText.split(/\r?\n/);
  const out: OpenQuestion[] = [];
  let inSection = false;
  let inComment = false;
  let inFence: MarkdownFence | null = null;
  for (const line of lines) {
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = marker;
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      inSection = sectionMatches(line, "Open Questions");
      continue;
    }
    if (!inSection) continue;
    // Only top-level bullets are questions. Nested fields belong to a
    // canonical decision request and must never inflate the open-question
    // count or surface as contextless questions of their own.
    const m = line.match(/^-\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1];
    // Leading id in any of its dressings: **OQ-1**, **OQ-1 — Title.**, ~~OQ-1~~
    const idMatch = text.match(/^(?:\*\*|~~)?\s*(OQ-?\d+)/i);
    const id = idMatch ? idMatch[1].toUpperCase().replace(/^OQ(\d)/, "OQ-$1") : null;
    let title = text;
    if (idMatch) title = stripBulletDressing(text, idMatch[0].length);
    title = title.replace(/\*\*|~~/g, "").trim();
    out.push({ id, text, title: title || text });
  }
  return out;
}

export interface ParsedHypothesis {
  id: string;
  statement: string;
  // Authored values remain raw here. The decision-signal projection owns the
  // bounded display state and can therefore explain malformed values without
  // silently rewriting the source.
  state: string | null;
  validationRefs: string[];
  evidence: string | null;
  line: number;
}

function nestedHypothesisField(line: string, field: string): string | null {
  const match = line.match(new RegExp(`^\\s{2,}-\\s+${field}:\\s*(.*?)\\s*$`, "i"));
  if (!match) return null;
  const value = match[1]
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return value || null;
}

/** Optional authored hypotheses, in document order, with no inferred fields. */
export function parseHypotheses(specText: string): ParsedHypothesis[] {
  const lines = specText.split(/\r?\n/);
  const anchors = parseAnchors(specText).filter((anchor) => anchor.kind === "H");
  return anchors.map((anchor) => {
    const block: string[] = [];
    for (let i = anchor.line; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i]) || /^-\s+\S/.test(lines[i])) break;
      block.push(lines[i]);
    }
    const state = block.map((line) => nestedHypothesisField(line, "State")).find((value) => value !== null) ?? null;
    const validatedBy = block.map((line) => nestedHypothesisField(line, "Validated by")).find((value) => value !== null) ?? null;
    const evidence = block.map((line) => nestedHypothesisField(line, "Evidence")).find((value) => value !== null) ?? null;
    return {
      id: anchor.id,
      statement: anchor.title,
      state,
      validationRefs: validatedBy?.match(/\bV-\d+\b/gi)?.map((id) => id.toUpperCase()) ?? [],
      evidence,
      line: anchor.line,
    };
  });
}

// ---------------------------------------------------------------------------
// Canonical actionable decisions (decision-surface-clarity-v0 R-001).
//
// Open-question prose remains tolerant legacy input. Urgency is opt-in and
// strict: only a complete `State: needs-decision` block becomes a request.
// Renderers consume the resulting QuestionModel; they never interpret raw
// Markdown or manufacture option/recommendation policy of their own.
// ---------------------------------------------------------------------------

export type DecisionTarget = { kind: "packet" } | { kind: "task"; id: string };

export interface PacketDecisionRequest {
  id: string;
  why_now: string;
  unblocks: DecisionTarget;
  answer_effect: string;
  question: ProjectedQuestion;
}

export type DecisionFindingCode =
  | "decision.missing_id"
  | "decision.missing_field"
  | "decision.invalid_confidence"
  | "decision.invalid_option"
  | "decision.missing_opt_out"
  | "decision.unknown_unblocks";

export interface DecisionFinding {
  code: DecisionFindingCode;
  line: number;
  text: string;
  detail: string;
}

export interface DecisionParseResult {
  requests: PacketDecisionRequest[];
  findings: DecisionFinding[];
}

type DecisionParseOptions = { taskIds?: Iterable<string> };

type RawDecisionOption = { id: string; label: string; outcome: string | null; line: number };

function plainDecisionText(value: string): string {
  const plain = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return redactText(plain, { profiles: ["secrets"] }).redactedText;
}

function fieldValue(line: string, field: string): string | null {
  const match = line.match(new RegExp(`^\\s{2,}-\\s+${field}:\\s*(.*?)\\s*$`, "i"));
  return match ? plainDecisionText(match[1]) : null;
}

function decisionFinding(
  code: DecisionFindingCode,
  line: number,
  text: string,
  detail: string,
): DecisionFinding {
  return { code, line, text, detail };
}

function parseDecisionBlock(
  bullet: OpenQuestion,
  startLine: number,
  lines: string[],
  validTaskIds: Set<string> | null,
): { request: PacketDecisionRequest | null; findings: DecisionFinding[] } {
  const findings: DecisionFinding[] = [];
  const state = lines.map((line) => fieldValue(line, "State")).find((value) => value !== null);
  if (state?.toLowerCase() !== "needs-decision") return { request: null, findings };

  const add = (code: DecisionFindingCode, detail: string) => {
    findings.push(decisionFinding(code, startLine, bullet.text, detail));
  };

  if (!bullet.id) add("decision.missing_id", "a needs-decision block requires a stable OQ id, for example `OQ-001`");

  const whyNow = lines.map((line) => fieldValue(line, "Why now")).find((value) => value !== null) ?? null;
  const unblocksRaw = lines.map((line) => fieldValue(line, "Unblocks")).find((value) => value !== null) ?? null;
  const evidence = lines.map((line) => fieldValue(line, "Evidence")).find((value) => value !== null) ?? null;
  const confidenceRaw = lines.map((line) => fieldValue(line, "Confidence")).find((value) => value !== null) ?? null;
  const dissent = lines.map((line) => fieldValue(line, "Dissent")).find((value) => value !== null) ?? undefined;
  const answerEffect = lines.map((line) => fieldValue(line, "Answer effect")).find((value) => value !== null) ?? null;
  const recommendationRaw = lines.map((line) => fieldValue(line, "Recommendation")).find((value) => value !== null) ?? null;

  for (const [field, value] of [
    ["Why now", whyNow],
    ["Unblocks", unblocksRaw],
    ["Recommendation", recommendationRaw],
    ["Evidence", evidence],
    ["Confidence", confidenceRaw],
    ["Answer effect", answerEffect],
  ] as const) {
    if (!value) add("decision.missing_field", `needs-decision is missing \`${field}:\`; copy the canonical block from a fresh foo spec packet`);
  }

  let confidence: "low" | "medium" | "high" | null = null;
  const normalizedConfidence = confidenceRaw?.toLowerCase();
  if (normalizedConfidence === "low" || normalizedConfidence === "medium" || normalizedConfidence === "high") {
    confidence = normalizedConfidence;
  } else if (confidenceRaw) {
    add("decision.invalid_confidence", "`Confidence:` must be low, medium, or high");
  }

  let unblocks: DecisionTarget | null = null;
  if (unblocksRaw?.toLowerCase() === "packet") {
    unblocks = { kind: "packet" };
  } else if (unblocksRaw && /^T-\d+$/i.test(unblocksRaw)) {
    const id = unblocksRaw.toUpperCase();
    if (validTaskIds && !validTaskIds.has(id)) {
      add("decision.unknown_unblocks", `\`Unblocks: ${id}\` does not name a task in tasks.yaml`);
    } else {
      unblocks = { kind: "task", id };
    }
  } else if (unblocksRaw) {
    add("decision.unknown_unblocks", "`Unblocks:` must be `packet` or a task id such as `T-002`");
  }

  const options: RawDecisionOption[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s{2,}-\s+Option\s+([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.*?)\s*$/i);
    if (!match) continue;
    const option: RawDecisionOption = {
      id: match[1],
      label: plainDecisionText(match[2]),
      outcome: null,
      line: startLine + i + 1,
    };
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s{2,}-\s+Option\s+/i.test(lines[j])) break;
      const outcome = lines[j].match(/^\s{4,}-\s+Outcome:\s*(.*?)\s*$/i);
      if (outcome) {
        option.outcome = plainDecisionText(outcome[1]);
        break;
      }
      if (/^\s{2,}-\s+\S/.test(lines[j])) break;
    }
    options.push(option);
  }

  if (options.length < 2) add("decision.invalid_option", "a decision needs at least two `Option <id>:` choices");
  const optionIds = options.map((option) => option.id);
  if (new Set(optionIds).size !== optionIds.length) add("decision.invalid_option", "option ids must be unique");
  for (const option of options) {
    if (!option.label) add("decision.invalid_option", `option \`${option.id}\` is missing a plain-English label`);
    if (!option.outcome) add("decision.invalid_option", `option \`${option.id}\` is missing its nested \`Outcome:\``);
  }
  if (!options.some((option) => /\b(?:pause|defer|not now|do not|don't|stop)\b/i.test(option.label))) {
    add("decision.missing_opt_out", "include a real pause, defer, not-now, do-not-do, or stop option");
  }

  let recommendedOptionId: string | null = null;
  let belief: string | null = null;
  if (recommendationRaw) {
    const match = recommendationRaw.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:—|–|-)\s*(.+)$/);
    if (!match) {
      add("decision.missing_field", "`Recommendation:` must be `<option-id> — <plain-English rationale>`");
    } else {
      recommendedOptionId = match[1];
      belief = plainDecisionText(match[2]);
      if (!optionIds.includes(recommendedOptionId)) {
        add("decision.invalid_option", `recommended option \`${recommendedOptionId}\` does not match an Option id`);
      }
    }
  }

  if (findings.length > 0 || !bullet.id || !whyNow || !unblocks || !answerEffect || !evidence || !belief || !recommendedOptionId || !confidence) {
    return { request: null, findings };
  }

  try {
    const question = projectQuestion(defineQuestion({
      header: "Decision needed",
      prompt: plainDecisionText(bullet.title),
      options: options.map((option) => ({ id: option.id, label: option.label, description: option.outcome ?? undefined })),
      recommendedOptionId,
      judgment: { belief, evidence, confidence, ...(dissent ? { dissent } : {}) },
    }));
    return {
      request: { id: bullet.id, why_now: whyNow, unblocks, answer_effect: answerEffect, question },
      findings,
    };
  } catch (error) {
    add("decision.invalid_option", error instanceof Error ? error.message : String(error));
    return { request: null, findings };
  }
}

export function parseDecisionRequests(specText: string, options: DecisionParseOptions = {}): DecisionParseResult {
  const validTaskIds = options.taskIds ? new Set([...options.taskIds].map((id) => id.toUpperCase())) : null;
  const allLines = specText.split(/\r?\n/);
  const requests: PacketDecisionRequest[] = [];
  const findings: DecisionFinding[] = [];
  let inSection = false;
  let inComment = false;
  // Same fence tracking as parseOpenQuestions (#775): a fenced canonical
  // example is documentation and must never mint a live decision request.
  let inFence: MarkdownFence | null = null;

  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = marker;
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      inSection = sectionMatches(line, "Open Questions");
      continue;
    }
    if (!inSection) continue;
    const top = line.match(/^-\s+(.*\S)\s*$/);
    if (!top) continue;

    const text = top[1];
    const idMatch = text.match(/^(?:\*\*|~~)?\s*(OQ-?\d+)/i);
    const id = idMatch ? idMatch[1].toUpperCase().replace(/^OQ(\d)/, "OQ-$1") : null;
    let title = idMatch ? stripBulletDressing(text, idMatch[0].length) : text;
    title = plainDecisionText(title);
    const bullet: OpenQuestion = { id, text, title: title || plainDecisionText(text) };

    const block: string[] = [];
    let j = i + 1;
    for (; j < allLines.length; j += 1) {
      const blockLine = allLines[j];
      // This scan advances the outer cursor, so it must consume fences too.
      // Fenced bullets and fields are examples, never block boundaries or
      // live decision metadata. Keep scanning for the next unfenced bullet.
      if (inFence) {
        if (closesFence(blockLine, inFence)) inFence = null;
        continue;
      }
      // Comments can contain unmatched example fences. As in the outer
      // scan, comments are inert unless they are themselves inside a fence.
      if (inComment) {
        if (blockLine.includes("-->")) inComment = false;
        continue;
      }
      if (blockLine.includes("<!--")) {
        if (!blockLine.includes("-->")) inComment = true;
        continue;
      }
      const blockFence = fenceMarker(blockLine);
      if (blockFence) {
        inFence = blockFence;
        continue;
      }
      if (/^##\s+/.test(blockLine) || /^-\s+\S/.test(blockLine)) break;
      block.push(blockLine);
    }
    const parsed = parseDecisionBlock(bullet, i + 1, block, validTaskIds);
    if (parsed.request) requests.push(parsed.request);
    findings.push(...parsed.findings);
    i = j - 1;
  }

  return { requests, findings };
}

// One copyable example for every packet scaffold. It is deliberately inside
// an HTML comment: a fresh packet teaches the contract without manufacturing
// a live question that status or a UI could mistake for user input.
export function decisionRequestAuthoringComment(): string {
  return `<!--
Add the block below only when active work truly cannot continue without a
human choice. Ordinary uncertainties stay as plain deferred notes.

- OQ-001 — Which option should we take?
  - State: needs-decision
  - Why now: Work cannot continue until this choice is made.
  - Unblocks: T-001
  - Option continue: Continue with the smallest reversible path
    - Outcome: The agent continues T-001 with that path.
  - Option pause: Pause this work
    - Outcome: The agent records the pause and does not build it.
  - Recommendation: continue — This is the smallest reversible path.
  - Evidence: Name the repo fact that supports the recommendation.
  - Confidence: medium
  - Dissent: Name the strongest reason to choose differently.
  - Answer effect: The selected option becomes the instruction for the active task.
-->`;
}

// ---------------------------------------------------------------------------
// Strict lint profile (R-004). Findings are data; validate renders them as
// advisory signals and the commit gate decides which subset blocks (R-005).
// ---------------------------------------------------------------------------

export type GrammarFindingCode =
  | "grammar.duplicate_id"
  | "grammar.malformed_id"
  | "grammar.missing_id"
  | "grammar.unparsed_candidate";

export interface GrammarFinding {
  code: GrammarFindingCode;
  line: number;
  // The offending line, verbatim — gate denials must name it (R-005).
  text: string;
  detail: string;
}

// Duplicate detection compares numeric identity, not spelling: `R-001` and
// `R1` in one packet are the same anchor written twice, which is exactly the
// ambiguity the grammar exists to prevent.
function normalizedKey(kind: AnchorKind, id: string): string {
  const num = id.replace(/^[A-Z]+-?/i, "");
  return `${kind}:${Number(num)}`;
}

// A line that *tried* to be an anchor and failed: right shape, broken ID
// (`### R-01a — ...`). Kept deliberately narrow — a gate that fires on the
// mention of a risk rather than the risk is one people learn to override on
// sight (AGENTS.md, three arrivals of that lesson).
// Digits are mandatory before the broken tail: `R-01a` and a dangling `R-`
// are anchor attempts; `Risk mitigation` and `Rendering` are prose.
const MALFORMED_HEADING_RE = /^###\s+(R-?\d+[A-Za-z]\w*|R-)\s/;
const MALFORMED_BULLET_RE = /^\s*-\s+(?:\*\*)?((?:OQ|D|V|RISK|H)-?\d+[A-Za-z]\w*|(?:OQ|D|V|RISK|H)-)\s/;

// A requirement candidate the tolerant read cannot anchor: a line under
// `## Requirements` shaped like the packet's OWN requirement grammar but with
// no recognizable ID. This is the sixth-grammar catcher (R-004, V-003) — and
// the grammar-sensitivity is load-bearing: in a heading-style packet, bold
// bullets inside a requirement's body are prose lists (signals-over-gates
// writes `- **B1 Safety**: ...` under R1), and flagging or stamping those is
// the fires-on-the-mention false positive that kills a gate's credibility.
export interface RequirementGrammar {
  headingForm: boolean;
  bulletForm: boolean;
}

export function requirementGrammarOf(anchors: SpecAnchor[]): RequirementGrammar {
  const rs = anchors.filter((a) => a.kind === "R");
  return {
    headingForm: rs.some((a) => a.form === "heading"),
    bulletForm: rs.some((a) => a.form === "bullet"),
  };
}

function isRequirementCandidate(line: string, grammar: RequirementGrammar): boolean {
  // Headings are candidates unless the packet writes requirements as bullets
  // only (there a bare `###` is a subsection title). Bullets are candidates
  // only where bullets are how requirements are written. An anchor-less
  // section defaults to heading candidacy — the scaffold's own form.
  const headingCandidate = !(!grammar.headingForm && grammar.bulletForm) && /^###\s+\S/.test(line);
  const bulletCandidate = grammar.bulletForm && !grammar.headingForm && /^\s*-\s+\*\*\S/.test(line);
  return headingCandidate || bulletCandidate;
}

export function lintAnchors(specText: string): GrammarFinding[] {
  const findings: GrammarFinding[] = [];
  const anchors = parseAnchors(specText);
  const anchoredLines = new Set(anchors.map((a) => a.line));
  const grammar = requirementGrammarOf(anchors);

  const seen = new Map<string, SpecAnchor>();
  for (const a of anchors) {
    const key = normalizedKey(a.kind, a.id);
    const first = seen.get(key);
    if (first) {
      findings.push({
        code: "grammar.duplicate_id",
        line: a.line,
        text: `${a.id}`,
        detail: `${a.id} duplicates ${first.id} (line ${first.line}) — same anchor written twice`,
      });
    } else {
      seen.set(key, a);
    }
  }

  const lines = specText.split(/\r?\n/);
  let section: string | null = null;
  let inComment = false;
  let inFence: MarkdownFence | null = null;
  lines.forEach((line, i) => {
    if (inFence) {
      if (closesFence(line, inFence)) inFence = null;
      return;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      return;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = marker;
      return;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      section = line;
      return;
    }
    if (anchoredLines.has(i + 1)) return;
    const malformed = line.match(MALFORMED_HEADING_RE) ?? line.match(MALFORMED_BULLET_RE);
    if (malformed) {
      findings.push({
        code: "grammar.malformed_id",
        line: i + 1,
        text: line.trim(),
        detail: `"${malformed[1]}" is anchor-shaped but not a valid ID`,
      });
      return;
    }
    if (!section) return;
    if (sectionMatches(section, "Requirements") && isRequirementCandidate(line, grammar)) {
      findings.push({
        code: "grammar.unparsed_candidate",
        line: i + 1,
        text: line.trim(),
        detail: "requirement-shaped line the grammar cannot anchor — a new format drifting in",
      });
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Canonical write profile (R-002, R-006). Output-strict: writers emit the
// blessed form only. Migration and the scaffold both mint through here.
// ---------------------------------------------------------------------------

/** Next free ID for a kind, zero-padded (`R-001` style), never reusing a
 * number any existing anchor holds in any spelling. */
export function nextAnchorId(kind: AnchorKind, existing: SpecAnchor[]): string {
  let max = 0;
  for (const a of existing) {
    if (a.kind !== kind) continue;
    const num = Number(a.id.replace(/^[A-Z]+-?/i, ""));
    if (Number.isFinite(num) && num > max) max = num;
  }
  return `${kind}-${String(max + 1).padStart(3, "0")}`;
}

export function formatRequirementHeading(id: string, title: string): string {
  return `### ${id} ${title}`;
}

export function formatAnchorBullet(id: string, text: string): string {
  return `- ${id} — ${text}`;
}

// ---------------------------------------------------------------------------
// Migration (R-006): mint IDs only where none exist, inside the existing line
// structure — a bullet stays a bullet, a heading stays a heading, and no
// existing ID or character is ever rewritten (R-003: read everything, rewrite
// nothing). Every change is a single contiguous inserted token, which is what
// makes the proof mechanical: strip exactly the inserted tokens and the
// original file comes back byte-for-byte (V-002).
// ---------------------------------------------------------------------------

export interface Insertion {
  // 1-indexed line the token was inserted into.
  line: number;
  // Column (0-indexed character offset in the ORIGINAL line) of the insertion.
  column: number;
  id: string;
  // The exact inserted text, e.g. "V-003 — ".
  token: string;
}

export interface MigrateResult {
  text: string;
  insertions: Insertion[];
  // True when stripInsertions(text, insertions) byte-equals the input. Always
  // checked, never assumed — a migrator that cannot prove itself must refuse
  // to write (R-006 contract, exit 2 at the CLI).
  proofOk: boolean;
}

// Where the minted token lands: after `- ` for plain bullets, after the bold
// or strike opener when the bullet leads with one, after `### ` for headings.
// The bullet arm keeps any leading indentation (`\s*`) so an indented bullet —
// which candidacy and parseAnchors both accept — is stamped after its marker,
// not at column 0 where the minted ID would stop reading as an anchor.
function insertionColumn(line: string): number {
  const m = line.match(/^(###\s+|\s*-\s+(?:\*\*|~~)?)/);
  return m ? m[0].length : 0;
}

/** Remove exactly the recorded tokens — the mechanical proof's inverse. */
export function stripInsertions(text: string, insertions: Insertion[]): string {
  const lines = text.split("\n");
  for (const ins of insertions) {
    const line = lines[ins.line - 1];
    lines[ins.line - 1] = line.slice(0, ins.column) + line.slice(ins.column + ins.token.length);
  }
  return lines.join("\n");
}

export function migrateSpecText(specText: string): MigrateResult {
  const lines = specText.split("\n");
  const existing = parseAnchors(specText);
  const anchoredLines = new Set(existing.map((a) => a.line));
  const grammar = requirementGrammarOf(existing);
  const insertions: Insertion[] = [];
  // Counters continue past every number already used in any spelling.
  const minted: SpecAnchor[] = [...existing];

  let section: string | null = null;
  let inComment = false;
  let inFence: MarkdownFence | null = null;
  lines.forEach((raw, i) => {
    if (inFence) {
      if (closesFence(raw, inFence)) inFence = null;
      return;
    }
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      return;
    }
    if (raw.includes("<!--")) {
      if (!raw.includes("-->")) inComment = true;
      return;
    }
    const marker = fenceMarker(raw);
    if (marker) {
      inFence = marker;
      return;
    }
    if (/^##\s+/.test(raw) && !/^###/.test(raw)) {
      section = raw;
      return;
    }
    if (!section || anchoredLines.has(i + 1)) return;

    let kind: AnchorKind | null = null;
    for (const k of ANCHOR_KINDS) {
      if (sectionMatches(section, ANCHOR_TABLE[k].home)) kind = k;
    }
    if (!kind) return;
    // Hypotheses are optional authored claims. Migration must never backfill
    // or invent one from an unanchored prose bullet.
    if (kind === "H") return;

    // Requirements are stamped only on requirement-shaped lines (headings and
    // bold-led bullets) — a `- Priority: P1` metadata bullet is not a
    // requirement and must never become one. Other home sections stamp every
    // top-level bullet: in Decisions/Risks/Validation/Open Questions the
    // bullets ARE the items.
    const stampable =
      kind === "R" ? isRequirementCandidate(raw, grammar) : /^-\s+\S/.test(raw);
    if (!stampable) return;

    const id = nextAnchorId(kind, minted);
    const token = kind === "R" && raw.startsWith("###") ? `${id} ` : `${id} — `;
    const column = insertionColumn(raw);
    lines[i] = raw.slice(0, column) + token + raw.slice(column);
    insertions.push({ line: i + 1, column, id, token });
    minted.push({ kind, id, line: i + 1, form: raw.startsWith("###") ? "heading" : "bullet", title: "" });
  });

  const text = lines.join("\n");
  const proofOk = stripInsertions(text, insertions) === specText;
  return { text, insertions, proofOk };
}
