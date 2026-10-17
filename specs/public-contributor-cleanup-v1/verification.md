# Verification and judgment record

Historical record: the PostgreSQL/SDR references and test/package counts below
describe the earlier cleanup candidate. The owner subsequently requested removal;
see [the removal packet](../remove-sdr-v1/spec.md) and current release preparation
for the replacement payload and verification.

The owner approved cleanup of audit items 1–11 and preparation of item 12. This
packet does not authorize publication, repository visibility changes, tagging,
publisher setup, or merging. The active release candidate remains unarmed.

## Audit punch-list closure

| Item | Resolution |
|---|---|
| 1 | Public verification uses checked-in source/package inventories, with no private exporter prerequisite. |
| 2 | Persona and trust-anchor generators are shipped; generated verification replaces obsolete adapter checks. |
| 3 | Cheatsheet removes enforcement bypasses and blanket safety claims. |
| 4 | All nine Anthropic launchers derive from the canonical command contract. |
| 5 | Quickstart task syntax executes in a test; Codex refresh uses explicit global setup. |
| 6 | Examples index accounts for all nine directories and preserves test fixtures. |
| 7 | Contributor, skill and command links resolve within the public tree. |
| 8 | Product/design guidance describes current scope and delegates interview limits to the run contract. |
| 9 | Historical token/server protocols are labeled compatibility material; normal setup remains local. |
| 10 | CI/toolchain, PostgreSQL dependency and fictional CalPal provenance claims are corrected. |
| 11 | Documentation/generation regressions run in CI; printable HTML is generated from Markdown. |
| 12 | Separate release preparation records exact evidence; publication gates remain unarmed. |

## Scope and proof

- Public source/package inventories replace absent private manifests. Negative
  tests reject local paths, unreviewed package files, and inventory drift.
- Canonical command contracts generate all nine Anthropic launchers. Generator
  checks cover persona skills, the bundled trust anchor, CLI reference, notices,
  and the printable cheatsheet.
- Quickstart tests execute the documented task command against a fresh packet.
  Adapter setup is checked in a fresh home with dry-run and explicit scope.
- All nine example roots are indexed; synthetic experiments are labeled and
  fixtures retained. The egress analyzer rejects empty/malformed evidence and
  emits only synthetic canary matches, without echoing raw source values.
- Documentation checks cover docs, examples, commands, skills, plugin launchers,
  and contributor contracts, including local anchors and maintenance scripts.
- The public rehearsal runner uses the requested local Git revision and exact
  supplied tarball. It checks workflow receipts and audits network-denied runs.

The final source revision, retained package hash, toolchain and fresh-checkout
results are recorded separately in `.github/release-preparation.json`, after the
payload is committed. That record is evidence, never release authorization.

## Check results before payload freeze

- Full suite: 1,533 tests, 1,532 passed, zero failures. The one skipped real
  PostgreSQL integration test requires an explicitly supplied test database.
- Public verification: all generated checks, 723 source paths, 547 package paths,
  isolated tarball install/import and reporting/update controls passed.
- The four actual example packets validate; example container directories are
  not packets and their missing-spec signals were resolved by selecting the nested
  packet paths.
- Independent code review found two contributor defects: stale public-build order
  in inventory instructions and missing output-directory creation in the persona
  generator. Both were fixed; generation from absent output directories passed.
- The exact-artifact rehearsal passed all 19 installed workflows. Its synthetic
  research fixture now uses valid claim labels and a topic matching the signed run.
  Doctor runs with npm offline and update-notifier disabled; the independent
  network denial positive control fires and the subsequent attempt log is empty.
- Seven release guard tests passed. `foo self check` found no boundary violations;
  the inherited initial commit lacks a spec trailer, an advisory history signal.
- `foo commands validate` passed. Reconciliation initially surfaced the regenerated
  skill trust anchor; it is now mapped to the agreed maintenance task.

## Design and messaging review

The printable cheatsheet was reviewed using Impeccable, principal-designer and
product-marketing lenses. The required dedicated design/marketing swarm modules
are absent from the public repository; this is a recorded manual-review gap.
Reviewer A had worked on Markdown guidance, so its source review was not blind.
Reviewer B independently ran the detector and checked static accessibility.

No confirmed P0–P2 design findings remained. The detector's em-dash warning was a
false positive caused by CLI double-hyphen flags. The actionable P3 finding was
fixed by printing the package version and canonical reference URL. Body contrast
is 16.10:1 and link contrast 8.47:1 on white.

A real installed Chromium browser checked the final page offline at 1440×1000
and 390×844: no page overflow, no console/page errors, named links, one main
landmark, ordered headings and visible 3px keyboard focus. Long command blocks
scroll within their containers. The mobile screenshot was inspected. Initial
sandbox browser failures were environmental; the bounded local retry succeeded.
Print CSS was inspected; physical paper output was not tested.

## Remaining human judgment

These checks establish the documented contributor and local package journeys,
not universal correctness of model-generated work. Review the final diff and
package before approving a release. Do not publish from this preparation record.
