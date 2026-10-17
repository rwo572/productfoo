---
name: build-preview-spec
description: Use when an app-building agent needs a fast visual checkpoint before implementation because product shape, workflow, states, assumptions, or human approval boundaries are not yet obvious.
---

# Build Preview Spec

Use Build Previews as a **control preview**, not a design handoff. The job is to show the smallest useful preview of the agent's product judgment before that judgment gets committed to code.

A good preview helps the user decide whether to let the agent run. It must not make the user do design homework.

## Usage

Use this skill when a user or agent needs to preview app shape, workflow, states, or assumptions before generation:

```text
Use $build-preview-spec for <app idea, spec, packet, or workflow>.
```

Do not require a Build Preview when the user clearly wants direct-to-app exploration, the task is low-risk, the shape is already specified, or rework is cheap. In those cases, say that a preview is optional and proceed only if the user asks for it.

## Speed Contract

The preview must feel faster than recovering from a wrong build:

- Keep the default preview skimmable in under 60 seconds.
- Prefer one strong build preview over multiple variants unless comparison is the product question.
- Show only enough layout, data, and state to expose the agent's judgment.
- Give explicit controls: `Build this`, `Revise direction`, `Show alternatives`, and `Skip preview next time`.
- Keep the visual register finished, not rough — a wireframe reads as unfinished and erodes trust. Spend that fidelity on clear hierarchy, realistic data, and honest states rather than on bespoke visual-design exploration, unless visual design is itself the thing being judged. (`preview-swarm` defines the full `Visual Quality Bar` and the harness-adaptive generation paths.)

## Clarity-First Defaults

The preview has failed if a developer finds it confusing. Apply before the first show, every time:

- One decision per screen, three choices or fewer; frame trade-offs as a labeled spectrum with exactly one recommendation.
- Plain language leads. Put commands, JSON, event schemas, and requirement IDs behind a single "show detail" disclosure — a terminal or raw-JSON default reads as a wireframe.
- Show outcomes with plain cards and state chips, not command output.
- Each revision subtracts: fewer words, controls, and findings. Adding surface area needs a reason.
- Run the deterministic detector and fix every P0/P1 before showing, do not merely report them; the user calling it busy or confusing is itself a P1.

## Control Levels

Choose the lightest level that can prevent wrong-code momentum:

- **Intent snapshot**: one flow, one screen, key assumptions, and build controls.
- **Scenario preview**: realistic dummy data, primary workflow, and core states.
- **Divergence preview**: a few materially different product theses when multiple valid shapes exist.
- **Reviewable mini-app**: clickable/commentable artifact only when convergence, traceability, or spec updates matter.

## Required Preview Content

Every preview must make the agent's judgment inspectable:

- What I think the user wants.
- The product shape I would build.
- Why this shape fits the goal.
- What workflow and states are covered.
- What assumptions I am making.
- What I am intentionally not building.
- Confidence and dissent or caveats.
- What still requires human taste, risk tolerance, source approval, or product judgment.

## Build Preview Content

Use layout only to clarify product judgment:

- Name the primary user, job, and decision the preview supports.
- Show the first meaningful workflow, not a generic landing page.
- Use realistic fake records, names, statuses, dates, provenance labels, and edge cases when data matters.
- Include empty, loading, populated, error, stale, ambiguous, approved, rejected, or regenerated states when they affect trust.
- Attach rationale to the relevant page, panel, or component instead of hiding it in a long explanation block.
- Keep raw requirement IDs secondary; show plain-language user promises first.

## Agent Loop Annotation

For agentic products, annotate the loop directly on the preview:

```text
read -> infer -> propose -> approval boundary -> revise -> outcome/export
```

The user should be able to see what the agent reads, what it believes, what it would do next, and where it must stop for approval.

## Output

Return a compact build brief, not just a picture:

- Recommended build direction.
- Accepted assumptions.
- Rejected or deferred directions.
- Required screens, states, and data.
- Human approval boundaries.
- Source or privacy boundaries.
- Exact next prompt the implementation agent should run.

## Error Handling

- If the user asks to build immediately and the task is low-risk, do not force a preview.
- If the source material is too thin to preview honestly, ask one focused question before inventing product truth.
- If multiple valid product shapes exist, recommend a divergence preview and explain the tradeoff.
- If private or sensitive source material would shape the preview, ask for source-boundary approval before using it.
- If the preview takes longer than the likely wrong-build recovery cost, stop and route direct-to-app.
