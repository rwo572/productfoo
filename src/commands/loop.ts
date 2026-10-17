// `foo loop design|check|status|estimate|routine` plus the top-level
// `foo estimate` (spec-budget-v0), which reuses the same pricing primitives.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkLoopContracts, loadLoopContracts, renderLoopDesign, renderLoopStatus, writeAgreedBudget } from "../loopContracts.js";
import { buildAgreedBudget, estimateLoopBudget, handshakeFloorUsd, loadPricing, measureSourcesCounted } from "../loopBudget.js";
import { autonomyDenied, loadModelRoster, resolveActiveModel } from "../activeModel.js";
import { estimateSpecBudget, type TierEstimate } from "../specBudget.js";
import { parse as parseYaml } from "../vendorYaml.js";
import { parseRoutines, validateRoutine, emitBinding } from "../routines.js";
import { supportedRuntimes, type RuntimeId } from "../agentAdapters.js";
import { glyphsEnabled, withGlyph } from "../statusGlyphs.js";
import { flagValue, hasFlag, resolvePacketDir } from "./shared.js";
import { UsageError } from "../errorTaxonomy.js";

export async function runLoopCommand(root: string, command: string | undefined, packetArg: string | undefined, args: string[]): Promise<string> {
  if (!command) throw new UsageError("loop command missing", "E_COMMAND_MISSING");
  const { packetDir } = resolvePacketDir(root, packetArg);

  if (command === "design") return renderLoopDesign(packetDir);
  if (command === "check") {
    const strictBudget = hasFlag(args, "--strict-budget") || process.env.FOO_BUDGET_REQUIRED === "1";
    return `${checkLoopContracts(root, packetDir, { strictBudget })}\n`;
  }
  if (command === "status") return `${JSON.stringify(renderLoopStatus(packetDir), null, 2)}\n`;
  if (command === "estimate") return runLoopEstimate(root, packetDir, args);

  throw new UsageError(`unknown loop command: ${command}`, "E_BAD_FLAG");
}

// foo loop routine <packet> [--emit <runtime>] [--json] [--strict]
// (portable-routines-v0): validate the routines in loops.yaml, resolve the
// runtimes they are bound to, and optionally emit a per-runtime binding. The
// contract is canonical; only the binding is per-runtime. Advisory by default; a
// B4 autonomy finding blocks only under --strict.
export function runLoopRoutine(root: string, packetDir: string, args: string[]): { output: string; exitCode: number } {
  const { specId, routines } = parseRoutines(packetDir);
  const packetRel = path.relative(root, packetDir).split(path.sep).join("/");
  const json = hasFlag(args, "--json");
  const emit = flagValue(args, "--emit");

  if (emit) {
    const routineId = flagValue(args, "--routine");
    const routine = routineId ? routines.find((r) => r.id === routineId) : routines[0];
    if (!routine) throw new Error(routineId ? `routine ${routineId} not found` : "no routines in loops.yaml");
    return { output: emitBinding(routine, emit as RuntimeId, packetRel), exitCode: 0 };
  }

  const report = routines.map((routine) => ({
    routine: routine.id,
    title: routine.title,
    trigger: routine.trigger,
    unattended: routine.unattended,
    runtimes: routine.runtimes,
    findings: validateRoutine(routine),
  }));
  const b4 = report.flatMap((r) => r.findings).filter((f) => f.boundary === "B4");
  // B4 is the autonomy boundary: it blocks only under --strict (signals-over-gates).
  const exitCode = hasFlag(args, "--strict") && b4.length > 0 ? 1 : 0;

  if (json) {
    return {
      output: `${JSON.stringify({ spec_id: specId, packet: packetRel, routines: report, supported_runtimes: supportedRuntimes() }, null, 2)}\n`,
      exitCode,
    };
  }

  const glyphs = glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args });
  const lines: string[] = [];
  if (routines.length === 0) {
    lines.push("No routines in loops.yaml. A routine is a loop with a schedule/event trigger and an adapters block.");
    lines.push("Next: foo loop design <packet-dir> > <packet-dir>/loops.yaml, then add trigger + adapters.");
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }
  lines.push(withGlyph(b4.length > 0 ? "drift" : "proven", `routines in ${packetRel} (${routines.length})`, glyphs));
  for (const r of report) {
    const triggerDesc = r.trigger.kind === "schedule" ? `schedule ${r.trigger.cron ?? "(no cron)"}` : r.trigger.kind;
    lines.push(`  ${r.routine} ${r.title} — ${triggerDesc}${r.unattended ? " · unattended" : ""}`);
    lines.push(`    runtimes: ${r.runtimes.join(", ") || "(none bound)"}`);
    for (const f of r.findings) {
      lines.push(`    [${f.boundary ?? f.class}/${f.severity}] ${f.summary}`);
    }
  }
  lines.push("");
  lines.push(`  Supported runtimes: ${supportedRuntimes().join(", ")}. Emit a binding: foo loop routine ${packetRel} --emit <runtime>`);
  lines.push(
    b4.length > 0
      ? "\n[boundary] B4 autonomy — an unattended routine missing verify/terminal/approval is unbounded; run with --strict to block."
      : "\n[signal] advisory only — routine validation surfaces findings, it does not block.",
  );
  return { output: `${lines.join("\n")}\n`, exitCode };
}

// foo loop estimate: pre-flight cost estimate for a loop, as a range, never a
// single number (R-003). Dry-run by default — it writes nothing. With --agree
// it records the agreed budget into loops.yaml and appends a budget_agreed
// event as provenance (R-004), reusing the dry-run-before-writes pattern.
async function runLoopEstimate(root: string, packetDir: string, args: string[]): Promise<string> {
  const asJson = hasFlag(args, "--json");
  const agree = hasFlag(args, "--agree");
  const loopId = flagValue(args, "--loop");
  const unitArg = flagValue(args, "--unit");
  if (unitArg && unitArg !== "usd" && unitArg !== "tokens") throw new UsageError("--unit must be usd or tokens", "E_BAD_FLAG");

  const { loops } = loadLoopContracts(packetDir);
  const loop = loopId ? loops.find((entry) => entry.id === loopId) : loops[0];
  if (!loop) throw new Error(loopId ? `loop ${loopId} not found` : "no loops in loops.yaml");

  const pricing = loadPricing(root);
  const unit = (unitArg as "usd" | "tokens" | undefined) ?? loop.budget?.unit ?? "usd";

  // Measure sources with count_tokens when a key is available (the accurate
  // tier); --structural forces the offline approximation. Either way the cost
  // model stays heuristic in V0.
  // Resolve the active model once (glm-model-awareness-v0 R-001/D-003 single source):
  // a budget model_mix still wins, else default to the resolved worker (GLM behind the
  // harness prices at GLM rates, not hardcoded Opus). The roster is data, loaded from
  // the same root as the price table (model-roster-data-v0 R-001).
  const active = resolveActiveModel(process.env, loadModelRoster(root));
  const worker = loop.budget?.estimate?.model_mix?.worker ?? active.worker;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  // R-002 (OQ-4): egress is opt-in. Default to the structural tier; only send
  // source content to the count_tokens API when explicitly asked, and even then
  // the egress guard redacts/refuses secret-bearing or local-only sources. The
  // endpoint follows the active base URL (R-003), not the hardcoded Anthropic one.
  const preferApi = hasFlag(args, "--count-tokens") && !hasFlag(args, "--structural");
  const measured = await measureSourcesCounted(packetDir, loop.observe.sources, { model: worker, apiKey, preferApi, countTokensUrl: active.countTokensUrl, routedNonNative: active.routed });

  const result = estimateLoopBudget({ packetDir, sources: loop.observe.sources, pricing, unit, budget: loop.budget, measured, active });

  const floor = handshakeFloorUsd();
  // B4 fail-closed: an unpriced estimate (degraded pricing / unknown model) can
  // never claim to be below the handshake floor (model-roster-data-v0 R-002).
  const belowThreshold = result.priced && result.usd.expected < floor;

  const glyphs = glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args });

  if (!agree) {
    if (asJson) {
      return `${JSON.stringify({ loop: loop.id, dry_run: true, below_threshold: belowThreshold, handshake_floor_usd: floor, estimate: result }, null, 2)}\n`;
    }
    return renderEstimateCard(loop.id, result, { agreed: false, belowThreshold, floor, glyphs });
  }

  // T-005 / R-005: autonomy on GLM is default-deny — the one place GLM-awareness
  // BLOCKS (a B4 boundary, not a signal). Estimation above still works (you can price
  // a GLM loop); only the --agree approval handshake is gated, until both follow-ons
  // land. Override is deliberate and logged, mirroring FOO_ALLOW_MAIN_EDITS.
  const glmAutonomyOverride = process.env.FOO_ALLOW_GLM_AUTONOMY === "1";
  if (autonomyDenied(active.family) && !glmAutonomyOverride) {
    throw new Error(
      "autonomy on GLM is default-deny (glm-model-awareness-v0 T-005 / R-005).\n" +
        "GLM's weaker self-correction makes it a degraded verifier of its own loop, and the\n" +
        "inference-egress boundary is not yet in place. Unblocks when BOTH land:\n" +
        "  - glm-inference-egress-boundary-v0 (R-006a)\n" +
        "  - glm-eval-goldenset-v0 (R-006b)\n" +
        "Run on a native (Anthropic) model, or override deliberately with FOO_ALLOW_GLM_AUTONOMY=1.",
    );
  }

  // --agree: write the agreed budget and record provenance. For an unmeasurable loop
  // there is no estimate to agree to — the human names a cap instead (--limit).
  const limitRaw = flagValue(args, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && !Number.isFinite(limit)) throw new UsageError("--limit requires a dollar amount, e.g. --limit 2.00", "E_BAD_FLAG");
  const by = flagValue(args, "--by") ?? process.env.USER ?? "unknown";
  const at = new Date().toISOString();
  const budget = buildAgreedBudget(result, { by, at, limit });
  writeAgreedBudget(packetDir, loop.id, budget);
  appendBudgetAgreedEvent(packetDir, loop, result, { by, at });
  // A deliberate GLM-autonomy override is auditable: record who bypassed the boundary.
  if (active.family === "glm" && glmAutonomyOverride) {
    appendAutonomyOverrideEvent(packetDir, loop, active, { by, at });
  }

  if (asJson) {
    return `${JSON.stringify({ loop: loop.id, agreed: true, by, at, budget }, null, 2)}\n`;
  }
  return renderEstimateCard(loop.id, result, { agreed: true, belowThreshold, floor, by, glyphs });
}

function renderEstimateCard(
  loopId: string,
  result: ReturnType<typeof estimateLoopBudget>,
  meta: { agreed: boolean; belowThreshold: boolean; floor: number; by?: string; glyphs: boolean },
): string {
  const lines: string[] = [];
  lines.push(`Loop ${loopId} budget estimate (basis: ${result.basis}, confidence: ${result.confidence})`);
  // R-004 / T-004: when the active model is only assumed (inferred from a base-URL
  // override), fly the ⚠️ tag so the estimate is never read as a confident,
  // model-confirmed number. Glyph is human-surface-only; the word carries the meaning
  // when glyphs are off. Never reaches --json (early return above).
  const active = result.model_provenance;
  const egressGated = result.measured_method === "structural_egress_gated";
  if (active.confidence === "assumed" || egressGated) {
    const pricedFamily = /glm/i.test(result.model_mix.worker) ? "glm" : /claude/i.test(result.model_mix.worker) ? "claude" : "unknown";
    let tag: string;
    if (egressGated) {
      // D-010: count_tokens was withheld because the endpoint is a routed third party,
      // so the estimate is structural even though a key was available — say so (D-002).
      tag = `  estimated · count_tokens withheld (egress-gated: routed to ${active.provider}) — structural until the inference-egress boundary lands`;
    } else if (pricedFamily !== active.family) {
      // The budget was pinned for one family but a different model is live now —
      // honor the recorded pin, but surface the conflict instead of silently re-pricing.
      tag = `  estimated · budget pinned for ${pricedFamily}, but ${active.family} (${active.provider}) is active — re-estimate to price the live model`;
    } else {
      tag = `  estimated · model: unconfirmed (assumed ${active.family} via ${active.provider} base URL)`;
    }
    lines.push(withGlyph("drift", tag, meta.glyphs));
  }
  // Degraded/unknown-model findings (model-roster-data-v0 R-002/R-003): always
  // worded; the ⚠️ drift glyph rides along only on a human TTY (glyphsEnabled
  // gating upstream), never into --json (early return above).
  for (const finding of result.findings) {
    lines.push(withGlyph("drift", `  finding: ${finding}`, meta.glyphs));
  }
  // No fabricated range for a loop whose cost we genuinely cannot know. Printing
  // "$1.0100 expected .. $2.5250 ceiling" for a loop that reads the web is false
  // precision: four decimal places of confidence on a guess. Say "unknown" instead.
  lines.push(
    result.unmeasurable
      ? "  Dollars: unknown — this loop reads sources productfoo cannot size (see findings above)"
      : result.priced
        ? `  Dollars: $${result.usd.expected.toFixed(2)} expected .. $${result.usd.ceiling.toFixed(2)} ceiling`
        : "  Dollars: unavailable — token-only estimate (see findings above)",
  );
  lines.push(
    result.unmeasurable
      ? "  Tokens:  unknown — observation size is not knowable offline"
      : `  Tokens:  ${result.tokens.expected} expected .. ${result.tokens.ceiling} ceiling`,
  );
  lines.push(`  Unit agreed in: ${result.unit}`);
  lines.push(`  Iterations: ${result.expected_iterations} expected .. ${result.ceiling_iterations} ceiling`);
  lines.push(`  Models: worker=${result.model_mix.worker}, verifier=${result.model_mix.verifier}`);
  lines.push(`  Token source: ${result.measured_method === "count_tokens" ? `count_tokens API (${result.model_provenance.provider})` : result.measured_method === "structural_egress_gated" ? "structural (count_tokens withheld — egress-gated)" : "structural approximation"}`);
  lines.push(`  Priced with: ${result.priced_with}`);
  if (result.stale) lines.push(`  WARNING: price table is ${result.stale_age_days} days old (stale).`);
  lines.push("  Measured sources:");
  for (const source of result.measured) {
    lines.push(`    - ${source.source}: ${source.found ? `${source.tokens} tokens` : "MISSING (counted as 0)"}`);
  }
  if (meta.agreed) {
    lines.push(`  AGREED by ${meta.by}; budget written to loops.yaml and budget_agreed event recorded.`);
  } else if (meta.belowThreshold) {
    lines.push(`  Below the $${meta.floor.toFixed(2)} handshake floor — would auto-approve. Re-run with --agree to record it.`);
  } else if (!result.priced) {
    lines.push(
      `  Unpriced — cannot compare to the $${meta.floor.toFixed(2)} handshake floor; treated as at/above it (fail-closed, B4). Restore pricing data, or agree a token budget with --unit tokens --agree.`,
    );
  } else {
    lines.push(`  Above the $${meta.floor.toFixed(2)} handshake floor — agreement required. Re-run with --agree to accept.`);
  }
  return `${lines.join("\n")}\n`;
}

function appendBudgetAgreedEvent(
  packetDir: string,
  loop: { id: string },
  result: ReturnType<typeof estimateLoopBudget>,
  who: { by: string; at: string },
): void {
  const eventsPath = path.join(packetDir, "events.jsonl");
  const event = {
    specversion: "0.1",
    id: `evt_loop_budget_agreed_${Date.now()}`,
    source: "agent://foo/loop-estimate",
    type: "com.adaptivespec.loop.budget_agreed",
    subject: `loop:${loop.id}`,
    time: who.at,
    actor: { type: "human", id: who.by, mode: "human-in-loop" },
    data: {
      summary: `Agreed a budget for loop ${loop.id}: $${result.usd.expected.toFixed(4)} expected, $${result.usd.ceiling.toFixed(4)} ceiling.`,
      unit: result.unit,
      expected_usd: result.usd.expected,
      ceiling_usd: result.usd.ceiling,
      expected_tokens: result.tokens.expected,
      ceiling_tokens: result.tokens.ceiling,
      basis: result.basis,
      confidence: result.confidence,
      priced_with: result.priced_with,
    },
    extensions: {},
  };
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
}

// Record a deliberate GLM-autonomy override (T-005). The boundary is default-deny;
// when a human sets FOO_ALLOW_GLM_AUTONOMY=1 to bypass it, that bypass is auditable —
// who, when, and which model family it waived.
function appendAutonomyOverrideEvent(
  packetDir: string,
  loop: { id: string },
  active: ReturnType<typeof resolveActiveModel>,
  who: { by: string; at: string },
): void {
  const eventsPath = path.join(packetDir, "events.jsonl");
  const event = {
    specversion: "0.1",
    id: `evt_glm_autonomy_override_${Date.now()}`,
    source: "agent://foo/loop-estimate",
    type: "com.adaptivespec.loop.glm_autonomy_override",
    subject: `loop:${loop.id}`,
    time: who.at,
    actor: { type: "human", id: who.by, mode: "human-in-loop" },
    data: {
      summary: `GLM autonomy default-deny overridden via FOO_ALLOW_GLM_AUTONOMY for loop ${loop.id}.`,
      provider: active.provider,
      model: active.worker,
      family: active.family,
    },
    extensions: {},
  };
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
}

// foo estimate <packet>: per-release-tier token/dollar cost ranges for a spec
// packet (spec-budget-v0). Read-only; reuses the loop-budget price/count_tokens
// primitives. Tokens-only — engineer-effort and calendar-time are out of scope.
export async function runSpecEstimate(root: string, packetDir: string, packetLabel: string, args: string[]): Promise<string> {
  const asJson = hasFlag(args, "--json");
  const unitArg = flagValue(args, "--unit");
  if (unitArg && unitArg !== "usd" && unitArg !== "tokens") throw new UsageError("--unit must be usd or tokens", "E_BAD_FLAG");
  const tierArg = flagValue(args, "--tier");
  if (tierArg && !["core", "next", "deferred", "all"].includes(tierArg)) {
    throw new UsageError("--tier must be core, next, deferred, or all", "E_BAD_FLAG");
  }
  const passesArg = flagValue(args, "--passes");

  const pricing = loadPricing(root);
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  // R-002 (OQ-4): egress is opt-in. Default to the structural tier; only send
  // source content to the count_tokens API when explicitly asked, and even then
  // the egress guard redacts/refuses secret-bearing or local-only sources.
  const preferApi = hasFlag(args, "--count-tokens") && !hasFlag(args, "--structural");

  const estimate = await estimateSpecBudget({
    packetDir,
    packetLabel,
    pricing,
    unit: (unitArg as "usd" | "tokens" | undefined) ?? "usd",
    buildPasses: passesArg ? Number(passesArg) : undefined,
    apiKey,
    preferApi,
    repoRoot: root,
    // Roster and price table load from the same root (model-roster-data-v0 R-001).
    active: resolveActiveModel(process.env, loadModelRoster(root)),
  });

  const tiers = tierArg && tierArg !== "all" ? estimate.tiers.filter((tier) => tier.tier === tierArg) : estimate.tiers;


  if (asJson) {
    // --tier filters the tiers, so `total` MUST be recomputed over the filtered
    // set. Shipping the full-packet total next to a filtered tier list made the
    // human and JSON surfaces disagree — the human card recomputed, the JSON
    // did not, so an agent reading --json --tier core got the core+next number.
    const total = {
      expected_tokens: tiers.reduce((s, t) => s + t.expected_tokens, 0),
      ceiling_tokens: tiers.reduce((s, t) => s + t.ceiling_tokens, 0),
      expected_usd: sumExpected(tiers),
      ceiling_usd: sumCeiling(tiers),
      expected_minutes: sumMinutes(tiers, "expected_minutes"),
      ceiling_minutes: sumMinutes(tiers, "ceiling_minutes"),
    };
    return `${JSON.stringify({ ...estimate, tiers, total }, null, 2)}\n`;
  }
  const glyphs = glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args });
  let card = renderSpecEstimateCard(estimate, tiers, glyphs);
  if (hasFlag(args, "--per-task")) {
    const tasksPath = path.join(packetDir, "tasks.yaml");
    if (existsSync(tasksPath)) {
      const doc = parseYaml(readFileSync(tasksPath, "utf8")) as { tasks?: { id?: string; title?: string; status?: string; refs?: string[] }[] };
      const tasks = (doc.tasks ?? []).map((t) => ({
        id: String(t.id ?? "?"),
        title: String(t.title ?? ""),
        status: String(t.status ?? "?"),
        refs: Array.isArray(t.refs) ? t.refs.map(String) : [],
      }));
      card = `${card}${renderPerTask(estimate, tasks)}\n`;
    }
  }
  return card;
}

// Money, rounded to what the estimate can actually support. A `heuristic` /
// `low confidence` number whose tokens come from `text.length / 4` has no
// business rendering to a hundredth of a cent — `$0.0714` is the fake precision
// R-004 forbids. Cents below a dollar, two decimals above (D-014).
//
// The `<1¢` case is load-bearing and was a bug here: rounding a real-but-tiny
// cost to "0¢" reprints the exact lie D-014 exists to kill — `0` reads as FREE,
// not as "too small to show". Only a genuinely zero cost may render as zero.
function money(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<1¢";
  if (usd < 1) return `${Math.round(usd * 100)}¢`;
  return `$${usd.toFixed(2)}`;
}

// A range, always (R-004: never a single number). Collapses to one figure only
// when the two ends round to the same thing — printing "7¢–7¢" is noise.
function moneyRange(lo: number | null, hi: number | null): string | null {
  const a = money(lo);
  const b = money(hi);
  if (a === null || b === null) return null;
  return a === b ? a : `${a}–${b}`;
}

// When there are no dollars, TOKENS are the estimate — so the cost column falls
// back to them. An unpriced run that shows an empty column has told the user
// nothing, which is worse than the $0.0000 it replaced.
function tokensRange(lo: number, hi: number): string {
  const fmt = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));
  const a = fmt(lo);
  const b = fmt(hi);
  return a === b ? `${a} tok` : `${a}–${b} tok`;
}

function minutesRange(lo: number | null, hi: number | null): string | null {
  if (lo === null || hi === null) return null;
  const fmt = (m: number) => (m < 1 ? "<1" : String(Math.round(m)));
  const a = fmt(lo);
  const b = fmt(hi);
  return a === b ? `${a} min` : `${a}–${b} min`;
}

function pctLabel(pct: number | null): string {
  if (pct === null) return "";
  const sign = pct > 0 ? "+" : "";
  return ` (${sign}${pct}%)`;
}

function renderSpecEstimateCard(estimate: Awaited<ReturnType<typeof estimateSpecBudget>>, tiers: typeof estimate.tiers, glyphs: boolean): string {
  const lines: string[] = [];
  const cols = (a: string, b: string | null, c: string | null): string => {
    const parts = [a.padEnd(26)];
    if (b !== null) parts.push(b.padEnd(12));
    if (c !== null) parts.push(c);
    return parts.join("").trimEnd();
  };

  lines.push(`${estimate.packet} — what this costs to build, on your current model`);
  for (const finding of estimate.findings) {
    lines.push(withGlyph("drift", `  finding: ${finding}`, glyphs));
  }
  if (!estimate.priced) {
    lines.push("  No price for this model — the token and time ranges below ARE the estimate.");
  }
  lines.push("");

  // --- What it costs, by tier -----------------------------------------------
  lines.push(`  Right now  ·  ${estimate.worker_model}`);
  for (const tier of tiers) {
    const cost = moneyRange(tier.expected_usd, tier.ceiling_usd) ?? tokensRange(tier.expected_tokens, tier.ceiling_tokens);
    lines.push(`    ${cols(tier.tier, cost, minutesRange(tier.expected_minutes, tier.ceiling_minutes))}`);
  }
  if (tiers.length > 1) {
    const label = `all (${tiers.map((t) => t.tier).join("+")})`;
    const allCost =
      moneyRange(sumExpected(tiers), sumCeiling(tiers)) ??
      tokensRange(
        tiers.reduce((s2, t) => s2 + t.expected_tokens, 0),
        tiers.reduce((s2, t) => s2 + t.ceiling_tokens, 0),
      );
    lines.push(`    ${cols(label, allCost, minutesRange(sumMinutes(tiers, "expected_minutes"), sumMinutes(tiers, "ceiling_minutes")))}`);
  }

  // --- Where the cost actually is (the relative signal) ----------------------
  const heavy = tiers
    .flatMap((t) => t.requirements)
    .sort((a, b) => b.share_of_packet - a.share_of_packet)
    .slice(0, 3)
    .filter((r) => r.share_of_packet > 0);
  if (heavy.length > 0) {
    lines.push("");
    lines.push(`  Where the cost is:  ${heavy.map((r) => `${r.id} (${Math.round(r.share_of_packet * 100)}%)`).join("  ·  ")}`);
  }

  // --- Trade-offs ------------------------------------------------------------
  if (estimate.tradeoffs.length > 0) {
    lines.push("");
    lines.push("  Trade-offs");
    estimate.tradeoffs.forEach((t, i) => {
      const cost = moneyRange(t.expected_usd, t.expected_usd) ?? tokensRange(t.expected_tokens, t.expected_tokens);
      const price = `${cost}${pctLabel(t.delta_usd_pct)}`;
      const time = t.expected_minutes === null ? "" : `${minutesRange(t.expected_minutes, t.expected_minutes)}${pctLabel(t.delta_minutes_pct)}`;
      lines.push(`    ${i + 1}. ${t.label}`);
      if (price || time) lines.push(`       ${[price, time].filter(Boolean).join("   ·   ")}`);
      lines.push(`       costs you: ${t.costs_you}`);
    });
  }

  // --- The honesty block -----------------------------------------------------
  lines.push("");
  lines.push(`  ${estimate.basis}, ${estimate.confidence} confidence — a relative read on which parts are heavy, not a price tag.`);
  lines.push(`  Prices agent tokens${estimate.worker_tokens_per_sec !== null ? " and agent runtime" : ""}. Does NOT price: ${estimate.excludes.join(", ")}.`);
  lines.push(
    `  Assumptions: build_passes=${estimate.build_passes}${estimate.worker_tokens_per_sec !== null ? `, ${estimate.worker_tokens_per_sec} tok/sec` : ""}, tier source=${estimate.tier_source}`,
  );
  lines.push(`  Token source: ${estimate.measured_method === "count_tokens" ? "count_tokens API (redacted, egress-guarded)" : estimate.measured_method === "structural_egress_gated" ? "structural (count_tokens withheld — egress-gated)" : "structural approximation"}`);
  lines.push(`  Priced with: ${estimate.priced_with}`);
  if (estimate.stale) lines.push(withGlyph("drift", `  WARNING: price table is ${estimate.stale_age_days} days old (stale).`, glyphs));

  if (tiers.length === 0) {
    // Nothing parsed. $0 would be a lie — it is not free, it is UNKNOWN. (theirs, kept)
    lines.push("  Cost UNKNOWN — no requirements were parsed from this spec (expected `### R-001 Title` headings).");
    lines.push("  This is not an estimate of zero; it is a failure to estimate.");
  }
  if (estimate.excluded_requirements.length > 0) {
    lines.push(`  Not costed (must-not or unparsed): ${estimate.excluded_requirements.join(", ")}`);
  }
  lines.push("");
  lines.push("  Read this as a FLOOR, not a forecast: it sizes requirement text × build passes.");
  lines.push("  It does not model what an agent actually burns executing the work.");
  return `${lines.join("\n")}\n`;
}

function sumExpected(tiers: { expected_usd: number | null }[]): number | null {
  if (tiers.some((t) => t.expected_usd === null)) return null;
  return Math.round(tiers.reduce((s, t) => s + (t.expected_usd ?? 0), 0) * 10000) / 10000;
}

// --- The hook (spec-budget-v0 R-010) -----------------------------------------
//
// `foo estimate` had ZERO routes in: nothing in foo ever sent a user to it. That
// gap was load-bearing while the number was wrong — it kept a misleading figure
// away from people. Now that the number is honest, cost shows up where scope is
// actually CHOSEN, rather than behind a verb you have to remember.
//
// One front door: this is a LINE on a surface the user already looks at, not a
// second command. The deep view stays `foo estimate <packet>`.
//
// Two rules this helper must never break:
//   1. STRUCTURAL ONLY. A hook fires on surfaces the user did not ask to spend
//      on — it must never egress spec text to count_tokens as a side effect.
//      preferApi is hard-false here; --count-tokens remains opt-in on `foo
//      estimate` itself.
//   2. NEVER BLOCK. A packet with no spec.md, an unparseable spec, or a missing
//      price table returns null and the host surface renders exactly as before.
//      A cost line is a signal, never a gate.
export async function costHeadline(
  root: string,
  packetDir: string,
  opts: { remainingOnly?: boolean } = {},
): Promise<string | null> {
  // Point at the packet the way the user typed it, not an absolute machine path.
  const label = path.relative(root, packetDir) || packetDir;
  try {
    if (!existsSync(path.join(packetDir, "spec.md"))) return null;
    const estimate = await estimateSpecBudget({
      packetDir,
      packetLabel: packetDir,
      pricing: loadPricing(root),
      preferApi: false, // rule 1: a hook never egresses
      repoRoot: root,
      active: resolveActiveModel(process.env, loadModelRoster(root)),
    });
    if (estimate.tiers.length === 0) return null; // nothing parsed => say nothing, not "$0"

    // "Remaining" is the honest number on a status card: a packet that is 80% done
    // does not still cost its full build price. Scale by the share of task-linked
    // requirements not yet done; fall back to the full packet when tasks.yaml has
    // no usable refs (and say "to build", not "remaining", so the words stay true).
    let scale = 1;
    let scopeWord = "to build";
    if (opts.remainingOnly) {
      const tasksPath = path.join(packetDir, "tasks.yaml");
      if (existsSync(tasksPath)) {
        const doc = parseYaml(readFileSync(tasksPath, "utf8")) as { tasks?: { status?: string; refs?: string[] }[] };
        const tasks = doc.tasks ?? [];
        const costed = tasks.filter((t) => Array.isArray(t.refs) && t.refs.length > 0);
        if (costed.length > 0) {
          const open = costed.filter((t) => String(t.status ?? "") !== "done" && String(t.status ?? "") !== "dropped");
          if (open.length === 0) return null; // nothing left to build — no cost line at all
          scale = open.length / costed.length;
          scopeWord = "left to build";
        }
      }
    }

    const lo = estimate.total.expected_usd === null ? null : estimate.total.expected_usd * scale;
    const hi = estimate.total.ceiling_usd === null ? null : estimate.total.ceiling_usd * scale;
    const mLo = estimate.total.expected_minutes === null ? null : estimate.total.expected_minutes * scale;
    const mHi = estimate.total.ceiling_minutes === null ? null : estimate.total.ceiling_minutes * scale;

    const cost =
      moneyRange(lo, hi) ??
      tokensRange(Math.round(estimate.total.expected_tokens * scale), Math.round(estimate.total.ceiling_tokens * scale));
    const time = minutesRange(mLo, mHi);

    // "floor" is not decoration: the estimate omits agent-execution overhead, which
    // is usually the dominant cost. Saying so here keeps the hook from becoming the
    // very price tag the command stopped pretending to be.
    return `${cost}${time ? ` · ${time}` : ""} ${scopeWord} on ${estimate.worker_model} — a floor, not a forecast. Options: foo estimate ${label}`;
  } catch {
    return null; // rule 2: never block the host surface
  }
}

// Dollars at a precision the estimate can actually support. "$0.0057" implies a
// confidence this heuristic does not have; below a cent, say so in words.
function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

// Per-task cost (R: "an estimate per task in a spec"). A task's cost is the cost of
// the requirements it implements, split across every task that shares them — so the
// per-task column sums back to the tier total instead of double-counting shared work.
export function renderPerTask(
  estimate: Awaited<ReturnType<typeof estimateSpecBudget>>,
  tasks: { id: string; title: string; status: string; refs: string[] }[],
): string {
  const reqCost = new Map<string, { expected: number; ceiling: number }>();
  for (const tier of estimate.tiers) {
    // D-014: a null (unpriced) requirement is UNKNOWN, not free — it must not
    // silently contribute 0 to a task's cost. Skip it; it surfaces as uncosted.
    for (const req of tier.requirements) {
      if (req.expected_usd === null || req.ceiling_usd === null) continue;
      reqCost.set(req.id, { expected: req.expected_usd, ceiling: req.ceiling_usd });
    }
  }
  const sharers = new Map<string, number>();
  for (const task of tasks) {
    for (const ref of task.refs) sharers.set(ref, (sharers.get(ref) ?? 0) + 1);
  }

  const lines: string[] = ["", "  Per task (requirement cost split across the tasks that share it):"];
  let totalE = 0;
  let totalC = 0;
  const uncosted: string[] = [];
  for (const task of tasks) {
    let e = 0;
    let c = 0;
    let costed = false;
    for (const ref of task.refs) {
      const cost = reqCost.get(ref);
      if (!cost) continue;
      const share = sharers.get(ref) ?? 1;
      e += cost.expected / share;
      c += cost.ceiling / share;
      costed = true;
    }
    if (!costed) {
      uncosted.push(task.id);
      lines.push(`     ${task.id} ${task.status.padEnd(7)} cost unknown — no costed requirement  · ${task.title}`);
      continue;
    }
    totalE += e;
    totalC += c;
    lines.push(`     ${task.id} ${task.status.padEnd(7)} ${usd(e)} .. ${usd(c)}  · ${task.title}`);
  }
  lines.push(`     ${"".padEnd(4)} ${"".padEnd(7)} ${usd(totalE)} .. ${usd(totalC)}  · TOTAL across costed tasks`);
  if (uncosted.length > 0) {
    lines.push(`  ${uncosted.length} task(s) carry no costed requirement (refs missing or unparsed): ${uncosted.join(", ")}`);
  }
  return lines.join("\n");
}

function sumCeiling(tiers: { ceiling_usd: number | null }[]): number | null {
  if (tiers.some((t) => t.ceiling_usd === null)) return null;
  return Math.round(tiers.reduce((s, t) => s + (t.ceiling_usd ?? 0), 0) * 10000) / 10000;
}

function sumMinutes(tiers: TierEstimate[], key: "expected_minutes" | "ceiling_minutes"): number | null {
  if (tiers.some((t) => t[key] === null)) return null;
  return Math.round(tiers.reduce((s, t) => s + (t[key] ?? 0), 0) * 10) / 10;
}
