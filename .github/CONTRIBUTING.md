# Maintenance and contribution policy

Contributions are welcome. Please open an issue before starting substantial work
so we can agree on direction. Keep pull requests focused and include relevant
tests or verification.

Rachel Wolan ([@rwo572](https://github.com/rwo572)) maintains productfoo, reviews
contributions, and makes the final decision on scope and merging. Contribute
through a fork and pull request; repository write access and merging remain with
the maintainer. Submitting a contribution does not guarantee acceptance.

Maintenance and support are best effort, with no guaranteed response or roadmap.

The source is shared under Apache-2.0. This contribution policy does not restrict
the rights granted by that license to use, modify, or distribute your own copy.

The development instructions below support contributors, maintainer work, and
independent local builds. See the [repository structure](../docs/contributing/repository-structure.md)
and [verification](../docs/contributing/verification.md) guides for deeper context.

## Maintenance expectations

Maintenance, support, compatibility updates, and security fixes are best effort.
There is no guaranteed response time or release schedule. Reports do not create a
commitment to implement a change or accept a contribution.

## Code of Conduct

Everyone participating in this project — issues, pull requests, discussions —
is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security issues

Do **not** open a public issue for a security vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 26.5.0, npm 11.17.0, and Git for the contributor build and tests.
The separately built, installed CLI supports Node.js 18 or newer. The full test
suite also uses Python 3 for the independent signed-envelope vectors, with either Python's `cryptography`
package or OpenSSL 3 on `PATH`. On macOS, the system LibreSSL does not support
that verifier; select an OpenSSL 3 executable on `PATH`. These are test tools;
the installed CLI does not require Python or OpenSSL.

These contributor versions match CI and release tooling. See
[runtime and contributor support](../docs/runtime-support.md) for tested combinations.

```bash
git clone https://github.com/rwo572/productfoo.git
cd productfoo
npm ci
npm run build
npm test
```

`npm test` compiles the project and runs the full suite with Node's built-in
test runner. For faster iteration, run a single compiled test file directly:

```bash
npm run build && env NODE_ENV=test node --test dist/test/someTest.js
```

productfoo is designed to run locally with no account, token, or hosted endpoint.
Please keep it that way: code you add should work offline and should not
require credentials.

## Repository layout

The short version:

- `src/` — canonical source; behavior lives here.
- `skills/`, `commands/`, `schemas/` — bundled product content; persona skills are
  generated from the canonical template and data.
- `docs/` — documentation.
- `examples/` — worked examples.
- `bin/foo` — the development entrypoint; examples and docs use it to run the
  checked-out build explicitly.

See [repository structure](../docs/contributing/repository-structure.md) for the
canonical-source and generated-output boundaries, including which paths are
verified build output rather than maintained in parallel.

## Pull requests

Open an issue before substantial work to agree on direction. Work in your own
fork and submit a focused pull request describing the problem, the change, and
how you verified it. Rachel reviews proposed changes before deciding whether to
merge them; contributors do not need write access to this repository.

- Review credits whenever a change adds, adapts, replaces, or removes outside
  work. Follow [Attribution maintenance](../AGENTS.md#attribution-maintenance),
  update affected acknowledgments and source notices in the same pull request,
  and note the review in the PR description.
- Keep the change focused. If you find an unrelated problem, open a separate
  issue instead of expanding the diff.
- Follow the existing TypeScript style. YAML is bundled at build time. Core
  workflows require no database server; see
  [runtime and contributor support](../docs/runtime-support.md).
- Run `npm test` before pushing. CI runs the full suite plus packaging,
  documentation, and security checks.
- Use [conventional commit](https://www.conventionalcommits.org/) prefixes
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) in commit messages.
- Shape product work with `bin/foo spec <work>` and reference the resulting
  agreement. Risky work follows the approval boundaries in `AGENTS.md`;
  `bin/foo spec start` provides the fuller workflow. See the [productfoo Spec guide](../docs/foo-spec.md).

## Documentation

Documentation lives in `docs/`. The README is also rendered on npm, so installation
guidance must distinguish verified source builds from registry placeholders and
future published releases. Generated files must stay in sync with their canonical
inputs:

- `npm run check:generated` checks drift across skills, command launchers, CLI
  reference, third-party notices, and the printable cheatsheet.
- `npm run generate` regenerates reviewed outputs. Inspect the diff, rebuild,
  and rerun tests afterward.
- `npm run verify:public` checks the public source/package boundary and smokes
  an installed tarball without private tooling or credentials.

See [verification](../docs/contributing/verification.md) for the complete workflow.

## Fixture privacy

Use invented identities and observations in tests and examples. Prefer reserved
`.example`, `.test`, or `.invalid` domains. When a provider-specific host is part
of the behavior under test, use an unmistakably synthetic identifier and a mock
transport. Do not copy customer transcripts, contact cards, private PR bodies, or
local account paths into fixtures. Preserve copyright and dependency attribution.
For public-release preparation, use your GitHub-provided noreply address for
author, committer, and Co-authored-by metadata. Inspect the final merge commit
as well as branch commits: GitHub merge defaults can reintroduce a personal
address even when the source files are clean. Never merge pre-cleanup history
back into this repository; start from a fresh clone of the current main branch.

## License

The project is distributed under the [Apache License 2.0](../LICENSE).
