---
name: check-spec-health
description: "Use when a portfolio of specs needs structural, freshness, evidence-coverage, or decision-readiness assessment."
---

# Check Spec Health

## Usage

Audit one or more productfoo packets without turning missing evidence into a false healthy
score. Start from local packet files, then add only approved evidence.

1. Inventory `spec.md`, `tasks.yaml`, and `events.jsonl`; run `foo asp validate
   <packet-dir>` for each packet.
2. Assess structure, requirement-test mapping, unresolved decisions, stale tasks,
   and proof coverage separately.
3. For claims about current customers, markets, competitors, or releases, require
   approved sanitized evidence or a research paper for which `foo research
   validate <paper.md>` succeeds. Connector access alone is not approval.
4. If external evidence was requested but is absent, state `external evidence:
   not assessed`; never roll that gap into an overall “healthy” verdict.
5. Return a ranked repair list. Write a local report only when the user explicitly
   supplies the destination.

### Source ledger

Every report includes:

- **Sources used** — source class, path or stable reference, approval, and receipt status.
- **Sources omitted** — every optional source not used and why.
- **Trust status** — repo fact, approved sanitized evidence, validated research, or hypothesis.
- **Limits** — what the audit could not assess and what still needs human judgment.

Optional-source degradation succeeds only when the omitted source appears in both
the human summary and the report artifact.

## Error Handling

- If a required packet, source approval, or signed receipt is missing, stop with a
  visible handoff: `status: blocked`, `did_not_run: <assessment>`, `missing:
  <input>`, `next action: <exact foo command or approval>`, and `exit: nonzero`.
- If only an optional source is unavailable, continue with a narrower score and
  list the omission; do not silently substitute model knowledge.
- A malformed packet is a finding, not permission to rewrite it. Propose the
  repair and leave product-meaning changes to a person.
