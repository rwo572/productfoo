# Runtime and contributor support

The installed CLI supports Node.js 18 or newer. Building and testing this
repository uses the separate contributor toolchain: **Node.js 26.5.0 and npm
11.17.0**. Build with those tools before installing a local tarball under an older
supported runtime. The package's `engines` field describes the installed CLI,
not every build-tool dependency.

See [Getting started](getting-started.md#install-productfoo) to install the
release tagged `latest` on npm with `npm install -g productfoo`.

## What compatibility checks cover

`scripts/test-installed-runtime.mjs` exercises an installed package under the
Node binary that invokes it. It uses a fresh home and synthetic project, denies
network access, and checks version/help, all nine command registrations, bundled
skills, project orientation, spec creation/validation, research/discovery/ideation/
pitch/roast/preview planning, adapter preview, local report add/show/delete, and
the package library import.

These are deterministic CLI checks. They do not run a coding agent, execute an
external provider, validate every workflow, or certify all model behavior.
Update checks are explicitly disabled for the offline compatibility run; normal
`foo doctor` and update commands may query the public npm registry. Requested
provider operations use their configured destinations and credentials.

[CI](../.github/workflows/ci.yml) schedules installed-package checks on Ubuntu and
macOS for Node 18.0.0, the latest patches of 18/20/22/24, and 26.5.0. Each job
builds with Node 26.5.0/npm 11.17.0, then installs and runs the resulting tarball
using its target runtime. A configured matrix is not evidence that a particular
CI run passed; inspect that run's logs for exact versions and architecture.

## Verified current release

The published npm release is
[`productfoo@1.0.1`](https://www.npmjs.com/package/productfoo/v/1.0.1).
On October 17, 2026, its [release-candidate CI run](https://github.com/rwo572/productfoo/actions/runs/39062257427)
passed the installed-package matrix on Ubuntu and macOS with Node 18.0.0,
18.x, 20.x, 22.x, 24.x, and 26.5.0. Each job installed the package with the
target runtime's npm and exercised it with network access denied.

After publication, the downloaded registry tarball matched the approved SHA-256,
npm verified its registry signatures and provenance, and all 19 installed
workflows passed with network access denied. The
[release verification record](../.github/release-verification.json) contains the
exact artifact digest, release commit, workflow link, and results. Runtime files
are byte-identical to the previous release; only the README, changelog, and
package version changed in the npm tarball.

These results do not establish native Windows, WSL, macOS x64, or Linux ARM64
compatibility. See the linked run for the precise runner architectures and
resolved Node versions. A later release needs its own verification evidence.

## Contributor test tools

The full source suite needs Git, Python 3, and either Python's `cryptography`
package or OpenSSL 3 on `PATH` for the independent signed-envelope verifier.
On macOS, system LibreSSL is insufficient; select OpenSSL 3 on `PATH` or provide
`cryptography` to the Python interpreter running the fixture. The fixture runs
as a plain Python subprocess; pytest is not required.

These are contributor test tools. The installed CLI requires neither Python
nor OpenSSL. See [development setup](../.github/CONTRIBUTING.md#development-setup)
and [verification](contributing/verification.md) before running the suite.

## Local storage

The core CLI needs no database server. Specs, task state, research artifacts and
local reports are files. Connected tools may have separate storage and service
requirements; configure those explicitly for the workflow that uses them.
