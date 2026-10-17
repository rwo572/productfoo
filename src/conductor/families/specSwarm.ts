// Family definition: spec-swarm expressed as PURE DATA — the C-002 proof that
// a second family rides the same engine with no new code path. Depth tiers,
// phases, lens roster, and record gates come straight from the prose skill
// (skills/spec-swarm/SKILL.md) and golden swarm-001.
import type { FamilyDefinition } from "../types.js";

// Where the swarm hands off: the finalization pass that turns good product
// thinking into an implementable packet (alpha_tester_fixes_v0 R-003).
//
// This used to read `foo spec-cleanup <packet>` — a command that has never
// existed. `foo spec-cleanup` is not a CLI domain, it errors with "unknown
// domain: spec-cleanup"; spec-cleanup is a *skill*. An agent handed a command
// that does not exist either gives up or invents its own next move, which is
// the one thing a handoff is supposed to prevent.
const HANDOFF = "foo skill spec-cleanup";

// Core lens roster (golden swarm-001 selection rationale, OQ-E2: the fast
// tier draws the first N lenses; deep runs the full roster).
const LENSES = [
  "cpo",
  "technical-architect",
  "security-privacy-legal",
  "applied-ai-eval",
  "business-gm-pm",
  "developer-experience",
  "principal-product-designer",
  "technical-lead",
  "data-science",
  "pmm",
  "user-research",
  "qa-release",
  "content-design",
  "strategy-competitive",
  "product-ops-program",
  "finance-cfo",
  "accessibility-inclusion",
  "dx-product",
  "responsible-ai-safety",
  "analytics-engineering",
  "field",
  "growth-pm",
  "consumer-craft-pm",
  "ai-technical-pm",
  "platform-pm",
] as const;

export const specSwarmFamily: FamilyDefinition = {
  family: "spec-swarm",
  banner: "── foo ▸ swarm ──  expert lenses before user questions ──",
  tagline: "expert lenses before user questions",
  skillRef: "spec-swarm", // a `foo skill` argument, never a filesystem path
  defaultDepth: "standard",
  depths: {
    fast: { lenses: 6, user_questions: 3, candidates_per_lens: 2, judges: 0, exhaustive: false },
    standard: { lenses: 12, user_questions: 7, candidates_per_lens: 2, judges: 0, exhaustive: false },
    deep: { lenses: 25, user_questions: 7, candidates_per_lens: 3, judges: 0, exhaustive: true },
  },
  phases: ["INTAKE", "LENSES", "PREFLIGHT", "RANK", "ASK", "REPORT"],
  cells: {
    rolePrefix: "lens-",
    countKey: "lenses",
    maxCount: 25,
    pools: {
      lens: { values: LENSES },
    },
  },
  record: {
    dir: "swarms",
    frontmatter: (ctx) => [
      "---",
      `swarm_id: swarm-${ctx.at.slice(0, 10)}`,
      `target: ${JSON.stringify(ctx.target)}`,
      `depth: ${ctx.depth}`,
      "decider: human            # expert answers carry forward unless the user disagrees",
      // The decision fields the gates read live in the front matter — the
      // record is prepared with them EMPTY and the swarm fills them before
      // `check` can pass (the completion gate demands nonempty not_doing).
      'minority_report: ""',
      "not_doing: []",
      'what_would_change_our_mind: ""',
      `handoff: ${JSON.stringify(HANDOFF)}`,
      "---",
    ],
    body: () => [
      "",
      "# Preflight routing table",
      "",
      "| Candidate question | Asking role | Experts consulted | Expert answer | Evidence / reason | Ask user? |",
      "| --- | --- | --- | --- | --- | --- |",
      "",
      "# Swarm report",
      "",
      "# Judgment ledger",
      "",
      "| Judgment | Owner lens | Type | Evidence | Confidence | Dissent | User? |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
      "# Decision",
      "",
    ],
  },
  // methodology-compiler-v0 T-004: the swarm's orchestration protocol moved
  // out of skills/spec-swarm/SKILL.md prose into this compiled emission; the
  // skill keeps only role-lens craft. Rationale lines ride with each rule.
  contract: (ctx) => [
    ctx.family.banner,
    "",
    `Target (read before any lens runs): ${ctx.target}`,
    `Depth: ${ctx.depth} — ${ctx.tier.lenses} lenses · ${ctx.tier.candidates_per_lens} candidates per lens · user-question budget ${ctx.tier.user_questions} across the WHOLE swarm${ctx.tier.exhaustive ? " · exhaustive review" : ""}`,
    "",
    "Execute the phases in order. Leaf craft (how to be a good lens): run `foo skill spec-swarm`.",
    `  ${ctx.family.phases.join(" → ")}`,
    "",
    "Protocol (conductor rules — each with its why):",
    "  INTAKE    read the spec/packet and extract bet, user, workflow, MVP boundary, evidence boundary, risks, validation bar, cut line, open questions — lenses that skip intake re-ask answered questions.",
    `  LENSES    each lens forms its top ${ctx.tier.candidates_per_lens} candidate question(s) grill-me shaped: question + recommended answer + evidence + type + dissent — a question already answered by the packet is dropped WITH the answering decision cited.`,
    "  PREFLIGHT every candidate passes the routing gate before any user question: inspect spec/code/tests/docs first, ask the other lenses second, escalate only genuine user-judgment — never ask the user what another lens or the repo can answer.",
    "  RANK      stack-rank survivors by: bet/user/source-boundary/cut-line impact, then MVP/validation impact, then risk reduction, then churn avoided; ask from the top only — lower-ranked questions become recorded assumptions or open questions, never budget overruns.",
    "  ASK       one question at a time as numbered options, recommendation first marked (recommended) — the user answers with a digit; batching questions hides the ranking.",
    "  REPORT    the seven sections, all mandatory: highest-leverage question · expert answers to override · deferred questions · judgment ledger · spec changes implied · finalization gate (spec-cleanup before implementation) · do-not-expand-yet.",
    "",
    "Lens roster (one cell per lens):",
    ...ctx.cells.map((c) => `  ${c.role}: ${c.attrs.lens}`),
    "",
    "Routing table (render it — invisible expert routing is the failure mode):",
    "  | Candidate question | Asking role | Experts consulted | Expert answer | Evidence / reason | Ask user? |",
    "  Use 'No, carrying forward unless you disagree' for steerable defaults; 'Yes' only for true judgment calls.",
    "Ledger types never collapse: repo-evidence | approved-context | role-expertise | agent-inference | user-judgment — the boundary between evidence, expertise, inference, and human judgment is the product.",
    "Progress surface (what the USER sees WHILE lenses run — separate from the record above):",
    `  Narrate the whole fan-out as ONE foo status line, not a per-lens agent tree — e.g. "🔄 doing — routing your brief past ${ctx.tier.lenses} expert lenses" while they run, then "✋ needs your input — synthesis ready" at the handoff. The lens count and machinery are plumbing; productfoo feels simple only when plumbing stays invisible.`,
    `  If your harness insists on surfacing agents separately, label EVERY agent — every lens AND the preflight/rank/synthesis steps — as "Expert N" with ONE running counter that never resets between phases (the synthesis step included, e.g. "Expert ${Number(ctx.tier.lenses) + 1}"). The label is the NUMBER ALONE: never a lens id, a role name, or a step name — never "security-privacy-legal", "Chief Product Officer", "Preflight", "Synthesis". Each agent's final line is a bare COUNT — "Done — 2 candidate questions" — never which lens it was. "Expert 3 security-privacy-legal" and "Chief Product Officer" leak the roster exactly as loudly as lens:cpo did; a number with anything stapled to it is not anonymized.`,
    "  WHICH experts foo routes to, in what order, and which it draws at each depth — ALL of it is the craft. A progress panel is the most screenshotted, most shared surface productfoo has; the roster does not belong in transient chrome.",
    "  Numbered in the RUNTIME, named in the RECORD. Anonymity buys secrecy in the chrome, never in the product: in the routing table, judgment ledger, and report every judgment keeps its real owner lens — \"Security & Privacy raised this risk\" is what makes a judgment legible and overridable. Invisible expert routing is still the failure mode. And never write \"Expert 3\" into a report: a reader who did not watch the run cannot resolve a number back to a judgment.",
    "Ground rules: no spec rewrite during the swarm; no new scope by default; expert-resolved answers stay visible and overridable; agent inference is never presented as fact.",
    "",
    `Swarm record scaffolded: ${ctx.recordPath}`,
    "  Read that record before you fill it. productfoo's CLI wrote the file, not you — and a harness that guards blind overwrites refuses the first write to a file the session has never read, so filling it blind fails.",
    "The user steers every carried-forward expert answer. The human is the Decider.",
    "",
  ],
  gates: [
    { type: "frontmatter-present", check: "target", field: "target", detail: "target captured", failDetail: "target missing from front matter" },
    { type: "frontmatter-present", check: "depth", field: "depth", pattern: "(fast|standard|deep)", detail: "depth {value}", failDetail: "depth missing or invalid" },
    { type: "section-present", check: "routing-table", heading: "Preflight routing table", detail: "routing table present", failDetail: "preflight routing table missing — expert routing was invisible" },
    { type: "section-present", check: "ledger", heading: "Judgment ledger", detail: "judgment ledger present", failDetail: "judgment ledger missing" },
    { type: "ledger-types", check: "ledger-taxonomy", taxonomy: ["repo-evidence", "approved-context", "role-expertise", "agent-inference", "user-judgment"] },
    { type: "section-present", check: "report", heading: "Swarm report", detail: "swarm report present", failDetail: "swarm report missing" },
    { type: "frontmatter-nonempty", check: "minority-report", field: "minority_report", detail: "dissent preserved", failDetail: "minority report empty — dissent was voted away" },
    { type: "frontmatter-nonempty", check: "not-doing", field: "not_doing", detail: "explicit not-doing recorded", failDetail: 'missing "do not expand yet"' },
    { type: "frontmatter-equals", check: "human-decider", field: "decider", expect: "human", detail: "human is the Decider", failDetail: "decider must be human, found: " },
  ],
  handoff: HANDOFF,
  decider: "human",
};
