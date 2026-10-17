import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import type { BugCapsule } from "./bugCapsule.js";

export type BugSpecContext = NonNullable<NonNullable<BugCapsule["extensions"]["foo"]>["spec_context"]>;

const MAX_STRING_LENGTH = 4_096;
const MAX_ARRAY_LENGTH = 100;
const SPEC_ID = /^[a-z][a-z0-9_]{0,127}$/;
const TASK_ID = /^T-\d{3}$/;
const REQUIREMENT_ID = /^R-\d{3}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const PACKET_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  asp: new Set(["validate", "migrate", "reconcile", "verify", "status", "event", "task", "verdict"]),
  loop: new Set(["design", "check", "status", "estimate", "routine"]),
  source: new Set(["discover", "approve", "revoke", "claim", "receipt"]),
};

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH ? value : undefined;
}

function packetArgument(domain: string, args: string[]): string | undefined {
  if (domain === "estimate") return args[1];
  const allowed = PACKET_COMMANDS[domain];
  return allowed?.has(args[1] ?? "") ? args[2] : undefined;
}

function safePacketPath(value: string): boolean {
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments[0] === "specs" && segments.every((segment) => PATH_SEGMENT.test(segment));
}

function rfc3339(value: unknown): string | undefined {
  const candidate = bounded(value);
  if (!candidate) return undefined;
  const match = RFC_3339.exec(candidate);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59
  ) return undefined;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() + 1 !== Number(month) ||
    calendar.getUTCDate() !== Number(day) ||
    Number.isNaN(Date.parse(candidate))
  ) return undefined;
  return candidate;
}

/**
 * Resolve only the packet argument positions owned by packet-aware commands.
 * Packet content is never consulted: tasks.yaml is the complete metadata source.
 */
export function resolveBugSpecContext(root: string, domain: string, args: string[]): BugSpecContext | undefined {
  const packetArg = packetArgument(domain, args);
  if (!packetArg || !safePacketPath(packetArg)) return undefined;

  try {
    const lexicalRoot = path.resolve(root);
    const lexicalSpecs = path.join(lexicalRoot, "specs");
    const lexicalPacket = path.resolve(lexicalRoot, packetArg);
    if (!inside(lexicalSpecs, lexicalPacket) || lexicalPacket === lexicalSpecs) return undefined;

    const realRoot = realpathSync(lexicalRoot);
    const realSpecs = realpathSync(lexicalSpecs);
    const realPacket = realpathSync(lexicalPacket);
    if (!inside(realRoot, realSpecs) || !inside(realSpecs, realPacket) || realPacket === realSpecs) return undefined;

    const tasksPath = path.join(realPacket, "tasks.yaml");
    const realTasksPath = realpathSync(tasksPath);
    if (!inside(realPacket, realTasksPath) || !inside(realSpecs, realTasksPath)) return undefined;

    const document = object(parseYaml(readFileSync(realTasksPath, "utf8")));
    if (!document) return undefined;
    const specId = bounded(document.spec_id);
    if (!specId || !SPEC_ID.test(specId)) return undefined;
    if (!specId || !Array.isArray(document.tasks) || document.tasks.length > MAX_ARRAY_LENGTH) return undefined;

    let requirementIds: string[] = [];
    let taskIds: string[] = [];
    if (domain === "asp" && args[1] === "task") {
      const taskId = bounded(args[3]);
      if (!taskId || !TASK_ID.test(taskId)) return undefined;
      const matches = document.tasks
        .map(object)
        .filter((task): task is Record<string, unknown> => task !== undefined && task.id === taskId);
      if (matches.length !== 1) return undefined;
      const refs = matches[0].refs;
      if (!Array.isArray(refs) || refs.length > MAX_ARRAY_LENGTH) return undefined;
      if (refs.some((ref) => typeof ref === "string" && ref.startsWith("R-") && !REQUIREMENT_ID.test(ref))) return undefined;
      requirementIds = refs.filter((ref): ref is string => typeof ref === "string" && REQUIREMENT_ID.test(ref));
      if (requirementIds.some((ref) => ref.length > MAX_STRING_LENGTH)) return undefined;
      taskIds = [taskId];
    }

    const packetPath = path.relative(realRoot, realPacket).split(path.sep).join("/");
    if (!packetPath || packetPath.length > MAX_STRING_LENGTH || !safePacketPath(packetPath)) return undefined;
    const revision = document.updated === undefined ? undefined : rfc3339(document.updated);
    if (document.updated !== undefined && !revision) return undefined;

    return {
      spec_id: specId,
      packet_path: packetPath,
      ...(revision ? { revision } : {}),
      requirement_ids: requirementIds,
      task_ids: taskIds,
      provenance: "reporter_observed",
    };
  } catch {
    return undefined;
  }
}
