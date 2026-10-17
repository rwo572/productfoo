---
name: research-brief
description: "Use when a product question needs a scoped research plan, study brief, hypotheses, participant criteria, or evidence plan before research begins."
---

# Research Brief

## Usage

Create a decision-oriented research plan from explicit intent and approved
context. Do not inspect a private source merely because a connector can see it.

1. Frame the decision, target segment, known evidence, deadline, and what would
   change as a result of the study.
2. Use repo facts and approved sanitized material already in context. Do not
   open, read, or inspect any new local or private material. For connector data,
   require `foo source discover` plus packet-scoped `foo source approve` before
   reading; connector access is not approval.
3. Write research questions and falsifiable hypotheses, then choose the smallest
   method and participant set that can answer them.
4. Specify recruitment, consent, privacy, analysis, evidence labels, decision
   owner, and stop conditions. Raw transcripts and PII stay out of Git.
5. Present a short proposal for human confirmation before the full brief. Return
   in chat by default; write only to an explicitly approved local destination.

### Brief shape

Decision · background · hypotheses · questions · method · participants · source
plan · consent/privacy · analysis · risks · timeline · decisions needed.

### Source ledger

- **Sources used** — source class, approval scope, and stable reference.
- **Sources omitted** — every optional prior-study, customer, or analytics lane not used.
- **Trust status** — repo fact, approved sanitized evidence, or hypothesis.
- **Limits** — evidence gaps and decisions that remain with a person.

Optional omissions are named in both the human summary and the brief artifact.

## Error Handling

- If the decision, required private-source approval, consent, or access is
  missing, do not inspect the private source. Return `status: blocked`, name
  what did not run, give the exact `next action`, and set `exit: nonzero`.
- If an optional source is unavailable, continue only when the remaining plan
  is still valid and list it under **Sources omitted**.
- If the requested study would collect unnecessary sensitive data, propose a
  lower-data method and require human approval before proceeding.
