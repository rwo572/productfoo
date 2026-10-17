// alpha-distribution-telemetry-v0 (T-009 / T-010 / T-011) — the local, testable
// core of satisfaction signal, friction-triggered error feedback, and the
// consented eval-capture lane. Verifies the two load-bearing promises:
// (1) default signals are content-free and honor the existing opt-out;
// (2) raw content is retained ONLY in the opt-in lane, redacted + encrypted +
//     TTL'd + tester-deletable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Machine-scoped tester-id state: keep in-process mints out of the real ~/.foo.
process.env.FOO_STATE_DIR = mkdtempSync(path.join(tmpdir(), "foo-state-"));

import {
  captureForEval,
  classifyDecision,
  recordIdeateDecision,
  deleteEvalCapture,
  feedbackEnabled,
  forgetAllEvalCaptures,
  listEvalCaptures,
  pruneExpiredEvalCaptures,
  readEvalCapture,
  readEvalConsent,
  recordErrorFeedback,
  recordRating,
  recordRevealed,
  recordSpontaneous,
  reasonForKey,
  renderErrorPrompt,
  setEvalConsent,
  shouldPromptOnError,
  TRANSIENT_ERROR_CLASSES,
  type FeedbackEvent,
} from "../src/feedback.js";

// The event ledger is MACHINE state (~/.foo), never the user's repo — that is the
// fix (alpha_tester_fixes_v0 R-005). So each test gets its own state dir as well as
// its own root, or they would all append to one shared ledger and read each other's
// events. `.foo/telemetry.json` under root stays: that is the per-repo OPT-OUT, a
// file the user chooses to create, not one foo writes behind their back.
function stateDir(root: string): string {
  return path.join(root, "state");
}

function tmpRoot(telemetry: "enabled" | "disabled" | "none" = "enabled"): string {
  const root = mkdtempSync(path.join(tmpdir(), "foo-feedback-"));
  process.env.FOO_STATE_DIR = stateDir(root);
  if (telemetry !== "none") {
    mkdirSync(path.join(root, ".foo"), { recursive: true });
    writeFileSync(
      path.join(root, ".foo", "telemetry.json"),
      JSON.stringify({ schema_version: "0.1", enabled: telemetry === "enabled", testerId: "t_fixture" }),
    );
  }
  return root;
}

function ledger(root: string): FeedbackEvent[] {
  const p = path.join(stateDir(root), "agent-events.jsonl");
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeedbackEvent)
    .filter((e) => e.event_type === "feedback");
}

// A KEY=VALUE secret assembled at runtime: the high-entropy value trips the
// redactor's keyed-assignment detector, and assembling at runtime keeps no
// secret literal in this file (the B1 pre-commit gate stays clean; `${value}`
// reads as an interpolation placeholder, not a secret).
function secretAssignment(): { assignment: string; value: string } {
  const value = ["Zx7Q", "9mKp", "2wR8", "5tN3", "aB4d", "8sLf"].join("");
  return { assignment: `password=${value}`, value };
}

// --- T-009 satisfaction (content-free, opt-out honored) ----------------------

test("revealed preference records a content-free, token-attributed event (T-009)", () => {
  const root = tmpRoot();
  const e = recordRevealed(root, "override", { domain: "ideate", command: "ideate" }, {});
  assert.ok(e);
  assert.equal(e.signal, "revealed");
  assert.equal(e.kind, "override");
  assert.equal(e.tester_id, "t_fixture");
  // no free-text / content fields on a revealed-preference event
  assert.equal(e.note, undefined);
  assert.equal(e.rating, undefined);
  assert.equal(ledger(root).length, 1);
});

test("sampled rating records a small integer, nothing else (T-009)", () => {
  const root = tmpRoot();
  const e = recordRating(root, 2, { domain: "ideate", command: "ideate" }, {});
  assert.equal(e?.signal, "solicited");
  assert.equal(e?.kind, "rating");
  assert.equal(e?.rating, 2);
  assert.equal(e?.note, undefined);
});

test("spontaneous feedback is redacted-before-store — a secret never lands in the ledger (T-009/D-010)", () => {
  const root = tmpRoot();
  const { assignment, value } = secretAssignment();
  const e = recordSpontaneous(root, `the shortlist was too samey, also ${assignment}`, {});
  assert.ok(e);
  assert.equal(e.kind, "spontaneous");
  assert.ok(e.note && !e.note.includes(value), "the secret must be redacted out of the stored note");
  assert.ok((e.redactions ?? 0) >= 1, "at least one span was redacted");
  // and the raw secret is nowhere in the persisted ledger file
  const raw = readFileSync(path.join(stateDir(root), "agent-events.jsonl"), "utf8");
  assert.ok(!raw.includes(value));
});

test("opt-out (telemetry disabled) suppresses every feedback signal (OQ-4/D-010)", () => {
  const root = tmpRoot("disabled");
  assert.equal(feedbackEnabled(root), false);
  assert.equal(recordRevealed(root, "handoff"), null);
  assert.equal(recordRating(root, 3), null);
  assert.equal(recordSpontaneous(root, "anything"), null);
  // nothing was written — not to the state dir, and not into the user's repo either
  assert.ok(!existsSync(path.join(stateDir(root), "agent-events.jsonl")));
  assert.ok(!readdirSync(path.join(root, ".foo")).includes("agent-events.jsonl"));
});

test("DO_NOT_TRACK=1 suppresses feedback even when config is enabled", () => {
  const root = tmpRoot("enabled");
  assert.equal(feedbackEnabled(root, { DO_NOT_TRACK: "1" }), false);
  assert.equal(recordRevealed(root, "kept", {}, { DO_NOT_TRACK: "1" }), null);
});

// --- T-010 friction-triggered feedback ---------------------------------------

test("shouldPromptOnError never fires on a transient/auto-recovered error (T-010)", () => {
  for (const cls of TRANSIENT_ERROR_CLASSES) {
    assert.equal(shouldPromptOnError(cls, { sampleRate: 1, sampler: () => 0 }), false, `must skip transient ${cls}`);
  }
  // a real error, sampled in
  assert.equal(shouldPromptOnError("command_error", { sampleRate: 1, sampler: () => 0 }), true);
  // a real error, sampled out
  assert.equal(shouldPromptOnError("command_error", { sampleRate: 0.5, sampler: () => 0.9 }), false);
});

test("error feedback records the structured reason and redacts an optional note (T-010)", () => {
  const root = tmpRoot();
  const { assignment, value } = secretAssignment();
  const e = recordErrorFeedback(root, {
    reason_code: "other",
    error_class: "command_error",
    domain: "ideate",
    command: "ideate",
    note: `it hung then died, ${assignment}`,
  });
  assert.ok(e);
  assert.equal(e.signal, "friction");
  assert.equal(e.kind, "error");
  assert.equal(e.reason_code, "other");
  assert.equal(e.error_class, "command_error");
  assert.ok(e.note && !e.note.includes(value), "note redacted before store");
});

test("structured reason mapping + prompt copy are stable (T-010)", () => {
  assert.equal(reasonForKey("1"), "too_slow");
  assert.equal(reasonForKey("4"), "other");
  assert.equal(reasonForKey("9"), null);
  assert.match(renderErrorPrompt(), /enter to skip/);
});

test("error feedback is offline-durable: it writes to the LOCAL ledger with no network (T-010)", () => {
  const root = tmpRoot();
  // no network involved — the append is the offline-safe capture; sync flushes later
  const e = recordErrorFeedback(root, { reason_code: "crashed", error_class: "command_error" });
  assert.ok(e);
  assert.equal(ledger(root).length, 1);
});

// --- T-011 consented eval-capture lane ---------------------------------------

test("no capture without consent — a non-consenting tester retains nothing (T-011)", () => {
  const root = tmpRoot();
  assert.equal(readEvalConsent(root), false); // opt-IN default
  const id = captureForEval(root, { idea: "a hosted brain idea", record: "---\npick: X\n", label: "bad" });
  assert.equal(id, null);
  assert.equal(listEvalCaptures(root).length, 0);
});

test("consenting tester's run is retained — redacted, encrypted at rest, decrypt round-trips (T-011)", () => {
  const root = tmpRoot();
  setEvalConsent(root, true);
  assert.equal(readEvalConsent(root), true);

  const { assignment, value } = secretAssignment();
  const id = captureForEval(root, {
    idea: `ship the thing with ${assignment}`,
    record: "---\npick: direction-1\nminority_report: X\n",
    label: "override",
  });
  assert.ok(id);

  // metadata is visible (the "show me what's retained" surface); plaintext is not
  const metas = listEvalCaptures(root);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].label, "override");
  assert.ok(metas[0].redactions >= 1);

  // encrypted at rest: the stored file does NOT contain the idea or the secret
  const stored = readFileSync(path.join(root, ".foo", "eval-capture", `${id}.enc`), "utf8");
  assert.ok(!stored.includes("ship the thing"), "idea text must not be readable at rest");
  assert.ok(!stored.includes(value), "secret must be redacted AND encrypted at rest");

  // maintainer read path round-trips, with the secret redacted out of the idea
  const triple = readEvalCapture(root, id);
  assert.ok(triple);
  assert.equal(triple.label, "override");
  assert.ok(!triple.idea.includes(value), "idea is redacted before encryption");
  assert.match(triple.record, /minority_report/);
});

test("captures are tester-deletable and forgettable-in-bulk (T-011)", () => {
  const root = tmpRoot();
  setEvalConsent(root, true);
  const a = captureForEval(root, { idea: "one", record: "r", label: "bad" })!;
  captureForEval(root, { idea: "two", record: "r", label: "abandon" });
  assert.equal(listEvalCaptures(root).length, 2);

  assert.equal(deleteEvalCapture(root, a), true);
  assert.equal(listEvalCaptures(root).length, 1);
  assert.equal(deleteEvalCapture(root, "ev_missing"), false);

  assert.equal(forgetAllEvalCaptures(root), 1);
  assert.equal(listEvalCaptures(root).length, 0);
});

test("TTL is enforced mechanically — an expired capture prunes and no longer decrypts (T-011)", () => {
  const root = tmpRoot();
  setEvalConsent(root, true);
  const t0 = 1_000_000_000_000;
  const id = captureForEval(root, { idea: "expiring idea", record: "r", label: "bad" }, { ttlMs: 1000, now: t0 })!;

  // still readable just before expiry
  assert.ok(readEvalCapture(root, id, t0 + 500));
  // expired: read returns null and prune removes it
  assert.equal(readEvalCapture(root, id, t0 + 2000), null);
  assert.equal(pruneExpiredEvalCaptures(root, t0 + 2000), 1);
  assert.equal(listEvalCaptures(root).length, 0);
});

test("consent is opt-in and reversible; turning it off stops new capture (T-011)", () => {
  const root = tmpRoot();
  setEvalConsent(root, true);
  assert.ok(captureForEval(root, { idea: "in", record: "r", label: "bad" }));
  setEvalConsent(root, false);
  assert.equal(readEvalConsent(root), false);
  assert.equal(captureForEval(root, { idea: "out", record: "r", label: "bad" }), null);
});

// --- T-009 revealed preference from the ideate record (instrumentation core) --

test("classifyDecision reads pick-vs-recommendation and returns only the class (T-009)", () => {
  assert.equal(classifyDecision('recommendation: "C1 direction-1"\npick: "C1 direction-1"'), "kept");
  assert.equal(classifyDecision('recommendation: "C1 direction-1"\npick: "C2 direction-2"'), "override");
  assert.equal(classifyDecision('recommendation: "C1"\npick: null'), "undecided");
  assert.equal(classifyDecision('recommendation: null\npick: "X"'), null);
});

test("recordIdeateDecision fires a content-free revealed event on override; nothing when undecided (T-009)", () => {
  const root = tmpRoot();
  const rec = path.join(root, "ideas", "r.md");
  mkdirSync(path.dirname(rec), { recursive: true });
  writeFileSync(rec, 'recommendation: "A"\npick: "B"\n');
  assert.equal(recordIdeateDecision(root, "ideas/r.md"), "override");
  const events = ledger(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].signal, "revealed");
  assert.equal(events[0].kind, "override");
  // the event carries no field values — only the class
  assert.equal(events[0].note, undefined);

  writeFileSync(rec, 'recommendation: "A"\npick: null\n'); // no decision yet ⇒ no event
  assert.equal(recordIdeateDecision(root, "ideas/r.md"), null);
  assert.equal(ledger(root).length, 1);
});

test("recordIdeateDecision is suppressed by opt-out and safe on a missing record (T-009)", () => {
  assert.equal(recordIdeateDecision(tmpRoot("disabled"), "ideas/nope.md"), null);
  assert.equal(recordIdeateDecision(tmpRoot(), "ideas/nope.md"), null); // enabled, but no such file
});
