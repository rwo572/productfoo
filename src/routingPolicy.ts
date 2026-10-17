// The routing policy loader and tier resolver (model-orchestrator-v0 T-001,
// R-001 / R-011 / R-013).
//
// The whole point of this module is what is NOT in it. Tier names, the
// task-type map, difficulty thresholds, escalation limits, and per-model tier
// membership are all committed data — `routing-policy.yaml` for the policy and
// `pricing.yaml` for which model sits in which tier. This file holds the
// decision logic and zero routing constants, so adding a provider, renaming a
// model, or moving a tier boundary is a data-only diff (C-001 / V-003). A test
// reads this source back and asserts no tier name, task-type name, or threshold
// number appears in it.
//
// It also has no defaults. A threshold missing from the data file is reported as
// missing, not quietly replaced with a number invented here — a default is a
// policy choice, and policy choices belong in the data file where a human can
// see and change them.
//
// Honest degradation (R-013) is the second rule. An unknown model, a model the
// roster does not place, an unmapped task type, a stale price table, or a stale
// policy all resolve to the policy's own `conservative_tier` with a worded
// finding. Never a silent guess, and never downward to the cheap end — the
// conservative direction is the strong one. When the policy file itself is
// missing there is no conservative tier to fall back to, so resolution returns
// no tier at all and says so; productfoo does not invent a tier name in code.
//
// R-011 is enforced structurally rather than by convention: usage share encodes
// price and free tiers, not capability, so the data file lists the keys that may
// never become routing inputs and the loader strips any it finds, with a
// finding. A rule nobody can add data against is stronger than a rule written
// down.

import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./configPath.js";
import { fileStatKey, readMemoized, writeMemoized, type MemoEntry } from "./processMemo.js";
import type { ModelRoster } from "./activeModel.js";
import type { Depth } from "./conductor/types.js";
import { pricingIsStale, type PricingTable } from "./loopBudget.js";
import type { RiskClassification, RiskConfidence } from "./riskClassify.js";
import { parse as parseYaml } from "./vendorYaml.js";

const POLICY_SOURCE = "routing-policy.yaml";

/** Key of the data node that lists forbidden inputs — never itself a finding. */
const FORBIDDEN_INPUTS_KEY = "forbidden_inputs";

export type TierDefinition = {
  name: string;
  purpose: string;
  /** Task types this tier serves, from the data file. */
  taskTypes: readonly string[];
};

export type DifficultyPolicy = {
  /** How the numbers below were arrived at, in the data file's own words. */
  basis: string | null;
  /** Signal name -> weight. */
  signals: Record<string, number>;
  /** Score at or above which a task moves up the ladder; null when the data file omits it. */
  escalateAt: number | null;
  /** Score at or below which a task moves down the ladder; null when omitted. */
  downgradeAt: number | null;
  maxTierMoves: number | null;
  /** Difficulty band -> thinking budget in tokens (R-003: adaptive, never fixed). */
  thinkingBudgetTokens: Record<string, number>;
};

export type EscalationPolicy = {
  basis: string | null;
  quality: { retriesSameModel: number | null; then: string | null; maxTierMoves: number | null };
  resilience: { trigger: string | null; direction: string | null; maxTierMoves: number | null };
};

export type ReviewPolicy = { requireDifferentFamily: boolean; onSameFamily: string | null };

export type PanelPolicy = {
  default: string | null;
  requireComparableCandidates: boolean;
  comparabilityMaxRankGap: number | null;
  onIncomparable: string | null;
  adjudication: string | null;
};

export type WorkflowLane = "direct" | "shape-fast" | "review-targeted" | "deep-explicit";
export type WorkflowRollout = "observe_only" | "enabled";

export type WorkflowPolicy = {
  /** False when workflow policy data cannot safely drive execution. */
  valid: boolean;
  basis: string | null;
  rollout: WorkflowRollout | null;
  defaultLane: WorkflowLane | null;
  conservativeLane: WorkflowLane | null;
  laneOrder: readonly WorkflowLane[];
  executableLanes: readonly WorkflowLane[];
  targetedMinDomains: number | null;
  depthLanes: Partial<Record<Depth, WorkflowLane>>;
  ambiguityTerms: readonly string[];
  domainSignals: Record<string, readonly string[]>;
  limitations: Partial<Record<WorkflowLane, string>>;
};

export type RoutingPolicy = {
  /** Basename of the data file, e.g. "routing-policy.yaml". */
  source: string;
  /** False when the data file is missing or unreadable — resolution degrades, never throws. */
  available: boolean;
  date: string | null;
  staleAfterDays: number | null;
  /** Where the tier definitions and task-type map come from. */
  evidence: string | null;
  /** Tier names weakest -> strongest. Difficulty moves along this list and nowhere else. */
  ladder: readonly string[];
  /** Where anything unresolvable lands. Null when the data file is unavailable. */
  conservativeTier: string | null;
  tiers: Record<string, TierDefinition>;
  /** Task type -> tier name. */
  taskTypes: Record<string, string>;
  difficulty: DifficultyPolicy;
  escalation: EscalationPolicy;
  review: ReviewPolicy;
  panel: PanelPolicy;
  /** Request -> orchestration amount. Deliberately separate from model tiers. */
  workflow: WorkflowPolicy;
  /** Data keys that may never become routing inputs (R-011). */
  forbiddenInputs: readonly string[];
  /** Worded findings carried into every decision made against this policy. */
  findings: readonly string[];
};

/** One tier decision, with the reason it landed there and any honesty findings. */
export type TierDecision = {
  /** Resolved tier name, or null when there is no policy to resolve against. */
  tier: string | null;
  /** Plain-text reason, safe to show a reader who did not watch the run. */
  reason: string;
  /** True when the decision fell back to the conservative tier rather than being mapped. */
  degraded: boolean;
  findings: readonly string[];
};

export type WorkflowLaneDecision = {
  /** The lane the caller may execute now under the rollout policy. */
  lane: WorkflowLane;
  /** The smallest adequate lane selected before rollout gating. */
  recommended_lane: WorkflowLane;
  reason: string;
  signals: readonly string[];
  confidence: RiskConfidence;
  conservative_escalation: boolean;
  explicit: boolean;
  executable: boolean;
  rollout: WorkflowRollout;
  /** Routing is deterministic and never spends a model call. */
  routing_model_calls: 0;
  boundary?: "B5";
  required_capability?: "research";
  limitation?: string;
};

export type WorkflowLaneInput = {
  work: string;
  explicitLane?: WorkflowLane;
  explicitDepth?: Depth;
  risk: RiskClassification;
  researchRequested?: boolean;
};

export type RoutingContext = {
  policy: RoutingPolicy;
  roster: ModelRoster;
  /** The price table backing the policy — a stale one degrades routing (R-013). */
  pricing: PricingTable;
  now?: Date;
};

// --- parsing helpers ---------------------------------------------------------

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOf(value: unknown): boolean {
  return value === true;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function numberMap(value: unknown): Record<string, number> {
  if (!isObj(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = numOf(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  if (!isObj(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = strOf(raw);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

const CANONICAL_WORKFLOW_LANE_ORDER: readonly WorkflowLane[] = [
  "direct",
  "shape-fast",
  "review-targeted",
  "deep-explicit",
];
const COMPILED_WORKFLOW_SAFETY_FLOOR: WorkflowLane = "shape-fast";
const WORKFLOW_LANES = new Set<WorkflowLane>(CANONICAL_WORKFLOW_LANE_ORDER);

function workflowLaneOf(value: unknown): WorkflowLane | null {
  return typeof value === "string" && WORKFLOW_LANES.has(value as WorkflowLane) ? value as WorkflowLane : null;
}

function workflowLaneArray(value: unknown): WorkflowLane[] {
  return strArray(value).map(workflowLaneOf).filter((lane): lane is WorkflowLane => lane !== null);
}

function workflowLaneMap(value: unknown): Partial<Record<Depth, WorkflowLane>> {
  if (!isObj(value)) return {};
  const out: Partial<Record<Depth, WorkflowLane>> = {};
  for (const depth of ["fast", "standard", "deep"] as const) {
    const lane = workflowLaneOf(value[depth]);
    if (lane) out[depth] = lane;
  }
  return out;
}

function stringArrayMap(value: unknown): Record<string, readonly string[]> {
  if (!isObj(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, strArray(child)]));
}

function workflowLimitations(value: unknown): Partial<Record<WorkflowLane, string>> {
  if (!isObj(value)) return {};
  const out: Partial<Record<WorkflowLane, string>> = {};
  for (const [key, child] of Object.entries(value)) {
    const lane = workflowLaneOf(key);
    const limitation = strOf(child);
    if (lane && limitation) out[lane] = limitation;
  }
  return out;
}

function unavailableWorkflow(): WorkflowPolicy {
  return {
    valid: false,
    basis: null,
    rollout: null,
    defaultLane: null,
    conservativeLane: null,
    laneOrder: [],
    executableLanes: [],
    targetedMinDomains: null,
    depthLanes: {},
    ambiguityTerms: [],
    domainSignals: {},
    limitations: {},
  };
}

/**
 * Every path in `value` whose key is a forbidden routing input (R-011). Exported
 * so any surface that accepts routing data — the policy file, the roster, a
 * future refresh proposal — can ask the same question of it. The node that
 * *declares* the forbidden list is skipped; naming a thing is not using it.
 */
export function findForbiddenInputs(value: unknown, forbidden: readonly string[]): string[] {
  const banned = new Set(forbidden);
  const hits: string[] = [];
  const walk = (node: unknown, trail: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, trail));
      return;
    }
    if (!isObj(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === FORBIDDEN_INPUTS_KEY) continue;
      const here = trail ? `${trail}.${key}` : key;
      if (banned.has(key)) hits.push(here);
      walk(child, here);
    }
  };
  walk(value, "");
  return hits;
}

function unavailablePolicy(finding: string): RoutingPolicy {
  return {
    source: POLICY_SOURCE,
    available: false,
    date: null,
    staleAfterDays: null,
    evidence: null,
    ladder: [],
    conservativeTier: null,
    tiers: {},
    taskTypes: {},
    difficulty: { basis: null, signals: {}, escalateAt: null, downgradeAt: null, maxTierMoves: null, thinkingBudgetTokens: {} },
    escalation: {
      basis: null,
      quality: { retriesSameModel: null, then: null, maxTierMoves: null },
      resilience: { trigger: null, direction: null, maxTierMoves: null },
    },
    review: { requireDifferentFamily: false, onSameFamily: null },
    panel: { default: null, requireComparableCandidates: false, comparabilityMaxRankGap: null, onIncomparable: null, adjudication: null },
    workflow: unavailableWorkflow(),
    forbiddenInputs: [],
    findings: [finding],
  };
}

/**
 * Load the routing policy from the committed data file. Missing or unreadable
 * data degrades to an unavailable policy with a worded finding; it never throws,
 * because a routing *decision* must be able to say "I cannot route this" without
 * taking the caller down with it.
 *
 * Memoized per process (cli_performance-v0 R-002): the policy file is committed
 * data read from several surfaces per invocation; the (mtime, size) key keeps
 * an out-of-band edit honest.
 */
const routingPolicyCache = new Map<string, MemoEntry<RoutingPolicy>>();

export function loadRoutingPolicy(root: string = process.cwd()): RoutingPolicy {
  const file = configPath(root, POLICY_SOURCE);
  const key = fileStatKey(file);
  const cached = readMemoized(routingPolicyCache, file, key);
  if (cached !== undefined) return cached;
  const value = computeRoutingPolicy(file);
  writeMemoized(routingPolicyCache, file, key, value);
  return value;
}

function computeRoutingPolicy(file: string): RoutingPolicy {
  if (!existsSync(file)) {
    return unavailablePolicy(`routing policy unavailable: ${POLICY_SOURCE} missing at repo root or in config/ — no tier can be resolved`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailablePolicy(`routing policy unavailable: ${POLICY_SOURCE} unreadable (${detail}) — no tier can be resolved`);
  }
  if (!isObj(doc)) {
    return unavailablePolicy(`routing policy unavailable: ${POLICY_SOURCE} is not a mapping — no tier can be resolved`);
  }

  const findings: string[] = [];
  const forbiddenInputs = strArray(doc[FORBIDDEN_INPUTS_KEY]);
  for (const hit of findForbiddenInputs(doc, forbiddenInputs)) {
    findings.push(`routing input refused: ${POLICY_SOURCE} carries ${hit}, which measures use rather than capability — it is ignored, not routed on`);
  }

  const tiersNode = isObj(doc.tiers) ? doc.tiers : {};
  const ladder = strArray(tiersNode.ladder);
  const definitionsNode = isObj(tiersNode.definitions) ? tiersNode.definitions : {};
  const tiers: Record<string, TierDefinition> = {};
  for (const [name, raw] of Object.entries(definitionsNode)) {
    const def = isObj(raw) ? raw : {};
    tiers[name] = { name, purpose: strOf(def.purpose) ?? "", taskTypes: strArray(def.task_types) };
  }

  const conservativeTier = strOf(doc.conservative_tier);
  if (!conservativeTier) {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} names no conservative tier — an unresolvable task has nowhere safe to land`);
  } else if (!tiers[conservativeTier]) {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} names a conservative tier (${conservativeTier}) it does not define`);
  }
  if (Object.keys(tiers).length === 0) {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} defines no tiers — every task resolves conservatively`);
  }

  const taskTypes = stringMap(doc.task_types);
  for (const [taskType, tier] of Object.entries(taskTypes)) {
    if (!tiers[tier]) findings.push(`routing policy degraded: task type ${taskType} maps to an undefined tier (${tier})`);
  }

  const difficultyNode = isObj(doc.difficulty) ? doc.difficulty : {};
  const difficulty: DifficultyPolicy = {
    basis: strOf(difficultyNode.basis),
    signals: numberMap(difficultyNode.signals),
    escalateAt: numOf(difficultyNode.escalate_at),
    downgradeAt: numOf(difficultyNode.downgrade_at),
    maxTierMoves: numOf(difficultyNode.max_tier_moves),
    thinkingBudgetTokens: numberMap(difficultyNode.thinking_budget_tokens),
  };
  // No defaults here on purpose: a missing threshold is reported, never invented.
  if (difficulty.escalateAt === null || difficulty.downgradeAt === null) {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} omits a difficulty threshold — difficulty cannot move a task off its type default`);
  }

  const escalationNode = isObj(doc.escalation) ? doc.escalation : {};
  const qualityNode = isObj(escalationNode.quality) ? escalationNode.quality : {};
  const resilienceNode = isObj(escalationNode.resilience) ? escalationNode.resilience : {};
  const escalation: EscalationPolicy = {
    basis: strOf(escalationNode.basis),
    quality: {
      retriesSameModel: numOf(qualityNode.retries_same_model),
      then: strOf(qualityNode.then),
      maxTierMoves: numOf(qualityNode.max_tier_moves),
    },
    resilience: {
      trigger: strOf(resilienceNode.trigger),
      direction: strOf(resilienceNode.direction),
      maxTierMoves: numOf(resilienceNode.max_tier_moves),
    },
  };

  const reviewNode = isObj(doc.review) ? doc.review : {};
  const panelNode = isObj(doc.panel) ? doc.panel : {};
  const workflowNode = isObj(doc.workflow) ? doc.workflow : {};
  const workflowRollout = strOf(workflowNode.rollout);
  const laneOrder = workflowLaneArray(workflowNode.lane_order);
  const executableLanes = workflowLaneArray(workflowNode.executable_lanes);
  const defaultLane = workflowLaneOf(workflowNode.default_lane);
  const conservativeLane = workflowLaneOf(workflowNode.conservative_lane);
  const laneOrderCanonical = laneOrder.length === CANONICAL_WORKFLOW_LANE_ORDER.length
    && laneOrder.every((lane, index) => lane === CANONICAL_WORKFLOW_LANE_ORDER[index]);
  const rolloutProven = workflowRollout === "observe_only";
  const safetyFloorHeld = defaultLane === COMPILED_WORKFLOW_SAFETY_FLOOR
    && conservativeLane === COMPILED_WORKFLOW_SAFETY_FLOOR;
  const executableLanesComplete = executableLanes.length > 0
    && defaultLane !== null
    && conservativeLane !== null
    && executableLanes.includes(defaultLane)
    && executableLanes.includes(conservativeLane);
  const workflowValid = rolloutProven
    && defaultLane !== null
    && conservativeLane !== null
    && laneOrderCanonical
    && safetyFloorHeld
    && executableLanesComplete;
  const workflow: WorkflowPolicy = {
    valid: workflowValid,
    basis: strOf(workflowNode.basis),
    // Enabling direct-by-default requires dependency-owned paired release proof.
    // No proof receipt/API exists yet, so a data-only flip must fail closed.
    rollout: rolloutProven ? workflowRollout : null,
    defaultLane,
    conservativeLane,
    laneOrder,
    executableLanes,
    targetedMinDomains: numOf(workflowNode.targeted_min_domains),
    depthLanes: workflowLaneMap(workflowNode.depth_lanes),
    ambiguityTerms: strArray(workflowNode.ambiguity_terms),
    domainSignals: stringArrayMap(workflowNode.domain_signals),
    limitations: workflowLimitations(workflowNode.limitations),
  };
  if (workflowRollout === "enabled") {
    findings.push(`routing policy degraded: enabled rollout refused because dependency-owned paired release proof is unavailable`);
  } else if (workflowRollout !== "observe_only") {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} has an unsupported workflow rollout (${workflowRollout ?? "missing"})`);
  }
  if (!laneOrderCanonical) {
    findings.push(`routing policy degraded: workflow lane_order must match the canonical safety order (${CANONICAL_WORKFLOW_LANE_ORDER.join(", ")})`);
  }
  if (!safetyFloorHeld) {
    findings.push(`routing policy degraded: observe-only default_lane and conservative_lane must both remain ${COMPILED_WORKFLOW_SAFETY_FLOOR} until dependency-owned release proof exists`);
  }
  if (!executableLanesComplete) {
    findings.push(`routing policy degraded: workflow executable_lanes must be non-empty and include its default and conservative lanes`);
  }
  if (!workflow.valid) {
    findings.push(`routing policy degraded: ${POLICY_SOURCE} has an incomplete workflow policy — workflow routing will escalate conservatively`);
  }

  return {
    source: POLICY_SOURCE,
    available: true,
    date: strOf(doc.date),
    staleAfterDays: numOf(doc.stale_after_days),
    evidence: strOf(doc.evidence),
    ladder,
    conservativeTier,
    tiers,
    taskTypes,
    difficulty,
    escalation,
    review: {
      requireDifferentFamily: boolOf(reviewNode.require_different_family),
      onSameFamily: strOf(reviewNode.on_same_family),
    },
    panel: {
      default: strOf(panelNode.default),
      requireComparableCandidates: boolOf(panelNode.require_comparable_candidates),
      comparabilityMaxRankGap: numOf(panelNode.comparability_max_rank_gap),
      onIncomparable: strOf(panelNode.on_incomparable),
      adjudication: strOf(panelNode.adjudication),
    },
    workflow,
    forbiddenInputs,
    findings,
  };
}

// --- staleness ---------------------------------------------------------------

/** Days between the policy date and `now`; Infinity when the date is unusable. */
export function routingPolicyAgeDays(policy: RoutingPolicy, now: Date = new Date()): number {
  if (!policy.date) return Number.POSITIVE_INFINITY;
  const dated = new Date(`${policy.date}T00:00:00Z`).getTime();
  if (Number.isNaN(dated)) return Number.POSITIVE_INFINITY;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((now.getTime() - dated) / dayMs);
}

/** True when the policy is older than its own declared refresh window (RISK-002). */
export function routingPolicyIsStale(policy: RoutingPolicy, now: Date = new Date()): boolean {
  if (policy.staleAfterDays === null) return true;
  return routingPolicyAgeDays(policy, now) > policy.staleAfterDays;
}

// A stale price table or a stale policy means the data behind a routing decision
// can no longer be vouched for, so the decision degrades (R-013). Both are worded
// for a reader who did not watch the run.
function stalenessFindings(ctx: RoutingContext): string[] {
  const now = ctx.now ?? new Date();
  const out: string[] = [];
  if (ctx.policy.available && routingPolicyIsStale(ctx.policy, now)) {
    out.push(`routing policy stale: ${ctx.policy.source} was last refreshed ${ctx.policy.date ?? "on an unstated date"} — routing conservatively until it is refreshed`);
  }
  if (ctx.pricing.available === false) {
    out.push(`price table unavailable: ${ctx.pricing.source} is missing — routing conservatively, no model costs assumed`);
  } else if (pricingIsStale(ctx.pricing, now)) {
    out.push(`price table stale: ${ctx.pricing.source} is dated ${ctx.pricing.date} — routing conservatively until it is refreshed`);
  }
  return out;
}

// --- resolution --------------------------------------------------------------

function conservative(policy: RoutingPolicy, reason: string, findings: string[]): TierDecision {
  if (!policy.conservativeTier) {
    return {
      tier: null,
      reason: `${reason}, and the policy names no safe tier to fall back to`,
      degraded: true,
      findings: [...policy.findings, ...findings],
    };
  }
  return {
    tier: policy.conservativeTier,
    reason: `${reason}, so the stronger of the available tiers was used`,
    degraded: true,
    findings: [...policy.findings, ...findings],
  };
}

/**
 * The tier a task type maps to, before difficulty adjusts it (R-002 step 1). An
 * unmapped task type lands conservatively and says so — never on the cheap end
 * by default.
 */
export function tierForTaskType(ctx: RoutingContext, taskType: string): TierDecision {
  const { policy } = ctx;
  const stale = stalenessFindings(ctx);
  if (!policy.available) {
    return { tier: null, reason: `no routing policy is available, so no tier was chosen`, degraded: true, findings: [...policy.findings, ...stale] };
  }
  if (stale.length > 0) {
    return conservative(policy, `the data behind this routing decision could not be vouched for`, stale);
  }
  const mapped = policy.taskTypes[taskType];
  if (!mapped) {
    return conservative(policy, `${policy.source} maps no tier for work of this kind (${taskType})`, []);
  }
  if (!policy.tiers[mapped]) {
    return conservative(policy, `work of this kind (${taskType}) maps to a tier ${policy.source} does not define (${mapped})`, []);
  }
  return {
    tier: mapped,
    reason: `${policy.source} routes work of this kind (${taskType}) to the ${mapped} tier`,
    degraded: false,
    findings: [...policy.findings],
  };
}

/**
 * The tier a specific model sits in. Tier membership is roster data: a model the
 * roster does not place, or does not know at all, resolves conservatively with a
 * worded finding rather than being guessed into a tier (R-013).
 */
export function tierForModel(ctx: RoutingContext, modelId: string): TierDecision {
  const { policy, roster } = ctx;
  const stale = stalenessFindings(ctx);
  if (!policy.available) {
    return { tier: null, reason: `no routing policy is available, so no tier was chosen`, degraded: true, findings: [...policy.findings, ...stale] };
  }
  const entry = roster.entries.find((candidate) => candidate.id === modelId);
  if (!entry) {
    return conservative(policy, `${modelId} is not in ${roster.source}, so nothing vouches for what it can do`, [
      ...stale,
      `unplaced model: ${modelId} is not in ${roster.source} — routed conservatively, no capability assumed`,
    ]);
  }
  if (!entry.routingTier) {
    return conservative(policy, `${roster.source} does not place ${modelId} in a tier`, [
      ...stale,
      `unplaced model: ${roster.source} carries no tier for ${modelId} — routed conservatively until the roster places it with evidence`,
    ]);
  }
  if (!policy.tiers[entry.routingTier]) {
    return conservative(policy, `${roster.source} places ${modelId} in a tier ${policy.source} does not define (${entry.routingTier})`, stale);
  }
  if (stale.length > 0) {
    return conservative(policy, `the data behind this routing decision could not be vouched for`, stale);
  }
  return {
    tier: entry.routingTier,
    reason: `${roster.source} places ${modelId} in the ${entry.routingTier} tier`,
    degraded: false,
    findings: [...policy.findings],
  };
}

/** Roster models placed in `tier`, in roster order. Empty is a real answer, not an error. */
export function modelsForTier(ctx: RoutingContext, tier: string): string[] {
  return ctx.roster.entries.filter((entry) => entry.routingTier === tier).map((entry) => entry.id);
}

/**
 * Move `tier` `steps` rungs along the ladder (R-003 allows at most one, and the
 * policy data says how many). A tier that is off the ladder — a different axis
 * rather than a stronger rung — does not move, and says why. Movement stops at
 * the ends rather than wrapping.
 */
export function adjustTier(policy: RoutingPolicy, tier: string, steps: number): TierDecision {
  const at = policy.ladder.indexOf(tier);
  if (at < 0) {
    return { tier, reason: `the ${tier} tier is not on the ladder, so difficulty does not move it`, degraded: false, findings: [] };
  }
  const cap = policy.difficulty.maxTierMoves;
  const allowed = cap === null ? steps : Math.max(-cap, Math.min(cap, steps));
  const target = Math.max(0, Math.min(policy.ladder.length - 1, at + allowed));
  const moved = policy.ladder[target];
  if (moved === tier) {
    return { tier, reason: `the ${tier} tier is already at the end of the ladder in that direction`, degraded: false, findings: [] };
  }
  return { tier: moved, reason: `difficulty moved this from the ${tier} tier to the ${moved} tier`, degraded: false, findings: [] };
}

// --- workflow-lane resolution ------------------------------------------------

function phraseMatches(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function laneRank(policy: WorkflowPolicy, lane: WorkflowLane): number {
  return policy.laneOrder.indexOf(lane);
}

function higherLane(policy: WorkflowPolicy, requested: WorkflowLane, floor: WorkflowLane): WorkflowLane {
  const requestedRank = laneRank(policy, requested);
  const floorRank = laneRank(policy, floor);
  if (requestedRank < 0 || floorRank < 0) return floor;
  return requestedRank >= floorRank ? requested : floor;
}

function workflowFallback(policy: RoutingPolicy): WorkflowLaneDecision {
  // The policy is untrusted on this path. Do not let malformed data choose the
  // fallback or claim executability; shape-fast is productfoo's compiled safety floor.
  const lane = COMPILED_WORKFLOW_SAFETY_FLOOR;
  return {
    lane,
    recommended_lane: lane,
    reason: "Workflow policy unavailable or incomplete, so productfoo chose the conservative bounded-shaping lane.",
    signals: [...policy.findings, "workflow-policy-unavailable"],
    confidence: "low",
    conservative_escalation: true,
    explicit: false,
    executable: true,
    rollout: "observe_only",
    routing_model_calls: 0,
  };
}

/**
 * Choose how much orchestration a request earns. This is a pure, deterministic
 * decision over committed policy data plus the existing B3 classifier: it never
 * calls a model merely to decide that no extra model call is needed.
 */
export function resolveWorkflowLane(policy: RoutingPolicy, input: WorkflowLaneInput): WorkflowLaneDecision {
  const workflow = policy.workflow;
  if (
    !policy.available
    || !workflow.valid
    || !workflow.rollout
    || !workflow.defaultLane
    || !workflow.conservativeLane
    || workflow.laneOrder.length === 0
  ) {
    return workflowFallback(policy);
  }

  const riskDimensions = (Object.entries(input.risk.dimensions) as Array<[string, string[]]>)
    .filter(([, matches]) => matches.length > 0)
    .map(([dimension]) => dimension);
  const domainMatches = Object.entries(workflow.domainSignals)
    .filter(([, terms]) => terms.some((term) => phraseMatches(input.work, term)))
    .map(([domain]) => domain);
  const ambiguityMatches = workflow.ambiguityTerms.filter((term) => phraseMatches(input.work, term));
  const domains = [...new Set([...riskDimensions, ...domainMatches])];
  const targeted = workflow.targetedMinDomains !== null && domains.length >= workflow.targetedMinDomains;
  const explicitLane = input.explicitLane ?? (input.explicitDepth ? workflow.depthLanes[input.explicitDepth] : undefined);
  const explicit = explicitLane !== undefined;

  let recommended: WorkflowLane;
  let reason: string;
  let confidence: RiskConfidence = input.risk.confidence;
  let conservativeEscalation = false;

  if (input.researchRequested) {
    recommended = "shape-fast";
    reason = "B5 explicit research must use productfoo's governed research front door; a simpler lane cannot bypass that boundary.";
    conservativeEscalation = explicitLane !== undefined && explicitLane !== "shape-fast";
  } else if (explicitLane) {
    recommended = explicitLane;
    reason = `The user explicitly selected the ${explicitLane} lane.`;
  } else if (input.risk.risky && targeted) {
    recommended = "review-targeted";
    reason = `Material risk crosses ${domains.length} domains, so bounded cross-domain analysis is the smallest adequate lane.`;
  } else if (input.risk.risky) {
    recommended = "shape-fast";
    reason = "B3 risk requires an agreed shape before build, so direct execution is not eligible.";
  } else if (targeted) {
    recommended = "review-targeted";
    reason = `The request crosses ${domains.length} domains, so bounded cross-domain analysis is the smallest adequate lane.`;
  } else if (ambiguityMatches.length > 0) {
    recommended = "shape-fast";
    reason = "The requested outcome is ambiguous, so one bounded interviewer is the smallest adequate lane.";
    confidence = "medium";
  } else {
    recommended = "direct";
    reason = "The request is clear, routine, and reversible, so the current agent plus deterministic checks is sufficient.";
    confidence = "high";
  }

  if (input.risk.risky) {
    const safetyFloor: WorkflowLane = targeted ? "review-targeted" : "shape-fast";
    const safe = higherLane(workflow, recommended, safetyFloor);
    if (safe !== recommended) {
      recommended = safe;
      conservativeEscalation = true;
      reason = `An explicit simpler lane cannot bypass B3 risk; productfoo escalated to ${safe}.`;
    }
  }

  const rollout = workflow.rollout;
  const observedOnly = rollout === "observe_only" && recommended === "direct" && !explicit;
  const recommendedExecutable = workflow.executableLanes.includes(recommended);
  const adapterFallback = !recommendedExecutable;
  const lane = observedOnly
    ? workflow.defaultLane
    : adapterFallback
      ? workflow.conservativeLane
      : recommended;
  if (observedOnly) {
    reason += ` The direct recommendation is observe-only until paired same-harness evaluation clears the release gate; ${lane} remains executable.`;
  } else if (adapterFallback) {
    conservativeEscalation = true;
    reason += ` ${workflow.limitations[recommended] ?? "That adapter is unavailable"}; ${lane} is the smallest safe implemented fallback.`;
  }

  const executable = workflow.executableLanes.includes(lane);
  const limitation = workflow.limitations[recommended];
  return {
    lane,
    recommended_lane: recommended,
    reason,
    signals: [
      ...riskDimensions.map((dimension) => `risk:${dimension}`),
      ...domainMatches.map((domain) => `domain:${domain}`),
      ...ambiguityMatches.map((term) => `ambiguity:${term}`),
    ],
    confidence,
    conservative_escalation: conservativeEscalation,
    explicit,
    executable,
    rollout,
    routing_model_calls: 0,
    ...(input.researchRequested ? { boundary: "B5" as const, required_capability: "research" as const } : {}),
    ...(limitation ? { limitation } : {}),
  };
}
