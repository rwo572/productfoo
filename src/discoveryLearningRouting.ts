import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "./vendorYaml.js";

export type LearningHomeType = "idea" | "research" | "backlog";
export type PlacementConfidence = "low" | "medium" | "high";

export type LearningDestination = {
  type: LearningHomeType;
  ref: string;
  path: string;
  title: string;
  text: string;
  blocks: string[];
};

export type LearningRouteCandidate = { destination: LearningDestination; score: number };

export type LearningClusterFinding = {
  finding_id: string;
  inbox_scope_id: string;
  headline: string;
  paraphrase: string;
  dissent?: string;
  proposal_text?: string;
};

export type LearningSignalCluster = {
  cluster_key: string;
  status: "emerging" | "eligible_for_synthesis";
  source_finding_ids: string[];
  source_scope_ids: string[];
  findings: LearningClusterFinding[];
};

export type HypothesisSynthesis = {
  source_finding_ids: string[];
  claim: string;
  dissent: string;
  falsifier: string;
  next_evidence: string;
  starting_confidence: "low" | "medium";
};

export type ValidatedHypothesisSynthesis = HypothesisSynthesis & {
  source_scope_ids: string[];
};

export type LearningRouteDecision =
  | {
      kind: "home";
      destination: LearningDestination;
      basis: "exact_ref" | "semantic";
      placement_confidence: "medium" | "high";
      why: string;
      score: number;
      margin: number;
    }
  | {
      kind: "unmatched";
      candidates: LearningRouteCandidate[];
      why: string;
    }
  | {
      kind: "hypothesis";
      claim: string;
      dissent: string;
      falsifier: string;
      next_evidence: string;
      starting_confidence: "low" | "medium";
      why: string;
    }
  | {
      kind: "unverified";
      reason: "conflict" | "insufficient_evidence" | "incomplete_hypothesis";
      candidates: LearningRouteCandidate[];
      why: string;
    };

export const LEARNING_ROUTING_POLICY = {
  semantic_minimum: 0.45,
  semantic_margin: 0.12,
  catch_all_shared_max: 5,
  synthesis_source_overlap_max: 0.82,
} as const;

const STOPWORDS = new Set([
  "about", "after", "again", "before", "being", "between", "could", "every",
  "should", "their", "there", "these", "those", "through", "with", "without",
  "would", "from", "into", "only", "that", "this", "when", "where", "which",
]);

// These are common product-label words, not distinctive concepts. They can
// still contribute to paragraph evidence, but never establish title custody.
const GENERIC_TITLE_TOKENS = new Set([
  "agent", "business", "company", "control", "enterprise", "management",
  "plane", "platform", "product", "system", "workflow",
]);

const CLUSTER_CONCEPTS = new Map<string, string>([
  ["access", "governance"], ["approval", "governance"], ["credential", "governance"],
  ["gated", "governance"], ["govern", "governance"], ["guardrail", "governance"],
  ["inspectable", "governance"], ["permission", "governance"], ["regulated", "governance"],
  ["security", "governance"], ["backlog", "portfolio"], ["command", "portfolio"],
  ["coordination", "portfolio"], ["portfolio", "portfolio"], ["prioritization", "portfolio"],
  ["steering", "portfolio"], ["visibility", "portfolio"], ["adoption", "adoption"],
  ["blocked", "adoption"], ["change", "adoption"], ["distribution", "adoption"],
  ["onboarding", "adoption"], ["restriction", "adoption"], ["automation", "process"],
  ["mining", "process"], ["process", "process"], ["recurring", "process"],
  ["variation", "process"], ["workflow", "process"],
]);

function normalizePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function titleCase(value: string): string {
  return value
    .replace(/\.md$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-v\d+$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function frontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const closing = text.indexOf("\n---", 4);
  if (closing === -1) return { meta: {}, body: text };
  const after = text.indexOf("\n", closing + 1);
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parse(text.slice(4, closing));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { meta, body: after === -1 ? "" : text.slice(after + 1) };
}

function contentBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
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

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function destinationFromFile(root: string, file: string, type: LearningHomeType, ref: string): LearningDestination {
  const text = readFileSync(file, "utf8");
  const parsed = frontmatter(text);
  const metadataTitle = typeof parsed.meta.title === "string"
    ? parsed.meta.title
    : typeof parsed.meta.idea === "string"
      ? parsed.meta.idea
      : null;
  const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim() ?? null;
  return {
    type,
    ref,
    path: normalizePath(root, file),
    title: metadataTitle?.trim() || heading || titleCase(path.basename(type === "backlog" ? path.dirname(file) : file)),
    text: parsed.body,
    blocks: contentBlocks(parsed.body),
  };
}

function isArchivedPath(root: string, file: string): boolean {
  return normalizePath(root, file).split("/").some((segment) => segment.toLowerCase() === "archive");
}

function isActivePacket(file: string): boolean {
  const { meta } = frontmatter(readFileSync(file, "utf8"));
  const lifecycle = typeof meta.lifecycle === "string" ? meta.lifecycle.trim().toLowerCase() : "";
  return !new Set(["complete", "completed", "done", "killed", "parked", "retired", "stopped"]).has(lifecycle);
}

export function buildLearningDestinationCatalog(root: string): LearningDestination[] {
  const destinations: LearningDestination[] = [];
  for (const file of markdownFiles(path.join(root, "ideas"))) {
    if (isArchivedPath(root, file)) continue;
    destinations.push(destinationFromFile(root, file, "idea", normalizePath(root, file)));
  }
  for (const file of markdownFiles(path.join(root, "research"))) {
    if (isArchivedPath(root, file)) continue;
    destinations.push(destinationFromFile(root, file, "research", normalizePath(root, file)));
  }
  const specsDir = path.join(root, "specs");
  if (existsSync(specsDir)) {
    for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(specsDir, entry.name, "spec.md");
      if (existsSync(file) && isActivePacket(file)) destinations.push(destinationFromFile(root, file, "backlog", entry.name));
    }
  }
  return destinations.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizedToken(token: string): string {
  if (/^evaluat|^evals?$/.test(token)) return "eval";
  if (/^orchestrat/.test(token)) return "orchestr";
  if (/^rout(?:e|ed|es|ing)?$/.test(token)) return "route";
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
      .map(normalizedToken),
  );
}

function normalizedText(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalizedToken).join(" ");
}

function clusterTokens(finding: LearningClusterFinding): Set<string> {
  return tokens(`${finding.headline} ${finding.paraphrase}`);
}

function clusterConcepts(finding: LearningClusterFinding): Set<string> {
  const concepts = new Set<string>();
  for (const token of clusterTokens(finding)) {
    const concept = CLUSTER_CONCEPTS.get(token);
    if (concept) concepts.add(concept);
  }
  return concepts;
}

function relatedClusterFindings(left: LearningClusterFinding, right: LearningClusterFinding): boolean {
  const leftConcepts = clusterConcepts(left);
  const rightConcepts = clusterConcepts(right);
  for (const concept of leftConcepts) if (rightConcepts.has(concept)) return true;

  const leftTokens = clusterTokens(left);
  const rightTokens = clusterTokens(right);
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap >= 3;
}

function clusterKey(findings: LearningClusterFinding[]): string {
  const sharedConcepts = [...clusterConcepts(findings[0] ?? { finding_id: "", inbox_scope_id: "", headline: "", paraphrase: "" })]
    .filter((concept) => findings.every((finding) => clusterConcepts(finding).has(concept)))
    .sort();
  return `cluster:${sharedConcepts[0] ?? "emerging"}:${findings[0]?.finding_id ?? "unknown"}`;
}

export function clusterUnmatchedLearnings(input: LearningClusterFinding[]): LearningSignalCluster[] {
  const findings = input
    .filter((finding) => /^F-\d{3}$/.test(finding.finding_id) && finding.inbox_scope_id.trim() && (finding.headline.trim() || finding.paraphrase.trim()))
    .map((finding) => ({ ...finding }))
    .sort((left, right) => left.finding_id.localeCompare(right.finding_id));
  const visited = new Set<string>();
  const clusters: LearningSignalCluster[] = [];

  for (const seed of findings) {
    if (visited.has(seed.finding_id)) continue;
    const members: LearningClusterFinding[] = [];
    const queue = [seed];
    visited.add(seed.finding_id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      for (const candidate of findings) {
        if (visited.has(candidate.finding_id) || !relatedClusterFindings(current, candidate)) continue;
        visited.add(candidate.finding_id);
        queue.push(candidate);
      }
    }
    members.sort((left, right) => left.finding_id.localeCompare(right.finding_id));
    const sourceScopeIds = [...new Set(members.map((finding) => finding.inbox_scope_id))].sort();
    clusters.push({
      cluster_key: clusterKey(members),
      status: sourceScopeIds.length >= 2 ? "eligible_for_synthesis" : "emerging",
      source_finding_ids: members.map((finding) => finding.finding_id),
      source_scope_ids: sourceScopeIds,
      findings: members,
    });
  }
  return clusters.sort((left, right) => left.cluster_key.localeCompare(right.cluster_key));
}

function tokenCoverage(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

export function validateHypothesisSynthesis(input: {
  cluster: LearningSignalCluster;
  synthesis: HypothesisSynthesis;
}): { ok: true; value: ValidatedHypothesisSynthesis } | { ok: false; reason: string } {
  if (input.cluster.status !== "eligible_for_synthesis" || input.cluster.source_scope_ids.length < 2) {
    return { ok: false, reason: "independent_calls_required" };
  }
  const actualSources = [...input.cluster.source_finding_ids].sort();
  const requestedSources = [...new Set(input.synthesis.source_finding_ids)].sort();
  if (requestedSources.length !== input.synthesis.source_finding_ids.length || requestedSources.join("\n") !== actualSources.join("\n")) {
    return { ok: false, reason: "source_set_mismatch" };
  }
  for (const key of ["claim", "dissent", "falsifier", "next_evidence"] as const) {
    const value = input.synthesis[key]?.trim();
    if (!value || value.length > 1500) return { ok: false, reason: `invalid_${key}` };
  }
  if (!new Set(["low", "medium"]).has(input.synthesis.starting_confidence)) {
    return { ok: false, reason: "invalid_starting_confidence" };
  }

  const claim = input.synthesis.claim.trim();
  const normalizedClaim = normalizedText(claim);
  for (const finding of input.cluster.findings) {
    for (const source of [finding.headline, finding.paraphrase, finding.proposal_text ?? ""]) {
      const normalizedSource = normalizedText(source);
      if (!normalizedSource) continue;
      const contained = normalizedClaim === normalizedSource
        || (normalizedClaim.length >= 40 && normalizedSource.includes(normalizedClaim))
        || (normalizedSource.length >= 40 && normalizedClaim.includes(normalizedSource));
      if (contained || tokenCoverage(claim, source) >= LEARNING_ROUTING_POLICY.synthesis_source_overlap_max) {
        return { ok: false, reason: "source_like_claim" };
      }
    }
  }

  return {
    ok: true,
    value: {
      source_finding_ids: actualSources,
      source_scope_ids: [...input.cluster.source_scope_ids],
      claim,
      dissent: input.synthesis.dissent.trim(),
      falsifier: input.synthesis.falsifier.trim(),
      next_evidence: input.synthesis.next_evidence.trim(),
      starting_confidence: input.synthesis.starting_confidence,
    },
  };
}

function blockScore(findingTokens: Set<string>, block: string): number {
  if (findingTokens.size === 0) return 0;
  const blockTokens = tokens(block);
  let overlap = 0;
  for (const token of findingTokens) if (blockTokens.has(token)) overlap += 1;
  if (overlap < 3) return 0;
  const findingCoverage = overlap / Math.min(findingTokens.size, 12);
  const blockPrecision = overlap / Math.min(blockTokens.size, 12);
  return Math.min(1, (findingCoverage * 0.6) + (blockPrecision * 0.4));
}

function titleScore(findingTokens: Set<string>, destination: LearningDestination): number {
  const coreTitle = destination.title.split(/[:—]/, 1)[0] ?? destination.title;
  const titleTokens = new Set([...tokens(coreTitle)].filter((token) => !GENERIC_TITLE_TOKENS.has(token)));
  let titleOverlap = 0;
  for (const token of titleTokens) if (findingTokens.has(token)) titleOverlap += 1;
  if (titleOverlap < 2 || titleTokens.size === 0) return 0;

  // A title echo is a useful routing label only when the document body also
  // supports the learning. This keeps a two-word coincidence from taking custody.
  const bodySupported = destination.blocks.some((block) => {
    const blockTokens = tokens(block);
    let overlap = 0;
    for (const token of findingTokens) if (blockTokens.has(token)) overlap += 1;
    return overlap >= 3;
  });
  if (!bodySupported) return 0;

  const titleCoverage = titleOverlap / titleTokens.size;
  const pairCoverage = Math.min(1, titleOverlap / 2);
  return Math.min(1, (titleCoverage * 0.75) + (pairCoverage * 0.25));
}

function semanticCandidates(findingText: string, destinations: LearningDestination[]): LearningRouteCandidate[] {
  const findingTokens = tokens(findingText);
  return destinations
    .map((destination) => ({
      destination,
      score: Math.max(
        titleScore(findingTokens, destination),
        destination.blocks.reduce((best, block) => Math.max(best, blockScore(findingTokens, block)), 0),
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.destination.path.localeCompare(right.destination.path));
}

function explicitRefs(finding: Record<string, unknown>): string[] {
  return Array.isArray(finding.explicit_refs)
    ? finding.explicit_refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
    : [];
}

function includesExactRef(destination: LearningDestination, ref: string): boolean {
  if (destination.ref === ref || destination.path === ref) return true;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(destination.text);
}

function textField(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function routeLearning(input: {
  finding: Record<string, unknown>;
  proposal?: Record<string, unknown> | null;
  destinations: LearningDestination[];
  sharedTargetCounts?: ReadonlyMap<string, number>;
}): LearningRouteDecision {
  for (const ref of explicitRefs(input.finding)) {
    const exact = input.destinations.find((destination) => includesExactRef(destination, ref));
    if (exact) {
      return {
        kind: "home",
        destination: exact,
        basis: "exact_ref",
        placement_confidence: "high",
        why: `The signal explicitly references ${ref} in ${exact.title}.`,
        score: 1,
        margin: 1,
      };
    }
  }

  const findingText = [textField(input.finding, "headline"), textField(input.finding, "paraphrase")]
    .filter(Boolean)
    .join(" ");
  const candidates = semanticCandidates(findingText, input.destinations);
  const eligible = candidates.filter((candidate) =>
    (input.sharedTargetCounts?.get(candidate.destination.path) ?? 0) <= LEARNING_ROUTING_POLICY.catch_all_shared_max,
  );
  const best = eligible[0];
  const runnerUp = eligible[1];
  const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;
  if (best && best.score >= LEARNING_ROUTING_POLICY.semantic_minimum && margin >= LEARNING_ROUTING_POLICY.semantic_margin) {
    return {
      kind: "home",
      destination: best.destination,
      basis: "semantic",
      placement_confidence: best.score >= 0.7 && margin >= 0.2 ? "high" : "medium",
      why: `${best.destination.title} is the closest supported next-action match and clears the routing margin.`,
      score: best.score,
      margin,
    };
  }
  if (best && best.score >= LEARNING_ROUTING_POLICY.semantic_minimum && runnerUp) {
    return {
      kind: "unverified",
      reason: "conflict",
      candidates: eligible.slice(0, 2),
      why: "Two destinations are similarly supported, so the primary home needs human judgment.",
    };
  }
  return {
    kind: "unmatched",
    candidates: (eligible.length ? eligible : candidates).slice(0, 2),
    why: "No existing Idea, Research, or Backlog destination cleared admission; keep this signal emerging until an independent call corroborates it.",
  };
}
