// Family definition: interview (the grill-me pattern) as engine data (T-006).
// The interview mechanics were already part-compiled — `foo shape`/`foo spec`
// emits the run contract (depth, question budget, brief shape) from CLI code.
// This family gives that contract a first-class home plus deterministic gates
// over the produced Shape Brief. Leaf craft stays in skills/interview-me.
import type { FamilyDefinition } from "../types.js";

export const interviewFamily: FamilyDefinition = {
  family: "interview",
  banner: "── foo ▸ interview ──  questions the user alone can answer ──",
  tagline: "questions the user alone can answer",
  skillRef: "interview-me", // a `foo skill` argument, never a filesystem path
  defaultDepth: "fast",
  depths: {
    fast: { user_questions: 3, stack_ranked: true },
    standard: { user_questions: 7, stack_ranked: true },
    deep: { user_questions: 0, stack_ranked: true }, // 0 = until enough to decide
  },
  phases: ["DISCOVER", "RANK", "ASK", "BRIEF"],
  cells: null, // interviews have no cell matrix; one interviewer, one human
  record: null, // the Shape Brief lands in the packet's spec.md, not a record dir
  contract: (ctx) => [
    ctx.family.banner,
    "",
    `Work item: ${ctx.target}`,
    `Depth: ${ctx.depth} — at most ${Number(ctx.tier.user_questions) || "as many as needed"} stack-ranked user questions.`,
    "",
    "Protocol (conductor rules — each with its why):",
    "  DISCOVER repo-first: inspect spec, code, tests, docs before forming any question — anything answerable from sources is never asked; the user's time is the scarcest input.",
    "  RANK     stack-rank candidates by spec impact; only user-judgment questions survive (taste, risk appetite, source approval, materially valid options).",
    "  ASK      one question at a time as numbered options, recommendation first marked (recommended) — the user answers with a digit; batching hides the ranking and anchors the reader.",
    "  BRIEF    emit the 5-part Shape Brief: work-in-one-line · bet + who it's for · source/approval boundaries · MVP scope + validation bar · judgment-ledger seed (belief, evidence, confidence, dissent, user-only decisions).",
    "",
    "Answers are recorded as packet decisions with the user's framing preserved — pushback is part of the record. Risky work escalates to a full packet (B3).",
    "Leaf craft (how to ask well): run `foo skill interview-me`.",
    "",
  ],
  gates: [
    { type: "section-present", check: "shape-brief", heading: "Shape Brief", detail: "shape brief present", failDetail: "Shape Brief section missing" },
    { type: "frontmatter-present", check: "spec-id", field: "spec_id", detail: "spec identity present (B2)", failDetail: "spec_id missing (B2)" },
    { type: "section-present", check: "intent", heading: "Intent", detail: "intent present", failDetail: "Intent section missing" },
    { type: "section-present", check: "open-questions", heading: "Open Questions", detail: "open questions surfaced", failDetail: "Open Questions section missing — user-only decisions were not surfaced" },
  ],
  handoff: "foo spec start <work-item>",
  decider: "human",
};
