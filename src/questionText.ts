// Numbered-text renderer for productfoo's branded question moment — the guaranteed fallback.
//
// Packet: specs/foo-branded-elicitation-v0 — T-003 (R-004 / R-005). Renders a
// QuestionModel as productfoo's canonical numbered text: the recommended option first and
// marked, every option numbered, the legible-judgment fields shown, and a reply-with-a-
// number prompt. This is the surface every runtime can render and a coding agent can
// read, so it is the fallback whenever the branded widget cannot render.

import type { ElicitationSurface, SurfaceContext } from "./elicitationSurface.js";
import { detectElicitationSurface } from "./elicitationSurface.js";
import type { QuestionModel } from "./questionModel.js";
import { projectQuestion } from "./questionModel.js";

// Render the model as canonical numbered text. Pure: the same model always renders the
// same text, so the text path shows identical content whatever the widget could have
// done (R-004 / C-006).
export function renderQuestionText(model: QuestionModel): string {
  const projected = projectQuestion(model);
  const lines: string[] = [`${model.header} — ${model.prompt}`, ""];

  for (const option of projected.options) {
    lines.push(`  ${option.number}. ${option.label}${option.recommended ? "  (recommended)" : ""}`);
    if (option.description) lines.push(`     ${option.description}`);
  }

  lines.push("");
  lines.push(`Why this pick: ${model.judgment.belief}`);
  lines.push(`Evidence:      ${model.judgment.evidence}`);
  lines.push(`Confidence:    ${model.judgment.confidence}`);
  if (model.judgment.dissent) lines.push(`Dissent:       ${model.judgment.dissent}`);

  lines.push("");
  const count = projected.options.length;
  lines.push(model.multiSelect ? `Reply with one or more numbers (1-${count}).` : `Reply with a number (1-${count}).`);

  return `${lines.join("\n")}\n`;
}

// Route a question to a surface and render it. The widget renderer lands in T-004; until
// then the text renderer is the guaranteed fallback for every surface, which is exactly
// the C-006 case (the widget is unavailable, so the text path renders identical content).
export function renderQuestion(
  model: QuestionModel,
  context?: SurfaceContext,
): { surface: ElicitationSurface; text: string } {
  const decision = detectElicitationSurface(context);
  return { surface: decision.surface, text: renderQuestionText(model) };
}
