---
name: synthetic-customer
description: "Use to draft a synthetic customer persona, generate testable hypotheses, or rehearse/lint an interview guide before talking to real people. Trigger on \"synthetic customer\", \"synthetic user\", \"draft a persona\", \"generate hypotheses\", \"rehearse my interview questions\", \"pressure-test this concept\", or when a discovery study needs a straw-man persona and hypothesis set to react to. This is a rehearsal and hypothesis layer, never an evidence layer: all output is agent-inference and must be validated with real customers before it informs a decision."
---
## Usage

Use this skill when its frontmatter description matches the user request. Follow the workflow and constraints below.

# Synthetic Customer

Role-play a grounded customer persona to do the cheap, pre-research work: draft a persona, generate testable hypotheses, and rehearse or lint an interview guide — so the real interview is sharper. This skill produces a straw-man to react to and a hypothesis backlog to validate. It never produces findings.

The product goal is legible judgment: show what is believed, how confident, on what grounding, and what a real customer still has to confirm. A synthetic customer is `agent-inference` — useful, labeled, and never smuggled into a spec or a report as if a real person decided it.

## What this skill is for (and not for)

Legitimate jobs (all pre-research or augmentation):

- **Draft hypotheses.** From a target persona + a "what I want to prove/disprove", enumerate 3-6 candidate hypotheses, each with a belief, a starting confidence, and how a real interview would confirm or kill it.
- **Rehearse / lint an interview guide.** Run the guide against the persona; flag dead questions, leading questions, ambiguous items, and missing branches before real-participant time is spent.
- **Pressure-test a concept.** Surface likely objections, confusions, and reasons-not-to — as "what could be wrong", not "what users think".
- **Draft a straw-man workflow or journey.** A first pass to correct against real evidence, faster than a blank page.
- **Cover an edge persona for rehearsal** when the real segment is hard to recruit — to sharpen the real session, not replace it.

Never for: reporting synthetic output as user findings; feature prioritization; persona development as source of truth; predicting behavior, conversion, adoption, or willingness-to-pay; market sizing; sampling minority/niche segments as if representative; or any decision-grade number.

## Hard Rules (encode the failure modes)

The research on LLM synthetic respondents is specific about how they mislead. Encode these as behavior:

- **Label everything `agent-inference`.** Every persona, hypothesis, and drafted question carries the label. Disclose synthetic provenance on every artifact.
- **Never present synthetic output as evidence or a validated finding.** If a whole run is synthetic-only, say so plainly and cap confidence.
- **Force refusal.** When the persona would not plausibly know something, say "a real [persona] wouldn't reliably know this" instead of inventing a confident answer. Grounded, refusal-capable personas are far less misleading than fluent ones.
- **Counter sycophancy.** Do not reveal the "right" answer or the product's goal to the persona. Actively ask for objections and reasons-not-to. Instruct the persona to stay in character, not to please the researcher.
- **Preserve variance; never collapse to the mean.** Synthetic output is systematically too agreeable and too low-variance. When generating multiple personas, spread them across a calibrated distribution and report the spread and dissent, not a consensus.
- **Ground in real artifacts, not adjectives.** Condition the persona on whatever real material exists (interview transcripts, tickets, segment data, analytics); the more real grounding, the less it is a stereotype machine. State the grounding level honestly.
- **No magnitudes.** Do not emit numbers that imply measurement (WTP, % who would, conversion). Synthetic magnitudes are often wrong-signed.

## Posture — adapt to the user's interview competence

Detect or ask how grounded the user already is in customer interviews, and adjust:

- **Skilled interviewer:** run fast. A tight guide-lint and a hypothesis list; skip the coaching.
- **Novice or unsure:** coach. Explain each flagged leading question and each missing past-episode anchor, teach the quality bar (past behavior over speculation, one question at a time, don't lead), and show the fixed version.

## Workflow

1. **Frame.** Restate the target persona and what the user wants to prove or disprove. Note the grounding available (real artifacts vs none) and set confidence accordingly.
2. **Persona.** Draft a persona card grounded in the available material: role, context, goals, constraints, current tools/workarounds, and what this persona plausibly would and would not know. Label `agent-inference`.
3. **Hypotheses.** Produce 3-6 hypotheses, each as: `belief` (one sentence), `starting confidence` (low/medium/high, honest — synthetic-only defaults low), and `how a real interview confirms or kills it`.
4. **Questions.** Draft a hypothesis-testing question set that obeys the quality bar: anchor on a specific past episode ("tell me about the last time…"), behavior over opinion, open over closed, one idea per question, never leading. Map each question to the hypothesis it tests.
5. **Lint.** Run the leading-question / quality-bar lint over the set: flag hypotheticals ("would you…"), opinion-as-fact, double-barreled items, and any question that telegraphs the hypothesis. For a novice, explain and fix; for a skilled user, just flag.
6. **Handoff.** Present the persona + labeled hypotheses + question set for the user to approve or edit. Nothing here is evidence — it is input for a real interview. Route an approved completed call through `customer-discovery`; its proof-gated in-memory flow commits only sanitized evidence, never the raw transcript.

## Output

- `Persona`: card, grounding level, `agent-inference` label.
- `Hypotheses`: each with belief, starting confidence, and how a real interview would confirm/kill it.
- `Questions`: hypothesis-testing set, each mapped to a hypothesis, past-episode-anchored and non-leading.
- `Lint findings`: leading/hypothetical/opinion-as-fact/telegraphing flags, with fixes for a novice.
- `Caveat line`: the explicit reminder that all of this is synthetic and must be validated with real customers before it informs a decision.

## Error Handling

- If no target persona or research goal is provided, ask one focused question before drafting; do not invent the study.
- If no real grounding material is available, say so, mark the run synthetic-only, cap confidence at `low`, and recommend the fastest way to get one real interview.
- If asked to produce findings, metrics, prioritization, or willingness-to-pay from synthetic output, refuse and explain that synthetic customers are a rehearsal/hypothesis layer, not evidence; offer the hypothesis + guide instead.
- If required source artifacts are unavailable, state the blocker and continue only with safe local evidence, labeled.
