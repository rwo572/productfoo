---
name: rfc-from-research
description: "Use when validated research should inform a strategy RFC, product RFC, opportunity memo, or sourced proposal."
---

# RFC From Research

## Usage

Turn validated evidence into a reviewable proposal without treating proof as an
automatic product decision.

1. Require at least one productfoo research paper and run `foo research validate
   <paper.md>`. Continue only when it succeeds with exit 0. A signed receipt
   binds the exact paper bytes; editing the paper invalidates that proof.
2. Read the validated paper, packet truth, and approved sanitized evidence.
   Distinguish source claims, repo facts, hypotheses, dissent, and unknowns.
3. Draft: context, problem, evidence, proposal, alternatives, tradeoffs,
   trust/privacy boundaries, rollout, validation, open decisions, and non-goals.
4. Map every load-bearing recommendation to evidence and preserve counterevidence.
5. Ask the human to approve promotion into a packet or decision. Validation and
   sealing never automatically promote research into a requirement.

### Source ledger

- **Sources used** — paper/reference, validation result, approval, and receipt status.
- **Sources omitted** — every optional evidence lane not used and why.
- **Trust status** — validated research, approved sanitized evidence, repo fact, or hypothesis.
- **Limits** — unsupported recommendations and human decisions still open.

Optional omissions appear in the human summary and the RFC artifact. Write the
RFC only to an explicitly requested local destination.

## Error Handling

- If `foo research validate <paper.md>` fails, a required paper is missing, or
  source approval is absent, stop with `status: blocked`, name what did not run,
  give the exact `next action`, and set `exit: nonzero`.
- If an optional source is unavailable, narrow the proposal and list the
  omission; never substitute model knowledge.
- If the evidence does not support a recommendation, write an open decision or
  a no-go alternative instead of forcing an RFC conclusion.
