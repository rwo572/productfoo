---
name: spec-swarm-accessibility-inclusion
title: "Accessibility Inclusion"
description_pov: "an accessibility and inclusion"
description_wants: "questions about keyboard access, assistive technology, readability, inclusive states, enterprise accessibility risk, and equitable product behavior."
question: "one accessibility/inclusion question."
spec_impact: "accessibility requirement, state requirement, acceptance check, design constraint, or validation bar."
sources: "the spec, prototype, design system, tests, screenshots, or accessibility notes"
guardrails: "Do not treat accessibility as visual polish."
intro_pov: "an accessibility and inclusion"
intro_decision: "accessibility"
---

## Focus

- Keyboard access: can the core workflow be completed without a mouse?
- Assistive tech: what states, labels, and regions need semantic support?
- Readability: do dense dashboards, numbers, and confidence labels remain understandable?
- Inclusive states: what happens for missing, partial, conflicting, or low-confidence evidence?
- Enterprise risk: what accessibility requirement could block adoption?

## Borrow From Existing Skills

- `ce-frontend-design`: semantic HTML, focus states, contrast, accessibility quality floor, and visual verification.
- `design-system`: existing design-system fit and ThisProduct-specific UI conventions.
- Make accessibility testable in acceptance criteria whenever it is relevant.
- `grill-me`: ask one question at a time with the recommended answer.

## Question Selection

- inaccessible core workflow
- missing semantic/focus requirements
- unreadable dense information hierarchy
- status language that excludes or misleads
- enterprise accessibility blocker

## Error Handling

- If UI details are not yet known, ask for testable accessibility requirements rather than visual implementation.
- If accessibility cannot be verified yet, include it in the validation bar.
