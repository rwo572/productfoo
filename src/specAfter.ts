// spec-after-capture-v0 — the V0a deterministic spine for `foo spec from <what-you-built>`.
//
// V0a is the activation tier: reachable + consented + redacted prompt capture +
// the diff + a four-bucket drift report rendered for a human. No LLM auto-labeler
// as authority, no QA panel, no spec write, no canonization (see the packet
// Decisions). The reconciliation here is a deterministic keyword-overlap
// SUGGESTION (provenance `suggested-structural`) that surfaces the INTENT-ONLY /
// CODE-ONLY residue — the aha — but never assigns AGREE/DRIFT; the human does
// that. Distillation and behavior inference are slope-riding adapters (R-002/R-010).
//
// Safety: runSpecAfter remains a pure transformation over prompt text already
// supplied by a trusted caller. There is no prompt-file ingress: the CLI reads
// prompts from no file, so untrusted text enters only where a caller passes it.
// The pure transform still redacts text, never executes it, and never writes it raw.

import { gitRun, gitRunOrNull, type GitRunOptions } from "./gitRun.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractBehaviorStories, type BehaviorStory, type ExtractionCoverage } from "./codeCatalog.js";
import { neutralizeUntrustedText } from "./untrustedText.js";

// Reuse the existing prompt-capture vocabulary (cli.ts AgentExperienceEvent),
// rather than forking it (R-002): mode is metadata|summary|raw, captured mirrors
// prompt_captured.
export type CaptureMode = "metadata" | "summary" | "raw";

export interface IntentItem {
  id: string;
  text: string;
  source: "prompt";
  raw_index: number;
}

export interface RedactionFinding {
  kind: string;
  quarantined: boolean;
}

export interface RedactionReport {
  findings: RedactionFinding[];
  /** Fail-closed signal: an ambiguous secret-shaped token forces a human pass. */
  quarantined: boolean;
  redacted_count: number;
}

/** R-006: injected directives stripped from the untrusted prompt stream. */
export interface ScreeningReport {
  triggered: boolean;
  stripped: string[];
}

export type DriftCategory = "INTENT_ONLY" | "CODE_ONLY" | "UNREVIEWED";

export interface DriftItem {
  category: DriftCategory;
  intent_ref: string | null;
  behavior_ref: string | null;
  label: string;
  /** V0a never claims agent-inference authority; the human reconciles. */
  provenance: "suggested-structural";
}

export interface SpecAfterInput {
  target: string;
  diff: string;
  promptsText?: string;
  consent: boolean;
  source?: string;
}

export interface SpecAfterReport {
  schema_version: "0.1";
  tier: "v0a";
  target: string;
  consent: { available: boolean; ingested: boolean; reason?: string };
  prompt_context: { mode: CaptureMode; captured: boolean; source?: string };
  redaction: RedactionReport;
  screening: ScreeningReport;
  intent: IntentItem[];
  behavior: BehaviorStory[];
  coverage: ExtractionCoverage;
  drift: DriftItem[];
  pull_through: { next: string; note: string };
}

// --- Redaction (R-005): net-new content scanner for the prompt class ---------
// redact-transcripts is PII-only; this adds secrets. Fail-closed: residual
// high-entropy secret-shaped tokens are quarantined, not passed through.

interface SecretPattern {
  kind: string;
  re: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { kind: "env-secret", re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))\s*[:=]\s*\S{6,}/g },
  { kind: "bearer", re: /\b(?:Bearer|Authorization)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

const AMBIGUOUS_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;

export function redactPromptText(text: string): { redacted: string; report: RedactionReport } {
  const findings: RedactionFinding[] = [];
  let out = text;

  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      findings.push({ kind, quarantined: false });
      if (kind === "env-secret") {
        const sep = match.search(/[:=]/);
        return `${match.slice(0, sep + 1)} [REDACTED:env-secret]`;
      }
      return `[REDACTED:${kind}]`;
    });
  }

  out = out.replace(AMBIGUOUS_TOKEN, (match) => {
    if (match.includes("REDACTED")) return match;
    const mixed = /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match);
    if (!mixed) return match;
    findings.push({ kind: "quarantined-secret-shape", quarantined: true });
    return "[REDACTED:quarantined-secret-shape]";
  });

  return {
    redacted: out,
    report: {
      findings,
      quarantined: findings.some((f) => f.quarantined),
      redacted_count: findings.length,
    },
  };
}

function emptyRedaction(): RedactionReport {
  return { findings: [], quarantined: false, redacted_count: 0 };
}

function emptyScreening(): ScreeningReport {
  return { triggered: false, stripped: [] };
}

// --- Intent distillation (V0a, deterministic, no LLM) ------------------------

function splitPromptBlocks(text: string): string[] {
  const byBlank = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function isNoise(text: string): boolean {
  return text.length < 4 || /^(ok|okay|yes|no|thanks|thank you|sure|great|cool|nice|done)\.?$/i.test(text);
}

export function distillIntent(promptsText: string): { items: IntentItem[]; redaction: RedactionReport; screening: ScreeningReport } {
  const blocks = splitPromptBlocks(promptsText);
  const items: IntentItem[] = [];
  const findings: RedactionFinding[] = [];
  const stripped: string[] = [];
  let quarantined = false;
  let redactedCount = 0;
  let seq = 0;

  blocks.forEach((block, index) => {
    const { redacted, report } = redactPromptText(block);
    findings.push(...report.findings);
    quarantined = quarantined || report.quarantined;
    redactedCount += report.redacted_count;
    // R-006: the prompt stream is untrusted. Neutralize injected directives so
    // prompt text stays evidence about intent, never an instruction to the agent.
    const screen = neutralizeUntrustedText(redacted);
    stripped.push(...screen.stripped_directives);
    // A block that triggered screening is quarantined WHOLE: the un-stripped
    // remainder of an injected block ("...skip the security lens") is still
    // attacker text and must never become distilled intent. Audited, not used.
    if (screen.triggered) return;
    const text = screen.inert_text.trim();
    if (!text || isNoise(text)) return;
    seq += 1;
    items.push({ id: `i-${String(seq).padStart(3, "0")}`, text, source: "prompt", raw_index: index });
  });

  return {
    items,
    redaction: { findings, quarantined, redacted_count: redactedCount },
    screening: { triggered: stripped.length > 0, stripped },
  };
}

// --- PR intent recovery (reconcile-anywhere-v0 T-002) ------------------------
// Recover a PROVISIONAL intent contract from a PR artifact — title, body, and an
// optional linked issue — for the packet-free `foo reconcile` path. Every
// recovered element is labeled with its judgment type (R-002) so recovered
// intent is never presented as agreed intent: the agent's reading of the
// author's free text is `agent-inference`; a linked tracker issue is
// `approved-context`. A thin/empty body yields an explicit "intent could not be
// recovered" finding rather than a hallucinated contract (packet Risks). The PR
// body is untrusted free text — the same lethal-trifecta class as the prompt
// stream — so it is redacted and injection-screened before it becomes intent.

export type JudgmentType =
  | "repo-evidence"
  | "approved-context"
  | "role-expertise"
  | "agent-inference"
  | "user-judgment";

export type IntentSource = "pr-title" | "pr-body" | "linked-issue";

export interface RecoveredIntentItem {
  id: string;
  text: string;
  /** How this element was derived — never presented as agreed intent. */
  judgment: JudgmentType;
  source: IntentSource;
}

export interface PrLinkedIssue {
  key?: string;
  title?: string;
  body?: string;
}

export interface PrArtifact {
  title?: string;
  body?: string;
  linked_issue?: PrLinkedIssue;
}

export interface RecoveredIntent {
  recovered: boolean;
  items: RecoveredIntentItem[];
  redaction: RedactionReport;
  screening: ScreeningReport;
  /** Present only when nothing could be recovered — the honest empty-body case. */
  reason?: string;
  /** The Foo-Spec trailer's declared packet ("specs/..." or "none"), if any. */
  declares_packet: string | null;
}

// Strip the boilerplate a PR body carries (badges, images, HTML comments, the
// generated-with footer, horizontal rules) so it does not become intent, and
// lift the Foo-Spec trailer out as a declared-packet signal rather than intent.
function cleanPrBody(body: string): { text: string; declaresPacket: string | null } {
  const kept: string[] = [];
  let declares: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    const trailer = t.match(/^Foo-Spec:\s*(\S+)/);
    if (trailer) {
      declares = trailer[1];
      continue;
    }
    if (!t) {
      kept.push(line);
      continue;
    }
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(t)) continue; // badge / image markdown
    if (/^\[!\[/.test(t)) continue; // linked badge image ([![alt](img)](href))
    if (/shields\.io|\/badge\//i.test(t)) continue; // CI/tooling badges
    if (/^<!--.*-->$/.test(t)) continue; // html comment
    if (/^-{3,}$/.test(t) || /^={3,}$/.test(t)) continue; // horizontal rule
    if (/^(?:🤖|generated with|built with|compound engineering|claude code)/i.test(t)) continue;
    // Checklist items carry intent in their label — keep the label, drop the box.
    if (/^[-*]\s*\[[ xX]\]/.test(t)) {
      kept.push(t.replace(/^[-*]\s*\[[ xX]\]\s*/, ""));
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), declaresPacket: declares };
}

// Redact + injection-screen one free-text block, returning inert intent text or
// null when the block is a secret quarantine, an injection, or noise. Mirrors the
// per-block discipline of distillIntent so PR text stays evidence, never an
// instruction.
function safeIntentText(
  block: string,
  agg: { findings: RedactionFinding[]; stripped: string[]; quarantined: { v: boolean } },
): string | null {
  const { redacted, report } = redactPromptText(block);
  agg.findings.push(...report.findings);
  agg.quarantined.v = agg.quarantined.v || report.quarantined;
  const screen = neutralizeUntrustedText(redacted);
  agg.stripped.push(...screen.stripped_directives);
  if (screen.triggered) return null; // a screened block is quarantined whole
  const text = screen.inert_text.trim();
  if (!text || isNoise(text)) return null;
  return text;
}

export function recoverPrIntent(pr: PrArtifact): RecoveredIntent {
  const items: RecoveredIntentItem[] = [];
  const agg = { findings: [] as RedactionFinding[], stripped: [] as string[], quarantined: { v: false } };
  let seq = 0;
  const add = (text: string, judgment: JudgmentType, source: IntentSource): void => {
    seq += 1;
    items.push({ id: `ri-${String(seq).padStart(3, "0")}`, text, judgment, source });
  };

  // 1. Title — the author's one-line statement of intent (agent-inference: we are
  //    reading their summary, not asserting it as agreed).
  const title = (pr.title ?? "").trim();
  if (title && !isNoise(title) && !/^(wip|update|fix|misc|changes?)$/i.test(title)) {
    const safe = safeIntentText(title, agg);
    if (safe) add(safe, "agent-inference", "pr-title");
  }

  // 2. Body — cleaned of boilerplate, distilled block by block.
  const { text: cleanedBody, declaresPacket } = cleanPrBody(pr.body ?? "");
  for (const block of splitPromptBlocks(cleanedBody)) {
    const safe = safeIntentText(block, agg);
    if (safe) add(safe, "agent-inference", "pr-body");
  }

  // 3. Linked tracker issue — approved connected-source context, not the agent's
  //    inference. Directional, still to be verified against repo-truth.
  const issue = pr.linked_issue;
  if (issue) {
    const issueText = [issue.title, issue.body].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
    for (const block of splitPromptBlocks(issueText)) {
      const safe = safeIntentText(block, agg);
      if (safe) add(safe, "approved-context", "linked-issue");
    }
  }

  const redaction: RedactionReport = {
    findings: agg.findings,
    quarantined: agg.quarantined.v,
    redacted_count: agg.findings.length,
  };
  const screening: ScreeningReport = { triggered: agg.stripped.length > 0, stripped: agg.stripped };

  return {
    recovered: items.length > 0,
    items,
    redaction,
    screening,
    declares_packet: declaresPacket,
    reason: items.length > 0 ? undefined : "intent could not be recovered — the PR title and body are too thin to distill a contract (this is honest, not a hallucinated intent)",
  };
}

// Compose a spec-after report from recovered PR intent + the PR's changed-file
// behavior, so `foo reconcile --adopt` can canonize a validating packet through
// the existing spec-after machinery (T-004). Recovered items enter as the
// `intent` side; the behavior side is code-derived.
export function buildReconcileSpecAfterReport(opts: {
  target: string;
  recovered: RecoveredIntent;
  behavior: BehaviorStory[];
  coverage: ExtractionCoverage;
  source?: string;
}): SpecAfterReport {
  const intent: IntentItem[] = opts.recovered.items.map((item, index) => ({
    id: item.id,
    text: item.text,
    source: "prompt",
    raw_index: index,
  }));
  return {
    schema_version: "0.1",
    tier: "v0a",
    target: opts.target,
    consent: { available: true, ingested: true },
    prompt_context: { mode: "summary", captured: true, source: opts.source },
    redaction: opts.recovered.redaction,
    screening: opts.recovered.screening,
    intent,
    behavior: opts.behavior,
    coverage: opts.coverage,
    drift: suggestDrift(intent, opts.behavior),
    pull_through: {
      next: `foo asp reconcile ${opts.target}`,
      note: "Adopted from a packet-free reconcile run — the recovered intent is provisional (agent-inference); reconcile keeps it honest to the code.",
    },
  };
}

// --- Deterministic drift suggestion (non-authoritative) ----------------------

const STOPWORDS = new Set([
  "that", "this", "with", "from", "into", "your", "have", "want", "need", "make", "made", "adds",
  "added", "should", "would", "also", "then", "when", "what", "where", "which", "they", "them",
  "their", "there", "here", "using", "uses", "code", "file", "files", "function", "functions",
  "feature", "change", "changes", "please", "like", "just", "some", "thing", "things", "work",
]);

function intentKeywords(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
  return new Set(tokens);
}

function splitIdent(symbol: string): string[] {
  const spaced = symbol.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const parts = spaced.split(/\s+/).filter((p) => p.length >= 4);
  return [symbol.toLowerCase(), ...parts];
}

function behaviorKeywords(story: BehaviorStory): Set<string> {
  const out = new Set<string>();
  for (const symbol of [...story.added_symbols, ...story.removed_symbols]) {
    for (const token of splitIdent(symbol)) {
      if (token.length >= 4 && !STOPWORDS.has(token)) out.add(token);
    }
  }
  const base = (story.file.split("/").pop() ?? story.file).replace(/\.[^.]+$/, "");
  for (const token of base.split(/[^a-z0-9]+/i)) {
    const t = token.toLowerCase();
    if (t.length >= 4 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

function truncate(text: string, max = 64): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Deterministic structural drift SUGGESTION. Surfaces the unmatched residue —
 * INTENT-ONLY (asked, not built) and CODE-ONLY (built, not asked) — and leaves
 * every matched pair UNREVIEWED for the human. It never emits AGREE/DRIFT: V0a
 * does not auto-classify (packet Decisions; R-004/R-008).
 */
export function suggestDrift(intent: IntentItem[], behavior: BehaviorStory[]): DriftItem[] {
  const intentKw = intent.map((item) => ({ item, kw: intentKeywords(item.text) }));
  const behaviorKw = behavior.map((story) => ({ story, kw: behaviorKeywords(story) }));
  const matched = new Set<string>();
  const items: DriftItem[] = [];

  for (const { item, kw } of intentKw) {
    const hit = behaviorKw.find((b) => overlaps(kw, b.kw));
    if (hit) {
      matched.add(hit.story.id);
      items.push({
        category: "UNREVIEWED",
        intent_ref: item.id,
        behavior_ref: hit.story.id,
        label: `asked & built — confirm AGREE or flag DRIFT: "${truncate(item.text)}" ~ ${hit.story.title}`,
        provenance: "suggested-structural",
      });
    } else {
      items.push({
        category: "INTENT_ONLY",
        intent_ref: item.id,
        behavior_ref: null,
        label: `you asked for this; not found in the build: "${truncate(item.text)}"`,
        provenance: "suggested-structural",
      });
    }
  }

  for (const { story } of behaviorKw) {
    if (matched.has(story.id)) continue;
    items.push({
      category: "CODE_ONLY",
      intent_ref: null,
      behavior_ref: story.id,
      label: `built but never asked for: ${story.title}`,
      provenance: "suggested-structural",
    });
  }

  return items;
}

// --- Core flow + renderer ----------------------------------------------------

export function runSpecAfter(input: SpecAfterInput): SpecAfterReport {
  const { stories, coverage } = extractBehaviorStories(input.diff);
  const hasPrompts = Boolean(input.promptsText && input.promptsText.trim());
  const captured = hasPrompts && input.consent;

  let intent: IntentItem[] = [];
  let redaction = emptyRedaction();
  let screening = emptyScreening();
  if (captured) {
    const distilled = distillIntent(input.promptsText!);
    intent = distilled.items;
    redaction = distilled.redaction;
    screening = distilled.screening;
  }
  const drift = suggestDrift(intent, stories).map((item) =>
    !captured && item.category === "CODE_ONLY"
      ? { ...item, label: item.label.replace(/^built but never asked for:/, "built; requested intent unavailable:") }
      : item,
  );

  return {
    schema_version: "0.1",
    tier: "v0a",
    target: input.target,
    consent: {
      available: hasPrompts,
      ingested: captured,
      reason: !hasPrompts ? "prompt-file capture unavailable; no approved prompt context" : !input.consent ? "opt-in required (--consent)" : undefined,
    },
    prompt_context: { mode: captured ? "raw" : "metadata", captured, source: input.source },
    redaction,
    screening,
    intent,
    behavior: stories,
    coverage,
    drift,
    pull_through: {
      next: "foo asp reconcile <packet>",
      note: "The win isn't this one-shot report — it's advancing into the reconcile loop so the spec stays honest to the code as it changes.",
    },
  };
}

function driftSection(report: SpecAfterReport): string[] {
  const lines: string[] = [
    report.prompt_context.captured
      ? "Drift report — what your agent built, and where it diverged from what you asked:"
      : "Drift report — behavior found in the local Git diff; requested intent is unavailable:",
  ];
  const order: DriftCategory[] = ["INTENT_ONLY", "CODE_ONLY", "UNREVIEWED"];
  const marks: Record<DriftCategory, string> = { INTENT_ONLY: "  ⚠ ", CODE_ONLY: "  ⚠ ", UNREVIEWED: "  • " };
  let any = false;
  for (const category of order) {
    for (const item of report.drift.filter((d) => d.category === category)) {
      any = true;
      lines.push(`${marks[category]}[${category}] ${item.label}`);
    }
  }
  if (!any) lines.push("  (no intent or behavior to reconcile yet)");
  lines.push("  note: deterministic keyword-overlap suggestions — you reconcile. V0a does not auto-classify or canonize.");
  return lines;
}

export function renderSpecAfterReport(report: SpecAfterReport): string {
  const lines: string[] = [];
  lines.push(`foo spec — spec-after drift report (${report.tier})`);
  lines.push(`target: ${report.target}`);
  lines.push("");

  // Lead with the drift report (packet Decisions: Positioning).
  lines.push(...driftSection(report));
  lines.push("");

  // Capture + safety status.
  if (report.consent.ingested) {
    const q = report.redaction.quarantined ? " — QUARANTINED tokens need a human pass before canonization" : "";
    lines.push(
      `Capture: ingested ${report.intent.length} intent item(s) from ${report.prompt_context.source ?? "prompts"} → ` +
        `${report.redaction.redacted_count} redaction(s)${q}. Raw prompts are run-scoped and never committed.`,
    );
    if (report.screening.triggered) {
      lines.push(
        `  ${report.screening.stripped.length} injected directive(s) neutralized as inert data (untrusted prompt stream, R-006).`,
      );
    }
  } else if (report.consent.available) {
    lines.push(
      `Capture: prompts available from ${report.prompt_context.source ?? "prompts"} but NOT ingested (${report.consent.reason}). ` +
        "Re-run with --consent to ingest; prompts are redacted and never committed.",
    );
  } else {
  }
  lines.push(
    `Coverage: ${report.coverage.story_files} behavior stor${report.coverage.story_files === 1 ? "y" : "ies"} ` +
      `from ${report.coverage.scanned_files} changed section(s); skipped ${report.coverage.skipped.length}` +
      `${report.coverage.skipped.length ? ` (${report.coverage.skipped.map((s) => `${s.file}:${s.reason}`).join(", ")})` : ""}.`,
  );
  lines.push("");

  if (report.intent.length) {
    lines.push(`Intent (${report.intent.length}):`);
    for (const item of report.intent) lines.push(`  ${item.id}: ${item.text}`);
    lines.push("");
  }
  if (report.behavior.length) {
    lines.push(`Behavior (${report.behavior.length}):`);
    for (const story of report.behavior) lines.push(`  ${story.id}: ${story.expected_behavior}`);
    lines.push("");
  }

  lines.push("Next — pull through into the loop:");
  lines.push(`  ${report.pull_through.next}`);
  lines.push(`  ${report.pull_through.note}`);
  return lines.join("\n");
}

// --- CLI wrapper -------------------------------------------------------------

export interface SpecFromOptions {
  consent: boolean;
  out?: string;
  json: boolean;
}

export function parseSpecFromArgs(args: string[]): SpecFromOptions {
  const options: SpecFromOptions = { consent: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
      const value = args[index + 1];
      if (!value) throw new Error("--out requires a path");
      options.out = value;
      index += 1;
      continue;
    }
    if (arg === "--consent" || arg === "--yes") {
      options.consent = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    // Name a flag, never a value. An unrecognized value is very often a path
    // the caller did not mean to publish — `--from-prompts <private-file>` used
    // to be refused before parsing, and echoing the stray operand back into an
    // error message (and from there into logs) would reintroduce exactly the
    // leak that guard existed to prevent.
    throw new Error(
      arg.startsWith("--")
        ? `unknown spec from argument: ${arg}`
        : "unknown spec from argument: unexpected value (pass --help to see the supported flags)",
    );
  }
  return options;
}

/**
 * These probes are *expected* to fail — that is how they answer their question. gitRun echoes the
 * child's stderr to the parent by default, so without this a routine "is this a revision?" check
 * spits a raw `git fatal:` at the user mid-report. Silence the channel; keep the answer.
 */
const QUIET: GitRunOptions = { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 };

/** Does this argument name something git can actually diff? A revision, or an `a..b` range. */
function isGitRevision(root: string, target: string): boolean {
  const ends = target.includes("..") ? target.split(/\.{2,3}/).filter(Boolean) : [target];
  if (ends.length === 0) return false;
  return ends.every(
    (end) => gitRunOrNull(["-C", root, "rev-parse", "--verify", "--quiet", `${end}^{commit}`], QUIET) !== null,
  );
}

/**
 * `foo spec from <what-you-built>` is documented — in `foo --help` and in AGENTS.md — as taking a
 * plain-English description of the work. It used to pass that description straight to `git diff`,
 * which meant the documented usage died on a raw `git fatal: ambiguous argument`. Following your own
 * tool's help text into a stack trace is the fastest way to lose someone on their first run.
 *
 * So: resolve the argument as a revision first. If git knows it, diff it. If it doesn't, the argument
 * is what it says it is — a description — and the thing the user means by "what I built" is the work
 * sitting in front of them: uncommitted changes, or failing that, the last commit.
 */
function gitDiff(root: string, target: string): string {
  const spec = target === "." || target === "" ? "HEAD" : target;

  if (isGitRevision(root, spec)) {
    const result = gitRun(["-C", root, "diff", spec], { maxBuffer: 32 * 1024 * 1024 });
    if (!result.ok) throw new Error(result.message);
    return result.stdout;
  }

  const working = gitRunOrNull(["-C", root, "diff", "HEAD"], { maxBuffer: 32 * 1024 * 1024 }) ?? "";
  const untracked = untrackedDiff(root);
  const uncommitted = `${working}${untracked}`;
  if (uncommitted.trim()) return uncommitted;

  const lastCommit = gitRunOrNull(["-C", root, "diff", "HEAD~1..HEAD"], QUIET);
  if (lastCommit && lastCommit.trim()) return lastCommit;

  return "";
}

/**
 * `git diff HEAD` does not show untracked files, so a brand-new file — an entire new module, the
 * whole point of most "what did my agent just build" questions — was invisible to the drift report.
 * It would cheerfully tell you nothing had changed while a new service sat on disk.
 *
 * Synthesize a diff for each untracked file instead. `--no-index` against /dev/null gives a real
 * unified diff and mutates nothing; `git add -N` would also work but writes to the user's index,
 * and a tool that silently stages your files to answer a question is not one you keep.
 */
function untrackedDiff(root: string): string {
  const listing = gitRunOrNull(["-C", root, "ls-files", "--others", "--exclude-standard"]);
  if (!listing) return "";
  const files = listing.split("\n").map((line) => line.trim()).filter(Boolean);

  let out = "";
  for (const file of files) {
    // --no-index exits 1 when the files differ, which is the normal case here, so read stdout
    // regardless of exit status rather than treating "they differ" as a failure.
    const result = gitRun(["-C", root, "diff", "--no-index", "--", "/dev/null", file], QUIET);
    if (result.stdout) out += result.stdout;
  }
  return out;
}

export function runSpecFrom(root: string, target: string, args: string[]): string {
  const options = parseSpecFromArgs(args);
  const diff = gitDiff(root, target);

  const report = runSpecAfter({ target, diff, consent: options.consent });
  const rendered = options.json ? JSON.stringify(report, null, 2) : renderSpecAfterReport(report);
  const body = rendered.endsWith("\n") ? rendered : `${rendered}\n`;

  if (options.out) {
    // B1: only the redacted report is persisted; raw prompts stay run-scoped.
    writeFileSync(path.resolve(root, options.out), body);
    return `${body}\nWrote redacted report to ${options.out} (raw prompts not persisted).\n`;
  }
  return body;
}

// --- Keep-it nudge (R-001): an advisory post-commit trigger ------------------
// Signal, not a gate. A post-commit hook calls `foo spec nudge`; when the commit
// shipped product code with no spec link, it suggests capturing intent while the
// session is still live. It never blocks — post-commit runs after the commit,
// and the renderer is advisory text only (signals-over-gates-v0).

export interface NudgeInput {
  changedFiles: string[];
  message: string;
  parentCount: number;
}

export interface NudgeDecision {
  nudge: boolean;
  reason: string;
  codeFiles: string[];
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|cs|swift|kt|scala|sh)$/i;
const NON_CODE_PREFIX = /^(specs\/|docs\/|dist\/|node_modules\/|\.githooks\/)/;
const FOO_SPEC_TRAILER = /^Foo-Spec:/m;
const SKIP_SUBJECT = /^(merge|chore|docs)\b/i;

function isCodeFile(file: string): boolean {
  return CODE_EXT.test(file) && !NON_CODE_PREFIX.test(file);
}

export function shouldNudgeSpecAfter(input: NudgeInput): NudgeDecision {
  const codeFiles = input.changedFiles.filter(isCodeFile);
  if (input.parentCount >= 2) return { nudge: false, reason: "merge commit", codeFiles };
  if (FOO_SPEC_TRAILER.test(input.message)) return { nudge: false, reason: "already spec-linked (Foo-Spec trailer)", codeFiles };
  const subject = input.message.split(/\r?\n/, 1)[0] ?? "";
  if (SKIP_SUBJECT.test(subject)) return { nudge: false, reason: "chore/docs/merge subject", codeFiles };
  if (codeFiles.length === 0) return { nudge: false, reason: "no product code changed", codeFiles };
  return { nudge: true, reason: "code shipped without a spec link", codeFiles };
}

export function renderSpecNudge(decision: NudgeDecision): string {
  const n = decision.codeFiles.length;
  return [
    "foo · spec-after nudge (advisory — your commit is unchanged)",
    `  You shipped ${n} code file${n === 1 ? "" : "s"} with no spec link. Review the local Git behavior now:`,
    "    foo spec from HEAD~1..HEAD",
    "  Leads with behavior-only drift: the report compares the diff against the packet, not against prompts.",
    "  Signal, not a gate — silence with FOO_SPEC_NUDGE=0.",
  ].join("\n");
}

export function runSpecNudge(root: string): string {
  // fail open: outside a repo or no HEAD -> no nudge
  const shown = gitRunOrNull(["-C", root, "show", "--name-only", "--pretty=format:", "HEAD"]);
  if (shown === null) return "";
  const changedFiles = shown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const message = gitRunOrNull(["-C", root, "log", "-1", "--pretty=%B"]);
  if (message === null) return "";
  const parentsOut = gitRunOrNull(["-C", root, "show", "-s", "--pretty=%P", "HEAD"]);
  if (parentsOut === null) return "";
  const parents = parentsOut.trim();
  const parentCount = parents ? parents.split(/\s+/).length : 0;
  const decision = shouldNudgeSpecAfter({ changedFiles, message, parentCount });
  return decision.nudge ? `${renderSpecNudge(decision)}\n` : "";
}

// --- V0b: multi-type QA panel (T-007, R-007) ---------------------------------
// Deterministic, review-only lenses over the drift report. The lens set is a
// FIXED constant: prompt content must never change which lenses run (R-006 —
// the panel's composition is part of the trusted computing base, the captured
// stream is not). Findings are emitted, never applied; a security finding
// hard-blocks canonization until a human accepts it with an attributed,
// append-only ledger record.

export type PanelLens = "correctness" | "security-safety" | "intent-fidelity" | "subtraction-red-team";

export const PANEL_LENSES: readonly PanelLens[] = [
  "correctness",
  "security-safety",
  "intent-fidelity",
  "subtraction-red-team",
] as const;

export interface PanelFinding {
  id: string;
  lens: PanelLens;
  severity: "hard-block" | "finding";
  label: string;
  refs: { drift_ref?: string; behavior_ref?: string };
}

export interface PanelResult {
  schema_version: "0.1";
  lenses: readonly PanelLens[];
  findings: PanelFinding[];
  security_blocked: boolean;
}

export function runQaPanel(report: SpecAfterReport): PanelResult {
  const findings: PanelFinding[] = [];
  let n = 0;
  const add = (lens: PanelLens, severity: PanelFinding["severity"], label: string, refs: PanelFinding["refs"] = {}) => {
    n += 1;
    findings.push({ id: `F-${String(n).padStart(3, "0")}`, lens, severity, label, refs });
  };

  // security-safety: quarantined secret-shaped tokens are a hard-block — the
  // stream cannot be canonized until a human clears the quarantine.
  if (report.redaction.quarantined) {
    add("security-safety", "hard-block", "quarantined secret-shaped token(s) in the captured stream need a human pass before canonization");
  }
  // Neutralized injections are audited, not executed (R-006): reviewable, not a block.
  if (report.screening.triggered) {
    add("security-safety", "finding", `${report.screening.stripped.length} injected directive(s) were neutralized as inert data — review before trusting distilled intent`);
  }

  for (const item of report.drift) {
    if (item.category === "CODE_ONLY") {
      add("correctness", "finding", `behavior with no stated intent: ${item.label}`, { behavior_ref: item.behavior_ref ?? undefined });
      add("subtraction-red-team", "finding", `unrequested change — candidate for subtraction or an intent backfill: ${item.label}`, { behavior_ref: item.behavior_ref ?? undefined });
    }
    if (item.category === "INTENT_ONLY") {
      add("intent-fidelity", "finding", `stated intent with no observed implementation: ${item.label}`, { drift_ref: item.intent_ref ?? undefined });
    }
    if (item.category === "UNREVIEWED") {
      add("correctness", "finding", `unreviewed pairing — verify before canonizing: ${item.label}`, { drift_ref: item.intent_ref ?? undefined, behavior_ref: item.behavior_ref ?? undefined });
    }
  }

  return {
    schema_version: "0.1",
    lenses: PANEL_LENSES,
    findings,
    security_blocked: findings.some((f) => f.severity === "hard-block"),
  };
}

// Accept-as-known: an attributed, append-only ledger record on the TARGET
// packet. Never called by the panel or canonize themselves — a human invokes
// it, and canonize only honors accepts that are already on the ledger.
export function acceptPanelFinding(
  packetDir: string,
  opts: { finding_id: string; lens: PanelLens; label: string; by: string; reason: string; at: string },
): void {
  if (!opts.by.trim() || !opts.reason.trim()) throw new Error("accept-as-known needs --by <who> and --reason <why>");
  const record = {
    specversion: "0.1",
    id: `evt_specafter_accept_${opts.finding_id}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    source: "agent://foo/spec-after",
    type: "com.adaptivespec.specafter.finding_accepted",
    subject: `finding:${opts.finding_id}`,
    time: opts.at,
    actor: { type: "human", id: opts.by, mode: "human-in-loop" },
    data: { finding_id: opts.finding_id, lens: opts.lens, label: opts.label, reason: opts.reason },
    extensions: {},
  };
  appendFileSync(path.join(packetDir, "events.jsonl"), `${JSON.stringify(record)}\n`);
}

export function acceptedFindingIds(packetDir: string): Set<string> {
  const file = path.join(packetDir, "events.jsonl");
  if (!existsSync(file)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "com.adaptivespec.specafter.finding_accepted" && evt.data?.finding_id) ids.add(String(evt.data.finding_id));
    } catch {
      // tolerate foreign ledger lines
    }
  }
  return ids;
}

// --- V0b: confirm-batch canonization (T-008/T-009, R-008/R-009/R-010) --------
// The AGREE batch is every intent↔behavior pair the deterministic overlap
// suggests MATCHES. Nothing auto-canonizes: the whole batch is surfaced to a
// human, and only an explicit confirm (with attribution) canonizes it — that is
// where a near-AGREE drift gets caught by human eyes (C-008). Canonization
// writes a real packet and registers it with the reconcile loop (C-009).

export interface AgreePair {
  intent_ref: string;
  behavior_ref: string;
  label: string;
}

export function computeAgreeBatch(report: SpecAfterReport): AgreePair[] {
  // The deterministic join marks suggested matches UNREVIEWED — those pairs ARE
  // the AGREE candidates, and every one goes through human eyes at the confirm
  // batch (a near-AGREE that merely overlaps keywords is caught there, C-008).
  return report.drift
    .filter((d) => d.category === "UNREVIEWED" && d.intent_ref && d.behavior_ref)
    .map((d) => ({ intent_ref: d.intent_ref!, behavior_ref: d.behavior_ref!, label: d.label }));
}

export interface CanonizeOptions {
  packetName: string;
  confirmBatch: boolean;
  by?: string;
  at: string;
}

export interface CanonizeResult {
  canonized: boolean;
  reason?: string;
  packetDir?: string;
  agree_batch: AgreePair[];
  blocking: PanelFinding[];
}

export function canonizeSpecAfter(root: string, report: SpecAfterReport, panel: PanelResult, opts: CanonizeOptions): CanonizeResult {
  const agree = computeAgreeBatch(report);
  const relDir = opts.packetName.includes("/") ? opts.packetName : path.posix.join("specs", opts.packetName);
  const packetDir = path.resolve(root, relDir);

  // Security hard-blocks refuse canonization unless each carries a prior
  // attributed accept on the target packet's ledger (never silent, C-007).
  const accepted = existsSync(packetDir) ? acceptedFindingIds(packetDir) : new Set<string>();
  const blocking = panel.findings.filter((f) => f.severity === "hard-block" && !accepted.has(f.id));
  if (blocking.length > 0) {
    return { canonized: false, reason: `security hard-block: ${blocking.map((f) => f.id).join(", ")} — accept-as-known (attributed) or resolve before canonizing`, agree_batch: agree, blocking };
  }

  // No silent AGREE: the batch canonizes only under an explicit, attributed
  // human confirm. This is the moment a seeded near-AGREE is caught (C-008).
  if (!opts.confirmBatch || !opts.by?.trim()) {
    return { canonized: false, reason: "confirm-batch required: review the AGREE batch and re-run with --confirm-batch --by <who>", agree_batch: agree, blocking: [] };
  }

  if (existsSync(path.join(packetDir, "spec.md"))) {
    return { canonized: false, reason: `refusing to overwrite existing packet: ${relDir}`, agree_batch: agree, blocking: [] };
  }
  mkdirSync(packetDir, { recursive: true });

  const base = path.basename(packetDir);
  const specId = base.replace(/-/g, "_");
  const isoDate = opts.at.slice(0, 10);

  const carried = report.drift.filter((d) => d.category !== "UNREVIEWED");
  const agreeLines = agree.map((p, i) => `- R-${String(i + 1).padStart(3, "0")}: ${p.label} (confirmed AGREE, ${p.intent_ref} ↔ ${p.behavior_ref})`);
  const driftLines = carried.map((d) => `- [${d.category}] ${d.label}`);
  const intentSummary = report.prompt_context.captured
    ? `Canonized by \`foo spec canonize\` from a spec-after drift report for \`${report.target}\` — verified intent recovered from the captured prompt stream, confirmed by ${opts.by} on ${isoDate}. This spec stays live through \`foo asp reconcile\`; brand build commits with \`foo commit-trailer ${relDir}\`.`
    : `Canonized by \`foo spec canonize\` from a behavior-only spec-after report for \`${report.target}\`, confirmed by ${opts.by} on ${isoDate}. No prompt-file intent was ingested; requested intent remains unknown. This spec stays live through \`foo asp reconcile\`; brand build commits with \`foo commit-trailer ${relDir}\`.`;
  const understanding = report.prompt_context.captured
    ? "Intent was distilled from the redacted, screened prompt stream; behavior from the diff. The QA panel ran review-only (fixed lens set); no directive from the captured stream was executed."
    : "Behavior came from the local Git diff. Requested intent was not inferred from absent prompt context; the QA panel ran review-only with its fixed lens set.";
  const evidence = report.prompt_context.captured
    ? `Redacted spec-after report for ${report.target} (run-scoped; raw prompts never persisted).`
    : `Behavior-only spec-after report for ${report.target} (prompt-file capture unavailable; no prompt path was read).`;
  writeFileSync(
    path.join(packetDir, "spec.md"),
    `---\nspec_id: ${specId}\ntitle: ${base}\nmode: capability\nlifecycle: draft\nstage: shaping\nowner: product\nautonomy: human-in-loop\nupdated: ${isoDate}\n---\n\n# ${base}\n\n## Intent\n\n${intentSummary}\n\n## Current Understanding\n\n${understanding}\n\n## Requirements\n\n${agreeLines.length ? agreeLines.join("\n") : "- (no confirmed AGREE pairs — drift-only capture)"}\n\n## Decisions\n\n- Canonized via explicit human confirm-batch by ${opts.by} at ${opts.at}; no category auto-canonized.\n\n## Risks\n\n- Carried drift items below are unreconciled intent/behavior residue.\n\n## Validation\n\n- foo asp validate ${relDir}; drift tracked via foo asp reconcile ${relDir}.\n\n## Evidence\n\n- ${evidence}\n\n## Open Questions\n\n${driftLines.length ? driftLines.map((l) => `${l} — reconcile before promoting`).join("\n") : "- none carried"}\n`,
  );

  const taskYamlBlock = (t: {
    id: string;
    title: string;
    status: "todo" | "done";
    check: { id: string; text: string; done: boolean; proof: string | null };
  }): string[] => [
    `  - id: ${t.id}`,
    `    title: ${JSON.stringify(t.title)}`,
    `    status: ${t.status}`,
    "    agreement: agreed",
    "    stage: shaping",
    "    refs: []",
    "    depends_on: []",
    "    owner: product",
    "    autonomy: human-in-loop",
    "    do:",
    `      - ${JSON.stringify(t.title)}`,
    "    done_when:",
    `      - id: ${t.check.id}`,
    `        text: ${JSON.stringify(t.check.text)}`,
    `        done: ${t.check.done}`,
    `        proof: ${t.check.proof === null ? "null" : JSON.stringify(t.check.proof)}`,
    ...(t.status === "done"
      ? [
          "    completed:",
          `      at: ${JSON.stringify(opts.at)}`,
          `      by: ${JSON.stringify(opts.by ?? "human")}`,
          `      summary: ${JSON.stringify("confirmed AGREE at canonization")}`,
          "      event: null",
        ]
      : ["    completed: null"]),
    "    blocked: null",
    "    review:",
    "      owner: product",
    "      due: null",
    "      stale_after_days: 7",
    "    extensions: {}",
  ];

  const taskLines = [
    ...agree.map((p, i) =>
      taskYamlBlock({
        id: `T-${String(i + 1).padStart(3, "0")}`,
        title: `Keep confirmed behavior true: ${truncate(p.label, 80)}`,
        status: "done",
        check: {
          id: `C-${String(i + 1).padStart(3, "0")}`,
          text: p.label,
          done: true,
          proof: `confirmed AGREE by ${opts.by} at ${opts.at} (${p.intent_ref} ↔ ${p.behavior_ref})`,
        },
      }),
    ),
    ...carried.map((d, i) =>
      taskYamlBlock({
        id: `T-${String(agree.length + i + 1).padStart(3, "0")}`,
        title: `Reconcile drift: ${truncate(d.label, 80)}`,
        status: "todo",
        check: {
          id: `C-${String(agree.length + i + 1).padStart(3, "0")}`,
          text: `${d.category} resolved: ${d.label}`,
          done: false,
          proof: null,
        },
      }),
    ),
  ].flat();
  const tasksYaml = [
    `schema_version: "0.1"`,
    `spec_id: ${specId}`,
    `spec_ref: ${relDir}/spec.md`,
    `updated: ${JSON.stringify(opts.at)}`,
    "defaults:",
    "  autonomy: human-in-loop",
    "  stale_after_days:",
    "    suggested: 7",
    "    discovered: 7",
    "ledger:",
    "  segment_order:",
    "    - events.jsonl",
    "tasks:",
    ...taskLines,
    "",
  ].join("\n");
  writeFileSync(path.join(packetDir, "tasks.yaml"), tasksYaml);

  const canonEvent = {
    specversion: "0.1",
    id: `evt_specafter_canonized_${Date.now()}`,
    source: "agent://foo/spec-after",
    type: "com.adaptivespec.specafter.canonized",
    subject: `packet:${relDir}`,
    time: opts.at,
    actor: { type: "human", id: opts.by, mode: "human-in-loop" },
    data: {
      target: report.target,
      agree_confirmed: agree.length,
      drift_carried: carried.length,
      // T-009: registration with the reconcile loop — the packet's live-ness
      // contract is `foo asp reconcile <dir>` plus spec-linked commit trailers.
      reconcile: { registered: true, command: `foo asp reconcile ${relDir}`, trailer: `foo commit-trailer ${relDir}` },
    },
    extensions: {},
  };
  writeFileSync(path.join(packetDir, "events.jsonl"), `${JSON.stringify(canonEvent)}\n`);

  return { canonized: true, packetDir, agree_batch: agree, blocking: [] };
}
