# Public alpha cleanup verification

## Scope and judgment

The user approved private alpha cleanup and explicitly preserved the complete
public release. All nine registered agent entrypoints, the reconciliation CLI,
research/discovery provider adapters, agent adapters, local skill trust, source
approval, redaction and loop budgets remain. Only owner-service authentication,
hosted skill hooks, private operator dispatch, automatic hosted usage/profile
reporting, remote report transport and their obsolete public claims were removed.
Direct Firecrawl credentials and explicitly requested GitHub issue filing remain.
The user separately authorized merging the verified PR; no publication, tag,
visibility change or publisher/environment configuration was authorized.

## Evidence

- The new credential-isolation regression first caught two owner-service ingest
  attempts with synthetic old credentials. It now passes with zero requests,
  while local usage and bounded profile logging remain available.
- Targeted provider/trust/readiness tests cover direct provider credentials,
  legacy token isolation, bundled and development skill integrity, caller-tree
  shadowing refusal, all three conductor families and research capability reports.
- Local reporting retains capture, redaction, review and exact deletion approval.
  Old archived reports remain readable and locally deletable; no local operation
  claims a remote deletion. Attempts to inject removed transport hooks are inert.
- Cross-review caught an inaccurate machine-only assurance on historical
  delivered archives. A plain-text regression failed first, then passed after
  rendering the historical destination and unknown current remote retention.
- Cross-review also caught an unsupported provider-login example and source
  install instructions that left the user in the tooling checkout. Both were
  corrected; setup now explicitly switches to the user's project.
- Full isolated source suite: 1,323 passed, zero failed or skipped. The macOS
  independent signature test uses OpenSSL 3 on PATH, as documented.
- Public verification passes: clean public build, reviewed inventories, generated
  drift checks, installed exports/configuration/update behavior, nine local report
  controls, sixteen legacy-settings API controls and twelve installed report CLI
  controls. Legacy-settings installed checks also run local usage/profile logging
  with a network trap, without relying on DO_NOT_TRACK.
- A fresh clone with isolated HOME passed locked npm ci, all 1,323 tests,
  public build and all 19 installed workflows against its exact tarball with
  network denied. No private repository or inherited credentials were needed.
- Boundary check, command validation, packet validation and reconciliation pass.
  Seven release guard tests pass; active publication pins remain unarmed.
- Installed runtime checks pass on macOS ARM64 with Node 18.0.0, 18.20.8,
  20.20.2, 22.23.3, 24.22.0 and 26.5.0 (17 checks each plus a working network
  denial positive control). The Node 18.0.0 failure of an extensionless packaged
  executable was fixed with bin/foo.mjs; the >=18 runtime promise is preserved.
- Contributor builds remain pinned to Node 26.5.0/npm 11.17.0. CI now verifies
  installed packages on Ubuntu and macOS across the six runtime selections.
  The final exact-artifact and clean-checkout receipt is recorded separately in
  .github/release-preparation.json after this payload is committed and tested.

- A second clean-checkout run exposed intermittent probe fixture startup failure.
  The old test reserved and released a port before the child bound it, and
  discarded child stderr. The fixture now binds PORT=0 itself and announces its
  actual port; the test waits for that announcement and retains diagnostics.
  The new readiness assertion failed against the old :0 announcement and passed
  after the fix. This changes only the example's ephemeral-port diagnostic and
  the contributor test, not public product functionality.

## Limits and remaining human decisions

Provider requests are covered with fixtures, not live customer credentials.
Runtime checks cover deterministic CLI behavior, not complete model-driven work.
No Windows support proof is claimed. Historical remote report retention remains
unknown; this cleanup never connects to or deletes external service storage.
Changing repository visibility and publishing a package remain separate actions.

## Review disposition

Cross-review of implementation found the historical report wording issue above;
its failing-to-passing regression verifies the fix. Review of provider/trust and
conductor changes found no actionable issues. Launcher/runtime/CI review found
only the two documentation corrections above. No findings are silently deferred.
