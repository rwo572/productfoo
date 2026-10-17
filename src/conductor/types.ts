// methodology-compiler-v0 (R-001) — the conductor engine's data model.
// A methodology family is DATA: depth tiers, phases, cell assignment, record
// scaffold, emitted-contract template, and gate specs. The engine renders
// contracts and verifies records; it never generates ideas, never calls a
// model, and never ships to testers. Orchestration expressed here stops
// existing as servable prose (R-002); only leaf prompts stay servable (R-003).

export type Depth = "fast" | "standard" | "deep";

// Tier knobs are family-specific by name; the engine treats them opaquely and
// templates read them by key. Numbers and booleans only — keeps tiers dumb.
export type Tier = Record<string, number | boolean>;

export interface Cell {
  role: string;
  attrs: Record<string, string | number>;
}

// Deterministic cell assignment expressed as data: pools of values cycled by
// index (ideate: frames × lenses), plus a linear seed rule. Same inputs →
// same matrix, so runs stay reproducible and testable.
export interface CellRule {
  rolePrefix: string;
  countKey: string; // tier key holding how many cells to emit
  maxCount?: number;
  pools: Record<string, { values: readonly string[]; cycleKey?: string }>;
  seed?: { attr: string; base: number; step: number };
}

// Gate specs are the invariant vocabulary (engine-design.md): each is a
// deterministic check over the record text. No model calls — these carry the
// structure half of V1 so blind judging covers only quality.
export type GateSpec =
  | { type: "frontmatter-present"; check: string; field: string; pattern?: string; detail: string; failDetail: string }
  | { type: "frontmatter-nonempty"; check: string; field: string; detail: string; failDetail: string }
  | { type: "frontmatter-equals"; check: string; field: string; expect: string; detail: string; failDetail: string }
  | { type: "diversity-meter"; check: string; floorCap: number; floorKey: string }
  // ideate-cost-v1 R-002: the meter's provenance. A record may say the meter was
  // `measured` only if it carries the structured ideas the number falls out of,
  // and the number must still fall out of them.
  | { type: "diversity-provenance"; check: string }
  | { type: "section-present"; check: string; heading: string; detail: string; failDetail: string }
  | { type: "ledger-types"; check: string; taxonomy: readonly string[] }
  // ideate frames-v1 (#697): a frame label is a claim; the reasoning field is its
  // proof. The gate checks the SHAPE of the move (an inversion shows its failure
  // ingredients, an analogy names its source domain) — never the quality, which
  // stays with blind judging. Records that predate the versioned contract pass
  // with a "predates" note: the gate refuses cosplay, it does not retroactively
  // fail records written under an older contract.
  | { type: "frame-reasoning"; check: string }
  | { type: "ideate-falsification" | "ideate-decision"; check: string }
  // A key line the versioned contract requires anywhere in the record body
  // (stress evidence, novelty anchor, cheapest test). Same retroactivity rule:
  // no version line, no requirement.
  | { type: "versioned-keyline"; check: string; field: string; detail: string; failDetail: string };

export interface RecordTemplate {
  dir: string; // record home relative to repo root
  frontmatter: (ctx: RenderContext) => string[];
  body: (ctx: RenderContext) => string[];
}

export interface FamilyDefinition {
  family: string;
  banner: string;
  tagline: string;
  // The leaf-craft pointer a contract hands to an agent. It is a `foo skill`
  // ARGUMENT (`"interview-me"`), never a filesystem path.
  //
  // These used to be `skills/interview-me/SKILL.md`. In a thin install that file
  // does not exist — and it is not even a valid `foo skill` argument, because
  // `skillRelPath` (skillDelivery.ts) rejects both the `skills/` prefix and the
  // uppercase SKILL.md. So the one pointer foo gave the agent was unopenable by
  // either route. A name resolves everywhere: local `skills/` in dev, over the
  // wire in a thin install (alpha_tester_fixes_v0 R-003).
  //
  // The release gate resolves every skillRef through `foo skill` from a neutral
  // directory, so an unresolvable one fails before it ships.
  skillRef: string;
  depths: Record<Depth, Tier>;
  defaultDepth: Depth;
  phases: readonly string[];
  cells: CellRule | null; // null: family has no cell matrix (e.g. loop)
  record: RecordTemplate | null;
  contract: (ctx: RenderContext) => string[]; // emitted text, family-templated
  gates: GateSpec[];
  handoff: string;
  decider: "human";
}

export interface RenderContext {
  family: FamilyDefinition;
  target: string; // the idea / spec path / work item, verbatim
  depth: Depth;
  tier: Tier;
  cells: Cell[];
  at: string; // ISO timestamp, caller-supplied (determinism)
  recordPath: string | null;
  root: string;
  // ip-protection-cheap-moves T-004 (R-001, D-003): when true, the emitted
  // contract carries the imperative rules an agent needs but drops the "— why"
  // rationale from the protocol rules (the teachable insight a copier wants).
  // OFF by default; armed by FOO_LEAN_CONTRACT=1. Absent/false = today's full
  // contract, byte-for-byte. Flipping the default waits on the D-003 A/B —
  // quality outranks IP, and a reasoned rule may be obeyed better than a bare one.
  lean?: boolean;
}

export interface GateFinding {
  check: string;
  ok: boolean;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  findings: GateFinding[];
}
