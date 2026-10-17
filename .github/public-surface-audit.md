# Public-surface privacy audit

Status: current source and reachable branch history cleaned; GitHub-retained
historical copies still require removal. The owner approved and the agent
performed the metadata rewrite. The repository remains private and unpublished.

## Scope and decision

The owner requested clearance of Git history, issue and PR content, and Actions
logs/artifacts before open-sourcing. Preserve all product capabilities and test
cases. Replace identifiable fixture content with synthetic examples, retain
copyright and third-party attribution, and keep raw audit exports outside Git.

## Findings and action

- Discovery fixtures contained identifiable contact names, profile links and
  organization associations. Replace them consistently with invented identities,
  reserved-domain addresses and clearly marked synthetic profile identifiers.
- Three reconciliation fixtures copied earlier private PR descriptions. Replace
  the descriptions and provenance with minimal synthetic parser inputs.
- Scheduling demonstrations used the maintainer's identity. Replace it with a
  fictional principal while preserving every scenario and privacy boundary.
- Source comments included personal home paths and contact examples. Generalize
  them; update the Reddit User-Agent repository link to productfoo.
- Commit author/committer metadata includes personal email addresses. A new
  commit cannot remove these or earlier fixture contents from existing history.
  Remote history removal requires a separately approved rewrite and cleanup of
  GitHub's retained PR references/cached views.
- Add fixture-privacy guidance to CONTRIBUTING. New cleanup commits use the
  owner's GitHub noreply address.

## Inspected surfaces

At the start of this audit: 27 commits across fetched branch and closed-PR heads,
1,165 unique text blobs (no binary blobs), eight merged PRs, six issues, and
21 Actions runs. No issue comments, review comments, reviews or commit comments;
no uploaded Actions artifacts or GitHub releases. All run log archives were
retrieved; seven skipped CodeQL runs had empty logs. Issue/PR edit history was
also inspected with complete pagination (six stored revisions across three
items). Discussion and wiki surfaces are disabled.

Secret scanning passed for all fetched history, downloaded logs and metadata.
Content review found the fixture/identity disclosures above despite those secret
scan results. The product scanner inspected all 1,165 blobs; its single medium-confidence
credential match is an intentionally synthetic transcript canary in a privacy
test. No secret rotation is indicated by this audit. Issue/PR bodies and
their revisions contain public-safe technical and release discussions; no
removal is needed there. Actions logs contain test/build output, with no matches
for the identified personal identities, addresses, private repository link or
personal workstation paths. Preserve their verification evidence.

## Verification and limits

The full suite passes 1,323 tests with no failures or skips after fixture updates.
Generated-output checks, repository boundaries, example packet validation and
public source/package checks pass. The fresh committed-source rehearsal also passes all 1,323 tests and all
19 installed workflows under network denial, with 652 source paths and 498
package paths. Exact artifact identity is in release-preparation.json.

The first test run exposed two dependent fixture selectors still naming the old
organization; both were updated to preserve the original no-selector test.
The fresh-checkout inventory check initially rejected the new audit record;
its exact path was reviewed and added to the source inventory.
No production logic, workflow, provider, adapter or capability was removed.

Confidence is high for the inspected surfaces and identified patterns. Automated
scanning cannot prove absence of all confidential meaning. Existing clones and
GitHub's retained historical views remain outside a normal cleanup PR's effect.
Do not call this audit fully cleared until those copies are handled or the owner
explicitly accepts their exposure. Recheck remote refs and new activity at that
step. Raw exports, replacement maps and private backups must never be committed.

## Release refresh — October 16, 2026

The owner approved productfoo-only metadata cleanup and release preparation.
A new parentless snapshot preserves all 653 current source paths, including the
merged onboarding/Firecrawl changes. Author and committer metadata use GitHub
noreply addresses. The merged branch retaining personal metadata was removed.

Fresh CI passes 1,325 tests, seven release-guard tests, and all 12 installed
runtime jobs. The exact Linux tarball passes 19 offline workflows on Linux and
macOS; two independent Linux builds produce identical bytes. New-history and
extracted-package Gitleaks scans pass. See release-preparation.json for the
exact source and artifact identities, supported controls, and recorded gaps.

GitHub still retains ten historical PR references, including the later
onboarding change. A prepared support request covers those refs and cached
objects, but no purge completion is claimed. Keep the repository private until
removal is verified. Neither private alpha repository was modified.
