---
name: initiative-tracker
description: "Use when product initiatives need a status-digest outline but recurring collection or delivery would be required."
---

# Product Initiative Tracker

## Usage

**Product Initiative Tracker** is a draft that keeps its egress boundary.

It may organize explicit intent, repo facts, and approved sanitized evidence into
an in-chat or local outline: initiative, outcome, owner, state, proof, risk,
decision, and next action. It must not collect connected signals, schedule a run,
send an update, or mutate a tracker. Include **Sources used**, **Sources omitted**,
**Trust status**, and **Limits**.

## Error Handling

- For recurring collection or delivery, return `status: blocked`, name what did
  not run, identify the egress boundary, give `next action: review the local
  outline and update the destination manually`, and set `exit: nonzero`.
- Do not turn missing status into “on track” or infer an owner from history.
