# SDR removal verification

## Judgment

The source dependency trace found only one production entry into SDR: its CLI
route. Shared product modules do not import its engine, store or adapters. The
only production pg import lived in the removed store. The removal preserves
core source/research approvals, loop budgeting, redaction and reporting code.

The intentional compatibility change is removal of `foo sdr`. Existing external
databases are untouched. No migration, connection, data deletion or history
rewrite was performed. Prior cleanup evidence remains historical; the current
preparation record is invalidated until the replacement payload passes.

## Plan and evidence

- The CLI regression first failed because the old route demanded DATABASE_URL.
  After removal, the same test passed both with and without a synthetic URL;
  it reports an unknown domain and leaves no project state.
- Generic pricing/model/routing configuration tests remain and pass. Only the
  removed policy's assertions and exclusively SDR tests/fixtures were deleted.
- Installed-package verification now rejects SDR artifacts, checks that pg
  cannot resolve, and verifies that the retired command no longer dispatches.
  Core import/configuration, reporting and update checks remain intact.
- Full remaining suite: 1,319 passed, zero failures, zero skips. Removed coverage
  belongs to SDR: 17 test/helper modules and 46 fixtures. The only other test
  edits remove SDR assertions from the shared configuration test and add the
  unsupported-command regression.
- Public verification: 167 source modules, 644 reviewed Git paths, 507 package
  paths; generated checks, installed core exports/configuration, reporting and
  update controls pass. Installed pg resolution fails as required.
- Exact-artifact rehearsal: all 19 core workflows pass under the network guard.
  This includes spec creation/validation, research planning/sealing/validation,
  approved-source discovery, skills, redaction, swarm checks and library import.
- Boundary checks, command validation and packet reconciliation pass with no
  unmapped changes. Only 19 production modules were removed; the remaining
  production change is removal of SDR entries and dispatch in src/cli.ts.
- Final committed payload and exact package evidence are recorded in
  `.github/release-preparation.json` after a fresh checkout repeats the journey.

## Remaining judgment

The removed sales command intentionally stops working. Core compatibility is
established for the tested commands/platforms; this does not prove all future
model-generated work. Publication remains a separate human decision.

## Independent review

A fresh read-only reviewer found no actionable issues. It confirmed that retained
core modules/exports are unchanged, deleted tests exclusively cover SDR, shared
safety/configuration coverage remains, pg is absent from the lockfile, and neither
build output nor package inventory contains the subsystem. The reviewer did not
rerun tests; the implementation run and fresh checkout supply execution evidence.

The review set aside the pending frozen-candidate run and temporary invalidated
preparation record; both are resolved by the final preparation step. External
databases are deliberately untouched. Generic database-secret redaction tests
and unrelated examples remain because they are not the removed subsystem.
