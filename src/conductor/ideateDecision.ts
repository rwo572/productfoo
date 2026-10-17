// Deterministic coverage and consistency checks, not a factual truth oracle.
// The harness performs the research/critique; productfoo keeps unknowns visible and
// prevents refuted premises from silently returning in a polished decision.
import { ideateContractVersion, ideateFrontmatter, parseIdeaObjects } from "./diversity.js";
import { renderOrchestrationResult, type OrchestrationResult } from "../orchestrationResult.js";

export const DECISION_CONTRACT = "decisions-v2";
type ObjectValue = Record<string, unknown>;
type Observation = { source: string; observation: string };
type ClaimReview = { claim: string; verdict: "supported" | "refuted" | "unknown"; evidence: Observation[]; consequence: string };
type Falsification = { claims: ClaimReview[]; excluded_ideas: string[] };
type Grounding = { searched: string[]; sources: { source: string; takeaway: string }[]; gap: string };
type Decision = {
  recommendation: string;
  rationale: string;
  new_contribution: string;
  builds_on: { source: string; delta: string }[];
  idea_ids: string[];
  assumptions: string[];
  confidence: { level: "low" | "medium" | "high"; reason: string };
  alternatives: { direction: string; choose_when: string; idea_ids: string[] }[];
  experiment: { action: string; effort: string; pass: string; fail: string };
  dissent: string;
  not_doing: string[];
  next_action: string;
};

const object = (v: unknown): v is ObjectValue => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !/^(TODO|null)$/i.test(v.trim());
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const normalized = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase();

export function hasDecisionContract(record: string): boolean {
  return ideateContractVersion(record) === DECISION_CONTRACT;
}

function block(record: string, name: string, errors: string[]): ObjectValue | null {
  const matches = [...record.matchAll(new RegExp("^```json " + name + "\\s*\\r?\\n([\\s\\S]*?)^```[ \\t]*$", "gm"))];
  if (matches.length !== 1) {
    errors.push(`store exactly one json ${name} block (found ${matches.length})`);
    return null;
  }
  try {
    const value: unknown = JSON.parse(matches[0][1]);
    if (object(value)) return value;
  } catch { /* The field name is sufficient; never echo arbitrary source text. */ }
  errors.push(`${name} must be a JSON object`);
  return null;
}

function fields(value: ObjectValue, names: readonly string[], label: string, errors: string[]): void {
  for (const name of names) if (!text(value[name])) errors.push(`${label}.${name} must contain text`);
}

function readFalsification(record: string, errors: string[]): Falsification | null {
  const value = block(record, "falsification", errors);
  if (!value) return null;
  const start = errors.length;
  if (!Array.isArray(value.claims)) errors.push("falsification.claims must be an array");
  else for (const [index, entry] of value.claims.entries()) {
    const at = `falsification.claims[${index}]`;
    if (!object(entry)) { errors.push(`${at} must be an object`); continue; }
    fields(entry, ["claim", "consequence"], at, errors);
    if (typeof entry.verdict !== "string" || !["supported", "refuted", "unknown"].includes(entry.verdict)) errors.push(`${at}.verdict must be supported, refuted, or unknown`);
    if (!Array.isArray(entry.evidence)) errors.push(`${at}.evidence must be an array`);
    else {
      if (entry.verdict !== "unknown" && entry.evidence.length === 0) errors.push(`${at}: ${entry.verdict} requires a cited observation`);
      for (const observation of entry.evidence) {
        if (!object(observation)) errors.push(`${at}.evidence must contain source/observation objects`);
        else fields(observation, ["source", "observation"], `${at}.evidence`, errors);
      }
    }
  }
  if (!strings(value.excluded_ideas)) errors.push("falsification.excluded_ideas must be an array of idea IDs");
  return errors.length === start ? value as unknown as Falsification : null;
}

export function checkFalsification(record: string): string[] {
  if (!hasDecisionContract(record)) return ["early falsification requires a decisions-v2 record; older records cannot prove this check"];
  const errors: string[] = [];
  if ([...record.matchAll(/```json ideas\s*\n/g)].length !== 1) errors.push("store exactly one json ideas block before checking claims");
  const review = readFalsification(record, errors);
  const parsed = parseIdeaObjects(record);
  if (!parsed.present || !parsed.ideas.length) errors.push("store the idea pool before checking its claims");
  errors.push(...parsed.errors);
  if (!review) return errors;
  const claims = new Map<string, ClaimReview>();
  for (const claim of review.claims) {
    const key = normalized(claim.claim);
    if (claims.has(key)) errors.push(`duplicate claim review: ${claim.claim}`);
    claims.set(key, claim);
  }
  const ids = new Set(parsed.ideas.map((idea) => idea.id));
  for (const id of review.excluded_ideas) if (!ids.has(id)) errors.push(`excluded idea does not exist: ${id}`);
  const used = new Set<string>();
  for (const idea of parsed.ideas) {
    for (const claim of idea.claims_relied_on) {
      const key = normalized(claim);
      used.add(key);
      if (!text(claim)) { errors.push(`${idea.id}: claims_relied_on contains an empty claim`); continue; }
      const reviewed = claims.get(key);
      if (!reviewed) errors.push(`${idea.id}: unreviewed claim: ${claim}`);
      else if (reviewed.verdict === "refuted" && !review.excluded_ideas.includes(idea.id)) errors.push(`${idea.id}: refuted premise requires exclusion; revise as a new idea with corrected claims`);
    }
  }
  for (const [key, claim] of claims) if (!used.has(key)) errors.push(`review names a claim absent from the stored pool: ${claim.claim}`);
  return errors;
}

function readGrounding(record: string, errors: string[]): Grounding | null {
  const value = block(record, "grounding", errors);
  if (!value) return null;
  const start = errors.length;
  if (!strings(value.searched) || !value.searched.length) errors.push("grounding.searched must name the local locations actually searched");
  if (!Array.isArray(value.sources)) errors.push("grounding.sources must be an array");
  else for (const source of value.sources) {
    if (!object(source)) errors.push("grounding.sources must contain source/takeaway objects");
    else fields(source, ["source", "takeaway"], "grounding.sources", errors);
  }
  fields(value, ["gap"], "grounding", errors);
  return errors.length === start ? value as unknown as Grounding : null;
}

function readDecision(record: string, errors: string[]): Decision | null {
  const value = block(record, "decision", errors);
  if (!value) return null;
  const start = errors.length;
  fields(value, ["recommendation", "rationale", "new_contribution", "dissent", "next_action"], "decision", errors);
  for (const key of ["idea_ids", "assumptions", "not_doing"] as const) {
    if (!strings(value[key])) errors.push(`decision.${key} must be an array of non-empty strings`);
  }
  if (Array.isArray(value.not_doing) && !value.not_doing.length) errors.push("decision.not_doing must name a cut");
  if (!object(value.confidence) || typeof value.confidence.level !== "string" || !["low", "medium", "high"].includes(value.confidence.level) || !text(value.confidence.reason)) errors.push("decision.confidence requires level (low/medium/high) and reason");
  if (!object(value.experiment)) errors.push("decision.experiment must be an object");
  else fields(value.experiment, ["action", "effort", "pass", "fail"], "decision.experiment", errors);
  if (!Array.isArray(value.alternatives) || value.alternatives.length > 2) errors.push("decision.alternatives must contain at most 2 alternatives");
  else for (const alt of value.alternatives) {
    if (!object(alt)) { errors.push("decision.alternatives must contain objects"); continue; }
    fields(alt, ["direction", "choose_when"], "decision.alternatives", errors);
    if (!strings(alt.idea_ids) || !alt.idea_ids.length) errors.push("each alternative must identify its source ideas");
  }
  if (!Array.isArray(value.builds_on) || value.builds_on.length > 3) errors.push("decision.builds_on must contain at most 3 prior-work references");
  else for (const source of value.builds_on) {
    if (!object(source)) errors.push("decision.builds_on must contain source/delta objects");
    else fields(source, ["source", "delta"], "decision.builds_on", errors);
  }
  return errors.length === start ? value as unknown as Decision : null;
}

function resultFrom(decision: Decision, review: Falsification): OrchestrationResult {
  // The page carries enough to understand the refutation and find its source;
  // raw observations remain complete in the record and never consume its budget.
  const short = (value: string) => {
    const words = value.trim().split(/\s+/);
    const excerpt = words.slice(0, 35).join(" ").slice(0, 280);
    return excerpt.length < value.trim().length ? `${excerpt}…` : excerpt;
  };
  const refuted = review.claims.filter((claim) => claim.verdict === "refuted");
  return {
    recommendation: [decision.recommendation, decision.rationale, `What this adds: ${decision.new_contribution}`,
      ...decision.builds_on.map((s) => `Builds on ${s.source}: ${s.delta}`),
      `Confidence: ${decision.confidence.level} — ${decision.confidence.reason}`,
      `Assumptions: ${decision.assumptions.length ? decision.assumptions.join("; ") : "No unresolved empirical premise recorded."}`].join("\n"),
    alternatives: decision.alternatives.map((a) => `${a.direction} — choose when ${a.choose_when}`),
    falsified: [
      ...refuted.slice(0, 3).map((c) => `${short(c.claim)} — ${short(c.evidence[0].observation)} (${c.evidence[0].source}). ${short(c.consequence)}`),
      ...(refuted.length ? [`${refuted.length > 3 ? `${refuted.length - 3} further refuted claims; ` : ""}complete observations remain in the backing record.`] : []),
    ],
    dissent: decision.dissent,
    what_would_change_our_mind: decision.experiment.fail,
    next_action: [`First test: ${decision.experiment.action}`, `Effort: ${decision.experiment.effort}`, `Pass: ${decision.experiment.pass}`, `Proposed cuts: ${decision.not_doing.join("; ")}`, decision.next_action].join("\n"),
  };
}

export function checkDecision(record: string): string[] {
  const errors = checkFalsification(record);
  const review = readFalsification(record, errors);
  const grounding = readGrounding(record, errors);
  const decision = readDecision(record, errors);
  if (!review || !grounding || !decision) return [...new Set(errors)];
  if (ideateFrontmatter(record)?.recommendation !== decision.recommendation) errors.push("frontmatter recommendation must match decision.recommendation exactly");
  const ideas = new Map(parseIdeaObjects(record).ideas.map((idea) => [idea.id, idea]));
  const claims = new Map(review.claims.map((c) => [normalized(c.claim), c]));
  const disclosed = new Set(decision.assumptions.map(normalized));
  for (const id of [...decision.idea_ids, ...decision.alternatives.flatMap((a) => a.idea_ids)]) {
    const idea = ideas.get(id);
    if (!idea) errors.push(`decision references an unknown idea: ${id}`);
    else {
      if (review.excluded_ideas.includes(id)) errors.push(`decision revives excluded idea: ${id}`);
      for (const claim of idea.claims_relied_on) {
        if (claims.get(normalized(claim))?.verdict === "unknown" && !disclosed.has(normalized(claim))) errors.push(`decision must disclose unresolved assumption: ${claim}`);
      }
    }
  }
  const sources = new Set(grounding.sources.map((s) => s.source));
  if (sources.size && !decision.builds_on.length) errors.push("decision must explain what it adds to the prior work found");
  for (const source of decision.builds_on) if (!sources.has(source.source)) errors.push(`decision cites prior work absent from grounding: ${source.source}`);
  if (renderOrchestrationResult(resultFrom(decision, review)).trim().split(/\s+/).length > 600) errors.push("decision exceeds the 600-word result budget; keep the full evidence in the backing record");
  return [...new Set(errors)];
}

export function decisionResult(record: string): OrchestrationResult {
  const errors = checkDecision(record);
  if (errors.length) throw new Error(errors.join("; "));
  return resultFrom(readDecision(record, [])!, readFalsification(record, [])!);
}
