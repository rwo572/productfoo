// ideate-command-v0 → methodology-compiler-v0 (T-003) → methodology-as-data
// (T-004): `foo ideate` is an adapter over the conductor. The family's
// orchestration lives as DATA and is resolved from the verified local package.
// A missing family is unavailable while remote delivery is rebuilt. This module
// imports NO family: it drives the engine from a resolved FamilyPack. The CLI
// still never generates ideas and never picks a winner (D6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCells, checkRecord, slugify } from "./conductor/engine.js";
import { resolveFamilyPack } from "./conductor/familyDelivery.js";
import {
  computeDiversity,
  clustererLine,
  meterLine,
  parseIdeaObjects,
  readDeclaredMeter,
  DIVERSITY_METER_LINE,
} from "./conductor/diversity.js";
import { contractFromPack, recordFromPack } from "./conductor/pack.js";
import type { FamilyPack } from "./conductor/pack.js";
import type { Depth, FamilyDefinition, GateResult, Tier } from "./conductor/types.js";
import { markFailure } from "./errorTaxonomy.js";
import { checkFalsification, decisionResult } from "./conductor/ideateDecision.js";
import { renderOrchestrationResult } from "./orchestrationResult.js";
import { findIdeateContext } from "./ideateContext.js";

export type IdeateDepth = Depth;

export interface IdeateTier {
  depth: IdeateDepth;
  reframes: number;
  ideators: number;
  stress_on: number;
  judges: number;
  extra_dissent_round: boolean;
}

export const MAX_IDEATORS = 8;
export const BUILD_ON_ROUNDS = 1;

export interface IdeatorCell {
  ideator: string;
  frame: string;
  lens: string;
  seed: number;
}

// The engine functions only read a couple of fields off a FamilyDefinition;
// a pack carries them, so these shims let the generic engine run from pack data.
function cellsShim(pack: FamilyPack): FamilyDefinition {
  return { cells: pack.cells } as FamilyDefinition;
}
function gatesShim(pack: FamilyPack): FamilyDefinition {
  return { gates: pack.gates, depths: pack.depths } as FamilyDefinition;
}

export function tierFromPack(pack: FamilyPack): IdeateTier {
  const t: Tier = pack.depths[pack.depth];
  return {
    depth: pack.depth,
    reframes: Number(t.reframes),
    ideators: Number(t.ideators),
    stress_on: Number(t.stress_on),
    judges: Number(t.judges),
    extra_dissent_round: Boolean(t.extra_dissent_round),
  };
}

export function cellMatrixFromPack(pack: FamilyPack): IdeatorCell[] {
  return buildCells(cellsShim(pack), pack.depths[pack.depth]).map((c) => ({
    ideator: c.role,
    frame: String(c.attrs.frame),
    lens: String(c.attrs.lens),
    seed: Number(c.attrs.seed),
  }));
}

export interface IdeatePlan {
  schema_version: "0.1";
  idea: string;
  depth: IdeateDepth;
  tier: IdeateTier;
  cells: IdeatorCell[];
  phases: string[];
  record_path: string;
  verification: string;
  handoff: string;
  decider: "human";
}

function recordPathFromPack(pack: FamilyPack, idea: string, at: string): string {
  if (!pack.recordDir) throw new Error(`${pack.family} has no record dir`);
  return path.posix.join(pack.recordDir, `${at.slice(0, 10)}-${slugify(idea)}.md`);
}

export function planFromPack(pack: FamilyPack, idea: string, at: string): IdeatePlan {
  const recordPath = recordPathFromPack(pack, idea, at);
  return {
    schema_version: "0.1",
    idea,
    depth: pack.depth,
    tier: tierFromPack(pack),
    cells: cellMatrixFromPack(pack),
    phases: [...pack.phases],
    record_path: recordPath,
    verification: `foo ideate check ${recordPath}`,
    handoff: pack.handoff,
    decider: "human",
  };
}

// Scaffold a record from a pack: substitute the real idea + timestamp into the
// pack's pre-rendered frontmatter/body and write it to the real record path.
export function scaffoldFromPack(pack: FamilyPack, root: string, idea: string, at: string): string {
  const rendered = recordFromPack(pack, idea, at);
  if (!rendered) throw new Error(`${pack.family} has no record template`);
  const recordPath = recordPathFromPack(pack, idea, at);
  const full = path.resolve(root, recordPath);
  if (existsSync(full)) throw new Error(`${pack.family} record already exists: ${recordPath}`);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, [...rendered.frontmatter, ...rendered.body].join("\n"));
  return full;
}

export type IdeateCheckFinding = GateResult["findings"][number];
export type IdeateCheckResult = GateResult;

export function checkRecordWithPack(pack: FamilyPack, recordText: string): IdeateCheckResult {
  return checkRecord(gatesShim(pack), recordText);
}

// --- Diversity (ideate-cost-v1 T-003) -----------------------------------------

// Rewrite the record's meter with the computed one and mark it measured. The
// CLI computing this number is the whole point: the orchestrator never reads 70
// ideas to count near-dupes, so the count stops being a judgment call. `exhausted`
// is NOT computed — whether the idea space is spent is a run's honest call, so
// whatever the record already declared survives the rewrite.
// The clusterer that produced the number is stamped alongside it, so a later
// reader (and the provenance gate) can tell a current number from one an older,
// weaker clusterer produced — the meter is only as trustworthy as the code that
// computed it, and that used to be invisible.
export function writeMeasuredMeter(recordText: string, meterText: string): string {
  const withMeter = recordText.replace(DIVERSITY_METER_LINE, meterText);
  const withMethod = /^diversity_method:/m.test(withMeter)
    ? withMeter.replace(/^diversity_method:.*$/m, "diversity_method: measured")
    : withMeter.replace(meterText, `${meterText}\ndiversity_method: measured`);
  return /^diversity_clusterer:/m.test(withMethod)
    ? withMethod.replace(/^diversity_clusterer:.*$/m, clustererLine())
    : withMethod.replace("diversity_method: measured", `diversity_method: measured\n${clustererLine()}`);
}

// --- CLI ----------------------------------------------------------------------

const LEAN = (process.env.FOO_LEAN_CONTRACT ?? "").trim() === "1";

export async function runIdeateCommand(root: string, args: string[]): Promise<{ output: string; exitCode: number }> {
  const json = args.includes("--json");

  if (args[0] === "context") {
    const idea = args.slice(1).filter((arg) => arg !== "--json").join(" ").trim();
    if (!idea) return { output: 'usage: foo ideate context "<idea>" [--json]\n', exitCode: 1 };
    const context = findIdeateContext(root, idea);
    return { output: json ? `${JSON.stringify(context, null, 2)}\n` : [
      "Prior work to read before generating ideas",
      ...context.candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.path}`),
      ...(context.candidates.length ? [] : ["No keyword matches found. Inspect related names and user-supplied references before declaring a gap."]),
      context.limitations, "",
    ].join("\n"), exitCode: 0 };
  }

  if (args[0] === "check" || args[0] === "result") {
    const target = args[1];
    if (!target) {
      markFailure({ errorClass: "usage_error", errorCode: "E_IDEATE_IDEA_MISSING", message: "ideate check: no record given" });
      return { output: `usage: foo ideate ${args[0]} <record.md> [--json]${args[0] === "check" ? " [--before-build-on]" : ""}\n`, exitCode: 1 };
    }
    const full = path.resolve(root, target);
    if (!existsSync(full)) {
      markFailure({ errorClass: "not_found", errorCode: "E_SPEC_NOT_FOUND", message: `ideate record not found: ${target}` });
      return { output: `ideate record not found: ${target}\n`, exitCode: 1 };
    }
    // gates are depth-independent; any depth's pack carries the same gate set.
    const pack = await resolveFamilyPack("ideate", "standard", LEAN);
    const record = readFileSync(full, "utf8");
    const early = args[0] === "check" && args.includes("--before-build-on");
    const errors = early ? checkFalsification(record) : [];
    const result = early
      ? { ok: !errors.length, findings: [{ check: "early-falsification", ok: !errors.length, detail: errors.length ? errors.join("; ") : "claim coverage verified; unknowns remain hypotheses, not facts" }] }
      : checkRecordWithPack(pack, record);
    if (args[0] === "result" && result.ok) {
      try {
        const value = decisionResult(record);
        return { output: json ? `${JSON.stringify(value, null, 2)}\n` : renderOrchestrationResult(value), exitCode: 0 };
      } catch (error) {
        const detail = (error as Error).message;
        return { output: json ? `${JSON.stringify({ ok: false, detail })}\n` : `Cannot render decision: ${detail}\n`, exitCode: 1 };
      }
    }
    if (json) return { output: `${JSON.stringify({ schema_version: "0.1", ...result }, null, 2)}\n`, exitCode: result.ok ? 0 : 1 };
    const lines = [`ideate check — ${target}`];
    for (const f of result.findings) lines.push(`  ${f.ok ? "ok " : "FAIL"} ${f.check}: ${f.detail}`);
    lines.push(result.ok ? (early ? "Early check passes. Continue only with surviving ideas; disclose unknowns and recheck added claims." : "Record verifies: shortlist is contract-complete.") : "Record does not verify — fix the FAIL lines; do not hand off an unverified shortlist.");
    return { output: `${lines.join("\n")}\n`, exitCode: result.ok ? 0 : 1 };
  }

  if (args[0] === "read") {
    // #700: the pool is stored as machine JSON so the meter can compute from
    // it — but a human reads ideas, not objects. This renders the stored pool
    // grouped by computed cluster, claims first, so the record's substance is
    // readable without parsing anything.
    const target = args[1];
    if (!target) {
      markFailure({ errorClass: "usage_error", errorCode: "E_IDEATE_IDEA_MISSING", message: "ideate read: no record given" });
      return { output: "usage: foo ideate read <record.md>\n", exitCode: 1 };
    }
    const full = path.resolve(root, target);
    if (!existsSync(full)) {
      markFailure({ errorClass: "not_found", errorCode: "E_SPEC_NOT_FOUND", message: `ideate record not found: ${target}` });
      return { output: `ideate record not found: ${target}\n`, exitCode: 1 };
    }
    const parsed = parseIdeaObjects(readFileSync(full, "utf8"));
    if (!parsed.present || parsed.ideas.length === 0) {
      return { output: "Nothing to read — the record stores no ideas yet.\n", exitCode: 1 };
    }
    const byId = new Map(parsed.ideas.map((i) => [i.id, i]));
    const computed = computeDiversity(parsed.ideas);
    const lines: string[] = [];
    computed.clusters.forEach((ids, index) => {
      lines.push(`### C${index + 1}${ids.length > 1 ? ` — ${ids.length} ideas, merged as one move` : ""}`);
      for (const id of ids) {
        const idea = byId.get(id);
        if (!idea) continue;
        lines.push("");
        lines.push(`**${idea.claim}**  — ${id} · ${idea.frame} × ${idea.lens}`);
        if (idea.reasoning.trim()) lines.push(`- move: ${idea.reasoning}`);
        lines.push(`- how: ${idea.mechanism}`);
        lines.push(`- novelty: ${idea.novelty}`);
        lines.push(`- bet: ${idea.assumption}`);
      }
      lines.push("");
    });
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  if (args[0] === "diversity") {
    const target = args[1];
    if (!target || target.startsWith("--")) {
      markFailure({ errorClass: "usage_error", errorCode: "E_IDEATE_IDEA_MISSING", message: "ideate diversity: no record given" });
      return { output: "usage: foo ideate diversity <record.md> [--write] [--json]\n", exitCode: 1 };
    }
    const full = path.resolve(root, target);
    if (!existsSync(full)) {
      markFailure({ errorClass: "not_found", errorCode: "E_SPEC_NOT_FOUND", message: `ideate record not found: ${target}` });
      return { output: `ideate record not found: ${target}\n`, exitCode: 1 };
    }
    const text = readFileSync(full, "utf8");
    const parsed = parseIdeaObjects(text);
    if (!parsed.present || parsed.errors.length || parsed.ideas.length === 0) {
      const why = !parsed.present
        ? "no ideas block in the record — the pools have not stored their objects yet"
        : parsed.errors.length
          ? `stored ideas do not validate: ${parsed.errors.join("; ")}`
          : "the ideas block is empty — nothing to cluster";
      // A refusal by design, not a crash: the record cannot show its work, so
      // foo declines to hand back a number it would be inventing.
      markFailure({ errorClass: "gate_block", errorCode: "E_GATE_BLOCKED", message: `ideate diversity: ${why}` });
      if (json) return { output: `${JSON.stringify({ schema_version: "0.1", ok: false, detail: why }, null, 2)}\n`, exitCode: 1 };
      return { output: `Cannot measure diversity — ${why}.\nUntil the ideas are stored, the meter is a guess: say diversity_method: estimated.\n`, exitCode: 1 };
    }
    const computed = computeDiversity(parsed.ideas, readDeclaredMeter(text)?.exhausted ?? false);
    const line = meterLine(computed);
    if (args.includes("--write")) writeFileSync(full, writeMeasuredMeter(text, line));
    if (json) return { output: `${JSON.stringify({ schema_version: "0.1", ok: true, ...computed }, null, 2)}\n`, exitCode: 0 };
    const lines = [
      `ideate diversity — ${target}`,
      `  ${line}`,
      `  ${computed.raw} idea(s) merged into ${computed.distinct_clusters} distinct cluster(s); ${computed.near_dupes_merged} near-dupe(s) merged.`,
      args.includes("--write")
        ? "Written into the record as diversity_method: measured."
        : "Not written. Re-run with --write to put this line in the record and mark it measured.",
    ];
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  const depthIdx = args.indexOf("--depth");
  const depth = (depthIdx === -1 ? "standard" : args[depthIdx + 1]) as IdeateDepth;
  if (!["fast", "standard", "deep"].includes(depth)) {
    markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: "ideate: --depth must be fast, standard, or deep" });
    return { output: "--depth must be fast, standard, or deep\n", exitCode: 1 };
  }
  const idea = args.filter((a, i) => !a.startsWith("--") && (depthIdx === -1 || i !== depthIdx + 1)).join(" ").trim();
  if (!idea) {
    markFailure({ errorClass: "usage_error", errorCode: "E_IDEATE_IDEA_MISSING", message: "ideate: no idea given" });
    return { output: 'usage: foo ideate "<raw idea>" [--depth fast|standard|deep] [--json]\n', exitCode: 1 };
  }

  const pack = await resolveFamilyPack("ideate", depth, LEAN);
  const at = new Date().toISOString();
  scaffoldFromPack(pack, root, idea, at);

  if (json) return { output: `${JSON.stringify(planFromPack(pack, idea, at), null, 2)}\n`, exitCode: 0 };
  // The contract array ends with "", so join already carries the trailing newline.
  return { output: contractFromPack(pack, idea, at).join("\n"), exitCode: 0 };
}
