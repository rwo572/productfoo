---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.

## Usage

Use this skill when its frontmatter description matches the user request. Follow the workflow and constraints below.


When the user explicitly asks to be grilled, pressure-test the plan until its consequential decisions are understood, resolving dependencies one at a time. When another skill borrows this interaction model, use its scope and question budget: one question, a recommended answer, then wait. Borrowing the pattern does not request an exhaustive interview. Keep criticism specific to the plan and its evidence. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Error Handling

- If required files, tools, connectors, credentials, or source artifacts are unavailable, state the blocker clearly and continue only with safe local evidence.
- If the user request requires missing product judgment or source-boundary approval, ask one focused question before proceeding.
