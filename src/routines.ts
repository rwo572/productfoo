// Portable routines (portable-routines-v0): a routine is a loop contract whose
// trigger is a schedule or event (not just manual), bound to one or more coding
// agents. Fiona Fung's "routines" — async agent management — made runtime-neutral.
//
// The split that makes it agnostic:
//   - The CONTRACT (goal, observe, act, verify, stop, ask_user_when, budget) is
//     the existing loop contract — canonical, validated by loopContracts.ts, the
//     same for every runtime.
//   - The TRIGGER (when it fires) is canonical too: a standard cron / event name.
//   - Only the BINDING (how a given agent arms the trigger and runs one pass
//     headless) is per-runtime, and that lives in agentAdapters.ts.
//
// This module reads routines out of loops.yaml, enforces the autonomy boundary
// (B4) for anything that runs unattended, resolves the bound adapters, and emits
// the per-runtime binding artifact. productfoo never schedules anything itself.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import { loadLoopContracts } from "./loopContracts.js";
import { NotFoundError } from "./errorTaxonomy.js";
import { AGENT_ADAPTERS, getAdapter, type RuntimeId, type TriggerKind } from "./agentAdapters.js";
import type { SeverityClass } from "./severityClass.js";

type JsonObject = Record<string, unknown>;

export interface RoutineTrigger {
  kind: TriggerKind;
  cron: string | null;
  tz: string | null;
  event: string | null;
}

export interface Routine {
  id: string;
  title: string;
  goal: string;
  mode: string;
  trigger: RoutineTrigger;
  /** Runtimes this routine is bound to (from the adapters block). */
  runtimes: RuntimeId[];
  /** schedule/event triggers run with no human present at fire time. */
  unattended: boolean;
  // B4 completeness, read from the loop contract.
  verifyCheck: string | null;
  terminalStates: string[];
  approvalBoundaries: string[];
  observeSources: string[];
  allowedActions: string[];
}

export interface RoutineFinding {
  kind: "autonomy_incomplete" | "unknown_runtime" | "runtime_not_headless" | "unsupported_runtime" | "trigger_malformed";
  severity: "high" | "medium" | "low";
  class: SeverityClass;
  /** B4 when this is the autonomy boundary; absent for advisory-only findings. */
  boundary: "B4" | null;
  subject: string;
  summary: string;
  suggested_actions: string[];
  requires_human: boolean;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((x): x is string => x !== null) : [];
}

function parseTrigger(raw: unknown): RoutineTrigger {
  const t = asObject(raw);
  const kind = (str(t.kind) ?? "manual") as TriggerKind;
  return { kind, cron: str(t.cron), tz: str(t.tz), event: str(t.event) };
}

// Terminal states come from lifecycle.terminal_states when present, else the
// keys of the stop: block (each key is a terminal state name).
function parseTerminalStates(loop: JsonObject): string[] {
  const lifecycle = asObject(loop.lifecycle);
  const fromLifecycle = strArray(lifecycle.terminal_states);
  if (fromLifecycle.length > 0) return fromLifecycle;
  return Object.keys(asObject(loop.stop));
}

// A loop entry is a routine when it declares an adapters block or a non-manual
// trigger; a plain manual loop stays a loop.
function isRoutineEntry(loop: JsonObject): boolean {
  if ("adapters" in loop) return true;
  const kind = str(asObject(loop.trigger).kind);
  return kind === "schedule" || kind === "event";
}

export function parseRoutines(packetDir: string): { specId: string; routines: Routine[] } {
  const loopsPath = path.join(packetDir, "loops.yaml");
  if (!existsSync(loopsPath)) {
    // Absent is not a defect (#702): NotFoundError classifies as `not_found`, which never pages.
    throw new NotFoundError(
      "loops.yaml missing; run foo loop design <packet-dir> > <packet-dir>/loops.yaml, then add trigger + adapters",
      "E_PACKET_NOT_FOUND",
    );
  }
  // Reuse the base loop-contract validation so a routine can never skip it.
  const { specId } = loadLoopContracts(packetDir);

  const doc = asObject(parseYaml(readFileSync(loopsPath, "utf8")));
  const loops = Array.isArray(doc.loops) ? doc.loops : [];
  const routines: Routine[] = [];

  for (const raw of loops) {
    const loop = asObject(raw);
    if (!isRoutineEntry(loop)) continue;

    const trigger = parseTrigger(loop.trigger);
    const adapters = asObject(loop.adapters);
    const runtimes = strArray(adapters.runtimes) as RuntimeId[];
    const verify = asObject(loop.verify);

    routines.push({
      id: str(loop.id) ?? "L-?",
      title: str(loop.title) ?? "",
      goal: str(loop.goal) ?? "",
      mode: str(loop.mode) ?? "human-in-loop",
      trigger,
      runtimes,
      unattended: trigger.kind === "schedule" || trigger.kind === "event",
      verifyCheck: str(verify.check),
      terminalStates: parseTerminalStates(loop),
      approvalBoundaries: strArray(loop.ask_user_when),
      observeSources: strArray(asObject(loop.observe).sources),
      allowedActions: strArray(asObject(loop.act).allowed),
    });
  }

  return { specId, routines };
}

// Validate a routine. The autonomy boundary (B4) findings carry boundary: "B4"
// and are the only ones a caller should escalate to a blocking exit under
// --strict; everything else is an advisory signal (signals-over-gates).
export function validateRoutine(routine: Routine): RoutineFinding[] {
  const findings: RoutineFinding[] = [];

  // B4: an unattended routine MUST carry a verification check, at least one
  // terminal state, and an approval boundary — otherwise unbounded action.
  if (routine.unattended) {
    const missing: string[] = [];
    if (!routine.verifyCheck) missing.push("verify.check");
    if (routine.terminalStates.length === 0) missing.push("a terminal state");
    if (routine.approvalBoundaries.length === 0) missing.push("ask_user_when (approval boundary)");
    if (missing.length > 0) {
      findings.push({
        kind: "autonomy_incomplete",
        severity: "high",
        class: "bad",
        boundary: "B4",
        subject: `routine:${routine.id}`,
        summary: `Unattended routine ${routine.id} is missing ${missing.join(", ")}. An unattended loop without these is unbounded risk (B4).`,
        suggested_actions: [
          "add a verify.check the routine runs every pass",
          "declare terminal states so the loop can stop",
          "list ask_user_when boundaries for actions that need a human",
        ],
        requires_human: true,
      });
    }
    if (routine.trigger.kind === "schedule" && !routine.trigger.cron) {
      findings.push({
        kind: "trigger_malformed",
        severity: "high",
        class: "bad",
        boundary: "B4",
        subject: `routine:${routine.id}`,
        summary: `Routine ${routine.id} has a schedule trigger with no cron expression.`,
        suggested_actions: ["set trigger.cron to a standard 5-field cron expression"],
        requires_human: true,
      });
    }
  }

  if (routine.runtimes.length === 0) {
    findings.push({
      kind: "unknown_runtime",
      severity: "medium",
      class: "sad",
      boundary: null,
      subject: `routine:${routine.id}`,
      summary: `Routine ${routine.id} is bound to no runtime; it has a contract but nothing to run it.`,
      suggested_actions: [`add adapters.runtimes (e.g. [claude, codex])`],
      requires_human: false,
    });
  }

  for (const runtime of routine.runtimes) {
    const adapter = getAdapter(runtime);
    if (!adapter) {
      findings.push({
        kind: "unknown_runtime",
        severity: "medium",
        class: "bad",
        boundary: null,
        subject: `routine:${routine.id}`,
        summary: `Routine ${routine.id} names unknown runtime "${runtime}".`,
        suggested_actions: [`use a known runtime: ${Object.keys(AGENT_ADAPTERS).join(", ")}`],
        requires_human: false,
      });
      continue;
    }
    if (routine.unattended && !adapter.can_run_headless) {
      findings.push({
        kind: "runtime_not_headless",
        severity: "high",
        class: "bad",
        boundary: "B4",
        subject: `routine:${routine.id}`,
        summary: `Runtime ${adapter.label} cannot run headless, so it cannot safely back an unattended routine.`,
        suggested_actions: [
          `arm this routine through github-actions running a headless runtime instead`,
          `or bind ${routine.id} to a headless runtime (${AGENT_ADAPTERS.claude.label}, ${AGENT_ADAPTERS.codex.label})`,
        ],
        requires_human: true,
      });
    } else if (adapter.support === "planned") {
      findings.push({
        kind: "unsupported_runtime",
        severity: "low",
        class: "sad",
        boundary: null,
        subject: `routine:${routine.id}`,
        summary: `Runtime ${adapter.label} is mapped but not yet supported: ${adapter.notes}`,
        suggested_actions: [`prefer a supported runtime for now: ${supportedLabels()}`],
        requires_human: false,
      });
    }
  }

  return findings;
}

function supportedLabels(): string {
  return (Object.values(AGENT_ADAPTERS))
    .filter((a) => a.support === "supported")
    .map((a) => a.label)
    .join(", ");
}

// The pass instruction handed to whichever runtime fires — identical across
// runtimes, which is what makes the routine portable. Built from the contract.
export function passPrompt(routine: Routine, packetRel: string): string {
  return [
    `Run one pass of foo routine ${routine.id} on packet ${packetRel}.`,
    `Goal: ${routine.goal}`,
    `Observe only: ${routine.observeSources.join(", ") || "the packet artifacts"}.`,
    `Allowed actions: ${routine.allowedActions.join("; ") || "propose findings only"}.`,
    `Pause and ask a human when: ${routine.approvalBoundaries.join("; ") || "any irreversible or outbound action"}.`,
    `Verify with: ${routine.verifyCheck ?? "foo asp verify " + packetRel}.`,
    `Record the iteration to the packet ledger, then stop at a terminal state (${routine.terminalStates.join(", ") || "succeeded, blocked, exhausted"}).`,
  ].join("\n");
}

// Emit the per-runtime binding artifact: how THIS runtime arms the trigger and
// runs one pass. Read-only — prints to stdout for review before it is committed
// or armed; foo schedules nothing itself.
export function emitBinding(routine: Routine, runtime: RuntimeId, packetRel: string): string {
  const adapter = getAdapter(runtime);
  if (!adapter) throw new Error(`unknown runtime "${runtime}" — known: ${Object.keys(AGENT_ADAPTERS).join(", ")}`);

  const prompt = passPrompt(routine, packetRel);
  const oneLinePrompt = prompt.replace(/\n/g, " ");
  const invoke = adapter.invoke_template
    ? adapter.invoke_template.replace("{prompt}", oneLinePrompt).replace("{packet}", packetRel)
    : null;
  const cron = routine.trigger.cron ?? "<set trigger.cron>";

  const header = [
    `# foo routine binding — ${routine.id} → ${adapter.label} (${adapter.support})`,
    `# Canonical contract lives in the packet; this is only the ${adapter.label} binding.`,
    `# Review before arming. productfoo does not schedule this for you.`,
  ];

  if (runtime === "github-actions") {
    // CI is a meta-adapter: it has no invoke of its own (invoke_template is null)
    // but hosts another runtime's headless invocation on a cron, so it is handled
    // before the headless guard below.
    return [
      ...header,
      `# Hosts a headless runtime on a cron. Fill in the runtime step below.`,
      `name: foo-routine-${routine.id}`,
      `on:`,
      `  schedule:`,
      `    - cron: "${cron}"`,
      `jobs:`,
      `  ${routine.id.toLowerCase()}:`,
      `    runs-on: ubuntu-latest`,
      `    steps:`,
      `      - uses: actions/checkout@v4`,
      `      - name: run routine pass`,
      `        run: |`,
      `          # e.g. ${AGENT_ADAPTERS.codex.invoke_template?.replace("{prompt}", '"$PROMPT"')}`,
      `        env:`,
      `          PROMPT: ${JSON.stringify(oneLinePrompt)}`,
      "",
    ].join("\n");
  }

  if (!adapter.can_run_headless || !invoke) {
    return [
      ...header,
      `#`,
      `# ${adapter.label} cannot be driven headless today.`,
      `# Gap: ${adapter.notes}`,
      `# Fix: arm this routine via github-actions running a headless runtime, or bind to ${supportedLabels()}.`,
      "",
    ].join("\n");
  }

  // Schedule bindings render as a reviewable crontab line; manual/event note how
  // they fire instead.
  const trigger =
    routine.trigger.kind === "schedule"
      ? [`# Arm with cron (${routine.trigger.tz ?? "local"} time):`, `${cron}  ${invoke}`]
      : routine.trigger.kind === "event"
        ? [`# Fires on event: ${routine.trigger.event ?? "<set trigger.event>"}`, `# Invoke per pass:`, invoke]
        : [`# Manual — run per pass:`, invoke];

  return [...header, ...trigger, ""].join("\n");
}
