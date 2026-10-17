---
swarm_id: swarm-2026-10-17
target: "Approved intake: remove private alpha remnants and fix installation/compatibility promises without publishing. Preserve all nine workflows, every public research/discovery provider and agent adapter. Remove owner service authentication/telemetry/hosted delivery only; keep local diagnostics and provider credentials. Verify core suite, public artifact and supported runtime claims. User explicitly rejects broader release cuts."
depth: fast
decider: human            # expert answers carry forward unless the user disagrees
minority_report: "Removing dormant private compatibility hooks changes private consumers, intentionally outside the public contract."
not_doing: []
what_would_change_our_mind: ""
handoff: "foo skill spec-cleanup"
---

# Preflight routing table

| Candidate question | Asking role | Experts consulted | Expert answer | Evidence / reason | Ask user? |
| --- | --- | --- | --- | --- | --- |

# Swarm report

# Judgment ledger

| Judgment | Owner lens | Type | Evidence | Confidence | Dissent | User? |
| --- | --- | --- | --- | --- | --- | --- |

# Decision

## Highest-leverage question

Should this become a smaller release? Answered by the user: no. Only the specified cleanup is approved.

## Expert answers to override

| Candidate question | Asking role | Experts consulted | Expert answer | Evidence / reason | Ask user? |
| --- | --- | --- | --- | --- | --- |
| Remove providers or demote workflows? | cpo | business-gm-pm | No | Explicit user correction | No |
| Remove all network support? | technical-architect | security-privacy-legal | No; remove owner alpha only | Direct providers remain product scope | No |
| Can old tokens activate telemetry? | security-privacy-legal | technical-architect | Must not after cleanup | cli autoReportUsage currently reads token | No |
| Drop minimum Node support untested? | applied-ai-eval | developer-experience | Test first | engines >=18 vs CI 26.5 | No |
| Advertise staged npm artifact as release? | business-gm-pm | developer-experience | Source-first pending release | Registry latest 0.0.0-stage | No |
| Remove local reporting with remote delivery? | developer-experience | security-privacy-legal | Keep local inspection/deletion | Public local diagnostic contract | No |

## Deferred questions

No user-only implementation question remains. Publication is outside this task.

## Judgment ledger

- approved-context: preserve full release and no publishing; confidence high; owner product.
- repo-evidence: private hooks remain in CLI, skills, report and telemetry; confidence high.
- agent-inference: delete private-only hooks rather than retain dead adapters; confidence high; dissent: private downstream callers must adapt.
- role-expertise: test runtime compatibility before changing engine promises; confidence high; dissent: coverage is finite.

## Spec changes implied

R-001 through R-004 explicitly bound removals, preserved scope and verification.

## Finalization gate

Applied spec-cleanup: requirements have IDs, tasks map all requirements, no new outbound or publication authority, legacy state and ambient credentials included in validation.

## Do-not-expand-yet

No provider extraction, workflow removal, agent adapter reduction or platform cut without evidence.
