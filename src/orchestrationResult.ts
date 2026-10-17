// orchestration-efficiency-v0 R-005: the decision is the product; orchestration
// records remain backing evidence. This closed shape deliberately excludes
// agents, phases, scores, token details, and internal IDs from the primary
// human result.

export type OrchestrationResult = {
  recommendation: string;
  alternatives: readonly string[];
  falsified: readonly string[];
  dissent: string;
  what_would_change_our_mind: string;
  next_action: string;
};

export const ORCHESTRATION_RESULT_INSTRUCTION =
  "Finish with one recommendation, at most two alternatives, what was falsified, the strongest dissent, what would change the recommendation, and the next action. Keep full records as backing evidence.";

const FIELDS = new Set([
  "recommendation",
  "alternatives",
  "falsified",
  "dissent",
  "what_would_change_our_mind",
  "next_action",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

export function validateOrchestrationResult(value: unknown): readonly string[] {
  if (!isObject(value)) return ["result must be an object"];

  const findings: string[] = [];
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key)) findings.push(`unknown field: ${key}`);
  }
  for (const field of ["recommendation", "dissent", "what_would_change_our_mind", "next_action"] as const) {
    if (!nonEmptyString(value[field])) findings.push(`${field} must be a non-empty string`);
  }
  if (!stringArray(value.alternatives)) {
    findings.push("alternatives must be an array of non-empty strings");
  } else if (value.alternatives.length > 2) {
    findings.push("alternatives must contain at most 2 alternatives");
  }
  if (!stringArray(value.falsified)) {
    findings.push("falsified must be an array of non-empty strings");
  }
  return findings;
}

function bullets(values: readonly string[], empty: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value.trim()}`) : [`- ${empty}`];
}

export function renderOrchestrationResult(value: OrchestrationResult): string {
  const findings = validateOrchestrationResult(value);
  if (findings.length > 0) throw new Error(`invalid orchestration result: ${findings.join("; ")}`);

  return [
    "Recommendation",
    value.recommendation.trim(),
    "",
    "Alternatives",
    ...bullets(value.alternatives, "None."),
    "",
    "What was falsified",
    ...bullets(value.falsified, "Nothing recorded."),
    "",
    "Strongest dissent",
    value.dissent.trim(),
    "",
    "What would change this",
    value.what_would_change_our_mind.trim(),
    "",
    "Next action",
    value.next_action.trim(),
    "",
  ].join("\n");
}
