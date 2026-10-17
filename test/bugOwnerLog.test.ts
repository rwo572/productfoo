import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBugLogIntake, buildSignalBugIntake, newBugLogSession, recentBugCreateCount, recordBugCreate, runBugLog, type BugLogSession, type GhExec } from "../src/bugOwnerLog.js";

// bug-owner-autolog-v0: engine tests over a mock gh transport — the network is
// never touched. The dedupe-gates-creation ordering test encodes the #521/#535
// incident: a create must not run before the search has returned and been
// evaluated.

const REPO = "rwo572/foo-private";

type CallLog = string[][];

function mockGh(options: {
  isPrivate?: boolean;
  viewFails?: boolean;
  listFails?: boolean;
  issues?: Array<{ number: number; title: string; state: string; url: string; body: string }>;
  createUrl?: string;
}): { gh: GhExec; calls: CallLog } {
  const calls: CallLog = [];
  const gh: GhExec = (args) => {
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      if (options.viewFails) return { ok: false, stdout: "", stderr: "gh: not logged in" };
      return { ok: true, stdout: JSON.stringify({ visibility: options.isPrivate === false ? "PUBLIC" : "PRIVATE", isPrivate: options.isPrivate !== false }), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "list") {
      if (options.listFails) return { ok: false, stdout: "", stderr: "gh: api error" };
      return { ok: true, stdout: JSON.stringify(options.issues ?? []), stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "comment") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") return { ok: true, stdout: `${options.createUrl ?? `https://github.com/${REPO}/issues/123`}\n`, stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
  };
  return { gh, calls };
}

function env(repo: string | null = REPO): NodeJS.ProcessEnv {
  return repo === null ? {} : { FOO_BUG_OWNER_REPO: repo };
}

function session(maxCreates = 3): BugLogSession {
  return { created: 0, max_creates: maxCreates, title_hashes: new Set() };
}

// A fresh, isolated state root per call: the creation log persists under
// <root>/.foo, so tests must not share one or bleed the ceiling into each other.
function mkRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-bug-log-"));
}

const INTAKE = buildBugLogIntake({
  expected: "foo discovery assign --auto should skip catch-all targets",
  actual: "The E_DISCOVERY_VALIDATION classifier in discoveryCommand.ts assigns catch-all targets shared by dozens of records",
  reproduction: "Run foo discovery assign --auto against a batch whose reconciliation candidates all name one research doc",
});

test("unconfigured owner repo refuses with zero transport calls", () => {
  const { gh, calls } = mockGh({});
  const result = runBugLog({ env: env(null), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "refused");
  assert.equal(result.errors[0].code, "E_BUG_OWNER_REPO");
  assert.match(result.next_actions[0], /export FOO_BUG_OWNER_REPO/);
  assert.equal(calls.length, 0);
});

test("a public repository refuses before any issue read or write", () => {
  const { gh, calls } = mockGh({ isPrivate: false });
  const result = runBugLog({ env: env(), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "refused");
  assert.equal(result.errors[0].code, "E_BUG_REPO_PUBLIC");
  assert.equal(calls.filter((call) => call[0] === "issue").length, 0);
});

test("dedupe gates creation: a failed search means no create call, ever (#521/#535 incident)", () => {
  const { gh, calls } = mockGh({ listFails: true });
  const result = runBugLog({ env: env(), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "retryable");
  assert.equal(result.errors[0].code, "E_BUG_SEARCH_FAILED");
  assert.match(result.errors[0].message, /search result must gate the filing/);
  assert.equal(calls.some((call) => call[1] === "create" || call[1] === "comment"), false);
});

test("filed path: the issue list call strictly precedes the create call and the body carries the intake sections", () => {
  const { gh, calls } = mockGh({ issues: [] });
  const result = runBugLog({ env: env(), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "filed");
  assert.equal(result.issue_number, 123);
  assert.match(String(result.issue_url), /issues\/123$/);
  const listIndex = calls.findIndex((call) => call[1] === "list");
  const createIndex = calls.findIndex((call) => call[1] === "create");
  assert.ok(listIndex >= 0 && createIndex > listIndex, "create must come after the dedupe list");
  const listCall = calls[listIndex];
  assert.ok(listCall.includes("--state") && listCall[listCall.indexOf("--state") + 1] === "all", "dedupe searches state:all — duplicates get closed");
  const body = calls[createIndex][calls[createIndex].indexOf("--body") + 1];
  assert.match(body, /## Expected[\s\S]*## Actual[\s\S]*## Reproduction/);
});

test("reproduced path: a mechanism match on a CLOSED issue comments there and creates nothing", () => {
  const { gh, calls } = mockGh({
    issues: [
      { number: 521, title: "classifier misroutes batch targets", state: "CLOSED", url: `https://github.com/${REPO}/issues/521`, body: "The E_DISCOVERY_VALIDATION classifier in discoveryCommand.ts collapses onto one target" },
      { number: 7, title: "unrelated docs typo", state: "OPEN", url: `https://github.com/${REPO}/issues/7`, body: "typo on the docs page" },
    ],
  });
  const result = runBugLog({ env: env(), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "reproduced");
  assert.equal(result.issue_number, 521);
  assert.equal(result.match?.issue_state, "CLOSED");
  assert.ok((result.match?.matched_terms ?? []).length > 0);
  assert.equal(calls.some((call) => call[1] === "create"), false);
  const commentCall = calls.find((call) => call[1] === "comment");
  assert.ok(commentCall, "one comment posted");
  assert.match(commentCall![commentCall!.indexOf("--body") + 1], /ceiling of automatic action/);
});

test("per-run creation ceiling withholds the second filing and says so", () => {
  const { gh } = mockGh({ issues: [] });
  const root = mkRoot();
  const shared = session(1);
  const first = runBugLog({ env: env(), gh, session: shared, intake: INTAKE, root });
  assert.equal(first.status, "filed");
  const second = runBugLog({ env: env(), gh, session: shared, intake: buildBugLogIntake({ expected: "different defect entirely", actual: "grammarGate.ts rejects valid V anchors on migrate" }), root });
  assert.equal(second.status, "refused");
  assert.equal(second.errors[0].code, "E_BUG_CREATE_CEILING");
  assert.match(String(second.withheld), /ceiling reached/);
});

test("title-hash guard refuses a same-run near-identical title even when dedupe finds no issue match", () => {
  // The refetched issue list stays empty, so dedupe clears both intakes; the
  // session's title-hash guard is what stops the second, near-identical filing.
  const { gh, calls } = mockGh({ issues: [] });
  const root = mkRoot();
  const shared = session(5);
  const first = runBugLog({ env: env(), gh, session: shared, intake: buildBugLogIntake({ expected: "anchors migrate cleanly", actual: "Grammar gate rejects valid anchors" }), root });
  assert.equal(first.status, "filed");
  const second = runBugLog({ env: env(), gh, session: shared, intake: buildBugLogIntake({ expected: "entirely different wording here", actual: "grammar GATE — rejects valid anchors!!" }), root });
  assert.equal(second.status, "refused");
  assert.equal(second.errors[0].code, "E_BUG_DUPLICATE_TITLE");
  assert.equal(calls.filter((call) => call[1] === "create").length, 1, "only the first intake created an issue");
});

test("gh unavailable is retryable, never silent, and writes nothing", () => {
  const { gh, calls } = mockGh({ viewFails: true });
  const result = runBugLog({ env: env(), gh, session: session(), intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "retryable");
  assert.match(result.next_actions[0], /gh auth/);
  assert.equal(calls.filter((call) => call[0] === "issue").length, 0);
});

test("signal intake renders provenance: finding id, call date, attribution basis, dissent", () => {
  const intake = buildSignalBugIntake({
    finding_id: "F-024",
    paraphrase: "Install friction: the tester hit a permission wall on first run and gave up for the day.",
    completed_at: "2026-07-22T17:30:00.000Z",
    inbox_scope_id: "granola_morgan_example_2026_07",
    evidence_type: "stated",
    confidence: "high",
    dissent: "One tester; may be environment-specific.",
  });
  assert.equal(intake.title, "Install friction");
  assert.match(intake.body, /## Evidence[\s\S]*permission wall/);
  assert.match(intake.body, /## Provenance/);
  assert.match(intake.body, /Signal: F-024 \(discovery inbox\)/);
  assert.match(intake.body, /Call date: 2026-07-22T17:30:00\.000Z/);
  assert.match(intake.body, /scope granola_morgan_example_2026_07, evidence stated, confidence high/);
  assert.match(intake.body, /Dissent: One tester/);
});

test("signal intake prefers the headline field over the paraphrase kicker (#567)", () => {
  const intake = buildSignalBugIntake({
    finding_id: "F-025",
    headline: "Wants one-line installer with interactive agent setup",
    paraphrase: "Direct product request from Example: the installer should be a one-line fetch-and-run command.",
    completed_at: "2026-07-14T20:30:00.000Z",
    inbox_scope_id: "granola_morgan_example_2026_q3",
    evidence_type: "stated",
    confidence: "high",
  });
  // Not the kicker ("Direct product request from Example") — the headline.
  assert.equal(intake.title, "Wants one-line installer with interactive agent setup");
  // The paraphrase still seeds the evidence body.
  assert.match(intake.body, /## Evidence[\s\S]*one-line fetch-and-run/);
});

test("signal intake normalizes a multi-line headline to its first line (#567)", () => {
  const intake = buildSignalBugIntake({
    finding_id: "F-025",
    headline: "Wants one-line installer\nwith interactive agent setup",
    paraphrase: "Direct product request: a one-line installer.",
    completed_at: "2026-07-14T20:30:00.000Z",
    inbox_scope_id: "granola_morgan_example_2026_q3",
    evidence_type: "stated",
    confidence: "high",
  });
  assert.ok(!intake.title.includes("\n"), "title must be single-line");
  assert.equal(intake.title, "Wants one-line installer");
});

test("signal intake caps a long single-line headline at 90 chars (#567)", () => {
  const longHeadline = "Wants a one-line installer with interactive agent selection and desktop-app client support across every coding agent runtime";
  const intake = buildSignalBugIntake({
    finding_id: "F-025",
    headline: longHeadline,
    paraphrase: "Direct product request: a one-line installer.",
    completed_at: "2026-07-14T20:30:00.000Z",
    inbox_scope_id: "granola_morgan_example_2026_q3",
    evidence_type: "stated",
    confidence: "high",
  });
  assert.ok(intake.title.length <= 90, `title must be capped at 90 chars, got ${intake.title.length}`);
  assert.match(intake.title, /^Wants a one-line installer/);
  assert.match(intake.title, /…$/);
});

test("signal intake falls back to the kicker when no headline is present (#567)", () => {
  const intake = buildSignalBugIntake({
    finding_id: "F-024",
    paraphrase: "Install friction: the tester hit a permission wall on first run.",
    completed_at: "2026-07-22T17:30:00.000Z",
    inbox_scope_id: "granola_morgan_example_2026_07",
    evidence_type: "stated",
    confidence: "high",
  });
  assert.equal(intake.title, "Install friction");
});

test("a malformed creation ceiling disables creation instead of inventing one", () => {
  const created = newBugLogSession({ FOO_BUG_LOG_MAX_CREATES: "banana" });
  assert.equal(created.max_creates, 0);
  const { gh } = mockGh({ issues: [] });
  const result = runBugLog({ env: env(), gh, session: created, intake: INTAKE, root: mkRoot() });
  assert.equal(result.status, "refused");
  assert.equal(result.errors[0].code, "E_BUG_CREATE_CEILING");
});

test("the ceiling bounds a loop across separate invocations, not just within one process (RISK-002)", () => {
  // A loop that re-invokes the verb once per defect gets a brand-new session
  // each time; without the persisted creation log the ceiling would never trip.
  const { gh } = mockGh({ issues: [] });
  const root = mkRoot();
  const runOnce = (actual: string) =>
    runBugLog({
      env: env(),
      gh,
      // Exactly what the CLI does per invocation: a fresh session seeded from root.
      session: newBugLogSession(env(), root),
      intake: buildBugLogIntake({ expected: "distinct defect", actual }),
      root,
    });

  assert.equal(runOnce("classifier A misroutes on discoveryCommand.ts").status, "filed");
  assert.equal(runOnce("classifier B drops anchors in grammarGate.ts").status, "filed");
  assert.equal(runOnce("classifier C mis-scopes in sourceIngress.ts").status, "filed");
  // Fourth distinct filing in a fresh invocation: title-hash guard cannot catch
  // it (new title), but the seeded ceiling now does.
  const fourth = runOnce("classifier D leaks in bugTransport.ts");
  assert.equal(fourth.status, "refused");
  assert.equal(fourth.errors[0].code, "E_BUG_CREATE_CEILING");
});

test("the creation count is a rolling window, scoped to the configured owner repo", () => {
  const root = mkRoot();
  const now = 1_700_000_000_000;
  // Record with a wide window so nothing is pruned on write; the read-time
  // window is what we exercise below.
  const wide = { ...env(), FOO_BUG_LOG_WINDOW_SECONDS: "100000" };
  recordBugCreate(root, wide, REPO, now - 3_600_000); // an hour old
  recordBugCreate(root, wide, REPO, now - 60_000); // a minute old
  recordBugCreate(root, wide, "someone/other-tracker", now - 1_000); // different repo
  // A 10-minute read window counts only the recent filing for THIS repo.
  assert.equal(recentBugCreateCount(root, { ...env(), FOO_BUG_LOG_WINDOW_SECONDS: "600" }, now), 1);
  // A wider read window brings the hour-old filing back into scope.
  assert.equal(recentBugCreateCount(root, { ...env(), FOO_BUG_LOG_WINDOW_SECONDS: "7200" }, now), 2);
});
