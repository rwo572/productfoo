---
name: interop-review
description: "Use when an interoperability decision needs a local review outline but copying results to an external system would be required."
---

# Interoperability Review

## Usage

This draft keeps its egress boundary. From explicit intent, repo facts, and
approved sanitized evidence, it may prepare an in-chat or local outline; it must
not fetch private guidelines, copy results, publish, or update another system.

Review protocol assumptions, versioning, identity, data mapping, failure modes,
security, compatibility, migration, observability, and ownership. Separate
verified facts from hypotheses and include **Sources used**, **Sources omitted**,
**Trust status**, and **Limits**.

## Error Handling

- If the requested outcome requires an external read or write, return `status:
  blocked`, name what did not run, identify the egress boundary, give the `next
  action: provide approved sanitized evidence and review the local outline`, and
  set `exit: nonzero`.
- Do not infer a partner contract, guideline, or compatibility guarantee.
