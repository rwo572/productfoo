---
name: ideate
description: "Leaf craft for productfoo's ideation runs: how to think as an ideator, a stress reviewer, or a judge inside the run contract that `foo ideate` emits. The conductor (CLI) owns the choreography — phases, cells, blindness, budgets, verification; this skill holds only the per-role thinking moves."
---

# ideate (leaf craft)

`foo ideate "<idea>"` emits the run contract: the phases, the per-ideator
frame × lens × seed cells, the protocol rules, and the record scaffold.
Execute that contract as printed. This skill adds only the craft — how to be
good *inside* each role. It contains no orchestration; if this file and the
emitted contract ever disagree about sequencing, the contract wins.

## Ideator craft (DIVERGE)

Work only your own cell; the contract tells you your frame, lens, and seed.
Use the shared prior-work brief as context, including previous ideas that
failed or were deferred. Compare with the strongest earlier proposal. A useful
new direction changes a mechanism, resolves an old constraint, or combines
findings into something the user can now do. Explain that difference with a
concrete before/after example in `mechanism`; a renamed earlier idea is not new.
Research conclusions retain their uncertainty until checked against evidence.
The thinking moves, each with its why (every depth rotates all five):

- **analogy** — steal the *mechanism* from another domain, never the surface;
  surface-analogies decorate, mechanism-analogies transfer.
- **inversion** — "how would we guarantee the failure?" then negate each
  ingredient; failure is easier to enumerate honestly than success.
- **how-might-we** — phrase the tension as HMW questions, then answer the
  sharpest; the question shape stops premature solutioning.
- **first-principles** — separate bedrock truths from inherited assumptions
  and rebuild only from bedrock; most designs smuggle in the defaults.
- **second-order** — "and then what?" twice; first-order wins often create
  the next problem.

Return every idea as an object — `claim, frame, lens, reasoning, mechanism,
assumption, novelty, claims_relied_on` — appended to the record's ideas block.
Idea and evaluation stay separate so raw claims survive scoring. `reasoning`
is the frame's move, shown, in the tagged shape the contract prints (an
inversion enumerates its failure ingredients before the negation; an analogy
names its source domain and the mechanism stolen). Put a concise rationale
in `reasoning`, not a private reasoning transcript. The check verifies the
shape of the explanation; it cannot certify originality or usefulness.

Return at most 4 new ideas. Retain the strongest existing direction as the
comparison baseline named by the conductor. For new candidates, discard generic
restatements of that baseline and return ideas whose `novelty` can honestly complete `vs: <nearest existing or obvious
approach> — <what this beats it on>`. Constraints stated in the idea are held
once at contract level; never restate consent, approval, or exclusion language
inside your objects — a mechanism spent on disclaimers is a mechanism not
spent on the idea.

Write the claim as one sentence and put the texture in `mechanism`: it is free
text, read by humans, and never clustered on, so nuance costs you nothing at
merge time. `claims_relied_on` lists the empirical claims the idea would die
without — that list is what the falsification pass aims at.

## Stress craft (STRESS)

For a claim review, separate **supported**, **refuted**, and **unknown**.
An observation needs a source and what it actually shows. Agreement across
ideators is not corroboration; a missing source is not a refutation. Explain
the consequence for each dependent idea. Preserve failed originals when a
corrected idea is introduced so the decision can show what changed.

- **pre-mortem** — "it is six months later and this failed — why?"; past-tense
  framing unlocks concrete failure stories that critique-framing suppresses.
- **consider-the-opposite** — argue the reverse position seriously once.
- **disconfirmation** — actively try to kill the front-runner; confirmation
  accumulates by default, disconfirmation only happens on purpose.
- Roast moves: sharpest cut first; subtract weak scope before adding caveats.
- Dissent must cite the observation, not the role ("the wire log shows X"
  beats "as security, I worry").
- The pass leaves a trace: fill the record's `pre_mortem`,
  `disconfirmation_vs_frontrunner`, and `outcome_change` lines — what the
  stress changed, or exactly why it changed nothing. A stress pass with no
  recorded verdict is indistinguishable from one that never ran.

## Judge craft (CONVERGE)

- **NUF**: New (does this exist already?), Useful (does it move the actual
  problem?), Feasible (buildable by this team at this scale?) — 1–10 each,
  using the full range: a pool judged 4-to-7 is a judge refusing to judge.
- N is unanchored until it names its neighbor: every finalist carries
  `nearest existing: <the closest thing that already exists>` and what this
  beats it on — "none found locally" must be said out loud, never implied.
- Every finalist carries `cheapest test:` — the one-week falsification a
  person could start Monday; an idea with no cheap test is a bet, and say so.
- Write the reason before the score; a score written first back-justifies.
- Note the asymmetry: reversible? cheap to test? A 6 that's free to try can
  beat an 8 that's a one-way door.
- Tag your competence: `inside | edge | needs-evidence` — a judge outside
  their circle flags it rather than bluffing calibration.

## The record's face (front matter)

The front matter is the first — often the only — thing a decider reads, so it
opens with `recommendation` and carries no machinery commentary. The
recommendation is opinionated and tight, in this shape and at most ~60 words:

```text
<Winner, by name>. <Why, one clause>. Bet: <the single load-bearing
assumption>. Test: <the falsifier a person could start Monday>.
```

No hedging words (maybe, could, consider, might) — a run that cannot pick
says so as its position ("the honest answer is nothing, because <reason>"),
which is a stance, not a hedge. A menu is not a recommendation; options
belong in `# The call`, ranked. `foo ideate check` refuses a record whose
recommendation is still null. Everything below `decider` in the front matter
is machinery (ids, contract version, the measured meter) — never add
explainer comments to it; the contract and this skill teach, the record
states.

## Useful decisions

The rendered decision is the human deliverable. It explains what the proposed
mechanism changes for the user, what it retains or challenges from named prior
research and ideas, and why it wins against the best alternative. Give each
alternative a condition under which the user should choose it.

In every ranking table, put `What this is` immediately after `Direction`.
Use one plain-English sentence saying who does or receives what. Describe the
idea itself before explaining why it ranks here; a renamed title or a phrase
such as “improves efficiency” does not explain the idea. Include the same
description for excluded directions so readers understand what was rejected.

Make the first experiment executable: an action, a time or cost bound, an
observable pass criterion, and a stop/change-direction criterion. Treat this
as a test to propose, not permission to run it. Preserve unresolved empirical
claims as explicit assumptions. If the evidence kills every candidate,
recommend doing nothing or gathering the missing evidence; do not manufacture
a winner to fill the form. Label scope cuts as proposals for the human; evidence-based exclusions remain
ineligible. Keep excluded directions in the backing rank with their refutation
and no score. The conductor owns the exact record and rendering
schema, including the size budget and validation commands.

## Judgment ledger

Carry claim, evidence, inference, confidence, dissent through the run. The
diversity meter and minority report are ledger entries, not decoration — a
homogeneous pool or vanished dissent is a finding to surface, never smooth
over. User-only decisions: the pick, the not-doing list, any scope call.

The meter is computed, never counted by reading: run
`foo ideate diversity <record> --write` over the stored objects. A number you
reached by eye must say `diversity_method: estimated` — every downstream reader
treats the meter as measured, so an eyeballed one is worse than none.

## Usage

```text
foo ideate "a CLI that reviews my dependencies for supply-chain risk"
foo ideate "make onboarding not suck" --depth deep
foo ideate context "make onboarding not suck" --json
foo ideate check ideas/2026-07-06-dep-risk.md --before-build-on
foo ideate diversity ideas/2026-07-06-dep-risk.md --write
foo ideate check ideas/2026-07-06-dep-risk.md
foo ideate result ideas/2026-07-06-dep-risk.md
Use $ideate on this idea: <idea>
```

Run the CLI first; it emits the contract this craft plugs into.

## Error Handling

- **No idea text** — ask for the idea in one sentence; never invent a
  placeholder.
- **Contract missing** (skill invoked without a `foo ideate` run) — run the
  CLI first; do not improvise phases or cells from memory.
- **Asked to auto-pick or auto-ship** — refuse: the Decider is human (D6);
  offer the shortlist and the `foo spec` hand-off instead.
- **Procedural failures** (homogeneous pool, judge inconsistency, missing
  dissent, budget exhaustion) — the emitted contract carries the recovery
  rules; follow it, and never bypass `foo ideate check` by hand-editing the
  verdict.
- **No prior-work match** — local discovery is lexical and bounded. Inspect
  related terminology and supplied references; record the search gap honestly.
- **Unresolved claim** — record unknown, retain its uncertainty in the decision,
  and propose a test. A record check proves coverage and consistency, not facts.
