import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { verifyPacket, renderVerifyReport, verdictGlyphState, VERIFY_SCHEMA_VERSION } from "../src/packetVerify.js";
import { SEVERITY_CLASS, countByClass } from "../src/severityClass.js";

// Build a packet dir with the given tasks and (optional) spec requirements.
function makePacket(tasks: unknown[], requirements: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-verify-"));
  const doc = {
    schema_version: "0.1",
    spec_id: "vp",
    spec_ref: "spec.md",
    updated: "2026-06-24T00:00:00Z",
    ledger: { segment_order: ["events.jsonl"] },
    tasks,
  };
  // The packet writer renders YAML by hand elsewhere; here a JSON document is
  // valid YAML, which keeps the fixture readable and the parser happy.
  writeFileSync(path.join(dir, "tasks.yaml"), JSON.stringify(doc, null, 2));
  const reqs = requirements.map((r) => `### ${r} heading\n`).join("\n");
  writeFileSync(path.join(dir, "spec.md"), `## Intent\nProve the verifier.\n\n${reqs}`);
  writeFileSync(path.join(dir, "events.jsonl"), "");
  return dir;
}

function task(id: string, status: string, checks: Array<{ id: string; done: boolean; proof: string | null }>, refs: string[] = []): unknown {
  return {
    id,
    title: `Task ${id}`,
    status,
    agreement: "agreed",
    refs,
    done_when: checks.map((c) => ({ id: c.id, text: "check", done: c.done, proof: c.proof })),
  };
}

// done + proof => proven (✅). The signature distinction is the whole point.
test("a done task with proof on every check is proven", () => {
  const dir = makePacket([task("T-001", "done", [{ id: "C-001", done: true, proof: "test passes" }], ["R-001"])], ["R-001"]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.schema_version, VERIFY_SCHEMA_VERSION);
  assert.equal(report.verdict, "proven");
  assert.equal(report.tasks.proven, 1);
  assert.equal(report.checks.proven, 1);
  assert.equal(report.requirements.proven, 1);
  assert.equal(report.findings.length, 0);
});

// done without proof => claimed (🟡), with an advisory finding, never drift.
test("a done task missing proof is claimed, not proven", () => {
  const dir = makePacket([task("T-001", "done", [{ id: "C-001", done: true, proof: null }])]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.verdict, "claimed");
  assert.equal(report.tasks.claimed, 1);
  assert.equal(report.checks.claimed, 1);
  const machine = JSON.parse(JSON.stringify(report));
  assert.equal(machine.verdict, "claimed");
  assert.equal(machine.tasks.claimed, 1);
  assert.equal(machine.checks.claimed, 1);
  assert.equal(machine.task_verdicts[0].verdict, "claimed");
  assert.equal(machine.task_verdicts[0].checks[0].state, "claimed");
  assert.equal(machine.task_verdicts[0].status, "done");
  const finding = report.findings.find((f) => f.kind === "unproven_claim");
  assert.ok(finding, "expected an unproven_claim finding");
  assert.equal(finding!.severity, "medium");
  assert.equal(finding!.requires_human, false);
});

// done but an acceptance check is not met => drift (⚠️): a false completion.
test("a done task with an unmet check is drift (false completion)", () => {
  const dir = makePacket([task("T-001", "done", [{ id: "C-001", done: false, proof: null }])]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.verdict, "drift");
  assert.equal(report.tasks.drift, 1);
  const finding = report.findings.find((f) => f.kind === "false_completion");
  assert.ok(finding, "expected a false_completion finding");
  assert.equal(finding!.severity, "high");
  assert.equal(finding!.requires_human, true);
});

// Worst-wins: any drift sets the headline even amid proven/claimed work.
test("verdict is worst-wins across tasks", () => {
  const dir = makePacket([
    task("T-001", "done", [{ id: "C-001", done: true, proof: "ok" }]),
    task("T-002", "done", [{ id: "C-002", done: true, proof: null }]),
    task("T-003", "done", [{ id: "C-003", done: false, proof: null }]),
  ]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.verdict, "drift");
  assert.equal(report.tasks.proven, 1);
  assert.equal(report.tasks.claimed, 1);
  assert.equal(report.tasks.drift, 1);
});

// Unfinished work is incomplete, never drift — nothing false, just not done.
test("not-done tasks are incomplete, not drift", () => {
  const dir = makePacket([
    task("T-001", "doing", [{ id: "C-001", done: false, proof: null }]),
    task("T-002", "todo", [{ id: "C-002", done: false, proof: null }]),
  ]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.verdict, "incomplete");
  assert.equal(report.tasks.incomplete, 2);
  assert.equal(report.tasks.drift, 0);
});

// A requirement with no referencing task can never be proven.
test("an unreferenced requirement is unproven with a finding", () => {
  const dir = makePacket([task("T-001", "done", [{ id: "C-001", done: true, proof: "ok" }], ["R-001"])], ["R-001", "R-002"]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.requirements.total, 2);
  assert.equal(report.requirements.proven, 1);
  const finding = report.findings.find((f) => f.kind === "uncovered_requirement" && f.subject === "requirement:R-002");
  assert.ok(finding, "expected an uncovered_requirement finding for R-002");
});

// Dropped work is excluded from the verdict math but counted for visibility.
test("dropped tasks are excluded from the verdict", () => {
  const dir = makePacket([
    task("T-001", "done", [{ id: "C-001", done: true, proof: "ok" }]),
    task("T-002", "dropped", [{ id: "C-002", done: false, proof: null }]),
  ]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  assert.equal(report.verdict, "proven");
  assert.equal(report.tasks.dropped, 1);
});

// Glyph gate: the human renderer decorates when glyphs are on and stays plain
// (word-only) when off, so machine readers never see an emoji.
test("renderVerifyReport honors the glyph gate", () => {
  const dir = makePacket([task("T-001", "done", [{ id: "C-001", done: true, proof: null }])]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  const off = renderVerifyReport(report, false);
  const on = renderVerifyReport(report, true);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(off), "glyphs-off output must carry no emoji");
  assert.match(off, /verify .*: DONE — PROOF PENDING —/);
  assert.match(off, /1 done — proof pending/);
  assert.match(off, /done — proof pending\s+T-001/);
  assert.doesNotMatch(off, /:\s*CLAIMED\s+—|\d+ claimed|^\s+claimed\s+T-/im);
  assert.match(on, /🟡 verify .*: DONE — PROOF PENDING —/);
  assert.ok(on.length > off.length, "glyphs-on output adds the glyph");
  // The renderer translates only at the human boundary.
  assert.equal(report.verdict, "claimed");
  assert.equal(report.tasks.claimed, 1);
  assert.equal(report.checks.claimed, 1);
});

test("verdictGlyphState maps to the locked vocabulary", () => {
  assert.equal(verdictGlyphState("proven"), "proven");
  assert.equal(verdictGlyphState("claimed"), "claimed");
  assert.equal(verdictGlyphState("incomplete"), "todo");
  assert.equal(verdictGlyphState("drift"), "drift");
});

// --- bad-vs-sad-severity-v0 -------------------------------------------------

// A false completion is unrecoverable until fixed: bad. Missing proof is
// recoverable by adding a receipt: sad. (Fiona Fung's frame.)
test("findings carry a bad/sad recoverability class", () => {
  const dir = makePacket([
    task("T-001", "done", [{ id: "C-001", done: false, proof: null }]), // drift -> bad
    task("T-002", "done", [{ id: "C-002", done: true, proof: null }]), // claimed -> sad
  ]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  const drift = report.findings.find((f) => f.kind === "false_completion");
  const claim = report.findings.find((f) => f.kind === "unproven_claim");
  assert.equal(drift!.class, "bad");
  assert.equal(claim!.class, "sad");
  assert.deepEqual(report.findings_by_class, { bad: 1, sad: 1 });
});

// A requirement no task references is structurally unprovable (bad); one merely
// not-yet-proven by its referencing task is recoverable (sad).
test("uncovered requirement is bad without a task, sad with one", () => {
  const dir = makePacket(
    [task("T-001", "doing", [{ id: "C-001", done: false, proof: null }], ["R-001"])],
    ["R-001", "R-002"],
  );
  const report = verifyPacket({ packetDir: dir, root: dir });
  const referenced = report.findings.find((f) => f.subject === "requirement:R-001");
  const orphan = report.findings.find((f) => f.subject === "requirement:R-002");
  assert.equal(referenced!.class, "sad");
  assert.equal(orphan!.class, "bad");
});

test("the human view shows the bad/sad split and orders bad first", () => {
  const dir = makePacket([
    task("T-001", "done", [{ id: "C-001", done: true, proof: null }]), // sad
    task("T-002", "done", [{ id: "C-002", done: false, proof: null }]), // bad
  ]);
  const report = verifyPacket({ packetDir: dir, root: dir });
  const out = renderVerifyReport(report, false);
  assert.match(out, /1 bad \(unrecoverable\) · 1 sad \(recoverable\)/);
  assert.ok(out.indexOf("[bad/") < out.indexOf("[sad/"), "bad findings list before sad");
});

test("severity class vocabulary and counter", () => {
  assert.equal(SEVERITY_CLASS.bad.tone, "warn");
  assert.equal(SEVERITY_CLASS.sad.tone, "neutral");
  assert.deepEqual(countByClass(["bad", "sad", "bad"]), { bad: 2, sad: 1 });
});
