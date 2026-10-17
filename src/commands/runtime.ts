// `foo runtime` reports the active harness AND, when the harness is routed to a
// non-native model endpoint (e.g. Claude Code pointed at z.ai to run GLM 5.2), the
// backing-model signal. This is provenance for the judgment ledger: productfoo's runtime
// identity is the harness, but the model actually answering may be swapped under it.
// Signal, not boundary — it never blocks and never changes branch prefix or the
// elicitation surface. The 🏷️ classification glyph is human-surface-only (gated off
// for --json/piped output by `glyphs`).
import { detectRuntimeId } from "../elicitationSurface.js";
import { describeActiveModel, resolveActiveModel } from "../activeModel.js";
import { withGlyph } from "../statusGlyphs.js";

export function runRuntimeCommand(args: string[], glyphs: boolean): string {
  const runtime = detectRuntimeId();
  const active = resolveActiveModel();

  if (args.includes("--json")) {
    return `${JSON.stringify({ runtime, active }, null, 2)}\n`;
  }

  const lines = [`Runtime (harness): ${runtime}`];
  const note = describeActiveModel(active);
  if (note) {
    // ⚠️ when the model is only assumed (inferred from a base URL); 🏷️ when a routed
    // model is explicitly confirmed. Glyphs are human-surface-only (gated off for --json).
    const state = active.confidence === "assumed" ? "drift" : "classification";
    lines.push(withGlyph(state, `Active model:      ${note}`, glyphs));
    lines.push("  Runtime identity and branch prefix are unchanged — the harness is still " + runtime + ".");
  } else {
    lines.push(`Active model:      native (${runtime} running its own model)`);
  }
  // Roster/unknown-model findings (model-roster-data-v0 R-003): always worded;
  // the ⚠️ drift glyph is human-surface-only (gated off for --json above).
  for (const finding of active.findings) {
    lines.push(withGlyph("drift", `  finding: ${finding}`, glyphs));
  }
  lines.push("");
  return lines.join("\n");
}
