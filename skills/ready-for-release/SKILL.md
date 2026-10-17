---
name: ready-for-release
description: "Use when a product change needs an evidence-backed Build, Beta, GA, or release-note readiness decision."
---

# Ready For Release

## Usage

Issue a readiness result only from inspected proof. A retrieval failure is a
blocked assessment, never a readiness verdict.

1. Confirm the release stage and approved packet or local release source.
2. Inspect requirement proof, tests, rollout and rollback plan, owner decisions,
   customer impact, documentation, privacy/legal status, and unresolved risks.
3. Use approved sanitized evidence or validated research when a readiness claim
   depends on customers or the market. Connector access alone is not approval.
4. Return exactly one result: `READY`, `NOT READY`, or `BLOCKED`. `READY` requires
   every stage-critical check to have proof; unknown is not pass.
5. List blocking checks, dissent, owners, and exact next actions. Draft release
   notes locally only when explicitly requested; do not send them.

### Source ledger

- **Sources used** — proof/reference, approval, retrieval outcome, and receipt status.
- **Sources omitted** — every optional release-information lane not used and why.
- **Trust status** — verified proof, approved evidence, owner decision, or unknown.
- **Limits** — checks not assessable and human sign-offs still required.

Optional omissions appear in both the human result and any release artifact.

## Error Handling

- On a required retrieval failure, issue no readiness verdict. Return `status:
  blocked`, `did_not_run: release readiness`, `missing: <source>`, `next action:
  <exact recovery step>`, and `exit: nonzero`.
- If an optional source fails, list it under **Sources omitted** and lower the
  scope or confidence; never replace it with general knowledge.
- If proof conflicts, return `NOT READY` or `BLOCKED` with the conflict visible.
