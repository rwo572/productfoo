import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EVAL_RECORD_SCHEMA_VERSION,
  loadEvalSuite,
  validateEvalRecords,
  type EvalRecord,
} from "../src/evalRecord.js";
import { runDeterministicChecks } from "../src/evalChecks.js";
import { compileSuite, runSuite } from "../src/evalCompile.js";
import { callJudgeWithSwap, parseVerdict, type JudgeTransport } from "../src/evalJudge.js";
import { judgeKey } from "../src/evalCalibration.js";

const record = (overrides: Partial<EvalRecord>): EvalRecord => ({
  schema_version: EVAL_RECORD_SCHEMA_VERSION,
  id: "E-001",
  suite: "seed-memo",
  target: "memo.md",
  kind: "deterministic",
  pass: "No sentence carries more than two quantities.",
  check: { id: "one-number-rule", params: { maxPerSentence: 2 } },
  provenance: { source: "roast-run", run: "roast-2026-08-27-demo" },
  approved: true,
  ...overrides,
});

// --- record contract (R-001) ---

test("a well-formed record validates; missing fields fail with named findings", () => {
  const good = validateEvalRecords([record({})]);
  assert.equal(good.ok, true);
  assert.equal(good.records.length, 1);

  const bad = validateEvalRecords([{ id: "E-002", kind: "judge" }]);
  assert.equal(bad.ok, false);
  const fields = bad.findings.map((finding) => finding.field);
  assert.ok(fields.includes("judge.prompt"));
  assert.ok(fields.includes("judge.model"));
  assert.ok(fields.includes("provenance"));
  assert.ok(fields.includes("approved"));
});

test("provenance is mandatory — an eval invented from nowhere is refused", () => {
  const result = validateEvalRecords([record({ provenance: undefined as never })]);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.field === "provenance"));
});

test("duplicate eval ids are refused, not collapsed", () => {
  const result = validateEvalRecords([record({}), record({})]);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.rule === "ER-003"));
  assert.equal(result.records.length, 1);
});

test("the engine-boundary lint rejects a record seeded with engine vocabulary (V-006)", () => {
  const seeded = validateEvalRecords([
    record({
      id: "E-010",
      kind: "judge",
      check: undefined,
      judge: {
        prompt: "Use llm-rubric to grade whether {{output}} skims well.",
        model: "claude-sonnet-5",
      },
    }),
  ]);
  assert.equal(seeded.ok, false);
  const rules = seeded.findings.map((finding) => finding.rule);
  assert.ok(rules.includes("ER-002"));
  // Both the assertion-type name and the template syntax are named.
  const phrases = seeded.findings.map((finding) => finding.phrase);
  assert.ok(phrases.includes("llm-rubric"));
  assert.ok(phrases.some((phrase) => phrase.includes("{{")));
});

test("loadEvalSuite reads a packet's evals home and an absent home is an empty suite", () => {
  const packet = mkdtempSync(path.join(tmpdir(), "foo-eval-packet-"));
  try {
    assert.deepEqual(loadEvalSuite(packet), { ok: true, records: [], findings: [] });
    mkdirSync(path.join(packet, "evals"));
    writeFileSync(
      path.join(packet, "evals", "seed-memo.yaml"),
      [
        `- schema_version: "${EVAL_RECORD_SCHEMA_VERSION}"`,
        "  id: E-001",
        "  suite: seed-memo",
        "  target: memo.md",
        "  kind: deterministic",
        "  pass: No sentence carries more than two quantities.",
        "  check: { id: one-number-rule }",
        "  provenance: { source: roast-run, run: roast-2026-08-27-demo }",
        "  approved: true",
      ].join("\n"),
    );
    const loaded = loadEvalSuite(packet);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.records[0]?.id, "E-001");
  } finally {
    rmSync(packet, { recursive: true, force: true });
  }
});

// --- deterministic checks (R-002) ---

test("one-number-rule catches a three-quantity sentence and names the line", () => {
  const result = runDeterministicChecks(
    ["A fine opening line.", "We grew 40% to $2M across 12 markets in one quarter."].join("\n"),
    [{ id: "one-number-rule" }],
  );
  assert.equal(result.ok, false);
  const finding = result.findings[0];
  assert.equal(finding.check, "one-number-rule");
  assert.equal(finding.line, 2);
  assert.equal(finding.severity, "fail");
});

test("a clean artifact passes every seed check", () => {
  const result = runDeterministicChecks(
    "The memo argues one thing. It cites [the study](https://example.com) for its 40% figure.",
    [
      { id: "one-number-rule" },
      { id: "length-limit", params: { maxWords: 100 } },
      { id: "number-sourcing" },
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test("number-sourcing is advisory by default and strict promotes it (R-002 posture)", () => {
  const artifact = "Revenue tripled to 9 figures.";
  const advisory = runDeterministicChecks(artifact, [{ id: "number-sourcing" }]);
  assert.equal(advisory.ok, true);
  assert.equal(advisory.findings[0]?.severity, "warn");

  const strict = runDeterministicChecks(artifact, [{ id: "number-sourcing" }], { strict: true });
  assert.equal(strict.ok, false);
});

test("an estimate flag or an “our rule” label satisfies the sourcing lint", () => {
  const result = runDeterministicChecks(
    ["Roughly 40% (estimate) of runs converge.", "We cap at 3 rounds — our rule."].join("\n"),
    [{ id: "number-sourcing" }],
  );
  assert.equal(result.findings.length, 0);
});

test("flag-conservation refuses an artifact that fell below its citation baseline (R-005 guard)", () => {
  const result = runDeterministicChecks(
    "Now punchier, with [one link](https://example.com) where three stood.",
    [{ id: "flag-conservation", params: { minCitations: 3 } }],
  );
  assert.equal(result.ok, false);
  assert.match(result.findings[0]?.message ?? "", /guarded substance/);
});

test("numbers inside code spans and fences are not quantities", () => {
  const result = runDeterministicChecks(
    ["Run `foo spec --limit 3 4 5` to start.", "```", "40 41 42 43", "```"].join("\n"),
    [{ id: "one-number-rule", params: { maxPerSentence: 0 } }],
  );
  assert.equal(result.findings.length, 0);
});

test("an unknown check fails loudly instead of silently no-opping", () => {
  const result = runDeterministicChecks("text", [{ id: "vibe-check" }]);
  assert.equal(result.ok, false);
  assert.match(result.findings[0]?.message ?? "", /Unknown deterministic check/);
});

// --- suite planning and running (R-001, R-003, V-006) ---


/** A judge transport that answers from a script, so no network is touched. */
const scripted = (replies: string[]): JudgeTransport => {
  let index = 0;
  return async () => ({ text: replies[Math.min(index++, replies.length - 1)] });
};

test("compile splits kinds, skips unapproved visibly, and plans each judge's ask", () => {
  const compiled = compileSuite([
    record({}),
    record({ id: "E-002", approved: false }),
    record({
      id: "E-003",
      kind: "judge",
      check: undefined,
      judge: { prompt: "Does bold-only reading yield the value prop?", model: "claude-opus-5" },
    }),
  ]);
  assert.deepEqual(compiled.skippedUnapproved, ["E-002"]);
  assert.equal(compiled.deterministic.length, 1);
  assert.equal(compiled.judges.length, 1);
  assert.deepEqual(compiled.judgePlan, [
    {
      id: "E-003",
      criterion: "Does bold-only reading yield the value prop?",
      model: "claude-opus-5",
    },
  ]);
});

test("the plan carries the record's criterion and pinned model verbatim — no runner config anywhere", () => {
  const records = [
    record({}),
    record({
      id: "E-003",
      kind: "judge",
      check: undefined,
      judge: { prompt: "Judge the skim test.", model: "claude-opus-5" },
    }),
  ];
  assert.equal(validateEvalRecords(records).ok, true);
  const rendered = JSON.stringify(compileSuite(records));
  // Nothing engine-shaped survives anywhere in the plan.
  assert.doesNotMatch(rendered, /llm-rubric|promptfoo|\{\{/);
  assert.match(rendered, /Judge the skim test\./);
});

test("a verdict is read strictly: bare PASS or FAIL only, ambiguity is an error not a pass", () => {
  assert.equal(parseVerdict("PASS").verdict, "pass");
  assert.equal(parseVerdict("FAIL\nThe third section buries the ask.").verdict, "fail");
  assert.equal(parseVerdict("pass.").verdict, "pass");
  // The dangerous cases: prose that merely contains the word.
  assert.equal(parseVerdict("This does not pass the skim test.").verdict, "error");
  assert.equal(parseVerdict("I would say it mostly passes").verdict, "error");
  assert.equal(parseVerdict("").verdict, "error");
});

test("a judge that disagrees with itself on the order swap resolves conservatively and records the flip", async () => {
  const compiled = compileSuite([
    record({
      id: "E-005",
      kind: "judge",
      check: undefined,
      judge: { prompt: "Skim test.", model: "claude-opus-5", calibration: "cal-1" },
    }),
  ]);
  const result = await runSuite(compiled, "An artifact.", {
    transport: scripted(["PASS", "FAIL"]),
    // A certified report for this judge, so it is allowed to gate.
    calibration: (rec) => ({
      schema_version: "0.1",
      judge_key: judgeKey(rec.judge!),
      labels: { total: 30, pass: 20, fail: 10, non_blind_excluded: 0 },
      tpr: 1,
      tnr: 1,
      flip_rate: 0,
      certified: true,
      reasons: [],
      disputes: [],
      kappa: 1,
    }),
  });
  assert.equal(result.judges[0]?.flipped, true);
  assert.equal(result.judges[0]?.verdict, "fail");
});

test("an uncalibrated judge is advisory-only and can never fail the run (D-007)", async () => {
  const compiled = compileSuite([
    record({}),
    record({
      id: "E-004",
      kind: "judge",
      check: undefined,
      judge: { prompt: "Judge the skim test.", model: "claude-opus-5" },
    }),
  ]);
  const result = await runSuite(compiled, "A clean artifact with one claim.", {
    transport: scripted(["FAIL", "FAIL"]),
  });
  assert.equal(result.deterministic.ok, true);
  assert.equal(result.judges[0]?.advisory, true);
  assert.equal(result.judges[0]?.verdict, "fail");
  assert.equal(result.ok, true);
});

test("a calibrated judge's repeated fail does gate the run", async () => {
  const compiled = compileSuite([
    record({
      id: "E-006",
      kind: "judge",
      check: undefined,
      judge: { prompt: "Skim test.", model: "claude-opus-5", calibration: "cal-1" },
    }),
  ]);
  const result = await runSuite(compiled, "An artifact.", {
    transport: scripted(["FAIL", "FAIL"]),
    calibration: (rec) => ({
      schema_version: "0.1",
      judge_key: judgeKey(rec.judge!),
      labels: { total: 30, pass: 20, fail: 10, non_blind_excluded: 0 },
      tpr: 1,
      tnr: 1,
      flip_rate: 0,
      certified: true,
      reasons: [],
      disputes: [],
      kappa: 1,
    }),
  });
  assert.equal(result.judges[0]?.advisory, false);
  assert.equal(result.ok, false);
});

test("no model credential means judge checks error honestly while deterministic checks still run", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const compiled = compileSuite([
      record({}),
      record({
        id: "E-007",
        kind: "judge",
        check: undefined,
        judge: { prompt: "Skim test.", model: "claude-opus-5" },
      }),
    ]);
    const result = await runSuite(compiled, "A clean artifact with one claim.");
    assert.equal(result.deterministic.ok, true);
    assert.equal(result.judges[0]?.verdict, "error");
    assert.equal(result.judges[0]?.advisory, true);
    assert.equal(result.status, "passed");
    assert.match(result.judges[0]?.reason ?? "", /credential/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// Release regressions: a failed confirmation must not retain the first PASS,
// and the actual provider payload must reverse the two inputs.
for (const firstVerdict of ["PASS", "FAIL"]) {
  for (const failure of ["throw", "refusal", "malformed"]) {
    test(`a ${firstVerdict} followed by second-call ${failure} is an error, persisted and gating only when calibrated`, async () => {
      const compiled = compileSuite([record({
        kind: "judge", check: undefined,
        judge: { prompt: "Skim test.", model: "controlled-model", calibration: "cal-1" },
      })]);
      for (const calibrated of [true, false]) {
        let calls = 0;
        const result = await runSuite(compiled, "An artifact.", {
          transport: async () => {
            if (++calls === 1) return { text: firstVerdict };
            if (failure === "throw") throw new Error("confirmation unavailable");
            if (failure === "refusal") return { text: "PASS", stop_reason: "refusal" };
            return { text: "Maybe" };
          },
          calibration: calibrated ? rec => ({
            schema_version: "0.1", judge_key: judgeKey(rec.judge!),
            labels: { total: 30, pass: 20, fail: 10, non_blind_excluded: 0 },
            tpr: 1, tnr: 1, flip_rate: 0, certified: true, reasons: [], disputes: [], kappa: 1,
          }) : undefined,
        });
        const persisted = JSON.parse(JSON.stringify(result));
        assert.equal(persisted.judges[0].verdict, "error");
        assert.equal(persisted.judges[0].swapped, "error");
        assert.equal(persisted.judges[0].flipped, false);
        assert.match(persisted.judges[0].reason, failure === "throw" ? /confirmation unavailable/ : failure === "refusal" ? /declined/ : /bare PASS or FAIL/);
        assert.equal(result.ok, !calibrated);
        assert.equal(calls, 2);
      }
    });
  }
}

test("provider requests reverse criterion and artifact without changing either input", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const bodies: { model: string; system: string; messages: { content: string }[] }[] = [];
  process.env.ANTHROPIC_API_KEY = "synthetic-provider-fixture";
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options!.body as string));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn" }), { status: 200 });
  };
  try {
    const result = await callJudgeWithSwap({ prompt: "CRITERION_CONTROL", artifact: "ARTIFACT_CONTROL", model: "controlled-model" });
    assert.equal(result.verdict, "pass");
    assert.equal(result.swapped, "pass");
    assert.equal(bodies.length, 2);
    const first = bodies[0]!.messages[0]!.content;
    const second = bodies[1]!.messages[0]!.content;
    assert.ok(first.indexOf("CRITERION_CONTROL") < first.indexOf("ARTIFACT_CONTROL"));
    assert.ok(second.indexOf("ARTIFACT_CONTROL") < second.indexOf("CRITERION_CONTROL"));
    for (const body of bodies) {
      assert.equal(body.model, "controlled-model");
      assert.equal(body.system, bodies[0]!.system);
      assert.equal(body.messages[0]!.content.match(/CRITERION_CONTROL/g)?.length, 1);
      assert.equal(body.messages[0]!.content.match(/ARTIFACT_CONTROL/g)?.length, 1);
      assert.doesNotMatch(body.messages[0]!.content, /Judge the artifact below/);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test("zero approved checks is not a passing suite, whether absent or all unapproved", async () => {
  for (const records of [[], [record({ approved: false })]]) {
    const result = await runSuite(compileSuite(records), "An artifact.");
    assert.equal(result.ok, false);
    assert.equal(result.status, "not_run");
    assert.deepEqual(result.skippedUnapproved, records.length ? ["E-001"] : []);
  }
});

for (const reply of ["PASS", "FAIL", "ambiguous"]) {
  test(`a judge-only uncalibrated ${reply} is advisory coverage, never a suite pass`, async () => {
    const compiled = compileSuite([record({ kind: "judge", check: undefined, judge: { prompt: "Skim test.", model: "controlled-model" } })]);
    const result = await runSuite(compiled, "An artifact.", { transport: scripted([reply]) });
    assert.equal(result.ok, true, "advisory outcomes remain nonblocking");
    assert.equal(result.status, "advisory_only");
    assert.equal(result.judges[0]!.advisory, true);
  });
}

test("both flip directions resolve to fail rather than retaining a first PASS", async () => {
  for (const replies of [["PASS", "FAIL"], ["FAIL", "PASS"]]) {
    const result = await callJudgeWithSwap({ prompt: "Skim test.", model: "controlled-model", artifact: "An artifact." }, scripted(replies));
    assert.equal(result.verdict, "fail");
    assert.equal(result.flipped, true);
    assert.equal(result.swapped, replies[1]!.toLowerCase());
  }
});
