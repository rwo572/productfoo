import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileCalPalScheduling } from "./reconcile.js";

test("reports expected reconcile findings", async () => {
  const report = await reconcileCalPalScheduling({
    asOf: new Date("2026-06-26T00:00:00Z"),
    changedFiles: [],
    gitDiff: false,
  });
  const kinds = report.findings.map((finding) => finding.kind);

  assert.ok(kinds.includes("unagreed_work"));
  assert.ok(kinds.includes("record_done_without_work_evidence"));
  assert.ok(kinds.includes("stale_suggested_task"));
});

test("does not flag CalPal spec and task drift after task ledger is realigned", async () => {
  const report = await reconcileCalPalScheduling({
    asOf: new Date("2026-06-19T20:00:00Z"),
    changedFiles: [],
    gitDiff: false,
  });

  const drift = report.findings.find((finding) => finding.kind === "spec_task_semantic_drift");

  assert.equal(drift, undefined);
});

test("derives external freshness from policy", async () => {
  const report = await reconcileCalPalScheduling({
    asOf: new Date("2026-06-18T21:10:00Z"),
    changedFiles: [],
    gitDiff: false,
  });

  const changedFiles = report.external_observations.find(
    (item) => item.event_id === "evt_calpal_integration_004",
  );
  const checks = report.external_observations.find(
    (item) => item.event_id === "evt_calpal_integration_005",
  );

  assert.equal(changedFiles?.derived_freshness, "fresh");
  assert.equal(checks?.derived_freshness, "fresh");
});

test("exposes replay order", async () => {
  const report = await reconcileCalPalScheduling({
    asOf: new Date("2026-06-18T21:10:00Z"),
    changedFiles: [],
    gitDiff: false,
  });

  assert.deepEqual(report.ledger.segment_order, ["events.jsonl", "integration-events.jsonl"]);
});

test("reconciles changed files against task touches", async () => {
  const report = await reconcileCalPalScheduling({
    asOf: new Date("2026-06-18T21:10:00Z"),
    changedFiles: [
      "apps/calpal/scheduler/availability.ts",
      "apps/calpal/experiments/ai_agenda_notes.ts",
    ],
    gitDiff: false,
  });

  const agreedFile = report.changed_files.find(
    (item) => item.path === "apps/calpal/scheduler/availability.ts",
  );
  const unmappedFile = report.changed_files.find(
    (item) => item.path === "apps/calpal/experiments/ai_agenda_notes.ts",
  );

  assert.equal(agreedFile?.state, "agreed");
  assert.ok(agreedFile?.mapped_tasks.includes("T-001"));
  assert.equal(unmappedFile?.state, "unmapped");

  const unmappedFindings = report.findings.filter(
    (finding) => finding.kind === "unmapped_changed_file",
  );
  assert.deepEqual(
    unmappedFindings.map((finding) => finding.file),
    ["apps/calpal/experiments/ai_agenda_notes.ts"],
  );
});
