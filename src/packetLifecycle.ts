// Packet lifecycle verdicts (packet-lifecycle-v0).
//
// productfoo could already say todo/doing/done/blocked — but not "we decided not to
// do this." Abandonment is a verdict, and a tool whose thesis is that verdicts
// carry reasons needs a recorded, reversible way to retire intent. Two terminal
// states close that gap:
//   - parked: still plausible, deliberately deferred; may come back.
//   - killed: the idea is dead or superseded; it will not come back as-is.
// Completion is the third terminal verdict (packet-lifecycle-truth-v0 R-003):
//   - done: the work shipped and its proofs are in — the same audited
//     mechanism as retirement, so every terminal transition rides one trail.
// All REQUIRE a reason (R-002): an unreasoned verdict is exactly the silent
// bookkeeping this module exists to prevent. `active` reopens a terminal packet
// (also with a reason), so every transition is reversible and auditable.
//
// The verdict lives in two places, written together:
//   - spec.md frontmatter `lifecycle:` — the canonical stamp the status/index
//     readers already consume;
//   - a `com.adaptivespec.packet.lifecycle_changed` event carrying {from, to,
//     reason} — the append-only audit trail (and B1-guarded via appendEvent).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, type JsonObject } from "./packetWrite.js";

export const VERDICT_STATES = ["parked", "killed", "active", "done"] as const;
export type VerdictState = (typeof VERDICT_STATES)[number];

export const RETIRED_LIFECYCLES = new Set(["parked", "killed"]);

export function isRetired(lifecycle: string | null | undefined): lifecycle is "parked" | "killed" {
  return typeof lifecycle === "string" && RETIRED_LIFECYCLES.has(lifecycle);
}

// Terminal states end a packet's story: retirement (parked/killed) and
// completion (done, plus the legacy `built` stamp some packets carry). A
// terminal header is a recorded disposition, so the lifecycle-truth reader
// (packet-lifecycle-truth-v0 R-001) never flags it as drift over task math —
// a parked packet at 0% tasks is a decision, not a contradiction.
export const TERMINAL_LIFECYCLES = new Set(["parked", "killed", "done", "built"]);

export function isTerminal(lifecycle: string | null | undefined): boolean {
  return typeof lifecycle === "string" && TERMINAL_LIFECYCLES.has(lifecycle);
}

export const LIFECYCLE_EVENT_TYPE = "com.adaptivespec.packet.lifecycle_changed";

// --- Frontmatter restamp -----------------------------------------------------

// Rewrites only the `lifecycle:` (and `updated:`) lines inside the leading
// frontmatter block; every other byte of spec.md is preserved. A missing
// lifecycle line is inserted before the closing delimiter rather than guessed
// into position.
function restampFrontmatter(specPath: string, lifecycle: string, isoDate: string): { from: string | null } {
  const text = readFileSync(specPath, "utf8");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error(`spec.md has no YAML frontmatter to restamp: ${specPath}`);

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error(`spec.md frontmatter never closes: ${specPath}`);

  let from: string | null = null;
  let stamped = false;
  for (let i = 1; i < close; i += 1) {
    const m = lines[i].match(/^lifecycle:\s*(\S+)/);
    if (m) {
      from = m[1];
      lines[i] = `lifecycle: ${lifecycle}`;
      stamped = true;
    } else if (/^updated:\s*/.test(lines[i])) {
      lines[i] = `updated: ${isoDate}`;
    }
  }
  if (!stamped) {
    lines.splice(close, 0, `lifecycle: ${lifecycle}`);
  }
  writeFileSync(specPath, lines.join("\n"));
  return { from };
}

// --- Verdict write ------------------------------------------------------------

export type VerdictOptions = {
  packetDir: string;
  state: VerdictState;
  reason: string;
  actor?: { type?: string; id?: string };
  now?: Date;
};

export type VerdictResult = { event: JsonObject; from: string | null; to: VerdictState };

export function recordVerdict(options: VerdictOptions): VerdictResult {
  if (!VERDICT_STATES.includes(options.state)) {
    throw new Error(`invalid verdict state: ${options.state} (expected ${VERDICT_STATES.join(" | ")})`);
  }
  const reason = options.reason?.trim();
  if (!reason) {
    throw new Error(`a ${options.state} verdict requires --reason: the reason is the product record, not decoration`);
  }
  const specPath = path.join(options.packetDir, "spec.md");
  if (!existsSync(specPath) || !existsSync(path.join(options.packetDir, "tasks.yaml"))) {
    throw new Error(`not a packet directory (missing spec.md or tasks.yaml): ${options.packetDir}`);
  }

  const now = options.now ?? new Date();
  const { from } = restampFrontmatter(specPath, options.state, now.toISOString().slice(0, 10));

  // Event second: if the stamp threw (bad frontmatter), no ledger line is left
  // claiming a verdict that spec.md does not carry.
  const event = appendEvent({
    packetDir: options.packetDir,
    type: LIFECYCLE_EVENT_TYPE,
    data: { from, to: options.state, reason },
    actor: options.actor,
    now,
  });

  return { event, from, to: options.state };
}

// --- Verdict read (for status surfaces) ----------------------------------------

export type VerdictRecord = { state: string; reason: string | null; at: string | null };

// Latest lifecycle_changed event, scanned from the ledger tail. Bounded and
// skip-on-malformed like every other ledger read; returns null when no verdict
// event exists (e.g. a hand-stamped frontmatter with no trail).
export function latestVerdict(packetDir: string, limit = 500): VerdictRecord | null {
  const eventsPath = path.join(packetDir, "events.jsonl");
  if (!existsSync(eventsPath)) return null;
  const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(-limit).reverse()) {
    try {
      const e = JSON.parse(line) as JsonObject;
      if (e.type !== LIFECYCLE_EVENT_TYPE) continue;
      const data = (e.data ?? {}) as JsonObject;
      return {
        state: typeof data.to === "string" ? data.to : "unknown",
        reason: typeof data.reason === "string" ? data.reason : null,
        at: typeof e.time === "string" ? e.time : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}
