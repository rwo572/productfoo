// Derived packet status (R-019 / D-019 / D-020).
//
// Progress is never stored in spec.md — it is derived here from tasks.yaml on
// every call. The default path is fast: it reads only tasks.yaml and spec.md,
// never git or the network, and never emits percent-complete. Source-authority,
// work-evidence (R-011), and last-meaningful-learning require git or event
// replay and are deferred to an explicit --deep flag (T-015); the fast view
// marks them "not yet checked" rather than faking them.
//
// derivePacketStatus() is the shared reader: the text view, the agent --json
// view, and any future cross-packet index all render from this one object.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import { isRetired, isTerminal, latestVerdict } from "./packetLifecycle.js";
import { glyphFor, STATUS_GLYPHS, withGlyph, type FooState } from "./statusGlyphs.js";
import {
  parseDecisionRequests,
  parseOpenQuestions,
  requirementIds,
  type DecisionFinding,
  type PacketDecisionRequest,
} from "./specSections.js";

export const PACKET_STATUS_SCHEMA_VERSION = "1.1";

export type TaskStatus = "todo" | "doing" | "blocked" | "done" | "dropped";

const CLAIMED_HUMAN_LABEL = STATUS_GLYPHS.claimed.label;

export type PacketNextAction =
  | { kind: "none"; reason: string }
  | { kind: "reconcile"; reason: string }
  | { kind: "decide"; decision: PacketDecisionRequest }
  | { kind: "unblock"; task: { id: string; title: string; reason: string | null } }
  | { kind: "task"; task: { id: string; title: string; status: "todo" | "doing" } };

export interface PacketStatus {
  packet: string;
  spec_id: string;
  title: string | null;
  lifecycle: string | null;
  // Lifecycle truth (packet-lifecycle-truth-v0 R-001). The hand-set header is a
  // claim; the task rows are the receipt. `lifecycle_stored` echoes the header
  // (same value as `lifecycle`, named for the contrast), `lifecycle_effective`
  // is derived purely from tasks.yaml — "done" only when every task is done
  // (dropped work excluded) and every done_when check is done WITH a proof
  // (D-001/Risks: effective-done means proofs-present, not merely claimed),
  // else "in_flight". `lifecycle_drift` flags the contradiction: a non-terminal
  // header over proven-done work, or a done/built stamp over unfinished work.
  // A terminal header (parked/killed/done/built) is a recorded disposition, so
  // parked/killed are never drift on their own — a parked packet at 0% tasks
  // is a decision, not a contradiction.
  lifecycle_stored: string | null;
  lifecycle_effective: "done" | "in_flight";
  lifecycle_drift: boolean;
  stage: string | null;
  mode: string | null;
  tasks: { total: number; done: number; doing: number; blocked: number; todo: number; dropped: number };
  proof: { checks_total: number; checks_done: number };
  requirements: { total: number; covered: number };
  // R-id -> P1/P2/... parsed from "### R-nnn" blocks' "- Priority:" line,
  // allowing the canonical blank line between the heading and metadata; used
  // by the index triage to inherit task priority from the requirements a task
  // implements (packet-index-triage-v0). Absent priorities simply don't rank.
  requirement_priorities: Record<string, string>;
  completed: string[];
  task_list: Array<{ id: string; title: string; status: TaskStatus; checksDone: number; checksTotal: number; agreement: string; owner: string | null; deps: string[]; refs: string[] }>;
  blocked: Array<{ id: string; title: string; reason: string | null }>;
  stale: Array<{ id: string; title: string; agreement: string; overdue: boolean }>;
  open_questions: string[];
  // Additive compatibility contract (decision-surface-clarity-v0): raw open
  // questions remain available, but only this typed union carries urgency.
  // Every renderer consumes it without interpreting question prose.
  next_action: PacketNextAction;
  decision_findings: DecisionFinding[];
  next: { id: string; title: string; kind: TaskStatus } | null;
  drift: { restamp: boolean };
  // Non-null only when frontmatter lifecycle is a retirement verdict (parked/
  // killed); reason comes from the latest lifecycle_changed ledger event.
  verdict: { state: string; reason: string | null; at: string | null } | null;
  deep_checked: boolean;
}

interface DeriveOptions {
  now?: Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Header identity is best-effort: packets mid-migration (T-013) still carry a
// flat `Spec ID:` / `Status:` header; restamped packets carry YAML frontmatter
// (D-017). Identity drives display only — counts never come from the header.
function parseHeader(specText: string): { title: string | null; lifecycle: string | null; stage: string | null; mode: string | null } {
  let title: string | null = null;
  let lifecycle: string | null = null;
  let stage: string | null = null;
  let mode: string | null = null;

  if (specText.startsWith("---")) {
    const end = specText.indexOf("\n---", 3);
    if (end !== -1) {
      try {
        const front = asRecord(parseYaml(specText.slice(3, end)));
        title = str(front.title);
        lifecycle = str(front.lifecycle) ?? str(front.status);
        stage = str(front.stage);
        mode = str(front.mode);
      } catch {
        // fall through to flat parsing
      }
    }
  }

  if (!title) {
    const m = specText.match(/^#\s+(.+?)\s*$/m);
    title = m ? m[1].trim() : null;
  }
  if (!lifecycle) lifecycle = specText.match(/^Status:\s*(\S+)/m)?.[1] ?? null;
  if (!stage) stage = specText.match(/^Stage:\s*(\S+)/m)?.[1] ?? null;
  if (!mode) mode = specText.match(/^Mode:\s*(\S+)/m)?.[1] ?? null;

  return { title, lifecycle, stage, mode };
}

function openQuestionTexts(specText: string): string[] {
  // Defensive de-dupe: a derived "needs attention" surface must never show the
  // same question twice (duplicate content reads as a broken derivation).
  return [...new Set(parseOpenQuestions(specText).map((q) => q.text))];
}

export interface PacketInputs {
  /** Parsed tasks.yaml document (may be any YAML value; wrapped by asRecord). */
  tasksDoc: unknown;
  /** Raw spec.md text. */
  specText: string;
}

// Single-packet derivation from already-read inputs (cli-performance-v0 R-001):
// the index reads and parses each packet's tasks.yaml and spec.md exactly once
// and threads the results through here, instead of every derivation re-reading
// the files. Does no fs I/O of its own except the retired-packet verdict tail.
export function derivePacketStatusFromInputs(packetDir: string, inputs: PacketInputs, options: DeriveOptions = {}): PacketStatus {
  const now = options.now ?? new Date();

  const doc = asRecord(inputs.tasksDoc);
  const rawTasks = doc.tasks;
  if (!Array.isArray(rawTasks)) throw new Error("tasks.yaml.tasks must be an array");
  const specText = inputs.specText;

  const specRequirements = new Set(requirementIds(specText));
  const requirementPriorities: Record<string, string> = {};
  for (const m of specText.matchAll(/^###\s+(R-?\d+)[^\n]*\r?\n(?:[ \t]*\r?\n)*-\s*Priority:\s*(P\d)/gm)) {
    requirementPriorities[m[1]] = m[2];
  }
  const header = parseHeader(specText);

  const counts = { total: 0, done: 0, doing: 0, blocked: 0, todo: 0, dropped: 0 };
  const proof = { checks_total: 0, checks_done: 0 };
  // Checks on live (non-dropped) tasks that are not yet done WITH a proof —
  // the receipt gap that keeps lifecycle_effective at in_flight (R-001).
  let unprovenChecks = 0;
  const completed: string[] = [];
  const blocked: PacketStatus["blocked"] = [];
  const stale: PacketStatus["stale"] = [];
  const coveredReqs = new Set<string>();
  const statusById = new Map<string, TaskStatus>();

  interface NormTask {
    id: string;
    title: string;
    status: TaskStatus;
    agreement: string;
    owner: string | null;
    refs: string[];
    dependsOn: string[];
    checksDone: number;
    checksTotal: number;
  }
  const tasks: NormTask[] = [];

  for (const raw of rawTasks) {
    const t = asRecord(raw);
    const id = str(t.id);
    if (!id) continue;
    const status = (str(t.status) ?? "todo") as TaskStatus;
    const title = str(t.title) ?? "";
    const agreement = str(t.agreement) ?? "agreed";
    const owner = str(t.owner);
    const refs = Array.isArray(t.refs) ? t.refs.map(str).filter((x): x is string => x !== null) : [];
    const dependsOn = Array.isArray(t.depends_on) ? t.depends_on.map(str).filter((x): x is string => x !== null) : [];
    statusById.set(id, status);

    // Per-task proof receipt: how many done_when checks are met. The packet
    // total is their sum; the index uses the per-task counts to tell a proven
    // task (every check met) from a merely done one.
    const doneWhen = Array.isArray(t.done_when) ? t.done_when : [];
    const checksTotal = doneWhen.length;
    const checksDone = doneWhen.filter((dw) => asRecord(dw).done === true).length;
    proof.checks_total += checksTotal;
    proof.checks_done += checksDone;
    if (status !== "dropped") {
      // Done without a proof string is a claim, not a receipt — it does not
      // count toward effective-done. Dropped work is excluded: its unmet
      // checks were retired with the task, not left open.
      unprovenChecks += doneWhen.filter((dw) => {
        const check = asRecord(dw);
        return check.done !== true || str(check.proof) === null;
      }).length;
    }

    tasks.push({ id, title, status, agreement, owner, refs, dependsOn, checksDone, checksTotal });

    counts.total += 1;
    if (status === "done") counts.done += 1;
    else if (status === "doing") counts.doing += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "dropped") counts.dropped += 1;
    else counts.todo += 1;

    // Requirement coverage counts requirements referenced by at least one
    // non-rejected task (agreement !== "rejected"), intersected with the
    // requirements that actually exist in spec.md.
    if (agreement !== "rejected") {
      for (const ref of refs) if (specRequirements.has(ref)) coveredReqs.add(ref);
    }

    if (status === "done") completed.push(id);
    if (status === "blocked") {
      blocked.push({ id, title, reason: str(t.blocked) });
    }
    if (agreement === "suggested" || agreement === "discovered") {
      const due = str(asRecord(t.review).due);
      const overdue = due !== null && !Number.isNaN(Date.parse(due)) && Date.parse(due) < now.getTime();
      stale.push({ id, title, agreement, overdue });
    }
  }

  // Next decision: the first todo/doing task whose dependencies are all done.
  // A retired packet (parked/killed) has no next decision by definition — its
  // remaining tasks are not backlog, they are covered by the verdict.
  const retired = isRetired(header.lifecycle);
  let next: PacketStatus["next"] = null;
  for (const t of tasks) {
    if (retired) break;
    if (t.status !== "todo" && t.status !== "doing") continue;
    const ready = t.dependsOn.every((dep) => statusById.get(dep) === "done");
    if (ready) {
      next = { id: t.id, title: t.title, kind: t.status };
      break;
    }
  }

  // The verdict reason is a bounded ledger-tail read, paid only by retired
  // packets so the common path stays tasks.yaml + spec.md only.
  const verdict = retired
    ? { state: header.lifecycle as string, ...verdictReason(packetDir, header.lifecycle as string) }
    : null;

  // Drift (foo-status-glyphs-v0 T-005, resolves OQ1): the header still claims an
  // unfinished lifecycle while every task is done — a restamp nudge. Computed in
  // the shared reader so asp status and asp index read the same signal. Mirrors
  // the existing packetIndex restamp flag.
  const restamp = header.lifecycle === "draft" && counts.total > 0 && counts.done === counts.total;

  // Effective lifecycle (packet-lifecycle-truth-v0 R-001): derived purely from
  // tasks.yaml, never from the header. Effectively done means every task is
  // done (dropped work excluded, at least one done) and every done_when check
  // on live tasks is done with a proof present; any open/doing/blocked task or
  // missing receipt keeps the packet in flight. Read-side only — nothing here
  // mutates the header; `foo asp verdict <packet> done` is the governed
  // transition (R-003).
  const effectivelyDone =
    counts.total > 0 &&
    counts.done > 0 &&
    counts.done + counts.dropped === counts.total &&
    unprovenChecks === 0;
  // Drift is a contradiction between claim and receipt (R-002): a non-terminal
  // header over effectively-done work, or a completion stamp (done/built) over
  // work that is not proofs-complete. Terminal retirement (parked/killed) is a
  // recorded decision, never drift — even at 0% tasks.
  const lifecycleDrift = effectivelyDone
    ? !isTerminal(header.lifecycle)
    : header.lifecycle === "done" || header.lifecycle === "built";

  const decisionParse = parseDecisionRequests(specText, { taskIds: statusById.keys() });
  const blockedTask = tasks.find((task) => task.status === "blocked") ?? null;
  const selectedDecision = (() => {
    for (const task of tasks) {
      if (task.status !== "blocked") continue;
      const request = decisionParse.requests.find(
        (candidate) => candidate.unblocks.kind === "task" && candidate.unblocks.id === task.id,
      );
      if (request) return request;
    }
    return decisionParse.requests.find((candidate) => candidate.unblocks.kind === "packet") ?? null;
  })();

  // One source of action truth. A retirement verdict wins over every stale
  // question below it; lifecycle contradictions win over completion labels;
  // only a complete canonical request can become a decision.
  const nextAction: PacketNextAction = isRetired(header.lifecycle)
    ? { kind: "none", reason: header.lifecycle === "parked" ? "This work is paused." : "This work was stopped." }
    : lifecycleDrift
      ? { kind: "reconcile", reason: lifecycleDriftText({ lifecycle_effective: effectivelyDone ? "done" : "in_flight", lifecycle_stored: header.lifecycle }) }
      : header.lifecycle === "done" || header.lifecycle === "built"
        ? { kind: "none", reason: "This work is complete." }
        : selectedDecision
          ? { kind: "decide", decision: selectedDecision }
          : blockedTask
            ? { kind: "unblock", task: { id: blockedTask.id, title: blockedTask.title, reason: blocked.find((item) => item.id === blockedTask.id)?.reason ?? null } }
            : next
              ? { kind: "task", task: { id: next.id, title: next.title, status: next.kind as "todo" | "doing" } }
              : { kind: "none", reason: "No action is needed." };

  return {
    packet: path.basename(packetDir),
    spec_id: str(doc.spec_id) ?? path.basename(packetDir),
    title: header.title,
    lifecycle: header.lifecycle,
    lifecycle_stored: header.lifecycle,
    lifecycle_effective: effectivelyDone ? "done" : "in_flight",
    lifecycle_drift: lifecycleDrift,
    stage: header.stage,
    mode: header.mode,
    tasks: counts,
    proof,
    requirements: { total: specRequirements.size, covered: coveredReqs.size },
    requirement_priorities: requirementPriorities,
    completed,
    task_list: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, checksDone: t.checksDone, checksTotal: t.checksTotal, agreement: t.agreement, owner: t.owner, deps: t.dependsOn, refs: t.refs })),
    blocked,
    stale,
    open_questions: openQuestionTexts(specText),
    next_action: nextAction,
    decision_findings: decisionParse.findings,
    next,
    drift: { restamp },
    verdict,
    deep_checked: false,
  };
}
// File-reading entry point: the shared reader for single-packet views (asp
// status). The index (packetIndex.ts) prefers derivePacketStatusFromInputs so
// each packet's files are read and parsed once per run (cli-performance-v0 R-001).
export function derivePacketStatus(packetDir: string, options: DeriveOptions = {}): PacketStatus {
  const tasksPath = path.join(packetDir, "tasks.yaml");
  const specPath = path.join(packetDir, "spec.md");
  if (!existsSync(tasksPath)) throw new Error(`tasks.yaml missing in ${packetDir}`);
  if (!existsSync(specPath)) throw new Error(`spec.md missing in ${packetDir}`);

  return derivePacketStatusFromInputs(packetDir, {
    tasksDoc: parseYaml(readFileSync(tasksPath, "utf8")),
    specText: readFileSync(specPath, "utf8"),
  }, options);
}

// The frontmatter stamp is canonical; the ledger event supplies the reason.
// A hand-stamped packet with no event still renders (reason null) rather than
// erroring — the missing trail is itself legible.
function verdictReason(packetDir: string, state: string): { reason: string | null; at: string | null } {
  const record = latestVerdict(packetDir);
  if (record && record.state === state) return { reason: record.reason, at: record.at };
  return { reason: null, at: null };
}

function pad(label: string): string {
  return (label + "          ").slice(0, 11);
}

// Exported so the initiative brief (initiative-brief-v0 R-001) renders the same
// sentence as the CLI card instead of writing a second one. A projection that
// re-phrases the action is a second reader with extra steps.
export function nextActionText(action: PacketNextAction): string {
  switch (action.kind) {
    case "none":
      return `none — ${action.reason}`;
    case "reconcile":
      return action.reason;
    case "decide":
      return `decide — ${action.decision.question.prompt}`;
    case "unblock":
      return `unblock ${action.task.title}${action.task.reason ? ` (${action.task.reason})` : ""} · ${action.task.id}`;
    case "task":
      return `${action.task.title} · ${action.task.id}`;
  }
}

// One sentence naming both sides of a lifecycle contradiction (R-002). The
// word "drift" leads so the line is greppable with or without the glyph.
function lifecycleDriftText(s: Pick<PacketStatus, "lifecycle_effective" | "lifecycle_stored">): string {
  return s.lifecycle_effective === "done"
    ? `drift — lifecycle says ${s.lifecycle_stored ?? "(unset)"}, but every task is done and proven; record it: foo asp verdict <packet> done --reason <text>`
    : `drift — lifecycle says ${s.lifecycle_stored}, but the work is not proofs-complete; finish it or reopen with foo asp verdict <packet> active --reason <text>`;
}

// Deep checks (T-015): source-authority, work-evidence, and last meaningful
// learning, derived from a bounded scan of the event ledger. Read-only and
// metadata-only — it prints event types, subjects, times, and authored
// summaries, never file contents, raw prompts, or secrets (C-003).
export interface DeepStatus {
  source_authority: string;
  work_evidence: string;
  last_learning: string | null;
}

const DEEP_SCAN_LIMIT = 2000;
const SECRET_HINT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|(?:password|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S{8,})/i;

function redact(text: string): string {
  return SECRET_HINT.test(text) ? "[redacted: looked like a secret]" : text;
}

function deriveDeep(packetDir: string): DeepStatus {
  const eventsPath = path.join(packetDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    return { source_authority: "no event ledger", work_evidence: "no event ledger", last_learning: null };
  }

  const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const scanned = lines.slice(-DEEP_SCAN_LIMIT);
  const events: Array<Record<string, unknown>> = [];
  for (const line of scanned) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") events.push(e as Record<string, unknown>);
    } catch {
      // A malformed ledger line is skipped, not fatal — this is a read.
    }
  }

  const providers = new Set<string>();
  let sourceSignals = 0;
  let workEvidence = 0;
  let latest: { time: number; type: string; subject: string; summary: string } | null = null;

  for (const e of events) {
    const type = String(e.type ?? "");
    const subject = String(e.subject ?? "");
    const data = asRecord(e.data);

    if (/source|external|record|observ|synced/i.test(type) || "provider" in data || "synced_at" in data || "observed_at" in data) {
      sourceSignals += 1;
      const provider = str(data.provider) ?? str(data.source);
      if (provider) providers.add(provider);
    }
    if (/code\.changed|pr_merged|status_changed|work\./i.test(type)) workEvidence += 1;

    const summary = str(data.summary);
    if (summary && type !== "cli_usage") {
      const t = Date.parse(String(e.time ?? "")) || 0;
      if (!latest || t >= latest.time) latest = { time: t, type, subject, summary };
    }
  }

  const source_authority =
    sourceSignals === 0
      ? "no source-authority signals in the ledger"
      : `${sourceSignals} source signal(s)${providers.size > 0 ? ` from: ${[...providers].sort().join(", ")}` : ""}`;
  const work_evidence =
    workEvidence === 0 ? "no work-evidence events in the ledger" : `${workEvidence} work-evidence event(s) (status changes, code changes, merged work)`;
  const last_learning = latest
    ? `${latest.type}${latest.subject ? ` (${latest.subject})` : ""}: ${redact(latest.summary).slice(0, 140)}`
    : null;

  return { source_authority, work_evidence, last_learning };
}


function renderText(s: PacketStatus, deepRequested: boolean, deep: DeepStatus | null, glyphs: boolean): string {
  const lines: string[] = [];
  lines.push(`${s.packet}  ·  ${s.spec_id}`);
  const meta = [s.lifecycle && `lifecycle ${s.lifecycle}`, s.stage && `stage ${s.stage}`, s.mode && `mode ${s.mode}`]
    .filter(Boolean)
    .join(" · ");
  if (s.title || meta) lines.push(`${s.title ?? ""}${s.title && meta ? " — " : ""}${meta}`.trim());
  lines.push("");

  // A retirement verdict leads the card: the packet's headline truth is "we
  // decided not to do this (yet)", not its task counts.
  if (s.verdict) {
    const state = s.verdict.state === "killed" ? "killed" : "parked";
    const when = s.verdict.at ? ` (${s.verdict.at.slice(0, 10)})` : "";
    lines.push(`${pad("Verdict")}${withGlyph(state, `${state}${when} — ${s.verdict.reason ?? "no reason recorded in the ledger"}`, glyphs)}`);
    lines.push("");
  }

  // Task-level and spec-level progress stay on separate lines (R-019); no percentages.
  lines.push(
    `${pad("Tasks")}${withGlyph("claimed", `${s.tasks.done} ${CLAIMED_HUMAN_LABEL}`, glyphs)} · ${withGlyph("doing", `${s.tasks.doing} doing`, glyphs)} · ${withGlyph("blocked", `${s.tasks.blocked} blocked`, glyphs)} · ${withGlyph("todo", `${s.tasks.todo} todo`, glyphs)}   (${s.tasks.total} total)`,
  );
  lines.push(`${pad("Proof")}${withGlyph("proven", `${s.proof.checks_done} of ${s.proof.checks_total} checks proven`, glyphs)}`);
  // 0-of-N renders loudly (packet-grammar-v1 R-009): a packet whose tasks
  // reference none of its requirements is drift, not a quiet statistic. The
  // silent "0 of 0" this line used to show for unparsed formats is extinct —
  // the grammar's tolerant read gives every packet a real denominator.
  lines.push(
    s.requirements.total > 0
      ? s.requirements.covered === 0
        ? `${pad("Spec")}${withGlyph("drift", `0 of ${s.requirements.total} requirements covered — no task references any requirement yet`, glyphs)}`
        : `${pad("Spec")}${s.requirements.covered} of ${s.requirements.total} requirements covered by a task`
      : `${pad("Spec")}no R-numbered requirements found`,
  );
  lines.push("");

  lines.push(`${pad("Completed")}${s.completed.length > 0 ? s.completed.join(" ") : "none yet"}`);
  if (s.blocked.length === 0) {
    lines.push(`${pad("Blocked")}none`);
  } else {
    s.blocked.forEach((b, i) => {
      const text = `${b.id} ${b.title}${b.reason ? ` — ${b.reason}` : ""}`;
      lines.push(`${pad(i === 0 ? "Blocked" : "")}${withGlyph("blocked", text, glyphs)}`);
    });
  }
  if (s.stale.length === 0) {
    lines.push(`${pad("Review")}no stale suggested/discovered tasks`);
  } else {
    lines.push(`${pad("Review")}${s.stale.length} ${s.stale.length === 1 ? "task" : "tasks"} awaiting review:`);
    for (const r of s.stale) {
      const text = `${r.id} (${r.agreement})${r.overdue ? " — overdue" : ""} ${r.title}`;
      lines.push(`${pad("")}${r.overdue ? withGlyph("drift", text, glyphs) : text}`);
    }
  }

  // Lifecycle drift (packet-lifecycle-truth-v0 R-002): the header contradicts
  // the derived truth. The restamp nudge (draft + all done) keeps its original
  // wording; other contradictions name both states and the governed way out.
  lines.push(
    s.drift.restamp
      ? `${pad("Drift")}${withGlyph("drift", "header says draft, but all tasks are done — restamp the lifecycle", glyphs)}`
      : s.lifecycle_drift
        ? `${pad("Drift")}${withGlyph("drift", lifecycleDriftText(s), glyphs)}`
        : `${pad("Drift")}none`,
  );

  if (s.open_questions.length > 0) {
    const actionable = s.next_action.kind === "decide";
    const label = actionable
      ? `${s.open_questions.length} saved · 1 decision needs your input`
      : `${s.open_questions.length} saved for reference · not blocking`;
    lines.push(`${pad("Questions")}${actionable ? withGlyph("needs_input", label, glyphs) : label}`);
    for (const q of s.open_questions) lines.push(`${pad("")}- ${q}`);
  } else {
    lines.push(`${pad("Questions")}none saved`);
  }

  lines.push("");
  lines.push(`${pad("Next")}${nextActionText(s.next_action)}`);

  if (deepRequested && deep) {
    lines.push(`${pad("Source")}${deep.source_authority}`);
    lines.push(`${pad("Evidence")}${deep.work_evidence}`);
    lines.push(`${pad("Learning")}${deep.last_learning ?? "no meaningful learning recorded yet"}`);
  } else {
    lines.push(`${pad("Deep")}source-authority, work-evidence, last learning — not yet checked (run with --deep)`);
  }
  lines.push("");
  return lines.join("\n");
}

// Rich (TTY) view (T-016): the same derived object as renderText, laid out as a
// scannable progress card — per-task table with status glyphs, proportional
// bars, and the next decision called out. Color is additive and never the only
// signal (every status carries a glyph and a word), so the view degrades
// cleanly with NO_COLOR, a dumb TERM, or a pipe. Still no percent-complete
// (R-019): bars encode proportion, never a number.
type Tone = "ok" | "active" | "bad" | "warn" | "muted" | "bold" | "accent";
type Paint = Record<Tone, (s: string) => string>;

// Glyphs are chosen for screen-reader and terminal-font portability (✓/✗ are
// widely spoken and have braille mappings; ●/○ are a filled/empty in-progress
// pair; × reads as "times"). The word is always load-bearing — color and glyph
// are additive, never the sole carrier of a status.
const STATUS_META: Record<TaskStatus, { glyph: string; label: string; tone: Tone }> = {
  done: { glyph: "✓", label: CLAIMED_HUMAN_LABEL, tone: "ok" },
  doing: { glyph: "●", label: "doing", tone: "active" },
  blocked: { glyph: "✗", label: "blocked", tone: "bad" },
  todo: { glyph: "○", label: "todo", tone: "muted" },
  dropped: { glyph: "×", label: "dropped", tone: "muted" },
};

function makePaint(color: boolean): Paint {
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    ok: wrap("32"),
    active: wrap("36"),
    bad: wrap("31"),
    warn: wrap("33"),
    muted: wrap("2"),
    bold: wrap("1"),
    accent: wrap("1;36"),
  };
}

function bar(done: number, total: number, p: Paint, tone: Tone, width = 16): string {
  if (total <= 0) return p.muted("░".repeat(width));
  let filled = Math.round((done / total) * width);
  if (done > 0 && filled === 0) filled = 1;
  if (done < total && filled === width) filled = width - 1;
  filled = Math.max(0, Math.min(width, filled));
  const empty = width - filled;
  return `${p[tone]("█".repeat(filled))}${empty > 0 ? p.muted("░".repeat(empty)) : ""}`;
}

function renderRich(s: PacketStatus, opts: { color: boolean; deep: boolean; bars: boolean }): string {
  const p = makePaint(opts.color);
  const out: string[] = [];

  // One fixed-width left label column so every value lands on the same edge.
  const W = 10;
  const field = (label: string, tone: Tone = "bold"): string => p[tone](label.padEnd(W));
  // Bars are decorative (R-019 forbids a number) and read as repeated noise to a
  // screen reader, so they render only on a real terminal; a pipe / --plain omits
  // them. Truncation hides text behind an off-screen ellipsis, so it too applies
  // only on a TTY where width is bounded — piped output stays whole.
  const barCell = (done: number, total: number, tone: Tone): string => (opts.bars ? `${bar(done, total, p, tone)}  ` : "");
  const clip = (text: string, n = 84): string => (opts.bars && text.length > n ? `${text.slice(0, n - 1)}…` : text);

  // Plain-first (jargon-supply-chain-v0 R-002): the human name leads the card;
  // machine identifiers ride muted at the end of the line, never bold-first.
  out.push(`${p.bold(s.title ?? s.packet)} ${p.muted("·")} ${p.muted(`${s.packet} · ${s.spec_id}`)}`);
  const meta = [s.lifecycle && `lifecycle ${s.lifecycle}`, s.stage && `stage ${s.stage}`, s.mode && `mode ${s.mode}`]
    .filter(Boolean)
    .join(" · ");
  if (meta) out.push(p.muted(meta));
  out.push("");

  // Summary drops zero-count categories (so an at-risk packet never reads as
  // complete) and surfaces blocked in red with the `!` token asp index uses.
  const counts: string[] = [`${s.tasks.done} ${CLAIMED_HUMAN_LABEL}`];
  if (s.tasks.doing) counts.push(`${s.tasks.doing} doing`);
  if (s.tasks.blocked) counts.push(p.bad(`! ${s.tasks.blocked} blocked`));
  if (s.tasks.todo) counts.push(`${s.tasks.todo} todo`);
  if (s.tasks.dropped) counts.push(p.muted(`${s.tasks.dropped} dropped`));
  out.push(`  ${field("Tasks")}${barCell(s.tasks.done, s.tasks.total, "ok")}${counts.join(" · ")}  ${p.muted(`(${s.tasks.total} total)`)}`);
  out.push(`  ${field("Proof")}${barCell(s.proof.checks_done, s.proof.checks_total, "active")}${s.proof.checks_done} of ${s.proof.checks_total} checks proven`);
  out.push(
    s.requirements.total > 0
      ? `  ${field("Spec")}${barCell(s.requirements.covered, s.requirements.total, "active")}${s.requirements.covered} of ${s.requirements.total} requirements covered`
      : `  ${field("Spec")}${p.muted("no R-numbered requirements found")}`,
  );
  out.push("");

  // The decision this card exists to drive sits directly under the summary, in
  // the only accent treatment, above the task detail (principal-designer P0).
  // A retired packet's decision is already made — the verdict replaces Next.
  if (s.verdict) {
    const state = s.verdict.state === "killed" ? "killed" : "parked";
    const glyph = glyphFor(state as FooState, true);
    out.push(
      `  ${field("Verdict", "warn")}${p.bold(`${glyph} ${state}`)} ${p.muted("—")} ${clip(s.verdict.reason ?? "no reason recorded in the ledger")}`,
    );
  } else {
    const tone: Tone = s.next_action.kind === "none" ? "muted" : s.next_action.kind === "unblock" || s.next_action.kind === "reconcile" ? "warn" : "accent";
    out.push(`  ${field("Next", tone)}${p[tone](`→ ${clip(nextActionText(s.next_action))}`)}`);
  }
  out.push("");

  if (s.task_list.length === 0) {
    out.push(`  ${p.muted("no tasks in tasks.yaml")}`);
  } else {
    for (const t of s.task_list) {
      const m = STATUS_META[t.status] ?? STATUS_META.todo;
      const title = m.tone === "muted" ? p.muted(t.title) : t.title;
      out.push(`  ${p[m.tone](m.glyph)} ${p[m.tone](m.label.padEnd(7))}  ${title} ${p.muted(`· ${t.id}`)}`.trimEnd());
    }
  }

  // Exceptions the table can't carry — one line each, same aligned column, shown
  // only when non-empty. Full text always lives in --plain / --json and spec.md.
  const exceptions: string[] = [];
  for (const b of s.blocked) {
    exceptions.push(`  ${field("Blocked", "bad")}${clip(`${b.title}${b.reason ? ` — ${b.reason}` : ""}`)} ${p.muted(`· ${b.id}`)}`);
  }
  if (s.stale.length > 0) {
    const tail = s.stale.map((r) => `${r.id} (${r.agreement}${r.overdue ? ", overdue" : ""})`).join(", ");
    exceptions.push(`  ${field("Review", "warn")}${s.stale.length} awaiting review ${p.muted(`· ${tail}`)}`);
  }
  if (s.open_questions.length > 0) {
    const word = s.open_questions.length === 1 ? "question" : "questions";
    const actionable = s.next_action.kind === "decide";
    exceptions.push(
      `  ${field("Questions", actionable ? "warn" : "muted")}${s.open_questions.length} saved ${word} ${p.muted(actionable ? "· 1 needs your input" : "· reference only")}`,
    );
  }
  // Lifecycle drift rides the exceptions column on the rich card too (R-002) —
  // the quick view must not read healthier than the text/plain view.
  if (s.lifecycle_drift) {
    exceptions.push(
      `  ${field("Drift", "warn")}${clip(
        s.lifecycle_effective === "done"
          ? `lifecycle says ${s.lifecycle_stored ?? "(unset)"}, work proven done — foo asp verdict <packet> done`
          : `lifecycle says ${s.lifecycle_stored}, work not proofs-complete`,
      )}`,
    );
  }
  if (exceptions.length > 0) {
    out.push("");
    out.push(...exceptions);
  }

  out.push("");
  // The rich card is the quick view; --deep renders the detailed text audit.
  out.push(`  ${field("Deep", "muted")}${p.muted("source-authority, work-evidence, last learning — run asp status --deep")}`);
  out.push("");
  return out.join("\n");
}

export interface RenderOptions {
  json?: boolean;
  deep?: boolean;
  rich?: boolean;
  color?: boolean;
  bars?: boolean;
  html?: boolean;
  now?: Date;
  glyphs?: boolean;
}

export function renderAspStatus(packetDir: string, options: RenderOptions = {}): string {
  const status = derivePacketStatus(packetDir, { now: options.now });
  const deep = options.deep === true ? deriveDeep(packetDir) : null;
  if (deep) status.deep_checked = true;
  if (options.json) {
    return `${JSON.stringify({ schema_version: PACKET_STATUS_SCHEMA_VERSION, ...status, ...(deep ? { deep } : {}) }, null, 2)}\n`;
  }
  if (options.html) {
    return renderStatusHtml(status);
  }
  // --deep is the detailed audit; render it as text (with the deep findings)
  // rather than the quick rich card.
  if (options.rich && !deep) {
    return renderRich(status, {
      color: options.color === true,
      deep: options.deep === true,
      // Bars and truncation are TTY-only; default to the color decision (a real
      // terminal) but let an explicit caller force them for capture.
      bars: options.bars ?? options.color === true,
    });
  }
  return renderText(status, options.deep === true, deep, options.glyphs === true);
}

// Single-packet HTML progress card (the visual sibling of the rich TTY card and
// the cross-packet `asp index --html`). Server-rendered and self-contained: no
// client JS, so it degrades to readable semantic HTML, reuses the asp-index
// design tokens (Atkinson Hyperlegible, OKLCH), and carries the design-swarm +
// Impeccable findings — Next is the dominant call-out linked to its list row,
// every status shows a word (never color/glyph alone), the task list is a fixed
// grid, accent side-bars are dropped (an AI tell), and `--muted` is darkened for
// ≥4.5:1 contrast. No percent-complete (R-019): bars encode proportion only.
const HTML_STATUS_META: Record<TaskStatus, { glyph: string; word: string; cls: string }> = {
  done: { glyph: "✓", word: CLAIMED_HUMAN_LABEL, cls: "d" },
  doing: { glyph: "●", word: "doing", cls: "wip" },
  blocked: { glyph: "✗", word: "blocked", cls: "b" },
  todo: { glyph: "○", word: "todo", cls: "o" },
  dropped: { glyph: "×", word: "dropped", cls: "x" },
};

function escHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// One filled segment over the track background — no abutting zero-flex sliver to
// read as a glitch near 100%. aria-hidden: the adjacent value text is the number.
function pbarHtml(done: number, total: number, colorVar: string): string {
  // The card refuses a percent-complete number by design; this bar is a coarse
  // proportion of discrete counts, not a precise metric. Round to one decimal so
  // the markup never ships a long binary float (e.g. 82.35294117647058%).
  const raw = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const fill = Math.round(raw * 10) / 10;
  return `<div class="pbar" aria-hidden="true"><i style="width:${fill}%;background:var(${colorVar})"></i></div>`;
}

export function renderStatusHtml(s: PacketStatus): string {
  const title = s.title ?? s.packet;
  // Summary line drops zero-count categories and leads with in-flight work.
  const counts: string[] = [];
  if (s.tasks.doing) counts.push(`${s.tasks.doing} doing`);
  counts.push(`${s.tasks.done} ${CLAIMED_HUMAN_LABEL}`);
  if (s.tasks.blocked) counts.push(`${s.tasks.blocked} blocked`);
  if (s.tasks.todo) counts.push(`${s.tasks.todo} todo`);
  if (s.tasks.dropped) counts.push(`${s.tasks.dropped} dropped`);
  const countLine = counts.join(" · ");

  const tags = [s.lifecycle && `lifecycle ${s.lifecycle}`, s.stage && `stage ${s.stage}`, s.mode && `mode ${s.mode}`]
    .filter((x): x is string => Boolean(x))
    .map((t) => `<span class="tag">${escHtml(t)}</span>`)
    .join("");

  const nextId = s.next?.id;
  const tasks = s.task_list
    .map((t) => {
      const m = HTML_STATUS_META[t.status] ?? HTML_STATUS_META.todo;
      // Mark the row the Next call-out points at, so the two read as one object.
      const mark = t.id === nextId ? " next" : "";
      return `<li class="tk ${m.cls}${mark}"><span class="g ${m.cls}" aria-hidden="true">${m.glyph}</span><span class="tid">${escHtml(t.id)}</span><span class="tst">${m.word}</span><span class="tt">${escHtml(t.title)}</span></li>`;
    })
    .join("");

  const nextValue =
    s.next_action.kind === "task"
      ? `<span class="next-t">${escHtml(s.next_action.task.title)}</span><span class="next-id">${escHtml(s.next_action.task.id)}</span>`
      : `<span class="next-t">${escHtml(nextActionText(s.next_action))}</span>`;
  const next = `<h2 class="next-k">Next</h2><p class="next-v">${nextValue}</p>`;

  const exc: string[] = [];
  if (s.blocked.length > 0) {
    const items = s.blocked
      .map((b) => `<li><b>${escHtml(b.id)}</b> ${escHtml(b.title)}${b.reason ? ` <span class="muted">(${escHtml(b.reason)})</span>` : ""}</li>`)
      .join("");
    exc.push(`<div class="exc b"><h3 class="exc-k">Blocked</h3><ul class="exc-l">${items}</ul></div>`);
  }
  if (s.stale.length > 0) {
    const items = s.stale
      .map((r) => `<li><b>${escHtml(r.id)}</b> ${escHtml(r.title)} <span class="muted">(${escHtml(r.agreement)}${r.overdue ? ", overdue" : ""})</span></li>`)
      .join("");
    exc.push(`<div class="exc w"><h3 class="exc-k">Review</h3><ul class="exc-l">${items}</ul></div>`);
  }
  if (s.open_questions.length > 0) {
    const items = s.open_questions.map((q) => `<li>${escHtml(q)}</li>`).join("");
    const actionable = s.next_action.kind === "decide";
    exc.push(`<div class="exc ${actionable ? "w" : ""}"><h3 class="exc-k">Saved questions${actionable ? " · 1 needs your input" : " · reference only"}</h3><ul class="exc-l">${items}</ul></div>`);
  }
  const excHtml = exc.length > 0 ? `<section class="excs"><h2 class="sr">Needs attention</h2>${exc.join("")}</section>` : "";

  const spec =
    s.requirements.total > 0
      ? `<div class="chip"><div class="k">requirements</div><div class="v">${s.requirements.covered}<small>/${s.requirements.total}</small></div>${pbarHtml(s.requirements.covered, s.requirements.total, "--proof")}</div>`
      : `<div class="chip"><div class="k">requirements</div><div class="v">—<small> none</small></div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>foo · ${escHtml(s.packet)} progress</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap');
:root{--ink:oklch(0.205 0.012 25);--muted:oklch(0.418 0.014 25);--line:oklch(0.875 0.006 25);--line2:oklch(0.705 0.012 25);--bg:oklch(1 0 0);--surf:oklch(0.985 0.001 25);--surf2:oklch(0.967 0.002 25);--att:oklch(0.36 0.12 0);--att-soft:oklch(0.967 0.015 8);--proof:oklch(0.47 0.095 190);--wip:oklch(0.5 0.12 255);--bad:oklch(0.52 0.18 25);--warn:oklch(0.55 0.1 70);--warn-soft:oklch(0.96 0.03 82);--bad-soft:oklch(0.96 0.025 25);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ui:"Atkinson Hyperlegible",ui-sans-serif,system-ui,sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--surf);color:var(--ink);font-family:var(--ui);line-height:1.5;-webkit-font-smoothing:antialiased;}
.wrap{max-width:760px;margin:0 auto;padding:40px 24px 56px;}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);border:0;}
.muted{color:var(--muted);}
.mast{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.wm{font-size:13px;font-weight:700;color:var(--muted);letter-spacing:.02em;}
.wm b{color:var(--att);}
h1.ttl{font-size:25px;font-weight:700;letter-spacing:-0.01em;margin:5px 0 4px;line-height:1.2;}
.sub{margin:0;font-size:12.5px;color:var(--muted);font-family:var(--mono);}
.tags{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}
.tag{font-family:var(--mono);font-size:10.5px;font-weight:700;border:0.5px solid var(--line2);border-radius:5px;padding:3px 7px;color:var(--muted);white-space:nowrap;}
.chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:22px 0 0;}
.chip{background:var(--bg);border:0.5px solid var(--line);border-radius:9px;padding:12px 14px;}
.chip .k{font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;}
.chip .v{font-size:22px;font-weight:700;margin:3px 0 9px;}
.chip .v small{font-size:12px;font-weight:400;color:var(--muted);}
.pbar{height:8px;border-radius:3px;overflow:hidden;background:var(--line);margin-top:1px;}
.pbar i{display:block;height:100%;}
.nextcard{display:block;margin:22px 0 0;background:var(--att-soft);border:0.5px solid var(--line2);border-radius:9px;padding:15px 17px;}
.next-k{font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--att);text-transform:uppercase;letter-spacing:.05em;margin:0 0 5px;}
.next-v{margin:0;font-size:18px;font-weight:700;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;}
.next-id{font-family:var(--mono);font-size:13px;color:var(--att);}
.next-t{font-weight:400;}
.seclabel{font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:26px 0 8px;}
.tks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}
.tk{display:grid;grid-template-columns:1.4rem 6ch 8ch 1fr;align-items:center;gap:11px;padding:8px 6px;border-top:0.5px solid var(--line);font-size:14px;}
.tk:first-child{border-top:0;}
.tk.next{background:var(--att-soft);border-radius:7px;}
.g{width:19px;height:19px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:oklch(0.99 0.004 190);}
.g.d{background:var(--proof);}
.g.wip{background:var(--wip);}
.g.b{background:var(--bad);}
.g.o{background:transparent;border:1.5px solid var(--line2);color:var(--muted);}
.g.x{background:transparent;border:1.5px solid var(--line2);color:var(--muted);}
.tid{font-family:var(--mono);font-size:11.5px;font-weight:700;color:var(--muted);}
.tst{font-family:var(--mono);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;}
.tk.d .tst{color:var(--proof);}
.tk.wip .tst{color:var(--wip);}
.tk.b .tst{color:var(--bad);}
.tk.o .tst,.tk.x .tst{color:var(--muted);}
.tt{color:var(--ink);}
.tk.d .tt,.tk.x .tt{color:var(--muted);}
.tk.x .tt{text-decoration:line-through;}
.excs{margin-top:24px;display:flex;flex-direction:column;gap:10px;}
.exc{background:var(--bg);border:0.5px solid var(--line);border-radius:9px;padding:12px 15px;}
.exc.b{background:var(--bad-soft);}
.exc.w{background:var(--warn-soft);}
.exc-k{font-family:var(--mono);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin:0 0 7px;color:var(--ink);}
.exc-l{margin:0;padding-left:18px;font-size:13.5px;display:flex;flex-direction:column;gap:4px;}
.deep{margin:26px 0 0;font-size:12.5px;color:var(--muted);font-style:italic;}
.foot{margin:18px 0 0;font-family:var(--mono);font-size:10.5px;color:var(--muted);border-top:0.5px solid var(--line);padding-top:12px;}
@media (max-width:520px){.wrap{padding:28px 16px 40px;}.tags{justify-content:flex-start;}}
</style>
</head>
<body>
<main class="wrap">
<header class="mast">
<div>
<div class="wm">foo<b>.</b> packet progress</div>
<h1 class="ttl">${escHtml(title)}</h1>
<p class="sub">${escHtml(s.spec_id)} · derived from tasks.yaml</p>
</div>
<div class="tags">${tags || '<span class="tag">no header</span>'}</div>
</header>

<section class="chips">
<h2 class="sr">Progress</h2>
<div class="chip"><div class="k">tasks</div><div class="v">${s.tasks.done}<small>/${s.tasks.total} ${CLAIMED_HUMAN_LABEL}</small></div>${pbarHtml(s.tasks.done, s.tasks.total, "--proof")}</div>
<div class="chip"><div class="k">proof</div><div class="v">${s.proof.checks_done}<small>/${s.proof.checks_total} checks</small></div>${pbarHtml(s.proof.checks_done, s.proof.checks_total, "--proof")}</div>
${spec}
</section>

<section class="nextcard">${next}</section>

<h2 class="seclabel">Tasks <span class="muted">· ${countLine}</span></h2>
<ul class="tks">${tasks || '<li class="tk o"><span class="tt muted">no tasks in tasks.yaml</span></li>'}</ul>

${excHtml}

<p class="deep">Deep checks not yet run: source-authority, work-evidence, last meaningful learning.</p>
<p class="foot">generated by foo asp status · read-only, derived from ${escHtml(s.packet)}/tasks.yaml · no percent-complete by design</p>
</main>
</body>
</html>
`;
}
