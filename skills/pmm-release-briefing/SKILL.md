---
name: pmm-release-briefing
description: "Use when a release needs a PMM briefing outline but external delivery, scheduling, or publishing would be required."
---

# PMM Release Briefing

## Usage

This draft keeps its egress boundary. It may prepare an in-chat or local outline
from explicit intent, repo facts, and approved sanitized evidence; it must not
schedule, publish, post, send, or update an external destination.

1. Confirm the release, audience, cadence, and intended recipient.
2. Use only material already supplied in chat, repo facts, or approved sanitized evidence.
3. Draft a concise briefing: changes, customer impact, evidence, risks, unknowns,
   owners, and proposed next actions.
4. Label **Sources used**, **Sources omitted**, **Trust status**, and **Limits**.
5. Hand the draft and destination to a person for review and delivery.

## Error Handling

- For any delivery or schedule request, stop with `status: blocked`,
  `did_not_run: external delivery`, `missing: egress approval and implementation`,
  `next action: review the in-chat draft and deliver it manually`, `exit: nonzero`.
- If approved evidence is missing, leave the claim unknown; do not inspect a
  connector or silently infer it.
