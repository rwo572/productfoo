// Cheap, safe write path for Adaptive Spec Packets (asp-cli-lifecycle-v0).
//
// `foo asp` could already read packets well; this closes the write side so a
// human or coding agent can scaffold a packet, append an event, and move a task
// without hand-editing events.jsonl or hand-choosing ids. Three guarantees:
//   - append-only: events are appended, prior ledger lines are never rewritten;
//   - collision-safe ids: every event id is a fresh ULID, re-rolled if a
//     (vanishingly unlikely) collision with an existing id is seen;
//   - legible actor identity: agent writers carry full identity, humans record
//     type "human" — and B1 refuses any write that smells like raw secrets.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import { decisionRequestAuthoringComment } from "./specSections.js";
import { UsageError } from "./errorTaxonomy.js";

const TASK_STATUSES = ["todo", "doing", "blocked", "done", "dropped"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

export type JsonObject = Record<string, unknown>;

// --- ULID (Crockford base32, 10 time chars + 16 random) ---------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()): string {
  let time = now;
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    timeChars.unshift(CROCKFORD[time % 32]);
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[bytes[i] % 32];
  return timeChars.join("") + rand;
}

function existingEventIds(eventsPath: string): Set<string> {
  if (!existsSync(eventsPath)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as JsonObject).id;
      if (typeof id === "string") ids.add(id);
    } catch {
      // A malformed prior line is a read concern, not a uniqueness concern.
    }
  }
  return ids;
}

function freshEventId(eventsPath: string): string {
  const taken = existingEventIds(eventsPath);
  let id = ulid();
  while (taken.has(id)) id = ulid();
  return id;
}

// --- B1 safety: refuse writes that carry raw private material ---------------

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "a private key block" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "an AWS access key id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: "a GitHub token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "an API secret key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "a Slack token" },
  { re: /(?:password|passwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S{8,}/i, label: "a secret assignment" },
];

export function findSecretLeak(text: string): string | null {
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

function guardSafety(payload: unknown): void {
  const leak = findSecretLeak(JSON.stringify(payload));
  if (leak) {
    throw new Error(
      `refusing write: payload looks like raw private material (${leak}). B1 safety blocks committing secrets into the ledger.`,
    );
  }
}

// --- Actor identity ---------------------------------------------------------

export type Actor = JsonObject & { type: string; id: string };

// AGENT_EVENT_TYPES require full agent identity in the validator; status_changed
// is one of them, so an agent writer must present complete identity here.
function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveActor(overrides: { type?: string; id?: string } = {}): Actor {
  const type = overrides.type ?? env("FOO_ACTOR_TYPE") ?? "human";
  if (type === "agent") {
    return {
      type: "agent",
      id: overrides.id ?? env("FOO_ACTOR_ID") ?? "agent:unknown",
      provider: env("FOO_ACTOR_PROVIDER") ?? "unknown",
      model: env("FOO_ACTOR_MODEL") ?? "unknown",
      persona: env("FOO_ACTOR_PERSONA") ?? "unknown",
      skills: env("FOO_ACTOR_SKILLS") ? env("FOO_ACTOR_SKILLS")!.split(",").map((s) => s.trim()).filter(Boolean) : [],
      adapter: env("FOO_ACTOR_ADAPTER") ?? "unknown",
      mode: env("FOO_ACTOR_MODE") ?? "human-in-loop",
    };
  }
  return { type: "human", id: overrides.id ?? env("FOO_ACTOR_ID") ?? "human" };
}

// --- Append-only event write ------------------------------------------------

export type AppendEventOptions = {
  packetDir: string;
  type: string;
  subject?: string;
  data?: JsonObject;
  actor?: { type?: string; id?: string };
  now?: Date;
};

function specIdOf(packetDir: string): string {
  const doc = parseYaml(readFileSync(path.join(packetDir, "tasks.yaml"), "utf8")) as JsonObject;
  const id = doc?.spec_id;
  if (typeof id !== "string") throw new Error("tasks.yaml is missing a string spec_id");
  return id;
}

export function appendEvent(options: AppendEventOptions): JsonObject {
  if (!existsSync(path.join(options.packetDir, "tasks.yaml"))) {
    throw new Error(`not a packet directory (no tasks.yaml): ${options.packetDir}`);
  }
  const eventsPath = path.join(options.packetDir, "events.jsonl");
  const now = options.now ?? new Date();
  const data = options.data ?? {};
  const actor = resolveActor(options.actor);

  const event: JsonObject = {
    specversion: "1.0",
    id: freshEventId(eventsPath),
    source: "foo-cli",
    type: options.type,
    subject: options.subject ?? `packet:${specIdOf(options.packetDir)}`,
    time: now.toISOString(),
    actor,
    data,
  };

  guardSafety(event);

  // Append-only: a trailing newline is ensured without rewriting prior lines.
  const prefix = existsSync(eventsPath) && readFileSync(eventsPath, "utf8").length > 0 && !readFileSync(eventsPath, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(eventsPath, `${prefix}${JSON.stringify(event)}\n`);
  return event;
}

// --- Task status write ------------------------------------------------------

export type UpdateTaskOptions = {
  packetDir: string;
  taskId: string;
  status: string;
  proof?: string;
  summary?: string;
  reason?: string;
  needs?: string[];
  actor?: { type?: string; id?: string };
  now?: Date;
};

function findTaskBlock(text: string, taskId: string, tasksPath: string): { start: number; end: number; indent: string } {
  const lines = text.split("\n");
  let start = -1;
  let indent = "";
  for (let i = 0; i < lines.length; i += 1) {
    // The locator must accept every id shape the YAML reader accepts: quoted
    // (both styles) and a trailing comment (#776).
    const m = lines[i].match(/^(\s*)-\s+id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))(?:\s+#.*)?\s*$/);
    const id = m?.[2] ?? m?.[3] ?? m?.[4];
    if (m && id === taskId) {
      start = i;
      indent = m[1];
      break;
    }
  }
  if (start === -1) {
    // The reader accepted this id but the writer's locator could not place the
    // block. A usage error names the packet and id and never files a capsule.
    throw new UsageError(`task ${taskId} not found in tasks.yaml (${tasksPath})`, "E_BAD_FLAG");
  }

  // The block runs until the next list item at the same indent, or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp(`^${indent}-\\s`).test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, indent };
}

export function updateTask(options: UpdateTaskOptions): { event: JsonObject; from: string; to: string } {
  // `--status bogus` is a typo, not a defect. As a bare Error it classified as
  // command_error, so `foo asp task <p> T-001 --status dnoe` PAGED and filed a
  // Bug Capsule — against productfoo's own promise that "a typo or a blocked gate never
  // produces a capsule at all". A queue full of the reader's spelling mistakes is
  // exactly the noise that teaches people to stop reading the queue.
  if (!TASK_STATUSES.includes(options.status as TaskStatus)) {
    throw new UsageError(`invalid status: ${options.status} (expected ${TASK_STATUSES.join(", ")})`, "E_BAD_FLAG");
  }
  const tasksPath = path.join(options.packetDir, "tasks.yaml");
  if (!existsSync(tasksPath)) throw new Error(`not a packet directory (no tasks.yaml): ${options.packetDir}`);

  const text = readFileSync(tasksPath, "utf8");
  const doc = parseYaml(text) as JsonObject;
  const tasks = Array.isArray(doc.tasks) ? (doc.tasks as JsonObject[]) : [];
  const task = tasks.find((t) => t && t.id === options.taskId);
  // A typo'd or pasted-quoted id is a usage mistake, not a foo defect —
  // UsageError classifies as command error and never files a Bug Capsule (#776).
  if (!task) throw new UsageError(`task ${options.taskId} not found in tasks.yaml (${tasksPath})`, "E_BAD_FLAG");

  const from = typeof task.status === "string" ? task.status : "todo";
  const to = options.status;
  const now = options.now ?? new Date();

  guardSafety({ proof: options.proof, summary: options.summary, reason: options.reason });

  // The block locator is a parallel scan over the raw text, so it can fail where
  // the tolerant YAML reader succeeded (a quoted id, a trailing comment). Resolve
  // it BEFORE the ledger append: on failure nothing has been written yet, so the
  // ledger can never claim a transition tasks.yaml doesn't carry, and a corrected
  // retry appends exactly one event (#776).
  const block = findTaskBlock(text, options.taskId, tasksPath);
  const lines = text.split("\n");

  // The event is appended first so its id can be referenced from the task block;
  // everything fallible between here and the tasks.yaml write is already resolved.
  const event = appendEvent({
    packetDir: options.packetDir,
    type: "com.adaptivespec.task.status_changed",
    subject: `task:${options.taskId}`,
    data: {
      from,
      to,
      ...(options.proof ? { proof: options.proof } : {}),
      ...(options.summary ? { summary: options.summary } : {}),
    },
    actor: options.actor,
    now,
  });

  // Build the replacement task block from the structured object, then splice it
  // back in place so surrounding tasks and ledger lines are untouched.
  const updated: JsonObject = { ...task, status: to };

  if (to === "done") {
    updated.completed = {
      at: now.toISOString(),
      by: event.actor && typeof event.actor === "object" ? (event.actor as JsonObject).id : "human",
      summary: options.summary ?? `Marked ${options.taskId} done.`,
      event: event.id,
    };
    updated.blocked = null;
    if (Array.isArray(updated.done_when)) {
      updated.done_when = (updated.done_when as JsonObject[]).map((check) => ({
        ...check,
        done: true,
        ...(options.proof ? { proof: options.proof } : {}),
      }));
    }
  } else if (to === "blocked") {
    updated.blocked = {
      reason: options.reason ?? options.summary ?? `${options.taskId} is blocked.`,
      needs: options.needs ?? ["resolve the blocker before continuing"],
      event: event.id,
    };
  }

  const rendered = renderTaskBlock(updated, block.indent);
  const next = [...lines.slice(0, block.start), ...rendered, ...lines.slice(block.end)].join("\n");

  // Temp-plus-rename so a torn write can never leave half a tasks.yaml behind a
  // ledger event that already claims the transition (#776).
  const temp = `${tasksPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, next);
    renameSync(temp, tasksPath);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }

  return { event, from, to };
}

// Minimal, stable YAML renderer for a single task block. Keys are emitted in the
// canonical packet order so a written task reads like a hand-authored one.
const TASK_KEY_ORDER = [
  "id", "title", "status", "agreement", "stage", "refs", "depends_on", "owner",
  "autonomy", "created_by", "touches", "do", "done_when", "completed", "blocked",
  "review", "extensions",
];

function renderTaskBlock(task: JsonObject, indent: string): string[] {
  const lines: string[] = [];
  const itemIndent = indent;
  const fieldIndent = `${indent}  `;
  const keys = [...TASK_KEY_ORDER.filter((k) => k in task), ...Object.keys(task).filter((k) => !TASK_KEY_ORDER.includes(k))];
  keys.forEach((key, i) => {
    const prefix = i === 0 ? `${itemIndent}- ` : `${fieldIndent}`;
    lines.push(...renderField(key, task[key], prefix, `${fieldIndent}  `));
  });
  return lines;
}

function renderField(key: string, value: unknown, prefix: string, childIndent: string): string[] {
  if (value === null || value === undefined) return [`${prefix}${key}: null`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${key}: []`];
    const lines = [`${prefix}${key}:`];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as JsonObject);
        entries.forEach(([k, v], idx) => {
          const p = idx === 0 ? `${childIndent}- ` : `${childIndent}  `;
          lines.push(...renderField(k, v, p, `${childIndent}    `));
        });
      } else {
        lines.push(`${childIndent}- ${scalar(item)}`);
      }
    }
    return lines;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonObject);
    if (entries.length === 0) return [`${prefix}${key}: {}`];
    const lines = [`${prefix}${key}:`];
    for (const [k, v] of entries) lines.push(...renderField(k, v, `${childIndent}`, `${childIndent}  `));
    return lines;
  }
  return [`${prefix}${key}: ${scalar(value)}`];
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (s === "" || /[:#\[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|~)$/i.test(s) || /^[-?]/.test(s) || /^\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// --- Scaffold (foo asp init) ------------------------------------------------

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type InitOptions = {
  root: string;
  name: string;
  now?: Date;
};

export type InitResult = { packetDir: string; specId: string; relSpecRef: string };

export function initPacket(options: InitOptions): InitResult {
  const now = options.now ?? new Date();
  const name = options.name;
  if (!name || /[^A-Za-z0-9_./-]/.test(name)) throw new Error("packet name must be a slug or path (letters, digits, -, _, /)");

  // A name with a separator is treated as a path; otherwise it lands under specs/.
  const relDir = name.includes("/") ? name : path.posix.join("specs", name);
  const packetDir = path.resolve(options.root, relDir);
  if (existsSync(packetDir)) throw new Error(`refusing to overwrite existing directory: ${relDir}`);

  const base = path.basename(packetDir);
  const specId = base.replace(/-/g, "_");
  const title = titleCase(base);
  const relSpecRef = path.relative(options.root, path.join(packetDir, "spec.md")).split(path.sep).join("/");
  const isoDate = now.toISOString().slice(0, 10);

  mkdirSync(packetDir, { recursive: true });

  const specMd = `---
spec_id: ${specId}
title: ${title}
mode: capability
lifecycle: draft
stage: exploring
owner: product
autonomy: human-in-loop
updated: ${isoDate}
---

# ${title}

<!-- Identity (\`spec_id\`) is read from the YAML frontmatter above. Progress is rendered by \`foo asp status\`, never stored here. -->

## Intent

State the product bet in one or two sentences: what this packet is for and why now.

## Current Understanding

- What is already true in the repo and approved sources.

## Requirements

### R-001 First requirement

- Priority: P1
- Risk: medium
- Confidence: low

Describe the first requirement this packet must satisfy.

## Decisions

- D-001 — (open) Record decisions as they are made.

## Risks

- RISK-001 — The dominant risk and how it will be surfaced.

## Validation

- V-001 — How a reviewer confirms the work matches intent.

## Evidence

- Links to repo, approved sources, and proof as it accrues.

## Open Questions

${decisionRequestAuthoringComment()}
`;

  const tasksYaml = `schema_version: "0.1"
spec_id: ${specId}
spec_ref: ${relSpecRef}
updated: "${now.toISOString()}"

defaults:
  autonomy: human-in-loop
  stale_after_days:
    suggested: 7
    discovered: 7

ledger:
  segment_order:
    - events.jsonl

tasks:
  - id: T-001
    title: Shape the packet intent and first requirement
    status: todo
    agreement: agreed
    stage: shaping
    refs:
      - R-001
    depends_on: []
    owner: agent:any
    autonomy: human-in-loop
    created_by:
      type: human
      id: product
    touches:
      - ${relSpecRef}
    do:
      - Capture the intent and current understanding from approved sources.
      - Write the first requirement and its acceptance check.
    done_when:
      - id: C-001
        text: Intent and R-001 are written into spec.md.
        done: false
        proof: null
    completed: null
    blocked: null
    review:
      owner: product
      due: null
      stale_after_days: null
    extensions: {}
`;

  writeFileSync(path.join(packetDir, "spec.md"), specMd);
  writeFileSync(path.join(packetDir, "tasks.yaml"), tasksYaml);
  writeFileSync(path.join(packetDir, "events.jsonl"), "");

  // Genesis event: subject is the packet (not a task), so no task-event matching
  // is triggered and the scaffold validates with no manual edits.
  appendEvent({
    packetDir,
    type: "com.adaptivespec.packet.created",
    subject: `packet:${specId}`,
    data: { summary: "Packet scaffolded by foo asp init.", spec_ref: relSpecRef },
    now,
  });

  return { packetDir, specId, relSpecRef };
}
