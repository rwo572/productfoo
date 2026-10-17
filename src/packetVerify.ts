// Portable intent-verification verdict (intent-verification-verdict-v0).
//
// `foo asp verify` is the third leg of the packet read-side, complementing the
// two that already exist:
//   - `asp validate`  — is the packet well-formed? (structure & identity)
//   - `asp reconcile` — did we touch only files mapped to an agreed task?
//   - `asp verify`    — did we actually ship what we intended, with proof?
//
// The question this answers is the one Fiona Fung names as the new bottleneck
// once coding is cheap: "how do you know the experience you shipped is what you
// intended?" foo already carries the answer in the packet — every task's
// `done_when` checks each hold `{ id, text, done, proof }`. Verify reads those
// and renders a verdict over productfoo's signature distinction: done is a *claim*
// (🟡), proof is a *receipt* (✅). A task marked done whose acceptance checks
// are not actually met is *drift* (⚠️) — a false completion claim, the one case
// worth escalating.
//
// Cross-agent by construction: verify reads only packet artifacts (spec.md,
// tasks.yaml, events.jsonl) and emits a runtime-neutral verdict — JSON for
// machines, glyph-decorated text for humans. The build can happen in one
// coding harness and the verification in another; the verdict
// lives in the portable packet, never in a vendor's session. With `--record`
// the verdict is appended to events.jsonl as a `com.foo.intent.verified` event,
// so the proof becomes part of the same append-only ledger every runtime reads.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import { STATUS_GLYPHS, withGlyph } from "./statusGlyphs.js";
import { countByClass, type SeverityClass, type SeverityClassCounts } from "./severityClass.js";
import { requirementIds } from "./specSections.js";

export const VERIFY_SCHEMA_VERSION = "1.0";

// The event type emitted by `--record`. Deliberately not in the validator's
// AGENT_EVENT_TYPES set, so a verdict event needs no agent-identity ceremony and
// any runtime (human or agent) can write one.
export const VERIFY_EVENT_TYPE = "com.foo.intent.verified";

export type CheckState = "proven" | "claimed" | "open";
// Task/packet verdicts ordered worst-to-best for precedence math below.
export type Verdict = "drift" | "incomplete" | "claimed" | "proven";

export interface CheckVerdict {
  id: string;
  text: string;
  state: CheckState;
  proof: string | null;
}

export interface Finding {
  kind: "false_completion" | "unproven_claim" | "uncovered_requirement";
  severity: "high" | "medium" | "low";
  // Recoverability axis (bad-vs-sad-severity-v0), orthogonal to severity:
  // bad = unrecoverable (a false "done", a structurally unprovable requirement);
  // sad = recoverable (just add proof / finish the referencing task).
  class: SeverityClass;
  subject: string;
  summary: string;
  suggested_actions: string[];
  requires_human: boolean;
}

export interface TaskVerdict {
  id: string;
  title: string;
  status: string;
  agreement: string;
  verdict: Verdict;
  checks_total: number;
  checks_proven: number;
  checks: CheckVerdict[];
}

export interface RequirementVerdict {
  id: string;
  verdict: Verdict;
  task_ids: string[];
}

export interface VerifyReport {
  schema_version: string;
  spec_id: string | null;
  packet: string;
  intent: string | null;
  verdict: Verdict;
  tasks: { total: number; proven: number; claimed: number; incomplete: number; drift: number; dropped: number };
  checks: { total: number; proven: number; claimed: number; open: number };
  requirements: { total: number; proven: number; unproven: number };
  findings_by_class: SeverityClassCounts;
  task_verdicts: TaskVerdict[];
  requirement_verdicts: RequirementVerdict[];
  findings: Finding[];
  summary: string;
}

export interface VerifyOptions {
  packetDir: string;
  root: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// The intent is the contract we verify against: the prose under `## Intent`.
// We surface only the first paragraph so the verdict header shows what was
// promised without reprinting the whole section.
function parseIntent(specText: string): string | null {
  const lines = specText.split(/\r?\n/);
  let inSection = false;
  const para: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      inSection = /^##\s+Intent\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    if (line.trim() === "") {
      if (para.length > 0) break;
      continue;
    }
    if (line.trim().startsWith("<!--")) continue;
    para.push(line.trim());
  }
  return para.length > 0 ? para.join(" ") : null;
}


// A done_when check is proven only when it is both marked done AND carries a
// non-empty proof string — done is the claim, proof is the receipt.
function checkVerdict(raw: unknown): CheckVerdict {
  const dw = asRecord(raw);
  const id = str(dw.id) ?? "C-?";
  const text = str(dw.text) ?? "";
  const proof = str(dw.proof);
  const done = dw.done === true;
  const state: CheckState = !done ? "open" : proof ? "proven" : "claimed";
  return { id, text, state, proof };
}

function taskVerdictFrom(status: string, checks: CheckVerdict[]): Verdict {
  // A done task whose acceptance is not actually met is a false completion —
  // the dangerous case, surfaced as drift regardless of proof on other checks.
  if (status === "done") {
    if (checks.some((c) => c.state === "open")) return "drift";
    if (checks.some((c) => c.state === "claimed")) return "claimed";
    return "proven";
  }
  // Not-done tasks are simply unfinished work, never drift.
  return "incomplete";
}

// Worst-wins precedence for the single headline verdict. Drift (a false "done")
// outranks everything; an unfinished packet is "incomplete"; a fully-done but
// partly-unproven packet is "claimed"; all-done-and-proven is "proven".
const VERDICT_RANK: Record<Verdict, number> = { drift: 0, incomplete: 1, claimed: 2, proven: 3 };

function worst(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b;
}

export function verifyPacket(options: VerifyOptions): VerifyReport {
  const tasksPath = path.join(options.packetDir, "tasks.yaml");
  const specPath = path.join(options.packetDir, "spec.md");
  if (!existsSync(tasksPath)) throw new Error(`tasks.yaml missing in ${options.packetDir}`);
  if (!existsSync(specPath)) throw new Error(`spec.md missing in ${options.packetDir}`);

  const doc = asRecord(parseYaml(readFileSync(tasksPath, "utf8")));
  const specText = readFileSync(specPath, "utf8");
  const rawTasks = Array.isArray(doc.tasks) ? doc.tasks : [];

  const tasks = { total: 0, proven: 0, claimed: 0, incomplete: 0, drift: 0, dropped: 0 };
  const checks = { total: 0, proven: 0, claimed: 0, open: 0 };
  const findings: Finding[] = [];
  const taskVerdicts: TaskVerdict[] = [];
  // requirement id -> the worst verdict of any non-rejected task that refs it.
  const reqVerdict = new Map<string, Verdict>();
  const reqTasks = new Map<string, string[]>();

  for (const raw of rawTasks) {
    const t = asRecord(raw);
    const id = str(t.id);
    if (!id) continue;
    const status = str(t.status) ?? "todo";
    const title = str(t.title) ?? "";
    const agreement = str(t.agreement) ?? "agreed";

    // Dropped and rejected work is intentionally not part of the shipped intent;
    // count dropped for visibility but exclude it from the verdict math.
    if (status === "dropped") {
      tasks.total += 1;
      tasks.dropped += 1;
      continue;
    }

    const checkVerdicts = (Array.isArray(t.done_when) ? t.done_when : []).map(checkVerdict);
    for (const c of checkVerdicts) {
      checks.total += 1;
      checks[c.state] += 1;
    }
    const checksProven = checkVerdicts.filter((c) => c.state === "proven").length;
    const verdict = taskVerdictFrom(status, checkVerdicts);

    tasks.total += 1;
    tasks[verdict] += 1;

    if (verdict === "drift") {
      const open = checkVerdicts.filter((c) => c.state === "open").map((c) => c.id);
      findings.push({
        kind: "false_completion",
        severity: "high",
        // bad: a false "done" cannot be trusted until the check is actually met.
        class: "bad",
        subject: `task:${id}`,
        summary: `Task ${id} is marked done, but acceptance check(s) ${open.join(", ")} are not met. A "done" without met acceptance is a false completion claim.`,
        suggested_actions: [
          "satisfy the open done_when check(s) and add proof",
          "move the task back to doing until acceptance is met",
          "amend the done_when checks if they no longer reflect intent",
        ],
        requires_human: true,
      });
    } else if (verdict === "claimed") {
      const unproven = checkVerdicts.filter((c) => c.state === "claimed").map((c) => c.id);
      findings.push({
        kind: "unproven_claim",
        severity: "medium",
        // sad: recoverable — the work is done, it just needs a proof receipt.
        class: "sad",
        subject: `task:${id}`,
        summary: `Task ${id} is done but check(s) ${unproven.join(", ")} carry no proof. Done is a claim; proof is the receipt.`,
        suggested_actions: [
          "add a proof reference (test, run, link) to each unproven done_when check",
        ],
        requires_human: false,
      });
    }

    taskVerdicts.push({
      id,
      title,
      status,
      agreement,
      verdict,
      checks_total: checkVerdicts.length,
      checks_proven: checksProven,
      checks: checkVerdicts,
    });

    if (agreement !== "rejected") {
      const refs = Array.isArray(t.refs) ? t.refs.map(str).filter((x): x is string => x !== null) : [];
      for (const ref of refs) {
        reqVerdict.set(ref, worst(reqVerdict.get(ref) ?? "proven", verdict));
        reqTasks.set(ref, [...(reqTasks.get(ref) ?? []), id]);
      }
    }
  }

  // Requirement coverage: every requirement declared in spec.md, judged by the
  // worst verdict of the tasks that claim it. An unreferenced requirement has no
  // proving task, so it is unproven by definition.
  const specReqs = requirementIds(specText);
  const requirementVerdicts: RequirementVerdict[] = specReqs.map((rid) => {
    const v = reqVerdict.get(rid) ?? "incomplete";
    const taskIds = reqTasks.get(rid) ?? [];
    if (v !== "proven") {
      findings.push({
        kind: "uncovered_requirement",
        severity: taskIds.length === 0 ? "medium" : "low",
        // bad when nothing references it (structurally unprovable — needs a spec
        // or task change); sad when a referencing task just is not done yet.
        class: taskIds.length === 0 ? "bad" : "sad",
        subject: `requirement:${rid}`,
        summary:
          taskIds.length === 0
            ? `Requirement ${rid} is declared in spec.md but no task references it — it cannot be proven.`
            : `Requirement ${rid} is referenced by ${taskIds.join(", ")} but is not yet proven (${v}).`,
        suggested_actions:
          taskIds.length === 0
            ? ["add a task whose refs include this requirement, or drop the requirement"]
            : ["finish and prove the referencing task(s)"],
        requires_human: taskIds.length === 0,
      });
    }
    return { id: rid, verdict: v, task_ids: taskIds };
  });
  const reqProven = requirementVerdicts.filter((r) => r.verdict === "proven").length;

  // Headline verdict: worst over every counted task. An empty packet (no
  // non-dropped tasks) is "incomplete" — there is nothing proven yet.
  const counted = tasks.total - tasks.dropped;
  let verdict: Verdict = counted === 0 ? "incomplete" : "proven";
  for (const tv of taskVerdicts) verdict = worst(verdict, tv.verdict);

  const summary = ((): string => {
    switch (verdict) {
      case "drift":
        return `${tasks.drift} task(s) claim done without meeting acceptance — false completion. Resolve before trusting this packet.`;
      case "incomplete":
        return `Work is unproven: ${tasks.incomplete} task(s) not yet done. Nothing false, just unfinished.`;
      case "claimed":
        return `All work is done but ${tasks.claimed} task(s) lack proof. Add receipts to reach proven.`;
      case "proven":
        return `Every counted task is done and proven (${checks.proven}/${checks.total} checks). Shipped matches intent.`;
    }
  })();

  return {
    schema_version: VERIFY_SCHEMA_VERSION,
    spec_id: str(doc.spec_id),
    packet: path.relative(options.root, options.packetDir).split(path.sep).join("/"),
    intent: parseIntent(specText),
    verdict,
    tasks,
    checks,
    requirements: { total: specReqs.length, proven: reqProven, unproven: specReqs.length - reqProven },
    findings_by_class: countByClass(findings.map((f) => f.class)),
    task_verdicts: taskVerdicts,
    requirement_verdicts: requirementVerdicts,
    findings,
    summary,
  };
}

// Map a verdict to the locked status-glyph state (foo-status-glyphs-v0). The
// word always travels with the glyph, so the caller passes both through
// withGlyph; here we only choose the FooState.
export function verdictGlyphState(verdict: Verdict): "proven" | "claimed" | "todo" | "drift" {
  switch (verdict) {
    case "proven":
      return "proven";
    case "claimed":
      return "claimed";
    case "incomplete":
      return "todo";
    case "drift":
      return "drift";
  }
}

function verdictDisplayLabel(verdict: Verdict): string {
  return verdict === "claimed" ? STATUS_GLYPHS.claimed.label : verdict;
}

// Human view. Glyphs ride the human-only gate (glyphsEnabled): the caller passes
// glyphsOn=false for --json, NO_COLOR, and piped/non-TTY output, so no glyph ever
// reaches machine readers.
export function renderVerifyReport(report: VerifyReport, glyphsOn: boolean): string {
  const lines: string[] = [];
  const headline = `${verdictDisplayLabel(report.verdict).toUpperCase()} — ${report.summary}`;
  lines.push(withGlyph(verdictGlyphState(report.verdict), `verify ${report.packet}: ${headline}`, glyphsOn));
  if (report.intent) lines.push(`  Intent: ${report.intent}`);
  lines.push(
    `  Tasks: ${report.tasks.proven} proven · ${report.tasks.claimed} ${STATUS_GLYPHS.claimed.label} · ${report.tasks.incomplete} incomplete · ${report.tasks.drift} drift` +
      (report.tasks.dropped ? ` · ${report.tasks.dropped} dropped` : ""),
  );
  lines.push(`  Checks: ${report.checks.proven}/${report.checks.total} proven (${report.checks.claimed} ${STATUS_GLYPHS.claimed.label}, ${report.checks.open} open)`);
  if (report.requirements.total > 0) {
    lines.push(`  Requirements: ${report.requirements.proven}/${report.requirements.total} proven`);
  }

  const interesting = report.task_verdicts.filter((t) => t.verdict !== "proven");
  if (interesting.length > 0) {
    lines.push("");
    lines.push("  Unproven tasks:");
    for (const t of interesting) {
      lines.push(
        `    ${withGlyph(verdictGlyphState(t.verdict), `${verdictDisplayLabel(t.verdict).padEnd(20)} ${t.id}`, glyphsOn)} ${t.title} (${t.checks_proven}/${t.checks_total} checks proven)`,
      );
    }
  }

  if (report.findings.length > 0) {
    lines.push("");
    lines.push(
      `  Findings (${report.findings.length}): ${report.findings_by_class.bad} bad (unrecoverable) · ${report.findings_by_class.sad} sad (recoverable)`,
    );
    // bad before sad: fix-now ahead of clean-up.
    const ordered = [...report.findings].sort((a, b) => (a.class === b.class ? 0 : a.class === "bad" ? -1 : 1));
    for (const f of ordered) {
      lines.push(`    [${f.class}/${f.severity}] ${f.summary}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
