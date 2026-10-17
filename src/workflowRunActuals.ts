import { createHash } from "node:crypto";
import { type PricingTable, priceTokenUsage, pricedWith, type TokenUsage } from "./loopBudget.js";
import { canonicalJson, type JsonValue } from "./trustEnvelope.js";

export type WorkflowUsagePopulation = "proxy" | "agent_reported";
export type WorkflowUsageSource = "inference_proxy" | "agent_cli";

export type WorkflowRunActualV1 = {
  schema_version: "1";
  population: WorkflowUsagePopulation;
  source: WorkflowUsageSource;
  run_id: string;
  packet_id?: string;
  task_id?: string;
  lane: "direct" | "shape-fast" | "review-targeted" | "deep-explicit";
  harness: string;
  scaffold: string;
  phase: string;
  model: string;
  tokens: TokenUsage;
  call_count?: number;
  expected_phase_count?: number;
  wall_time_ms?: number;
  recommendation_changed?: boolean;
  observed_at: string;
};

export type RunActualRejection =
  | "invalid_shape" | "unknown_field" | "forbidden_field"
  | "invalid_identifier" | "invalid_number" | "invalid_timestamp";

type RunActualParseResult =
  | { ok: true; value: WorkflowRunActualV1 }
  | { ok: false; reason: RunActualRejection; remediation: string };

const TOP_LEVEL_KEYS = new Set([
  "schema_version", "population", "source", "run_id", "packet_id", "task_id", "lane", "harness", "scaffold", "phase", "model", "tokens", "call_count", "expected_phase_count", "wall_time_ms", "recommendation_changed", "observed_at",
]);
const TOKEN_KEYS = new Set(["fresh_input", "cache_write", "cache_read", "output"]);
const FORBIDDEN_KEYS = new Set(["prompt", "output_text", "source_url", "user", "headers", "metadata"]);
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const TOKEN_CATEGORIES = ["fresh_input", "cache_write", "cache_read", "output"] as const;

export type WorkflowCostRegime =
  | { kind: "measured"; population: WorkflowUsagePopulation; sample_count: number; median: TokenUsage; median_usd: number | null; priced_with: string }
  | { kind: "estimated"; population: null; sample_count: number; estimate: TokenUsage }
  | { kind: "unavailable"; population: null; sample_count: number; reason: "no_comparable_rows" | "incomplete_usage" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejection(reason: RunActualRejection, remediation: string): RunActualParseResult {
  return { ok: false, reason, remediation };
}

function hasOnlyDataProperties(value: Record<string, unknown>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable) && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isPositiveCounter(value: unknown): value is number {
  return isCounter(value) && value > 0;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function parseWorkflowRunActual(value: unknown): RunActualParseResult {
  if (!isPlainObject(value) || !hasOnlyDataProperties(value)) return rejection("invalid_shape", "provide a plain JSON object");

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return rejection("forbidden_field", "remove content-bearing fields");
    if (!TOP_LEVEL_KEYS.has(key)) return rejection("unknown_field", "remove fields outside the run-actual schema");
  }

  if (value.schema_version !== "1" ||
    (value.population !== "proxy" && value.population !== "agent_reported") ||
    (value.source !== "inference_proxy" && value.source !== "agent_cli") ||
    (value.lane !== "direct" && value.lane !== "shape-fast" && value.lane !== "review-targeted" && value.lane !== "deep-explicit") ||
    !isPlainObject(value.tokens) || !hasOnlyDataProperties(value.tokens) ||
    typeof value.recommendation_changed !== "undefined" && typeof value.recommendation_changed !== "boolean") {
    return rejection("invalid_shape", "provide fields with their declared schema values");
  }

  for (const key of ["run_id", "packet_id", "task_id", "harness", "scaffold", "phase", "model"] as const) {
    if (!(key in value) ? key === "packet_id" || key === "task_id" : isIdentifier(value[key])) continue;
    return rejection("invalid_identifier", "use bounded lowercase identifiers");
  }

  for (const key of Object.keys(value.tokens)) {
    if (!TOKEN_KEYS.has(key)) return rejection("unknown_field", "remove token categories outside the schema");
    if (!isCounter(value.tokens[key])) return rejection("invalid_number", "use finite non-negative integer counters");
  }
  for (const key of ["call_count", "wall_time_ms"] as const) {
    if (key in value && !isCounter(value[key])) return rejection("invalid_number", "use finite non-negative integer counters");
  }
  if ("expected_phase_count" in value && !isPositiveCounter(value.expected_phase_count)) {
    return rejection("invalid_number", "use a positive expected phase count");
  }
  if (!isCanonicalUtcTimestamp(value.observed_at)) return rejection("invalid_timestamp", "use a canonical UTC ISO timestamp");

  return { ok: true, value: value as WorkflowRunActualV1 };
}

/** Stable id for deduplicating an accepted record across durable sinks. */
export function workflowActualEventId(value: WorkflowRunActualV1): string {
  const bytes = canonicalJson(value as unknown as JsonValue);
  return `workflow-run-actual:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

type RegimeEntry = Pick<WorkflowRunActualV1, "phase" | "model" | "call_count">;
type AggregatedRun = { tokens: TokenUsage; pricedUsd: number | null; regimeKey: string };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable v1 comparability identity: JSON of every [phase, model, call-count]
 * entry, lexicographically sorted. Rows are never deduplicated, so both
 * multiplicity and phase/model assignment remain part of the regime.
 */
export function workflowRunRegimeKey(rows: readonly RegimeEntry[]): string {
  const entries = rows.map((row) => [row.phase, row.model, row.call_count ?? 1] as const);
  entries.sort((left, right) =>
    compareText(left[0], right[0]) || compareText(left[1], right[1]) || left[2] - right[2]);
  return JSON.stringify(entries);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function medianUsage(runs: readonly AggregatedRun[]): TokenUsage {
  const result: TokenUsage = {};
  for (const category of TOKEN_CATEGORIES) {
    const values = runs.map((run) => run.tokens[category]);
    if (values.every((value): value is number => value !== undefined)) result[category] = median(values);
  }
  return result;
}

export function summarizeWorkflowRunActuals(rows: readonly WorkflowRunActualV1[], input: {
  packet_id?: string;
  lane?: WorkflowRunActualV1["lane"];
  harness: string;
  scaffold: string;
  pricing: PricingTable;
}): WorkflowCostRegime {
  const comparable = rows.filter((row) => {
    const parsed = parseWorkflowRunActual(row);
    return parsed.ok &&
      (input.packet_id === undefined || parsed.value.packet_id === input.packet_id) &&
      (input.lane === undefined || parsed.value.lane === input.lane) &&
      parsed.value.harness === input.harness && parsed.value.scaffold === input.scaffold;
  });
  if (comparable.length === 0) return { kind: "unavailable", population: null, sample_count: 0, reason: "no_comparable_rows" };

  const populations = new Set(comparable.map((row) => row.population));
  if (populations.size !== 1) {
    return { kind: "unavailable", population: null, sample_count: 0, reason: "incomplete_usage" };
  }

  const grouped = new Map<string, WorkflowRunActualV1[]>();
  for (const row of comparable) {
    const current = grouped.get(row.run_id) ?? [];
    current.push(row);
    grouped.set(row.run_id, current);
  }

  const runs: AggregatedRun[] = [];
  for (const phases of grouped.values()) {
    const expectedCounts = new Set(phases.map((phase) => phase.expected_phase_count));
    const hasExpectedCount = phases.every((phase) => phase.expected_phase_count !== undefined);
    const complete = hasExpectedCount
      ? expectedCounts.size === 1 && phases.length === phases[0].expected_phase_count
      : phases.every((phase) => phase.expected_phase_count === undefined) && phases.length === 1;
    if (!complete) continue;

    const tokens: TokenUsage = {};
    const known = new Set<string>(TOKEN_CATEGORIES);
    let pricedUsd: number | null = 0;
    for (const row of phases) {
      for (const category of TOKEN_CATEGORIES) {
        const count = row.tokens[category];
        if (count === undefined) {
          known.delete(category);
          delete tokens[category];
        } else if (known.has(category)) {
          tokens[category] = (tokens[category] ?? 0) + count;
        }
      }
      const priced = priceTokenUsage(input.pricing, row.model, row.tokens);
      pricedUsd = pricedUsd === null || priced === null ? null : pricedUsd + priced.usd;
    }
    if (Object.keys(tokens).length === 0) continue;
    if (!TOKEN_CATEGORIES.every((category) => known.has(category))) pricedUsd = null;
    runs.push({ tokens, pricedUsd, regimeKey: workflowRunRegimeKey(phases) });
  }

  if (runs.length === 0) {
    return { kind: "unavailable", population: null, sample_count: 0, reason: "no_comparable_rows" };
  }

  const regimes = new Map<string, AggregatedRun[]>();
  for (const run of runs) {
    const candidate = regimes.get(run.regimeKey) ?? [];
    candidate.push(run);
    regimes.set(run.regimeKey, candidate);
  }
  const selected = [...regimes.entries()]
    .sort((left, right) => right[1].length - left[1].length || compareText(left[0], right[0]))[0][1];

  const usage = medianUsage(selected);
  if (selected.length < 10) return { kind: "estimated", population: null, sample_count: selected.length, estimate: usage };
  const costs = selected.map((run) => run.pricedUsd);
  return {
    kind: "measured",
    population: comparable[0].population,
    sample_count: selected.length,
    median: usage,
    median_usd: costs.every((cost): cost is number => cost !== null) ? median(costs) : null,
    priced_with: pricedWith(input.pricing),
  };
}
