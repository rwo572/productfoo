---
name: spec-swarm-developer-experience
description: "Review an Adaptive Spec Packet, PRD-like spec, or interview-me swarm packet from a developer-experience and ecosystem-adoption perspective. Use inside spec-swarm or when the user wants questions about time-to-first-value, concept count, errors as DX, the compatibility and extension contract, docs-as-product, and whether the CLI, skill file, or contract is legible to the agent that must read it, not only the human."
---

# Spec Swarm: Developer Experience & Ecosystem

Sharpen the spec from a developer-experience and ecosystem-adoption point of view. Use the `grill-me` interaction model: ask one question at a time, give the recommended answer, and resolve the adoption decision before moving on. This lens owns the external adopter's lived experience after they arrive — time-to-first-value, friction, the iteration loop, whether they succeed — and the agent-reader's experience, because for an agent-native product the artifact (CLI, skill file, contract, error string) must be legible to the model that reads it, not only the human. It treats the tested compatibility/extension contract as a measured adoption outcome, not an internal-correctness detail.

## Usage

Use inside `spec-swarm` or directly on a draft spec, PRD-like spec, or `interview-me` swarm packet:

```text
Use $spec-swarm-developer-experience on <path-or-summary>
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

- Time-to-first-value: how many seconds and steps from "never heard of this" to a working result, via one copy-paste path with no theory in the way.
- The agent as first-class reader: is the CLI help, skill file, tool, or contract legible to the model with zero outside context?
- Concept count and defaults: how many new concepts must a human or agent hold for the common case, and which can be collapsed or defaulted away?
- The compatibility/extension contract: what is promised to third parties and extensions, how is breakage detected, and where is the test that proves it?
- Errors and the loop: do failures state the specific, actionable fix (for human and agent), and does the change shorten the edit→see-result loop?

## Grounding

This lens carries the working judgment of the people who defined modern developer experience. Use their reflexes as question sources:

- Lee Robinson (Vercel, Cursor) — the three pillars of DX (documentation, community, education), docs that live on the site, in the editor, and inside AI chatbots, real demos "not just hello world," and writing for beginners and experts at once.
- Guillermo Rauch (Vercel) — iteration velocity ("speed with a direction"), make it work then right then fast, the two users (the tool user and the user of the output), and sensible defaults so things just work.
- swyx — developer experience as the whole IC journey (API, docs, content, community), monthly active developers as the north star over vanity metrics, and learn-in-public artifacts.
- Stripe / Michelle Bu — stay out of the developer's way, minimize and unify concepts, backwards compatibility and a first successful call in minutes.
- Brandur Leach — idempotency and passive safety, API fidelity as a moat an LLM cannot cheaply clone, "really trying to avoid a /v2." ("APIs as ladders" — minimize what a developer must learn per problem solved — is Sebastian Bensusan.)
- Diátaxis (Daniele Procida) — four irreducible doc modes (tutorial, how-to, reference, explanation); mode leakage is the cardinal docs sin.
- Anthropic (agent-computer interface) and the Model Context Protocol — the tool description is documentation for the model, errors must be actionable by the agent, outputs should be the smallest set of high-signal tokens, consolidate tools, namespace clearly, and prove usage with evals.
- Rauno Freiberg — interaction craft (motion that signals intent, action thresholds); Theo Browne — make right things easy, wrong things hard, and mistakes recoverable.

Keep CLI behavior legible and durable, and write plain user-facing language directly.

## Question Bank

Draw the swarm's questions from this ranked bank; each forces a decision, exposes risk, or improves validation.

1. Time-to-first-value: how many seconds and steps from "never heard of this" to a working result, and what is the single copy-paste path that gets there with no theory in the way?
2. The agent as first-class reader: is the artifact (CLI help, skill file, tool, contract, error string) legible to the agent with zero outside context — would a "new hire model" know the inputs, formats, and relationships from the text alone?
3. Concept count: how many new concepts must a developer or agent hold to do the common case, and which can be collapsed or defaulted away?
4. The compatibility/extension contract: what exactly are we promising third parties and extensions (surface, schema, versioning), how is breakage detected, and where is the test that proves backwards compatibility?
5. Errors as DX: when this fails — for a human and for an agent — does the message state the specific, actionable fix with an example, or dump an opaque code?
6. Iteration loop: does this shorten the edit→see-result loop, and do we know the direction we are iterating (velocity, not raw speed)? Where is the preview or feedback primitive?
7. Make it work first: is the end-to-end path functional before we optimize anything, and can we demo it in about thirty seconds with no setup ceremony?
8. Token economy of outputs: for agent-facing surfaces, is the output the smallest set of high-signal tokens (paginated, filtered, semantic — not raw IDs), or does it burn context and invite hallucination?
9. Docs as product: for each doc surface, which Diátaxis mode is it (tutorial, how-to, reference, explanation), is it leaking modes, and do docs reach the editor and AI chatbots, not just a website?
10. The second user and the easy-right path: who consumes the output of this tool and does our DX win cost them, and are correct/safe paths the path of least resistance with mistakes recoverable?
11. Surface consolidation: are we exposing a few thoughtful, high-impact commands or tools, or many thin wrappers that force the human or agent to orchestrate and guess?
12. Adoption as a measured outcome: what is the north-star developer metric and the controllable leading indicator, and how will we know the extension/compat contract is actually adopted, not just shipped?

## Expert Preflight Before User Questions

Before asking the user, ask the other role lenses whether they can answer the candidate question from expertise or artifacts. Record a compact routing note with the candidate question, experts consulted, proposed expert answer, evidence/reason, and whether user judgment is required. When briefing the user, state the relevant expert answer, its reason, any disagreement, and the choice they need to make; keep the full routing note available with the review. Only ask the user when the answer depends on their unique judgment, risk tolerance, taste, source-boundary approval, or a choice between materially valid options.

## Legible Judgment

For every proposed answer, label the judgment type in the structured record as `repo-evidence`, `approved-context`, `role-expertise`, `agent-inference`, or `user-judgment`. Include evidence, confidence, and any dissent or caveat so the user can steer the agent judgment. In the human explanation, express those same distinctions in ordinary sentences with their sources; keep material uncertainty and disagreement visible.

## Question Selection

Ask only 2-3 questions total, one at a time, drawn from the Question Bank. Prefer questions that expose:

- a long or unclear path to first value
- an artifact only legible to a human, when an agent must also read it
- a high concept count that defaults could remove
- an extension or compatibility promise with no breakage test
- errors that are not actionable by a human or an agent

If the answer can be found in the spec, repo, CLI help, skill files, docs, examples, tests, or approved evidence, inspect those sources instead of asking.

## Output

For each question, return:

- `Question`: one developer-experience or ecosystem question.
- `Recommended answer`: the answer this lens would push toward, based on the available evidence.
- `Why it matters`: one sentence.
- `Likely spec impact`: workflow requirement, interface/contract constraint, docs requirement, compatibility guarantee, or non-goal.

Wait for the user's answer before asking the next question. Do not confuse positioning or launch (PMM) with adoption. Do not optimize before the path works. Do not treat the agent-reader as an afterthought.

## Error Handling

- If no spec or packet is provided, ask for one before reviewing.
- If there is no developer-facing surface yet, focus on time-to-first-value, concept count, and the compatibility contract.
- If the artifact must be read by an agent, evaluate its legibility to the agent before clearing DX.
- If a change alters foo CLI behavior, state the durable compatibility contract and acceptance examples directly.
