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

The October 16, 2026 local cleanup check passed all 17 checks above against one
installed `productfoo@1.0.0` candidate on **macOS ARM64**, using Node **18.0.0,
18.20.8, 20.20.2, 22.23.3, 24.22.0, and 26.5.0**. The test runner also proved its
network-denial control fired before running the workflows. Provisioning used
Node 26.5.0/npm 11.17.0; installing with each older runtime's npm is scheduled
in CI and was not part of that local run.

Native Windows, WSL, macOS x64, and Linux ARM64 have not been rerun for this
cleanup. Historical checks of earlier packages are not evidence for this
candidate. The final release must rerun compatibility against its exact package;
preparing or testing a local package does not publish it.

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
