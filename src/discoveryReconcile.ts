import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDiscoveryRun, transitionDiscoveryRun, type DiscoveryWrite } from "./discoveryArtifacts.js";
import { parseDiscoveryQualifiedRef, validateDiscoveryEvidence, type DiscoveryEvidenceEnvelope, type DiscoveryEvidenceFinding } from "./discoveryEvidence.js";
import { parse, stringify } from "./vendorYaml.js";
import { classifyProvider } from "./sourceIngress.js";
import { verifyDiscoveryBundleForApply } from "./discoveryProof.js";
import { createUnreachableDiscoveryReceiptStatus, type DiscoveryReceiptStatusEndpoint } from "./discoveryProcess.js";
import type { TrustStore } from "./trustEnvelope.js";

export type DiscoveryIndexEntry = { id?: string; path: string; excerpt: string; text: string };
export type DiscoveryIndex = { entries: DiscoveryIndexEntry[] };
export type ReconciliationKind = "exact" | "semantic_candidate" | "drift_candidate" | "draft_proposal";
export type ReconciliationOutcome = {
  finding_id: string;
  kind: ReconciliationKind;
  canonical: boolean;
  target_id?: string;
  target_path?: string;
  existing_excerpt?: string;
  confidence: "low" | "medium" | "high";
  dissent: string;
};
export type ReconciliationResult = { outcomes: ReconciliationOutcome[] };

const INDEX_DIRS = ["discovery", "research", "specs"];
const INDEX_EXTENSIONS = new Set([".md", ".yaml", ".yml", ".jsonl"]);
const ID_PATTERN = /\b([RDTFCPEH]-\d{3})\b/g;
const STOPWORDS = new Set(["about", "after", "again", "before", "being", "between", "could", "every", "should", "their", "there", "these", "those", "through", "with", "without", "would", "from", "into", "only", "that", "this", "when", "where", "which"]);

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile() && INDEX_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

function excerpt(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 240);
}

// YAML frontmatter is metadata wearing a document's opening lines. Indexed
// raw, its `---` delimiter became the "first content line" of every research
// paper — so review cards showed `existing_excerpt: ---` (#529).
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const closing = text.indexOf("\n---", 4);
  if (closing === -1) return text;
  const afterDelimiter = text.indexOf("\n", closing + 1);
  return afterDelimiter === -1 ? "" : text.slice(afterDelimiter + 1);
}

// Paragraph-sized blocks, because the semantic score must mean CONCENTRATED
// overlap. Indexing each file as one whole-document bag of words meant the
// longest, most vocabulary-rich document cleared the overlap bar against
// nearly any paraphrase — 78 findings about unrelated industries all "matched"
// the same research paper (#529). A block that has no blank lines to split on
// (events.jsonl) falls back to per-line blocks so it can never re-become a
// whole-file bag.
function contentBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const paragraph of stripFrontmatter(text).split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length > 1500) {
      for (const line of trimmed.split("\n")) if (line.trim()) blocks.push(line.trim());
    } else {
      blocks.push(trimmed);
    }
  }
  return blocks;
}

export function buildDiscoveryIndex(root: string): DiscoveryIndex {
  const entries: DiscoveryIndexEntry[] = [];
  for (const dirName of INDEX_DIRS) {
    for (const file of walkFiles(path.join(root, dirName)).sort()) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const ids = [...line.matchAll(ID_PATTERN)].map((match) => match[1]);
        for (const id of ids) entries.push({ id, path: relative, excerpt: excerpt(line), text: line });
      }
      for (const block of contentBlocks(text)) {
        entries.push({ path: relative, excerpt: excerpt(block), text: block });
      }
    }
  }
  return { entries };
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
}

function semanticScore(finding: string, entry: DiscoveryIndexEntry): number {
  const left = tokens(finding);
  if (left.size === 0) return 0;
  const right = tokens(entry.text);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  if (overlap < 3) return 0;
  return overlap / left.size;
}

function exactEntry(index: DiscoveryIndex, refs: string[]): DiscoveryIndexEntry | undefined {
  // D-011 (nango-discovery-connector-v0 T-005): only a packet-qualified
  // reference can create an exact mapping, and only when it resolves to
  // exactly one record inside that packet's directory. A bare `R-001`-style
  // id is review-only — it falls through to semantic matching, and the
  // first-match behavior this function used to have (including a bare
  // substring hit on any indexed line) can never silently win for an
  // ambiguous reference (V-007).
  const resolved: DiscoveryIndexEntry[] = [];
  for (const ref of refs) {
    const qualified = parseDiscoveryQualifiedRef(ref);
    if (!qualified) continue; // bare ids and https URLs are review-only, never exact
    const packetPrefix = `specs/${qualified.packet_slug}/`;
    for (const entry of index.entries) {
      if (entry.id === qualified.record_id && entry.path.startsWith(packetPrefix)) resolved.push(entry);
    }
  }
  if (resolved.length === 0) return undefined;
  // Multiple indexed mentions of the same record within one file are one
  // record (definition plus body prose); mentions across files are ambiguous
  // and stay review-only.
  const paths = new Set(resolved.map((entry) => entry.path));
  return paths.size === 1 ? resolved[0] : undefined;
}

function outcomeFor(index: DiscoveryIndex, finding: DiscoveryEvidenceFinding): ReconciliationOutcome {
  const exact = exactEntry(index, finding.explicit_refs ?? []);
  if (exact) {
    return {
      finding_id: finding.finding_id,
      kind: finding.relationship_hint === "contradicts" ? "drift_candidate" : "exact",
      canonical: finding.relationship_hint !== "contradicts",
      target_id: exact.id,
      target_path: exact.path,
      existing_excerpt: exact.excerpt,
      confidence: "high",
      dissent: finding.dissent,
    };
  }
  let best: { entry: DiscoveryIndexEntry; score: number } | undefined;
  for (const entry of index.entries) {
    const score = semanticScore(finding.paraphrase, entry);
    if (!best || score > best.score) best = { entry, score };
  }
  if (best && best.score >= 0.35) {
    return {
      finding_id: finding.finding_id,
      kind: finding.relationship_hint === "contradicts" ? "drift_candidate" : "semantic_candidate",
      canonical: false,
      target_id: best.entry.id,
      target_path: best.entry.path,
      existing_excerpt: best.entry.excerpt,
      confidence: best.score >= 0.6 ? "high" : "medium",
      dissent: finding.dissent,
    };
  }
  return { finding_id: finding.finding_id, kind: "draft_proposal", canonical: false, confidence: "low", dissent: finding.dissent };
}

export function reconcileDiscoveryEvidence(root: string, envelope: DiscoveryEvidenceEnvelope): ReconciliationResult {
  const index = buildDiscoveryIndex(root);
  return { outcomes: envelope.findings.map((finding) => outcomeFor(index, finding)) };
}

function relativeWrite(root: string, file: string): DiscoveryWrite {
  return { path: path.relative(root, file).split(path.sep).join("/"), action: "updated" };
}

function nextArtifactId(records: Array<Record<string, unknown>>, key: string, prefix: string): string {
  const highest = records.reduce((max, record) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(record[key] ?? ""));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

export function applyDiscoveryEvidence(root: string, studyDir: string, envelope: DiscoveryEvidenceEnvelope, now: string): {
  status: "needs_review" | "clean_no_op";
  writes: DiscoveryWrite[];
  reconciliation: ReconciliationResult;
} {
  const run = loadDiscoveryRun(studyDir);
  validateDiscoveryEvidence(envelope, { expected_study_id: run.study_id, expected_lane: "study_linked" });
  const findingsPath = path.join(studyDir, "findings.yaml");
  const proposalsPath = path.join(studyDir, "proposals.yaml");
  const reportPath = path.join(studyDir, "report.md");
  const findingsDoc = parse(readFileSync(findingsPath, "utf8")) as { schema_version: string; findings: Array<Record<string, unknown>> };
  if (findingsDoc.findings.some((finding) => finding.source_fingerprint === envelope.source.source_fingerprint)) {
    return { status: "clean_no_op", writes: [], reconciliation: { outcomes: [] } };
  }
  const reconciliation = reconcileDiscoveryEvidence(root, envelope);
  // Every applied record carries its provider's registry classification so
  // reconcile renders each source's evidence by its class (RISK-002), and —
  // only when the summary is INCOMPLETE — the coverage limitation. A complete
  // summary records nothing: findings never claim a raw transcript exists.
  const classification = classifyProvider(envelope.source.provider);
  const summaryCoverage = envelope.coverage.transcript_complete === false
    ? { transcript_complete: false, caveats: [...envelope.coverage.caveats] }
    : undefined;
  const canonicalFindingIds = new Map<string, string>();
  for (const finding of envelope.findings) {
    const outcome = reconciliation.outcomes.find((candidate) => candidate.finding_id === finding.finding_id)!;
    const canonicalFindingId = nextArtifactId(findingsDoc.findings, "finding_id", "F");
    canonicalFindingIds.set(finding.finding_id, canonicalFindingId);
    findingsDoc.findings.push({
      ...finding,
      finding_id: canonicalFindingId,
      source_finding_id: finding.finding_id,
      lane: envelope.lane,
      source_provider: envelope.source.provider,
      source_category: classification.source_category,
      evidence_class: classification.evidence_class,
      ...(summaryCoverage ? { summary_coverage: summaryCoverage } : {}),
      source_url: envelope.source.stable_url ?? null,
      source_fingerprint: envelope.source.source_fingerprint,
      completed_at: envelope.source.completed_at,
      reconciliation: { ...outcome, finding_id: canonicalFindingId },
      review_state: "needs_review",
    });
  }
  writeFileSync(findingsPath, stringify(findingsDoc));

  const proposalsDoc = parse(readFileSync(proposalsPath, "utf8")) as { schema_version: string; proposals: Array<Record<string, unknown>> };
  for (const outcome of reconciliation.outcomes.filter((candidate) => candidate.kind !== "exact")) {
    const finding = envelope.findings.find((candidate) => candidate.finding_id === outcome.finding_id)!;
    proposalsDoc.proposals.push({
      proposal_id: nextArtifactId(proposalsDoc.proposals, "proposal_id", "P"),
      source_finding_ids: [canonicalFindingIds.get(finding.finding_id)!],
      proposed_text: outcome.kind === "draft_proposal" ? finding.paraphrase : null,
      rationale: outcome.kind,
      existing_artifact_candidates: outcome.target_path ? [{ path: outcome.target_path, id: outcome.target_id ?? null, excerpt: outcome.existing_excerpt ?? null }] : [],
      confidence: outcome.confidence,
      dissent: finding.dissent,
      destination: null,
      state: "needs_review",
      disposition: null,
    });
  }
  writeFileSync(proposalsPath, stringify(proposalsDoc));

  const findings = envelope.findings.map((finding) => `- ${canonicalFindingIds.get(finding.finding_id)!}: ${finding.paraphrase} (${finding.confidence})`).join("\n");
  const dissent = envelope.findings.map((finding) => `- ${canonicalFindingIds.get(finding.finding_id)!}: ${finding.dissent}`).join("\n");
  writeFileSync(reportPath, [
    "# Discovery report",
    "",
    "## Current fit belief",
    "",
    "Needs human review; automation does not decide fit.",
    "",
    "## Evidence that moved the belief",
    "",
    findings,
    "",
    "## Revised belief and confidence",
    "",
    "Pending human review.",
    "",
    "## Contradictions and dissent",
    "",
    dissent,
    "",
    "## Proposals needing review",
    "",
    ...reconciliation.outcomes.filter((candidate) => candidate.kind !== "exact").map((candidate) => `- ${candidate.finding_id}: ${candidate.kind}`),
    "",
  ].join("\n"));

  const writes = [relativeWrite(root, findingsPath), relativeWrite(root, proposalsPath), relativeWrite(root, reportPath)];
  // A study already parked in needs_review has no needs_review -> needs_review transition
  // (ALLOWED_TRANSITIONS), so re-applying a distinct-fingerprint envelope must not throw:
  // record the derived artifacts and leave the state where it already is.
  if (loadDiscoveryRun(studyDir).state !== "needs_review") {
    writes.push(...transitionDiscoveryRun(studyDir, "needs_review", { type: "agent", id: "foo-discovery" }, now));
  }
  return { status: "needs_review", writes, reconciliation };
}

// A workspace whose discovery inbox has never received evidence has no
// findings/proposals files yet — nothing created them before the first apply.
// An absent file is an empty collection, not a crash.
function readInboxYamlDoc(filePath: string): { schema_version: string; findings: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>> } {
  if (!existsSync(filePath)) return { schema_version: "0.1", findings: [], proposals: [] };
  return parse(readFileSync(filePath, "utf8")) as { schema_version: string; findings: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>> };
}

export function applyInboxDiscoveryEvidence(root: string, inboxDir: string, envelope: DiscoveryEvidenceEnvelope, now: string): {
  status: "needs_review" | "clean_no_op";
  writes: DiscoveryWrite[];
  reconciliation: ReconciliationResult;
} {
  validateDiscoveryEvidence(envelope, { expected_study_id: envelope.study_id, expected_lane: "unassigned_call_evidence" });
  const findingsPath = path.join(inboxDir, "findings.yaml");
  const proposalsPath = path.join(inboxDir, "proposals.yaml");
  const eventsPath = path.join(inboxDir, "events.jsonl");
  const findingsDoc = readInboxYamlDoc(findingsPath) as { schema_version: string; findings: Array<Record<string, unknown>> };
  const existingSourceRecords = findingsDoc.findings.filter(
    (finding) => finding.source_fingerprint === envelope.source.source_fingerprint,
  );
  if (existingSourceRecords.length > 0) {
    const existingIds = existingSourceRecords.map((finding) => String(finding.source_finding_id ?? "")).sort();
    const replayIds = envelope.findings.map((finding) => finding.finding_id).sort();
    if (existingIds.length !== replayIds.length || existingIds.some((id, index) => id !== replayIds[index])) {
      throw new Error("source replay finding set does not match the existing derived evidence");
    }

    let repaired = false;
    for (const finding of envelope.findings) {
      const recordIndex = findingsDoc.findings.findIndex(
        (candidate) =>
          candidate.source_fingerprint === envelope.source.source_fingerprint
          && candidate.source_finding_id === finding.finding_id,
      );
      const current = findingsDoc.findings[recordIndex];
      let next = current;
      if (typeof current.headline !== "string" || !current.headline.trim()) {
        const { finding_id: findingId, ...fields } = current;
        delete fields.headline;
        next = { finding_id: findingId, headline: finding.headline, ...fields };
        repaired = true;
      }
      if (
        envelope.source.stable_url
        && (typeof next.source_url !== "string" || !next.source_url.trim())
      ) {
        next = { ...next, source_url: envelope.source.stable_url };
        repaired = true;
      }
      findingsDoc.findings[recordIndex] = next;
    }
    if (!repaired) return { status: "clean_no_op", writes: [], reconciliation: { outcomes: [] } };
    writeFileSync(findingsPath, stringify(findingsDoc));
    return {
      status: "needs_review",
      writes: [relativeWrite(root, findingsPath)],
      reconciliation: { outcomes: [] },
    };
  }
  const reconciliation = reconcileDiscoveryEvidence(root, envelope);
  // Every applied record carries its provider's registry classification so
  // reconcile renders each source's evidence by its class (RISK-002), and —
  // only when the summary is INCOMPLETE — the coverage limitation. A complete
  // summary records nothing: findings never claim a raw transcript exists.
  const classification = classifyProvider(envelope.source.provider);
  const summaryCoverage = envelope.coverage.transcript_complete === false
    ? { transcript_complete: false, caveats: [...envelope.coverage.caveats] }
    : undefined;
  const canonicalFindingIds = new Map<string, string>();
  for (const finding of envelope.findings) {
    const mapped = reconciliation.outcomes.find((candidate) => candidate.finding_id === finding.finding_id)!;
    const canonicalFindingId = nextArtifactId(findingsDoc.findings, "finding_id", "F");
    canonicalFindingIds.set(finding.finding_id, canonicalFindingId);
    findingsDoc.findings.push({
      ...finding,
      finding_id: canonicalFindingId,
      source_finding_id: finding.finding_id,
      lane: "unassigned_call_evidence",
      source_provider: envelope.source.provider,
      source_category: classification.source_category,
      evidence_class: classification.evidence_class,
      ...(summaryCoverage ? { summary_coverage: summaryCoverage } : {}),
      inbox_scope_id: envelope.study_id.slice("inbox:".length),
      source_url: envelope.source.stable_url ?? null,
      source_fingerprint: envelope.source.source_fingerprint,
      completed_at: envelope.source.completed_at,
      reconciliation: { ...mapped, finding_id: canonicalFindingId },
      review_state: "needs_review",
      attached_to: null,
    });
  }
  writeFileSync(findingsPath, stringify(findingsDoc));
  const proposalsDoc = readInboxYamlDoc(proposalsPath) as { schema_version: string; proposals: Array<Record<string, unknown>> };
  for (const mapped of reconciliation.outcomes.filter((candidate) => candidate.kind !== "exact")) {
    const finding = envelope.findings.find((candidate) => candidate.finding_id === mapped.finding_id)!;
    proposalsDoc.proposals.push({
      proposal_id: nextArtifactId(proposalsDoc.proposals, "proposal_id", "P"),
      source_finding_ids: [canonicalFindingIds.get(finding.finding_id)!],
      proposed_text: mapped.kind === "draft_proposal" ? finding.paraphrase : null,
      rationale: mapped.kind,
      existing_artifact_candidates: mapped.target_path ? [{ path: mapped.target_path, id: mapped.target_id ?? null, excerpt: mapped.existing_excerpt ?? null }] : [],
      confidence: mapped.confidence,
      dissent: finding.dissent,
      destination: null,
      state: "needs_review",
      disposition: null,
    });
  }
  writeFileSync(proposalsPath, stringify(proposalsDoc));
  appendFileSync(eventsPath, `${JSON.stringify({
    specversion: "1.0",
    id: `evt_discovery_inbox_evidence_${Date.parse(now)}`,
    source: "agent://foo/discovery",
    type: "com.adaptivespec.discovery.inbox_evidence_applied",
    subject: `scope:${envelope.study_id.slice("inbox:".length)}`,
    time: now,
    actor: { type: "agent", id: "foo-discovery" },
    data: { finding_ids: envelope.findings.map((finding) => canonicalFindingIds.get(finding.finding_id)!), review_state: "needs_review" },
  })}\n`);
  return {
    status: "needs_review",
    writes: [relativeWrite(root, findingsPath), relativeWrite(root, proposalsPath), relativeWrite(root, eventsPath)],
    reconciliation,
  };
}

// --- Receipt-verified bundle apply (nango-discovery-connector-v0 T-005) ------

export type DiscoveryBundleApplyResult =
  | { status: "needs_review" | "clean_no_op"; writes: DiscoveryWrite[]; reconciliation: ReconciliationResult }
  | { status: "needs_service_verification" | "invalid"; writes: []; reason: string };

// The hosted portable-bundle apply boundary: verify everything locally
// checkable (discoveryProof gate), then ask the service `discovery_receipt_status`
// as the LAST network boundary before any write, fail closed on unreachability,
// a non-active receipt, or any revocation-epoch movement, and only then run
// the normal discovery apply — which still re-validates and stops at
// needs_review. No outcome but the two write states touches disk (C-009).
export async function applyReceiptVerifiedDiscoveryBundle(input: {
  root: string;
  target_id: string;
  studyDir: string;
  bundle: unknown;
  trust_store?: TrustStore<"foo">;
  receipt_status?: DiscoveryReceiptStatusEndpoint;
  now: string;
}): Promise<DiscoveryBundleApplyResult> {
  const verified = verifyDiscoveryBundleForApply({
    bundle: input.bundle,
    target_id: input.target_id,
    root: input.root,
    study_dir: input.studyDir,
    ...(input.trust_store ? { trust_store: input.trust_store } : {}),
    now: input.now,
  });
  if (!verified.ok) return { status: "invalid", writes: [], reason: verified.message };

  try {
    const status = await (input.receipt_status ?? createUnreachableDiscoveryReceiptStatus()).receiptStatus({
      receipt_hash: verified.receipt_hash,
      target_ref: verified.registry.target_ref,
    });
    if (status.receipt_status !== "active" || status.revocation_epoch !== verified.registry.revocation_epoch) {
      return { status: "needs_service_verification", writes: [], reason: "the discovery service could not confirm the receipt is active at the current revocation epoch; nothing was written" };
    }
  } catch {
    // Bounded by design: error text can carry provider or transport content,
    // so the refusal names the state, never the underlying error body.
    return { status: "needs_service_verification", writes: [], reason: "the discovery service is unreachable; receipt status could not be verified and nothing was written" };
  }

  try {
    const applied = verified.registry.lane === "inbox"
      ? applyInboxDiscoveryEvidence(input.root, input.studyDir, verified.bundle.envelope, input.now)
      : applyDiscoveryEvidence(input.root, input.studyDir, verified.bundle.envelope, input.now);
    return { status: applied.status, writes: applied.writes, reconciliation: applied.reconciliation };
  } catch {
    // Same boundary: a failed apply reports the bounded refusal, and no
    // partial discovery update was accepted.
    return { status: "invalid", writes: [], reason: "the verified evidence could not be applied; no partial discovery update was accepted" };
  }
}
