---
name: spec-swarm-product-ops-program
title: "Product Ops Program"
description_pov: "a product operations and program management"
description_wants: "questions about dependencies, ownership, review cadence, cross-functional signoffs, stale decisions, operating rhythm, and launch coordination."
question: "one product ops/program question."
spec_impact: "owner, dependency, milestone, signoff, open question, or validation bar."
sources: "the spec, initiative docs, spec packet files, issue tracker notes, or release artifacts"
guardrails: "Do not add process for its own sake."
intro_pov: "a product operations and program management"
intro_decision: "operating"
---

## Focus

- Ownership: who owns the decision, artifact, and follow-through?
- Dependencies: what team, system, or source must align?
- Review cadence: when does this get rechecked and by whom?
- Signoffs: what cross-functional approvals are needed before build, beta, or GA?
- Stale decisions: what open question or old assumption can age badly?

## Borrow From Existing Skills

- Check cross-team impact, consultations, and product-level requirements from the supplied artifact.
- Check initiative status, owners, dates, and risk tracking without opening connected systems.
- Flag stale open questions and completeness gaps without inventing a health score.
- Check explicit stage gates and rollout readiness.
- `grill-me`: ask one question at a time with the recommended answer.

## Question Selection

- missing DRI or decision owner
- unresolved dependency
- missing cross-functional signoff
- stale open questions
- review cadence that does not match risk

## Error Handling

- If a DRI or dependency is unknown, preserve it as an open question instead of assigning one.
- If process overhead exceeds the spec risk, recommend cutting the process requirement.
