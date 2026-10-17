// Per-packet index derivation (cli-performance-v0 R-001).
//
// One module on purpose: the serial path in packetIndex.ts and the worker
// threads (packetIndexWorker.ts) must run the exact same reader, or the two
// paths drift. Each packet's tasks.yaml is read once and parsed once, spec.md
// is read once, and every derivation below consumes those single results —
// previously five reads + two YAML parses per packet (720 readFileSync across
// 141 packets, with 68% of self-time in the YAML parser).
//
// Pure with respect to the repo tree: reads only the packet's own files (plus
// the retired-packet verdict tail of events.jsonl). Throws on malformed input;
// callers decide the rendering.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "./vendorYaml.js";
import { isRetired } from "./packetLifecycle.js";
import { derivePacketStatusFromInputs, type PacketStatus } from "./packetStatus.js";
import { deriveSpecDecisionSignals, type SpecDecisionSignals } from "./specDecisionSignals.js";
import type { PacketIndexEntry } from "./packetIndex.js";

export function readPacketInput(dir: string, file: "tasks.yaml" | "spec.md"): string {
  try {
    return readFileSync(path.join(dir, file), "utf8");
  } catch (error) {
    // Mirror the shared reader's canonical missing-file message so a packet
    // whose file vanishes between listing and reading renders the same error
    // row `derivePacketStatus` produced before the refactor (exported for the
    // malformed-input tests that pin this message).
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${file} missing in ${dir}`);
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// The task list comes from the shared derivePacketStatus reader (D-002), fed
// the already-parsed tasks.yaml; the only field this index still reads from
// that document directly is `updated`.
function updatedFromTasksDoc(tasksDoc: unknown): string | null {
  return str(asRecord(tasksDoc).updated);
}

function readIntent(specText: string): string | null {
  let inIntent = false;
  for (const line of specText.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      inIntent = /^##\s+Intent\s*$/i.test(line);
      continue;
    }
    if (inIntent && line.trim() !== "") {
      const sentence = line.trim().split(/(?<=[.!?])\s/)[0];
      return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence;
    }
  }
  return null;
}

function readDecisionSignals(root: string, packetDir: string, specText: string): SpecDecisionSignals {
  return deriveSpecDecisionSignals(specText, path.relative(root, path.join(packetDir, "spec.md")));
}

function bucketOf(s: PacketStatus): PacketIndexEntry["bucket"] {
  // A retirement verdict outranks task math: a killed packet with 0/7 done is
  // not "open" backlog, it is retired intent (packet-lifecycle-v0 R-003).
  if (isRetired(s.lifecycle)) return "retired";
  if (s.tasks.total > 0 && s.tasks.done === s.tasks.total) return "proven";
  if (s.tasks.done === 0 && s.tasks.doing === 0) return "open";
  return "progress";
}

// Derive one packet's index entry: the single-pass read/parse/derive unit.
// A malformed packet never throws out of here — it renders as an error row
// (blank status + the error message), exactly as the index always rendered.
export function derivePacketEntry(root: string, dir: string): PacketIndexEntry {
  try {
    // Single pass (R-001): read tasks.yaml once, parse it once, read spec.md
    // once — every derivation below consumes those results.
    const tasksDoc = parseYaml(readPacketInput(dir, "tasks.yaml"));
    const specText = readPacketInput(dir, "spec.md");
    const status = derivePacketStatusFromInputs(dir, { tasksDoc, specText });
    return {
      ...status,
      updated: updatedFromTasksDoc(tasksDoc),
      intent: readIntent(specText),
      decision_signals: readDecisionSignals(root, dir, specText),
      bucket: bucketOf(status),
    };
  } catch (error) {
    const blank: PacketStatus = {
      packet: path.basename(dir),
      spec_id: path.basename(dir),
      title: null,
      lifecycle: null,
      lifecycle_stored: null,
      lifecycle_effective: "in_flight",
      lifecycle_drift: false,
      stage: null,
      mode: null,
      tasks: { total: 0, done: 0, doing: 0, blocked: 0, todo: 0, dropped: 0 },
      proof: { checks_total: 0, checks_done: 0 },
      requirements: { total: 0, covered: 0 },
      requirement_priorities: {},
      completed: [],
      task_list: [],
      blocked: [],
      stale: [],
      open_questions: [],
      next_action: { kind: "none", reason: "Packet status could not be read." },
      decision_findings: [],
      next: null,
      drift: { restamp: false },
      verdict: null,
      deep_checked: false,
    };
    return {
      ...blank,
      updated: null,
      intent: null,
      decision_signals: deriveSpecDecisionSignals(""),
      task_list: [],
      bucket: "open",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
