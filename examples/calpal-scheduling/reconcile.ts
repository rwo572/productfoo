import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "../../src/vendorYaml.js";
import type { PacketContext } from "../../src/cli.js";

type JsonObject = Record<string, unknown>;

type Task = JsonObject & {
  id: string;
  status: string;
  agreement: string;
  touches?: string[];
  review?: { due?: string };
};

type Event = JsonObject & {
  id: string;
  type: string;
  subject: string;
  time: string;
  data: JsonObject;
  _segment: string;
  _segment_index: number;
  _line: number;
};

export type ReconcileOptions = {
  asOf: Date;
  changedFiles: string[];
  gitDiff: boolean;
  packetDir?: string;
  root?: string;
};

type Finding = JsonObject & {
  kind: string;
  severity?: string;
  task_id?: string;
  subject?: string;
  file?: string;
  _key?: string;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(moduleDir, "..", "..", "..");
const DEFAULT_PACKET_DIR = path.join(DEFAULT_ROOT, "examples", "calpal-scheduling");

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function parseArgs(args: string[]): Omit<ReconcileOptions, "packetDir" | "root"> {
  const options = {
    asOf: new Date(),
    changedFiles: [] as string[],
    gitDiff: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--as-of") {
      const value = args[index + 1];
      if (!value) throw new Error("--as-of requires a value");
      options.asOf = new Date(value);
      if (Number.isNaN(options.asOf.getTime())) throw new Error(`invalid --as-of value: ${value}`);
      index += 1;
    } else if (arg === "--changed-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--changed-file requires a value");
      options.changedFiles.push(value);
      index += 1;
    } else if (arg === "--git-diff") {
      options.gitDiff = true;
    } else {
      throw new Error(`unknown reconcile argument: ${arg}`);
    }
  }

  return options;
}

function loadEvents(packetDir: string, segmentOrder: string[]): Event[] {
  const events: Event[] = [];

  segmentOrder.forEach((segment, segmentIndex) => {
    const eventPath = path.join(packetDir, segment);
    if (!existsSync(eventPath)) return;

    readFileSync(eventPath, "utf8").split(/\r?\n/).forEach((line, lineIndex) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as Event;
      events.push({
        ...event,
        _segment: segment,
        _segment_index: segmentIndex,
        _line: lineIndex + 1,
      });
    });
  });

  return events.sort((left, right) => {
    const leftKey = [new Date(left.time).getTime(), left._segment_index, left._line];
    const rightKey = [new Date(right.time).getTime(), right._segment_index, right._line];
    return leftKey[0] - rightKey[0] || leftKey[1] - rightKey[1] || leftKey[2] - rightKey[2];
  });
}

function freshnessFor(event: Event, asOf: Date, maxAgeSeconds: number): JsonObject | null {
  const syncedAt = typeof event.data.synced_at === "string" ? event.data.synced_at : null;
  const observedAt = typeof event.data.observed_at === "string" ? event.data.observed_at : null;
  if (!syncedAt && !observedAt) return null;

  const referenceTime = new Date(syncedAt ?? observedAt ?? "");
  const ageSeconds = (asOf.getTime() - referenceTime.getTime()) / 1000;
  const state = ageSeconds < 0 ? "unknown" : ageSeconds <= maxAgeSeconds ? "fresh" : "stale";

  return {
    event_id: event.id,
    type: event.type,
    subject: event.subject,
    observed_at: observedAt,
    synced_at: syncedAt,
    max_age_seconds: maxAgeSeconds,
    derived_freshness: state,
  };
}

function taskDoneOrDropped(task: Task): boolean {
  return task.status === "done" || task.status === "dropped";
}

function touchMatches(touch: string, changedFile: string): boolean {
  return touch.endsWith("/") ? changedFile.startsWith(touch) : changedFile === touch;
}

function tasksForChangedFile(tasks: Task[], changedFile: string): Task[] {
  return tasks.filter((task) => (task.touches ?? []).some((touch) => touchMatches(touch, changedFile)));
}

function gitChangedFiles(root: string): string[] {
  const output = execFileSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function addFinding(findings: Finding[], finding: Finding): void {
  const key = [finding.kind, finding.task_id, finding.subject, finding.file].filter(Boolean).join("|");
  if (findings.some((existing) => existing._key === key)) return;
  findings.push({ ...finding, _key: key });
}

function addSpecTaskDriftFinding(packetDir: string, tasks: Task[], findings: Finding[]): void {
  const specText = readFileSync(path.join(packetDir, "spec.md"), "utf8");
  const taskText = tasks
    .flatMap((task) => {
      const steps = Array.isArray(task.do) ? task.do.map(String) : [];
      const checks = Array.isArray(task.done_when)
        ? task.done_when.map((check) => String(asObject(check).text ?? ""))
        : [];
      return [task.title, ...steps, ...checks];
    })
    .join("\n");

  const specIsAgenticEa = /agentic executive assistant|agentic EA|delegated scheduling/i.test(specText);
  const tasksStillSchedulingLink =
    /public scheduling links|scheduling link|booking page|guest booking page/i.test(taskText);

  if (!specIsAgenticEa || !tasksStillSchedulingLink) return;

  addFinding(findings, {
    kind: "spec_task_semantic_drift",
    severity: "high",
    subject: "packet:calpal_scheduling_v0",
    summary: "spec.md now describes an agentic EA, but tasks.yaml still carries scheduling-link and booking-page work from the prior product model.",
    suggested_actions: [
      "run interview-me and approve an intake summary",
      "update tasks.yaml from the approved agentic EA scope",
      "mark old scheduling-link tasks as preserved, dropped, or superseded",
    ],
    requires_human: true,
  });
}

export async function reconcileCalPalScheduling(options: ReconcileOptions) {
  const packetDir = options.packetDir ?? DEFAULT_PACKET_DIR;
  const root = options.root ?? DEFAULT_ROOT;
  const tasksDoc = parseYaml(readFileSync(path.join(packetDir, "tasks.yaml"), "utf8")) as JsonObject;
  const tasks = (tasksDoc.tasks as Task[]) ?? [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const segmentOrder = ((asObject(tasksDoc.ledger).segment_order as string[] | undefined) ?? ["events.jsonl"]);
  const events = loadEvents(packetDir, segmentOrder);

  let changedFileInputs = [...options.changedFiles];
  if (changedFileInputs.length === 0 && options.gitDiff) changedFileInputs = gitChangedFiles(root);

  const maxAgeSeconds =
    Number(asObject(asObject(tasksDoc.freshness).external_observations).max_age_seconds) || 3600;
  const externalObservations = events.flatMap((event) => {
    const observation = freshnessFor(event, options.asOf, maxAgeSeconds);
    return observation ? [observation] : [];
  });

  const findings: Finding[] = [];
  addSpecTaskDriftFinding(packetDir, tasks, findings);

  const changedFiles = [...new Set(changedFileInputs)].sort().map((changedFile) => {
    const mappedTasks = tasksForChangedFile(tasks, changedFile);
    const agreements = Object.fromEntries(mappedTasks.map((task) => [task.id, task.agreement]));
    const state =
      mappedTasks.length === 0
        ? "unmapped"
        : Object.values(agreements).includes("agreed")
          ? "agreed"
          : "unagreed";

    if (state === "unmapped") {
      addFinding(findings, {
        kind: "unmapped_changed_file",
        severity: "high",
        file: changedFile,
        subject: `file:${changedFile}`,
        summary: "Changed file does not map to any task touchpoint.",
        candidate_tasks: [],
        suggested_actions: ["map file to an agreed task", "create a discovered task", "revert file change"],
        requires_human: true,
      });
    } else if (state === "unagreed") {
      addFinding(findings, {
        kind: "changed_file_without_agreed_task",
        severity: "high",
        file: changedFile,
        subject: `file:${changedFile}`,
        summary: "Changed file maps only to tasks that are not agreed.",
        candidate_tasks: mappedTasks.map((task) => task.id),
        candidate_task_agreements: agreements,
        suggested_actions: ["accept related task", "reject related task", "revert file change"],
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

  for (const task of tasks) {
    if (task.agreement !== "suggested") continue;
    if (taskDoneOrDropped(task)) continue;

    const due = task.review?.due;
    if (!due || new Date(`${due}T00:00:00Z`) >= options.asOf) continue;

    addFinding(findings, {
      kind: "stale_suggested_task",
      severity: "medium",
      task_id: task.id,
      summary: `${task.id} is suggested, not agreed, and review was due on ${due}.`,
      suggested_actions: ["accept task as agreed", "reject task", "refresh review due date with reason"],
      requires_human: true,
    });
  }

  for (const event of events) {
    if (event.type !== "com.adaptivespec.code.unmapped_change_detected") continue;

    const candidateTasks = (event.data.candidate_tasks as string[] | undefined) ?? [];
    const agreements = Object.fromEntries(
      candidateTasks.map((taskId) => [taskId, tasksById.get(taskId)?.agreement ?? "unknown"]),
    );
    if (Object.values(agreements).includes("agreed")) continue;

    addFinding(findings, {
      kind: "unagreed_work",
      severity: "high",
      file: typeof event.data.changed_file === "string" ? event.data.changed_file : undefined,
      subject: event.subject,
      summary: typeof event.data.summary === "string" ? event.data.summary : undefined,
      candidate_tasks: candidateTasks,
      candidate_task_agreements: agreements,
      source_event: event.id,
      suggested_actions: (event.data.suggested_actions as string[] | undefined) ?? [],
      requires_human: true,
    });
  }

  const doneRecordEvents = events.filter(
    (event) =>
      event.type === "com.adaptivespec.external.record.synced" &&
      asObject(event.data.fields).status === "Done",
  );

  const mergedTaskIds = events.flatMap((event) => {
    if (event.type !== "com.adaptivespec.external.work.pr_merged") return [];
    return ((event.data.maps_to as string[] | undefined) ?? []).map((subject) => subject.replace(/^task:/, ""));
  });

  if (doneRecordEvents.length > 0) {
    for (const task of tasks) {
      if (task.agreement !== "agreed") continue;
      if (taskDoneOrDropped(task)) continue;
      if (mergedTaskIds.includes(task.id)) continue;

      addFinding(findings, {
        kind: "record_done_without_work_evidence",
        severity: "high",
        task_id: task.id,
        subject: `task:${task.id}`,
        summary: `An external record is Done, but agreed task ${task.id} has no mapped merged work evidence.`,
        record_events: doneRecordEvents.map((event) => event.id),
        suggested_actions: ["move external record back to In Progress", "link merged work evidence", "mark task dropped with reason"],
        requires_human: true,
      });
    }
  }

  return {
    spec_id: tasksDoc.spec_id,
    as_of: options.asOf.toISOString().replace(".000Z", "Z"),
    ledger: {
      segment_order: segmentOrder,
      event_count: events.length,
    },
    external_observations: externalObservations,
    changed_files: changedFiles,
    findings: findings.map(({ _key, ...finding }) => finding),
  };
}

export function reconcilePacket(context: PacketContext & { args: string[] }) {
  return reconcileCalPalScheduling({
    ...parseArgs(context.args),
    packetDir: context.packetDir,
    root: context.root,
  });
}
