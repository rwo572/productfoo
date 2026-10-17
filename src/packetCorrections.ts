// default-agent-routing-v0 T-005 (R-005): capture user corrections as packet
// contract updates instead of losing them to the chat scrollback. Two moves:
//
// - `foo decision add` appends an attributed, append-only decision event,
//   best-effort linked to the requirement or open question it corrects.
// - `foo spec patch` turns a correction into an INSPECTABLE patch proposal for
//   spec.md / tasks.yaml — exact insertions, a confidence grade, and an
//   explicit approval requirement. It never writes; a human applies.
//
// Raw private context stays out: only the correction text the user explicitly
// provided lands in the packet, and the event writer's safety guard screens it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendEvent } from "./packetWrite.js";
import { UsageError } from "./errorTaxonomy.js";
import { matchGlossaryTerms, readPacketGlossary, type GlossaryTerm } from "./packetGlossary.js";
import { parseOpenQuestions, parseRequirementHeadings } from "./specSections.js";

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "is", "are", "should", "must", "not", "with", "that", "this", "it", "on", "be"]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

export interface CorrectionLink {
  kind: "requirement" | "open_question";
  id: string;
  title: string;
}

// Best-effort: link the correction to the requirement heading or open-question
// bullet it most plausibly corrects (keyword overlap; ties go to nothing —
// a wrong link is worse than no link).
export function linkCorrection(packetDir: string, correction: string): CorrectionLink | null {
  const specPath = path.join(packetDir, "spec.md");
  if (!existsSync(specPath)) return null;
  const text = readFileSync(specPath, "utf8");
  const correctionWords = keywords(correction);

  const candidates: Array<CorrectionLink & { score: number }> = [];
  for (const r of parseRequirementHeadings(text)) {
    candidates.push({ kind: "requirement", id: r.id, title: r.title, score: overlapScore(correctionWords, keywords(r.title)) });
  }
  // Most packets write open questions as plain bullets with no OQ id; a
  // positional id keeps the link addressable (the title is the real anchor).
  parseOpenQuestions(text).forEach((q, i) => {
    candidates.push({ kind: "open_question", id: q.id ?? `OQ-${i + 1}`, title: q.title, score: overlapScore(correctionWords, keywords(q.text)) });
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score === 0) return null;
  if (candidates[1] && candidates[1].score === best.score) return null;
  const { score: _score, ...link } = best;
  return link;
}

export interface DecisionRecord {
  summary: string;
  by: string;
  linked: CorrectionLink | null;
  vocabulary: GlossaryTerm[];
}

export interface PendingUserCorrection {
  eventId: string;
  summary: string;
  time?: string;
}

function normalizeRepresentation(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Preview trusts only productfoo's explicit correction marker. Historical human and
// agent decisions are too heterogeneous to infer as pending packet patches
// without false positives. A correction is represented when the exact summary
// inserted by `foo spec patch` appears after whitespace normalization.
export function findUnrepresentedUserCorrections(packetDir: string): PendingUserCorrection[] {
  const eventsPath = path.join(packetDir, "events.jsonl");
  if (!existsSync(eventsPath)) return [];

  const represented = normalizeRepresentation(
    ["spec.md", "tasks.yaml"]
      .map((file) => path.join(packetDir, file))
      .map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""))
      .join("\n"),
  );
  const pending: PendingUserCorrection[] = [];

  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { id?: unknown; type?: unknown; time?: unknown; data?: unknown };
      if (event.type !== "com.adaptivespec.decision.recorded" || !event.data || typeof event.data !== "object") continue;
      const data = event.data as { source?: unknown; summary?: unknown };
      if (data.source !== "user-correction" || typeof data.summary !== "string" || !data.summary.trim()) continue;
      const summary = data.summary.trim();
      if (represented.includes(normalizeRepresentation(summary))) continue;
      pending.push({
        eventId: typeof event.id === "string" ? event.id : "(unknown event)",
        summary,
        ...(typeof event.time === "string" ? { time: event.time } : {}),
      });
    } catch {
      // Packet validation owns malformed ledger structure. Preview's preflight
      // stays defensive so a bad line does not become an unexpected crash.
    }
  }

  return pending;
}

export function recordDecision(packetDir: string, opts: { summary: string; by: string; now?: Date }): DecisionRecord {
  // A missing correction is the caller's typo, not productfoo's bug — UsageError keeps it
  // out of the page-worthy command_error bucket and files no Bug Capsule (#778).
  if (!opts.summary.trim()) throw new UsageError("foo decision add needs --summary <correction>", "E_BAD_FLAG");
  const linked = linkCorrection(packetDir, opts.summary);
  const vocabulary = matchGlossaryTerms(readPacketGlossary(packetDir), opts.summary);
  appendEvent({
    packetDir,
    type: "com.adaptivespec.decision.recorded",
    actor: { type: "human", id: opts.by },
    data: {
      summary: opts.summary,
      linked: linked ? { kind: linked.kind, id: linked.id } : null,
      vocabulary: vocabulary.map((t) => t.term),
      source: "user-correction",
    },
    now: opts.now,
  });
  return { summary: opts.summary, by: opts.by, linked, vocabulary };
}

export interface PatchProposal {
  schema_version: "0.1";
  packet: string;
  correction: string;
  confidence: "low" | "medium";
  requires_approval: true;
  linked: CorrectionLink | null;
  vocabulary: string[];
  patches: Array<{ file: string; anchor: string; insert: string }>;
}

export function proposeSpecPatch(packetDir: string, correction: string): PatchProposal {
  if (!correction.trim()) throw new Error("foo spec patch needs --correction <text>");
  const linked = linkCorrection(packetDir, correction);
  const vocabulary = matchGlossaryTerms(readPacketGlossary(packetDir), correction).map((t) => t.term);
  const date = new Date().toISOString().slice(0, 10);

  const patches: PatchProposal["patches"] = [];
  // spec.md: record the correction as a dated Decision entry, anchored to the
  // linked item when one exists.
  patches.push({
    file: "spec.md",
    anchor: "## Decisions",
    insert: `- ${date} (user correction${linked ? `, ${linked.id}` : ""}): ${correction}`,
  });

  // tasks.yaml: when the correction names a task, propose an explicit review
  // note on it rather than a silent status flip.
  const taskRef = correction.match(/\bT-\d{3}\b/);
  if (taskRef) {
    patches.push({
      file: "tasks.yaml",
      anchor: `id: ${taskRef[0]}`,
      insert: `# user correction (${date}): ${correction} — re-verify done_when before trusting status`,
    });
  }

  return {
    schema_version: "0.1",
    packet: path.basename(packetDir),
    correction,
    // Linked corrections read as targeted (medium); unlinked ones are broad (low).
    confidence: linked ? "medium" : "low",
    requires_approval: true,
    linked,
    vocabulary,
    patches,
  };
}

export function renderPatchProposal(proposal: PatchProposal): string {
  const lines = [
    `Spec patch proposal — ${proposal.packet} (confidence: ${proposal.confidence}; requires human approval, nothing written)`,
    `  correction: ${proposal.correction}`,
    proposal.linked ? `  linked: ${proposal.linked.kind} ${proposal.linked.id} — ${proposal.linked.title}` : "  linked: none confidently matched",
    ...(proposal.vocabulary.length ? [`  packet vocabulary used: ${proposal.vocabulary.join(", ")}`] : []),
    "",
  ];
  for (const patch of proposal.patches) {
    lines.push(`  ${patch.file} @ ${patch.anchor}:`);
    lines.push(`  + ${patch.insert}`);
  }
  lines.push("", "Apply by editing the file(s) above, then: foo asp validate <packet-dir>");
  return `${lines.join("\n")}\n`;
}
