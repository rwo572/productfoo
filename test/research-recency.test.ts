import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildResearchPlan,
  DEFAULT_RECENCY_DAYS,
  parseResearchArgs,
  renderResearchJson,
  renderResearchPlan,
} from "../src/research.js";

const ROOT = process.cwd();

test("recency defaults to 30 days with no end date", () => {
  const parsed = parseResearchArgs(["agent memory"]);
  assert.equal(parsed.recency.days, DEFAULT_RECENCY_DAYS);
  assert.equal(parsed.recency.days, 30);
  assert.equal(parsed.recency.end_date, null);
});

test("--days and --end-date are parsed", () => {
  const parsed = parseResearchArgs(["topic", "--days", "7", "--end-date", "2026-01-15"]);
  assert.equal(parsed.recency.days, 7);
  assert.equal(parsed.recency.end_date, "2026-01-15");
});

test("--days rejects non-positive and non-integer values", () => {
  assert.throws(() => parseResearchArgs(["t", "--days", "0"]), /positive whole number/);
  assert.throws(() => parseResearchArgs(["t", "--days", "-3"]), /positive whole number/);
  assert.throws(() => parseResearchArgs(["t", "--days", "3.5"]), /positive whole number/);
  assert.throws(() => parseResearchArgs(["t", "--days"]), /positive whole number/);
});

test("--end-date requires YYYY-MM-DD", () => {
  assert.throws(() => parseResearchArgs(["t", "--end-date", "yesterday"]), /YYYY-MM-DD/);
  assert.throws(() => parseResearchArgs(["t", "--end-date", "2026-1-1"]), /YYYY-MM-DD/);
});

test("the plan carries the recency window and renders it in text and json", () => {
  const args = parseResearchArgs(["agents", "--days", "14", "--end-date", "2026-02-01"]);
  const plan = buildResearchPlan(ROOT, args, { date: "2026-02-01" });
  assert.equal(plan.recency.days, 14);
  assert.equal(plan.recency.end_date, "2026-02-01");

  const text = renderResearchPlan(plan);
  assert.match(text, /Recency window: last 14 day\(s\) ending 2026-02-01/);

  const json = JSON.parse(renderResearchJson(plan));
  assert.equal(json.recency.days, 14);
  assert.equal(json.recency.end_date, "2026-02-01");
});

test("the social class reports available with the native keyless adapters", () => {
  const args = parseResearchArgs(["agents"]);
  const plan = buildResearchPlan(ROOT, args, { date: "2026-02-01" });
  const social = plan.sources.find((s) => s.class === "social");
  assert.equal(social?.status, "available");
  assert.match(social?.reason ?? "", /Reddit, HN, arXiv, GitHub/);
});
