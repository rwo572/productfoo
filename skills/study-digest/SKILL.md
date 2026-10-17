---
name: study-digest
description: "Use when approved sanitized study evidence needs a traceable synthesis, theme map, hypothesis update, or decision handoff."
---

# Study Digest

## Usage

Synthesize a study from approved sanitized evidence. Never ingest, quote, or
commit raw transcripts, recordings, private messages, or participant PII.

1. Anchor the digest to the research brief's decision, questions, and hypotheses.
2. Accept only approved sanitized discovery evidence, validated research papers,
   or explicitly approved packet evidence. Source access alone is not approval.
3. Cluster independent evidence into themes; separate observed behavior, stated
   preference, interpretation, dissent, and unknowns.
4. Use a verbatim quote only when the exact approved sanitized evidence contains
   it. Never invent or reconstruct a quote from a summary or raw-content memory.
5. Update each hypothesis as supported, refuted, mixed, or open. Present
   implications and decisions for a person; do not auto-create requirements.

### Source ledger

- **Sources used** — approved evidence reference, study/session scope, and trust label.
- **Sources omitted** — every optional session or evidence lane not used and why.
- **Trust status** — approved quote, sanitized observation, validated research, or inference.
- **Limits** — sample coverage, dissent, and decisions not established by evidence.

Every optional omission appears in the human summary and digest artifact. Return
in chat by default; write only to an explicitly requested local destination.

## Error Handling

- If the study has no approved sanitized evidence, or a required approval or
  brief is missing, return `status: blocked`, name what did not run, provide the
  exact `next action`, and set `exit: nonzero`.
- If an optional source is unavailable, continue only when the remaining
  evidence supports an honest synthesis and list the omission.
- If only raw material is offered, route it through the proof-gated discovery
  flow; do not open or summarize the raw content here.
