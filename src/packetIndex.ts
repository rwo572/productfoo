// Cross-packet packet index (packet_index_v0).
//
// A birds-eye view over every spec packet: enumerate specs/*, derive each
// through the shared derivePacketStatus reader (R-019), and render the result
// as text (default), a versioned --json array, or a self-contained Plain Packet
// HTML artifact. This is a renderer, not a second reader (D-002). It is
// read-only — the only write is the --html artifact, and only when asked.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { STATUS_GLYPHS, withGlyph, type FooState } from "./statusGlyphs.js";
import { NotFoundError } from "./errorTaxonomy.js";
import { deriveSpecDecisionSignals, type SpecDecisionSignals } from "./specDecisionSignals.js";
import { derivePacketEntry } from "./packetIndexEntry.js";
import type { PacketIndexWorkerData } from "./packetIndexWorker.js";
import type { PacketStatus } from "./packetStatus.js";

export const PACKET_INDEX_SCHEMA_VERSION = "1.2";

export interface PacketIndexEntry extends PacketStatus {
  updated: string | null;
  intent: string | null;
  decision_signals: SpecDecisionSignals;
  bucket: "proven" | "progress" | "open" | "retired";
  error?: string;
}

// Discover every specs/* directory that is actually a packet (spec.md +
// tasks.yaml). Non-packets like rfcs/ are skipped because they lack tasks.yaml.
export function listPackets(root: string): string[] {
  const specsDir = path.join(root, "specs");
  if (!existsSync(specsDir)) throw new NotFoundError(`no specs directory at ${specsDir}`, "E_PACKET_NOT_FOUND");
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(specsDir, entry.name))
    .filter((dir) => existsSync(path.join(dir, "spec.md")) && existsSync(path.join(dir, "tasks.yaml")))
    .sort();
}

// Parallel per-packet derivation (cli-performance-v0 R-001): the per-packet
// read/parse/derive work is CPU-bound and independent, so at scale it runs on
// worker threads (packetIndexWorker.ts). The API stays synchronous — the
// parent waits on atomically-set per-worker flags — and any failure (worker
// boot, oversized slot, crash) falls back to the serial loop, so output never
// depends on which path ran. Below PARALLEL_MIN_PACKETS the serial loop wins:
// worker bootstrap would cost more than it saves (and keeps unit-test
// fixtures on the simple path).
const PARALLEL_MIN_PACKETS = 24;
const PARALLEL_MAX_WORKERS = 8;
// Per-worker slot: JSON-encoded entries. Sized for ~300 packets at today's
// ~6KB entry JSON; an overflowing slot falls back to serial, never truncates.
const WORKER_REGION_BYTES = 2 * 1024 * 1024;
const WORKER_SLOT_HEADER = 8; // Int32 header cell + Int32 byte-length cell

const WORKER_DONE = 1;
const WORKER_FAILED = 2;

function derivePacketEntries(root: string, dirs: string[]): PacketIndexEntry[] {
  if (dirs.length >= PARALLEL_MIN_PACKETS) {
    const parallel = derivePacketEntriesParallel(root, dirs);
    if (parallel) return parallel;
  }
  return dirs.map((dir) => derivePacketEntry(root, dir));
}

function derivePacketEntriesParallel(root: string, dirs: string[]): PacketIndexEntry[] | null {
  const workerCount = Math.max(2, Math.min(PARALLEL_MAX_WORKERS, os.cpus().length - 1));
  const slotBytes = WORKER_REGION_BYTES + WORKER_SLOT_HEADER;
  const workers: Worker[] = [];
  let failed = false;
  try {
    const sab = new SharedArrayBuffer(workerCount * slotBytes);
    const batch = Math.ceil(dirs.length / workerCount);
    const cells: Int32Array[] = [];
    for (let slot = 0; slot < workerCount; slot++) {
      const slotBase = slot * slotBytes;
      const cell = new Int32Array(sab, slotBase, 1);
      cells.push(cell);
      const chunk = dirs.slice(slot * batch, (slot + 1) * batch);
      if (chunk.length === 0) {
        // Nothing to derive in this slot — pre-set done so the wait skips it.
        Atomics.store(cell, 0, WORKER_DONE);
        continue;
      }
      const worker = new Worker(new URL("./packetIndexWorker.js", import.meta.url), {
        workerData: { root, dirs: chunk, sab, slotBase, regionBytes: WORKER_REGION_BYTES } satisfies PacketIndexWorkerData,
      });
      worker.on("error", () => markWorkerFailed(cell, () => (failed = true)));
      worker.on("exit", (code) => {
        if (code !== 0) markWorkerFailed(cell, () => (failed = true));
      });
      workers.push(worker);
    }
    // Synchronous bridge: workers write their result slots and store+notify
    // their header cell; Atomics.wait wakes on the write (a store that lands
    // before the wait is not lost — wait re-checks the expected value).
    for (const cell of cells) {
      if (Atomics.load(cell, 0) === 0) Atomics.wait(cell, 0, 0);
    }
    if (failed) return null;
    const entries: PacketIndexEntry[] = [];
    const decoder = new TextDecoder();
    for (let slot = 0; slot < cells.length; slot++) {
      if (Atomics.load(cells[slot], 0) !== WORKER_DONE) return null;
      const slotBase = slot * slotBytes;
      const byteLength = Atomics.load(new Int32Array(sab, slotBase + 4, 1), 0);
      const chunk = JSON.parse(decoder.decode(new Uint8Array(sab, slotBase + WORKER_SLOT_HEADER, byteLength))) as PacketIndexEntry[];
      entries.push(...chunk);
    }
    return entries;
  } catch {
    failed = true;
    return null;
  } finally {
    // Finished workers exit on their own right after storing their slot;
    // terminate() is only cleanup for a failed run's stragglers.
    if (failed) for (const worker of workers) void worker.terminate();
  }
}

function markWorkerFailed(cell: Int32Array, fail: () => void): void {
  fail();
  // A finished slot keeps its result; only a still-pending slot is failed, so
  // a late error after DONE can never discard good entries.
  if (Atomics.load(cell, 0) === 0) {
    Atomics.store(cell, 0, WORKER_FAILED);
    Atomics.notify(cell, 0);
  }
}

export function derivePacketIndex(root: string): PacketIndexEntry[] {
  const entries = derivePacketEntries(root, listPackets(root));
  const rank: Record<PacketIndexEntry["bucket"], number> = { progress: 0, proven: 1, open: 2, retired: 3 };
  return entries.sort((a, b) => {
    if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
    const ra = a.tasks.total ? a.tasks.done / a.tasks.total : 0;
    const rb = b.tasks.total ? b.tasks.done / b.tasks.total : 0;
    if (rb !== ra) return rb - ra;
    return a.spec_id.localeCompare(b.spec_id);
  });
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderIndexText(index: PacketIndexEntry[], glyphs = false): string {
  // Headline totals count only live work: a retired packet's undone tasks are
  // covered by its verdict, not open commitments (packet-lifecycle-v0 R-003).
  const totals = index.reduce(
    (acc, e) => {
      if (e.bucket === "retired") {
        acc.retired += 1;
        return acc;
      }
      acc.tasksTotal += e.tasks.total;
      acc.tasksDone += e.tasks.done;
      acc.blocked += e.tasks.blocked;
      acc.proven += e.bucket === "proven" ? 1 : 0;
      acc.drift += e.lifecycle_drift ? 1 : 0;
      return acc;
    },
    { tasksTotal: 0, tasksDone: 0, blocked: 0, proven: 0, retired: 0, drift: 0 },
  );
  const lines: string[] = [];
  lines.push("foo packet index");
  const retiredNote = totals.retired > 0 ? ` · ${totals.retired} retired` : "";
  // Lifecycle drift (packet-lifecycle-truth-v0 R-002): contradicted packets are
  // a headline number, not a per-row easter egg — the index exists to say what
  // is actually done, and these rows are where it currently lies.
  const driftNote = totals.drift > 0 ? ` · ${totals.drift} lifecycle drift` : "";
  lines.push(
    `${index.length - totals.retired} packets · ${totals.tasksDone} of ${totals.tasksTotal} tasks done · ${totals.proven} complete · ${totals.blocked} blocked${driftNote}${retiredNote}`,
  );
  lines.push("");
  let retiredDivider = false;
  for (const e of index) {
    if (e.error) {
      lines.push(`${pad(e.spec_id, 30)} error: ${e.error}`);
      continue;
    }
    if (e.bucket === "retired" && !retiredDivider) {
      if (lines[lines.length - 1] !== "") lines.push("");
      lines.push("retired (parked/killed — not open work):");
      retiredDivider = true;
    }
    const counts = `${e.tasks.done}/${e.tasks.total} done`;
    const proofs = `${e.proof.checks_done}/${e.proof.checks_total} proven`;
    const flags = e.tasks.blocked > 0 && e.bucket !== "retired" ? `  ! ${e.tasks.blocked} blocked` : "";
    const nextNote = e.next ? `  → ${e.next.id}` : "";
    const reason = e.bucket === "retired" && e.verdict?.reason ? `  — ${e.verdict.reason}` : "";
    // The ⚠️ glyph is TTY-only (statusGlyphs R-008); the word "drift" always
    // travels, so piped output and greps still carry the contradiction.
    const drift = e.lifecycle_drift
      ? `  ${withGlyph("drift", e.lifecycle_effective === "done" ? `drift: work proven done, header says ${e.lifecycle ?? "(unset)"}` : `drift: header says ${e.lifecycle}, work incomplete`, glyphs)}`
      : "";
    lines.push(`${pad(e.spec_id, 30)} ${pad(counts, 11)} ${pad(proofs, 13)} ${pad(e.lifecycle ?? "-", 8)}${nextNote}${flags}${drift}${reason}`);
  }
  lines.push("");
  return lines.join("\n");
}


// --- Work-queue triage (packet-index-triage-v0) ------------------------------
// Lanes before scores: tasks waiting on the human, tasks in flight, tasks an
// agent can start now, tasks blocked by dependencies, and open tasks stranded
// inside retired packets (a drift finding, not backlog). Within a lane, rank
// by inherited requirement priority (P1 first; unknown ranks BELOW known),
// then by unlock count (how many downstream tasks completing this one frees),
// then packet recency as the momentum tiebreak.
// Lanes describe OPEN WORK. There is deliberately no "drift" lane: lifecycle
// drift is a property of a packet, not of a task, and it already surfaces as a
// per-packet flag in the index render. The old drift lane conflated the two and
// became a bucket for dead work — see the retired skip in deriveTriage.
export type TriageLane = "needs_you" | "in_flight" | "ready" | "blocked";

export interface TriageRow {
  packet: string;
  task: string;
  title: string;
  lane: TriageLane;
  prio: string | null; // inherited max requirement priority, e.g. "P1"
  unlocks: number;
  unmet: string[]; // unmet dependency ids (blocked lane)
  owner: string | null;
  agreement: string;
  updated: string | null;
}

const LANE_ORDER: Record<TriageLane, number> = { needs_you: 0, in_flight: 1, ready: 2, blocked: 3 };

// One lane rule shared by the per-task triage and the packet-level portfolio
// rollup (packet-index-portfolio-v0 R-001), so the two surfaces can never
// disagree about what lane a task is in.
function laneForOpenTask(t: PacketStatus["task_list"][number], unmet: string[]): TriageLane {
  if (unmet.length > 0) return "blocked";
  const humanOwned = (t.owner ?? "").replace(/"/g, "").startsWith("human") || (t.owner ?? "") === "product";
  if (humanOwned || t.agreement === "suggested" || t.agreement === "discovered" || t.status === "blocked") return "needs_you";
  if (t.status === "doing") return "in_flight";
  return "ready";
}

export function deriveTriage(index: PacketIndexEntry[]): TriageRow[] {
  const rows: TriageRow[] = [];
  for (const e of index) {
    // A retired packet is not work. Its lifecycle already says killed/parked —
    // that IS the status, and triage's job is to honor it, not to re-surface the
    // packet's open tasks under another name.
    //
    // This skip is worth 34 of 172 triage rows at the time it was written: six
    // packets (personal-brain-stash-v0, build-preview-mini-apps-v0,
    // build-preview-annotation-branches-v0, build-preview-integrated-loop-v1,
    // code-catalog-rip-v0, release-channel-v0), every one carrying an explicit
    // kill/park event with a reason — one of them recording that its scope had
    // already SHIPPED into `foo preview`. They were being read as a fifth of the
    // open board. The rest of the index already got this right (headline totals
    // exclude retired; the render prints "retired (parked/killed — not open
    // work)"); only triage asked a different question and got a different answer.
    //
    // Nothing is deleted: the packet keeps its tasks, its ledger, and its place
    // in the `packets` array with its lifecycle intact. It simply stops being
    // offered as something to pick up.
    if (e.bucket === "retired") continue;
    const done = new Set(e.task_list.filter((t) => t.status === "done").map((t) => t.id));
    for (const t of e.task_list) {
      if (t.status === "done" || t.status === "dropped") continue;
      const unmet = t.deps.filter((d) => !done.has(d));
      const unlocks = e.task_list.filter((o) => o.status !== "done" && o.status !== "dropped" && o.deps.includes(t.id)).length;
      const prios = t.refs.map((r) => e.requirement_priorities[r]).filter((x): x is string => Boolean(x));
      const prio = prios.length ? prios.sort()[0] : null;
      const lane = laneForOpenTask(t, unmet);
      rows.push({ packet: e.packet, task: t.id, title: t.title, lane, prio, unlocks, unmet, owner: t.owner, agreement: t.agreement, updated: e.updated });
    }
  }
  return rows.sort((a, b) => {
    if (LANE_ORDER[a.lane] !== LANE_ORDER[b.lane]) return LANE_ORDER[a.lane] - LANE_ORDER[b.lane];
    const pa = a.prio ?? "P8"; // unknown priority ranks below every stated one
    const pb = b.prio ?? "P8";
    if (pa !== pb) return pa.localeCompare(pb);
    if (b.unlocks !== a.unlocks) return b.unlocks - a.unlocks;
    return (b.updated ?? "").localeCompare(a.updated ?? "");
  });
}

// --- Packet-level portfolio rollup (packet-index-portfolio-v0) ---------------
// The data deriveTriage already reads, asked one level up: not "what do I pick
// up next" but "where should portfolio attention and decisions go". Triage maps
// unknown priority to "P8", so a packet stating no priority sinks below every
// labeled one no matter how much work it would unlock — `mispriced` flags that
// as a review queue (missing signal is not low signal, D-002), never as a
// priority value.

// Threshold calibration (packet-index-portfolio-v0 D-004): the observed
// unlabeled tier of the 2026-09-24 stack rank sat at 13/10/8/7/7/4/2 unlocks;
// 7 catches the heavy unlabeled packets without firing on single-task ones
// (whose sum is 0). An assumption on record — recalibrate if it fires on
// obviously small packets or misses a known mispriced one at review.
export const MISPRICED_UNLOCK_THRESHOLD = 7;

export interface PortfolioRow {
  packet: string;
  spec_id: string;
  open_tasks: number; // tasks.total - done - dropped
  total_tasks: number;
  lanes: TriageLane[]; // union over the packet's open task rows, in LANE_ORDER sequence
  priority: string | null; // best (lowest) stated requirement priority; null when none stated
  unlocks_sum: number; // upper bound — double-counts shared downstream dependents
  unlocks_max: number; // largest single-task one-hop count — no double-count
  mispriced: boolean;
  lifecycle_drift: boolean; // passthrough; the trust overlay is repo-computable signals only (R-005)
  updated: string | null; // momentum context, not a sort key here
}

export function derivePacketPortfolio(index: PacketIndexEntry[]): PortfolioRow[] {
  const rows: PortfolioRow[] = [];
  for (const e of index) {
    // Rows are for live work only (packet-index-portfolio-v0 R-001, carrying
    // packet-index-triage-v0 D-003's retirement exclusion): a retired packet is
    // not work, and a packet with zero open tasks (proven or otherwise) has
    // nothing to roll up.
    if (e.bucket === "retired") continue;
    // An unreadable packet produces no row — there is nothing to roll up — but
    // never silently disappears: its error row stays in `packets` (R-005).
    if (e.error) continue;
    const open = e.task_list.filter((t) => t.status !== "done" && t.status !== "dropped");
    if (open.length === 0) continue;
    // Unlocks are re-derived from task_list[].deps, never summed from the
    // triage rows (D-003): a per-task one-hop count is correct per-task but not
    // additive — several open tasks sharing one downstream dependent each count
    // it, so the sum is an upper bound. unlocks_max is the no-double-count view.
    const done = new Set(e.task_list.filter((t) => t.status === "done").map((t) => t.id));
    const laneSet = new Set<TriageLane>();
    let unlocksSum = 0;
    let unlocksMax = 0;
    for (const t of open) {
      laneSet.add(laneForOpenTask(t, t.deps.filter((d) => !done.has(d))));
      const unlocks = e.task_list.filter((o) => o.status !== "done" && o.status !== "dropped" && o.deps.includes(t.id)).length;
      unlocksSum += unlocks;
      if (unlocks > unlocksMax) unlocksMax = unlocks;
    }
    const lanes = (Object.keys(LANE_ORDER) as TriageLane[]).filter((l) => laneSet.has(l));
    // Packet-level signal (R-001/R-002): the best value stated on any
    // requirement, even where individual tasks reference none.
    const stated = Object.values(e.requirement_priorities);
    const priority = stated.length ? stated.sort()[0] : null;
    rows.push({
      packet: e.packet,
      spec_id: e.spec_id,
      open_tasks: e.tasks.total - e.tasks.done - e.tasks.dropped,
      total_tasks: e.tasks.total,
      lanes,
      priority,
      unlocks_sum: unlocksSum,
      unlocks_max: unlocksMax,
      mispriced: priority === null && unlocksSum >= MISPRICED_UNLOCK_THRESHOLD,
      lifecycle_drift: e.lifecycle_drift,
      updated: e.updated,
    });
  }
  // Sort (R-004): mispriced first (the review queue), then priority with the
  // unstated fallback below every stated one ("P8", carrying
  // packet-index-triage-v0 D-001), then unlocks_sum descending, then packet
  // name ascending. Deterministic, zero model calls.
  return rows.sort((a, b) => {
    if (a.mispriced !== b.mispriced) return a.mispriced ? -1 : 1;
    const pa = a.priority ?? "P8";
    const pb = b.priority ?? "P8";
    if (pa !== pb) return pa.localeCompare(pb);
    if (b.unlocks_sum !== a.unlocks_sum) return b.unlocks_sum - a.unlocks_sum;
    return a.packet.localeCompare(b.packet);
  });
}

function renderIndexJson(index: PacketIndexEntry[]): string {
  // portfolio is additive (packet-index-portfolio-v0 R-003): triage and packets
  // keep shape, order, and byte content; only the key and the schema bump land.
  return `${JSON.stringify({ schema_version: PACKET_INDEX_SCHEMA_VERSION, triage: deriveTriage(index), portfolio: derivePacketPortfolio(index), packets: index }, null, 2)}\n`;
}

// Per-task signifier. "Done is a claim. Proof is a receipt." —
//   p proven    status done AND every done_when check met (the receipt)
//   d done      status done without a full receipt (no checks, or not all met)
//   w doing     in progress
//   b blocked
//   o open      todo / dropped
export function taskGlyph(t: { status: string; checksDone: number; checksTotal: number }): "p" | "d" | "w" | "o" | "b" {
  if (t.status === "blocked") return "b";
  if (t.status === "done") return t.checksTotal > 0 && t.checksDone === t.checksTotal ? "p" : "d";
  if (t.status === "doing") return "w";
  return "o";
}

function htmlData(index: PacketIndexEntry[]): string {
  const shortDate = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][d.getUTCMonth()];
    return `${d.getUTCDate()} ${mon}`;
  };
  const data = index.map((e) => {
    const flags: Array<{ tone: string; label: string }> = [];
    if (e.tasks.blocked > 0) {
      const blockedTitle = e.blocked[0] ? `${e.blocked[0].id} ${e.blocked[0].title}` : "";
      flags.push({ tone: "warn", label: `${e.tasks.blocked} blocked${blockedTitle ? ` — ${blockedTitle}` : ""}` });
    }
    // Lifecycle drift (packet-lifecycle-truth-v0 R-002) subsumes the older
    // draft-restamp nudge; the draft-specific wording survives for the one
    // case lifecycle_drift does not cover (all done, proofs not yet in).
    if (e.lifecycle_drift) {
      flags.push({
        tone: "att",
        label:
          e.lifecycle_effective === "done"
            ? `drift — header says ${e.lifecycle ?? "(unset)"}, work proven; record the done verdict?`
            : `drift — header says ${e.lifecycle}, work not proofs-complete`,
      });
    } else if (e.lifecycle === "draft" && e.tasks.total > 0 && e.tasks.done === e.tasks.total) {
      flags.push({ tone: "att", label: "drift — header says draft, work proven; restamp?" });
    }
    return {
      id: e.spec_id,
      title: e.title ?? e.packet,
      intent: e.intent ?? "",
      mode: e.mode ?? "",
      stage: e.stage ?? "",
      life: e.lifecycle ?? "",
      up: shortDate(e.updated),
      bucket: e.bucket,
      d: e.tasks.done,
      t: e.tasks.total,
      cD: e.proof.checks_done,
      cT: e.proof.checks_total,
      reqC: e.requirements.covered,
      reqT: e.requirements.total,
      next: e.next ? `${e.next.id} · ${e.next.title}` : "",
      questions: e.open_questions,
      flags,
      tasks: e.task_list.map((task) => [task.id, taskGlyph(task), task.title]),
    };
  });
  // Escape "<" so a packet title containing </script> cannot break out of the tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

// The HTML legend is generated from the status-glyph vocabulary (R-001) so the
// web key, the CLI, and the spec read the same glyph+label; only the swatch color
// is web-specific. Emoji are decorative (aria-hidden); the word is the accessible
// carrier (R-002). Emoji appear ONLY here in the legend — never on data rows
// (design-swarm consensus: no badge pile, no color-only state).
const LEGEND_STATES: Array<{ state: FooState; swatch: string }> = [
  { state: "proven", swatch: "background:var(--proof)" },
  { state: "claimed", swatch: "background:var(--proof);opacity:.42" },
  { state: "doing", swatch: "background:var(--line2)" },
  { state: "todo", swatch: "background:var(--line)" },
  { state: "blocked", swatch: "background:var(--warn)" },
  { state: "needs_input", swatch: "background:var(--att)" },
];

function legendHtml(): string {
  return LEGEND_STATES.map(({ state, swatch }) => {
    const g = STATUS_GLYPHS[state];
    return `<span><i class="em" aria-hidden="true">${g.glyph}</i><i class="sw" style="${swatch}" aria-hidden="true"></i>${g.label}</span>`;
  }).join("\n  ");
}

export function renderIndexHtml(index: PacketIndexEntry[]): string {
  // Numeric aggregates count live packets only; retired rows still render in
  // the table (their lifecycle column carries the verdict) but their undone
  // tasks are not open work (packet-lifecycle-v0 R-003). Retired-specific HTML
  // treatment (tab/section) is a recorded follow-up, not silently absent.
  const live = index.filter((e) => e.bucket !== "retired");
  const generated = index.length;
  const tasksDone = live.reduce((n, e) => n + e.tasks.done, 0);
  const tasksTotal = live.reduce((n, e) => n + e.tasks.total, 0);
  const checksDone = live.reduce((n, e) => n + e.proof.checks_done, 0);
  const checksTotal = live.reduce((n, e) => n + e.proof.checks_total, 0);
  const complete = index.filter((e) => e.bucket === "proven").length;
  const progress = index.filter((e) => e.bucket === "progress").length;
  const open = index.filter((e) => e.bucket === "open").length;
  const blocked = live.filter((e) => e.tasks.blocked > 0).length;
  // Task-state segments. proven ⊆ done; the remainder split by authoritative counts.
  let segProven = 0;
  for (const e of live) for (const t of e.task_list) if (taskGlyph(t) === "p") segProven += 1;
  const segBlocked = live.reduce((n, e) => n + e.tasks.blocked, 0);
  const segDoing = live.reduce((n, e) => n + e.tasks.doing, 0);
  const segDone = Math.max(0, tasksDone - segProven);
  const segOpen = Math.max(0, tasksTotal - tasksDone - segDoing - segBlocked);
  const data = htmlData(index);
  const triage = JSON.stringify(deriveTriage(index).map((r) => [r.lane, r.packet, r.task, r.title, r.prio ?? "", r.unlocks, r.unmet.join(","), r.owner ?? "", r.agreement])).replace(/</g, "\\u003c");
  // Tokens repeat in the template, so replace globally (string.replace hits only the first).
  return INDEX_HTML.replace("__DATA__", data).replace("__TRIAGE__", triage)
    .replace(/__N__/g, String(generated))
    .replace(/__TASKS_DONE__/g, String(tasksDone))
    .replace(/__TASKS_TOTAL__/g, String(tasksTotal))
    .replace(/__TASKS_PROVEN__/g, String(segProven))
    .replace(/__CHECKS_DONE__/g, String(checksDone))
    .replace(/__CHECKS_TOTAL__/g, String(checksTotal))
    .replace(/__COMPLETE__/g, String(complete))
    .replace(/__PROGRESS__/g, String(progress))
    .replace(/__OPEN__/g, String(open))
    .replace(/__BLOCKED__/g, String(blocked))
    .replace("__PROVEN_SEG__", String(segProven))
    .replace("__DONE_SEG__", String(segDone))
    .replace("__DOING_SEG__", String(segDoing))
    .replace("__OPEN_SEG__", String(segOpen))
    .replace("__BLOCKED_SEG__", String(segBlocked))
    .replace("__LEGEND__", legendHtml());
}

export interface IndexOptions {
  json?: boolean;
  html?: boolean;
  htmlPath?: string;
  // Human-surface gate (statusGlyphs R-008): the caller decides from TTY/env;
  // --json and --html never see it, so machine output stays glyph-free.
  glyphs?: boolean;
}

export function runAspIndex(root: string, options: IndexOptions): string {
  const index = derivePacketIndex(root);
  if (options.json) return renderIndexJson(index);
  if (options.html) {
    const outPath = path.resolve(root, options.htmlPath ?? "packet-index.html");
    writeFileSync(outPath, renderIndexHtml(index));
    return `wrote ${index.length}-packet index to ${outPath}\n`;
  }
  return renderIndexText(index, options.glyphs === true);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>foo · packet index</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap');
:root{--ink:oklch(0.205 0.012 25);--muted:oklch(0.455 0.014 25);--line:oklch(0.875 0.006 25);--line2:oklch(0.705 0.012 25);--bg:oklch(1 0 0);--surf:oklch(0.985 0.001 25);--surf2:oklch(0.972 0.002 25);--att:oklch(0.36 0.12 0);--att-soft:oklch(0.945 0.022 8);--proof:oklch(0.47 0.095 190);--warn:oklch(0.62 0.1 70);--warn-soft:oklch(0.955 0.035 82);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--ui:"Atkinson Hyperlegible",ui-sans-serif,system-ui,sans-serif;}
*{box-sizing:border-box;}
body{margin:0;background:var(--surf);color:var(--ink);font-family:var(--ui);line-height:1.5;-webkit-font-smoothing:antialiased;}
.wrap{max-width:920px;margin:0 auto;padding:40px 24px 64px;}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
.mast{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.wm{font-size:27px;font-weight:700;letter-spacing:-0.01em;}
.wm b{color:var(--att);}
.sub{margin:4px 0 0;font-size:13px;color:var(--muted);}
.asof{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right;}
.chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0 14px;}
.chip{background:var(--bg);border:0.5px solid var(--line);border-radius:8px;padding:11px 13px;}
.chip .k{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--muted);}
.chip .v{font-size:21px;font-weight:700;margin-top:3px;}
.chip .v small{font-size:12px;font-weight:400;color:var(--muted);}
.pbar{display:flex;height:10px;border-radius:3px;overflow:hidden;background:var(--line);margin:2px 0 9px;}
.pbar i{display:block;}
.lg{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-bottom:18px;}
.lg span{display:inline-flex;align-items:center;gap:5px;}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block;}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
.ft{font-family:var(--mono);font-size:12px;color:var(--muted);background:transparent;border:0.5px solid var(--line2);border-radius:20px;padding:5px 11px;cursor:pointer;}
.ft[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink);}
.ft b{font-weight:700;opacity:.6;margin-left:4px;}
.list{display:flex;flex-direction:column;gap:8px;}
.row{position:relative;text-align:left;width:100%;background:var(--bg);border:0.5px solid var(--line);border-radius:9px;padding:13px 15px 13px 17px;cursor:pointer;font-family:var(--ui);color:var(--ink);overflow:hidden;}
.row:hover,.row.open{background:var(--surf2);border-color:var(--line2);}
.row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent;}
.row.open::before{background:var(--att);}
.r1{display:flex;align-items:center;gap:8px;}
.sid{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--muted);}
.tag{font-family:var(--mono);font-size:12px;font-weight:700;border:0.5px solid var(--line2);border-radius:4px;padding:2px 6px;color:var(--muted);}
.tag.life{color:var(--ink);}
.cnt{margin-left:auto;font-family:var(--mono);font-size:12px;font-weight:700;white-space:nowrap;}
.cnt small{color:var(--muted);font-weight:400;}
.ttl{font-size:15px;margin:7px 0 9px;}
.segs{display:flex;gap:2px;height:7px;}
.segs i{flex:1;border-radius:1.5px;min-width:3px;}
.segs i.p{background:var(--proof);}
.segs i.d{background:var(--proof);opacity:.42;}
.segs i.w{background:var(--line2);}
.segs i.o{background:var(--line);}
.segs i.b{background:var(--warn);}
.flag{display:inline-flex;align-items:center;gap:5px;font-size:12px;border-radius:5px;padding:3px 8px;margin-top:9px;}
.flag.warn{background:var(--warn-soft);color:oklch(0.42 0.07 60);}
.flag.att{background:var(--att-soft);color:var(--att);}
.det{max-height:0;overflow:hidden;transition:max-height .22s ease;}
.det-in{padding-top:13px;margin-top:13px;border-top:0.5px solid var(--line);}
.det .intent{font-size:13px;color:var(--muted);margin:0 0 11px;}
.det .meta{font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:11px;display:flex;flex-wrap:wrap;gap:5px 14px;}
.tk{display:flex;align-items:flex-start;gap:9px;padding:4px 0;font-size:13px;}
.g{flex:none;width:17px;height:17px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;font-weight:700;margin-top:1px;}
.g.p{background:var(--proof);color:oklch(0.99 0.004 190);}
.g.d{background:transparent;border:1.25px solid var(--proof);color:var(--proof);}
.g.w{background:transparent;border:1.25px solid var(--ink);color:var(--ink);}
.g.o{border:1px solid var(--line2);color:var(--muted);}
.g.b{background:var(--warn);color:oklch(0.99 0.004 80);}
.tk .tid{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--muted);flex:none;width:38px;margin-top:2px;}
.tk.dn .tt{color:var(--muted);}
.q{font-size:12.5px;color:var(--muted);padding:3px 0 3px 12px;}
.seclabel{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--muted);margin:14px 0 6px;}
.seclabel.sep{border-top:0.5px solid var(--line);padding-top:12px;}
.next{font-family:var(--mono);font-size:12px;color:var(--att);margin-top:10px;}
.hint{font-size:12px;color:var(--muted);margin:16px 0 0;font-style:italic;}
.foot{margin-top:14px;font-family:var(--mono);font-size:12px;color:var(--muted);}
.lg .em{font-size:12px;line-height:1;}
.row:focus-visible,.ft:focus-visible,.search:focus-visible{outline:none;box-shadow:0 0 0 3px oklch(0.82 0.07 190);}
.search{width:100%;font-family:var(--ui);font-size:13px;color:var(--ink);background:var(--bg);border:0.5px solid var(--line2);border-radius:8px;padding:9px 12px;margin:0 0 10px;}
.search::placeholder{color:var(--muted);}
.empty{font-size:13px;color:var(--muted);padding:16px 2px;display:none;}
.tabs{display:flex;gap:2px;margin:22px 0 14px;border-bottom:0.5px solid var(--line2);}
.tab{font-family:var(--ui);font-size:14px;font-weight:700;color:var(--muted);background:transparent;border:none;border-bottom:2.5px solid transparent;padding:8px 14px 9px;cursor:pointer;}
.tab[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--att);}
.tab:focus-visible{outline:none;box-shadow:0 0 0 3px oklch(0.82 0.07 190);border-radius:6px 6px 0 0;}
.qsub{font-size:12px;color:var(--muted);margin:0 0 10px;}
.lgwrap{margin-bottom:14px;}
.lgwrap summary{font-family:var(--mono);font-size:12px;color:var(--muted);cursor:pointer;width:max-content;}
.lgwrap[open] summary{margin-bottom:8px;}
.qbar{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin:0 0 10px;}
.qbar select{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--bg);border:0.5px solid var(--line2);border-radius:6px;padding:4px 8px;}
.qrow{display:block;background:var(--bg);border:0.5px solid var(--line);border-radius:9px;padding:12px 15px;margin-bottom:8px;}
.qr1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.qlane{font-family:var(--mono);font-size:12px;font-weight:700;white-space:nowrap;border:0.5px solid var(--line2);border-radius:4px;padding:2px 7px;}
.qlane.l-needs_you{color:var(--att);border-color:var(--att);background:var(--att-soft);}
.qlane.l-in_flight{color:var(--ink);}
.qlane.l-ready{color:var(--proof);border-color:var(--proof);}
.qlane.l-blocked{color:oklch(0.52 0.09 70);border-color:oklch(0.75 0.07 70);background:var(--warn-soft);}
.qlane.l-drift{color:var(--muted);}
.qpk{font-family:var(--mono);font-size:12px;color:var(--muted);}
.qtid{font-family:var(--mono);font-size:12px;font-weight:700;}
.qtt{font-size:15px;margin-top:7px;}
.qmeta{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;}
</style>
</head>
<body>
<div class="wrap">
<h2 class="sr">Birds-eye index of __N__ foo spec packets with task completion and rollover detail.</h2>
<div class="mast">
  <div>
    <div class="wm">foo<b>.</b> packet index</div>
    <p class="sub">every spec, its proof, at a glance — derived live from each packet's tasks.yaml</p>
  </div>
  <div class="asof">foo asp index<br>__N__ packets</div>
</div>
<div class="chips">
  <div class="chip"><div class="k">packets</div><div class="v">__N__</div></div>
  <div class="chip"><div class="k">tasks done</div><div class="v">__TASKS_DONE__<small>/__TASKS_TOTAL__</small></div></div>
  <div class="chip"><div class="k">proven</div><div class="v">__TASKS_PROVEN__<small>/__TASKS_TOTAL__ · checks __CHECKS_DONE__/__CHECKS_TOTAL__</small></div></div>
  <div class="chip"><div class="k">state</div><div class="v">__COMPLETE__<small> complete · __PROGRESS__ wip · __OPEN__ open</small></div></div>
</div>
<div class="pbar" aria-hidden="true"><i style="flex:__PROVEN_SEG__;background:var(--proof)"></i><i style="flex:__DONE_SEG__;background:var(--proof);opacity:.42"></i><i style="flex:__DOING_SEG__;background:var(--line2)"></i><i style="flex:__BLOCKED_SEG__;background:var(--warn)"></i><i style="flex:__OPEN_SEG__"></i></div>
<details class="lgwrap"><summary>key</summary><div class="lg">__LEGEND__</div></details>
<div class="tabs" role="tablist" aria-label="Index views">
  <button class="tab" id="tab-queue" role="tab" aria-selected="true" aria-controls="panel-queue">work queue</button>
  <button class="tab" id="tab-packets" role="tab" aria-selected="false" aria-controls="panel-packets">packets</button>
</div>
<section id="panel-queue" role="tabpanel" aria-labelledby="tab-queue">
<p class="qsub">everything still to do across active specs, most important first — drift means tasks left behind in retired specs</p>
<div class="filters" id="qfilters"></div>
<div class="qbar"><label for="qsort">sort</label><select id="qsort" aria-label="Sort work queue"><option value="rank">most important first</option><option value="packet">by spec</option><option value="unlocks">unblocks the most work</option></select></div>
<div class="qlist" id="qlist"></div>
</section>
<section id="panel-packets" role="tabpanel" aria-labelledby="tab-packets" hidden>
<input class="search" id="search" type="search" placeholder="filter by id or title — press /" aria-label="Filter packets by id or title" autocomplete="off" />
<div class="filters" id="filters">
  <button class="ft" data-f="all" aria-pressed="true">all<b>__N__</b></button>
  <button class="ft" data-f="progress" aria-pressed="false">in progress<b>__PROGRESS__</b></button>
  <button class="ft" data-f="proven" aria-pressed="false">complete<b>__COMPLETE__</b></button>
  <button class="ft" data-f="open" aria-pressed="false">open<b>__OPEN__</b></button>
  <button class="ft" data-f="blocked" aria-pressed="false">blocked<b>__BLOCKED__</b></button>
</div>
<div class="list" id="list"></div>
<p class="empty" id="empty"></p>
</section>
<p class="hint">click a packet to open its tasks · click again to close · / to search · esc to close all</p>
<p class="foot">generated by foo asp index — read-only, derived from tasks.yaml</p>
</div>
<script>
var P=__DATA__;
var T=__TRIAGE__;
var LANES={needs_you:["\u270B","needs your input"],in_flight:["\uD83D\uDD04","doing"],ready:["\u25B6","ready to start"],blocked:["\uD83D\uDEA7","blocked"]};
var LANE_SEQ=["needs_you","in_flight","ready","blocked"];
var CLAIMED_LABEL=${JSON.stringify(STATUS_GLYPHS.claimed.label)};
var GW={p:"proven",d:CLAIMED_LABEL,w:"doing",o:"todo",b:"blocked"};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
var list=document.getElementById("list");
P.forEach(function(p){
  var segs=p.tasks.map(function(t){return '<i class="'+t[1]+'"></i>';}).join("");
  if(!segs){segs='<i class="o"></i>';}
  var sc={p:0,d:0,w:0,o:0,b:0};p.tasks.forEach(function(t){sc[t[1]]=(sc[t[1]]||0)+1;});
  var segLabel=p.tasks.length?('tasks: '+sc.p+' proven, '+sc.d+' '+CLAIMED_LABEL+', '+sc.w+' doing, '+sc.b+' blocked, '+sc.o+' todo'):'no tasks yet';
  var tags='<span class="tag life">'+esc(p.life||"-")+'</span>'+(p.mode?'<span class="tag">'+esc(p.mode)+'</span>':"");
  var flags=p.flags.map(function(f){return '<div class="flag '+(f.tone==="att"?"att":"warn")+'">'+esc(f.label)+'</div>';}).join("");
  var meta='<div class="meta"><span>mode · '+esc(p.mode||"-")+'</span><span>stage · '+esc(p.stage||"-")+'</span><span>lifecycle · '+esc(p.life||"-")+'</span><span>checks · '+p.cD+'/'+p.cT+'</span><span>requirements · '+p.reqC+'/'+p.reqT+'</span><span>updated · '+esc(p.up||"-")+'</span></div>';
  var tks=(p.tasks.length?'<div class="seclabel">tasks</div>':"")+p.tasks.map(function(t){var g=t[1];var gl=(g==="p"||g==="d")?"\\u2713":(g==="b"?"!":(g==="w"?"\\u00b7":""));return '<div class="tk '+((g==="p"||g==="d")?"dn":"")+'"><span class="g '+g+'" aria-hidden="true">'+gl+'</span><span class="sr">'+(GW[g]||"")+' </span><span class="tid">'+esc(t[0])+'</span><span class="tt">'+esc(t[2])+'</span></div>';}).join("");
  var qs=p.questions&&p.questions.length?'<div class="seclabel sep">open questions</div>'+p.questions.map(function(q){return '<div class="q">- '+esc(q)+'</div>';}).join(""):"";
  var nx=p.next?'<div class="next">next · '+esc(p.next)+'</div>':"";
  var row=document.createElement("button");
  row.className="row";row.type="button";
  row.setAttribute("data-bucket",p.bucket);
  row.setAttribute("data-blocked",p.flags.some(function(f){return f.tone==="warn";})?"1":"0");
  row.setAttribute("data-search",(p.id+" "+p.title).toLowerCase());
  row.setAttribute("aria-expanded","false");
  row.innerHTML='<div class="r1"><span class="sid">'+esc(p.id)+'</span>'+tags+'<span class="cnt">'+p.d+'<small>/'+p.t+' done</small></span></div>'+
    '<div class="ttl">'+esc(p.title)+'</div>'+
    '<div class="segs" role="img" aria-label="'+esc(segLabel)+'">'+segs+'</div>'+flags+
    '<div class="det"><div class="det-in"><p class="intent">'+esc(p.intent||"")+'</p>'+meta+tks+qs+nx+'</div></div>';
  var det=row.querySelector(".det");
  function open(){det.style.maxHeight=det.scrollHeight+"px";row.classList.add("open");row.setAttribute("aria-expanded","true");}
  function close(){det.style.maxHeight="0";row.classList.remove("open");row.setAttribute("aria-expanded","false");}
  row.addEventListener("click",function(){if(row.classList.contains("open"))close();else open();});
  list.appendChild(row);
});
(function(){
  var tabs=[document.getElementById("tab-queue"),document.getElementById("tab-packets")];
  var panels=[document.getElementById("panel-queue"),document.getElementById("panel-packets")];
  function select(i){
    tabs.forEach(function(t,j){t.setAttribute("aria-selected",j===i?"true":"false");});
    panels.forEach(function(p,j){if(j===i)p.removeAttribute("hidden");else p.setAttribute("hidden","");});
    try{location.hash=i===0?"queue":"packets";}catch(e){}
  }
  tabs.forEach(function(t,i){t.addEventListener("click",function(){select(i);});});
  tabs.forEach(function(t,i){t.addEventListener("keydown",function(e){
    if(e.key==="ArrowRight"||e.key==="ArrowLeft"){var n=(i+1)%2;select(n);tabs[n].focus();}
  });});
  if(location.hash==="#packets")select(1);
})();
(function(){
  var qlist=document.getElementById("qlist");
  var qfilters=document.getElementById("qfilters");
  var qsort=document.getElementById("qsort");
  var active={all:true};
  var counts={};T.forEach(function(r){counts[r[0]]=(counts[r[0]]||0)+1;});
  var chips=[["all","all",T.length]].concat(LANE_SEQ.map(function(l){return [l,LANES[l][0]+" "+LANES[l][1],counts[l]||0];}));
  chips.forEach(function(c,i){
    var b=document.createElement("button");b.className="ft";b.setAttribute("data-l",c[0]);
    b.setAttribute("aria-pressed",i===0?"true":"false");
    b.innerHTML=esc(c[1])+"<b>"+c[2]+"</b>";
    qfilters.appendChild(b);
  });
  function laneRank(l){return LANE_SEQ.indexOf(l);}
  function render(){
    var mode=qsort.value;var rows=T.slice();
    if(mode==="packet"){rows.sort(function(a,b){return a[1]===b[1]?laneRank(a[0])-laneRank(b[0]):(a[1]<b[1]?-1:1);});}
    else if(mode==="unlocks"){rows.sort(function(a,b){return b[5]-a[5];});}
    var f=qfilters.querySelector('[aria-pressed="true"]').getAttribute("data-l");
    qlist.innerHTML="";
    rows.forEach(function(r){
      if(f!=="all"&&r[0]!==f)return;
      var d=document.createElement("div");d.className="qrow";
      var meta=[];if(r[4])meta.push(r[4]);if(r[5])meta.push("frees "+r[5]+(r[5]===1?" task":" tasks"));if(r[6])meta.push("waiting on "+r[6]);
      if(r[0]==="needs_you"&&r[8]!=="agreed")meta.push(r[8]);
      d.innerHTML='<div class="qr1"><span class="qlane l-'+r[0]+'">'+LANES[r[0]][0]+' '+LANES[r[0]][1]+'</span><span class="qpk">'+esc(r[1])+'</span><span class="qtid">'+esc(r[2])+'</span><span class="qmeta">'+esc(meta.join(" \u00b7 "))+'</span></div><div class="qtt">'+esc(r[3])+'</div>';
      qlist.appendChild(d);
    });
    if(!qlist.children.length){qlist.innerHTML='<div class="qrow" style="color:var(--muted)">no open tasks in this lane</div>';}
  }
  qfilters.addEventListener("click",function(e){
    var b=e.target.closest(".ft");if(!b)return;
    [].forEach.call(qfilters.querySelectorAll(".ft"),function(x){x.setAttribute("aria-pressed",x===b?"true":"false");});
    render();
  });
  qsort.addEventListener("change",render);
  render();
})();
var filters=document.getElementById("filters");
var search=document.getElementById("search");
var emptyMsg=document.getElementById("empty");
var activeF="all";
function applyFilters(){
  var q=(search.value||"").trim().toLowerCase();
  var shown=0;
  [].forEach.call(list.querySelectorAll(".row"),function(r){
    var bucketOk=activeF==="all"||r.getAttribute("data-bucket")===activeF||(activeF==="blocked"&&r.getAttribute("data-blocked")==="1");
    var qOk=!q||(r.getAttribute("data-search")||"").indexOf(q)!==-1;
    var show=bucketOk&&qOk;r.style.display=show?"":"none";if(show)shown++;
  });
  emptyMsg.textContent=shown?"":(q?'no packets match "'+q+'"':"no packets");
  emptyMsg.style.display=shown?"none":"block";
}
filters.addEventListener("click",function(e){
  var b=e.target.closest(".ft");if(!b)return;
  activeF=b.getAttribute("data-f");
  [].forEach.call(filters.querySelectorAll(".ft"),function(x){x.setAttribute("aria-pressed",x===b?"true":"false");});
  applyFilters();
});
search.addEventListener("input",applyFilters);
document.addEventListener("keydown",function(e){
  if(e.key==="/"&&document.activeElement!==search){e.preventDefault();search.focus();return;}
  if(e.key==="Escape"){
    if(document.activeElement===search&&search.value){search.value="";applyFilters();return;}
    [].forEach.call(list.querySelectorAll(".row"),function(r){r.classList.remove("open");r.setAttribute("aria-expanded","false");r.querySelector(".det").style.maxHeight="0";});
  }
});
</script>
</body>
</html>
`;
