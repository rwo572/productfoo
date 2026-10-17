---
name: create-prd
description: "Use when a product idea needs a PRD outline but reading private files or publishing to an external document system would be required."
---

# Create PRD

## Usage

This draft keeps its file-ingress and egress boundaries. It may draft an in-chat
or local outline from explicit intent, repo facts, and approved sanitized evidence;
it must not open a supplied file, fetch connected context, publish, sync, or update
an external document.

Draft problem, audience, intent, requirements, non-goals, evidence, risks,
validation, decisions, and open questions. Include **Sources used**, **Sources
omitted**, **Trust status**, and **Limits**. Prefer `foo spec` or `foo spec start`
for a governed packet.

## Error Handling

- If a required input is file-only or the requested result must be published,
  return `status: blocked`, name what did not run, identify the file-ingress or
  egress boundary, give the exact `next action`, and set `exit: nonzero`.
- Never paste or inspect private source material as a fallback. Return the safe
  in-chat outline and hand publication to a person.
