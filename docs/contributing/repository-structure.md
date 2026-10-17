# Repository structure

productfoo's public repository should make it obvious which files define product behavior,
which files are generated, and which material does not belong in the distribution.

## Canonical public source

```text
bin/                 CLI entry point
src/                 TypeScript product source
commands/            readable command entry points
skills/              canonical product-management skills
schemas/             public data contracts
scripts/             build, generation, export, and verification scripts
test/                 tests and safe fixtures
examples/             curated runnable examples
docs/                 durable public documentation
config/               bundled pricing and routing data; public build config
.github/              community policies, workflows and release checks
```

The current source includes top-level TypeScript modules, command handlers in
`src/commands/`, and focused subdirectories such as `src/conductor/`,
and `src/contracts/`. Use the files and their tests to locate behavior;
this guide does not prescribe a future directory migration.

Public modules may depend on public contracts. They must not import private
hosted implementations.

## Generated output

Generated files are useful when they let a clean checkout run immediately or when
an agent runtime requires a native layout. They are not independent sources of
truth.

- Build output is regenerated from `src/`.
- Runtime adapters are generated from canonical commands, skills, and adapter code.
- The flat spec-reviewer skills are generated from one shared template plus persona
  data because runtimes need separately addressable skills.
- Golden generated outputs belong in focused test fixtures.

Every generated tree should name its generator and have a drift check. Do not fix a
generated file by hand.

## Skill source of truth

Each canonical skill lives at `skills/<name>/SKILL.md`. See
[Skill governance](../../skills/README.md) for the file contract and registry rules.

The following are not second canonical skill homes:

- `.agents/`, which contains pinned development helpers;
- generated runtime plugin directories;
- generated distribution bundles;
- cached skills installed by an agent runtime.

## Public examples and fixtures

Examples demonstrate productfoo without exposing real product history. A public example
may contain a spec, tasks, events, proof, and a reviewable artifact when every input
is safe to publish.

CalPal is a fictional scheduling-agent example, not an evaluation of a Cal.com
revision. Preserve the [example provenance note](../../examples/README.md):
it has no real users or operating data and implies no affiliation or endorsement.

Parser and regression cases belong under `test/fixtures/`. They should contain the
smallest content needed to prove behavior.

## Material outside the public distribution

Do not include real internal product memory in the public export. This includes
historical specs, ideas, research, discovery memory, swarm output, studio sources,
private website work, and internal design-review evidence.

Private hosted implementation, operations, stores, workers, administration, and
deployment configuration also stay outside the public package. Shared wire formats
belong under `src/contracts/`; an optional public client may depend on those
contracts without importing the service implementation.

## Public source and package checks

The public repository and npm package have different contents: the repository
includes source, tests, and contribution tools; the package includes the public
build and runtime assets. Run `npm run verify:public` to check both inventories.
Private predecessor history and hosted-service tooling are not contributor
prerequisites.

## Documentation and local drafts

`docs/` is committed public documentation. Private local drafts belong under the
ignored `.foo/docs/` directory and must be promoted deliberately after review.

This prevents a locally visible document from being mistaken for a tracked public
artifact.

## Root files

Keep the root focused on installation, tooling, and the contributor entry point:
`README.md`, `LICENSE`, `AGENTS.md`, `package.json`, `package-lock.json`,
`tsconfig.json`, and `skills-lock.json`, plus tool-required dotfiles.

Supporting files live in the following locations:

- `docs/`: changelog, Markdown and HTML cheatsheets, and third-party notices.
- `docs/product/`: product purpose, design, background, and vision.
- `docs/reference/`: skill trust, spec trailers, and trust-envelope contracts.
- `.github/`: contributing, security, and code-of-conduct policies, where GitHub
  discovers them automatically.
- `config/`: bundled runtime YAML and the public TypeScript build configuration.

Existing projects can keep `pricing.yaml` and `routing-policy.yaml` at their
root. Each root file takes precedence over its
`config/` counterpart, including when the override is invalid; a malformed
policy never silently falls back to the bundled policy. Missing configuration
keeps the existing unavailable/degraded behavior.

The README, changelog, third-party notices, runtime YAML, and skill lock still
ship in the npm package. Relocation does not change the public CLI name or
package exports.
