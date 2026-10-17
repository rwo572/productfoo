// Runtime-neutral question model for productfoo's branded question moment.
//
// Packet: specs/foo-branded-elicitation-v0 — T-002 (R-005 / R-006). One model, two
// renderers: the numbered-text renderer (T-003) and the branded widget renderer (T-004)
// both read this model and never hold their own option set or wording, so the surfaces
// cannot drift. The model carries productfoo's question contract — a recommendation (R-005's
// "recommend one"), numbered options, and the legible-judgment fields (belief, evidence,
// confidence, dissent) — so a judgment surface is never reduced to a bare menu.

export type Confidence = "low" | "medium" | "high";

export type QuestionOption = {
  // Stable across regeneration; the selection round-trip (T-005) returns this id, so it
  // must not be derived from display position alone when callers can supply a real id.
  id: string;
  label: string;
  description?: string;
};

// Legible judgment that travels with the question so the surface shows reasoning rather
// than a bare menu (AGENTS.md). belief / evidence / confidence are required; dissent is
// optional (present when there is a real counter-view to surface).
export type Judgment = {
  belief: string;
  evidence: string;
  confidence: Confidence;
  dissent?: string;
};

export type QuestionModel = {
  header: string; // short capability/topic label (renderers truncate for chips; the model does not)
  prompt: string; // the full question
  options: QuestionOption[]; // >= 2, unique ids
  recommendedOptionId: string; // references one of `options` (R-005 recommend one)
  judgment: Judgment;
  multiSelect: boolean; // V0 asks one decision at a time; default false
};

export type QuestionInput = {
  header: string;
  prompt: string;
  options: Array<{ id?: string; label: string; description?: string }>;
  recommendedOptionId?: string; // defaults to the first option when omitted
  judgment: Judgment;
  multiSelect?: boolean;
};

// A render-agnostic projection of the model: the recommended option first, every option
// numbered 1..n with the recommended one flagged (productfoo's "recommend one, then number"
// rule). BOTH renderers consume this projection and only differ in presentation
// (numbered text vs branded widget); neither re-derives wording. This is the single
// source that keeps the surfaces from drifting (R-006).
export type ProjectedOption = QuestionOption & { number: number; recommended: boolean };

export type ProjectedQuestion = {
  header: string;
  prompt: string;
  options: ProjectedOption[];
  recommendedOptionId: string;
  judgment: Judgment;
  multiSelect: boolean;
};

const CONFIDENCE_VALUES: ReadonlySet<Confidence> = new Set<Confidence>(["low", "medium", "high"]);

function defaultId(index: number): string {
  return `opt-${index + 1}`;
}

function validateJudgment(judgment: Judgment): void {
  if (!judgment.belief.trim()) throw new Error("judgment.belief is required");
  if (!judgment.evidence.trim()) throw new Error("judgment.evidence is required");
  if (!CONFIDENCE_VALUES.has(judgment.confidence)) {
    throw new Error("judgment.confidence must be one of low|medium|high");
  }
}

// Build and validate a canonical QuestionModel. Throws on a malformed question so a
// drifted or bare-menu question fails fast rather than rendering something wrong.
export function defineQuestion(input: QuestionInput): QuestionModel {
  if (!input.header.trim()) throw new Error("question header is required");
  if (!input.prompt.trim()) throw new Error("question prompt is required");
  if (input.options.length < 2) throw new Error("a question needs at least two options");

  const options: QuestionOption[] = input.options.map((option, index) => {
    if (!option.label.trim()) throw new Error(`option ${index + 1} is missing a label`);
    return { id: option.id?.trim() || defaultId(index), label: option.label, description: option.description };
  });

  const ids = options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) throw new Error("option ids must be unique");

  const recommendedOptionId = input.recommendedOptionId ?? options[0].id;
  if (!ids.includes(recommendedOptionId)) {
    throw new Error(`recommendedOptionId "${recommendedOptionId}" does not match any option`);
  }

  validateJudgment(input.judgment);

  return {
    header: input.header,
    prompt: input.prompt,
    options,
    recommendedOptionId,
    judgment: input.judgment,
    multiSelect: input.multiSelect ?? false,
  };
}

// Project the model into the render-agnostic shape both renderers consume: the
// recommended option first, then the rest in author order, each numbered 1..n.
export function projectQuestion(model: QuestionModel): ProjectedQuestion {
  const recommended = model.options.find((option) => option.id === model.recommendedOptionId);
  if (!recommended) {
    throw new Error(`recommendedOptionId "${model.recommendedOptionId}" is not in options`);
  }

  const ordered = [recommended, ...model.options.filter((option) => option.id !== model.recommendedOptionId)];
  const options: ProjectedOption[] = ordered.map((option, index) => ({
    ...option,
    number: index + 1,
    recommended: option.id === model.recommendedOptionId,
  }));

  return {
    header: model.header,
    prompt: model.prompt,
    options,
    recommendedOptionId: model.recommendedOptionId,
    judgment: model.judgment,
    multiSelect: model.multiSelect,
  };
}
