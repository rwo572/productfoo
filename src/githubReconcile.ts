// GitHub done_when verdict engine (github-integration-v0 T-003/T-004). Reconciles
// a packet's done_when criteria against the typed GitHub facts of an approved PR
// into a fail-closed tri-state verdict. Pure + offline: the runtime/CLI supplies
// the evidence, this module decides. It consumes sourceIngress for the source
// identity and the payload-free conflict-event shape; it re-implements no
// substrate behavior (R-005). This is the PROOF axis (criterion ↔ evidence) —
// orthogonal to and composing with packetReconcile's COVERAGE axis (changed-file
// ↔ task); the two are named as one drift model with two axes, never merged
// (D-011). `no-linkage` here is the proof-axis analog of the coverage axis's
// `unmapped`.

import { appendSourceConflictEvent, type GithubFixture, githubLinkageForSpec, type SourceId } from "./sourceIngress.js";

export type GithubCheck = { name?: string; conclusion?: string };

// Typed GitHub facts for an approved PR (the only authority that can corroborate,
// R-004 split authority). Free-text (bodies, titles, logs) is deliberately absent
// here: it is inert reference and never feeds a verdict.
export type GithubEvidence = {
  merged?: boolean;
  state?: string;
  checks?: GithubCheck[];
  commits?: Array<{ message?: string; files?: string[] }>;
  files_changed?: string[];
};

// A criterion's optional, explicit GitHub-checkable predicate (R-006). ONLY a
// typed predicate can corroborate; a criterion without one is out-of-reach. This
// is what keeps free text from ever producing `satisfied`.
export type CriterionCheck =
  | { kind: "pr_merged" }
  | { kind: "checks_pass" }
  | { kind: "path_changed"; path: string };

export type DoneWhenCriterion = { id: string; text?: string; check?: CriterionCheck };

export type NotVerifiedReason = "no-linkage" | "signal-absent" | "out-of-reach";
export type CriterionStatus = "corroborated" | "contradicted" | "unresolvable";
export type Verdict = "satisfied" | "drifted" | "not-verified";

export type CriterionVerdict = {
  criterion_id: string;
  status: CriterionStatus;
  reason?: NotVerifiedReason;
  basis: string;
  teach?: string;
};

// null = no diff information at all (signal-absent); [] = diff known but empty.
function changedFiles(ev: GithubEvidence): string[] | null {
  const hasInfo = ev.files_changed !== undefined || (ev.commits ?? []).some((c) => c.files !== undefined);
  if (!hasInfo) return null;
  return [...(ev.files_changed ?? []), ...(ev.commits ?? []).flatMap((c) => c.files ?? [])];
}

// Errors that teach (R-006): each not-verified reason names the concept, the fix,
// and the next command — the Rust-compiler bar, not a bare assertion.
const teachFor: Record<NotVerifiedReason, (c: DoneWhenCriterion) => string> = {
  "no-linkage": (c) =>
    `not-verified (no-linkage): no PR/commit is bound to ${c.id} → add a Foo-Spec trailer to the implementing commit (or pass --source github:<pr-url>), then re-run foo asp reconcile`,
  "signal-absent": (c) =>
    `not-verified (signal-absent): ${c.id} needs a GitHub signal that is not present yet (e.g. no required checks, or the PR is still open) → re-run once the signal exists`,
  "out-of-reach": (c) =>
    `not-verified (out-of-reach): ${c.id} asserts something read-only GitHub signal cannot confirm → verify by test/review, or declare a check predicate (pr_merged | checks_pass | path_changed)`,
};

// Verify ONE criterion against the typed evidence (R-006). Corroboration is read
// only from typed fields; free text never corroborates. Precedence inside a
// criterion is fail-closed: an explicit contradiction beats a missing signal.
export function verifyCriterion(criterion: DoneWhenCriterion, ev: GithubEvidence, linked: boolean): CriterionVerdict {
  const nv = (reason: NotVerifiedReason, basis: string): CriterionVerdict => ({
    criterion_id: criterion.id,
    status: "unresolvable",
    reason,
    basis,
    teach: teachFor[reason](criterion),
  });
  // (1) no-linkage: nothing binds this PR to the criterion's packet (D-009).
  if (!linked) return nv("no-linkage", "no PR/commit is bound to this criterion's task via the Foo-Spec trailer");
  // (3) out-of-reach: no typed predicate, so GitHub signal cannot speak to it.
  const check = criterion.check;
  if (!check) return nv("out-of-reach", "no GitHub-checkable predicate; the criterion is outside read-only GitHub signal");

  if (check.kind === "pr_merged") {
    if (ev.merged === true) return { criterion_id: criterion.id, status: "corroborated", basis: "PR is merged" };
    if (ev.merged === false) return { criterion_id: criterion.id, status: "contradicted", basis: `PR is not merged (state: ${ev.state ?? "open"})` };
    return nv("signal-absent", "PR merge state is not present in the evidence");
  }

  if (check.kind === "checks_pass") {
    const checks = ev.checks ?? [];
    if (checks.length === 0) return nv("signal-absent", "no required checks are present");
    const failed = checks.find((c) => c.conclusion === "failure");
    if (failed) return { criterion_id: criterion.id, status: "contradicted", basis: `a required check = failure` };
    if (checks.every((c) => c.conclusion === "success")) {
      return { criterion_id: criterion.id, status: "corroborated", basis: `${checks.length}/${checks.length} required checks green` };
    }
    // pending/neutral/unknown conclusions present and none failed: cannot confirm green.
    return nv("signal-absent", "not all required checks have a success conclusion yet");
  }

  // path_changed
  const files = changedFiles(ev);
  if (files === null) return nv("signal-absent", "no diff/file information is present in the evidence");
  const hit = files.some((f) => f === check.path || f.startsWith(check.path) || f.includes(check.path));
  return hit
    ? { criterion_id: criterion.id, status: "corroborated", basis: `a commit changed ${check.path}` }
    : { criterion_id: criterion.id, status: "contradicted", basis: `no commit changed ${check.path}` };
}

export type ReconcileResult = {
  verdict: Verdict;
  criteria: CriterionVerdict[];
  counts: { corroborated: number; contradicted: number; unresolvable: number };
  observed_at?: string;
};

// Aggregate per-criterion statuses into the fail-closed verdict (R-005): any
// contradicted → drifted; else any unresolvable → not-verified; else satisfied.
// `satisfied` therefore requires positive corroboration on EVERY criterion —
// silence is never a pass. An empty criteria set is not-verified, not satisfied.
export function aggregateVerdict(criteria: CriterionVerdict[]): Verdict {
  if (criteria.length === 0) return "not-verified";
  if (criteria.some((c) => c.status === "contradicted")) return "drifted";
  if (criteria.some((c) => c.status === "unresolvable")) return "not-verified";
  return "satisfied";
}

export function reconcileDoneWhen(opts: {
  criteria: DoneWhenCriterion[];
  evidence: GithubEvidence;
  linked: boolean;
  observedAt?: string;
}): ReconcileResult {
  const criteria = opts.criteria.map((c) => verifyCriterion(c, opts.evidence, opts.linked));
  return {
    verdict: aggregateVerdict(criteria),
    criteria,
    counts: {
      corroborated: criteria.filter((c) => c.status === "corroborated").length,
      contradicted: criteria.filter((c) => c.status === "contradicted").length,
      unresolvable: criteria.filter((c) => c.status === "unresolvable").length,
    },
    observed_at: opts.observedAt,
  };
}

// Freshness (R-005 / OQ-2 carried default): a typed-fact verdict is stamped with
// observed_at and goes stale past the window, so a re-run is prompted rather than
// a cached `satisfied` trusted. Fail-closed: an unparseable timestamp is stale.
export const DEFAULT_VERDICT_MAX_AGE_SECONDS = 86400;

export function isStale(observedAt: string, now: string, maxAgeSeconds = DEFAULT_VERDICT_MAX_AGE_SECONDS): boolean {
  const obs = Date.parse(observedAt);
  const cur = Date.parse(now);
  if (Number.isNaN(obs) || Number.isNaN(cur)) return true;
  return (cur - obs) / 1000 > maxAgeSeconds;
}

// Record a payload-free conflict event for each contradicted criterion (C-006),
// reusing the substrate writer. Returns the number of conflicts recorded. The
// event carries only criterion ids/status — no raw GitHub payload (B1).
export function recordGithubConflicts(packetDir: string, sourceId: SourceId, result: ReconcileResult, at: string): number {
  const contradicted = result.criteria.filter((c) => c.status === "contradicted");
  if (contradicted.length === 0) return 0;
  appendSourceConflictEvent(
    packetDir,
    {
      source_id: sourceId,
      conflicts: contradicted.map((c) => ({ criterion_id: c.criterion_id, status: c.status })),
      note: "GitHub evidence contradicts a done_when criterion; not promoted (github-integration-v0 R-004/R-005).",
    },
    at,
  );
  return contradicted.length;
}

// --- Dual-reader proof receipt (github-integration-v0 T-006/R-008) ----------

// The per-criterion status maps to the criterion-level verdict vocabulary.
const CRITERION_VERDICT: Record<CriterionStatus, Verdict> = {
  corroborated: "satisfied",
  contradicted: "drifted",
  unresolvable: "not-verified",
};

export type GithubReceipt = {
  schema_version: "0.1";
  packet: string;
  source_id: SourceId;
  verdict: Verdict;
  observed_at?: string;
  counts: ReconcileResult["counts"];
  // Machine-parseable per-criterion block (R-008): only ids, verdicts, reasons,
  // and foo-authored basis strings — never raw GitHub payload (B1).
  criteria: Array<{ criterion_id: string; verdict: Verdict; reason?: NotVerifiedReason; basis: string }>;
};

// --- Shared PR-reconcile engine (reconcile-anywhere-v0 T-001) ----------------
// The PROOF-axis core both entry points share (D-001): `asp reconcile --source
// github:` (packet path — criteria from tasks.yaml) and the top-level packet-free
// `foo reconcile`. Free text still never corroborates; only typed fields feed the
// verdict. Keeping this one function is the anti-drift mitigation the D-001
// dissent named: two entry points, one engine.

// Lift the typed GithubEvidence out of an offline fixture (or a runtime-supplied
// PR payload of the same shape). Only typed fields cross; bodies/titles stay out.
export function evidenceFromFixture(fixture: GithubFixture): GithubEvidence {
  return {
    merged: fixture.merged,
    state: fixture.state,
    checks: fixture.checks,
    commits: fixture.commits,
    files_changed: fixture.files_changed,
  };
}

export type PrProof = {
  evidence: GithubEvidence;
  result: ReconcileResult;
  receipt: GithubReceipt;
  linked: boolean;
};

// Given a PR fixture + a packet's done_when criteria, produce the typed-fact
// verdict and dual-reader receipt. `asp reconcile` delegates here (behavior
// preserved); the packet-free command reuses `evidenceFromFixture` and this same
// verdict once a packet has been adopted.
export function reconcilePrProof(opts: {
  packet: string;
  sourceId: SourceId;
  fixture: GithubFixture;
  specId: string;
  criteria: DoneWhenCriterion[];
  observedAt?: string;
}): PrProof {
  const evidence = evidenceFromFixture(opts.fixture);
  const linked = githubLinkageForSpec({
    specId: opts.specId,
    commitMessages: (opts.fixture.commits ?? []).map((c) => c.message ?? ""),
    branch: opts.fixture.branch,
    prBody: opts.fixture.body,
  }).linked;
  const result = reconcileDoneWhen({ criteria: opts.criteria, evidence, linked, observedAt: opts.observedAt });
  const receipt = buildGithubReceipt({ packet: opts.packet, sourceId: opts.sourceId, result });
  return { evidence, result, receipt, linked };
}

export function buildGithubReceipt(opts: { packet: string; sourceId: SourceId; result: ReconcileResult }): GithubReceipt {
  return {
    schema_version: "0.1",
    packet: opts.packet,
    source_id: opts.sourceId,
    verdict: opts.result.verdict,
    observed_at: opts.result.observed_at,
    counts: opts.result.counts,
    criteria: opts.result.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      verdict: CRITERION_VERDICT[c.status],
      reason: c.reason,
      basis: c.basis,
    })),
  };
}

// Render the receipt as a copy-pasteable PR comment the DEVELOPER posts (foo posts
// nothing, R-008/R-007). Dual-reader: human-scannable markdown lines PLUS a
// machine block in an HTML comment (invisible in rendered markdown) so an agent
// re-reading the PR reconstructs the verdict without re-running. Payload-free.
export function renderGithubReceipt(receipt: GithubReceipt): string {
  const lines = receipt.criteria.map((c) => `- ${c.criterion_id}: ${c.verdict}${c.reason ? ` (${c.reason})` : ""} — ${c.basis}`);
  const machine = JSON.stringify({
    foo_verdict: {
      schema_version: receipt.schema_version,
      packet: receipt.packet,
      source_id: receipt.source_id,
      verdict: receipt.verdict,
      observed_at: receipt.observed_at,
      criteria: receipt.criteria.map((c) => ({ criterion_id: c.criterion_id, verdict: c.verdict, reason: c.reason })),
    },
  });
  return [
    `**foo proof receipt** — \`${receipt.packet}\` · verdict: **${receipt.verdict}**`,
    `source: ${receipt.source_id.provider}:${receipt.source_id.connection_id} (${receipt.source_id.external_id ?? "repo"}) · ${receipt.counts.corroborated} satisfied / ${receipt.counts.contradicted} drifted / ${receipt.counts.unresolvable} not-verified`,
    "",
    ...(lines.length ? lines : ["- (no criteria evaluated)"]),
    "",
    `<!-- foo:verdict ${machine} -->`,
    "",
  ].join("\n");
}
