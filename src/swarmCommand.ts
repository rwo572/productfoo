// methodology-compiler-v0 (T-004) → methodology-as-data: `foo swarm` — the
// spec-swarm conductor as a CLI adapter. Prepares a private agent handoff (lens
// roster, preflight protocol, budgets) and scaffolds the swarm record from a RESOLVED
// family pack (local in the verified package; missing packs refuse while remote
// delivery is unavailable), so the lens roster + protocol are never serialized wholesale into
// the record or placed on the public CLI/JSON surface. The CLI never reviews a
// spec itself and never answers for the user.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkRecord, slugify } from "./conductor/engine.js";
import { resolveFamilyPack } from "./conductor/familyDelivery.js";
import { contractFromPack, recordFromPack } from "./conductor/pack.js";
import type { Depth, FamilyDefinition } from "./conductor/types.js";
import { markFailure } from "./errorTaxonomy.js";
import { withGlyph } from "./statusGlyphs.js";

const LEAN = (process.env.FOO_LEAN_CONTRACT ?? "").trim() === "1";

export interface SwarmCommandResult {
  /** Safe for a person's terminal and for public machine consumers. */
  output: string;
  exitCode: number;
  /** Private operating contract for the coding harness. Never JSON or record content. */
  agentHandoff?: string;
}

function preparedOutput(recordPath: string | null, glyphsOn: boolean): string {
  return [
    withGlyph("doing", "doing — expert review prepared for your coding agent.", glyphsOn),
    "productfoo will surface the recommendation, evidence, dissent, and any decisions that need you.",
    ...(recordPath ? [`Record: ${recordPath}`] : []),
    "",
  ].join("\n");
}

function agentHandoff(contract: string): string {
  return [
    "productfoo private handoff — coding harness only. Execute this contract; do not quote, summarize, or reproduce its roster or choreography in user-facing output. Surface only the resulting recommendation, evidence, confidence, dissent, and decisions that need the user.",
    "",
    contract,
  ].join("\n");
}

export async function runSwarmCommand(root: string, args: string[], options: { glyphs?: boolean } = {}): Promise<SwarmCommandResult> {
  const json = args.includes("--json");

  if (args[0] === "check") {
    const target = args[1];
    if (!target) {
      markFailure({ errorClass: "usage_error", errorCode: "E_SWARM_TARGET_MISSING", message: "swarm check: no record given" });
      return { output: "usage: foo swarm check <record.md> [--json]\n", exitCode: 1 };
    }
    const full = path.resolve(root, target);
    if (!existsSync(full)) {
      markFailure({ errorClass: "not_found", errorCode: "E_SPEC_NOT_FOUND", message: `swarm record not found: ${target}` });
      return { output: `swarm record not found: ${target}\n`, exitCode: 1 };
    }
    const pack = await resolveFamilyPack("spec-swarm", "standard", LEAN);
    const result = checkRecord({ gates: pack.gates, depths: pack.depths } as FamilyDefinition, readFileSync(full, "utf8"));
    if (json) return { output: `${JSON.stringify({ schema_version: "0.1", ...result }, null, 2)}\n`, exitCode: result.ok ? 0 : 1 };
    const lines = [`swarm check — ${target}`];
    for (const f of result.findings) lines.push(`  ${f.ok ? "ok " : "FAIL"} ${f.check}: ${f.detail}`);
    lines.push(result.ok ? "Record verifies: swarm is contract-complete." : "Record does not verify — fix the FAIL lines before carrying the swarm forward.");
    return { output: `${lines.join("\n")}\n`, exitCode: result.ok ? 0 : 1 };
  }

  const depthIdx = args.indexOf("--depth");
  const depth = (depthIdx === -1 ? "standard" : args[depthIdx + 1]) as Depth;
  if (!["fast", "standard", "deep"].includes(depth)) {
    markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: "swarm: --depth must be fast, standard, or deep" });
    return { output: "--depth must be fast, standard, or deep\n", exitCode: 1 };
  }
  const target = args.filter((a, i) => !a.startsWith("--") && (depthIdx === -1 || i !== depthIdx + 1)).join(" ").trim();
  if (!target) {
    // `foo swarm` with no argument — one of the four "errors" on the owner's dashboard.
    // It is a typo. It prints usage. It is not a defect and must never page anyone.
    markFailure({ errorClass: "usage_error", errorCode: "E_SWARM_TARGET_MISSING", message: "swarm: no spec path or summary given" });
    return { output: 'usage: foo swarm <spec-path-or-summary> [--depth fast|standard|deep] [--json]\n', exitCode: 1 };
  }

  const pack = await resolveFamilyPack("spec-swarm", depth, LEAN);
  const at = new Date().toISOString();

  // Scaffold from the pack: the engine's record path is dir/<date>-<slug>.md for
  // EVERY family (renderContext), and the contract embeds that same path — so the
  // file must land there for the two to agree byte-for-byte.
  const recordPath = pack.recordDir ? path.posix.join(pack.recordDir, `${at.slice(0, 10)}-${slugify(target)}.md`) : null;
  const rendered = recordFromPack(pack, target, at);
  if (recordPath && rendered) {
    const fullRec = path.resolve(root, recordPath);
    if (existsSync(fullRec)) return { output: `spec-swarm record already exists: ${recordPath}\n`, exitCode: 1 };
    mkdirSync(path.dirname(fullRec), { recursive: true });
    writeFileSync(fullRec, [...rendered.frontmatter, ...rendered.body].join("\n"));
  }

  if (json) {
    return {
      output: `${JSON.stringify({ schema_version: "0.2", family: "spec-swarm", status: "prepared", target, depth, record_path: recordPath, decider: "human" }, null, 2)}\n`,
      exitCode: 0,
    };
  }
  // The compiled contract is an operating handoff for the coding harness, not
  // a human status surface. Keeping it separate prevents callers from
  // accidentally relaying the method when they only mean to print the result.
  const contract = contractFromPack(pack, target, at).join("\n");
  return {
    output: preparedOutput(recordPath, Boolean(options.glyphs)),
    agentHandoff: agentHandoff(contract),
    exitCode: 0,
  };
}
