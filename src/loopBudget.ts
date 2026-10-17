import { gitRun } from "./gitRun.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { configPath } from "./configPath.js";
import { parse as parseYaml } from "./vendorYaml.js";
import { redactText, scanText } from "./redactEngine.js";
import { fileStatKey, readMemoized, writeMemoized, type MemoEntry } from "./processMemo.js";
import { type ActiveModel, deriveCountTokensUrl, resolveActiveModel } from "./activeModel.js";

// Loop budget primitives for loop-budget-contract-v0: the budget block schema
// (R-001), the dated price table and token<->dollar conversion (R-002, R-008),
// and the cold/structural pre-flight estimator (R-003). The estimator is the
// "cold" tier: it never claims precision, always returns a range with an
// explicit basis and confidence, and reports which sources it measured so an
// under-declared `observe.sources` is visible.

export type BudgetUnit = "usd" | "tokens";
export type EstimateBasis = "heuristic" | "ledger" | "probed";
export type Confidence = "low" | "medium" | "high";
export type OnExceed = "ask" | "stop" | "checkpoint";

export type PerPassTokens = { observe: number; act: number; verify: number };
export type ModelMix = { worker: string; verifier: string };

export type BudgetEstimate = {
  expected: number;
  ceiling: number;
  basis: EstimateBasis;
  confidence: Confidence;
  per_pass_tokens: PerPassTokens;
  model_mix: ModelMix;
  priced_with: string;
};

export type BudgetAgreed = { by: string; at: string; event: string };

export type BudgetBlock = {
  unit: BudgetUnit;
  limit: number;
  estimate?: BudgetEstimate;
  agreed?: BudgetAgreed;
  max_iterations?: number;
  no_progress_after?: number;
  on_exceed?: OnExceed;
  warn_at?: number;
};

// --- Pricing table -----------------------------------------------------------

export type ModelPrice = {
  input_per_mtok: number;
  output_per_mtok: number;
  /**
   * Assumed effective agent throughput (tokens/sec, incl. tool turns). Optional:
   * a model with no declared rate yields NO time estimate rather than a made-up
   * one. Labeled assumption, same status as build_passes (spec-budget-v0 R-008).
   */
  tokens_per_sec?: number;
  /** Model family (claude | gpt | gemini | glm …). Lets a surface ask whether
   *  foo default-denies autonomy on this model before offering it as an option. */
  family?: string;
};
export type TokenUsage = {
  fresh_input?: number;
  cache_write?: number;
  cache_read?: number;
  output?: number;
};
export type PricingTable = {
  source: string; // basename, e.g. "pricing.yaml"
  date: string; // ISO date the table was priced
  staleAfterDays: number;
  currency: string;
  models: Record<string, ModelPrice>;
  /**
   * False when the table file is missing — dollar estimates degrade to
   * token-only instead of throwing (model-roster-data-v0 R-002). Absent means
   * available (so hand-built fixtures stay valid).
   */
  available?: boolean;
  /** Worded degradation findings carried into every estimate priced on this table. */
  findings?: string[];
};

// Token measurement has two tiers. The structural tier approximates tokens from
// source size — the offline default, deterministic and never presented as
// precise. When an API key is available, foo measures `observe.sources` with
// Anthropic `count_tokens` instead (never tiktoken — tiktoken is OpenAI's
// tokenizer and undercounts Claude tokens). The cost model around the
// measurement stays heuristic in V0 (per-pass act/verify projections and
// iteration counts), so `basis` remains "heuristic"; `measured_method` records
// which tier produced the token counts.
const CHARS_PER_TOKEN = 4;

const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_ACT_TOKENS = 2000;
const DEFAULT_VERIFY_TOKENS = 1000;
const DEFAULT_EXPECTED_ITERATIONS = 2;
const DEFAULT_CEILING_ITERATIONS = 5;

const BUDGET_KEYS = new Set([
  "unit",
  "limit",
  "estimate",
  "agreed",
  "max_iterations",
  "no_progress_after",
  "on_exceed",
  "warn_at",
]);
const ESTIMATE_KEYS = new Set([
  "expected",
  "ceiling",
  "basis",
  "confidence",
  "per_pass_tokens",
  "model_mix",
  "priced_with",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown key: ${key}`);
  }
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`${label} must be a number`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

// Parse and validate a `budget` block. Unknown keys are rejected so the
// contract stays stable (R-001). `estimate` and `agreed` are optional: a budget
// may be authored before the handshake; its missing `agreed` is what
// `foo loop check --strict-budget` rejects (R-005).
export function parseBudget(raw: unknown, label: string): BudgetBlock {
  if (!isObject(raw)) throw new Error(`${label} must be an object`);
  rejectUnknown(raw, BUDGET_KEYS, label);

  const unit = "unit" in raw ? requireString(raw.unit, `${label}.unit`) : "usd";
  if (unit !== "usd" && unit !== "tokens") throw new Error(`${label}.unit must be usd or tokens`);

  const budget: BudgetBlock = {
    unit,
    limit: requireNumber(raw.limit, `${label}.limit`),
  };

  if ("max_iterations" in raw) budget.max_iterations = requireNumber(raw.max_iterations, `${label}.max_iterations`);
  if ("no_progress_after" in raw) budget.no_progress_after = requireNumber(raw.no_progress_after, `${label}.no_progress_after`);
  if ("warn_at" in raw) budget.warn_at = requireNumber(raw.warn_at, `${label}.warn_at`);
  if ("on_exceed" in raw) {
    const onExceed = requireString(raw.on_exceed, `${label}.on_exceed`);
    if (onExceed !== "ask" && onExceed !== "stop" && onExceed !== "checkpoint") {
      throw new Error(`${label}.on_exceed must be ask, stop, or checkpoint`);
    }
    budget.on_exceed = onExceed;
  }

  if ("estimate" in raw) {
    const est = raw.estimate;
    if (!isObject(est)) throw new Error(`${label}.estimate must be an object`);
    rejectUnknown(est, ESTIMATE_KEYS, `${label}.estimate`);
    budget.estimate = {
      expected: requireNumber(est.expected, `${label}.estimate.expected`),
      ceiling: requireNumber(est.ceiling, `${label}.estimate.ceiling`),
      basis: requireString(est.basis, `${label}.estimate.basis`) as EstimateBasis,
      confidence: requireString(est.confidence, `${label}.estimate.confidence`) as Confidence,
      per_pass_tokens: est.per_pass_tokens as PerPassTokens,
      model_mix: est.model_mix as ModelMix,
      priced_with: requireString(est.priced_with, `${label}.estimate.priced_with`),
    };
  }

  if ("agreed" in raw) {
    const agreed = raw.agreed;
    if (!isObject(agreed)) throw new Error(`${label}.agreed must be an object`);
    budget.agreed = {
      by: requireString(agreed.by, `${label}.agreed.by`),
      at: requireString(agreed.at, `${label}.agreed.at`),
      event: requireString(agreed.event, `${label}.agreed.event`),
    };
  }

  return budget;
}

// Load the dated price table. A missing table is not a throw and not a silent
// default (model-roster-data-v0 R-002): it returns a degraded, empty table with
// an explicit worded finding, so dollar estimates downgrade to token-only and
// every surface says why. A present-but-malformed table still throws — corrupt
// data is an error, absent data is a degraded mode.
// Memoized per process (cli_performance-v0 R-002): loop paths call loadPricing
// several times per invocation; pricing.yaml is committed data, and the
// (mtime, size) key keeps an out-of-band edit honest.
const pricingCache = new Map<string, MemoEntry<PricingTable>>();

export function loadPricing(root: string): PricingTable {
  const pricingPath = configPath(root, "pricing.yaml");
  const key = fileStatKey(pricingPath);
  const cached = readMemoized(pricingCache, pricingPath, key);
  if (cached !== undefined) return cached;
  const value = computePricingTable(pricingPath);
  writeMemoized(pricingCache, pricingPath, key, value);
  return value;
}

function computePricingTable(pricingPath: string): PricingTable {
  if (!existsSync(pricingPath)) {
    return {
      source: "pricing.yaml",
      date: "",
      staleAfterDays: 0,
      currency: "usd",
      models: {},
      available: false,
      findings: ["pricing degraded: pricing.yaml missing at repo root or in config/ — dollar estimates unavailable, token-only estimates only"],
    };
  }
  const doc = parseYaml(readFileSync(pricingPath, "utf8"));
  if (!isObject(doc)) throw new Error("pricing.yaml must be an object");
  const models = doc.models;
  if (!isObject(models)) throw new Error("pricing.yaml.models must be an object");

  const parsedModels: Record<string, ModelPrice> = {};
  for (const [name, price] of Object.entries(models)) {
    if (!isObject(price)) throw new Error(`pricing.yaml.models.${name} must be an object`);
    parsedModels[name] = {
      input_per_mtok: requireNumber(price.input_per_mtok, `pricing.yaml.models.${name}.input_per_mtok`),
      output_per_mtok: requireNumber(price.output_per_mtok, `pricing.yaml.models.${name}.output_per_mtok`),
      // Optional (spec-budget-v0 R-008): assumed agent throughput, used to derive
      // runtime. Absent => the estimate reports no time rather than inventing one.
      ...(typeof price.tokens_per_sec === "number" ? { tokens_per_sec: price.tokens_per_sec } : {}),
      ...(typeof price.family === "string" ? { family: price.family } : {}),
    };
  }

  return {
    source: "pricing.yaml",
    date: requireString(doc.date, "pricing.yaml.date"),
    staleAfterDays: typeof doc.stale_after_days === "number" ? doc.stale_after_days : 30,
    currency: typeof doc.currency === "string" ? doc.currency : "usd",
    models: parsedModels,
    available: true,
    findings: [],
  };
}

export function pricedWith(table: PricingTable): string {
  if (table.available === false) return `unpriced (${table.source} missing)`;
  return `${table.source}@${table.date}`;
}

/** Convert observed token categories with one model's declared dated rates. */
export function priceTokenUsage(table: PricingTable, model: string, usage: TokenUsage): { usd: number; priced_with: string } | null {
  const rate = table.available === false ? undefined : table.models[model];
  if (!rate) return null;
  const inputTokens = (usage.fresh_input ?? 0) + (usage.cache_write ?? 0) + (usage.cache_read ?? 0);
  const outputTokens = usage.output ?? 0;
  return {
    usd: (inputTokens / 1_000_000) * rate.input_per_mtok + (outputTokens / 1_000_000) * rate.output_per_mtok,
    priced_with: pricedWith(table),
  };
}

// Days between the table date and `now`; > staleAfterDays means a staleness
// signal must surface (R-008).
export function pricingAgeDays(table: PricingTable, now: Date = new Date()): number {
  const priced = new Date(`${table.date}T00:00:00Z`).getTime();
  if (Number.isNaN(priced)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - priced) / (1000 * 60 * 60 * 24));
}

export function pricingIsStale(table: PricingTable, now: Date = new Date()): boolean {
  return pricingAgeDays(table, now) > table.staleAfterDays;
}

// --- Token measurement (cold tier) -------------------------------------------

// "structural_egress_gated" is the structural tier reached *because* the count_tokens
// call was withheld on a routed (non-native) endpoint — distinct from a plain offline
// structural estimate so the surface can fly ⚠️ and explain why (D-010 / C-011).
export type MeasureMethod = "count_tokens" | "structural" | "structural_egress_gated";
/**
 * `external` = the source is not a local file (a URL, a leaderboard, "arXiv cs.SE").
 * Its size CANNOT be measured offline, so it is priced with a conservative floor
 * rather than counted as zero — see EXTERNAL_SOURCE_TOKENS.
 */
export type SourceMeasurement = { source: string; found: boolean; tokens: number; external?: boolean };
export type MeasuredSources = { total: number; measured: SourceMeasurement[]; method: MeasureMethod };

// A loop may observe the WEB, not just packet files (a scheduled research refresh
// is the motivating case). Such a source CANNOT be sized offline, and we refuse to
// pretend otherwise.
//
// Two wrong answers were considered and rejected:
//   - 0 tokens (the original bug): the loop priced at ~$0, fell under the $0.50
//     handshake floor, and AUTO-APPROVED itself — bypassing the human budget
//     handshake for exactly the loops whose cost is least knowable.
//   - A "conservative default" of N tokens: this is false precision. A fabricated
//     token count flows straight into "$1.0100 expected .. $2.5250 ceiling", which
//     reads as a prediction. Dressing a guess in four decimal places is not honesty.
//
// The honest answer is the one foo already uses for missing pricing data: the cost
// is UNKNOWN. An unmeasurable source contributes no invented tokens; it marks the
// estimate unmeasurable, which (a) forbids auto-approval and (b) forbids agreeing a
// dollar budget derived from the estimate. A human may still authorise the loop —
// but by setting an explicit spend CAP, which is a decision, not a prediction.

// A source that isn't a path we can stat is treated as external rather than
// missing: "https://…", "arXiv cs.SE (routing)", "provider pricing pages".
function looksExternal(source: string): boolean {
  return /^[a-z]+:\/\//i.test(source) || /\s/.test(source) || /\.(ai|com|dev|org|io)\b/i.test(source);
}

// Structural (offline) token approximation — the shared chars/token basis used
// by both the loop estimator and the spec estimator.
export function structuralTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function measureSources(packetDir: string, sources: string[]): { total: number; measured: SourceMeasurement[] } {
  const measured = sources.map((source): SourceMeasurement => {
    const sourcePath = path.join(packetDir, source);
    if (existsSync(sourcePath)) return { source, found: true, tokens: structuralTokens(readFileSync(sourcePath, "utf8")) };
    // Not a file we can read. A web/external source is UNMEASURABLE — it carries no
    // invented token count (that would be false precision); it flags the estimate as
    // resting on an unknown. A genuinely missing packet file stays 0: its absence is
    // the finding, not its size.
    if (looksExternal(source)) return { source, found: false, external: true, tokens: 0 };
    return { source, found: false, tokens: 0 };
  });
  const total = measured.reduce((sum, item) => sum + item.tokens, 0);
  return { total, measured };
}

/** Does this measurement contain a source whose size we could not actually determine? */
export function hasExternalSources(measured: SourceMeasurement[]): boolean {
  return measured.some((item) => item.external === true);
}

// Count one source's tokens with Anthropic count_tokens. Single non-streaming
// call; raw fetch keeps this minimal CLI free of an SDK dependency for an
// optional, offline-first feature. Throws on any non-2xx so the caller can fall
// back to the structural tier.
// The count_tokens endpoint follows the active base URL (R-003): on a GLM-via-z.ai
// session it targets api.z.ai, not api.anthropic.com. Defaults to the native Anthropic
// endpoint when no URL is supplied so existing callers are unaffected.
export async function countTokensViaApi(
  model: string,
  text: string,
  apiKey: string,
  url: string = deriveCountTokensUrl("https://api.anthropic.com"),
): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
  });
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
  const data = (await res.json()) as { input_tokens?: unknown };
  if (typeof data.input_tokens !== "number") throw new Error("count_tokens response missing input_tokens");
  return data.input_tokens;
}

// --- Egress guard (security-hardening-followups-v0 R-002 / OQ-4) -------------
// The count_tokens path sends source content to api.anthropic.com. Never egress
// local-only/gitignored content or content carrying a high-confidence secret;
// otherwise send a REDACTED copy so no raw secret leaves the machine.

const LOCAL_ONLY = /(^|\/)integration-events\.jsonl$/; // local-only summary ledger (B1)

export function isLocalOnly(repoCwd: string, source: string, sourcePath: string): boolean {
  if (LOCAL_ONLY.test(source)) return true;
  // exit 0 => the path is gitignored; non-zero (not ignored) or git
  // unavailable => false — the secret scan still guards.
  return gitRun(["check-ignore", "-q", "--", sourcePath], { cwd: repoCwd, stdio: ["ignore", "ignore", "ignore"] }).ok;
}

// Pure decision (testable without network or git): may this source's text go to
// the count_tokens API, and in what form?
export function guardSourceForEgress(
  text: string,
  localOnly: boolean,
): { egress: false; reason: string } | { egress: true; text: string } {
  if (localOnly) return { egress: false, reason: "local-only / gitignored source" };
  if (scanText(text).counts.high > 0) return { egress: false, reason: "high-confidence secret present" };
  return { egress: true, text: redactText(text).redactedText };
}

// Measure sources, preferring count_tokens when a key is available and not
// disabled. Any failure (no key, network, auth, rate limit) falls back to the
// structural tier rather than blocking an estimate.
export async function measureSourcesCounted(
  packetDir: string,
  sources: string[],
  opts: { model: string; apiKey?: string; preferApi: boolean; countTokensUrl?: string; routedNonNative?: boolean },
): Promise<MeasuredSources> {
  if (!opts.preferApi || !opts.apiKey) {
    return { ...measureSources(packetDir, sources), method: "structural" };
  }
  // D-010 egress gate: on a non-native (routed) endpoint, never send source text to a
  // third-party count_tokens — withhold the call and use the structural tier until the
  // R-006a inference-egress boundary lands. The derived URL stays correct; only the
  // *call* is gated, and the distinct method lets the surface fly ⚠️ (D-002 fail-loud).
  if (opts.routedNonNative) {
    return { ...measureSources(packetDir, sources), method: "structural_egress_gated" };
  }
  try {
    const measured: SourceMeasurement[] = [];
    for (const source of sources) {
      const sourcePath = path.join(packetDir, source);
      if (!existsSync(sourcePath)) {
        measured.push({ source, found: false, tokens: 0 });
        continue;
      }
      const text = readFileSync(sourcePath, "utf8");
      // R-002: never egress local-only or secret-bearing content — fall back to
      // the structural tier for that source instead.
      const decision = guardSourceForEgress(text, isLocalOnly(packetDir, source, sourcePath));
      const tokens = decision.egress
        ? await countTokensViaApi(opts.model, decision.text, opts.apiKey, opts.countTokensUrl)
        : structuralTokens(text);
      measured.push({ source, found: true, tokens });
    }
    const total = measured.reduce((sum, item) => sum + item.tokens, 0);
    return { total, measured, method: "count_tokens" };
  } catch {
    return { ...measureSources(packetDir, sources), method: "structural" };
  }
}

// --- Estimator ---------------------------------------------------------------

export type EstimateResult = {
  unit: BudgetUnit;
  usd: { expected: number; ceiling: number };
  tokens: { expected: number; ceiling: number };
  expected_iterations: number;
  ceiling_iterations: number;
  per_pass_tokens: PerPassTokens;
  model_mix: ModelMix;
  // Active-model provenance (R-004 / T-004): which model the estimate was priced
  // for and how sure we are. `confidence: "assumed"` means the model was inferred
  // from a base-URL override and the surface should fly the ⚠️ tag.
  model_provenance: { provider: string; family: string; confidence: "confirmed" | "assumed" };
  basis: EstimateBasis;
  confidence: Confidence;
  priced_with: string;
  measured: SourceMeasurement[];
  measured_method: MeasureMethod;
  stale: boolean;
  stale_age_days: number;
  /**
   * False when dollars could not be priced (missing pricing data or an unknown
   * model): the usd range is zeroed and MUST NOT be trusted — token numbers are
   * the estimate (model-roster-data-v0 R-002/R-003). Fail-closed consumers
   * (loop check auto-approval) treat unpriced as at/above the handshake floor.
   */
  priced: boolean;
  /**
   * True when at least one observation source could not be sized offline (the web).
   * The token and dollar ranges below then rest on an UNKNOWN and must not be shown
   * as a prediction — no fabricated "expected .. ceiling". A human may still
   * authorise the loop, but by setting an explicit spend cap, not by agreeing to a
   * number foo invented.
   */
  unmeasurable: boolean;
  /** Worded degradation/unknown-model findings. Always worded; a field in --json; glyphs are the caller's job. */
  findings: string[];
};

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function estimateLoopBudget(args: {
  packetDir: string;
  sources: string[];
  pricing: PricingTable;
  unit?: BudgetUnit;
  budget?: BudgetBlock;
  now?: Date;
  // Pre-measured token counts (e.g. from count_tokens). When absent the
  // estimator measures structurally.
  measured?: MeasuredSources;
  // The resolved active model (R-001/D-003 single source). Defaults to the
  // environment-resolved model so callers that don't thread it still price the
  // active model, not hardcoded Opus.
  active?: ActiveModel;
}): EstimateResult {
  const unit = args.unit ?? args.budget?.unit ?? "usd";
  const active = args.active ?? resolveActiveModel();
  // An explicit budget model_mix still wins (a packet may pin its models); otherwise
  // default to the *resolved active* model, not the hardcoded native one (R-002).
  const worker = args.budget?.estimate?.model_mix?.worker ?? active.worker;
  const verifier = args.budget?.estimate?.model_mix?.verifier ?? active.verifier;
  const expectedIterations = args.budget?.no_progress_after ?? DEFAULT_EXPECTED_ITERATIONS;
  const ceilingIterations = args.budget?.max_iterations ?? DEFAULT_CEILING_ITERATIONS;

  const measurement = args.measured ?? { ...measureSources(args.packetDir, args.sources), method: "structural" as const };
  const observeTokens = measurement.total;
  const measured = measurement.measured;
  const perPass: PerPassTokens = {
    observe: observeTokens,
    act: DEFAULT_ACT_TOKENS,
    verify: DEFAULT_VERIFY_TOKENS,
  };

  // Degraded pricing (model-roster-data-v0 R-002/R-003): a missing table or an
  // unknown model downgrades the dollar range to token-only with an explicit,
  // worded finding — never a throw, and never another model's rates.
  const findings: string[] = [...(args.pricing.findings ?? [])];
  const workerPrice = args.pricing.models[worker];
  const verifierPrice = args.pricing.models[verifier];
  let priced = args.pricing.available !== false;
  if (args.pricing.available !== false) {
    if (!workerPrice) findings.push(`unknown model: ${worker} has no price in ${args.pricing.source} — dollar estimate degraded to token-only, no default-model rates assumed`);
    if (!verifierPrice && verifier !== worker) findings.push(`unknown model: ${verifier} has no price in ${args.pricing.source} — dollar estimate degraded to token-only, no default-model rates assumed`);
    if (!workerPrice || !verifierPrice) priced = false;
  }

  // Worker reads the sources (input) and produces the action (output); the
  // verifier re-reads the same sources (input) and emits its check (output).
  const workerUsage = priceTokenUsage(args.pricing, worker, { fresh_input: perPass.observe, output: perPass.act });
  const verifierUsage = priceTokenUsage(args.pricing, verifier, { fresh_input: perPass.observe, output: perPass.verify });
  const perPassUsd = priced && workerUsage && verifierUsage ? workerUsage.usd + verifierUsage.usd : 0;

  const perPassTokens = perPass.observe + perPass.act + perPass.observe + perPass.verify;

  const usd = {
    expected: round(perPassUsd * expectedIterations, 4),
    ceiling: round(perPassUsd * ceilingIterations, 4),
  };
  const tokens = {
    expected: perPassTokens * expectedIterations,
    ceiling: perPassTokens * ceilingIterations,
  };

  const stale = priced && pricingIsStale(args.pricing, args.now);
  if (stale) {
    findings.push(
      `pricing stale: ${args.pricing.source}@${args.pricing.date} is ${pricingAgeDays(args.pricing, args.now)} days old (stale_after_days: ${args.pricing.staleAfterDays}) — dollar range priced on stale rates`,
    );
  }

  // An unmeasurable source means the cost is UNKNOWN, not "probably about N". Say so
  // in words and let every downstream surface refuse to print a fabricated range.
  const unmeasurable = hasExternalSources(measured);
  if (unmeasurable) {
    const external = measured.filter((m) => m.external).map((m) => m.source);
    findings.push(
      `cost unknown: ${external.length} observation source(s) cannot be sized offline (${external.slice(0, 3).join("; ")}${external.length > 3 ? "; …" : ""}) — this loop reads the web, so its cost cannot be estimated. Authorise it with an explicit cap: foo loop estimate <packet-dir> --agree --limit <usd>`,
    );
  }

  return {
    unit,
    usd,
    tokens,
    expected_iterations: expectedIterations,
    ceiling_iterations: ceilingIterations,
    per_pass_tokens: perPass,
    model_mix: { worker, verifier },
    model_provenance: { provider: active.provider, family: active.family, confidence: active.confidence },
    // Cold/structural tier: heuristic basis, low confidence. No fake precision.
    basis: "heuristic",
    confidence: "low",
    priced_with: priced ? pricedWith(args.pricing) : args.pricing.available === false ? pricedWith(args.pricing) : "unpriced (unknown model)",
    unmeasurable,
    measured,
    measured_method: measurement.method,
    stale,
    stale_age_days: priced ? pricingAgeDays(args.pricing, args.now) : 0,
    priced,
    findings,
  };
}

// Build the budget block to record on agreement: the agreed ceiling becomes the
// limit, the estimate is preserved as provenance, and the agreed handshake is
// stamped (R-004).
//
// B4 carve-out (model-roster-data-v0 R-002): degraded pricing affects estimation,
// never the handshake itself — an *agreed dollar budget* still requires priced
// data, so an unpriced dollar agreement is refused rather than recorded at $0.00.
// A token-unit budget needs no price table and stays agreeable.
export function buildAgreedBudget(
  result: EstimateResult,
  opts: { by: string; at: string; limit?: number },
): BudgetBlock {
  // Cost is UNKNOWN (the loop reads sources productfoo cannot size). There is no honest
  // estimate to agree to — so the only way to authorise it is for a human to name a
  // spend CAP. That is a decision, not a prediction, and it is recorded as such: the
  // budget carries the human's limit and NO fabricated expected/ceiling range.
  if (result.unmeasurable) {
    if (opts.limit === undefined) {
      throw new Error(
        `cannot agree a budget for a loop whose cost is unknown (${result.findings.find((f) => f.startsWith("cost unknown")) ?? "unmeasurable sources"}) — ` +
          "there is no estimate to agree to. Authorise it with an explicit cap you choose: --agree --limit <usd>.",
      );
    }
    if (!(opts.limit > 0)) throw new Error("--limit must be a positive dollar amount");
    return {
      unit: "usd",
      limit: opts.limit,
      // basis `human-cap`: the number came from a person, not from an estimator.
      estimate: {
        expected: 0,
        ceiling: 0,
        basis: "heuristic",
        confidence: "low",
        per_pass_tokens: result.per_pass_tokens,
        model_mix: result.model_mix,
        priced_with: "unmeasurable — cost unknown; cap set by human",
      },
      agreed: { by: opts.by, at: opts.at, event: "com.adaptivespec.loop.budget_agreed" },
      max_iterations: result.ceiling_iterations,
      no_progress_after: result.expected_iterations,
      on_exceed: "ask",
      warn_at: 0.8,
    };
  }

  if (result.unit === "usd" && !result.priced) {
    throw new Error(
      `cannot agree a dollar budget on unpriced data (${result.findings.join("; ") || "pricing degraded"}) — ` +
        "restore pricing.yaml (or add the model's rates), or agree a token budget with --unit tokens. " +
        "Degraded pricing never waives the budget handshake (B4).",
    );
  }
  const inUnit = (which: "expected" | "ceiling"): number =>
    result.unit === "tokens" ? result.tokens[which] : result.usd[which];

  return {
    unit: result.unit,
    limit: inUnit("ceiling"),
    estimate: {
      expected: inUnit("expected"),
      ceiling: inUnit("ceiling"),
      basis: result.basis,
      confidence: result.confidence,
      per_pass_tokens: result.per_pass_tokens,
      model_mix: result.model_mix,
      priced_with: result.priced_with,
    },
    agreed: {
      by: opts.by,
      at: opts.at,
      event: "com.adaptivespec.loop.budget_agreed",
    },
    max_iterations: result.ceiling_iterations,
    no_progress_after: result.expected_iterations,
    on_exceed: "ask",
    warn_at: 0.8,
  };
}

// Default dollar floor below which the handshake is skipped and the loop is
// auto-approved (R-006). Overridable via FOO_BUDGET_HANDSHAKE_FLOOR.
export function handshakeFloorUsd(): number {
  const raw = process.env.FOO_BUDGET_HANDSHAKE_FLOOR;
  if (raw === undefined) return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.5;
}
