import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadModelRoster } from "../src/activeModel.js";
import { loadPricing } from "../src/loopBudget.js";
import {
  adjustTier,
  findForbiddenInputs,
  loadRoutingPolicy,
  modelsForTier,
  resolveWorkflowLane,
  routingPolicyIsStale,
  tierForModel,
  tierForTaskType,
  type WorkflowLane,
  type RoutingContext,
} from "../src/routingPolicy.js";
import { classifyWork } from "../src/riskClassify.js";
import { researchRequestTopic } from "../src/researchGate.js";

// Pinned so the committed policy and price table are fresh for every assertion
// about a NON-degraded decision. Staleness has its own tests below; it must not
// leak into the others and make them pass or fail with the calendar.
const NOW = new Date("2026-07-20T00:00:00Z");

const REPO = ".";
const POLICY_TEXT = readFileSync(path.join(REPO, "config", "routing-policy.yaml"), "utf8");
const PRICING_TEXT = readFileSync(path.join(REPO, "config", "pricing.yaml"), "utf8");

function contextFor(root: string): RoutingContext {
  return { policy: loadRoutingPolicy(root), roster: loadModelRoster(root), pricing: loadPricing(root), now: NOW };
}

function workflowRoute(
  work: string,
  options: { explicitLane?: WorkflowLane; explicitDepth?: "fast" | "standard" | "deep"; root?: string } = {},
) {
  const policy = loadRoutingPolicy(options.root ?? REPO);
  return resolveWorkflowLane(policy, {
    work,
    explicitLane: options.explicitLane,
    explicitDepth: options.explicitDepth,
    risk: classifyWork(work),
    researchRequested: researchRequestTopic(work) !== null,
  });
}

// A throwaway repo root holding just the two data files, so a "data-only diff"
// can be made and its effect observed with no src/ edit anywhere in the test.
function rootWith(policy: string, pricing: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-routing-"));
  writeFileSync(path.join(dir, "routing-policy.yaml"), policy);
  writeFileSync(path.join(dir, "pricing.yaml"), pricing);
  return dir;
}

// --- the committed policy loads and decides (R-001) --------------------------

test("the committed routing policy loads clean", () => {
  const policy = loadRoutingPolicy(REPO);
  assert.equal(policy.available, true);
  assert.deepEqual(policy.findings, []);
  assert.equal(policy.conservativeTier, "frontier");
  assert.deepEqual(policy.ladder, ["cheap", "generalist", "frontier"]);
  assert.equal(policy.evidence, "research/2026-07-12-model-routing-orchestration.md");
  assert.equal(routingPolicyIsStale(policy, NOW), false);
});

test("routine, ambiguous, risky cross-domain, and explicit-deep work choose the smallest adequate lane", () => {
  const routine = workflowRoute("rename the parseSpec helper");
  assert.equal(routine.recommended_lane, "direct");
  assert.equal(routine.lane, "shape-fast", "observe-only rollout must not silently change the executable default");
  assert.equal(routine.rollout, "observe_only");
  assert.equal(routine.routing_model_calls, 0, "routing itself must not spend a model call");
  assert.equal("model_calls" in routine, false, "the route must not imply that the whole downstream run made zero calls");
  assert.match(routine.reason, /clear|routine|reversible/i);

  const ambiguous = workflowRoute("help me decide what to build");
  assert.equal(ambiguous.recommended_lane, "shape-fast");
  assert.equal(ambiguous.lane, "shape-fast");
  assert.match(ambiguous.signals.join("\n"), /ambigu/i);

  const crossDomain = workflowRoute("design an autonomous billing webhook API");
  assert.equal(crossDomain.recommended_lane, "review-targeted");
  assert.equal(crossDomain.lane, "shape-fast", "an unavailable targeted adapter must degrade to the smallest safe implemented lane");
  assert.match(crossDomain.signals.join("\n"), /agentic|outbound|billing|api/i);

  const explicit = workflowRoute("redesign the platform", { explicitLane: "deep-explicit" });
  assert.equal(explicit.recommended_lane, "deep-explicit");
  assert.equal(explicit.lane, "deep-explicit");
  assert.equal(explicit.explicit, true);
});

test("explicit simplicity cannot bypass B3, while explicit depth maps to a visible lane", () => {
  const unsafeDirect = workflowRoute("delete the production users table", { explicitLane: "direct" });
  assert.equal(unsafeDirect.recommended_lane, "shape-fast");
  assert.equal(unsafeDirect.lane, "shape-fast");
  assert.equal(unsafeDirect.conservative_escalation, true);
  assert.match(unsafeDirect.reason, /cannot bypass|risk|B3/i);

  assert.equal(workflowRoute("explore onboarding", { explicitDepth: "fast" }).recommended_lane, "shape-fast");
  assert.equal(workflowRoute("review onboarding", { explicitDepth: "standard" }).recommended_lane, "review-targeted");
  assert.equal(workflowRoute("exhaustively review onboarding", { explicitDepth: "deep" }).recommended_lane, "deep-explicit");
});

test("an unavailable workflow policy escalates conservatively and explains the gap", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "foo-workflow-empty-"));
  const decision = workflowRoute("rename the parseSpec helper", { root: empty });
  assert.equal(decision.lane, "shape-fast");
  assert.equal(decision.recommended_lane, "shape-fast");
  assert.equal(decision.conservative_escalation, true);
  assert.match(decision.reason, /policy unavailable|cannot classify|conservative/i);
});

test("malformed lane order cannot turn direct into the B3 safety ceiling", () => {
  const malformed = POLICY_TEXT.replace(
    "lane_order: [direct, shape-fast, review-targeted, deep-explicit]",
    "lane_order: [shape-fast, direct, review-targeted, deep-explicit]",
  );
  const root = rootWith(malformed, PRICING_TEXT);
  const policy = loadRoutingPolicy(root);
  assert.match(policy.findings.join("\n"), /lane_order.*canonical|workflow policy/i);

  const decision = workflowRoute("delete the production users table", { explicitLane: "direct", root });
  assert.equal(decision.lane, "shape-fast");
  assert.equal(decision.conservative_escalation, true);
});

test("enabled rollout without dependency-owned release proof fails closed", () => {
  const unproven = POLICY_TEXT.replace("rollout: observe_only", "rollout: enabled");
  const root = rootWith(unproven, PRICING_TEXT);
  const policy = loadRoutingPolicy(root);
  assert.match(policy.findings.join("\n"), /enabled rollout.*release proof|paired.*gate/i);

  const decision = workflowRoute("rename the parseSpec helper", { root });
  assert.equal(decision.lane, "shape-fast");
  assert.notEqual(decision.recommended_lane, "direct");
  assert.equal(decision.conservative_escalation, true);
});

test("observe-only cannot activate implicit direct through a policy-only default change", () => {
  const unsafeDefault = POLICY_TEXT.replace("default_lane: shape-fast", "default_lane: direct");
  const root = rootWith(unsafeDefault, PRICING_TEXT);
  const policy = loadRoutingPolicy(root);
  assert.match(policy.findings.join("\n"), /default_lane.*shape-fast|safety floor/i);

  const decision = workflowRoute("rename the parseSpec helper", { root });
  assert.equal(decision.lane, "shape-fast");
  assert.equal(decision.recommended_lane, "shape-fast");
  assert.equal(decision.conservative_escalation, true);
});

test("a policy-only conservative fallback cannot downgrade risky targeted work to direct", () => {
  const unsafeFallback = POLICY_TEXT.replace("conservative_lane: shape-fast", "conservative_lane: direct");
  const root = rootWith(unsafeFallback, PRICING_TEXT);
  const policy = loadRoutingPolicy(root);
  assert.match(policy.findings.join("\n"), /conservative_lane.*shape-fast|safety floor/i);

  const decision = workflowRoute("design an autonomous billing webhook API", { root });
  assert.equal(decision.lane, "shape-fast");
  assert.equal(decision.conservative_escalation, true);
});

test("an empty executable-lane set is incomplete policy and falls back safely", () => {
  const empty = POLICY_TEXT.replace(
    "executable_lanes: [direct, shape-fast, deep-explicit]",
    "executable_lanes: []",
  );
  const root = rootWith(empty, PRICING_TEXT);
  const policy = loadRoutingPolicy(root);
  assert.match(policy.findings.join("\n"), /executable_lanes|workflow policy/i);

  const decision = workflowRoute("rename the parseSpec helper", { explicitLane: "direct", root });
  assert.equal(decision.lane, "shape-fast");
  assert.equal(decision.executable, true);
});

test("targeted and deep lanes expose their execution limits instead of pretending missing adapters exist", () => {
  const targeted = workflowRoute("design an autonomous billing webhook API");
  assert.equal(targeted.recommended_lane, "review-targeted");
  assert.equal(targeted.lane, "shape-fast");
  assert.equal(targeted.executable, true);
  assert.equal(targeted.conservative_escalation, true);
  assert.match(targeted.limitation ?? "", /three|lens|adapter|unavailable/i);

  const deep = workflowRoute("redesign the platform", { explicitLane: "deep-explicit" });
  assert.equal(deep.executable, true, "an explicit deep request is executable through the governed full loop");
});

test("a task type routes to its mapped tier, with a reason a reader can follow", () => {
  const ctx = contextFor(REPO);
  const planned = tierForTaskType(ctx, "plan");
  assert.equal(planned.tier, "frontier");
  assert.equal(planned.degraded, false);
  assert.match(planned.reason, /routes work of this kind \(plan\) to the frontier tier/);

  assert.equal(tierForTaskType(ctx, "implement").tier, "generalist");
  assert.equal(tierForTaskType(ctx, "bulk_edit").tier, "cheap");
});

test("tier membership comes from the roster, not from code", () => {
  const ctx = contextFor(REPO);
  assert.equal(tierForModel(ctx, "claude-opus-4-8").tier, "frontier");
  assert.equal(tierForModel(ctx, "claude-sonnet-4-6").tier, "generalist");
  assert.deepEqual(modelsForTier(ctx, "frontier"), ["claude-opus-4-8"]);
});

// --- C-001: adding a provider, renaming a model, and moving a tier boundary ---
// are each a data-only diff. Every one of these tests changes YAML text only.

test("adding a provider is a data-only diff", () => {
  const added = `${PRICING_TEXT}
  newprov-2:
    input_per_mtok: 0.10
    output_per_mtok: 0.40
    family: newprov
    roles: [worker]
    routing:
      tier: cheap
      evidence: "test fixture"
    detect:
      model_markers: [newprov]
      provider: newprov
`;
  const ctx = contextFor(rootWith(POLICY_TEXT, added));
  const decision = tierForModel(ctx, "newprov-2");
  assert.equal(decision.tier, "cheap");
  assert.equal(decision.degraded, false);
  assert.deepEqual(modelsForTier(ctx, "cheap"), ["newprov-2"]);
});

test("renaming a model is a data-only diff", () => {
  const renamed = PRICING_TEXT.replace(/claude-opus-4-8:/, "claude-opus-4-9:");
  const ctx = contextFor(rootWith(POLICY_TEXT, renamed));
  assert.equal(tierForModel(ctx, "claude-opus-4-9").tier, "frontier");

  // The old id is now unknown — and says so rather than resolving silently.
  const gone = tierForModel(ctx, "claude-opus-4-8");
  assert.equal(gone.degraded, true);
  assert.equal(gone.tier, "frontier");
  assert.match(gone.findings.join("\n"), /unplaced model: claude-opus-4-8 is not in pricing\.yaml/);
});

test("moving a tier boundary is a data-only diff", () => {
  const moved = POLICY_TEXT.replace(/^  implement: generalist$/m, "  implement: frontier");
  assert.notEqual(moved, POLICY_TEXT);
  const ctx = contextFor(rootWith(moved, PRICING_TEXT));
  const decision = tierForTaskType(ctx, "implement");
  assert.equal(decision.tier, "frontier");
  assert.equal(decision.degraded, false);
});

// --- R-013: honest degradation ----------------------------------------------

test("a model the roster does not place routes conservatively and says why", () => {
  const ctx = contextFor(REPO);
  // Deliberately unplaced in the committed roster: the evidence does not name it.
  const decision = tierForModel(ctx, "claude-haiku-4-5");
  assert.equal(decision.tier, "frontier");
  assert.equal(decision.degraded, true);
  assert.match(decision.reason, /does not place claude-haiku-4-5 in a tier/);
  assert.match(decision.findings.join("\n"), /routed conservatively until the roster places it with evidence/);
});

test("an unmapped task type routes conservatively, never to the cheap tier", () => {
  const ctx = contextFor(REPO);
  const decision = tierForTaskType(ctx, "translate-the-changelog");
  assert.equal(decision.tier, "frontier");
  assert.equal(decision.degraded, true);
  assert.match(decision.reason, /maps no tier for work of this kind/);
});

test("a stale price table degrades routing rather than pricing a guess", () => {
  const ctx = contextFor(REPO);
  const later = { ...ctx, now: new Date("2027-01-01T00:00:00Z") };
  const decision = tierForTaskType(later, "implement");
  assert.equal(decision.tier, "frontier");
  assert.equal(decision.degraded, true);
  assert.match(decision.findings.join("\n"), /price table stale/);
  assert.match(decision.findings.join("\n"), /routing policy stale/);
});

test("a missing policy file yields no tier at all, and never throws", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "foo-routing-empty-"));
  const policy = loadRoutingPolicy(empty);
  assert.equal(policy.available, false);
  assert.equal(policy.conservativeTier, null);
  assert.match(policy.findings.join("\n"), /routing policy unavailable/);

  // No policy means no invented tier name from code.
  const ctx: RoutingContext = { policy, roster: loadModelRoster(REPO), pricing: loadPricing(REPO), now: NOW };
  assert.equal(tierForTaskType(ctx, "plan").tier, null);
  assert.equal(tierForModel(ctx, "claude-opus-4-8").tier, null);
});

test("an unreadable policy file degrades instead of throwing", () => {
  const broken = rootWith("tiers:\n  ladder: [cheap\n", PRICING_TEXT);
  const policy = loadRoutingPolicy(broken);
  assert.equal(policy.available, false);
  assert.match(policy.findings.join("\n"), /routing policy unavailable/);
});

test("a policy naming a conservative tier it does not define says so", () => {
  const bad = POLICY_TEXT.replace("conservative_tier: frontier", "conservative_tier: mythical");
  const policy = loadRoutingPolicy(rootWith(bad, PRICING_TEXT));
  assert.match(policy.findings.join("\n"), /names a conservative tier \(mythical\) it does not define/);
});

// --- R-011: popularity is never a routing input ------------------------------

test("a usage-popularity key in the policy data is refused, not routed on", () => {
  const spiked = POLICY_TEXT.replace("    frontier:\n", "    frontier:\n      usage_share: 0.41\n");
  assert.notEqual(spiked, POLICY_TEXT);
  const policy = loadRoutingPolicy(rootWith(spiked, PRICING_TEXT));
  assert.match(policy.findings.join("\n"), /routing input refused: routing-policy\.yaml carries tiers\.definitions\.frontier\.usage_share/);
  assert.match(policy.findings.join("\n"), /measures use rather than capability/);
});

test("declaring the forbidden list is not itself using one", () => {
  const policy = loadRoutingPolicy(REPO);
  assert.ok(policy.forbiddenInputs.includes("usage_share"));
  assert.deepEqual(policy.findings, []);
});

test("the forbidden-input scan generalizes to roster-shaped data", () => {
  const hits = findForbiddenInputs({ models: { "a-1": { popularity: 3 } } }, ["popularity"]);
  assert.deepEqual(hits, ["models.a-1.popularity"]);
});

// --- ladder movement (R-003's one-rung rule, as data) ------------------------

test("difficulty moves a task at most as far as the data allows, and stops at the ends", () => {
  const policy = loadRoutingPolicy(REPO);
  assert.equal(adjustTier(policy, "cheap", 1).tier, "generalist");
  assert.equal(adjustTier(policy, "generalist", -1).tier, "cheap");
  // max_tier_moves is 1 in the data: a two-rung request is capped, not honored.
  assert.equal(adjustTier(policy, "cheap", 2).tier, "generalist");
  const capped = adjustTier(policy, "frontier", 1);
  assert.equal(capped.tier, "frontier");
  assert.match(capped.reason, /already at the end of the ladder/);
});

test("a tier off the ladder is a different axis, not a stronger rung", () => {
  const policy = loadRoutingPolicy(REPO);
  const decision = adjustTier(policy, "long_context", 1);
  assert.equal(decision.tier, "long_context");
  assert.match(decision.reason, /not on the ladder/);
});

// --- V-003: the policy is data, and nowhere else ------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function quotedLiterals(source: string): string[] {
  return [...source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
}

test("no tier name, task type, or threshold is written into the source", () => {
  const policy = loadRoutingPolicy(REPO);
  const names = [...policy.ladder, ...Object.keys(policy.tiers), ...Object.keys(policy.taskTypes)];
  const code = stripComments(readFileSync("src/routingPolicy.ts", "utf8"));

  for (const literal of quotedLiterals(code)) {
    for (const name of names) {
      // Token boundary, not substring: a hyphen joins a word, it does not start one.
      assert.doesNotMatch(literal, new RegExp(`(?<![\\w-])${name}(?![\\w-])`), `"${literal}" hardcodes the routing datum ${name}`);
    }
  }
  // Every threshold and weight in the policy is fractional; none may appear here.
  assert.doesNotMatch(code, /\b\d+\.\d+\b/);
});

test("no skill file carries routing choreography", () => {
  const policy = loadRoutingPolicy(REPO);
  const tiers = Object.keys(policy.tiers);
  const taskTypes = Object.keys(policy.taskTypes);
  const dataKeys = ["conservative_tier", "escalate_at", "downgrade_at", "retries_same_model", "max_tier_moves"];

  for (const dir of readdirSync("skills", { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join("skills", dir.name, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const key of dataKeys) {
      assert.ok(!text.includes(key), `${file} carries the routing datum ${key} — policy is data, skills are leaf-only`);
    }
    // Choreography is a MAPPING, not a mention: a skill may discuss the frontier;
    // it may not say which kind of work goes to which tier.
    for (const taskType of taskTypes) {
      for (const tier of tiers) {
        const mapping = new RegExp(`(?<![\\w-])${taskType}(?![\\w-])\\s*(?:->|=>|→)\\s*(?<![\\w-])${tier}(?![\\w-])`, "i");
        assert.doesNotMatch(text, mapping, `${file} maps ${taskType} to ${tier} — routing choreography belongs in compiled code, not skill prose`);
      }
    }
  }
});
