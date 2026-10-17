// evidence-intake-loop-v0 — turn shipped product decisions into enforced,
// agent-readable standards. A governed, read-only sweep over APPROVED GitHub
// PRs and Linear issues extracts decision evidence (the *why* living in review
// comments and issue threads), suggests the narrowest enforcement route per
// candidate, and emits ONE pending review packet. Automation ends at the
// packet: no standard changes without a human disposition, and every accepted
// disposition appends a provenance-carrying decision-log event.
//
// Ownership (conflict-1 resolution, 2026-07-06): this module is the single
// governed-sweep engine; coding-agent-pm-enhancements T-004 (channel-scour /
// backlog-triage) and T-005 (replay-the-week) are satisfied by routing modes
// over this engine, not by their own sweeps.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { approvalStates, minimizeSummary, sourceKey, type SourceId } from "./sourceIngress.js";
import { appendEvent, updateTask } from "./packetWrite.js";
import { readJson } from "./jsonFile.js";
import { flagValue, hasFlag } from "./cliArgs.js";
import { markFailure } from "./errorTaxonomy.js";

// A malformed evidence invocation returns exit 1 with a usage line (not a throw),
// so it must mark itself usage_error — otherwise the top-level writer sees a
// codeless nonzero exit and files it as a command_error crash.
function usageFail(output: string): { output: string; exitCode: number } {
  markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: output.trim() });
  return { output, exitCode: 1 };
}

// The fixture/live shape handed in by the runtime's read-only selectors
// (github:<pr-url> / linear:<issue-url> — same MCP-first, fixture-fallback
// pattern as asp reconcile). The engine never fetches; it is handed evidence.
export interface SweepSource {
  source_id: SourceId; // must be approved on the governing packet
  source_type: "github_pr" | "linear_issue";
  url: string;
  title?: string;
  /** review comments / issue thread bodies, in order */
  comments: string[];
}

export type SuggestedRoute = "guidance" | "lint" | "example" | "eval" | "no-change";

export interface Candidate {
  id: string;
  summary: string; // PII-minimized
  source_url: string;
  source_type: SweepSource["source_type"];
  suggested_route: SuggestedRoute;
  rationale: string;
}

// Decision-evidence heuristic: a comment is a candidate when it states a
// durable rule or decision, not a one-off nit.
const DECISION_SIGNAL = /\b(?:we decided|going forward|from now on|always|never|must|the rule is|our convention|as a standard|standardize)\b|\bdecisions?:/i;

// Route the candidate to the NARROWEST enforcement layer (R-002):
// deterministic-shaped evidence → lint; verifiable-outcome → eval;
// demonstrable-pattern → example; judgment-shaped → guidance. The route is a
// signal — inspectable, overridable at disposition, never auto-applied.
export function suggestRoute(text: string): { route: SuggestedRoute; rationale: string } {
  if (/\b(regex|naming|prefix|suffix|import order|format(ting)?|casing|file name|must match)\b/i.test(text)) {
    return { route: "lint", rationale: "deterministic-shaped: mechanically checkable pattern (narrowest layer)" };
  }
  if (/\b(test|assert|verif|measure|coverage|benchmark|eval)\b/i.test(text)) {
    return { route: "eval", rationale: "verifiable-shaped: an observable outcome a check can re-run" };
  }
  if (/\b(example|like this|see how|pattern in|reference implementation)\b/i.test(text)) {
    return { route: "example", rationale: "demonstrable-shaped: best taught by a canonical example" };
  }
  if (/\b(prefer|should|tone|wording|judgment|taste|feel|when in doubt)\b/i.test(text)) {
    return { route: "guidance", rationale: "judgment-shaped: needs agent guidance, not a mechanical rule" };
  }
  if (DECISION_SIGNAL.test(text)) {
    return { route: "guidance", rationale: "durable decision without a mechanical shape: default to guidance" };
  }
  return { route: "no-change", rationale: "no durable decision signal — likely a one-off; propose nothing" };
}

// The sweep: refuse any unapproved source (fail-closed, same gate as claims),
// extract decision-shaped comments, minimize, and route.
export function sweepCandidates(governingPacketDir: string, sources: SweepSource[]): { candidates: Candidate[]; refused: Array<{ source_id: SourceId; reason: string }> } {
  const approvals = approvalStates(governingPacketDir);
  const candidates: Candidate[] = [];
  const refused: Array<{ source_id: SourceId; reason: string }> = [];
  let n = 0;
  for (const source of sources) {
    const state = approvals.get(sourceKey(source.source_id))?.state ?? "excluded";
    if (state !== "approved") {
      refused.push({ source_id: source.source_id, reason: `source not approved (state: ${state}) — sweep is fail-closed` });
      continue;
    }
    for (const comment of source.comments) {
      if (!DECISION_SIGNAL.test(comment)) continue;
      n += 1;
      const { route, rationale } = suggestRoute(comment);
      candidates.push({
        id: `E-${String(n).padStart(3, "0")}`,
        summary: minimizeSummary(comment).slice(0, 240),
        source_url: source.url,
        source_type: source.source_type,
        suggested_route: route,
        rationale,
      });
    }
  }
  return { candidates, refused };
}

// Emit the single pending review packet — the TERMINAL state of the automated
// phase (R-003). Each candidate is a task whose done_when is the human
// disposition; nothing here applies a standard.
export function emitPendingPacket(root: string, name: string, candidates: Candidate[], at: string): string {
  const relDir = name.includes("/") ? name : path.posix.join("specs", name);
  const packetDir = path.resolve(root, relDir);
  if (existsSync(path.join(packetDir, "spec.md"))) throw new Error(`refusing to overwrite existing packet: ${relDir}`);
  mkdirSync(packetDir, { recursive: true });
  const specId = path.basename(packetDir).replace(/-/g, "_");
  const isoDate = at.slice(0, 10);

  writeFileSync(
    path.join(packetDir, "spec.md"),
    [
      "---",
      `spec_id: ${specId}`,
      `title: Evidence intake — pending review (${isoDate})`,
      "mode: capability",
      "lifecycle: draft",
      "stage: shaping",
      "owner: product",
      "autonomy: human-in-loop",
      `updated: ${isoDate}`,
      "---",
      "",
      `# Evidence intake — pending review (${isoDate})`,
      "",
      "## Intent",
      "",
      "Candidates extracted by the governed evidence sweep. Every suggested route is a signal awaiting YOUR disposition (accept / override / reject) — nothing below is a standard until a human says so.",
      "",
      "## Requirements",
      "",
      ...candidates.map((c) => `- ${c.id}: [${c.suggested_route}] ${c.summary} — evidence: ${c.source_url}`),
      ...(candidates.length ? [] : ["- (no candidates this sweep)"]),
      "",
      "## Open Questions",
      "",
      "- Disposition each candidate: foo evidence disposition <this-packet> <E-xxx> --action accept|override|reject --by <you>",
      "",
    ].join("\n"),
  );

  const due = new Date(new Date(at).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const taskBlock = (c: Candidate): string[] => [
    `  - id: ${c.id}`,
    `    title: ${JSON.stringify(`[${c.suggested_route}] ${c.summary.slice(0, 80)}`)}`,
    "    status: todo",
    "    agreement: suggested",
    "    stage: shaping",
    "    refs: []",
    "    depends_on: []",
    "    owner: product",
    "    autonomy: human-in-loop",
    "    do:",
    `      - ${JSON.stringify(`Disposition: ${c.suggested_route} — ${c.rationale}`)}`,
    `      - ${JSON.stringify(`Evidence: ${c.source_url}`)}`,
    "    done_when:",
    `      - id: C-${c.id.slice(2)}`,
    `        text: ${JSON.stringify("A human dispositioned this candidate (accept/override/reject) with provenance.")}`,
    "        done: false",
    "        proof: null",
    "    completed: null",
    "    blocked: null",
    "    review:",
    "      owner: product",
    `      due: ${JSON.stringify(due)}`,
    "      stale_after_days: 7",
    "    extensions: {}",
  ];
  writeFileSync(
    path.join(packetDir, "tasks.yaml"),
    [
      `schema_version: "0.1"`,
      `spec_id: ${specId}`,
      `spec_ref: ${relDir}/spec.md`,
      `updated: ${JSON.stringify(at)}`,
      "defaults:",
      "  autonomy: human-in-loop",
      "  stale_after_days:",
      "    suggested: 7",
      "    discovered: 7",
      "ledger:",
      "  segment_order:",
      "    - events.jsonl",
      "tasks:",
      ...(candidates.length ? candidates.flatMap(taskBlock) : [
        "  - id: E-000",
        '    title: "No candidates this sweep (clean no-op)"',
        "    status: done",
        "    agreement: agreed",
        "    stage: shaping",
        "    refs: []",
        "    depends_on: []",
        "    owner: product",
        "    autonomy: human-in-loop",
        "    do:",
        '      - "Record the clean sweep."',
        "    done_when:",
        "      - id: C-000",
        '        text: "Sweep ran and found no durable decision candidates."',
        "        done: true",
        '        proof: "clean sweep"',
        "    completed:",
        `      at: ${JSON.stringify(at)}`,
        '      by: "foo-evidence-sweep"',
        '      summary: "clean no-op"',
        "      event: null",
        "    blocked: null",
        "    review:",
        "      owner: product",
        "      due: null",
        "      stale_after_days: 7",
        "    extensions: {}",
      ]),
      "",
    ].join("\n"),
  );

  const actor = { type: "agent", id: "foo-cli", provider: "foo", model: "deterministic", persona: "tool", skills: [], adapter: "cli", mode: "human-in-loop" };
  const sweepEvent = {
    specversion: "0.1",
    id: `evt_evidence_sweep_${Date.now()}`,
    source: "agent://foo/evidence-intake",
    type: "com.adaptivespec.evidence.sweep_emitted",
    subject: `packet:${relDir}`,
    time: at,
    actor,
    data: { candidates: candidates.length, terminal: "pending-review packet — automation ends here" },
    extensions: {},
  };
  // One suggested-task event per candidate: a suggested task without ledger
  // provenance is invalid by the packet contract.
  const suggestedEvents = candidates.map((c, i) => ({
    specversion: "0.1",
    id: `evt_evidence_candidate_${Date.now()}_${i}`,
    source: "agent://foo/evidence-intake",
    type: "com.adaptivespec.task.suggested",
    subject: `task:${c.id}`,
    time: at,
    actor,
    data: { suggested_route: c.suggested_route, rationale: c.rationale, evidence_url: c.source_url },
    extensions: {},
  }));
  writeFileSync(path.join(packetDir, "events.jsonl"), [sweepEvent, ...suggestedEvents].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return packetDir;
}

// --- Triage mode (cpe T-004: channel-scour + backlog-triage routine) ---------
// Same sweep, different routing target: instead of an enforcement layer, each
// candidate gets a priority bucket. Deterministic signals; the human re-orders
// at disposition like any other suggestion.
export type TriageBucket = "now" | "next" | "later";

export function suggestTriage(text: string): { bucket: TriageBucket; rationale: string } {
  if (/\b(blocker|blocking|urgent|sev-?[01]|outage|regression|broken|security)\b/i.test(text)) {
    return { bucket: "now", rationale: "urgency signal: blocking/regression/security language" };
  }
  if (/\b(customer|deal|revenue|churn|committed|deadline|launch)\b/i.test(text)) {
    return { bucket: "next", rationale: "commitment signal: customer/revenue/deadline language" };
  }
  return { bucket: "later", rationale: "no urgency or commitment signal — default to later" };
}

// --- Replay mode (cpe T-005: replay-the-week/month) ---------------------------
// A read-only window recap over a packet's events ledger: what happened, who
// decided what, what was proven. Report schema is typed and stable.
export interface ReplayReport {
  schema_version: "0.1";
  packet: string;
  since: string;
  events: number;
  by_type: Record<string, number>;
  decisions: Array<{ at: string; by: string; summary: string }>;
  proofs: Array<{ at: string; task: string }>;
}

export function replayWindow(packetDir: string, since: string): ReplayReport {
  const file = path.join(packetDir, "events.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : [];
  const byType: Record<string, number> = {};
  const decisions: ReplayReport["decisions"] = [];
  const proofs: ReplayReport["proofs"] = [];
  let count = 0;
  for (const line of lines) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    const time = String(evt.time ?? "");
    if (time < since) continue;
    count += 1;
    const type = String(evt.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;
    const data = (evt.data ?? {}) as Record<string, unknown>;
    if (type.includes("decision")) {
      decisions.push({ at: time, by: String((evt.actor as Record<string, unknown>)?.id ?? "unknown"), summary: String(data.summary ?? data.question ?? "").slice(0, 160) });
    }
    if (type.includes("task") && String(data.to ?? "") === "done") {
      proofs.push({ at: time, task: String(data.task ?? evt.subject ?? "") });
    }
  }
  return { schema_version: "0.1", packet: path.basename(packetDir), since, events: count, by_type: byType, decisions, proofs };
}

export type Disposition = "accept" | "override" | "reject";

// The human disposition (R-003): attributed, appended to the ledger with the
// evidence back-link. Accept (or override-with-route) proves the task; reject
// drops it. Overriding the route is first-class — the suggestion is a signal.
export function recordDisposition(
  packetDir: string,
  candidateId: string,
  opts: { action: Disposition; route?: SuggestedRoute; by: string; at?: string },
): { action: Disposition; route?: SuggestedRoute } {
  if (!opts.by.trim()) throw new Error("a disposition needs --by <who>");
  if (opts.action === "override" && !opts.route) throw new Error("override needs --route guidance|lint|example|eval|no-change");
  const tasks = readFileSync(path.join(packetDir, "tasks.yaml"), "utf8");
  const literalId = candidateId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const evidence = tasks.match(new RegExp(`id: ${literalId}[\\s\\S]*?Evidence: ([^\\\\"]+)`))?.[1] ?? "unknown";

  appendEvent({
    packetDir,
    type: "com.adaptivespec.evidence.disposition",
    actor: { type: "human", id: opts.by },
    data: {
      candidate: candidateId,
      action: opts.action,
      route: opts.route ?? null,
      evidence_url: evidence,
    },
  });
  updateTask({
    packetDir,
    taskId: candidateId,
    status: opts.action === "reject" ? "dropped" : "done",
    proof: opts.action === "reject" ? undefined : `human disposition: ${opts.action}${opts.route ? ` → ${opts.route}` : ""} by ${opts.by}; evidence: ${evidence}`,
    reason: opts.action === "reject" ? `rejected by ${opts.by}` : undefined,
    actor: { type: "human", id: opts.by },
  });
  return { action: opts.action, route: opts.route };
}

// --- CLI ------------------------------------------------------------------------

export function runEvidenceCommand(root: string, args: string[]): { output: string; exitCode: number } {
  const sub = args[0];
  const json = hasFlag(args, "--json");
  const flag = (name: string): string | undefined => flagValue(args, name);

  if (sub === "sweep") {
    const governing = args[1];
    const fixture = flag("--fixture");
    if (!governing || !fixture) return usageFail("usage: foo evidence sweep <governing-packet-dir> --fixture <sources.json> [--out <packet-name>] [--json]\n");
    const sources = readJson<SweepSource[]>(path.resolve(root, fixture));
    const governingDir = path.resolve(root, governing);
    const mode = flag("--mode") ?? "standards";
    let { candidates, refused } = sweepCandidates(governingDir, sources);
    if (mode === "triage") {
      // cpe T-004 routing mode: priority buckets instead of enforcement layers.
      candidates = candidates
        .map((c) => {
          const t = suggestTriage(c.summary);
          return { ...c, suggested_route: c.suggested_route, rationale: `[${t.bucket}] ${t.rationale}`, summary: `(${t.bucket}) ${c.summary}` };
        })
        .sort((a, b) => a.summary.localeCompare(b.summary));
    }
    const at = new Date().toISOString();
    const outName = flag("--out") ?? `evidence-review-${at.slice(0, 10)}`;
    const packetDir = emitPendingPacket(root, outName, candidates, at);
    if (json) return { output: `${JSON.stringify({ schema_version: "0.1", candidates, refused, packet: path.relative(root, packetDir) }, null, 2)}\n`, exitCode: 0 };
    const lines = [
      `evidence sweep — ${candidates.length} candidate(s), ${refused.length} source(s) refused (fail-closed)`,
      ...candidates.map((c) => `  ${c.id} [${c.suggested_route}] ${c.summary.slice(0, 90)} — ${c.source_url}`),
      ...refused.map((r) => `  refused: ${r.source_id.provider}/${r.source_id.connection_id} — ${r.reason}`),
      `Pending review packet: ${path.relative(root, packetDir)} (automation ends here — disposition each candidate)`,
    ];
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  if (sub === "replay") {
    const packet = args[1];
    if (!packet) return usageFail("usage: foo evidence replay <packet-dir> [--since <iso-date>] [--json]\n");
    const since = flag("--since") ?? new Date(Date.now() - 7 * 86400000).toISOString();
    const report = replayWindow(path.resolve(root, packet), since);
    if (json) return { output: `${JSON.stringify(report, null, 2)}\n`, exitCode: 0 };
    const lines = [
      `replay — ${report.packet} since ${report.since.slice(0, 10)}: ${report.events} event(s)`,
      ...Object.entries(report.by_type).map(([t, n]) => `  ${n}× ${t}`),
      ...report.decisions.map((d) => `  decision (${d.by}, ${d.at.slice(0, 10)}): ${d.summary}`),
      ...report.proofs.map((p) => `  proven: ${p.task} (${p.at.slice(0, 10)})`),
    ];
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  if (sub === "disposition") {
    const packet = args[1];
    const candidate = args[2];
    const action = flag("--action") as Disposition | undefined;
    const by = flag("--by") ?? "";
    if (!packet || !candidate || !action) return usageFail("usage: foo evidence disposition <pending-packet> <E-xxx> --action accept|override|reject [--route r] --by <who>\n");
    const result = recordDisposition(path.resolve(root, packet), candidate, { action, route: flag("--route") as SuggestedRoute | undefined, by });
    return { output: `Dispositioned ${candidate}: ${result.action}${result.route ? ` → ${result.route}` : ""} (attributed to ${by}; provenance on the ledger).\n`, exitCode: 0 };
  }

  return usageFail(`unknown evidence subcommand: ${sub ?? "(none)"}. Try: sweep [--mode standards|triage] | replay | disposition\n`);
}
