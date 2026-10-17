import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "./vendorYaml.js";

const TASK_STATUSES = ["todo", "doing", "blocked", "done", "dropped"];
const TASK_AGREEMENTS = ["agreed", "discovered", "suggested", "rejected"];
const AGENT_EVENT_TYPES = [
  "com.adaptivespec.task.created",
  "com.adaptivespec.task.updated",
  "com.adaptivespec.task.agreement_changed",
  "com.adaptivespec.task.status_changed",
  "com.adaptivespec.conflict.detected",
  "com.adaptivespec.code.changed",
  "com.adaptivespec.code.unmapped_change_detected",
];

export type JsonObject = Record<string, unknown>;

type ValidationOptions = {
  packetDir: string;
  label: string;
  requireSpecSections?: boolean;
  requiredSpecRef?: string;
  requireEvents?: boolean;
};

/** A packet is malformed or violates its contract; this is a finding, not a product failure. */
export class PacketValidationError extends Error {
  readonly code = "FOO_PACKET_VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "PacketValidationError";
  }
}

/** Stable across installed-CLI and project-local compiled copies of this module. */
export function isPacketValidationError(error: unknown): error is PacketValidationError {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && error.name === "PacketValidationError"
    && "code" in error
    && error.code === "FOO_PACKET_VALIDATION",
  );
}

function parseValidationYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PacketValidationError(message);
  }
}

function parseValidationJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PacketValidationError(error.message);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function asObject(value: unknown, pathLabel: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PacketValidationError(`${pathLabel} must be an object`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, pathLabel: string): unknown[] {
  if (!Array.isArray(value)) throw new PacketValidationError(`${pathLabel} must be an array`);
  return value;
}

function requireKeys(value: JsonObject, keys: string[], pathLabel: string): void {
  for (const key of keys) {
    if (!(key in value)) throw new PacketValidationError(`${pathLabel} missing ${key}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// YAML frontmatter is the canonical packet header (asp_v0 D-017 / T-013). A
// restamped packet carries `spec_id` (and title/mode/lifecycle/stage/owner/
// autonomy/updated) in a leading `--- ... ---` block; packets mid-migration
// still carry the flat `Spec ID:` line, which stays accepted as a fallback.
function parseFrontmatter(specText: string): JsonObject | null {
  if (!specText.startsWith("---")) return null;
  const end = specText.indexOf("\n---", 3);
  if (end === -1) return null;
  try {
    const parsed = parseYaml(specText.slice(3, end));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch (error) {
    if (error instanceof YAMLParseError) return null;
    throw error;
  }
}

function requireAgentIdentity(actor: JsonObject, pathLabel: string): void {
  requireKeys(actor, ["type", "id", "provider", "model", "persona", "skills", "adapter", "mode"], pathLabel);
  if (actor.type !== "agent") throw new PacketValidationError(`${pathLabel}.type must be agent`);
  asArray(actor.skills, `${pathLabel}.skills`);
}

function loadEvents(packetDir: string, eventSegments: string[], taskIds: Set<string>, label: string): JsonObject[] {
  const events: JsonObject[] = [];

  for (const segment of eventSegments) {
    const eventsPath = path.join(packetDir, segment);
    let eventsText: string;
    try {
      eventsText = readFileSync(eventsPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (segment === "events.jsonl") throw new PacketValidationError(`${segment} missing`);
      continue;
    }

    const lines = eventsText.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;

      const event = asObject(parseValidationJson(line), `${segment}:${index + 1}`);
      const pathLabel = `${segment}:${index + 1}`;
      requireKeys(event, ["specversion", "id", "source", "type", "subject", "time", "actor", "data"], pathLabel);

      const data = asObject(event.data, `${pathLabel}.data`);
      if ("freshness" in data) throw new PacketValidationError(`${pathLabel}.data.freshness must be derived, not stored`);

      const actor = asObject(event.actor, `${pathLabel}.actor`);
      const eventType = String(event.type);
      if (actor.type === "agent" && AGENT_EVENT_TYPES.includes(eventType)) {
        requireAgentIdentity(actor, `${pathLabel}.actor`);
      }

      if (eventType === "com.adaptivespec.task.status_changed") {
        const from = data.from;
        const to = data.to;
        if (!TASK_STATUSES.includes(String(from))) throw new PacketValidationError(`${pathLabel}.data.from invalid: ${from}`);
        if (!TASK_STATUSES.includes(String(to))) throw new PacketValidationError(`${pathLabel}.data.to invalid: ${to}`);
      }

      const subject = String(event.subject);
      if (subject.startsWith("task:")) {
        const taskId = subject.slice("task:".length);
        if (!taskIds.has(taskId)) throw new PacketValidationError(`${pathLabel}.subject references unknown task ${taskId}`);
      }

      events.push(event);
    });
  }

  if (events.length === 0) throw new PacketValidationError(`${label} validation failed: events missing`);
  return events;
}

// Errors that teach (foo-brand-presence-v0 R-007 / T-005): every validation
// failure states the concept, the fix, and the next command — the Rust-compiler
// bar — instead of a bare assertion.
function validationFixHint(message: string): string {
  if (/missing ##/.test(message)) return "add the missing section heading to spec.md";
  if (/spec_id must match/.test(message)) return "make tasks.yaml spec_id equal the spec.md frontmatter spec_id";
  if (/spec_ref/.test(message)) return "point tasks.yaml spec_ref at this packet's spec.md";
  if (/duplicated/.test(message)) return "give each task a unique id";
  if (/invalid/.test(message)) return "correct the value to one of the allowed options";
  if (/missing/.test(message)) return "add the missing file or field named above";
  return "correct the issue named above";
}

export function validatePacket(options: ValidationOptions): string {
  const fail = (message: string): never => {
    throw new PacketValidationError(
      [
        `${options.label} validation failed: ${message}`,
        "  Concept: a packet is valid when spec.md, tasks.yaml, and events.jsonl agree on identity and structure.",
        `  Fix: ${validationFixHint(message)}.`,
        `  Next: foo asp validate ${options.label}`,
      ].join("\n"),
    );
  };

  const specPath = path.join(options.packetDir, "spec.md");
  const tasksPath = path.join(options.packetDir, "tasks.yaml");
  let specText: string;
  try {
    specText = readFileSync(specPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) fail("spec.md missing");
    throw error;
  }
  if (options.requireSpecSections) {
    for (const section of [
      "## Intent",
      "## Current Understanding",
      "## Requirements",
      "## Decisions",
      "## Risks",
      "## Validation",
      "## Evidence",
      "## Open Questions",
    ]) {
      if (!specText.includes(section)) fail(`spec.md missing ${section}`);
    }
  }

  let tasksText: string;
  try {
    tasksText = readFileSync(tasksPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) fail("tasks.yaml missing");
    throw error;
  }
  const tasksDoc = asObject(parseValidationYaml(tasksText), "tasks.yaml");
  requireKeys(tasksDoc, ["schema_version", "spec_id", "spec_ref", "updated", "defaults", "tasks"], "tasks.yaml");

  if (options.requiredSpecRef && tasksDoc.spec_ref !== options.requiredSpecRef) {
    fail("tasks.yaml.spec_ref must point to spec.md");
  }

  const specId = stringValue(tasksDoc.spec_id);
  if (!specId) fail("tasks.yaml.spec_id must match spec.md");
  // Identity must agree with the spec header via either the canonical YAML
  // frontmatter `spec_id` (T-013) or the transitional `Spec ID:` line.
  const frontmatter = parseFrontmatter(specText);
  const frontmatterSpecId = frontmatter ? stringValue(frontmatter.spec_id) : null;
  const legacyLineMatches = new RegExp(
    `^Spec ID:\\s*${(specId as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "m",
  ).test(specText);
  if (frontmatterSpecId !== specId && !legacyLineMatches) {
    fail("tasks.yaml.spec_id must match spec.md frontmatter spec_id or the `Spec ID:` line");
  }

  const ledger = tasksDoc.ledger ? asObject(tasksDoc.ledger, "tasks.yaml.ledger") : null;
  if (ledger) {
    requireKeys(ledger, ["segment_order"], "tasks.yaml.ledger");
    const segmentOrder = asArray(ledger.segment_order, "tasks.yaml.ledger.segment_order");
    if (!segmentOrder.includes("events.jsonl")) {
      fail("tasks.yaml.ledger.segment_order must include events.jsonl");
    }
  }

  if (tasksDoc.freshness) {
    const freshness = asObject(tasksDoc.freshness, "tasks.yaml.freshness");
    requireKeys(freshness, ["external_observations"], "tasks.yaml.freshness");
    requireKeys(
      asObject(freshness.external_observations, "tasks.yaml.freshness.external_observations"),
      ["max_age_seconds"],
      "tasks.yaml.freshness.external_observations",
    );
  }

  if (tasksDoc.codebase) {
    requireKeys(
      asObject(tasksDoc.codebase, "tasks.yaml.codebase"),
      ["root", "baseline", "require_task_for_changes", "unmatched_change"],
      "tasks.yaml.codebase",
    );
  }

  const tasks = asArray(tasksDoc.tasks, "tasks.yaml.tasks");
  if (tasks.length === 0) fail("tasks.yaml.tasks must be a nonempty array");

  const taskIds = new Set<string>();
  const taskObjects = tasks.map((task, index) => {
    const taskObject = asObject(task, `tasks.yaml.tasks[${index}]`);
    const pathLabel = `tasks.yaml.tasks[${index}]`;
    requireKeys(
      taskObject,
      ["id", "title", "status", "agreement", "stage", "refs", "depends_on", "owner", "autonomy", "do", "done_when", "completed", "blocked", "review", "extensions"],
      pathLabel,
    );

    const id = String(taskObject.id);
    if (taskIds.has(id)) fail(`${pathLabel}.id duplicated`);
    taskIds.add(id);

    if (!TASK_STATUSES.includes(String(taskObject.status))) fail(`${pathLabel}.status invalid: ${taskObject.status}`);
    if (!TASK_AGREEMENTS.includes(String(taskObject.agreement))) {
      fail(`${pathLabel}.agreement invalid: ${taskObject.agreement}`);
    }
    asArray(taskObject.refs, `${pathLabel}.refs`);
    asArray(taskObject.do, `${pathLabel}.do`);
    asArray(taskObject.done_when, `${pathLabel}.done_when`).forEach((check, checkIndex) => {
      requireKeys(asObject(check, `${pathLabel}.done_when[${checkIndex}]`), ["id", "text", "done", "proof"], `${pathLabel}.done_when[${checkIndex}]`);
    });

    if (taskObject.status === "done") {
      requireKeys(asObject(taskObject.completed, `${pathLabel}.completed`), ["at", "by", "summary", "event"], `${pathLabel}.completed`);
    }

    if (taskObject.blocked) {
      requireKeys(asObject(taskObject.blocked, `${pathLabel}.blocked`), ["reason", "needs", "event"], `${pathLabel}.blocked`);
    }

    if (taskObject.agreement === "discovered" || taskObject.agreement === "suggested") {
      const review = asObject(taskObject.review, `${pathLabel}.review`);
      requireKeys(review, ["owner", "due", "stale_after_days"], `${pathLabel}.review`);
      if (!review.due) fail(`${pathLabel}.review.due required for ${taskObject.agreement} task`);
    }

    if (taskObject.created_by && asObject(taskObject.created_by, `${pathLabel}.created_by`).type === "agent") {
      const createdBy = asObject(taskObject.created_by, `${pathLabel}.created_by`);
      requireKeys(createdBy, ["type", "id", "provider", "model", "persona", "skills", "adapter"], `${pathLabel}.created_by`);
      asArray(createdBy.skills, `${pathLabel}.created_by.skills`);
    }

    return taskObject;
  });

  // evidence.yaml (discovery-review-verbs-v0 R-004): the optional home for
  // inbox evidence attached to this packet by `foo discovery review <F-id>
  // attach --packet <name>`. Absent is valid; present must be well-formed, or
  // attached evidence becomes an unvalidated side file.
  let evidenceText: string | null = null;
  try {
    evidenceText = readFileSync(path.join(options.packetDir, "evidence.yaml"), "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (evidenceText !== null) {
    try {
      const evidenceDoc = asObject(parseValidationYaml(evidenceText), "evidence.yaml");
      requireKeys(evidenceDoc, ["schema_version", "findings"], "evidence.yaml");
      const evidenceFindings = asArray(evidenceDoc.findings, "evidence.yaml.findings");
      const evidenceIds = new Set<string>();
      evidenceFindings.forEach((finding, index) => {
        const findingLabel = `evidence.yaml.findings[${index}]`;
        const findingObject = asObject(finding, findingLabel);
        requireKeys(findingObject, ["finding_id", "original_finding_id", "original_lane", "review_state"], findingLabel);
        const findingId = String(findingObject.finding_id);
        if (evidenceIds.has(findingId)) throw new PacketValidationError(`${findingLabel}.finding_id duplicated`);
        evidenceIds.add(findingId);
      });
    } catch (error) {
      if (isPacketValidationError(error)) fail(error.message);
      throw error;
    }
  }

  const segmentOrder = ledger ? asArray(ledger.segment_order, "tasks.yaml.ledger.segment_order").map(String) : ["events.jsonl"];
  const events = loadEvents(options.packetDir, segmentOrder, taskIds, options.label);
  const taskEvents = events.filter((event) => String(event.subject).startsWith("task:"));

  for (const task of taskObjects) {
    if (task.agreement !== "discovered" && task.agreement !== "suggested" && task.agreement !== "rejected") continue;
    const hasMatchingEvent = taskEvents.some((event) => event.subject === `task:${task.id}`);
    if (!hasMatchingEvent) fail(`task ${task.id} has agreement ${task.agreement} but no task event`);
  }

  return `${options.label} ok`;
}
