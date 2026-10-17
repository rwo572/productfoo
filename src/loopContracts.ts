import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { GateBlock, NotFoundError } from "./errorTaxonomy.js";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "./vendorYaml.js";
import {
  type BudgetBlock,
  buildAgreedBudget,
  type EstimateResult,
  estimateLoopBudget,
  handshakeFloorUsd,
  hasExternalSources,
  loadPricing,
  parseBudget,
} from "./loopBudget.js";

type JsonObject = Record<string, unknown>;

type LoopContract = {
  id: string;
  title: string;
  status: string;
  owner: string;
  refs: {
    requirements: string[];
    tasks: string[];
    events: string[];
  };
  goal: string;
  observe: {
    sources: string[];
  };
  record: {
    artifact: string;
  };
  ask_user_when: string[];
  budget?: BudgetBlock;
};

const LOOP_STATES = [
  "draft",
  "ready",
  "active",
  "succeeded",
  "clean_no_op",
  "blocked",
  "approval_required",
  "exhausted",
  "stagnated",
  "retired",
];

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return asArray(value, label).map((item, index) => requireString(item, `${label}[${index}]`));
}

function requireKeys(value: JsonObject, keys: string[], label: string): void {
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label} missing ${key}`);
  }
}

function loadTasksDoc(packetDir: string): JsonObject {
  const tasksPath = path.join(packetDir, "tasks.yaml");
  if (!existsSync(tasksPath)) throw new Error("tasks.yaml missing");
  return asObject(parseYaml(readFileSync(tasksPath, "utf8")), "tasks.yaml");
}

function taskIds(tasksDoc: JsonObject): Set<string> {
  return new Set(
    asArray(tasksDoc.tasks, "tasks.yaml.tasks").map((task, index) =>
      requireString(asObject(task, `tasks.yaml.tasks[${index}]`).id, `tasks.yaml.tasks[${index}].id`),
    ),
  );
}

function defaultLoopTask(tasksDoc: JsonObject): string {
  const tasks = asArray(tasksDoc.tasks, "tasks.yaml.tasks").map((task, index) => asObject(task, `tasks.yaml.tasks[${index}]`));
  const reconciliationTask = tasks.find((task) =>
    stringArray(task.refs, `task ${String(task.id)} refs`).includes("R-010"),
  );
  const selected = reconciliationTask ?? tasks[0];
  return requireString(selected.id, "selected task id");
}

export function renderLoopDesign(packetDir: string): string {
  const tasksDoc = loadTasksDoc(packetDir);
  const specId = requireString(tasksDoc.spec_id, "tasks.yaml.spec_id");
  const taskId = defaultLoopTask(tasksDoc);

  return [
    'schema_version: "0.1"',
    `spec_id: ${specId}`,
    'updated: null',
    'loops:',
    '  - id: L-001',
    '    title: "Reconciliation loop contract"',
    '    status: draft',
    '    owner: product',
    '    refs:',
    '      requirements: [R-010]',
    `      tasks: [${taskId}]`,
    '      events: []',
    '    mode: human-in-loop',
    '    trigger: manual',
    '    goal: Review changed work against agreed tasks without editing canonical packet files.',
    '    lifecycle:',
    '      allowed_states: [draft, ready, active, succeeded, clean_no_op, blocked, approval_required, exhausted, stagnated, retired]',
    '      terminal_states: [succeeded, clean_no_op, blocked, exhausted, stagnated, retired]',
    '    observe:',
    '      sources: [spec.md, tasks.yaml, events.jsonl]',
    '      freshness: read files immediately before each pass',
    '    choose:',
    '      criteria: [highest-risk unmapped change]',
    '    act:',
    '      allowed: [propose one reconciliation finding]',
    '      forbidden:',
    '        - Do not edit canonical packet files without explicit approval',
    '        - Do not import raw private sources',
    '    verify:',
    '      check: "foo asp reconcile <packet-dir> --git-diff"',
    '      method: manual review plus CLI reconciliation',
    '    record:',
    '      event_type: com.adaptivespec.loop.iteration_recorded',
    '      artifact: artifacts/loops/L-001/',
    '      required_fields: [iteration_id, observed_sources, action_taken, verification_result, next_state]',
    '    stop:',
    '      succeeded: all changed work maps to agreed tasks or accepted events',
    '      clean_no_op: no relevant changed work is present',
    '      blocked: approval needed for canonical packet changes',
    '      exhausted: two passes produce no clearer loop contract',
    '      stagnated: a pass produces no new resolvable finding',
    '    ask_user_when:',
    '      - product meaning changes',
    '      - source boundary changes',
    '      - destructive, production, financial, privacy-sensitive, or external-message action would be enabled',
    '',
  ].join("\n");
}

export function loadLoopContracts(packetDir: string): { specId: string; loops: LoopContract[] } {
  const loopsPath = path.join(packetDir, "loops.yaml");
  if (!existsSync(loopsPath))
    throw new NotFoundError(
      "loops.yaml missing; run foo loop design <packet-dir> > <packet-dir>/loops.yaml",
      "E_PACKET_NOT_FOUND",
    );

  const tasksDoc = loadTasksDoc(packetDir);
  const specId = requireString(tasksDoc.spec_id, "tasks.yaml.spec_id");
  const ids = taskIds(tasksDoc);
  const doc = asObject(parseYaml(readFileSync(loopsPath, "utf8")), "loops.yaml");
  requireKeys(doc, ["schema_version", "spec_id", "loops"], "loops.yaml");
  if (doc.spec_id !== specId) throw new Error("loops.yaml.spec_id must match tasks.yaml.spec_id");

  const loops = asArray(doc.loops, "loops.yaml.loops").map((loop, index): LoopContract => {
    const loopObject = asObject(loop, `loops.yaml.loops[${index}]`);
    requireKeys(
      loopObject,
      ["id", "title", "status", "owner", "refs", "goal", "observe", "choose", "act", "verify", "record", "stop", "ask_user_when"],
      `loops.yaml.loops[${index}]`,
    );

    const id = requireString(loopObject.id, `loops.yaml.loops[${index}].id`);
    const status = requireString(loopObject.status, `loops.yaml.loops[${index}].status`);
    if (!LOOP_STATES.includes(status)) throw new Error(`loops.yaml.loops[${index}].status invalid: ${status}`);

    const refs = asObject(loopObject.refs, `loops.yaml.loops[${index}].refs`);
    const tasks = stringArray(refs.tasks, `loops.yaml.loops[${index}].refs.tasks`);
    for (const task of tasks) {
      if (!ids.has(task)) throw new Error(`loop ${id} references unknown task ${task}`);
    }

    const observe = asObject(loopObject.observe, `loops.yaml.loops[${index}].observe`);
    const record = asObject(loopObject.record, `loops.yaml.loops[${index}].record`);

    return {
      id,
      title: requireString(loopObject.title, `loops.yaml.loops[${index}].title`),
      status,
      owner: requireString(loopObject.owner, `loops.yaml.loops[${index}].owner`),
      refs: {
        requirements: stringArray(refs.requirements, `loops.yaml.loops[${index}].refs.requirements`),
        tasks,
        events: "events" in refs ? stringArray(refs.events, `loops.yaml.loops[${index}].refs.events`) : [],
      },
      goal: requireString(loopObject.goal, `loops.yaml.loops[${index}].goal`),
      observe: {
        sources: stringArray(observe.sources, `loops.yaml.loops[${index}].observe.sources`),
      },
      record: {
        artifact: requireString(record.artifact, `loops.yaml.loops[${index}].record.artifact`),
      },
      ask_user_when: stringArray(loopObject.ask_user_when, `loops.yaml.loops[${index}].ask_user_when`),
      budget: "budget" in loopObject ? parseBudget(loopObject.budget, `loops.yaml.loops[${index}].budget`) : undefined,
    };
  });

  if (loops.length === 0) throw new Error("loops.yaml.loops must be a nonempty array");
  return { specId, loops };
}

// R-005: an unbudgeted loop is a malformed contract — but enforcement is
// size-aware (T-004). `--strict-budget` refuses any unbudgeted loop outright.
// Otherwise foo prices each unbudgeted loop with the cold/structural estimator:
// a loop under the handshake threshold (FOO_BUDGET_HANDSHAKE_FLOOR, default
// $0.50) is auto-approved and logged — cheap work keeps its momentum — while a
// loop at or above the threshold blocks until a human runs the budget handshake.
// Either way an estimate event is recorded for calibration.
function emitLoopEstimateEvent(
  packetDir: string,
  loopId: string,
  result: EstimateResult,
  meta: { autoApproved: boolean; floor: number },
): string {
  const eventsPath = path.join(packetDir, "events.jsonl");
  const id = `evt_loop_budget_estimated_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // UNMEASURABLE MEANS UNKNOWN — here too, not only on the screen.
  //
  // `priced` answers "was pricing.yaml found?", NOT "is the cost knowable?". A loop that
  // reads the web is priced and unknowable at the same time, and this writer only ever asked
  // the first question. So it recorded `expected_usd: 0.11, ceiling_usd: 0.275` on a loop
  // whose own findings, in the same event, said "cost unknown: 5 observation source(s)
  // cannot be sized offline". The ledger asserted a number the estimate had just refused to
  // stand behind.
  //
  // That was already the packet's most-corrected mistake. `foo loop estimate` prints "unknown
  // — this loop reads sources productfoo cannot size", and evt_mo_008 in model-orchestrator-v0 spent
  // a whole event retiring the last fabricated range: "Prior events in this ledger quoting
  // $0.60/$1.50/$0.275 per pass are superseded: the true answer is that productfoo does not know,
  // and now says so." The fix landed on the RENDER path on 2026-07-11 and never reached this
  // one, so the ledger kept accruing exactly the numbers that event retired — including one
  // written three days later, quoting $0.275 again.
  //
  // A screen is read once; a ledger is what a future reader and `foo asp reconcile` treat as
  // fact. Of the two doors, this is the one that had to hold.
  const unknown = result.unmeasurable;
  const summary = unknown
    ? `Estimated loop ${loopId}: cost UNKNOWN — ${result.findings.join("; ") || "this loop reads sources productfoo cannot size offline"}. Treated as at/above the $${meta.floor.toFixed(2)} threshold; handshake required. Authorise with an explicit cap: foo loop estimate <packet-dir> --agree --limit <usd>.`
    : result.priced
      ? `Estimated loop ${loopId}: $${result.usd.expected.toFixed(4)} expected (threshold $${meta.floor.toFixed(2)}); ${meta.autoApproved ? "auto-approved below threshold" : "over threshold, handshake required"}.`
      : `Estimated loop ${loopId}: unpriced (${result.findings.join("; ") || "pricing degraded"}); token-only estimate ${result.tokens.expected} expected — treated as at/above the $${meta.floor.toFixed(2)} threshold, handshake required (fail-closed).`;

  const event = {
    specversion: "0.1",
    id,
    source: "agent://foo/loop-check",
    type: "com.adaptivespec.loop.budget_estimated",
    subject: `loop:${loopId}`,
    time: new Date().toISOString(),
    actor: { type: "agent", id: "foo:loop-check", mode: "human-in-loop" },
    data: {
      summary,
      auto_approved: meta.autoApproved,
      priced: result.priced,
      // Recorded so a reader can tell "productfoo does not know" apart from "foo forgot to write it".
      unmeasurable: unknown,
      findings: result.findings,
      handshake_floor_usd: meta.floor,
      // Omitted entirely when unknown, rather than written as a number nobody stands behind.
      // An absent field cannot be averaged, charted, or quoted back as a prediction.
      ...(unknown
        ? {}
        : { expected_usd: result.usd.expected, ceiling_usd: result.usd.ceiling, expected_tokens: result.tokens.expected }),
      basis: result.basis,
      confidence: result.confidence,
      priced_with: result.priced_with,
    },
    extensions: {},
  };
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  return id;
}

/** Loop states that can act, and so spend. B4's budget handshake is due for
 *  these; a loop in any other state is a signal (AGENTS.md B4). */
export const ARMED_LOOP_STATES: ReadonlySet<string> = new Set(["ready", "active"]);

export function checkLoopContracts(
  root: string,
  packetDir: string,
  options: { strictBudget?: boolean } = {},
): string {
  // Most packets declare no loops at all, and that is the healthy default — B4 governs
  // packets that HAVE loops. Checking one that has none used to throw a bare Error, which
  // classifies as `command_error`: the one class that pages a human and files a Bug Capsule.
  // So a stranger's first packet reported a defect in foo for being perfectly ordinary (#702).
  // Nothing to check is not a failure; say so and exit 0.
  if (!existsSync(path.join(packetDir, "loops.yaml"))) {
    return "loop contracts ok (0) — this packet declares no loops, so there is nothing to check.";
  }
  const { loops } = loadLoopContracts(packetDir);
  const allUnbudgeted = loops.filter((loop) => !loop.budget?.agreed);
  let base = `loop contracts ok (${loops.length})`;

  if (allUnbudgeted.length === 0) return base;

  // Strict mode: any unbudgeted loop is refused, regardless of size.
  if (options.strictBudget) {
    // Strict means every loop, armed or not (AGENTS.md B4 --strict-budget).
    const ids = allUnbudgeted.map((loop) => loop.id).join(", ");
    // B4 refusing an unbudgeted loop is the product WORKING, not breaking. It exits nonzero
    // because it stopped you on purpose — so it is a gate_block, and it never pages anyone.
    // (It was being recorded as a crash, which is exactly the false alarm this taxonomy exists
    // to kill: a pager that fires when the safety rules work correctly gets muted immediately.)
    throw new GateBlock(`loop(s) without an agreed budget: ${ids} — run foo loop estimate <packet-dir> --agree`, "E_GATE_B4_BUDGET");
  }

  // #906 / AGENTS.md B4: "a draft unbudgeted loop is a signal; a ready/active
  // armed loop without budget blocks." A draft cannot act, so it cannot spend:
  // report it and move on — no estimate, no event, no auto-approved budget
  // written into tracked packet files. Arming it is what makes the handshake due.
  const drafts = allUnbudgeted.filter((loop) => !ARMED_LOOP_STATES.has(loop.status));
  const unbudgeted = allUnbudgeted.filter((loop) => ARMED_LOOP_STATES.has(loop.status));
  if (drafts.length > 0) {
    base += `; signal: ${drafts.length} unarmed loop(s) without an agreed budget (${drafts.map((loop) => `${loop.id} ${loop.status}`).join(", ")}) — budget before arming with foo loop estimate <packet-dir> --agree`;
  }
  if (unbudgeted.length === 0) return base;

  const floor = handshakeFloorUsd();
  const pricing = loadPricing(root);
  const autoApproved: string[] = [];
  const overThreshold: string[] = [];
  const degradedFindings = new Set<string>();

  for (const loop of unbudgeted) {
    const result = estimateLoopBudget({ packetDir, sources: loop.observe.sources, pricing, unit: "usd", budget: loop.budget });
    // B4 fail-closed (model-roster-data-v0 R-002): an unpriced estimate (missing
    // pricing.yaml or unknown model) cannot prove the loop is below the floor, so
    // it is treated as at/above it — auto-approval is a convenience that requires
    // priced data; the handshake is never waived by degraded pricing.
    //
    // Same fail-closed rule for UNMEASURABLE sources: a loop that observes the web
    // cannot be sized offline. Such a source used to measure 0 tokens, so a
    // scheduled research loop priced itself at ~$0, fell under the floor, and
    // auto-approved — bypassing the handshake for exactly the loops whose cost is
    // least knowable. An estimate resting on an unmeasurable source is a floor, not
    // a measurement, and can never prove the loop is cheap. Unknown cost => a human
    // decides.
    const unmeasurable = hasExternalSources(result.measured);
    const below = result.priced && !unmeasurable && result.usd.expected < floor;
    emitLoopEstimateEvent(packetDir, loop.id, result, { autoApproved: below, floor });

    if (below) {
      // Auto-approve: write an agreed budget so the cheap loop runs and is not
      // re-estimated next time. Logged, not blocked (C-008).
      const at = new Date().toISOString();
      writeAgreedBudget(packetDir, loop.id, buildAgreedBudget(result, { by: "foo:auto-approve", at }));
      autoApproved.push(loop.id);
    } else {
      overThreshold.push(loop.id);
      if (!result.priced) for (const finding of result.findings) degradedFindings.add(finding);
      if (unmeasurable) {
        const external = result.measured.filter((m) => m.external).map((m) => m.source);
        degradedFindings.add(
          `loop observes ${external.length} source(s) that cannot be sized offline (${external.slice(0, 3).join("; ")}${external.length > 3 ? "; …" : ""}) — priced at a conservative floor, so the estimate cannot prove the loop is below the threshold`,
        );
      }
    }
  }

  // A loop at or above the threshold is malformed until a human prices it (C-007).
  if (overThreshold.length > 0) {
    const degradedNote =
      degradedFindings.size > 0
        ? ` [degraded: ${[...degradedFindings].join("; ")} — an unpriced loop cannot be auto-approved and is treated as at/above the floor]`
        : "";
    // B4 stopping an armed loop is the gate working, not a crash (see the
    // strict path above): a GateBlock, never a paging command_error.
    throw new GateBlock(
      `loop(s) at or above the $${floor.toFixed(2)} handshake threshold without an agreed budget: ${overThreshold.join(", ")} — run foo loop estimate <packet-dir> --agree${degradedNote}`,
      "E_GATE_B4_BUDGET",
    );
  }

  return `${base}; ${autoApproved.length} auto-approved below the $${floor.toFixed(2)} threshold: ${autoApproved.join(", ")} (estimate logged)`;
}

function nextAction(status: string): "continue" | "stop" | "ask" {
  if (status === "blocked" || status === "approval_required") return "ask";
  if (["succeeded", "clean_no_op", "exhausted", "stagnated", "retired"].includes(status)) return "stop";
  return "continue";
}

export function renderLoopStatus(packetDir: string): unknown[] {
  const { loops } = loadLoopContracts(packetDir);
  return loops.map((loop) => ({
    loop: loop.id,
    title: loop.title,
    owner: loop.owner,
    state: loop.status,
    why_it_exists: loop.goal,
    current_evidence: {
      sources: loop.observe.sources,
      last_events: loop.refs.events,
    },
    next_action: nextAction(loop.status),
    approval_boundary: loop.ask_user_when,
    trail: loop.record.artifact,
    // Surface budget only when authored, so status cards for pre-budget loops
    // are unchanged.
    ...(loop.budget
      ? {
          budget: {
            unit: loop.budget.unit,
            limit: loop.budget.limit,
            agreed: loop.budget.agreed ?? null,
          },
        }
      : {}),
  }));
}

// Write an agreed budget back into a loop's entry in loops.yaml. The file is
// re-serialized from its parsed form; callers own when this runs (the
// dry-run-before-writes handshake in foo loop estimate --agree).
export function writeAgreedBudget(packetDir: string, loopId: string, budget: BudgetBlock): void {
  const loopsPath = path.join(packetDir, "loops.yaml");
  if (!existsSync(loopsPath)) throw new NotFoundError("loops.yaml missing", "E_PACKET_NOT_FOUND");
  const doc = asObject(parseYaml(readFileSync(loopsPath, "utf8")), "loops.yaml");
  const loops = asArray(doc.loops, "loops.yaml.loops");
  const target = loops.find((loop) => asObject(loop, "loops.yaml.loops[]").id === loopId);
  if (!target) throw new NotFoundError(`loop ${loopId} not found in loops.yaml`, "E_PACKET_NOT_FOUND");
  (target as JsonObject).budget = budget as unknown as JsonObject;
  writeFileSync(loopsPath, stringifyYaml(doc));
}
