---
name: gong-quotes
description: "Use when approved customer-call evidence needs traceable quotations, paraphrases, themes, or quote-gap analysis."
---

# Gong Quotes

## Usage

The name is retained for compatibility; the workflow is provider-neutral. Work
only from approved sanitized evidence. Do not open, paste, commit, or reproduce a
raw transcript.

1. Confirm the topic, study or packet scope, and whether exact quotations are required.
2. Use `foo discovery` to match and apply an approved call through the in-memory
   proof gate when raw call access is needed. Consume only the resulting approved
   sanitized evidence envelope.
3. Reproduce a verbatim quote only when those exact words are already present in
   approved sanitized evidence. Otherwise write a labeled paraphrase; never
   reconstruct or invent wording.
4. Group quotes by theme, retain the stable evidence reference and date, show
   dissent, and avoid participant PII.
5. Return the quote set in chat or an explicitly requested local artifact; never
   update a CRM, call system, or message destination.

### Source ledger

- **Sources used** — approved sanitized evidence references and quote eligibility.
- **Sources omitted** — calls or evidence lanes not approved, unavailable, or out of scope.
- **Trust status** — exact approved quote, labeled paraphrase, or unsupported gap.
- **Limits** — coverage, representativeness, and wording that could not be quoted.

Optional omissions are named in both the human summary and the artifact.

## Error Handling

- If a required call lacks source approval, provider access, or an approved
  sanitized envelope, stop with `status: blocked`, name what did not run, give
  the exact `next action` from `foo discovery`, and set `exit: nonzero`.
- If an optional call is omitted, continue only when the remaining evidence can
  support an honest result and list the omission.
- If asked for a quote that does not exist in approved evidence, return a quote
  gap. Do not use a generic quote or model-generated substitute.
