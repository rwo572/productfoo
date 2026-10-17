// pitch-command-v0 — `foo pitch <opportunity>`: the whether & why gate.
//
// pitch is an authoring command: its intelligence lives in the skill
// (skills/pitch/SKILL.md) and the reviewed command doc (commands/pitch.md), not
// in a heavy CLI engine. This module emits a bounded, deterministic PLAN + the
// output path the agent then fills — the same "CLI declares, agent authors"
// shape research uses, minus the source fan-out. It performs no network, no
// mutation, no outbound action (read-and-synthesize-only, R-005).

import path from "node:path";
import { estimatePitch, type DeepEstimate } from "./research.js";
import { loadPricing } from "./loopBudget.js";
import { loadModelRoster, resolveActiveModel } from "./activeModel.js";
import { flagValue, hasFlag } from "./cliArgs.js";
import { resolveFirecrawlKey } from "./tokenStore.js";

export type PitchStage = "auto" | "0to1" | "1ton" | "nx";

const STAGES: Record<Exclude<PitchStage, "auto">, string> = {
  "0to1": "New product (0→1): net-new solution / new market; highest innovation + market-introduction risk.",
  "1ton": "Major enhancement (1→n): expand an existing product — new features, markets, or value proposition.",
  nx: "Incremental improvement (n^x): refine an established product; smaller changes that compound.",
};

export type SourceStatus = "available" | "absent";

export interface PitchSources {
  repo: SourceStatus;
  web_free: SourceStatus;
  web_firecrawl: SourceStatus;
  /** Human-readable reason for the firecrawl status (present-and-use vs degrade). */
  web_firecrawl_note: string;
}

const SECTION_COUNT = 7; // the PR/FAQ sections below
const PANEL_COUNT = 2;   // the pitch panel lenses below

export interface PitchPlan {
  command: "pitch";
  /** Pre-flight cost of the planned work — bounded by sections x panel, honest about what it excludes. */
  estimate: DeepEstimate;
  opportunity: string;
  stage: PitchStage;
  stage_note: string | null;
  output_path: string;
  from_research: string[];
  to_shape: boolean;
  posture: "read-and-synthesize-only";
  page_budget: string;
  sources: PitchSources;
  evidence_directive: string;
  skill: string;
  references: string[];
  sections: string[];
  panel: string[];
  verdict_options: ["GO", "NOT-NOW", "NO-GO"];
  next: string;
}

// Detect which external evidence classes this run may use. Mirrors research's
// source-class contract so pitch can never silently skip an available class:
// firecrawl is capability-gated on a present key/entitlement and degrades to
// free web when absent — it is never a block, and private/connected content is
// never sent to it.
export function detectPitchSources(env: NodeJS.ProcessEnv = process.env): PitchSources {
  // Env-first, then the key saved by `foo login --firecrawl` (tokenStore).
  const firecrawl = Boolean(resolveFirecrawlKey(env).key);
  return {
    repo: "available",
    web_free: "available",
    web_firecrawl: firecrawl ? "available" : "absent",
    web_firecrawl_note: firecrawl
      ? "use it to verify quantified / load-bearing claims; never send private or connected content to Firecrawl"
      : "degrades to web_free; save a key with `foo login --firecrawl <key>` to enrich (never blocks)",
  };
}

export function slugifyOpportunity(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "opportunity";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseStage(args: string[]): PitchStage {
  if (!hasFlag(args, "--stage")) return "auto";
  const value = flagValue(args, "--stage");
  if (value === "0to1" || value === "1ton" || value === "nx") return value;
  throw new Error(`unknown --stage: ${value ?? "(missing)"}. Use one of: 0to1, 1ton, nx.`);
}

function collectFlagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[i + 1]);
  }
  return out;
}

export function buildPitchPlan(args: string[], env: NodeJS.ProcessEnv = process.env, root: string = process.cwd()): PitchPlan {
  const stage = parseStage(args);
  const fromResearch = collectFlagValues(args, "--from-research");
  const flagValues = new Set([...fromResearch, stage]);
  const opportunity = args
    .filter((a) => !a.startsWith("--") && !flagValues.has(a))
    .join(" ")
    .trim();
  const slug = slugifyOpportunity(opportunity || "opportunity");
  const sources = detectPitchSources(env);
  // Same honest primitive as research: the work is BOUNDED (a ~2-page paper over N
  // sections + a panel), so a range is defensible — but it excludes what the agent
  // actually burns executing it, and says so rather than implying a forecast.
  const active = resolveActiveModel(env, loadModelRoster(root));
  const estimate = estimatePitch(SECTION_COUNT, PANEL_COUNT, loadPricing(root), active.worker);
  return {
    command: "pitch",
    estimate,
    opportunity,
    stage,
    stage_note: stage === "auto" ? null : STAGES[stage],
    output_path: path.posix.join(".foo", "docs", "pitch", `${todayIso()}-${slug}.md`),
    from_research: fromResearch,
    to_shape: args.includes("--to-shape"),
    posture: "read-and-synthesize-only",
    page_budget: "~2 pages, highlights only — early exec/founder read; deeper detail belongs in the full spec.",
    sources,
    evidence_directive:
      "Gather evidence across every available source class; when web_firecrawl is available, use it to verify quantified / load-bearing claims. Report per-class status in the paper; degrade honestly, never silently skip an available class.",
    // Skill pointers are `foo skill` ARGUMENTS, never filesystem paths (R-003,
    // alpha_tester_fixes_v0). `skills/pitch/SKILL.md` does not exist in a thin
    // install and is not a valid `foo skill` argument either — it was a pointer
    // the agent could not open by any route. A name resolves on disk or over the wire.
    skill: "pitch",
    references: ["pitch/references/prfaq-template.md", "pitch/references/opportunity-assessment.md"],
    sections: [
      "Press Release (worked backwards: heading, precise-customer subheading, summary + real launch date, customer-POV problem, differentiated solution, quotes)",
      "External FAQ",
      "Internal FAQ = staged opportunity assessment (0→1 / 1→n / n^x)",
      "What must be true · Top 3 reasons it fails · Current solution & will they switch",
      "Evidence (every claim typed [source · confidence] or hypothesis)",
      "Recommendation (GO / NOT-NOW / NO-GO + numbered next steps + B3 risk read)",
      "Panel dissent",
    ],
    panel: ["research-tuned lenses", "PR/FAQ reviewer (customer? problem? solution? behavior change? prize?)"],
    verdict_options: ["GO", "NOT-NOW", "NO-GO"],
    next: "Author the Pitch paper per `foo skill pitch`, then hand off with --to-shape or point deeper work at the full spec (foo spec then spec start).",
  };
}

function renderPlanText(plan: PitchPlan): string {
  const lines: string[] = [];
  lines.push("foo pitch — Working Backwards PR/FAQ × staged opportunity assessment");
  lines.push("");
  if (!plan.opportunity) {
    lines.push("No opportunity given. Provide one, e.g.:");
    lines.push('  foo pitch "governed PR/FAQ command for coding agents" --stage 0to1 --to-shape');
    lines.push("");
    lines.push("Then author the paper per `foo skill pitch` (frame the customer first, pick the stage).");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Opportunity : ${plan.opportunity}`);
  lines.push(`Stage       : ${plan.stage}${plan.stage_note ? ` — ${plan.stage_note}` : " (confirm 0→1 / 1→n / n^x)"}`);
  lines.push(`Output      : ${plan.output_path} (gitignored scratch; promote to commit)`);
  lines.push(`Budget      : ${plan.page_budget}`);
  lines.push(
    plan.estimate.expected_usd === null
      ? `Cost        : ${plan.estimate.expected_tokens.toLocaleString("en-US")}–${plan.estimate.ceiling_tokens.toLocaleString("en-US")} tokens (dollars unavailable — ${plan.estimate.priced_with})`
      : `Cost        : ~$${plan.estimate.expected_usd.toFixed(2)}–$${plan.estimate.ceiling_usd!.toFixed(2)} for the planned paper (${plan.estimate.expected_tokens.toLocaleString("en-US")}–${plan.estimate.ceiling_tokens.toLocaleString("en-US")} tokens, priced with ${plan.estimate.priced_with})`,
  );
  lines.push(`              floor, not a forecast — excludes ${plan.estimate.excludes[0]}`);
  lines.push(`Posture     : ${plan.posture}`);
  lines.push(
    `Sources     : repo ${plan.sources.repo} · web_free ${plan.sources.web_free} · web_firecrawl ${plan.sources.web_firecrawl} — ${plan.sources.web_firecrawl_note}`,
  );
  if (plan.from_research.length) lines.push(`Seeded from : ${plan.from_research.join(", ")}`);
  lines.push(`Hand off    : ${plan.to_shape ? "foo spec (carry labeled claims + dissent + verdict)" : "add --to-shape to route into foo spec"}`);
  lines.push("");
  lines.push("Author these sections (run `foo skill pitch` and execute as written):");
  for (const s of plan.sections) lines.push(`  - ${s}`);
  lines.push("");
  lines.push(`Panel (never blocks): ${plan.panel.join("; ")}`);
  lines.push(`Verdict: one of ${plan.verdict_options.join(" / ")}. ${plan.next}`);
  return `${lines.join("\n")}\n`;
}

export function runPitchCommand(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { output: string; exitCode: number } {
  const plan = buildPitchPlan(args, env, root);
  if (args.includes("--json")) {
    return { output: `${JSON.stringify(plan, null, 2)}\n`, exitCode: 0 };
  }
  return { output: renderPlanText(plan), exitCode: 0 };
}
