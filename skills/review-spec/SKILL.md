---
name: review-spec
description: "Use when one productfoo spec packet needs a focused quality, evidence, scope, risk, or implementation-readiness review."
---

# Review Spec

## Usage

Review one packet in depth. Use `check-spec-health` for a portfolio roll-up.

1. Read `spec.md`, `tasks.yaml`, and `events.jsonl`; preserve the append-only ledger.
2. Run `foo asp validate <packet-dir>` and, when implementation exists, `foo asp
   reconcile <packet-dir> --git-diff` or the approved source equivalent.
3. Check intent, requirements, non-goals, decisions, risks, validation, task
   dependency shape, proof, approval boundaries, and product/code drift.
4. Inspect repo facts and approved evidence before asking questions. A connector
   being installed is not source approval; raw private context is not packet evidence.
5. Report findings by severity, then propose the smallest repair. Apply edits only
   after the user approves product-meaning changes, and write packet events/tasks
   through `foo asp event` and `foo asp task`.

The report includes **Sources used**, **Sources omitted**, **Trust status**, and
**Limits**, plus the decisions that remain the user's alone.

## Error Handling

- If the packet is missing or malformed, name the exact validation failure and
  next command; do not invent missing intent.
- If a required source approval or proof is absent, stop the affected assessment
  with a visible nonzero handoff. Optional omissions must be named in the report.
- Never hand-edit an old event row, renumber stable IDs, or auto-approve a risky boundary.
