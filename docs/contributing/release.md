# Prepare a release without publishing

Contributor checks and release approval are separate. Preparing a candidate never
changes repository visibility, creates a release tag, configures a publisher, or
publishes to npm.

## Verify the candidate

Use a clean checkout of the exact intended commit, with the tool versions pinned
in `.github/workflows/release.yml`. Install the contributor test prerequisites in
[CONTRIBUTING](../../.github/CONTRIBUTING.md#development-setup).

```sh
npm ci
npm test
npm run verify:public
node --test .github/scripts/verify-release.test.mjs
bin/foo.mjs self check
bin/foo.mjs commands validate
```

The public source and package inventories live in `config/public-source-files.json`
and `config/public-package-files.json`. A deliberate file addition or removal needs
review before updating them:

```sh
npm run build
npm run generate
# Stage only the intended changes, including new inventory files if applicable.
node scripts/generate-public-manifests.mjs --source-only --write
npm run build:public
node scripts/generate-public-manifests.mjs --write
npm run verify:public
```

Refresh the source inventory before building so additions, removals, and renames
are reflected in the public compilation. Review every inventory diff.
Generated inventories check paths, not whether their contents are safe to publish.
Review content and run the history secret scan separately.

## Record the evidence

After the final product change is committed, run the journey from a fresh local
clone with a fresh home and configuration. Record the commit, Git tree, public
history root, toolchain, check outcomes, skipped checks, and the exact tarball's
SHA-256. Retain the tarball so approval can name the bytes that were tested.

`npm run verify:public` installs its freshly built tarball into an isolated prefix,
checks the CLI and library import, and exercises local reporting and update
classification. It makes npm dependency requests during provisioning; its product
checks are separately isolated. This is not a certificate that all agent/model
behavior is safe.

Use `scripts/smoke-public.mjs` for the additional network-denied skill, spec,
research, and discovery workflows against a supplied package. Its help describes
the supported public-repository interfaces and receipt location.

A preparation record belongs under `.github/release-preparation.json`. It may name
proposed candidate pins, but does not replace `.github/release-candidate.json` or
grant publication approval. Keep the active candidate pending until the final
source and package are explicitly reviewed. Any product-content change invalidates
the proposed pins and requires a new preparation run.

## Separate human decisions

Before publication, a maintainer must approve the exact candidate and handle the
remaining repository and registry controls:

- Review final source/package content and full-history secret-scan results.
- Configure and verify repository, release-environment, and tag protections.
- Keep write access and merging with the maintainer. Allow pull request creation
  from contributors (`pull_request_creation_policy: all`) so fork-based proposals
  match the contribution policy. This setting grants no write access and does
  not change private repository visibility. Reapply and verify it when creating
  a fresh repository; copying source files does not transfer settings.
- Review the exact npm package and trusted-publisher binding.
- Approve visibility separately; verify CodeQL once its workflow can run.
- Update the active candidate pins only from fresh, successful evidence.
- Approve the release commit and tag, then manually dispatch the release workflow.

The release workflow checks repository identity, the approved commit and tag,
source history, clean contents, version fields, and package bytes before it can
publish. Do not weaken these checks or treat green CI as release authorization.
Do not include credentials or raw private context in preparation records.

## Keep current-version documentation aligned with npm

After publication, read the registry's `latest` dist-tag with
`npm view productfoo dist-tags --json --prefer-online`. Update the current-release
labels and npm version links in `README.md` and `docs/getting-started.md`.
Refresh `docs/runtime-support.md` only from verification evidence for that exact
release. Development package versions and unpublished GitHub tags are not proof
that a version is available on npm.

An hourly Codex automation checks this repository for drift and opens or updates
a focused documentation pull request. It may merge documentation-only corrections
after required checks pass and a final registry check confirms the version.
Each run is limited to ten minutes, two registry observations, one pull request,
and one merge. Pending checks carry over to the next run. It reports completed
updates, failed verification, or required human action; unchanged runs stay quiet.

Keep historical changelog entries and dated release/security records accurate to
the events they describe. Do not replace every old version string indiscriminately.
The automation does not publish packages, change runtime code or package versions,
move tags, rewrite release pins, or weaken repository protections. GitHub docs can
change independently of the README bundled in an already-published npm tarball.
