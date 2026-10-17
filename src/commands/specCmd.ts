// The spec-first front doors: spec start/from/nudge, shape, classify, roast,
// preview, learn, and the elicitation surface demo. These route work into
// skills and packets; the packet write itself lives in packetWrite.
import { readJson } from "../jsonFile.js";
import { GateBlock, UsageError } from "../errorTaxonomy.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { appendEvent, initPacket } from "../packetWrite.js";
import {
  acceptPanelFinding,
  buildReconcileSpecAfterReport,
  canonizeSpecAfter,
  type CanonizeResult,
  parseSpecFromArgs,
  type RecoveredIntent,
  runQaPanel,
  runSpecAfter,
  runSpecFrom,
  runSpecNudge,
  type PanelLens,
} from "../specAfter.js";
import type { BehaviorStory, ExtractionCoverage } from "../codeCatalog.js";
import { gitRunOrNull } from "../gitRun.js";
import { classifyWork, renderClassification } from "../riskClassify.js";
import {
  loadRoutingPolicy,
  resolveWorkflowLane,
  type WorkflowLane,
} from "../routingPolicy.js";
import { withGlyph } from "../statusGlyphs.js";
import { buildLinearCandidate, type LinearCandidate, parseLinearSource } from "../sourceIngress.js";
import { findUnrepresentedUserCorrections, proposeSpecPatch, renderPatchProposal } from "../packetCorrections.js";
import { detectElicitationSurface } from "../elicitationSurface.js";
import { defineQuestion } from "../questionModel.js";
import type { QuestionInput } from "../questionModel.js";
import { renderQuestion } from "../questionText.js";
import { flagValue, loadRegisteredSkills, registeredSkillPath, resolvePacketDir, ROOT } from "./shared.js";
import { costHeadline } from "./loop.js";
import { guardHumanSurface } from "../humanSurfaceEval.js";
import { researchRequestTopic } from "../researchGate.js";
import { SkillDeliveryError } from "../skillLocal.js";

type CompanionLens = "ponytail";

type SpecStartOptions = {
  requiredSkills: string[];
  request?: string;
  packetName?: string;
  companions: CompanionLens[];
};

type SpecRoute =
  | {
      kind: "interview-required";
      reason: string;
      nextSkill: "interview-me";
      triggers: string[];
    }
  | {
      kind: "product-shape-interview-required";
      reason: string;
      nextSkill: "product-shape-interview";
      triggers: string[];
    }
  | {
      kind: "full-loop";
      reason: string;
      nextSkill: "interview-me";
      triggers: string[];
    };

function parseCompanionLens(value: string | undefined): CompanionLens {
  if (!value) throw new UsageError("--companion requires a value", "E_BAD_FLAG");
  if (value !== "ponytail") throw new UsageError(`unsupported companion: ${value}. Supported companions: ponytail`, "E_BAD_FLAG");
  return value;
}

function renderCompanionLines(companions: CompanionLens[]): string[] {
  if (!companions.includes("ponytail")) return [];
  return [
    "Companion lens: Ponytail — if available, invoke it during implementation/review as advisory pressure for the smallest correct implementation; never let it override productfoo boundaries, validation, safety, accessibility, or clarity.",
  ];
}

function parseSpecStartArgs(args: string[]): SpecStartOptions {
  const required = ["interview-me", "spec-swarm"];
  const companions = new Set<CompanionLens>();
  let request: string | undefined;
  let packetName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--request") {
      const value = args[index + 1];
      if (!value) throw new UsageError("--request requires a value", "E_BAD_FLAG");
      request = value;
      index += 1;
      continue;
    }

    if (arg === "--packet") {
      const value = args[index + 1];
      if (!value) throw new UsageError("--packet requires a value", "E_BAD_FLAG");
      packetName = value;
      index += 1;
      continue;
    }

    if (arg === "--companion") {
      companions.add(parseCompanionLens(args[index + 1]));
      index += 1;
      continue;
    }

    if (arg === "--ponytail") {
      companions.add("ponytail");
      continue;
    }

    if (arg !== "--skill") throw new UsageError(`unknown spec start argument: ${arg}`, "E_BAD_FLAG");

    const skill = args[index + 1];
    if (!skill) throw new UsageError("--skill requires a value", "E_BAD_FLAG");
    required.push(skill);
    index += 1;
  }

  return {
    requiredSkills: [...new Set(required)],
    request,
    packetName,
    companions: [...companions],
  };
}

function matchingTriggers(text: string, patterns: Array<[string, RegExp]>): string[] {
  return patterns.flatMap(([label, pattern]) => (pattern.test(text) ? [label] : []));
}

function classifySpecStart(request: string | undefined): SpecRoute {
  if (!request) {
    return {
      kind: "full-loop",
      reason: "Default product/spec workflow.",
      nextSkill: "interview-me",
      triggers: [],
    };
  }

  const rewriteTriggers = matchingTriggers(request, [
    ["reimagine", /\breimagin(e|es|ed|ing)\b/i],
    ["rewrite", /\brewrit(e|es|ing|ten)\b/i],
    ["pivot", /\bpivot(s|ed|ing)?\b/i],
    ["agentic", /\bagentic\b/i],
    ["EA", /\bEA\b/i],
    ["delegation", /\bdelegat(e|es|ed|ing|ion)\b/i],
    ["identity", /\bidentity\b/i],
    ["approval", /\bapproval\b/i],
    ["outbound communication", /\boutbound\b|\bcommunicat(e|es|ed|ing|ion)\b/i],
  ]);

  const hasRewriteIntent = rewriteTriggers.some((trigger) =>
    ["reimagine", "rewrite", "pivot"].includes(trigger),
  );
  const hasProductShapeTrigger = rewriteTriggers.some((trigger) =>
    ["agentic", "EA", "delegation", "identity", "approval", "outbound communication"].includes(trigger),
  );

  if (hasRewriteIntent && hasProductShapeTrigger) {
    return {
      kind: "interview-required",
      reason: "Product-shape rewrite detected.",
      nextSkill: "interview-me",
      triggers: rewriteTriggers,
    };
  }

  const artifactTriggers = matchingTriggers(request, [
    ["wired artifact", /\bwired artifact\b/i],
    ["artifact", /\bartifact\b/i],
    ["simulate", /\bsimulat(e|es|ed|ing)\b/i],
    ["end-user experience", /\bend[- ]user experience\b/i],
    ["scenario prototype", /\bscenario prototype\b/i],
    ["workbench", /\bworkbench\b/i],
  ]);

  if (artifactTriggers.length > 0) {
    return {
      kind: "product-shape-interview-required",
      reason: "Artifact generation needs a packet-local Shape Brief before HTML or UI output.",
      nextSkill: "product-shape-interview",
      triggers: artifactTriggers,
    };
  }

  return {
    kind: "full-loop",
    reason: "Default product/spec workflow.",
    nextSkill: "interview-me",
    triggers: [],
  };
}

function renderTriggerLines(triggers: string[]): string[] {
  if (triggers.length === 0) return [];
  return ["", "Triggers:", ...triggers.map((trigger) => `- ${trigger}`)];
}

function renderSpecStart(workItem: string, options: SpecStartOptions, registeredSkills: Map<string, string>): string {
  const route = classifySpecStart(options.request);
  const requiredSkills = [...new Set([...options.requiredSkills, route.nextSkill])];

  for (const skill of requiredSkills) {
    registeredSkillPath(registeredSkills, skill);
  }

  const interviewPath = registeredSkillPath(registeredSkills, "interview-me");
  const swarmPath = registeredSkillPath(registeredSkills, "spec-swarm");

  if (route.kind === "interview-required") {
    return [
      `Product/spec work must pause for: ${workItem}`,
      "",
      `Routing: ${route.kind}`,
      `Reason: ${route.reason}`,
      ...renderTriggerLines(route.triggers),
      "",
      `Next skill: ${route.nextSkill}`,
      ...renderCompanionLines(options.companions),
      `Prompt: Use $${route.nextSkill} on this work item and request.${options.companions.length ? " Carry companion lenses forward only after productfoo captures the approved intake." : ""}`,
      "Gate: Do not edit spec.md, tasks.yaml, or artifacts until the interview produces an approved intake summary.",
      "",
    ].join("\n");
  }

  if (route.kind === "product-shape-interview-required") {
    const shapePath = registeredSkillPath(registeredSkills, "product-shape-interview");
    return [
      `Product/spec work must shape the artifact first for: ${workItem}`,
      "",
      `Routing: ${route.kind}`,
      `Reason: ${route.reason}`,
      ...renderTriggerLines(route.triggers),
      "",
      `Next skill: ${route.nextSkill} (${shapePath})`,
      ...renderCompanionLines(options.companions),
      `Prompt: Use $product-shape-interview on the packet before generating the wired artifact.${options.companions.length ? " Carry companion lenses forward only after the Shape Brief." : ""}`,
      "Boundary (B3): produce an approved Shape Brief before generating HTML, Build Previews, or scenario UI.",
      "",
    ].join("\n");
  }

  return [
    `Product/spec work must follow the full loop for: ${workItem}`,
    "",
    "Default caller: coding agent; users can state the work naturally and may run this manually when desired.",
    "Signals: run `foo asp validate` after packet edits and `foo asp reconcile` after implementation-relevant changes; both surface findings into the ledger, they do not block.",
    "",
    `1. Interview: interview-me (${interviewPath})`,
    "   Prompt: Use $interview-me on this work item.",
    "   Boundary (B3): for irreversible, agentic, or outbound-facing work, do not draft or edit the spec before the interview produces an approved intake summary. For lighter work, `foo spec` is the faster reflex.",
    "",
    ...renderCompanionLines(options.companions),
    ...(options.companions.length ? [""] : []),
    `2. Expert swarm: spec-swarm (${swarmPath})`,
    "   Prompt: Use $spec-swarm on the approved intake summary or draft spec.",
    "   Signal: ask expert lenses and source artifacts before escalating questions to the user.",
    "",
    "3. Packet validation: foo asp validate <packet-dir>",
    "   Signal: spec.md, tasks.yaml, and events.jsonl structural validation; advisory. `foo self check` blocks only on B1 safety and B2 spec identity.",
    "",
    "4. Packet reconciliation: foo asp reconcile <packet-dir> --git-diff",
    "   Signal: changed work maps to agreed tasks or surfaces a human-visible finding.",
    "",
    options.companions.length
      ? "Next: run the interview now; carry the swarm packet forward before implementation, then invoke companion lenses only as advisory build/review pressure."
      : "Next: run the interview now; carry the swarm packet forward before implementation.",
    "",
  ].join("\n");
}

export function runSpecCommand(root: string, command: string | undefined, workItem: string | undefined, args: string[]): string {
  if (!command) throw new UsageError("spec command missing", "E_COMMAND_MISSING");

  if (command === "from") {
    if (!workItem) throw new UsageError("target missing — usage: foo spec from <what-you-built>", "E_SPEC_WORK_MISSING");
    return runSpecFrom(root, workItem, args);
  }

  if (command === "nudge") {
    return runSpecNudge(root);
  }

  // V0b (spec-after-capture T-007/T-008/T-009): review-only QA panel, attributed
  // accept-as-known, and confirm-batch canonization into a reconcile-registered packet.
  if (command === "panel" || command === "canonize") {
    if (!workItem) throw new UsageError(`target missing — usage: foo spec ${command} <what-you-built>`, "E_SPEC_WORK_MISSING");
    // A revision beginning with "-" would be parsed by git as an option (audit
    // F9) — `git diff --output=<path>` alone writes the diff to an arbitrary
    // file. `--` cannot disambiguate here: inside `git diff` everything after
    // `--` is a pathspec, so the guarded form silently yields an empty diff
    // for every real revision. Refuse the shape instead.
    if (workItem.startsWith("-")) throw new UsageError(`revision must not begin with "-": ${workItem}`);
    // Strip canonize-only flags before reusing the spec-from parser.
    const passthrough: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--confirm-batch") continue;
      if (args[i] === "--packet" || args[i] === "--by") { i += 1; continue; }
      passthrough.push(args[i]);
    }
    const options = parseSpecFromArgs(passthrough);
    const diff = gitRunOrNull(["-C", root, "diff", `${workItem}~1..${workItem}`]) ?? gitRunOrNull(["-C", root, "diff", workItem]) ?? "";
    const report = runSpecAfter({ target: workItem, diff, consent: options.consent });
    const panel = runQaPanel(report);

    if (command === "panel") {
      if (options.json) return `${JSON.stringify(panel, null, 2)}\n`;
      const lines = [`QA panel (review-only, fixed lens set: ${panel.lenses.join(", ")}):`];
      for (const f of panel.findings) lines.push(`  ${f.id} [${f.lens}] ${f.severity === "hard-block" ? "HARD-BLOCK " : ""}${f.label}`);
      if (!panel.findings.length) lines.push("  (no findings)");
      if (panel.security_blocked) lines.push("Canonization is hard-blocked until a human accepts or resolves the security finding(s).");
      return `${lines.join("\n")}\n`;
    }

    const packetName = flagValue(args, "--packet");
    if (!packetName) throw new UsageError("foo spec canonize needs --packet <name>", "E_BAD_FLAG");
    const by = flagValue(args, "--by");
    const result = canonizeSpecAfter(root, report, panel, {
      packetName,
      confirmBatch: args.includes("--confirm-batch"),
      by,
      at: new Date().toISOString(),
    });
    if (options.json) return `${JSON.stringify({ schema_version: "0.1", ...result }, null, 2)}\n`;
    if (!result.canonized) {
      const lines = [`Not canonized: ${result.reason}`];
      if (result.agree_batch.length) {
        lines.push(`AGREE batch for human review (${result.agree_batch.length}):`);
        for (const p of result.agree_batch) lines.push(`  ${p.intent_ref} ↔ ${p.behavior_ref}: ${p.label}`);
      }
      return `${lines.join("\n")}\n`;
    }
    return `Canonized ${result.agree_batch.length} confirmed AGREE pair(s) + ${report.drift.filter((d) => d.category !== "UNREVIEWED").length} carried drift item(s) into ${result.packetDir}.\nRegistered with the reconcile loop: foo asp reconcile ${packetName.includes("/") ? packetName : `specs/${packetName}`}\n`;
  }

  if (command === "patch") {
    if (!workItem) throw new UsageError("usage: foo spec patch <packet-dir> --correction <text> [--json]", "E_PACKET_DIR_MISSING");
    const { packetDir } = resolvePacketDir(root, workItem);
    const correction = flagValue(args, "--correction") ?? "";
    const proposal = proposeSpecPatch(packetDir, correction);
    if (args.includes("--json")) return `${JSON.stringify(proposal, null, 2)}\n`;
    return renderPatchProposal(proposal);
  }

  if (command === "accept") {
    if (!workItem) throw new UsageError("usage: foo spec accept <packet-dir> --finding <F-xxx> --lens <lens> --label <text> --by <who> --reason <why>", "E_PACKET_DIR_MISSING");
    const { packetDir } = resolvePacketDir(root, workItem);
    const finding = flagValue(args, "--finding");
    const lens = flagValue(args, "--lens") as PanelLens | undefined;
    const label = flagValue(args, "--label") ?? "";
    const by = flagValue(args, "--by") ?? "";
    const reason = flagValue(args, "--reason") ?? "";
    if (!finding || !lens) throw new UsageError("foo spec accept needs --finding <F-xxx> and --lens <lens>", "E_BAD_FLAG");
    acceptPanelFinding(packetDir, { finding_id: finding, lens, label, by, reason, at: new Date().toISOString() });
    return `Accepted ${finding} as known (attributed to ${by}); recorded in the local event log at ${workItem}/events.jsonl.\n`;
  }

  if (command !== "start") throw new UsageError(`unknown spec command: ${command}`, "E_BAD_FLAG");
  if (!workItem) throw new UsageError("work-item missing — usage: foo spec start <work-item> [--request <text>] [--packet <name>]", "E_SPEC_WORK_MISSING");

  const options = parseSpecStartArgs(args);
  const handoff = renderSpecStart(workItem, options, loadRegisteredSkills(root));

  // Driver mode (asp-cli-lifecycle-v0 T-007): with --packet, spec start scaffolds
  // the packet via the shared init path and records a work.started event, then
  // prints the same routing handoff. The scaffold is an empty container — the
  // interview still fills the spec, so the B3 gate in the handoff still holds.
  if (!options.packetName) return handoff;

  const result = initPacket({ root, name: options.packetName });
  const rel = path.relative(root, result.packetDir).split(path.sep).join("/");
  const event = appendEvent({
    packetDir: result.packetDir,
    type: "com.adaptivespec.work.started",
    subject: `packet:${result.specId}`,
    data: { work_item: workItem, ...(options.request ? { request: options.request } : {}) },
  });

  return [
    `Scaffolded packet: ${rel} (spec_id ${result.specId})`,
    `Recorded work.started event: ${event.id}`,
    "The scaffold is an empty container — the interview below fills the spec.",
    "",
    handoff,
  ].join("\n");
}

// reconcile-anywhere-v0 T-004: the `foo reconcile --adopt` write path. Composes
// the existing spec-after machinery — build a spec-after report from the
// recovered PR intent, run the review-only QA panel, then canonize into a packet
// that passes `foo asp validate`. This is the ONLY write path in the reconcile
// flow (D-002); the default run writes zero files. Adopt is the explicit human
// opt-in, so it confirms the batch on the human's behalf; a quarantined secret in
// the PR text still hard-blocks canonization until a human clears it.
export function adoptReconcileIntent(
  root: string,
  opts: {
    target: string;
    recovered: RecoveredIntent;
    behavior: BehaviorStory[];
    coverage: ExtractionCoverage;
    packetName: string;
    by: string;
  },
): CanonizeResult {
  const report = buildReconcileSpecAfterReport({
    target: opts.target,
    recovered: opts.recovered,
    behavior: opts.behavior,
    coverage: opts.coverage,
    source: opts.target,
  });
  const panel = runQaPanel(report);
  return canonizeSpecAfter(root, report, panel, {
    packetName: opts.packetName,
    confirmBatch: true,
    by: opts.by,
    at: new Date().toISOString(),
  });
}

function parseRoastArgs(args: string[]): { artifact: string; mode: "auto" | "panel" | "single" } {
  let mode: "auto" | "panel" | "single" = "auto";
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--mode") {
      const value = args[index + 1];
      if (value !== "auto" && value !== "panel" && value !== "single") {
        throw new UsageError("--mode must be auto, panel, or single", "E_BAD_FLAG");
      }
      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--panel") {
      mode = "panel";
      continue;
    }

    if (arg === "--single") {
      mode = "single";
      continue;
    }

    rest.push(arg);
  }

  const artifact = rest.join(" ").trim();
  if (!artifact) throw new UsageError("artifact missing — usage: foo roast <artifact> [--mode auto|panel|single]", "E_BAD_FLAG");

  return { artifact, mode };
}

const WORKFLOW_LANES: readonly WorkflowLane[] = ["direct", "shape-fast", "review-targeted", "deep-explicit"];

function parseShapeArgs(args: string[]): { work: string; request?: string; companions: CompanionLens[]; explicitLane?: WorkflowLane } {
  let work: string | undefined;
  let request: string | undefined;
  let explicitLane: WorkflowLane | undefined;
  const companions = new Set<CompanionLens>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--request") {
      request = args[index + 1];
      index += 1;
    } else if (arg === "--companion") {
      companions.add(parseCompanionLens(args[index + 1]));
      index += 1;
    } else if (arg === "--ponytail") {
      companions.add("ponytail");
    } else if (arg === "--lane") {
      const value = args[index + 1];
      if (!value) throw new UsageError("--lane requires a value", "E_BAD_FLAG");
      if (!WORKFLOW_LANES.includes(value as WorkflowLane)) {
        throw new UsageError("--lane must be direct, shape-fast, review-targeted, or deep-explicit", "E_BAD_FLAG");
      }
      if (explicitLane) throw new UsageError("--lane may be provided only once", "E_BAD_FLAG");
      explicitLane = value as WorkflowLane;
      index += 1;
    } else if (arg === "--source" || arg === "--source-fixture") {
      // Consumed by resolveLinearSeed; skip the flag and its value here.
      index += 1;
    } else if (!work) {
      work = arg;
    }
  }
  if (!work) throw new UsageError("work missing — usage: foo spec <work> [--request <text>] [--companion ponytail]", "E_SPEC_WORK_MISSING");
  return { work, request, companions: [...companions], explicitLane };
}

// foo spec (bare, no subcommand) is the frictionless spec-first reflex: a ~30-second shape brief
// that beats improvising. It routes to a fast interview (<=3 questions) and
// names the next handoff, so spec-first wins on speed, not on enforcement.
// Resolve an optional `--source linear:<url>` selector into a shape seed. V0 has
// no live MCP, so the issue/project payload is supplied via `--source-fixture
// <file>` (the runtime would hand it in the same way). Returns null when no
// --source is present; throws an actionable error when the payload is missing
// (errors-as-DX) rather than silently inventing a seed.
function resolveLinearSeed(root: string, args: string[]): { requestLine: string; candidate: LinearCandidate } | null {
  const source = flagValue(args, "--source");
  if (!source) return null;
  if (!source.startsWith("linear:")) {
    throw new UsageError(`--source '${source}' is not supported; V0 admits only linear:<issue-or-project-url>`, "E_BAD_FLAG");
  }
  const selection = parseLinearSource(source);
  const fixturePath = flagValue(args, "--source-fixture");
  if (!fixturePath) {
    // A missing fixture is the caller not supplying an input foo asked for. Guidance, not a bug.
    throw new UsageError(
      `no Linear payload available for ${selection.url}. V0 has no live Linear MCP — supply the issue/project payload with --source-fixture <file.json>, then re-run.`,
      "E_BAD_FLAG",
    );
  }
  let payload: { title?: string; description?: string; state?: string };
  try {
    payload = readJson<{ title?: string; description?: string; state?: string }>(path.resolve(root, fixturePath));
  } catch {
    throw new UsageError(`--source-fixture is not readable JSON: ${fixturePath}`, "E_BAD_FLAG");
  }
  const candidate = buildLinearCandidate(selection, payload);
  return { requestLine: `From Linear ${selection.unit} ${selection.external_id}: ${candidate.intent}`, candidate };
}

export type ShapeSkillResolutionOptions = {
  packageRoot?: string;
};

async function resolveShapeSkillAdapter(
  root: string,
  name: string,
  options: ShapeSkillResolutionOptions,
): Promise<string> {
  const packageRoot = options.packageRoot ?? ROOT;
  if (existsSync(path.join(packageRoot, "skills", "skill-registry.yaml"))) {
    return registeredSkillPath(loadRegisteredSkills(root), name);
  }

  throw new SkillDeliveryError("unapproved-source", `Bundled skill registry is missing. Rebuild or reinstall productfoo before loading "${name}".`);
}

async function shapeRunContext(
  root: string,
  args: string[],
  skillOptions: ShapeSkillResolutionOptions,
) {
  const { work, request, companions, explicitLane } = parseShapeArgs(args);
  // Optional --source linear:<url> selector (linear_integration_v0 R-002): a
  // Linear issue/project seeds the shape request. No new command, +1 concept.
  const seed = resolveLinearSeed(root, args);
  const effectiveRequest = seed ? (request ? `${request}\n\n${seed.requestLine}` : seed.requestLine) : request;
  const classification = classifyWork(effectiveRequest ? `${work} ${effectiveRequest}` : work);
  const routedWork = effectiveRequest ? `${work} ${effectiveRequest}` : work;
  const workflow = resolveWorkflowLane(loadRoutingPolicy(ROOT), {
    work: routedWork,
    explicitLane,
    risk: classification,
    researchRequested: researchRequestTopic(routedWork) !== null,
  });
  const interviewPath = workflow.lane === "shape-fast" && workflow.required_capability !== "research"
    ? await resolveShapeSkillAdapter(root, "interview-me", skillOptions)
    : null;

  return { work, companions, interviewPath, seed, effectiveRequest, classification, workflow };
}

type ShapeRunContext = Awaited<ReturnType<typeof shapeRunContext>>;

function renderShapeAgentContext(context: ShapeRunContext, glyphsOn: boolean): string {
  const { work, companions, interviewPath, seed, effectiveRequest, classification, workflow } = context;
  const common = [
    "Use this run context. It is agent-only; do not relay it verbatim:",
    `Work: ${work}`,
    "",
    "Capability: foo spec (frictionless spec-first reflex)",
    `Workflow lane: ${workflow.lane}`,
    `Recommended lane: ${workflow.recommended_lane}`,
    `Route reason: ${workflow.reason}`,
    `Route signals: ${workflow.signals.length > 0 ? workflow.signals.join(", ") : "none"}`,
    `Route confidence: ${workflow.confidence}; deterministic routing model calls: ${workflow.routing_model_calls}`,
    effectiveRequest ? `Request: ${effectiveRequest}` : "Request: (none provided)",
    ...renderCompanionLines(companions),
    ...(seed ? [`Source: Linear ${seed.candidate.source_id.external_id} (${seed.candidate.url}) — approved-private-context, verify against repo-truth before it becomes a requirement.`] : []),
    withGlyph("classification", `Risk: ${classification.risky ? "risky" : "routine"} — ${classification.rationale}`, glyphsOn),
    ...(workflow.limitation ? [
      `Limitation: ${workflow.limitation}.`,
      "Do not silently substitute the historical six-lens fast swarm or a fixed first-N panel.",
    ] : []),
    "",
  ];

  if (workflow.required_capability === "research") {
    return [
      ...common,
      "Boundary (B5): explicit research runs through productfoo's governed research front door. Do not implement or interview.",
      `Next: run \`foo research ${JSON.stringify(work)}\` and follow its trust and approval boundaries.`,
      "",
    ].join("\n");
  }

  if (workflow.lane === "direct") {
    return [
      ...common,
      "Prompt: Continue in the current coding agent. Read the repository, implement the requested change, and verify it in proportion to risk.",
      "Do not run an interview, swarm, panel, or routing-model call. Do not create a subagent merely to confirm this route.",
      "Run the repository's tests and all applicable deterministic checks: safety scan/redaction, packet validation/reconciliation for packet-tied work, and productfoo self-checks when changing productfoo itself.",
      "Preserve B1-B5, source approval, branch discipline, and explicit user control.",
      "",
      `Next: implement ${work} in the current agent, then report the result, evidence, dissent, and exact next action.`,
      "",
    ].join("\n");
  }

  if (workflow.lane === "review-targeted") {
    return [
      ...common,
      `Limitation: ${workflow.limitation ?? "the bounded targeted adapter is unavailable"}.`,
      "Do not silently substitute the historical six-lens fast swarm or a fixed first-N panel.",
      `Next: pause this lane; use \`foo spec ${work} --lane shape-fast\` for bounded shaping, or choose deep-explicit deliberately.`,
      "",
    ].join("\n");
  }

  if (workflow.lane === "deep-explicit") {
    return [
      ...common,
      "Prompt: Run the governed full spec loop explicitly. Preserve B1-B5, obtain any required autonomy budget, and keep exhaustive work opt-in.",
      `Next: run \`foo spec start ${work}\` and follow its interview, targeted review, packet validation, and approval boundaries.`,
      "",
    ].join("\n");
  }

  return [
    ...common,
    `Skill adapter: interview-me (${interviewPath})`,
    "Depth: fast interview — at most 3 stack-ranked questions.",
    `Prompt: Use $interview-me in fast mode on ${work}; ask at most 3 stack-ranked questions, then emit a Shape Brief.${companions.length ? " Carry companion lenses forward as optional build/review pressure after the Shape Brief." : ""}`,
    "",
    "The Shape Brief must return:",
    "1. The work in one line",
    "2. The product bet and who it is for",
    "3. Source and approval boundaries",
    "4. MVP scope and the validation bar",
    "5. Judgment ledger seed: belief, confidence, dissent, user-only decisions",
    "",
    "Packet handoff: a plain open question is a deferred note, never an urgent request. Use `State: needs-decision` only when active work cannot continue without a person, and copy the scaffold's complete decision block.",
    "",
    classification.spec_first_required
      ? withGlyph("needs_input", "Boundary (B3): this work is risky — escalate to `foo spec start` before build.", glyphsOn)
      : "Signal: this work is routine — spec-first stays advisory; surface findings, do not block.",
    `Next: carry the Shape Brief into build, or run \`foo spec start ${work}\` if the scope is deep.`,
    "",
  ].join("\n");
}

export type ShapeCommandRun = {
  output: string;
  handoffSteps: string[];
};

function inlineCode(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const longestRun = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = "`".repeat(longestRun + 1);
  const padding = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${oneLine}${padding}${delimiter}`;
}

export async function runShapeCommandWithHandoff(
  root: string,
  args: string[],
  glyphsOn: boolean,
  skillOptions: ShapeSkillResolutionOptions = {},
): Promise<ShapeCommandRun> {
  const context = await shapeRunContext(root, args, skillOptions);
  const { work, classification, workflow } = context;
  const output = workflow.required_capability === "research"
    ? [
        `Research route prepared for: ${inlineCode(work)}`,
        "",
        `Lane: shape-fast — ${workflow.reason}`,
        "B5 applies: research runs through productfoo's governed research path.",
        "",
        "Next: continue with governed research in your coding assistant.",
        "",
      ].join("\n")
    : workflow.lane === "direct"
    ? [
        `Ready to build: ${inlineCode(work)}`,
        "",
        `Lane: direct — ${workflow.reason}`,
        "This stays in your current coding agent; no extra model call is needed.",
        "",
        "Next: continue with the implementation in your coding assistant.",
        "",
      ].join("\n")
    : workflow.lane === "review-targeted"
      ? [
          `Review route prepared for: ${inlineCode(work)}`,
          "",
          `Lane: review-targeted — ${workflow.reason}`,
          `This route is not executable yet: ${workflow.limitation ?? "the bounded targeted adapter is unavailable"}.`,
          "",
          "Next: use shape-fast for bounded clarification, or choose deep-explicit deliberately.",
          "",
        ].join("\n")
      : workflow.lane === "deep-explicit"
        ? [
            `Deep route prepared for: ${inlineCode(work)}`,
            "",
            `Lane: deep-explicit — ${workflow.reason}`,
            "This runs only by explicit choice and keeps every safety and approval boundary.",
            "",
            "Next: continue with the governed full spec loop in your coding assistant.",
            "",
          ].join("\n")
        : [
            `Ready to plan: ${inlineCode(work)}`,
            "",
            `Lane: shape-fast — ${workflow.reason}`,
            ...(workflow.limitation ? [`Targeted execution is unavailable: ${workflow.limitation}.`] : []),
            "I’ll read the project first, then ask up to 3 questions only where the answer depends on you.",
            classification.spec_first_required
              ? "This could be hard to reverse, act on its own, or affect people outside the project. Agree on the plan before building."
              : "This looks safe to plan quickly.",
            "",
            "Next: continue with the first question in your coding assistant.",
            "",
          ].join("\n");

  return {
    output: guardHumanSurface(output),
    handoffSteps: [renderShapeAgentContext(context, glyphsOn)],
  };
}

export async function runShapeCommand(root: string, args: string[], glyphsOn: boolean): Promise<string> {
  return (await runShapeCommandWithHandoff(root, args, glyphsOn)).output;
}

function parseClassifyArgs(args: string[]): { work: string; override?: string; asJson: boolean } {
  let work: string | undefined;
  let override: string | undefined;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--strict") {
      // Consumed by the caller; named here so it is never mistaken for the work text.
    } else if (arg === "--override") {
      override = args[index + 1];
      index += 1;
    } else if (!work) {
      work = arg;
    }
  }
  if (!work) throw new UsageError("work missing — usage: foo classify \"<work>\"", "E_BAD_FLAG");
  return { work, override, asJson };
}

export function runClassifyCommand(args: string[], glyphsOn: boolean): string {
  const { work, override, asJson } = parseClassifyArgs(args);
  // --strict blocks on any keyword hit — the behaviour before the governing-frame
  // downgrade existed. Kept so a caller who wants the blunt instrument can have it.
  const strict = args.includes("--strict") || process.env.FOO_CLASSIFY_STRICT === "1";
  return renderClassification(classifyWork(work, override, { strict }), asJson, glyphsOn);
}

export async function runRoastCommand(root: string, args: string[]): Promise<string> {
  let roastPath: string;
  if (existsSync(path.join(ROOT, "skills", "skill-registry.yaml"))) {
    const registeredSkills = loadRegisteredSkills(root);
    roastPath = registeredSkillPath(registeredSkills, "foo-roast");
  } else {
    throw new SkillDeliveryError("unapproved-source", "Bundled skill registry is missing. Rebuild or reinstall productfoo before running roast.");
  }

  const { artifact, mode } = parseRoastArgs(args);
  const panelLine = mode === "auto" ? "auto (panel for meaningful product work; single for tiny prompts)" : mode;

  return [
    `Product roast must run for: ${artifact}`,
    "",
    "Capability: foo roast",
    `Skill adapter: foo-roast (${roastPath})`,
    `Panel: ${panelLine}`,
    "",
    `Prompt: Use $foo-roast on ${artifact}`,
    "",
    "Five moves:",
    "1. Core Job",
    "2. Subtract",
    "3. Consequences",
    "4. Guardrails",
    "5. Candidate evals",
    "",
    "The roast must return:",
    "1. What this is trying to become",
    "2. Take away",
    "3. Preserve",
    "4. Consequence map",
    "5. Do not ask the coding agent to",
    "6. Candidate evals",
    "7. Panel dissent",
    "8. Next prompt",
    "",
    "Signal: run this before the next generation so cuts, guardrails, and evals shape the next prompt.",
    "Next: fold the cuts and guardrails into your next prompt, then `foo spec` the revised work.",
    "",
  ].join("\n");
}

export async function runPreviewCommand(root: string, packetArg: string | undefined): Promise<string> {
  const registeredSkills = loadRegisteredSkills(root);
  const previewPath = registeredSkillPath(registeredSkills, "preview-swarm");

  if (!packetArg) throw new UsageError("packet-dir missing — usage: foo preview <packet-dir>", "E_PACKET_DIR_MISSING");

  const packet = resolvePacketDir(root, packetArg);
  const pending = findUnrepresentedUserCorrections(packet.packetDir);
  if (pending.length > 0) {
    const proposals = pending.map(({ summary }) =>
      renderPatchProposal(proposeSpecPatch(packet.packetDir, summary)).trimEnd(),
    );
    throw new GateBlock(
      [
        `drift — ${pending.length} accepted user correction${pending.length === 1 ? " is" : "s are"} missing from ${packet.packetArg}.`,
        "Preview did not run. Review and apply the proposal before retrying.",
        "",
        ...proposals.flatMap((proposal, index) => (index === 0 ? [proposal] : ["", proposal])),
        "",
        `Then run: foo asp validate ${packet.packetArg}`,
        `Retry: foo preview ${packet.packetArg}`,
      ].join("\n"),
      "E_CONTRACT_DRIFT",
    );
  }
  const artifactTarget = path.join(packet.packetArg, "artifacts", "previews", "<run-id>", "preview.html");
  const cost = await costHeadline(root, packet.packetDir);

  return [
    `Build Preview must run for: ${packet.packetArg}`,
    "",
    "Capability: foo preview",
    `Skill adapter: preview-swarm (${previewPath})`,
    "",
    `Prompt: Use $preview-swarm on ${packet.packetArg}`,
    `Artifact target: ${artifactTarget}`,
    "",
    "Signal: run the Impeccable collaboration contract before marking the Build Preview complete; record a manual-review gap if Impeccable is unavailable.",
    // Cost, where the decision actually is (spec-budget-v0 R-010). A preview is the
    // "what am I about to pay for" moment, so the number belongs here rather than
    // behind a verb nobody remembers to type. Structural only — never egresses —
    // and silently absent if it cannot be computed honestly.
    ...(cost ? ["", `Cost: ${cost}`] : []),
    "",
  ].join("\n");
}

// A small built-in question to demonstrate the canonical text rendering via
// `foo elicitation render`. Intentionally meta: the surface choice itself.
const EXAMPLE_QUESTION: QuestionInput = {
  header: "Surface",
  prompt: "Which surface should productfoo use to ask this question?",
  options: [
    { id: "widget", label: "Branded widget", description: "Full productfoo visual identity; needs a widget-capable TTY runtime." },
    { id: "text", label: "Numbered text", description: "The guaranteed fallback; every runtime and the agent reader can read it." },
  ],
  recommendedOptionId: "text",
  judgment: {
    belief: "Text is the safe default; the widget is the earned exception.",
    evidence: "R-004 — never render a widget into a piped or agent-read stream.",
    confidence: "high",
  },
};

// `foo elicitation surface` reports the resolved surface; `foo elicitation render` shows
// the canonical numbered-text rendering of an example question (T-001/T-003,
// specs/foo-branded-elicitation-v0). The default surface is text; the branded widget is
// the earned exception, and a piped/non-TTY context always reads as text.
export function runElicitationCommand(command: string | undefined, args: string[]): string {
  if (command === "surface") {
    const decision = detectElicitationSurface();
    if (args.includes("--json")) {
      return `${JSON.stringify(decision, null, 2)}\n`;
    }
    return [
      `Elicitation surface: ${decision.surface}`,
      `Runtime:             ${decision.runtime}`,
      `Reason:              ${decision.reason}`,
      "",
    ].join("\n");
  }

  if (command === "render") {
    return renderQuestion(defineQuestion(EXAMPLE_QUESTION)).text;
  }

  throw new UsageError(`unknown elicitation command: ${command ?? "(none)"}. Try: foo elicitation surface | render`, "E_BAD_FLAG");
}

// `foo learn`'s static screen was deleted when learn collapsed into `foo init`
// (cli-first-run-v0 D-011/R-013): one door, one first-run corpus. The alias
// dispatch lives in cli.ts; the orientation strings live in initCommand.ts.
