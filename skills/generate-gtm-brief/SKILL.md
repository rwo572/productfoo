---
name: generate-gtm-brief
description: "Use when an approved product change needs a launch brief, audience and messaging plan, rollout assumptions, or go-to-market decision record."
---

# Generate GTM Brief

## Usage

Draft a launch brief from approved product truth without polishing missing facts
into certainty.

1. Read the approved packet, product behavior, release proof, and approved
   sanitized customer evidence supplied for this launch.
2. Extract audience, problem, product change, differentiation, rollout, success
   measure, owners, dates, legal/privacy needs, and open decisions.
3. Mark missing facts as `unknown`, `TBD`, or `hypothesis`; never infer an owner,
   launch date, customer quote, metric, or claim merely to complete the template.
4. Produce: launch summary, audience, evidence-backed messages, claims table,
   rollout stages, success measures, risks, decisions, and next actions.
5. Return the brief in chat by default. Write to a local destination only after
   the user explicitly names it; never publish or sync it.

### Source ledger

- **Sources used** — packet/repo/evidence reference, approval, and receipt status.
- **Sources omitted** — every optional customer, market, legal, or analytics lane not used.
- **Trust status** — fact, validated research, approved sanitized evidence, or hypothesis.
- **Limits** — unresolved launch decisions and claims that cannot ship yet.

Every omission appears in the human summary and the brief artifact.

## Error Handling

- If the product change or required launch decision has no approved source, stop:
  `status: blocked`, `did_not_run: GTM brief`, `missing: <fact or approval>`,
  `next action: <exact source/approval step>`, `exit: nonzero`.
- If an optional lane is unavailable, keep the section explicitly `unknown` and
  list it under **Sources omitted**; do not silently delete the section.
- If the request asks to send, publish, or update an external system, return the
  completed local draft plus a precise human handoff; do not perform the write.
