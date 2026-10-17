// methodology-compiler-v0 (R-001) — the conductor engine. One code path for
// every family: resolve tier, build the cell matrix, scaffold the record,
// render the contract, verify the record against the family's gate specs.
// Adding a family means adding DATA (a FamilyDefinition), never a new engine.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkDecision, checkFalsification } from "./ideateDecision.js";
import {
  CLUSTERER_ID,
  computeDiversity,
  frameReasoningOffenders,
  hasExecutableFramesContract,
  ideateContractVersion,
  parseIdeaObjects,
  readClustererId,
  readDeclaredMeter,
  readDiversityMethod,
} from "./diversity.js";
import type {
  Cell,
  Depth,
  FamilyDefinition,
  GateFinding,
  GateResult,
  GateSpec,
  RenderContext,
  Tier,
} from "./types.js";

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "idea"
  );
}

export function buildCells(family: FamilyDefinition, tier: Tier): Cell[] {
  const rule = family.cells;
  if (!rule) return [];
  const count = Math.min(Number(tier[rule.countKey] ?? 0), rule.maxCount ?? Number.POSITIVE_INFINITY);
  const cells: Cell[] = [];
  for (let i = 0; i < count; i += 1) {
    const attrs: Record<string, string | number> = {};
    for (const [attr, pool] of Object.entries(rule.pools)) {
      const cycle = pool.cycleKey ? Number(tier[pool.cycleKey] ?? pool.values.length) : pool.values.length;
      attrs[attr] = pool.values[i % Math.max(1, Math.min(cycle, pool.values.length))];
    }
    if (rule.seed) attrs[rule.seed.attr] = rule.seed.base + i * rule.seed.step;
    cells.push({ role: `${rule.rolePrefix}${i + 1}`, attrs });
  }
  return cells;
}

export function renderContext(
  family: FamilyDefinition,
  target: string,
  depth: Depth,
  at: string,
  root: string,
): RenderContext {
  const tier = family.depths[depth];
  if (!tier) throw new Error(`unknown depth for ${family.family}: ${depth}`);
  const recordPath = family.record
    ? path.posix.join(family.record.dir, `${at.slice(0, 10)}-${slugify(target)}.md`)
    : null;
  // ip-protection-cheap-moves T-004: lean contract is opt-in via env, OFF by
  // default so the emitted contract stays byte-identical until the D-003 A/B arms it.
  const lean = (process.env.FOO_LEAN_CONTRACT ?? "").trim() === "1";
  return { family, target, depth, tier, cells: buildCells(family, tier), at, recordPath, root, lean };
}

// Scaffold the record: family template renders it; the engine owns only the
// refuse-to-overwrite and filesystem mechanics.
export function scaffoldRecord(ctx: RenderContext): string {
  const { family, recordPath, root } = ctx;
  if (!family.record || !recordPath) throw new Error(`${family.family} has no record template`);
  const full = path.resolve(root, recordPath);
  if (existsSync(full)) throw new Error(`${family.family} record already exists: ${recordPath}`);
  mkdirSync(path.dirname(full), { recursive: true });
  const body = [...family.record.frontmatter(ctx), ...family.record.body(ctx)].join("\n");
  writeFileSync(full, body);
  return full;
}

export function renderContract(ctx: RenderContext): string {
  return ctx.family.contract(ctx).join("\n");
}

// --- Gates (deterministic verification; the structure half of V1) -----------

function grab(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

// The human-readable content of a `field:` keyline. A record author may write
// the value inline, as a YAML block list (`- item` lines), or as a folded
// block (`>-` / `|` plus indented lines) — the gate cares that substance
// exists, not which of those shapes carries it. Machine-shaped one-liners
// were being forced onto human surfaces purely because the old check only
// read the same line; that was the gate's defect, not the author's.
function keylineContent(recordText: string, field: string): string | null {
  const lines = recordText.split("\n");
  const start = lines.findIndex((l) => l === `${field}:` || l.startsWith(`${field}:`));
  if (start === -1) return null;
  const inline = lines[start].slice(field.length + 1).trim();
  const parts: string[] = [];
  if (inline && inline !== ">-" && inline !== ">" && inline !== "|" && inline !== "|-") parts.push(inline);
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (!/^\s+\S/.test(line)) break; // next top-level key or heading ends the block
    parts.push(line.trim().replace(/^- /, ""));
  }
  return parts.join(" ");
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runGate(spec: GateSpec, recordText: string, tierFor: (d: Depth) => Tier): GateFinding[] {
  switch (spec.type) {
    case "ideate-falsification":
    case "ideate-decision": {
      const version = ideateContractVersion(recordText);
      if (version === null || version === "frames-v1") return [{ check: spec.check, ok: true, detail: "record predates decisions-v2 — new evidence and decision checks not required" }];
      if (version !== "decisions-v2") return [{ check: spec.check, ok: false, detail: `unsupported or malformed ideate contract: ${version}` }];
      const errors = spec.type === "ideate-falsification" ? checkFalsification(recordText) : checkDecision(recordText);
      return [{ check: spec.check, ok: !errors.length, detail: errors.length ? errors.join("; ") : "recorded coverage and consistency verified; factual truth and execution chronology remain human/model judgments" }];
    }
    case "frontmatter-present": {
      const value = grab(recordText, new RegExp(`^${spec.field}:\\s*${spec.pattern ?? "(.+)"}\\s*$`, "m"));
      const ok = Boolean(value && value.trim().length > (spec.field === "idea" ? 2 : 0));
      return [{ check: spec.check, ok, detail: ok ? spec.detail.replace("{value}", value ?? "") : spec.failDetail }];
    }
    case "frontmatter-nonempty": {
      const value = keylineContent(recordText, spec.field);
      const stripped = (value ?? "").replace(/["']/g, "").trim();
      // "null" is a scaffold placeholder, not content — an unfilled field must
      // read as unfilled, or the gate certifies a record with no position.
      const ok = stripped.length > 0 && stripped !== "[]" && stripped !== "null";
      return [{ check: spec.check, ok, detail: ok ? spec.detail : spec.failDetail }];
    }
    case "frontmatter-equals": {
      const value = grab(recordText, new RegExp(`^${spec.field}:\\s*(\\S+)`, "m"));
      const ok = value === spec.expect;
      return [{ check: spec.check, ok, detail: ok ? spec.detail : `${spec.failDetail}${value ?? "none"}` }];
    }
    case "section-present": {
      const ok = new RegExp(`^#+\\s*${escapeRegExpLiteral(spec.heading)}`, "m").test(recordText);
      return [{ check: spec.check, ok, detail: ok ? spec.detail : spec.failDetail }];
    }
    case "frame-reasoning": {
      // frames-v1 (#697): the frame label is a claim; reasoning is its proof.
      // Shape only — quality stays with blind judging.
      if (!hasExecutableFramesContract(recordText)) {
        return [{
          check: spec.check,
          ok: true,
          detail: "record predates executable frames (no ideate_contract line) — frame execution unverifiable, not failed",
        }];
      }
      const parsed = parseIdeaObjects(recordText);
      if (!parsed.present || parsed.ideas.length === 0) {
        return [{ check: spec.check, ok: false, detail: "frames-v1 record stores no ideas to verify frame execution against" }];
      }
      if (parsed.errors.length) {
        return [{ check: spec.check, ok: false, detail: `stored ideas do not validate: ${parsed.errors.slice(0, 3).join("; ")}` }];
      }
      const offenders = frameReasoningOffenders(parsed.ideas);
      const ok = offenders.length === 0;
      return [{
        check: spec.check,
        ok,
        detail: ok
          ? `every idea shows its frame's move (${parsed.ideas.length} checked)`
          : `frame declared but not executed — ${offenders.length} idea(s): ${offenders.slice(0, 3).join("; ")}${offenders.length > 3 ? "; …" : ""}`,
      }];
    }
    case "versioned-keyline": {
      if (!hasExecutableFramesContract(recordText)) {
        return [{ check: spec.check, ok: true, detail: `record predates frames-v1 — ${spec.field} not required` }];
      }
      const value = keylineContent(recordText, spec.field);
      const stripped = (value ?? "").replace(/["']/g, "").trim();
      const ok = stripped.length > 0 && stripped !== "[]" && stripped !== "null" && stripped.toUpperCase() !== "TODO";
      return [{ check: spec.check, ok, detail: ok ? spec.detail : spec.failDetail }];
    }
    case "ledger-types": {
      // methodology-compiler-v0 T-005: the type taxonomy is engine-enforced.
      // Scan markdown-table rows for a Type column value; any value outside
      // the taxonomy is a collapse — the boundary between evidence,
      // expertise, inference, and human judgment is the product.
      const rows = recordText.split("\n").filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-+/.test(l) && !/\|\s*Type\s*\|/i.test(l));
      const offenders: string[] = [];
      for (const row of rows) {
        const cols = row.split("|").map((c) => c.trim());
        for (const col of cols) {
          const m = col.match(/^(repo-evidence|approved-context|role-expertise|agent-inference|user-judgment|[a-z]+-(?:evidence|context|expertise|inference|judgment))$/);
          if (m && !spec.taxonomy.includes(m[1])) offenders.push(m[1]);
        }
      }
      const ok = offenders.length === 0;
      return [{
        check: spec.check,
        ok,
        detail: ok
          ? "ledger judgment types stay within the taxonomy"
          : `ledger type(s) outside the taxonomy (collapsed or invented): ${[...new Set(offenders)].join(", ")}`,
      }];
    }
    case "diversity-meter": {
      const findings: GateFinding[] = [];
      const div = recordText.match(
        /^diversity:\s*\{\s*raw:\s*(\d+),\s*distinct_clusters:\s*(\d+),\s*near_dupes_merged:\s*(\d+),\s*exhausted:\s*(true|false)\s*\}/m,
      );
      if (!div) {
        findings.push({
          check: spec.check,
          ok: false,
          detail: "diversity meter missing (raw / distinct_clusters / near_dupes_merged / exhausted)",
        });
        return findings;
      }
      const raw = Number(div[1]);
      const clusters = Number(div[2]);
      const exhausted = div[4] === "true";
      findings.push({
        check: spec.check,
        ok: true,
        detail: `raw ${raw}, distinct ${clusters}, merged ${div[3]}, exhausted ${exhausted}`,
      });
      const depth = (grab(recordText, /^depth:\s*(fast|standard|deep)\s*$/m) ?? "standard") as Depth;
      const tier = tierFor(depth);
      const floor = Math.min(spec.floorCap, Number(tier[spec.floorKey] ?? spec.floorCap));
      // A homogeneous pool is flagged, not accepted — unless the run honestly
      // declared the idea space exhausted (the flag stays visible either way).
      findings.push({
        check: "diversity-floor",
        ok: clusters >= floor || exhausted,
        detail:
          clusters >= floor
            ? `distinct clusters ${clusters} ≥ floor ${floor}`
            : exhausted
              ? `below floor (${clusters} < ${floor}) but honestly declared exhausted`
              : `homogeneous pool: ${clusters} distinct cluster(s) < floor ${floor} and not declared exhausted — identical-output run flagged`,
      });
      findings.push({
        check: "no-padding",
        ok: raw >= clusters,
        detail: raw >= clusters ? "raw ≥ clusters" : "cluster count exceeds raw ideas — fabricated clusters",
      });
      return findings;
    }
    case "diversity-provenance": {
      // ideate-cost-v1 R-002 / T-003 C-005. The v0 meter was eyeballed and
      // recorded as data, so the honest states are named and only one of them
      // has to prove anything: `estimated` passes and says so out loud;
      // `measured` must reproduce from the record's own structured ideas.
      const fail = (detail: string): GateFinding[] => [{ check: spec.check, ok: false, detail }];
      const method = readDiversityMethod(recordText);
      if (!method) return fail("diversity_method must read measured or estimated");
      if (method.value === "estimated") {
        return [{
          check: spec.check,
          ok: true,
          detail: method.declared
            ? "diversity meter is estimated — declared, not computed from stored ideas"
            : "diversity meter is estimated — no diversity_method declared, so the number is not a measurement",
        }];
      }
      const parsed = parseIdeaObjects(recordText);
      if (!parsed.present) {
        return fail('claims diversity_method: measured but the record stores no ideas block — add one, or say estimated');
      }
      if (parsed.errors.length) {
        return fail(`claims measured but the stored ideas do not validate: ${parsed.errors.slice(0, 3).join("; ")}`);
      }
      if (parsed.ideas.length === 0) return fail("claims measured over an empty idea pool — nothing was clustered");
      const declared = readDeclaredMeter(recordText);
      if (!declared) return fail("claims measured but the diversity meter line is missing");
      const computed = computeDiversity(parsed.ideas, declared.exhausted);
      const drift = (["raw", "distinct_clusters", "near_dupes_merged"] as const)
        .filter((k) => declared[k] !== computed[k])
        .map((k) => `${k} says ${declared[k]}, computes ${computed[k]}`);
      if (drift.length) {
        // A record that names an older clusterer is stale, not dishonest, and the
        // difference is worth saying: "recompute it" is a fixable instruction,
        // while "your meter does not reproduce" reads as an accusation and sends
        // the reader hunting for a mistake nobody made.
        //
        // An *unstamped* record gets no such benefit of the doubt. A missing
        // stamp is indistinguishable from the original failure this gate was
        // built to catch — a `measured` that was never computed at all — so it
        // keeps the blunt message. Softening it there would let a hand-typed
        // meter excuse itself as merely out of date.
        const stamped = readClustererId(recordText);
        if (stamped && stamped !== CLUSTERER_ID) {
          return fail(
            `meter was computed by clusterer ${stamped}, and ${CLUSTERER_ID} reads the pool differently (${drift.join("; ")}) — re-run foo ideate diversity <record> --write`,
          );
        }
        return fail(`meter does not reproduce from the stored ideas: ${drift.join("; ")}`);
      }
      return [{
        check: spec.check,
        ok: true,
        detail: `meter reproduced from ${parsed.ideas.length} stored idea(s) by ${CLUSTERER_ID}: raw ${computed.raw}, distinct ${computed.distinct_clusters}, merged ${computed.near_dupes_merged}`,
      }];
    }
  }
}

export function checkRecord(family: FamilyDefinition, recordText: string): GateResult {
  const findings: GateFinding[] = [];
  for (const spec of family.gates) {
    findings.push(...runGate(spec, recordText, (d) => family.depths[d]));
  }
  return { ok: findings.every((f) => f.ok), findings };
}
