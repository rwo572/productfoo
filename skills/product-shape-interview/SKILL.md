---
name: product-shape-interview
description: "Run a one-question-at-a-time shaping interview before generating an HTML artifact, scenario prototype, workbench, Build Preview, or visual app exploration from a spec packet, PRD-like spec, approved intake summary, or swarm report. Use when the user wants one solid artifact optimized for a product bet rather than multiple divergent directions, when realistic dummy data is needed to make an app feel real, or when the artifact generator needs a packet-local Shape Brief and exact next generator prompt."
---

# Product Shape Interview

Shape one artifact before generation. This skill decides what one HTML artifact should prove, what scenario it should make feel real, and what generator prompt should run next.

## Usage

Use with a spec packet, PRD-like spec, approved `interview-me` intake summary, `spec-swarm` report, or existing artifact critique:

```text
Use $product-shape-interview on <packet-or-spec-path> before generating an artifact.
```

If no source artifact is provided, ask for the spec packet, spec path, intake summary, swarm report, or artifact critique before shaping.

## Core Rule

Do not generate UI, HTML, Build Previews, scenario prototypes, or mockups during this skill. Produce a Shape Brief first. The next generator must consume that brief.

Default away from multiple directions. Recommend one artifact job unless the source material shows comparison itself is the product question.

## Clarity-First Defaults

The brief must steer the generator toward a clear artifact, not a dense one. Bake these into `Visual And Interaction Posture` and `Design Review Plan` so the downstream generator inherits them. The artifact has failed if a developer finds it confusing.

- One decision per screen, three choices or fewer; trade-offs as a labeled spectrum with exactly one recommendation.
- Plain language leads; commands, JSON, event schemas, and requirement IDs go behind a "show detail" disclosure, never the default surface.
- Outcomes shown as plain cards and state chips, not command output.
- Fix detector P0/P1 before the first show, do not merely report them; treat "busy" or "confusing" as a blocking defect.

## Inputs

Read the provided source artifact and extract:

- Product bet
- Primary user, buyer, reviewer, or operator
- Core workflow or broken decision
- Product objects and relationships
- Agent behavior, if any
- Human approval or steering boundaries
- Trust, provenance, confidence, dissent, and privacy requirements
- Existing realistic data hints, source constraints, and fake precision risks
- Required states: empty, loading, populated, error, stale, ambiguous, rejected, approved, regenerated
- MVP boundary, explicit non-goals, and open questions
- Prior critique of generated artifacts, if available

Do not use raw private notes, transcripts, or source dumps unless the user explicitly approved them for this shaping run.

## Shaping Interview

Before asking the user, inspect the source artifact and decide what is already answered. Ask only questions that require unique product judgment, taste, appetite for risk, source-boundary approval, or a choice between materially valid options.

### Announce and teach (productfoo brand presence, R-004)

Before the first question, emit the signature frame and a compact announce-and-teach block so the user knows productfoo has taken over the agent's default behavior and learns the loop in the same beat (full on the first interview of a session, one line thereafter):

```
── foo ▸ shape ──────────────────────────  specs over vibes ──
You're in foo: I'll ask a few focused questions, then shape the artifact — not autocomplete a guess.
I've read what you gave me, so I'll only ask what it can't tell me — about 4 questions.
Say "go deeper" for more, or "just write it" to skip.
Progress: Q1 / ~4
```

Say what is about to happen, in the user's words. Do **not** list the fields a spec contains: "the product bet", "source and approval boundaries", "MVP scope and the validation bar", "what still needs human judgment" are productfoo's filing labels, not a first-time user's language, and a list of them is the machinery showing through on the first screen anyone ever sees. The one thing worth teaching is the loop itself — productfoo reads the source artifact and asks only the gaps (that is the whole point of the preflight above) — so say that, and get to Q1. State one count only, the depth you are actually running, and make the progress counter match it. Name the escape hatches explicitly, and drop the box-drawing when output is piped or read by an agent (R-008).

Ask one question at a time. Use numbered options with a recommendation when defensible:

```text
Question: What should this artifact optimize for first?

1. **End-to-end scenario realism (Recommended)**
   Best when the current artifact does not feel like real software yet.
2. Agent behavior and approval
   Best when the product depends on what the agent reads, infers, proposes, and waits on.
3. Product model clarity
   Best when the app category, objects, and workflow shape are still unclear.
4. Visual application realism
   Best when the product model is settled but the screens need to feel credible.
```

Rules:

- Keep options numbered `1` through `4` when practical.
- Mark exactly one option with `(Recommended)` when evidence supports it.
- Bold the recommended option label in Markdown.
- If no recommendation is defensible, say `No recommendation yet` before the options.
- Wait for the user's answer before asking the next question.
- Do not ask for facts that the spec, packet, code, design system, or approved context can answer.

High-value shaping questions:

- What should the artifact optimize for first: product model, agent behavior, end-to-end workflow, realistic data, visual credibility, or decision export?
- What kind of artifact should exist: scenario prototype, product model explorer, agent trace player, app mock, decision workbench, or hybrid?
- What one scenario should the user feel from start to finish?
- Which object model should anchor the artifact: task, case, packet, source, user journey, decision, queue item, or agent run?
- What must the agent see, believe, propose, ask approval for, revise, and export?
- What realistic dummy data would make the product feel real?
- What states or edge cases must appear so the artifact does not feel fake?
- What should the human be able to decide after using the artifact?
- What should stay out of the artifact because it would create fake precision or false product truth?
- What exact generator should run next?

## Shape Brief Contract

Write the accepted brief inside the source packet:

```text
<packet>/artifacts/shapes/<run-id>/shape.md
```

If the input is not a packet, write the brief beside the input artifact in the nearest reasonable `artifacts/shapes/<run-id>/shape.md` location and explain the location.

Use a timestamped, slugged run ID such as `2026-06-19-scheduling-scenario`.

The Shape Brief must include:

```markdown
# Product Shape Brief

Source:
Run ID:
Status:
Created:

## Optimization Target

## Artifact Type

## Primary Scenario

## Primary Reviewer

## Product Model

## Core Objects

## Agent Loop

## Human Decision

## Realistic Dummy Data Contract

## Required States

## Trust And Provenance

## Visual And Interaction Posture

## Design Review Plan

## Non-Goals

## Open Questions

## Generator Prompt
```

### Field Guidance

- `Optimization Target`: name the main thing the artifact must prove, not a list of all goals.
- `Artifact Type`: choose one primary type such as `scenario prototype`, `product model explorer`, `agent trace player`, `application mock`, or `decision workbench`.
- `Primary Scenario`: describe the one workflow slice the artifact must make feel real.
- `Product Model`: name the app shape, such as queue, cockpit, canvas, wizard, inbox, review room, ledger, timeline, or operating surface.
- `Core Objects`: list the objects the artifact must make tangible, with relationships.
- `Agent Loop`: show `read -> infer -> propose -> approval boundary -> revise -> outcome/export` when the product is agentic.
- `Realistic Dummy Data Contract`: define plausible records, names, statuses, timestamps, source labels, masked/private fields, stale evidence, errors, and edge cases. Avoid gray placeholder bars as primary content.
- `Required States`: include enough states to make the product behavior credible.
- `Trust And Provenance`: define what evidence, source boundary, confidence, dissent, or privacy markers must be visible.
- `Visual And Interaction Posture`: state the design system, density, motion, and app realism expectations without turning the brief into a full design spec. Default to clarity-first: plain language leads, three choices or fewer, and implementation detail (commands, JSON, requirement IDs) sits behind progressive disclosure.
- `Design Review Plan`: name which post-generation review should run, usually `$impeccable critique <artifact>`, plus `$impeccable audit <artifact>` or `$impeccable polish <artifact>` when the artifact promises responsive, accessible, production-like behavior. Require P0/P1 fixed before the first show, not merely reported. If Impeccable is unavailable, require a manual review gap to be recorded.
- `Non-Goals`: explicitly forbid four divergent directions unless comparison is the chosen artifact job.
- `Generator Prompt`: include the exact next prompt an agent can run.

## Generator Prompt Contract

End every brief with a directly runnable prompt:

```text
Use $scenario-workbench on <path-to-shape.md>.
Generate one HTML artifact optimized for the approved Shape Brief. Do not generate four directions unless the Shape Brief says comparison is the optimization target.
After generation, run the Shape Brief's Design Review Plan and report the critique snapshot path, score, P0/P1 findings, and remaining gaps.
```

If `scenario-workbench` does not exist yet, route to the closest available generator and make the gap explicit:

```text
Use $preview-swarm on <path-to-shape.md>, but treat the Shape Brief as authoritative: generate one scenario workbench, not divergent Build Preview directions.
After generation, run the Shape Brief's Design Review Plan and report the critique snapshot path, score, P0/P1 findings, and remaining gaps.
```

## Event Logging

If working inside a spec packet with `events.jsonl`, append an event only after the user accepts the Shape Brief or explicitly asks to record it. The event should point to the shape path and summarize the optimization target. Do not treat the shape as canonical product truth until accepted.

## Output

Return:

- Shape Brief path
- Optimization target
- Artifact type
- Primary scenario
- Dummy data contract summary
- Generator prompt
- Remaining user-judgment questions, if any

## Error Handling

- If the source artifact is missing, ask for the packet, spec path, intake summary, swarm report, or artifact critique before shaping.
- If the source is too thin to choose an optimization target, route back to `interview-me` before writing a fake Shape Brief.
- If the user wants immediate artifact generation, explain that this skill is a pre-generation gate and ask whether to skip the gate explicitly.
- If the artifact should use private sources, ask for source-boundary approval before including private-derived facts in the Shape Brief.
- If the run is not packet-local, explain where the brief will be written before writing it.
- If no generator skill exists for the chosen artifact type, write the brief anyway and put the generator gap in the prompt section.
