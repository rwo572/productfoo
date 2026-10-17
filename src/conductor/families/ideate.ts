// Family definition: ideate (the storm/ideation conductor) expressed as data.
// This is the byte-compat proving case (C-002): the engine must reproduce the
// exact contract and record that src/ideate.ts emits today.
import { slugify } from "../engine.js";
import type { FamilyDefinition, RenderContext } from "../types.js";

// frames-v1 (#694/#696): every depth rotates the FULL frame roster — depth
// scales how many cells run and how hard stress/judging push, never which
// thinking moves exist. Analogy leads because it is the strongest novelty
// engine (mechanism theft from another domain) and the old order starved it:
// frames used to cycle on the reframes count, so fast ran inversion-only and
// standard never reached analogy or second-order at all.
const FRAMES = ["analogy", "inversion", "how-might-we", "first-principles", "second-order"] as const;
const LENSES = ["product", "engineering", "security", "design", "gtm", "data", "user-research", "platform"] as const;

function verification(ctx: RenderContext): string {
  return `foo ideate check ${ctx.recordPath}`;
}

const HANDOFF = 'foo spec "<winning direction>"';

export const ideateFamily: FamilyDefinition = {
  family: "ideate",
  banner: "── foo ▸ ideate ──  ideas before specs ──",
  tagline: "ideas before specs",
  skillRef: "ideate", // a `foo skill` argument, never a filesystem path
  defaultDepth: "standard",
  depths: {
    // reframes = how many F-lines the FRAME phase writes (one per leading cell);
    // it no longer truncates which frames the cells receive.
    fast: { reframes: 3, ideators: 3, stress_on: 1, judges: 1, extra_dissent_round: false },
    standard: { reframes: 5, ideators: 5, stress_on: 3, judges: 3, extra_dissent_round: false },
    deep: { reframes: 5, ideators: 8, stress_on: 5, judges: 3, extra_dissent_round: true },
  },
  phases: ["GROUND", "FRAME", "DIVERGE", "FALSIFY", "PANEL", "REVEAL", "BUILD_ON", "STRESS", "CONVERGE", "CAPTURE"],
  cells: {
    rolePrefix: "ideator-",
    countKey: "ideators",
    maxCount: 8,
    pools: {
      frame: { values: FRAMES },
      lens: { values: LENSES },
    },
    seed: { attr: "seed", base: 11, step: 7 },
  },
  record: {
    dir: "ideas",
    // The front matter is the record's face: the pick leads, machinery trails,
    // and nothing on it carries an inline explainer — the contract and skill
    // teach; the record states. `recommendation` is scaffolded null and gated,
    // so a record cannot verify without taking a position.
    frontmatter: (ctx) => [
      "---",
      "recommendation: null",
      `idea: ${JSON.stringify(ctx.target)}`,
      `depth: ${ctx.depth}`,
      "decider: human",
      `ideate_id: ideate-${ctx.at.slice(0, 10)}-${slugify(ctx.target)}`,
      // frames-v1 (#697): names the contract this record was scaffolded under,
      // so the executable-frame and keyline gates know they apply. Older
      // records without the line pass those gates with a "predates" note.
      "ideate_contract: decisions-v2",
      "diversity: { raw: 0, distinct_clusters: 0, near_dupes_merged: 0, exhausted: false }",
      // ideate-cost-v1 R-002: the meter's provenance travels with the meter.
      // Scaffolds default to `measured` because computing it is the job; a run
      // that cannot show its work has to downgrade this line on purpose.
      "diversity_method: measured",
      "---",
    ],
    // #700: the record is decision-first — a reader gets the call and the full
    // stack rank before any process detail, and the machine JSON is the LAST
    // section, never the lead. Process order (frames → pool → stress) is how
    // the run happened; it is not how a decider reads.
    body: (ctx) => [
      "",
      "# The call",
      "(CAPTURE renders `foo ideate result <record>` here: a decision in at most 600 words, its new contribution, prior work, conditional alternatives, and a first test. The rank and full pool below are backing evidence.)",
      "",
      "# Stack rank — surviving directions scored New / Useful / Feasible (1–10); exclusions retained",
      "(CONVERGE + CAPTURE write this: Every cluster has a disposition and plain-English name. Every ranking table includes a `What this is` column immediately after `Direction`: one concrete sentence explaining who does or receives what, understandable without the idea's title, score, or rationale. Eligible directions carry N/U/F scores and placement reasons; clusters with no surviving idea are excluded with the refutation, never scored. Distinguish panel scores from the completion pass.)",
      "",
      "# Decision",
      "pick: null",
      "keep: []",
      "maybe: []",
      "cut: []",
      "not_doing: []",
      // #698: the novelty anchor. N is unanchored until the recommendation
      // names the nearest existing thing it beats ("none found locally" must
      // be said, never implied).
      'nearest_existing: ""',
      // Actionability: the cheapest one-week falsification test for the
      // recommended direction — something a person could start Monday.
      'cheapest_test: ""',
      'minority_report: ""',
      'what_would_change_our_mind: ""',
      `handoff: ${JSON.stringify(HANDOFF)}`,
      "",
      // #695: STRESS gets a scaffolded home so the decision-changing phase
      // cannot be silently dropped — its keylines are gated like the minority
      // report. `outcome_change` is the honesty line: what the pass changed,
      // or precisely why it changed nothing.
      "# What moved the ranking (stress — findings must be able to change the outcome)",
      'pre_mortem: ""',
      'disconfirmation_vs_frontrunner: ""',
      'outcome_change: ""',
      "",
      "# Frames",
      ...ctx.cells.slice(0, Number(ctx.tier.reframes)).map((c, i) => `- F${i + 1} ${c.attrs.frame}: TODO`),
      "",
      "# Idea pool (readable — REVEAL renders the clustered pool here via `foo ideate read`, each cluster under its plain-English name)",
      "",
      "# Appendix — measured source (the diversity meter is computed from this block, never read off it)",
      "```json ideas",
      "[]",
      "```",
      "",
      "# Prior work (local context; empirical claims still need checking)",
      "```json grounding",
      '{"searched": [], "sources": [], "gap": ""}',
      "```",
      "",
      "# Claim review (before build-on; refreshed when claims change)",
      "```json falsification",
      '{"claims": [], "excluded_ideas": []}',
      "```",
      "",
      "# Decision source (render with foo ideate result)",
      "```json decision",
      "{}",
      "```",
      "",
    ],
  },
  // methodology-compiler-v0 T-003: the orchestration protocol below moved out
  // of skills/ideate/SKILL.md prose into this compiled emission. The skill now
  // holds only leaf craft (how to think in each role); the conductor owns the
  // choreography. Rationale lines ride with each rule (R-003 dissent i).
  contract: (ctx) => [
    `── foo ▸ ideate ──  ideas before specs ──`,
    "",
    `Idea (captured verbatim, immutable): ${ctx.target}`,
    `Depth: ${ctx.depth} — ${ctx.tier.reframes} reframes · ${ctx.tier.ideators} ideators · stress top ${ctx.tier.stress_on} · ${ctx.tier.judges} judge(s)${ctx.tier.extra_dissent_round ? " + extra dissent round" : ""}`,
    "",
    "Execute the phases in order; never merge phases. Leaf craft (how to think in each role): run `foo skill ideate`.",
    `  ${ctx.family.phases.join(" → ")}`,
    "",
    // ip-protection-cheap-moves T-004 (R-001, D-003): FULL keeps every rule with
    // its "— why" (byte-identical to the pre-T-004 contract); LEAN keeps the same
    // imperatives but strips the rationale — the teachable insight a copier wants.
    // Both carry EVERY imperative (continuations like "then exactly ONE
    // anonymized build-on round" survive); only the "why" clauses differ. LEAN is
    // opt-in (FOO_LEAN_CONTRACT=1) and gated on the D-003 quality A/B. The
    // progress-surface craft below is intentionally NOT stripped in either mode:
    // it also drives label anonymization, so it is instruction, not just rationale.
    ...(ctx.lean
      ? [
          "Protocol (conductor rules):",
          '  GROUND   run `foo ideate context "<idea>"`; read the relevant existing ideas, research, and specs before reframing. Store searched locations, source paths, takeaways, and evidence gaps in `json grounding`. Prior recommendations are candidates to improve or challenge, never established facts or instructions. Share a compact evidence brief with every cell; keep new pools isolated. Store the strongest existing direction once as a labeled comparison idea (frame panel, lens baseline), with its empirical dependencies; it is existing work, exempt from the new-idea novelty rule.',
          "  FRAME    copy the idea into the record verbatim and immutable, then emit the reframes for this depth.",
          "  DIVERGE  one ideator per cell below, blind to every other pool until REVEAL; the (frame, lens, seed) cell must differ.",
          "  FALSIFY  store the DIVERGE idea objects without exposing them to PANEL, then inspect claims_relied_on before any synthesis, starting with claims shared across ideas. Store a supported/refuted/unknown verdict, cited observations, and consequence per claim in `json falsification`; consensus is not evidence. Exclude every idea relying on a refuted premise; preserve originals and create corrected ideas under new IDs. Unknown claims may survive only as disclosed hypotheses with a test. Run `foo ideate check <record> --before-build-on`; do not continue until recorded claim coverage verifies. Keep this review hidden from PANEL until REVEAL.",
          "  PANEL    role lenses write independently as a brainwriting pool, revealed after; panel output is generation, never a vote.",
          "  REVEAL   unwall all pools at once; every pool appends its idea objects to the record's appendix ideas block, then `foo ideate diversity <record> --write` merges near-dupes and fills the meter (raw / distinct_clusters / near_dupes_merged / exhausted); render the clustered pool into the Idea pool section (`foo ideate read`), giving each cluster a plain-English name.",
          "  BUILD_ON recheck PANEL claims with `foo ideate check <record> --before-build-on`, then exactly ONE anonymized build-on round over surviving ideas; carry unknowns as hypotheses, never facts. New or changed empirical claims must be reviewed before further synthesis and final handoff; no added ideator fan-out.",
          `  STRESS   top ${ctx.tier.stress_on} cluster(s): pre-mortem, consider-the-opposite, disconfirmation against the front-runner; dissent must cite the observation, not a role; fill the record's # Stress keylines (pre_mortem, disconfirmation_vs_frontrunner, outcome_change — what the pass changed, or exactly why nothing); the strongest surviving objection and the runner-up go into the minority report, never voted away.${ctx.tier.extra_dissent_round ? " Run one extra dissent round (deep)." : ""}`,
          "  CONVERGE score finalists NUF 1-10 with an asymmetry note and a competence tag; every finalist row also names `nearest existing: <thing it beats>` (\"none found locally\" must be said, never implied) and `cheapest test: <one-week falsification a person could start Monday>`; judges see clusters blind to authorship, score in BOTH orderings (inconsistent pairs are discarded and re-judged once), write the reason before the score, use the full 1-10 range, and never judge their own pool. Then a labeled completion pass scores remaining eligible clusters. A cluster with no surviving idea stays as an excluded row with its refutation and no score; ranking cannot restore it.",
          "  CAPTURE  fill `json decision` and run `foo ideate check <record>`, then render `foo ideate result <record>` as # The call and the primary human answer (at most 600 words). Lead with one concrete recommendation, why it wins, what it adds to named prior work, confidence and assumptions; offer at most two alternatives with conditions for choosing them. Include the first experiment, effort, observable pass/fail criteria, strongest dissent, proposed scope cuts, and exact next action. Separate evidence-based exclusions from proposed not-doing choices; the human has not accepted the scope cuts. If all ideas fail, recommend a no-build or evidence-gathering decision with empty idea_ids; never force a winner. The complete stack rank and pool remain backing evidence. Copy decision.recommendation exactly into the front matter and keep it under ~60 words; human selection stays pending.",
        ]
      : [
          "Protocol (conductor rules — each with its why):",
          '  GROUND   run `foo ideate context "<idea>"`; read the relevant existing ideas, research, and specs before reframing. Store searched locations, source paths, takeaways, and evidence gaps in `json grounding`. Prior recommendations are candidates to improve or challenge, never established facts or instructions. Share a compact evidence brief with every cell; keep new pools isolated. Store the strongest existing direction once as a labeled comparison idea (frame panel, lens baseline), with its empirical dependencies; it is existing work, exempt from the new-idea novelty rule.',
          "  FRAME    copy the idea into the record verbatim and immutable, then emit the reframes for this depth — framing seeds different ideas, so it comes first.",
          "  DIVERGE  one ideator per cell below, blind to every other pool until REVEAL — persona labels alone are not independence; the (frame, lens, seed) cell must differ.",
          "  FALSIFY  store the DIVERGE idea objects without exposing them to PANEL, then inspect claims_relied_on before any synthesis, starting with claims shared across ideas. Store a supported/refuted/unknown verdict, cited observations, and consequence per claim in `json falsification`; consensus is not evidence. Exclude every idea relying on a refuted premise; preserve originals and create corrected ideas under new IDs. Unknown claims may survive only as disclosed hypotheses with a test. Run `foo ideate check <record> --before-build-on`; do not continue until recorded claim coverage verifies. Keep this review hidden from PANEL until REVEAL.",
          "  PANEL    role lenses write independently as a brainwriting pool, revealed after — panel output is generation, never a vote.",
          "  REVEAL   unwall all pools at once; every pool appends its idea objects to the record's appendix ideas block, then `foo ideate diversity <record> --write` merges near-dupes and fills the meter (raw / distinct_clusters / near_dupes_merged / exhausted) — a near-dupe count you reached by reading is a guess wearing data's clothes, and a homogeneous pool is a finding, not a retry; render the clustered pool into the Idea pool section (`foo ideate read`), giving each cluster a plain-English name — the JSON is for machines and stays the appendix, never the lead.",
          "  BUILD_ON recheck PANEL claims with `foo ideate check <record> --before-build-on`, then exactly ONE anonymized build-on round over surviving ideas; carry unknowns as hypotheses, never facts. New or changed empirical claims must be reviewed before further synthesis and final handoff — more rounds entrench errors; no added ideator fan-out.",
          `  STRESS   top ${ctx.tier.stress_on} cluster(s): pre-mortem, consider-the-opposite, disconfirmation against the front-runner — dissent must cite the observation, not a role; fill the record's # Stress keylines (pre_mortem, disconfirmation_vs_frontrunner, outcome_change — what the pass changed, or exactly why nothing: a stress pass that leaves no trace is a stress pass that can be skipped); the strongest surviving objection and the runner-up go into the minority report, never voted away.${ctx.tier.extra_dissent_round ? " Run one extra dissent round (deep)." : ""}`,
          "  CONVERGE score finalists NUF 1-10 with an asymmetry note and a competence tag; every finalist row also names `nearest existing: <thing it beats>` (\"none found locally\" must be said, never implied — an N score with no named neighbor is a number wearing a measurement's clothes) and `cheapest test: <one-week falsification a person could start Monday>`; judges see clusters blind to authorship, score in BOTH orderings (inconsistent pairs are discarded and re-judged once), write the reason before the score, use the full 1-10 range — a pool judged 4-to-7 is a judge refusing to judge — and never judge their own pool. Then a labeled completion pass scores remaining eligible clusters. A cluster with no surviving idea stays as an excluded row with its refutation and no score; ranking cannot restore it.",
          "  CAPTURE  fill `json decision` and run `foo ideate check <record>`, then render `foo ideate result <record>` as # The call and the primary human answer (at most 600 words). Lead with one concrete recommendation, why it wins, what it adds to named prior work, confidence and assumptions; offer at most two alternatives with conditions for choosing them. Include the first experiment, effort, observable pass/fail criteria, strongest dissent, proposed scope cuts, and exact next action. Separate evidence-based exclusions from proposed not-doing choices; the human has not accepted the scope cuts. If all ideas fail, recommend a no-build or evidence-gathering decision with empty idea_ids; never force a winner. The complete stack rank and pool remain backing evidence. Copy decision.recommendation exactly into the front matter and keep it under ~60 words; human selection stays pending.",
        ]),
    "",
    // ideate-cost-v1 T-003 (R-002): prose in, hand-clustering out. The schema is
    // an imperative, so it survives LEAN; only its "why" is stripped.
    "Decision evidence (decisions-v2; one block each, in the backing record):",
    '  json grounding: {"searched":["ideas/","research/","specs/"],"sources":[{"source":"path","takeaway":"finding or earlier idea, with its uncertainty"}],"gap":"what is missing; say no relevant work found only after searching"}. Empty sources are valid when none is relevant.',
    '  json falsification: {"claims":[{"claim":"exact claims_relied_on text","verdict":"supported|refuted|unknown","evidence":[{"source":"file or approved citation","observation":"what was actually observed"}],"consequence":"what changes or remains conditional"}],"excluded_ideas":["refuted idea id"]}. Review every stored empirical claim; evidence may be empty only for unknown. This check verifies coverage, not truth or chronology.',
    '  json decision: {"recommendation":"concrete choice","rationale":"why it beats the closest alternative","new_contribution":"what becomes possible beyond the prior ideas","builds_on":[{"source":"a grounding source path","delta":"what is retained, changed, or rejected"}],"idea_ids":["surviving source idea"],"assumptions":["unresolved claims, copied exactly, plus the load-bearing bet"],"confidence":{"level":"low|medium|high","reason":"evidence and limits"},"alternatives":[{"direction":"plain name","choose_when":"specific switch condition","idea_ids":["surviving source idea"]}],"experiment":{"action":"smallest useful test","effort":"time/cost bound","pass":"observable success criterion","fail":"stop or change-direction criterion"},"dissent":"strongest surviving objection","not_doing":["cut and why"],"next_action":"exact action or command for the human"}. At most 2 alternatives and 3 builds_on references; cite only sources already read and recorded. An empty idea_ids is a deliberate no-build recommendation.',
    "Use prior research as context until its empirical claims are checked. New web research uses foo research; connected-source approval rules still apply. Do not launch research automatically to fill a gap; unknown is a valid result.",
    "",
    "Required output shape — every ideator and panelist returns objects, never prose:",
    '  {"id": "i1", "claim": "one sentence", "frame": "<your frame>", "lens": "<your lens>", "reasoning": "the frame move, SHOWN — shapes below", "mechanism": "free text: how it works", "assumption": "the one load-bearing assumption", "novelty": "vs: <nearest existing or obvious approach> — <what this beats it on>", "claims_relied_on": ["empirical claim this rests on"]}',
    "  Append each object to the record's ideas block. `mechanism` is read by humans and never clustered on, so keep the nuance there.",
    ...(ctx.lean
      ? []
      : ["  The meter is computed from those objects, never counted by hand — a near-dupe number a human eyeballed is worse than none, because every downstream reader treats it as measured."]),
    "",
    "Frame execution (frames-v1, gated) — `reasoning` must SHOW the move; a frame label without its move is cosplay and fails `foo ideate check`:",
    "  analogy          `source-domain: <domain>` and `mechanism-stolen: <the mechanism>` — steal the mechanism, never the surface.",
    "  inversion        `guarantee-failure: <ingredient>; <ingredient>; …` then `negated: <the negation this idea is>` — enumerate the failure first.",
    "  how-might-we     `tension: <the tension>` and `answer: <why this answers the sharpest HMW>`.",
    "  first-principles `bedrock: <what must be true>` and `discarded-assumption: <the inherited default this rejects>`.",
    "  second-order     `then-1: <first-order effect>` and `then-2: <what that causes next>`.",
    "  panel/build-on   free text stating the move (never empty).",
    "Novelty must be a useful difference: compare against the strongest existing idea or current workflow, name a changed mechanism and a concrete before/after example in mechanism. Reuse good earlier ideas; include a surprising alternative without treating novelty as an automatic win. Claims of research support belong in claims_relied_on and get checked.",
    "Cell economics: each cell returns AT MOST 4 idea objects. Keep the existing-direction baseline as a comparison. For NEW candidates, your first instinct is the pool's most available idea — everyone else has it too, so discard generic restatements and return ideas whose `novelty` can honestly say what they beat (`vs: …`). Four ideas that survive that test beat ten that don't.",
    ...(ctx.lean
      ? ["Constraints named in the idea are held ONCE, here at contract level — never restate consent, approval, or exclusion language inside idea objects."]
      : ["Constraints named in the idea are held ONCE, here at contract level — never restate consent, approval, or exclusion language inside idea objects: a mechanism spent on disclaimers is a mechanism not spent on the idea, and forty restatements of the same guardrail are what a homogeneous pool is made of."]),
    "",
    "Engineered independence — one ideator per cell, hidden until REVEAL (R2):",
    ...ctx.cells.map((c) => `  ${c.role}: frame=${c.attrs.frame} lens=${c.attrs.lens} seed=${c.attrs.seed}`),
    // #614: the pools this contract mandates are a LOCAL fan-out, and productfoo's own
    // research gate cannot know that from the outside — an ideator prompt asking
    // for claims that cite their evidence looks, word for word, like a research
    // sweep. Saying where the cell reads is what separates them, so the contract
    // says it rather than leaving each cell's fate to its phrasing.
    "  Every cell reads local sources only — say exactly that in each spawn. These pools read this repo and the files already on disk; a cell that needs the open web is not an ideator, it is a research run, and it goes through `foo research`.",
    "",
    "Progress surface (what the USER sees WHILE ideators run — separate from the record above):",
    `  Narrate the whole divergence as ONE foo status line, not a per-ideator agent tree — e.g. "🔄 doing — exploring ${ctx.tier.ideators} independent idea directions" while they run, then "✋ needs your input — shortlist ready" at the handoff. The ideator count and cell machinery are plumbing; productfoo feels simple only when plumbing stays invisible.`,
    `  If your harness insists on surfacing agents separately, label EVERY agent — in EVERY phase (DIVERGE ideators, PANEL lenses, STRESS reviewers, CONVERGE judges) — as "Explorer N" with ONE running counter that never resets between phases, so no phase is distinguishable from another. The label is the NUMBER ALONE: never a frame, lens, seed, role, OR a stress/judging technique — never "pre-mortem", "consider-the-opposite", "disconfirmation", "Stress: …", "Panel: …", "Judge: …". Each agent's final line is a bare COUNT of what it produced — "Done — 9 ideas", "Done — 3 findings" — never the technique it ran. "Explorer 1 inversion/product", "Stress: pre-mortem", and "Panel: reverse-engineering red team" all leak the craft exactly as loudly as the raw slug did; a number with anything stapled to it is not anonymized.`,
    "  WHICH frames and lenses foo pairs, which stress moves it runs against the front-runner, and how the cells are engineered for independence — ALL of it is the craft. A progress panel is the most screenshotted, most shared surface productfoo has; none of that design belongs in transient chrome.",
    "  Numbered in the RUNTIME, named in the RECORD. Anonymity buys secrecy in the chrome, never in the product: the frames, clusters, diversity meter, and minority report stay fully visible in the record, each attributed to its real cell. Never write \"Explorer 3\" into a report — a reader who did not watch the run cannot resolve a number back to an idea.",
    "",
    "If it goes wrong: homogeneous pool → vary frames (not seeds) for one regeneration, else record exhausted: true visibly; judge inconsistency → discard the pair, re-judge once, else log it unresolved in the minority report; no surviving dissent → run one extra disconfirmation pass before recording an empty minority report, and say so.",
    "",
    `Ideate record scaffolded: ${ctx.recordPath}`,
    "  Read that record before you fill it. productfoo's CLI wrote the file, not you — and a harness that guards blind overwrites refuses the first write to a file the session has never read, so filling it blind fails.",
    `Verify before hand-off: ${verification(ctx)} — fix named fields; never hand-edit the verdict; the record is the contract.`,
    "Boundary B4: allowed actions are frame/generate/cluster/critique/score — never ship, send, commit, or auto-promote.",
    `The human picks the winner. Then: ${HANDOFF}`,
    "",
  ],
  gates: [
    { type: "ideate-falsification", check: "early-falsification" },
    { type: "ideate-decision", check: "actionable-decision" },
    { type: "frontmatter-present", check: "raw-idea", field: "idea", detail: "raw idea captured verbatim", failDetail: "idea missing from front matter" },
    { type: "frontmatter-present", check: "depth", field: "depth", pattern: "(fast|standard|deep)", detail: "depth {value}", failDetail: "depth missing or invalid" },
    { type: "diversity-meter", check: "diversity-meter", floorCap: 3, floorKey: "ideators" },
    { type: "diversity-provenance", check: "diversity-provenance" },
    // frames-v1 gates (#695/#697/#698). All apply only to records carrying
    // `ideate_contract: frames-v1`; older records pass with a "predates" note.
    { type: "frame-reasoning", check: "frame-execution" },
    { type: "versioned-keyline", check: "stress-pre-mortem", field: "pre_mortem", detail: "stress: pre-mortem recorded", failDetail: "stress pre_mortem empty — the adversarial pass left no trace (#695)" },
    { type: "versioned-keyline", check: "stress-disconfirmation", field: "disconfirmation_vs_frontrunner", detail: "stress: disconfirmation vs front-runner recorded", failDetail: "disconfirmation_vs_frontrunner empty — nobody tried to kill the front-runner (#695)" },
    { type: "versioned-keyline", check: "stress-outcome", field: "outcome_change", detail: "stress verdict recorded (what changed, or why nothing)", failDetail: "outcome_change empty — say what stress changed, or exactly why it changed nothing (#695)" },
    { type: "versioned-keyline", check: "novelty-anchor", field: "nearest_existing", detail: "novelty anchored: nearest existing thing named", failDetail: 'nearest_existing empty — N is unanchored until the recommendation names what it beats; "none found locally" must be said (#698)' },
    { type: "versioned-keyline", check: "cheapest-test", field: "cheapest_test", detail: "cheapest one-week falsification test recorded", failDetail: "cheapest_test empty — the recommendation has no one-week falsification a person could start Monday" },
    // The record's face takes a position: a null recommendation cannot verify.
    { type: "versioned-keyline", check: "recommendation", field: "recommendation", detail: "recommendation takes a position", failDetail: 'recommendation is null — the record must open with a stance: "<winner>. <why>. Bet: <assumption>. Test: <Monday falsifier>."' },
    { type: "frontmatter-nonempty", check: "minority-report", field: "minority_report", detail: "dissent preserved", failDetail: "minority report empty — dissent was voted away (R5)" },
    { type: "frontmatter-nonempty", check: "not-doing", field: "not_doing", detail: "explicit not-doing recorded", failDetail: 'missing "what we are NOT doing" (R6)' },
    { type: "frontmatter-equals", check: "human-decider", field: "decider", expect: "human", detail: "human is the Decider", failDetail: "decider must be human, found: " },
    { type: "frontmatter-nonempty", check: "falsifier", field: "what_would_change_our_mind", detail: "decision-journal falsifier present", failDetail: 'missing "what would change our mind" (R7)' },
  ],
  handoff: HANDOFF,
  decider: "human",
};
