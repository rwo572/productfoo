import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  countTokensViaApi,
  guardSourceForEgress,
  isLocalOnly,
  loadPricing,
  type MeasureMethod,
  type PricingTable,
  pricedWith,
  pricingAgeDays,
  pricingIsStale,
  structuralTokens,
} from "./loopBudget.js";
import { type ActiveModel, autonomyDenied, resolveActiveModel } from "./activeModel.js";

// Spec-level budgeting (spec-budget-v0). Estimates what a spec packet costs to
// BUILD, per release tier, by reusing the loop-budget price/count_tokens
// primitives. A spec packet has no observe.sources per requirement, so the
// token number is DERIVED: count_tokens(requirement text) × complexity
// multiplier × build_passes, aggregated by tier.
//
// This is a RELATIVE instrument, not a price tag (D-013). It answers "which
// parts of this are heavy, and what do my options cost me?" — not "this will
// cost exactly $0.0714." Hence: always a range, basis heuristic, confidence
// low; money rounds to cents; relative share leads; and every run offers
// trade-offs (cheaper/faster model, fewer passes, smaller tier) with the honest
// price of taking them.
//
// R-007 (amended, D-013): engineer-effort and calendar-time remain OUT of scope
// — they are the least-calibratable estimates in software. AGENT RUNTIME is in
// scope: it is tokens ÷ assumed throughput, arithmetic rather than a guess about
// people. The two are not the same thing and the output must never conflate them.

export type Priority = "must" | "should" | "may" | "must-not";
export type Risk = "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";
export type Tier = "core" | "next" | "deferred";
export type TierSource = "decisions" | "priority" | "single";

export type ParsedRequirement = {
  id: string;
  title: string;
  priority: Priority;
  risk: Risk;
  confidence: Confidence;
  text: string;
};

export type ParseResult = {
  requirements: ParsedRequirement[];
  excluded: string[]; // requirement headings that could not be parsed
};

// --- Heuristic factors (R-002 / R-006 defaults) ------------------------------

const PRIORITY_WEIGHT: Record<Priority, number> = { must: 1.5, should: 1.0, may: 0.6, "must-not": 0 };
const RISK_SURCHARGE: Record<Risk, number> = { high: 0.5, medium: 0.25, low: 0 };
const CONFIDENCE_SURCHARGE: Record<Confidence, number> = { low: 0.25, medium: 0.1, high: 0 };
export const DEFAULT_BUILD_PASSES = 3;

export function buildPassesDefault(): number {
  const raw = process.env.FOO_SPEC_BUILD_PASSES;
  if (raw === undefined) return DEFAULT_BUILD_PASSES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUILD_PASSES;
}

// --- Parsing -----------------------------------------------------------------

function normalizePriority(value: string): Priority | null {
  const v = value.trim().toLowerCase();
  if (v === "must" || v === "should" || v === "may" || v === "must-not") return v;
  return null;
}

function normalizeLevel(value: string): Risk | null {
  const v = value.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return null;
}

// Parse requirement-heading blocks with Priority / Risk / Confidence metadata.
// The reader stays input-liberal across the catalog's legacy separators, while
// metadata may use the Release Channel V0 bullet layout or the older bare lines.
// A block missing or mis-formatting any of the three is reported as excluded so
// an undercount is visible rather than silent (R-002).
export function parseRequirements(specText: string): ParseResult {
  const lines = specText.split(/\r?\n/);
  const headingRe = /^###\s+(R-?\d+)\b\s*[:—–-]?\s*(.+?)\s*$/;
  const blocks: { id: string; title: string; body: string[] }[] = [];
  let current: { id: string; title: string; body: string[] } | null = null;

  for (const line of lines) {
    const match = headingRe.exec(line);
    if (match) {
      if (current) blocks.push(current);
      current = { id: match[1], title: match[2], body: [line] };
      continue;
    }
    if (current) {
      if (/^##\s+/.test(line)) {
        // next top-level section ends the requirements run
        blocks.push(current);
        current = null;
        continue;
      }
      current.body.push(line);
    }
  }
  if (current) blocks.push(current);

  const requirements: ParsedRequirement[] = [];
  const excluded: string[] = [];

  for (const block of blocks) {
    const body = block.body.join("\n");
    const priorityMatch = /^-?\s*Priority:\s*(.+)$/m.exec(body);
    const riskMatch = /^-?\s*Risk:\s*(.+)$/m.exec(body);
    const confidenceMatch = /^-?\s*Confidence:\s*(.+)$/m.exec(body);
    const priority = priorityMatch ? normalizePriority(priorityMatch[1]) : null;
    const risk = riskMatch ? normalizeLevel(riskMatch[1]) : null;
    const confidence = confidenceMatch ? normalizeLevel(confidenceMatch[1]) : null;

    if (!priority || !risk || !confidence) {
      excluded.push(block.id);
      continue;
    }
    requirements.push({ id: block.id, title: block.title, priority, risk, confidence, text: body });
  }

  return { requirements, excluded };
}

// Parse an explicit release-tier mapping from the `## Decisions` section, e.g.
// "core = R-001, R-002 ; next increment = R-006 ; deferred = ...". Returns a
// requirement-id → tier map (empty when no mapping is present).
export function parseTierMap(specText: string): Map<string, Tier> {
  const map = new Map<string, Tier>();
  // Anchor on the heading line so an inline `## Decisions` mention in prose does
  // not get picked up as the section start.
  const headingRe = /^##\s+Decisions\s*$/m;
  const heading = headingRe.exec(specText);
  let scope = specText;
  if (heading) {
    const rest = specText.slice(heading.index + heading[0].length);
    const nextSection = rest.search(/\n##\s/);
    scope = nextSection === -1 ? rest : rest.slice(0, nextSection);
  }
  const tierAliases: { tier: Tier; re: RegExp }[] = [
    { tier: "core", re: /\bcore\b[^.]*?=\s*([^;.\n]*)/i },
    { tier: "next", re: /\bnext(?:\s+increment)?\b[^.]*?=\s*([^;.\n]*)/i },
    { tier: "deferred", re: /\b(?:deferred|later)\b[^.]*?=\s*([^;.\n]*)/i },
  ];
  for (const { tier, re } of tierAliases) {
    const match = re.exec(scope);
    if (!match) continue;
    for (const id of match[1].match(/R-\d+/g) ?? []) {
      if (!map.has(id)) map.set(id, tier);
    }
  }
  return map;
}

// Assign a tier to each requirement: explicit Decisions mapping wins; otherwise
// group by Priority (must→core, should→next, may→deferred). must-not is excluded
// from costing (weight 0).
export function assignTier(req: ParsedRequirement, tierMap: Map<string, Tier>): Tier | "excluded" {
  if (req.priority === "must-not") return "excluded";
  const explicit = tierMap.get(req.id);
  if (explicit) return explicit;
  if (req.priority === "must") return "core";
  if (req.priority === "should") return "next";
  return "deferred";
}

// --- Estimation --------------------------------------------------------------

export type RequirementEstimate = {
  id: string;
  priority: Priority;
  risk: Risk;
  confidence: Confidence;
  tokens: number; // measured requirement-text tokens (one pass, before multiplier)
  measured_method: MeasureMethod;
  expected_tokens: number;
  ceiling_tokens: number;
  /** null when unpriced — NEVER 0. `0` reads as "free"; null reads as "unknown" (D-014). */
  expected_usd: number | null;
  ceiling_usd: number | null;
  /** Fraction (0..1) of the packet's expected tokens. The relative signal — the honest one. */
  share_of_packet: number;
};

export type TierEstimate = {
  tier: Tier;
  expected_usd: number | null;
  ceiling_usd: number | null;
  expected_tokens: number;
  ceiling_tokens: number;
  /** Agent runtime, minutes. null when the worker has no declared tokens_per_sec. */
  expected_minutes: number | null;
  ceiling_minutes: number | null;
  requirements: RequirementEstimate[];
};

/**
 * An alternative the user could actually take, with the honest price of taking
 * it. A trade-off that only lists what you SAVE is an advertisement, not a
 * trade-off — `costs_you` is mandatory (D-015).
 */
export type TradeOff = {
  id: string; // "model:claude-haiku-4-5" | "passes:2" | "tier:core"
  label: string;
  expected_usd: number | null;
  expected_minutes: number | null;
  expected_tokens: number;
  /** Negative = cheaper/faster than the baseline. null when the baseline is unpriced. */
  delta_usd_pct: number | null;
  delta_minutes_pct: number | null;
  costs_you: string;
};

export type SpecEstimate = {
  /** 0.2: usd fields are nullable, runtime + trade-offs added (spec-budget-v0 D-013..D-015). */
  schema_version: "0.2";
  packet: string;
  basis: "heuristic";
  confidence: "low";
  unit: "usd" | "tokens";
  tier_source: TierSource;
  build_passes: number;
  worker_model: string;
  /** Assumed agent throughput for the worker; null => no time is reported at all. */
  worker_tokens_per_sec: number | null;
  priced_with: string;
  stale: boolean;
  stale_age_days: number;
  /**
   * False when dollars could not be priced (missing pricing data or an unknown
   * worker model): every *_usd field is null — never 0 — and the token and time
   * ranges are the estimate (model-roster-data-v0 R-002/R-003, D-014).
   */
  priced: boolean;
  /** Worded degradation/unknown-model findings — always worded; a field in --json. */
  findings: string[];
  /** What this estimate does NOT price. Agent runtime is priced; human time is not. */
  excludes: string[];
  excluded_requirements: string[];
  measured_method: MeasureMethod;
  tiers: TierEstimate[];
  total: {
    expected_usd: number | null;
    ceiling_usd: number | null;
    expected_tokens: number;
    ceiling_tokens: number;
    expected_minutes: number | null;
    ceiling_minutes: number | null;
  };
  /** Ranked alternatives. Empty only when there is genuinely nothing to trade. */
  tradeoffs: TradeOff[];
};

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Blended per-token price: requirement build cost mixes reading (input) and
// generating (output), approximated 50/50 on the worker model. Documented
// assumption, single price source (pricing.yaml). Returns null when the model
// has no price — the caller degrades to token-only with a worded finding
// (model-roster-data-v0 R-002/R-003), never a throw and never another model's rates.
function blendedUsdPerToken(table: PricingTable, model: string): number | null {
  const price = table.models[model];
  if (!price) return null;
  return ((price.input_per_mtok + price.output_per_mtok) / 2) / 1_000_000;
}

async function measureRequirementTokens(
  text: string,
  opts: {
    model: string;
    apiKey?: string;
    preferApi: boolean;
    countTokensUrl?: string;
    routedNonNative?: boolean;
    /** True when the spec file is gitignored/local-only — such text never egresses. */
    localOnly?: boolean;
  },
): Promise<{ tokens: number; method: MeasureMethod }> {
  // D-010 egress gate: never egress requirement text to a routed third-party endpoint.
  if (opts.routedNonNative && opts.preferApi && opts.apiKey) {
    return { tokens: structuralTokens(text), method: "structural_egress_gated" };
  }
  if (opts.preferApi && opts.apiKey) {
    // CONTENT gate (D-016). The loop path has always guarded this same endpoint
    // with guardSourceForEgress; the spec path shipped without it and sent raw
    // spec.md text to count_tokens unredacted and unscanned. Two commands hitting
    // one endpoint under different rules is how a boundary rots — so the spec
    // path now runs the identical guard: a local-only source or a high-confidence
    // secret withholds egress entirely; otherwise only the REDACTED copy is sent.
    const decision = guardSourceForEgress(text, opts.localOnly === true);
    if (!decision.egress) {
      return { tokens: structuralTokens(text), method: "structural_egress_gated" };
    }
    try {
      return {
        tokens: await countTokensViaApi(opts.model, decision.text, opts.apiKey, opts.countTokensUrl),
        method: "count_tokens",
      };
    } catch {
      // graceful fallback — never block an estimate
    }
  }
  return { tokens: structuralTokens(text), method: "structural" };
}

export async function estimateSpecBudget(args: {
  packetDir: string;
  packetLabel: string;
  pricing: PricingTable;
  unit?: "usd" | "tokens";
  buildPasses?: number;
  workerModel?: string;
  apiKey?: string;
  preferApi?: boolean;
  now?: Date;
  /**
   * Repo root, used to ask git whether the spec is gitignored/local-only before
   * any count_tokens egress (D-016). Omitted => treated as not-local-only; the
   * secret scan in guardSourceForEgress still guards.
   */
  repoRoot?: string;
  // The resolved active model (glm-model-awareness-v0 R-001/D-003 single source).
  // Callers that know the repo root should thread it so the roster loads from the
  // same root as the price table; defaults to the environment-resolved model.
  active?: ActiveModel;
}): Promise<SpecEstimate> {
  const specPath = path.join(args.packetDir, "spec.md");
  if (!existsSync(specPath)) throw new Error("spec.md missing");
  const specText = readFileSync(specPath, "utf8");

  const { requirements, excluded } = parseRequirements(specText);
  const tierMap = parseTierMap(specText);
  const tierSource: TierSource = tierMap.size > 0 ? "decisions" : requirements.length > 0 ? "priority" : "single";

  const buildPasses = args.buildPasses ?? buildPassesDefault();
  // Price the resolved active model unless the caller pins one (R-002): a GLM-backed
  // session is priced at GLM rates, not hardcoded Opus.
  const active = args.active ?? resolveActiveModel();
  const worker = args.workerModel ?? active.worker;
  // Degraded pricing (model-roster-data-v0 R-002/R-003): a missing table or an
  // unknown worker downgrades dollar fields to token-only with a worded finding.
  const findings: string[] = [...(args.pricing.findings ?? [])];
  const blended = blendedUsdPerToken(args.pricing, worker);
  const priced = args.pricing.available !== false && blended !== null;
  if (args.pricing.available !== false && blended === null) {
    findings.push(`unknown model: ${worker} has no price in ${args.pricing.source} — dollar estimate degraded to token-only, no default-model rates assumed`);
  }
  // Unpriced => null, never 0. `0` is the one value that reads as a VALID and
  // attractive answer ("this tier is free"); null reads as "unknown" (D-014).
  const usdPerToken: number | null = priced && blended !== null ? blended : null;
  const money = (tokens: number): number | null => (usdPerToken === null ? null : round(tokens * usdPerToken, 4));

  const workerTps = args.pricing.models[worker]?.tokens_per_sec ?? null;
  if (priced && workerTps === null) {
    findings.push(`no throughput for ${worker} in ${args.pricing.source} — runtime estimate withheld (no made-up minutes)`);
  }
  // Agent runtime, minutes. Null-safe: a model with no declared throughput
  // reports NO time rather than an invented one (R-008).
  const minutes = (tokens: number, tps: number | null): number | null =>
    tps === null || tps <= 0 ? null : round(tokens / tps / 60, 1);

  const preferApi = args.preferApi ?? true;
  // Mirror the loop path: a gitignored/local-only spec never egresses (D-016).
  const localOnly = args.repoRoot ? isLocalOnly(args.repoRoot, specPath, specPath) : false;

  const order: Tier[] = ["core", "next", "deferred"];
  const buckets = new Map<Tier, RequirementEstimate[]>(order.map((tier) => [tier, []]));
  let anyApi = false;
  let anyStructural = false;
  let anyGated = false;

  for (const req of requirements) {
    const tier = assignTier(req, tierMap);
    if (tier === "excluded") {
      excluded.push(req.id);
      continue;
    }
    const { tokens, method } = await measureRequirementTokens(req.text, {
      model: worker,
      apiKey: args.apiKey,
      preferApi,
      countTokensUrl: active.countTokensUrl,
      routedNonNative: active.routed,
      localOnly,
    });
    if (method === "count_tokens") anyApi = true;
    else if (method === "structural_egress_gated") anyGated = true;
    else anyStructural = true;

    const expectedMult = PRIORITY_WEIGHT[req.priority];
    const ceilingMult = expectedMult * (1 + RISK_SURCHARGE[req.risk] + CONFIDENCE_SURCHARGE[req.confidence]);
    const expectedTokens = Math.round(tokens * expectedMult * buildPasses);
    const ceilingTokens = Math.round(tokens * ceilingMult * buildPasses);

    buckets.get(tier)!.push({
      id: req.id,
      priority: req.priority,
      risk: req.risk,
      confidence: req.confidence,
      tokens,
      measured_method: method,
      expected_tokens: expectedTokens,
      ceiling_tokens: ceilingTokens,
      expected_usd: money(expectedTokens),
      ceiling_usd: money(ceilingTokens),
      share_of_packet: 0, // filled once the packet total is known
    });
  }

  const tiers: TierEstimate[] = order
    .map((tier) => {
      const reqs = buckets.get(tier)!;
      const expectedTokens = reqs.reduce((s, r) => s + r.expected_tokens, 0);
      const ceilingTokens = reqs.reduce((s, r) => s + r.ceiling_tokens, 0);
      return {
        tier,
        requirements: reqs,
        expected_tokens: expectedTokens,
        ceiling_tokens: ceilingTokens,
        expected_usd: money(expectedTokens),
        ceiling_usd: money(ceilingTokens),
        expected_minutes: minutes(expectedTokens, workerTps),
        ceiling_minutes: minutes(ceilingTokens, workerTps),
      };
    })
    .filter((tier) => tier.requirements.length > 0);

  const totalExpectedTokens = tiers.reduce((s, t) => s + t.expected_tokens, 0);
  const totalCeilingTokens = tiers.reduce((s, t) => s + t.ceiling_tokens, 0);

  // The relative signal. This is the number that survives even when the dollars
  // are junk: "R-002 is a third of this build" is decision-grade; "$0.0714" is not.
  for (const tier of tiers) {
    for (const req of tier.requirements) {
      req.share_of_packet = totalExpectedTokens > 0 ? round(req.expected_tokens / totalExpectedTokens, 3) : 0;
    }
  }

  const total = {
    expected_tokens: totalExpectedTokens,
    ceiling_tokens: totalCeilingTokens,
    expected_usd: money(totalExpectedTokens),
    ceiling_usd: money(totalCeilingTokens),
    expected_minutes: minutes(totalExpectedTokens, workerTps),
    ceiling_minutes: minutes(totalCeilingTokens, workerTps),
  };

  const tradeoffs = buildTradeOffs({
    pricing: args.pricing,
    worker,
    workerTps,
    usdPerToken,
    buildPasses,
    tiers,
    totalExpectedTokens,
    baselineUsd: total.expected_usd,
    baselineMinutes: total.expected_minutes,
  });

  return {
    schema_version: "0.2",
    packet: args.packetLabel,
    basis: "heuristic",
    confidence: "low",
    unit: args.unit ?? "usd",
    tier_source: tierSource,
    build_passes: buildPasses,
    worker_model: worker,
    worker_tokens_per_sec: workerTps,
    priced_with: priced ? pricedWith(args.pricing) : args.pricing.available === false ? pricedWith(args.pricing) : "unpriced (unknown model)",
    stale: priced && pricingIsStale(args.pricing, args.now),
    stale_age_days: priced ? pricingAgeDays(args.pricing, args.now) : 0,
    priced,
    findings,
    // What this number does NOT cover. The dominant real cost of an agent building
    // a requirement is its EXECUTION — subagents, tool calls, re-reads, retries,
    // failed attempts — none of which this models. It sizes the requirement text and
    // a build-passes multiplier, nothing more. Measured against a real run this can
    // be low by an order of magnitude or worse, so it is a FLOOR, not a forecast.
    // Naming that here is the difference between a useful lower bound and a lie.
    //
    // This is also precisely WHY the estimate is a RELATIVE instrument (D-013): a
    // floor that omits the dominant cost term can never honestly answer "what will
    // this cost" — but it CAN answer "which parts are heavy, and what do my options
    // cost me," because the omitted overhead scales with all of them alike.
    //
    // R-007 (amended, D-013): AGENT RUNTIME is priced above and is deliberately NOT
    // in this list. HUMAN time — engineer-effort, calendar-time — is, and always
    // will be. The output must never conflate the two.
    excludes: [
      "engineer-effort",
      "calendar-time",
      "agent-execution-overhead (subagents, tool calls, retries — usually the dominant cost)",
    ],
    excluded_requirements: excluded,
    // count_tokens if any source used the API; else egress-gated if that's why we fell
    // back; else plain structural. The gated signal must survive to the surface (D-002).
    measured_method: anyApi ? "count_tokens" : anyGated && !anyStructural ? "structural_egress_gated" : "structural",
    tiers,
    total,
    tradeoffs,
  };
}

// --- Trade-offs (R-009 / D-015) ----------------------------------------------
//
// The point of a relative estimate is that the alternatives are comparable. Each
// option must state what it COSTS you, not only what it saves — an option list
// that only shows savings is an advertisement.
function buildTradeOffs(args: {
  pricing: PricingTable;
  worker: string;
  workerTps: number | null;
  usdPerToken: number | null;
  buildPasses: number;
  tiers: TierEstimate[];
  totalExpectedTokens: number;
  baselineUsd: number | null;
  baselineMinutes: number | null;
}): TradeOff[] {
  const { pricing, worker, buildPasses, tiers, totalExpectedTokens, baselineUsd, baselineMinutes } = args;
  const out: TradeOff[] = [];
  if (totalExpectedTokens === 0) return out;

  const pct = (next: number | null, base: number | null): number | null =>
    next === null || base === null || base === 0 ? null : Math.round(((next - base) / base) * 100);

  // 1. Swap the model. Token volume is text-derived and does not change with the
  //    model — only price and speed do. That is exactly why the honest caveat
  //    below matters: a weaker model plausibly needs MORE passes, which this
  //    arithmetic does NOT model. Never sell a model swap as free savings.
  const candidates = Object.entries(pricing.models)
    .filter(([name]) => name !== worker)
    .map(([name, price]) => {
      const perToken = (price.input_per_mtok + price.output_per_mtok) / 2 / 1_000_000;
      return {
        name,
        usd: round(totalExpectedTokens * perToken, 4),
        minutes: price.tokens_per_sec ? round(totalExpectedTokens / price.tokens_per_sec / 60, 1) : null,
        // foo default-denies autonomy on some families. Offering such a model as a
        // cheap win while `foo loop estimate --agree` would REFUSE it is foo
        // contradicting itself — so the deny rides along in the trade-off (D-017).
        autonomyDenied: autonomyDenied(price.family),
      };
    });

  const cheapest = [...candidates].sort((a, b) => a.usd - b.usd)[0];
  const fastest = [...candidates]
    .filter((c) => c.minutes !== null)
    .sort((a, b) => (a.minutes as number) - (b.minutes as number))[0];

  for (const pick of [cheapest, fastest]) {
    if (!pick) continue;
    if (out.some((o) => o.id === `model:${pick.name}`)) continue; // cheapest may also be fastest
    if (baselineUsd !== null && pick.usd >= baselineUsd && (pick.minutes === null || baselineMinutes === null || pick.minutes >= baselineMinutes)) {
      continue; // neither cheaper nor faster — not a trade-off worth offering
    }
    const samePassesCaveat =
      "This assumes the SAME number of build passes — a weaker model plausibly needs more, which would eat the saving. Unmeasured (role-expertise, not repo-evidence).";
    out.push({
      id: `model:${pick.name}`,
      label: `Build with ${pick.name} instead of ${worker}`,
      expected_usd: args.usdPerToken === null ? null : pick.usd,
      expected_minutes: pick.minutes,
      expected_tokens: totalExpectedTokens,
      delta_usd_pct: pct(pick.usd, baselineUsd),
      delta_minutes_pct: pct(pick.minutes, baselineMinutes),
      costs_you: pick.autonomyDenied
        ? `more than money: foo DEFAULT-DENIES autonomous work on this model (weaker self-correction makes it a degraded verifier of its own loop), so \`foo loop estimate --agree\` will refuse it unless you override with FOO_ALLOW_GLM_AUTONOMY=1. Plus capability on the hard requirements. ${samePassesCaveat}`
        : `capability on the hard requirements. ${samePassesCaveat}`,
    });
  }

  // 2. Spend fewer build passes. Linear and honest: passes is the biggest single
  //    assumption in the whole estimate.
  if (buildPasses > 1) {
    const scale = (buildPasses - 1) / buildPasses;
    const tokens = Math.round(totalExpectedTokens * scale);
    const usd = args.usdPerToken === null ? null : round(tokens * args.usdPerToken, 4);
    out.push({
      id: `passes:${buildPasses - 1}`,
      label: `Budget ${buildPasses - 1} build passes instead of ${buildPasses}`,
      expected_usd: usd,
      expected_minutes: args.workerTps === null ? null : round(tokens / args.workerTps / 60, 1),
      expected_tokens: tokens,
      delta_usd_pct: pct(usd, baselineUsd),
      delta_minutes_pct: pct(args.workerTps === null ? null : round(tokens / args.workerTps / 60, 1), baselineMinutes),
      costs_you: "rework headroom. If the build actually needs the last pass you pay for it anyway — this saves nothing, it only hides the cost until later.",
    });
  }

  // 3. Cut scope to core. The only lever that changes what you actually GET.
  const core = tiers.find((t) => t.tier === "core");
  const deferred = tiers.filter((t) => t.tier !== "core");
  if (core && deferred.length > 0 && core.expected_tokens < totalExpectedTokens) {
    const deferredIds = deferred.flatMap((t) => t.requirements.map((r) => r.id));
    out.push({
      id: "tier:core",
      label: "Build the core tier only",
      expected_usd: core.expected_usd,
      expected_minutes: core.expected_minutes,
      expected_tokens: core.expected_tokens,
      delta_usd_pct: pct(core.expected_usd, baselineUsd),
      delta_minutes_pct: pct(core.expected_minutes, baselineMinutes),
      costs_you: `you defer ${deferredIds.join(", ")}. This is the only option here that changes what you actually ship — the others just change what it costs to ship the same thing.`,
    });
  }

  return out;
}

export { loadPricing };
