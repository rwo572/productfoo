---
name: voc-researcher
description: "Use when approved customer evidence needs voice-of-customer synthesis, pain analysis, workaround mapping, or evidence-backed product triage."
---

# Voice Of Customer Researcher

## Usage

Produce a traceable VoC brief from approved evidence, not a connector inventory
or a model's idea of what customers probably think.

1. Confirm the product question, segment, time window, and decision the evidence
   may inform.
2. Inventory source classes before reading: approved sanitized discovery
   evidence, validated research, packet evidence, product analytics, and support
   signals. Connector access is not source approval.
3. Record each class as `used`, `omitted`, `blocked`, or `not applicable`.
   Approved derived evidence is allowed; raw transcripts, private messages, PII,
   and unapproved connector content are not.
4. Synthesize pains, jobs, triggers, workarounds, frequency evidence, segment
   differences, dissent, and gaps. Do not manufacture counts or quotes.
5. Recommend only when at least one approved evidence lane supports the claim and
   the coverage limits are visible. Zero approved evidence means no recommendation.

### Source ledger

- **Sources used** — source class, scope, approval, date, and stable reference.
- **Sources omitted** — every optional source class not used and why.
- **Trust status** — approved sanitized evidence, validated research, metric, or inference.
- **Limits** — coverage, representativeness, missing lanes, and human judgment.

Every optional omission appears in both the human summary and the VoC artifact.
Write locally only when the user supplies a destination; never update a tracker
or send the brief.

## Error Handling

- With zero approved evidence, return `status: blocked`, `did_not_run: VoC
  recommendation`, `missing: approved evidence`, the exact `next action`, and
  `exit: nonzero`. Do not recommend “park” or any other product decision.
- If a required source approval, receipt, or access grant is missing, name it and
  stop; never silently fall back to another lane.
- If only optional sources are unavailable, proceed only with adequate remaining
  evidence and list all omissions in the summary and artifact.
