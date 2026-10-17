---
spec_id: public_alpha_cleanup_v1
title: Remove private alpha remnants without reducing the public release
mode: capability
lifecycle: done
stage: building
owner: product
autonomy: human-in-loop
updated: 2026-10-17
---

# Public alpha cleanup

## Intent

Remove private alpha service behavior and misleading installation/support claims while preserving the full public release. The user explicitly approved this cleanup and explicitly rejected broader release cuts.

## Current Understanding

The previous audit found private service seams remaining in the public CLI. The approved change removes those seams without reducing public features.

## Requirements

### R-001 Remove private alpha service coupling

- Priority: P1
- Risk: medium
- Confidence: high

Remove owner-service authentication, hosted skill delivery hooks, automatic hosted telemetry/profile reporting, private operator dispatch, remote bug-report delivery and associated current disclosures. Old environment tokens and stored credentials must not activate outbound requests. Keep bundled skill authenticity and development trust, local diagnostics/report records, local feedback and comprehension signals, and direct provider credentials. Remove unsupported channel help and private entrypoint fallback.

### R-002 Preserve the complete public product

- Priority: P1
- Risk: medium
- Confidence: high

Keep all nine workflows, all research/discovery providers, every agent adapter, packet/proof reconciliation, source approvals, safety and autonomy budgets. No connector extraction, workflow demotion, or feature reduction beyond private alpha remnants. Keep update checks and user-requested direct provider network operations, accurately disclosed.

### R-003 Truthful installation and compatibility

- Priority: P1
- Risk: medium
- Confidence: high

Document source installation as current while npm latest is the staging placeholder. Keep future npm instructions explicitly conditional on a verified release. Test the claimed Node support before narrowing it; document build-tool versus installed-runtime requirements and platform evidence honestly. Add appropriate CI coverage. No publication or visibility/tag/environment/publisher changes.

### R-004 Verifiable distribution

- Priority: P1
- Risk: medium
- Confidence: high

Run full tests, generated drift checks, boundaries, packet checks, clean contributor install/build and exact installed package workflows. Refresh inventories and invalidate earlier release preparation. Leave active release pins unarmed. Land through a named-branch PR and merge after review and required checks, as subsequently authorized by the user.

## Decisions

- D-001 — (accepted) User approved cleanup after the concrete prior assessment; no additional discovery question is needed.
- D-002 — (accepted) Preserve release scope, providers and all nine workflows.
- D-003 — (implementation choice) Test existing runtime claims, then document the supported range from evidence; do not reduce support merely to avoid testing.
- D-004 — (accepted) Nothing is published; release authorization remains separate.
- D-005 — (accepted) The user subsequently authorized merging the cleanup PR after verification.

## Risks

- RISK-001 — Shared provider credentials may be mistaken for alpha credentials; trace imports and test provider login.
- RISK-002 — Ambient legacy tokens may still trigger egress; use synthetic credentials and a network trap.
- RISK-003 — Existing local report files must remain readable/deletable without hosted state.
- RISK-004 — Runtime and contributor toolchain requirements differ; verify each separately.

## Validation

- V-001 — Synthetic alpha configuration cannot cause service requests or block bundled skills.
- V-002 — Local reports remain usable; removed hosted commands fail without network access.
- V-003 — Full suite and installed workflows pass, including direct provider fixtures and all front-door command contracts.
- V-004 — Fresh checkout regenerates without diff, passes public verification and supported runtime smoke.
- V-005 — Release guard still refuses publication with unarmed pins.

## Evidence

- Approved scope: current user instructions; inspection of cli.ts, commands/agent.ts, commands/login.ts, skillLocal.ts and README.md.
- Detailed proof and expert judgment will be recorded in verification.md.

## Open Questions

- No unresolved scope decision. Compatibility evidence is an implementation task.
