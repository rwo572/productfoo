---
spec_id: remove_sdr_v1
title: Remove SDR from productfoo
mode: capability
lifecycle: done
stage: building
owner: product
autonomy: human-in-loop
updated: 2026-10-16
---

# Remove SDR from productfoo

## Intent

Remove the sales-development subsystem and its PostgreSQL dependency from the
public product. Preserve productfoo's product-management workflows and verify
the exact replacement package before refreshing release preparation.

## Current Understanding

The owner requested complete removal after confirming SDR is outside the core
product scope. Core source reaches SDR only through the CLI route; the only
production pg import is inside the SDR store. This is a continuation of the
public cleanup PR, with no merge, publication, tagging or visibility change.

## Requirements

### R-001 Complete subsystem removal

- Priority: P1
- Risk: medium
- Confidence: high

Remove the SDR engine, CLI route/help/launcher, policy data, simulation adapters,
exclusive tests and fixtures, and pg/@types/pg dependencies. The removed command
must report an unknown domain even when DATABASE_URL is present. Do not connect
to, migrate, or delete any existing external database. Keep history recoverable.

### R-002 Preserve the core product

- Priority: P1
- Risk: medium
- Confidence: high

Keep core spec, research, discovery, skills, report, adapter, loop budget and
safety behavior. Preserve non-SDR tests, supported package exports, generic
configuration override behavior, and synthetic examples unrelated to SDR.
Verify the complete remaining suite and actual installed workflows without pg.

### R-003 Current documentation and distribution

- Priority: P1
- Risk: low
- Confidence: high

Remove current SDR/PostgreSQL setup guidance and regenerate CLI references,
notices and reviewed source/package inventories. Retain prior audit evidence
with an explicit superseded note. Refresh source/package preparation after a
fresh checkout verifies the new payload. Keep active publication pins unarmed.

## Decisions

- D-001 — (accepted, 2026-10-16) Remove the subsystem entirely from current public source and package; Git history remains intact.
- D-002 — (accepted, 2026-10-16) Removal intentionally withdraws foo sdr; core product functionality must remain verified.
- D-003 — (implementation choice) Extend the existing open cleanup PR and keep the existing branch/worktree.

## Risks

- RISK-001 — Shared code or tests could be removed accidentally. Trace all imports and keep generic configuration tests.
- RISK-002 — Stale emitted files could survive local builds. Clean build output and verify a fresh checkout and exact installed package.
- RISK-003 — Old preparation evidence could be mistaken for the new candidate. Invalidate it during edits and refresh only after verification.

## Validation

- V-001 — Removed CLI route fails with E_UNKNOWN_DOMAIN even with a configured database URL.
- V-002 — Full remaining npm test suite passes without a database skip.
- V-003 — npm run verify:public passes; installed package has no pg driver or SDR artifacts and still loads core configuration and exports.
- V-004 — Nineteen installed workflows pass under the network guard; release guard remains unarmed.

## Evidence

- Dependency trace: src/cli.ts is the only non-SDR product consumer; config layout tests and installed-package checks also referenced the removed policy.
- Completion proof and judgment are recorded in verification.md.

## Open Questions

- No unresolved implementation decision. Publication remains a separate human action.
