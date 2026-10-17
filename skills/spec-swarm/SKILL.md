---
name: spec-swarm
description: "Leaf craft for productfoo's spec-swarm runs: how to be a good role lens inside the private run contract that `foo swarm` hands to the coding harness. The conductor owns the choreography; this skill holds only the per-lens craft."
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.


# spec-swarm (leaf craft)

`foo swarm <spec-path>` prepares the record and privately hands the coding
harness its run contract. Execute that handoff without quoting or reproducing
its roster or choreography in user-facing output. This skill adds only the
craft — how to be sharp *inside* a lens. It contains no
orchestration; if this file and the emitted contract disagree about
sequencing or budgets, the contract wins.

## Lens craft (one candidate at a time, grill-me shaped)

- Form ONE candidate question, then its **recommended answer** — a lens that
  asks without recommending is offloading judgment, not exercising it.
- Ground the recommendation in **evidence you can point to**: a spec line, a
  code path, a test, a decision id. "The validation bar at line 115 checks X"
  beats "the spec seems to lack X."
- Prefer **decision-forcing** over critique: a good question changes the
  requirement, the boundary, the risk posture, or the validation bar; a
  generic observation changes nothing.
- **Drop answered questions with the citation** — finding that the packet
  already decided it (and saying where) is a contribution, not a wasted turn.
- Type every judgment honestly: `repo-evidence` (a source you inspected),
  `approved-context`, `role-expertise` (your canon, no direct proof),
  `agent-inference` (plausible synthesis — label it), `user-judgment` (taste,
  risk appetite, strategy — only the user's). Collapsing these types is the
  cardinal sin: the boundary between them is what the swarm exists to show.
- Carry one **dissent/caveat** line even when you agree — the caveat you
  almost didn't write is usually the finding.

## Question-quality sources by role

Borrow sharpening moves from the skill library: CPO → `cpo-lens` (outcome,
lifecycle, trust); Designer → `design-system` (states, hierarchy); Architect →
`ce-plan`, `interop-review` (boundaries, primitives); Security → `ready-for-release`,
`privacy-source-interview` (data handling, consent); Eval → golden sets, judge
calibration, no "demo looked good"; GTM/Field → `positioning-messaging`,
`competitive-positioning`; Growth/Business → value metric, willingness to pay,
payback. Steal the *question shape*, not the checklist.

## Common craft failures

- Six generic reviews instead of six distinct lenses.
- Asking the user what another lens or the repo could answer.
- Presenting inference as fact; hiding confidence or evidence gaps behind
  polished prose.
- Fake precision in cost, impact, or ROI numbers.
- Restating another lens's question with your role's vocabulary.

## Usage

```text
foo swarm specs/<packet>/spec.md
foo swarm "approved intake summary: <summary>" --depth fast
foo swarm check swarms/2026-07-08-<slug>.md
Use $spec-swarm on <path-or-summary>
```

Run the CLI first; it hands the coding harness the contract this craft plugs into. If no
artifact is provided, ask for the spec path or approved intake summary before
starting. After accepted swarm changes, the contract's REPORT phase names the
finalization gate: run `$spec-cleanup` on the packet before implementation —
until then the spec is swarm-reviewed, not implementation-ready.

## Error Handling

- **Spec or packet missing** — ask for it before any lens runs.
- **Contract missing** (skill invoked without a `foo swarm` run) — run the
  CLI first; do not improvise the roster, budget, or report shape from memory.
- **A lens has no distinct question** — skip that lens and say why; padding
  the roster is worse than a short swarm.
- **Artifact too thin or a product-shape rewrite without approved intake** —
  route back to `interview-me` instead of manufacturing questions.
- **Asked to implement during the swarm** — stop and hand off; the swarm
  surfaces judgment, it does not build.
