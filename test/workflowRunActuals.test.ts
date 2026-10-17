import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PricingTable } from "../src/loopBudget.js";
import type { WorkflowRunActualV1, WorkflowUsagePopulation } from "../src/workflowRunActuals.js";

async function runActuals() {
  return import("../src/" + "workflowRunActuals.js");
}

function actual(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1",
    population: "proxy",
    source: "inference_proxy",
    run_id: "run-001",
    packet_id: "run-cost-telemetry-v0",
    task_id: "t-001",
    lane: "deep-explicit",
    harness: "foo-hosted",
    scaffold: "research-panel-v1",
    phase: "provider-call",
    model: "claude-sonnet-4",
    tokens: { fresh_input: 101, output: 31 },
    call_count: 1,
    wall_time_ms: 1000,
    recommendation_changed: false,
    observed_at: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

test("the run-actual schema is closed and errors never echo values", async () => {
  const { parseWorkflowRunActual } = await runActuals();
  assert.equal(parseWorkflowRunActual(actual()).ok, true);

  for (const field of ["prompt", "output_text", "source_url", "user", "headers", "metadata"]) {
    const secret = "private-canary-value";
    const result = parseWorkflowRunActual({ ...actual(), [field]: secret });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private-canary-value/);
  }
});

test("missing token categories stay unknown", async () => {
  const { parseWorkflowRunActual } = await runActuals();
  const result = parseWorkflowRunActual(actual({ tokens: { output: 31 } }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.tokens, { output: 31 });
});

test("expected phase count is an optional positive completion invariant", async () => {
  const { parseWorkflowRunActual } = await runActuals();
  const present = parseWorkflowRunActual(actual({ expected_phase_count: 2 }));
  assert.equal(present.ok, true);
  if (present.ok) assert.equal((present.value as WorkflowRunActualV1 & { expected_phase_count?: number }).expected_phase_count, 2);
  assert.equal(parseWorkflowRunActual(actual({ expected_phase_count: 0 })).ok, false);
});

function row(population: WorkflowUsagePopulation, runId: string, tokens: WorkflowRunActualV1["tokens"], overrides: Partial<WorkflowRunActualV1> & { expected_phase_count?: number } = {}): WorkflowRunActualV1 {
  return {
    schema_version: "1",
    population,
    source: population === "proxy" ? "inference_proxy" : "agent_cli",
    run_id: runId,
    packet_id: "run-cost-telemetry-v0",
    lane: "deep-explicit",
    harness: "foo-hosted",
    scaffold: "research-panel-v1",
    phase: "main",
    model: "m",
    tokens,
    observed_at: "2026-07-31T12:00:00.000Z",
    ...overrides,
  } as WorkflowRunActualV1;
}

const pricing: PricingTable = {
  source: "pricing.yaml",
  date: "2026-07-31",
  staleAfterDays: 30,
  currency: "usd",
  models: { m: { input_per_mtok: 2, output_per_mtok: 8 } },
};

test("run summaries keep populations separate, sum phases by run, and exclude other scaffolds", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const complete = { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 };
  const proxy = Array.from({ length: 10 }, (_, index) => {
    const runId = `proxy-${index + 1}`;
    return [
      row("proxy", runId, { fresh_input: 50, cache_write: 10, cache_read: 2, output: 5 }, { phase: "phase-a", expected_phase_count: 2 }),
      row("proxy", runId, { fresh_input: 50, cache_write: 10, cache_read: 3, output: 5 }, { phase: "phase-b", expected_phase_count: 2 }),
    ];
  }).flat();
  proxy.push(row("proxy", "other-scaffold", { fresh_input: 9_999, cache_write: 9_999, cache_read: 9_999, output: 9_999 }, { scaffold: "other-v1" }));
  const agent = Array.from({ length: 10 }, (_, index) => row("agent_reported", `agent-${index + 1}`, { fresh_input: 200, cache_write: 40, cache_read: 10, output: 20 }));

  assert.deepEqual(summarizeWorkflowRunActuals(proxy, {
    packet_id: "run-cost-telemetry-v0", lane: "deep-explicit", harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), {
    kind: "measured",
    population: "proxy",
    sample_count: 10,
    median: complete,
    median_usd: 0.00033,
    priced_with: "pricing.yaml@2026-07-31",
  });
  assert.deepEqual(summarizeWorkflowRunActuals(agent, {
    packet_id: "run-cost-telemetry-v0", lane: "deep-explicit", harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), {
    kind: "measured",
    population: "agent_reported",
    sample_count: 10,
    median: { fresh_input: 200, cache_write: 40, cache_read: 10, output: 20 },
    median_usd: 0.00066,
    priced_with: "pricing.yaml@2026-07-31",
  });
});

test("fewer than ten comparable runs remains estimated", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const nine = Array.from({ length: 9 }, (_, index) => row("proxy", `proxy-${index + 1}`, { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 }));
  const summary = summarizeWorkflowRunActuals(nine, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  });
  assert.equal(summary.kind, "estimated");
  assert.equal(summary.sample_count, 9);
  if (summary.kind === "estimated") assert.deepEqual(summary.estimate, { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 });
});

test("partial token coverage keeps measured known tokens but makes total dollars unavailable", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const rows = Array.from({ length: 10 }, (_, index) => row("proxy", `proxy-${index + 1}`, { fresh_input: 100, output: 10 }));
  assert.deepEqual(summarizeWorkflowRunActuals(rows, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), {
    kind: "measured",
    population: "proxy",
    sample_count: 10,
    median: { fresh_input: 100, output: 10 },
    median_usd: null,
    priced_with: "pricing.yaml@2026-07-31",
  });
});

test("a dropped expected phase excludes that run from the sample", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const rows = Array.from({ length: 10 }, (_, index) => [
    row("proxy", `proxy-${index + 1}`, { fresh_input: 40, cache_write: 8, cache_read: 2, output: 4 }, { phase: "panel:1", model: "model-a", expected_phase_count: 2 }),
    row("proxy", `proxy-${index + 1}`, { fresh_input: 60, cache_write: 12, cache_read: 3, output: 6 }, { phase: "panel:2", model: "model-b", expected_phase_count: 2 }),
  ]).flat();
  rows.splice(rows.findIndex((candidate) => candidate.run_id === "proxy-10" && candidate.phase === "panel:2"), 1);

  assert.deepEqual(summarizeWorkflowRunActuals(rows, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), {
    kind: "estimated",
    population: null,
    sample_count: 9,
    estimate: { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 },
  });
});

test("regime keys preserve sorted phase/model/call-count multiplicity and assignment", async () => {
  const { workflowRunRegimeKey } = await runActuals() as typeof import("../src/workflowRunActuals.js") & {
    workflowRunRegimeKey: (rows: ReadonlyArray<{ phase: string; model: string; call_count?: number }>) => string;
  };
  const fixtures = JSON.parse(readFileSync("test/fixtures/workflow-run-regimes.json", "utf8")) as Array<{
    name: string;
    phases: Array<Pick<WorkflowRunActualV1, "phase" | "model" | "call_count">>;
    expected: string;
  }>;
  for (const fixture of fixtures) {
    assert.equal(workflowRunRegimeKey(fixture.phases), fixture.expected, fixture.name);
  }
  assert.notEqual(fixtures[0].expected, fixtures[1].expected);
});

test("runs with the same model set but different multiplicity or phase assignment do not combine", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const baseline = (runId: string): WorkflowRunActualV1[] => [
    row("proxy", runId, { fresh_input: 30, cache_write: 3, cache_read: 3, output: 3 }, { phase: "build", model: "model-a", expected_phase_count: 3 }),
    row("proxy", runId, { fresh_input: 30, cache_write: 3, cache_read: 3, output: 3 }, { phase: "build", model: "model-b", expected_phase_count: 3 }),
    row("proxy", runId, { fresh_input: 40, cache_write: 4, cache_read: 4, output: 4 }, { phase: "review", model: "model-a", call_count: 2, expected_phase_count: 3 }),
  ];
  const rows = Array.from({ length: 10 }, (_, index) => baseline(`proxy-${index + 1}`)).flat();
  const changed = rows.find((candidate) => candidate.run_id === "proxy-10" && candidate.phase === "review");
  assert.ok(changed);
  changed.model = "model-b";

  const result = summarizeWorkflowRunActuals(rows, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing: {
      ...pricing,
      models: {
        ...pricing.models,
        "model-a": pricing.models.m,
        "model-b": pricing.models.m,
      },
    },
  });
  assert.equal(result.kind, "estimated");
  assert.equal(result.sample_count, 9);
});

test("wholly unknown runs do not count toward the sample threshold", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const rows = Array.from({ length: 10 }, (_, index) => row("proxy", `proxy-${index + 1}`, {}, { expected_phase_count: 1 }));
  assert.deepEqual(summarizeWorkflowRunActuals(rows, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), { kind: "unavailable", population: null, sample_count: 0, reason: "no_comparable_rows" });
});

test("mixed populations cannot support a measured claim", async () => {
  const { summarizeWorkflowRunActuals } = await runActuals();
  const rows = [
    ...Array.from({ length: 10 }, (_, index) => row("proxy", `proxy-${index + 1}`, { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 })),
    ...Array.from({ length: 10 }, (_, index) => row("agent_reported", `agent-${index + 1}`, { fresh_input: 200, cache_write: 40, cache_read: 10, output: 20 })),
  ];
  assert.deepEqual(summarizeWorkflowRunActuals(rows, {
    harness: "foo-hosted", scaffold: "research-panel-v1", pricing,
  }), { kind: "unavailable", population: null, sample_count: 0, reason: "incomplete_usage" });
});

test("workflow actual event ids are stable for the same closed record", async () => {
  const { workflowActualEventId } = await runActuals();
  const source = row("proxy", "proxy-1", { fresh_input: 100, cache_write: 20, cache_read: 5, output: 10 });
  assert.equal(workflowActualEventId(source), workflowActualEventId({ ...source, tokens: { ...source.tokens } }));
  assert.notEqual(workflowActualEventId(source), workflowActualEventId({ ...source, run_id: "proxy-2" }));
});
