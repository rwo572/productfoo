// Shared, runtime-neutral reconcile engine (asp-cli-lifecycle-v0 T-001).
//
// Reconcile answers one question: does every changed file map to an agreed task
// touchpoint? The per-packet `reconcile.ts` modules used to each carry an
// identical copy of this logic, differing only by a human task noun and the
// spec_id/packet labels — both of which are derivable from the packet itself.
// This module is that single copy; the per-packet wrappers now delegate here,
// and `foo asp reconcile` can run it generically on any packet dir with no
// compiled per-packet module at all (T-002).
//
// The richer worked example (examples/calpal-scheduling) keeps its own bespoke
// reconcile — freshness, drift, and work-evidence findings — and is not folded
// into this engine.

import { gitRun } from "./gitRun.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import {
  approvalStates,
  jiraScopeCoversIssue,
  jiraScopeString,
  jiraSiteHost,
  parseJiraScope,
  parseJiraScopeString,
  parseJiraSource,
  sourceKey,
  type JiraRawIssue,
  type SourceId,
} from "./sourceIngress.js";
import { UsageError } from "./errorTaxonomy.js";

export type JsonObject = Record<string, unknown>;

export type Task = {
  id: string;
  agreement: string;
  // Packet task state ("todo" | "doing" | "blocked" | "done" | "dropped") as
  // written in tasks.yaml. Optional because older readers may omit it; a task
  // with no status reads as "not done" (fail-closed) in Jira comparisons.
  status?: string;
  touches?: string[];
};

export type ChangedFileClass = {
  path: string;
  state: "agreed" | "unagreed" | "unmapped";
  mapped_tasks: string[];
  mapped_task_agreements: Record<string, string>;
};

export type ReconcileOptions = {
  packetDir: string;
  root: string;
  changedFiles?: string[];
  gitDiff?: boolean;
  // Human-readable noun woven into summary/finding prose ("npm installer").
  // Omitted for generic dispatch, where neutral phrasing is used.
  taskNoun?: string;
  // Path to a Jira evidence fixture (jira-source-connector-v0 T-005), resolved
  // against root. When set, reconcile also maps work-system evidence onto
  // packet tasks — behind the substrate approval gate — and labels those
  // findings `evidence_kind: "work_system"`.
  jiraEvidencePath?: string;
};

export type ReconcileReport = {
  spec_id: unknown;
  packet: string;
  changed_files: Array<{
    path: string;
    state: "agreed" | "unagreed" | "unmapped";
    mapped_tasks: string[];
    mapped_task_agreements: Record<string, string>;
  }>;
  findings: JsonObject[];
  summary: string;
  // Present only when reconcile ran with a Jira evidence fixture
  // (jira-source-connector-v0 T-005): the admitted/excluded work-system
  // evidence block, with its findings merged into `findings`.
  work_system?: JiraWorkSystemReport;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function parseReconcileArgs(args: string[]): { changedFiles: string[]; gitDiff: boolean; jiraEvidencePath?: string } {
  const options: { changedFiles: string[]; gitDiff: boolean; jiraEvidencePath?: string } = { changedFiles: [], gitDiff: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--changed-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--changed-file requires a value");
      options.changedFiles.push(value);
      index += 1;
      continue;
    }

    if (arg === "--git-diff") {
      options.gitDiff = true;
      continue;
    }

    if (arg === "--jira-evidence") {
      const value = args[index + 1];
      if (!value) throw new Error("--jira-evidence requires a path to a Jira evidence fixture (JSON)");
      options.jiraEvidencePath = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown reconcile argument: ${arg}`);
  }

  return options;
}

function touchMatches(touch: string, changedFile: string): boolean {
  return touch.endsWith("/") ? changedFile.startsWith(touch) : changedFile === touch;
}

// What the working tree changed, as the drift check must see it.
//
// This was `git diff --name-only`, which answers a much narrower question than
// anyone reading the call site assumed: *unstaged* edits to *tracked* files. It
// therefore had two blind spots, and drift silently reported success on work it
// had never seen — the exact "claimed read as proven" failure foo exists to stop.
//
//   1. New files were invisible. `git diff` cannot see an untracked file at any
//      --cached setting. A build made entirely of new files — the common agent
//      case — reconciled perfectly clean.
//   2. Staged files were invisible, including *modified tracked* ones. So after
//      a routine `git add -A` the check saw NOTHING AT ALL and called the packet
//      clean. Staging your work disabled the drift detector.
//
// Both halves are needed and neither subsumes the other: `diff HEAD` covers
// staged+unstaged for files git tracks, `ls-files --others` covers files git has
// never seen. --exclude-standard keeps .gitignore'd paths (node_modules, build
// output) out, so the report stays about the author's work.
export function gitChangedFiles(root: string): string[] {
  const tracked = gitRun(["-C", root, "diff", "--name-only", headRef(root)]);
  if (!tracked.ok) throw new Error(tracked.message);
  const untracked = gitRun(["-C", root, "ls-files", "--others", "--exclude-standard"]);
  if (!untracked.ok) throw new Error(untracked.message);
  const lines = [...splitGitLines(tracked.stdout), ...splitGitLines(untracked.stdout)];
  // A file can be both staged and dirty; it is still one changed file.
  return [...new Set(lines)].sort();
}

// `diff HEAD` is the right comparison once there is a commit to compare against.
// In a repo whose first commit has not landed, HEAD does not resolve and git
// exits non-zero — so the reconcile of a brand-new packet would crash rather
// than report. There, everything in the index is new, and `--cached` alone says so.
function headRef(root: string): string {
  const head = gitRun(["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
  return head.ok ? "HEAD" : "--cached";
}

function splitGitLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function tasksForChangedFile(tasks: Task[], changedFile: string): Task[] {
  return tasks.filter((task) => (task.touches ?? []).some((touch) => touchMatches(touch, changedFile)));
}

// The COVERAGE-axis core (reconcile-anywhere-v0 T-001): classify each changed
// file against the agreed task touchpoints and emit the unmapped findings. Pure
// and packet-free — the shared engine the packet path (`reconcilePacket`, below)
// and the top-level packet-free `foo reconcile` both call, so the two entry
// points can never drift (D-001). With no tasks (a repo that has never heard of
// packets), every changed file classifies `unmapped`, which IS the honest
// adoption signal: nothing is covered by an agreed task yet.
export function classifyChangedFiles(
  tasks: Task[],
  changedFileInputs: string[],
  noun = "",
): { changed_files: ChangedFileClass[]; findings: JsonObject[] } {
  const findings: JsonObject[] = [];
  const nounPrefix = noun ? `${noun} ` : "";
  const changed_files = [...new Set(changedFileInputs)].sort().map((changedFile): ChangedFileClass => {
    const mappedTasks = tasksForChangedFile(tasks, changedFile);
    const agreements = Object.fromEntries(mappedTasks.map((task) => [task.id, task.agreement]));
    const state: "agreed" | "unagreed" | "unmapped" =
      mappedTasks.length === 0
        ? "unmapped"
        : Object.values(agreements).includes("agreed")
          ? "agreed"
          : "unagreed";

    if (state === "unmapped") {
      findings.push({
        kind: "unmapped_changed_file",
        severity: "high",
        file: changedFile,
        subject: `file:${changedFile}`,
        summary: `Changed file does not map to any agreed ${nounPrefix}task touchpoint.`,
        suggested_actions: [
          "map the file to an agreed task",
          "create a discovered task",
          "revert the unrelated file change",
        ],
        requires_human: true,
      });
    }

    return {
      path: changedFile,
      state,
      mapped_tasks: mappedTasks.map((task) => task.id),
      mapped_task_agreements: agreements,
    };
  });
  return { changed_files, findings };
}

// --- Jira work-system evidence (jira-source-connector-v0 T-005 / R-006) -----

// Jira findings render as WORK-SYSTEM evidence in reconcile output: issue
// status against packet task state, stale or missing proof references, and
// conflicts reported, never silently resolved (R-006). Every finding carries
// `evidence_kind` so the output distinguishes tracker state (`work_system`),
// changed-file coverage (`repo`), and the engine's own derived verdicts
// (`agent_inference`) — agent inference is labeled, never presented as fact.

// The offline Jira evidence a runtime (or a fixture) hands to reconcile. The
// runtime read the issues through an approved scope and declares that scope
// (the canonical approved-scope string, or the equivalent object) plus when it
// observed the issues. Each issue optionally cites the packet task it is
// evidence for; an uncited issue can never be mapped onto a task by guessing.
export type JiraEvidenceFixture = {
  provider: "jira";
  site: string;
  observed_at: string;
  scope: unknown;
  issues: Array<{ issue: unknown; cites_task?: string }>;
};

export type JiraWorkSystemReport = {
  source_id: SourceId;
  site: string;
  observed_at: string;
  scope: string;
  admitted: number;
  excluded: number;
  // Raw tracker-derived findings (evidence_kind: "work_system").
  findings: JsonObject[];
  // The engine's derived per-task verdicts (evidence_kind: "agent_inference").
  task_conclusions: JsonObject[];
};

// Jira status names are site-configurable, so done detection matches a small
// documented name set and findings report the status name they saw — the
// engine never pretends to know a site's workflow.
const JIRA_DONE_STATUS = /^(done|closed|resolved)$/i;
// Freshness is DERIVED from observed timestamps (R-006): an issue untouched
// for this many days before the observation is reported stale.
export const JIRA_STALE_DAYS = 30;

function jiraTrackerDone(status: string): boolean {
  return JIRA_DONE_STATUS.test(status.trim());
}

function jiraFreshness(updated: string, observedAt: string): { freshness: "fresh" | "stale"; age_days: number } {
  const ageDays = Math.floor((Date.parse(observedAt) - Date.parse(updated)) / 86_400_000);
  return { freshness: ageDays > JIRA_STALE_DAYS ? "stale" : "fresh", age_days: ageDays };
}

// Reconcile a validated Jira evidence fixture against packet task state.
// Pure apart from reading the packet's approval ledger: the gate refuses
// unapproved sources (exit-path, like the GitHub reconcile gate), and evidence
// that falls outside the approved scope or cannot be mapped is EXCLUDED with a
// finding — never admitted, never resolved.
export function jiraWorkSystemReconcile(opts: {
  packetDir: string;
  fixture: JiraEvidenceFixture;
  tasks: Task[];
}): JiraWorkSystemReport {
  if (opts.fixture.provider !== "jira") {
    throw new UsageError(`jira evidence fixture must declare provider "jira"`, "E_BAD_FLAG");
  }
  if (typeof opts.fixture.observed_at !== "string" || Number.isNaN(Date.parse(opts.fixture.observed_at))) {
    throw new UsageError(`jira evidence fixture needs an ISO observed_at — freshness is derived from observed timestamps (R-006)`, "E_BAD_FLAG");
  }
  const site = jiraSiteHost(opts.fixture.site);
  const sourceId: SourceId = { ingress_path: "nango", provider: "jira", connection_id: site };
  const scope =
    typeof opts.fixture.scope === "string" ? parseJiraScopeString(opts.fixture.scope) : parseJiraScope(opts.fixture.scope);
  const scopeStr = jiraScopeString(scope);

  // Gate (R-004): connection is not approval — the source must be approved for
  // THIS packet and the read must have run through exactly an approved scope
  // (substrate accumulation is exact-match; nothing here widens it).
  const approval = approvalStates(opts.packetDir).get(sourceKey(sourceId));
  if (approval?.state !== "approved" || !approval.scopes.includes(scopeStr)) {
    const rel = path.relative(process.cwd(), opts.packetDir).split(path.sep).join("/") || opts.packetDir;
    throw new Error(
      `Jira source ${site} is ${approval?.state ?? "excluded"} for this packet, or the declared scope was never approved — connection is not approval.\n` +
        `Approve the bounded scope, then re-run:\n` +
        `  foo source approve ${rel} --provider jira --connection ${site} --scope '${scopeStr}' --by <you>\n`,
    );
  }

  const byTask = new Map(opts.tasks.map((task) => [task.id, task]));
  const findings: JsonObject[] = [];
  const task_conclusions: JsonObject[] = [];
  let admitted = 0;
  let excluded = 0;

  for (const entry of opts.fixture.issues ?? []) {
    let issue: JiraRawIssue;
    try {
      issue = parseJiraSource(entry?.issue);
    } catch (error) {
      excluded += 1;
      findings.push({
        kind: "work_system_unparseable",
        evidence_kind: "work_system",
        severity: "high",
        summary: `a Jira issue fixture was refused by the parse layer: ${error instanceof Error ? error.message : String(error)}`,
        requires_human: true,
      });
      continue;
    }
    // Scope containment (R-004): an issue outside the approved scope never
    // surfaces — reported loudly, not silently dropped.
    if (!jiraScopeCoversIssue(scope, issue)) {
      excluded += 1;
      findings.push({
        kind: "work_system_out_of_scope",
        evidence_kind: "work_system",
        severity: "high",
        issue_key: issue.key,
        summary: `issue ${issue.key} falls outside the approved scope — the runtime read an unapproved project`,
        requires_human: true,
      });
      continue;
    }
    admitted += 1;
    const freshness = jiraFreshness(issue.updated, opts.fixture.observed_at);

    if (freshness.freshness === "stale") {
      findings.push({
        kind: "work_system_stale",
        evidence_kind: "work_system",
        severity: "medium",
        issue_key: issue.key,
        freshness,
        summary: `issue ${issue.key} was last updated ${freshness.age_days} days before observation — freshness is derived from observed timestamps, not asserted`,
        requires_human: false,
      });
    }

    const cites = typeof entry.cites_task === "string" ? entry.cites_task.trim() : "";
    if (!cites) {
      findings.push({
        kind: "work_system_unmapped",
        evidence_kind: "work_system",
        severity: "medium",
        issue_key: issue.key,
        status: issue.status,
        summary: `issue ${issue.key} cites no packet task — work-system evidence maps onto tasks only by explicit citation, never by guessing`,
        requires_human: true,
      });
      continue;
    }
    const task = byTask.get(cites);
    if (!task) {
      findings.push({
        kind: "work_system_unknown_task",
        evidence_kind: "work_system",
        severity: "medium",
        issue_key: issue.key,
        cites_task: cites,
        summary: `issue ${issue.key} cites task ${cites}, which this packet does not define`,
        requires_human: true,
      });
      continue;
    }

    const trackerDone = jiraTrackerDone(issue.status);
    const packetDone = task.status === "done";
    if (trackerDone && !packetDone) {
      findings.push({
        kind: "work_system_conflict",
        evidence_kind: "work_system",
        severity: "high",
        issue_key: issue.key,
        cites_task: cites,
        tracker_status: issue.status,
        packet_status: task.status,
        summary: `tracker says ${issue.key} is done (${issue.status}) but packet task ${cites} is not — reported, never silently resolved (R-006)`,
        requires_human: true,
      });
    } else if (!trackerDone && packetDone) {
      findings.push({
        kind: "work_system_conflict",
        evidence_kind: "work_system",
        severity: "high",
        issue_key: issue.key,
        cites_task: cites,
        tracker_status: issue.status,
        packet_status: "done",
        summary: `packet task ${cites} is done but tracker shows ${issue.key} as ${issue.status} — reported, never silently resolved (R-006)`,
        requires_human: true,
      });
    } else {
      findings.push({
        kind: "work_system_status",
        evidence_kind: "work_system",
        severity: "low",
        issue_key: issue.key,
        cites_task: cites,
        tracker_status: issue.status,
        freshness,
        summary: `issue ${issue.key} (${issue.status}) vs task ${cites} (${packetDone ? "done" : "not done"})`,
        requires_human: false,
      });
    }

    // RISK-001: tracker status creates false certainty when repo proof is
    // missing. A done-category issue with no remote links is the exact
    // conflict class — rendered, never resolved.
    if (trackerDone && (issue.remote_links ?? []).length === 0) {
      findings.push({
        kind: "work_system_missing_proof",
        evidence_kind: "work_system",
        severity: "high",
        issue_key: issue.key,
        cites_task: cites,
        summary: `tracker says ${issue.key} is done with no remote links to repo proof — tracker status alone proves nothing (RISK-001)`,
        requires_human: true,
      });
    }

    // The engine's own derived verdict — labeled agent_inference so it is
    // never mistaken for tracker or repo fact (V-006).
    task_conclusions.push({
      task_id: cites,
      issue_key: issue.key,
      packet_status: packetDone ? "done" : "not done",
      tracker_status: issue.status,
      tracker_done_category: trackerDone,
      conclusion: trackerDone && packetDone ? "corroborated" : trackerDone || packetDone ? "conflict" : "in_flight",
      basis: "deterministic name-match of tracker status against packet task state; statuses are site-configurable names",
      evidence_kind: "agent_inference",
    });
  }

  return {
    source_id: sourceId,
    site,
    observed_at: opts.fixture.observed_at,
    scope: scopeStr,
    admitted,
    excluded,
    findings,
    task_conclusions,
  };
}

// Reads a Jira evidence fixture file for reconcile. The fixture path is
// resolved against the repo root, like every other fixture flag.
export function readJiraEvidenceFixture(root: string, fixturePath: string): JiraEvidenceFixture {
  const resolved = path.resolve(root, fixturePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new UsageError(`--jira-evidence is not readable JSON: ${fixturePath}`, "E_BAD_FLAG");
  }
  const fixture = parsed as Partial<JiraEvidenceFixture> | null;
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new UsageError(`--jira-evidence must be a JSON object`, "E_BAD_FLAG");
  }
  if (fixture.provider !== "jira" || typeof fixture.site !== "string" || !Array.isArray(fixture.issues)) {
    throw new UsageError(`--jira-evidence needs {provider: "jira", site, observed_at, scope, issues}`, "E_BAD_FLAG");
  }
  return fixture as JiraEvidenceFixture;
}

export function reconcilePacket(options: ReconcileOptions): ReconcileReport {
  const tasksDoc = asObject(parseYaml(readFileSync(path.join(options.packetDir, "tasks.yaml"), "utf8")));
  const tasks = (tasksDoc.tasks as Task[] | undefined) ?? [];
  const gitDiff = options.gitDiff ?? false;
  const requested = options.changedFiles ?? [];
  const changedFileInputs = requested.length > 0 || !gitDiff ? requested : gitChangedFiles(options.root);
  const noun = options.taskNoun ?? "";

  const { changed_files: changedFiles, findings: repoFindings } = classifyChangedFiles(tasks, changedFileInputs, noun);
  // Repo findings are labeled by evidence class so reconcile output
  // distinguishes changed-file coverage from work-system evidence and agent
  // inference (jira-source-connector-v0 T-005 / V-006).
  const findings: JsonObject[] = repoFindings.map((f) => ({ ...f, evidence_kind: "repo" }));
  let work_system: JiraWorkSystemReport | undefined;
  if (options.jiraEvidencePath) {
    const fixture = readJiraEvidenceFixture(options.root, options.jiraEvidencePath);
    work_system = jiraWorkSystemReconcile({ packetDir: options.packetDir, fixture, tasks });
    findings.push(...work_system.findings);
  }

  // packet is the packet dir relative to the repo root, in POSIX form, matching
  // the literal value the per-packet wrappers used to hardcode.
  const packet = path.relative(options.root, options.packetDir).split(path.sep).join("/");

  const workSummary = work_system
    ? ` Work-system evidence from ${work_system.site}: ${work_system.admitted} admitted, ${work_system.excluded} excluded.`
    : "";
  return {
    spec_id: tasksDoc.spec_id,
    packet,
    changed_files: changedFiles,
    findings,
    ...(work_system ? { work_system } : {}),
    summary:
      findings.length === 0
        ? `All changed files map to agreed ${noun ? `${noun} ` : ""}tasks.${workSummary}`
        : `${findings.length} reconciliation finding(s) need review.${workSummary}`,
  };
}
