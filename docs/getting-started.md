# Getting started

productfoo is designed to be used through a coding agent, while remaining inspectable
and runnable as a normal command-line tool.

## Before you start

productfoo is a personal open-source project with best-effort maintenance and
support. Start in a disposable repository with synthetic data and limited
permissions. Review agent changes and commands before accepting them: the checks
are review aids, not a sandbox or a guarantee of safety. Your agent and connected
services may transmit data or incur charges even when the CLI runs locally.

Read [project status and responsible use](../README.md#project-status-and-responsible-use)
for the full notice.

## Requirements

- Node.js 18 or newer
  (prefer a maintained LTS release; see [tested runtime support](runtime-support.md))
- Git
- A coding-agent runtime if you want productfoo to install native agent commands

## Install productfoo

Install the release tagged `latest` on npm:

```bash
npm install -g productfoo
foo --version
cd /path/to/your/project
```

The resulting package runs with Node.js 18 or newer. It needs no productfoo
account, service token, Python, or contributor build tools. Optional direct
providers use their own credentials; for example, `foo login --firecrawl <key>` configures
Firecrawl access for requested research. It is not a productfoo account login.

## Run from a development checkout

Build with Node.js 26.5.0 and npm 11.17.0:

```bash
git clone https://github.com/rwo572/productfoo.git
cd productfoo
npm ci
npm run build
```

To try the packaged CLI from your development checkout:

```bash
package_file="$(npm pack --silent)"
npm install -g "./$package_file"
foo --version
```

After `npm ci` and `npm run build`, `bin/foo.mjs --version` runs the checkout's
compiled CLI. The examples below use the installed `foo` command; substitute
`bin/foo.mjs` when developing productfoo itself. A fresh clone has no compiled CLI
until you build it.

For the full test suite, also install the
[contributor test tools](runtime-support.md#contributor-test-tools).

## Check readiness

```bash
foo doctor
```

`doctor` reports what is installed, which agent adapters are configured, and the
next command to run. Use JSON when another tool needs to inspect the result:

```bash
foo doctor --json
```

## Connect your coding agent

Preview the adapter changes before writing them:

```bash
foo agent setup --agent all --scope project --dry-run
```

Apply the reviewed plan:

```bash
foo agent setup --agent all --scope project --yes
```

productfoo generates the native files each runtime expects. It does not replace every
runtime with one shared plugin directory. See [Agent adapters](agent-adapters.md)
for the source and generated-file boundaries.

### Codex (OpenAI)

Codex requires global plugin installation (personal plugin only, no project scope):

```bash
foo agent setup --agent codex --scope global --yes
```

This installs productfoo as a personal plugin at `~/.codex/plugins/foo/` with commands
accessible as `/foo:*` in both Codex App and Codex CLI.

**After a productfoo update:** refresh the installed Codex adapter explicitly:

```bash
foo agent setup --agent codex --scope global --dry-run
foo agent setup --agent codex --scope global --yes
```

Then start a new Codex task to load the refreshed plugin. `foo init` does not
refresh the Codex adapter in a bundled public installation.

**Troubleshooting:**
- **Commands not found:** Ensure the plugin installed to the correct path. Run `ls ~/.codex/plugins/foo/` to verify.
- **Stale behavior after update:** Repeat the global Codex setup above, then start a fresh task.
- **Permission errors:** Check that `~/.codex/plugins/` is writable.

## Create your first productfoo Spec

Start with the project orientation:

```bash
foo init
```

Or shape a specific piece of work directly:

```bash
foo spec "add saved filters" \
  --request "customers keep re-creating the same filters"
```

productfoo reads the project before asking questions. Routine work gets a short shaping
pass; riskier or more ambiguous work can escalate into deeper research and review.

## Inspect progress and proof

When the work has a productfoo Spec directory, validate it and inspect its derived
status:

```bash
foo asp validate specs/my-feature
foo asp task specs/my-feature T-001 --status done --proof "test or review link"
foo asp status specs/my-feature
```

The first meaningful proof moment is when an agreed completion check becomes
proven. Status is derived from the agreed work and its proof; marking something done
does not make it proven unless the completion check has supporting evidence.

## Next steps

- Choose a [product workflow](workflows.md).
- Learn how a [productfoo Spec](foo-spec.md) keeps intent and implementation aligned.
- Explore the [CalPal scheduling example](../examples/calpal-scheduling/).
- Read the [security model](security-model.md) before connecting private sources
  or designing autonomous work.
