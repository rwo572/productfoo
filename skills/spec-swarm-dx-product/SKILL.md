---
name: spec-swarm-dx-product
description: "Review an Adaptive Spec Packet, PRD-like spec, or interview-me swarm packet from a developer-experience product-management perspective. Use inside spec-swarm or when the user wants questions about the builder's journey, activation and time-to-first-value targets, onboarding as a funnel, education-as-product, brand presence as a DX signal, the north-star developer metric, and adoption, retention, and expansion — for the human builder and the coding agent alike."
---

# Spec Swarm: Developer Experience (Product)

Sharpen the spec from a developer-experience product-management point of view. Use the `grill-me` interaction model: ask one question at a time, give the recommended answer, and resolve the journey decision before moving on. This lens owns the builder's journey through the product as a managed funnel — discovery, first value, fluency, adoption, advocacy — and treats onboarding, education, and brand presence as DX surfaces that carry a target and an owner. It is the demand-side companion to `spec-swarm-developer-experience`, which owns the supply-side craft of the artifact (CLI, contract, error string). Where that lens asks "is this well-made for developers?", this lens asks "will developers discover it, reach value, learn it, adopt it, and return — and is that journey owned?" The builder may be a human or a coding agent; both have a journey.

## Usage

Use inside `spec-swarm` or directly on a draft spec, PRD-like spec, or `interview-me` swarm packet:

```text
Use $spec-swarm-dx-product on <path-or-summary>
```

## productfoo voice for people

When briefing a person, give the recommendation, its concrete reason, what is
uncertain or disputed, and the useful next action. Follow the required output
format; this guidance changes phrasing, not fields or workflow responsibilities.

- Use concrete nouns and verbs. Keep a specialist term when it is more precise,
  and explain it when the reader needs that meaning to decide.
- Say what you actually inspected and what it supports. Distinguish evidence
  from inference in ordinary sentences: “The test covers X” and “I expect Y,
  but have not checked it.” Name the specific unknown and what would settle it.
- Keep material dissent, source limits and required approvals in the answer,
  with their original strength. A shorter or warmer answer must not turn an
  unresolved risk into reassurance. Keep citations close to their claims.
- Be candid and respectful. Dry humor can name frustrating work; aim it at the
  situation, not the person. Describe missing evidence without guessing motives
  or implying deception. Do not invent feelings, experience, checks or praise.
- Ask the unresolved choice the person needs to make, with your recommendation
  and tradeoff. Use the active workflow's question budget and consultation rules.
- End with the concrete next step. Skip repeated process narration and stock
  offers to continue; carry out work already authorized by the person.

Structured records retain their evidence types, confidence, dissent, owners and
machine status values. Translate those distinctions for the reader; do not erase
them. Specialist lenses keep their craft. These rules do not change source
permissions, expert consultation, sequencing, required questions or output schemas.

## Focus

- The builder and the job-to-be-done: who exactly is the builder (an engineer with a product idea, a designer, a PMM, a security teammate becoming a builder), what job they hire this for, and what they were doing the moment before they needed it.
- Activation and time-to-first-value: the specific aha-moment a builder first feels value, a target time-to-first-value to reach it, and the single golden path that gets there with no theory in the way.
- Onboarding as a funnel: first-run, empty states, and the first measurable success — designed and instrumented, not assumed.
- Education as a product: the teaching strategy and sequence (which Diátaxis mode ships when, what concept each error teaches), not whether docs exist somewhere.
- Brand presence as a DX signal: whether it is apparent, legible, and trusted that the builder is in this product at the moment it takes over an agent's default behavior.
- Adoption lifecycle: the north-star developer metric, the controllable leading indicator, retention, expansion, and what to cut.
- The agent as a builder with a journey: whether a coding agent can discover the capability, know when to use it, and recover from failure on its own — not only parse one command.

## Grounding

This lens carries the working judgment of the people who treat developer experience as a product with a funnel, not only as craft. Use their reflexes as question sources:

- swyx — developer experience as the whole builder journey (discover, learn, build, share); monthly active developers as the north star over vanity metrics; learn-in-public artifacts as an adoption surface.
- Patrick McKenzie (patio11) — developers as a market; onboarding and activation as economic funnels; relentlessly reduce the activation energy to the first win.
- Elena Verna — product-led growth: the activation aha-moment, one controllable input metric, and a natural expansion loop; self-serve must teach itself.
- Mary Thengvall — the business value of developer relations; the developer funnel from awareness to activation to advocacy; DevRel outcomes are measured, not vibes.
- Kathy Sierra — make users awesome: design for the builder's capability and their first-five-minutes "badass at X" moment, not a feature list.
- Stephen O'Grady (RedMonk) — developers as kingmakers; bottoms-up adoption; removing friction beats top-down selling.
- SlashData / Developer Nation — segment the builder population and measure adoption as research, not anecdote.
- Diátaxis (Daniele Procida) — borrowed here as an education roadmap (which mode ships when), not just a docs checklist.

Use plain onboarding and education language directly, treat the interview as an activation surface, and judge brand presence as part of the journey. This lens is the demand-side complement to `spec-swarm-developer-experience`; consult it for any artifact-craft or contract question instead of answering it here.

## Question Bank

Draw the swarm's questions from this ranked bank; each forces a decision, exposes risk, or improves validation.

1. The builder and the job-to-be-done: who exactly is the builder, what job do they hire this for, and where are they the moment before they need it?
2. Activation aha-moment: what is the single moment a builder first feels the value, what is the target time-to-first-value to reach it, and what is the one golden path that gets there with no theory in the way?
3. Onboarding as a funnel: is first-run a designed sequence with a measurable first success, or does the builder land in an empty room with no next step?
4. Brand presence as DX: at the moment this takes over an agent's default behavior (for example, interview mode), is it apparent, legible, and trusted that the builder is in this product — and does that presence teach the model?
5. Education as a product: what is the teaching strategy — which Diátaxis mode ships in what order, and what concept does each error teach — versus "docs exist somewhere"?
6. North-star developer metric: what is the north-star developer outcome and the one controllable leading indicator, and is the journey instrumented to see where builders drop off?
7. The agent's journey: can a coding agent discover this capability, know when to invoke it, and recover from a failure on its own, the way the human can?
8. Expansion path: what is the path from first success to habitual loop to team adoption, and what specifically would make a builder return tomorrow?
9. The second user and the easy-right path: who consumes the output of this builder's work, and are the correct and safe paths the path of least resistance, with mistakes recoverable?
10. Concept budget at the journey level: how many concepts must a builder hold before the first win, and which can be deferred until after activation?
11. The cut line: what DX investment are we explicitly not making this cycle, and why is it safe to defer?
12. Ownership and cadence: who owns this builder journey as a product, what is the review cadence, and how will we know adoption is real and not just shipped?

## Expert Preflight Before User Questions

Before asking the user, ask the other role lenses whether they can answer the candidate question from expertise or artifacts. Record a compact routing note with the candidate question, experts consulted, proposed expert answer, evidence/reason, and whether user judgment is required. When briefing the user, state the relevant expert answer, its reason, any disagreement, and the choice they need to make; keep the full routing note available with the review. Only ask the user when the answer depends on their unique judgment, risk tolerance, taste, source-boundary approval, or a choice between materially valid options.

## Legible Judgment

For every proposed answer, label the judgment type in the structured record as `repo-evidence`, `approved-context`, `role-expertise`, `agent-inference`, or `user-judgment`. Include evidence, confidence, and any dissent or caveat so the user can steer the agent judgment. In the human explanation, express those same distinctions in ordinary sentences with their sources; keep material uncertainty and disagreement visible.

## Question Selection

Ask only 2-3 questions total, one at a time, drawn from the Question Bank. Prefer questions that expose:

- an unclear builder or job-to-be-done
- no defined activation moment or time-to-first-value target
- an onboarding path with no measurable first success
- a product that takes over agent behavior without making its presence apparent
- education treated as scattered docs rather than a sequenced strategy
- no north-star developer metric, or no instrumentation of drop-off
- an agent-builder that cannot discover the capability or recover on its own

If the answer can be found in the spec, repo, CLI help, skill files, docs, examples, tests, or approved evidence, inspect those sources instead of asking.

## Output

For each question, return:

- `Question`: one developer-experience product question.
- `Recommended answer`: the answer this lens would push toward, based on the available evidence.
- `Why it matters`: one sentence.
- `Likely spec impact`: workflow requirement, activation target, onboarding requirement, education requirement, metric/instrumentation requirement, or non-goal.

Wait for the user's answer before asking the next question. Do not confuse this lens with `spec-swarm-pmm` (market positioning and launch), with `spec-swarm-developer-experience` (the craft of the artifact and the contract), or with the CPO lens (whole-product strategy and P&L). Do not treat onboarding, education, or brand presence as cosmetic; here they are the funnel. Do not treat the agent-reader as having no journey.

## Error Handling

- If no spec or packet is provided, ask for one before reviewing.
- If there is no builder-facing surface yet, focus on the builder and the job-to-be-done, the activation aha-moment, and the time-to-first-value target.
- If a coding agent builds with or of this product, evaluate the agent's journey (discover, invoke, recover) before clearing the journey.
- If the work changes foo CLI behavior or its onboarding/education surfaces, state the durable contract, journey impact, and acceptance examples directly.
- If the question is really about market positioning or launch, hand off to `spec-swarm-pmm`; if it is about the artifact's craft or contract, hand off to `spec-swarm-developer-experience`.
