# productfoo quick reference

Install with `npm install -g productfoo`; see
[getting started](getting-started.md#install-productfoo) for setup. In a built
source checkout, substitute `bin/foo` for `foo` below.
These commands help inspect work; they do not sandbox an agent or guarantee
correctness. See [getting started](getting-started.md) and the
[security model](security-model.md).

## Set up an agent

```bash
foo doctor
foo agent setup --agent all --scope project --dry-run
foo agent setup --agent all --scope project --yes
```

Codex uses global scope and requires the Codex CLI on `PATH`:

```bash
foo agent setup --agent codex --scope global --dry-run
foo agent setup --agent codex --scope global --yes
```

After updating productfoo, repeat the Codex setup and start a new Codex task.
Review setup output before applying it. See [agent adapters](agent-adapters.md)
for runtime-specific paths and ownership rules.

## Choose the next workflow

| Task | Command |
|---|---|
| Read the project and find a starting point | `foo init` |
| Shape a clear request | `foo spec "add saved filters"` |
| Start deeper shaping | `foo spec start "add saved filters" --request "customers repeat this work"` |
| Plan public research | `foo research "how teams evaluate coding agents"` |
| Plan customer discovery | `foo discovery plan --study customer-onboarding` |
| Compare ideas | `foo ideate "ways to reduce setup time"` |
| Assess whether to build | `foo pitch "help teams preserve product intent"` |
| Review a spec | `foo roast specs/my-feature` |
| Prepare a preview | `foo preview specs/my-feature` |
| Inspect a PR against recovered intent | `foo reconcile --source github:<pr-url>` |

Commands that emit a plan still need the agent to carry it out. Source approval,
research validation, and human decisions remain separate steps. See
[product workflows](workflows.md) for context.

## Maintain a spec

Use an existing packet and its actual task IDs in these examples:

```bash
foo asp validate specs/my-feature
foo asp task specs/my-feature T-001 --status done --proof "test or review link"
foo asp status specs/my-feature
foo asp reconcile specs/my-feature --git-diff
foo asp verify specs/my-feature
foo commit-trailer my-feature
```

A task marked done can still have proof pending. Validation checks structure;
reconciliation reports alignment and gaps; verification inspects supporting
proof. None substitutes for reviewing the implementation. See
[the spec guide](foo-spec.md).

## Review safety and autonomy

| Task | Command |
|---|---|
| Inspect repository boundaries | `foo self check` |
| Inspect staged content before committing | `foo self gate` |
| Scan a file | `foo scan input.txt --exit-code` |
| Produce redacted text for manual review | `foo redact input.txt` |
| Classify proposed work | `foo classify "describe the work"` |
| Check a loop contract | `foo loop check specs/my-feature` |
| Inspect a budget estimate | `foo loop estimate specs/my-feature` |
| Record an agreed budget | `foo loop estimate specs/my-feature --agree --limit 2.00` |

Only agree a budget after reviewing the estimate and intended actions. An armed
loop requires its contract and agreed budget; a declared cap is not a provider
spending limit. Scans can miss private information. This repository does not ship
Git hooks: run checks explicitly or configure your own integration.

## Approve a connected source

```text
foo source discover specs/my-feature --surface <surface.json>
foo source approve specs/my-feature --provider <provider> --connection <id> --scope <scope> --by <person>
foo source receipt specs/my-feature
foo source revoke specs/my-feature --provider <provider> --connection <id> --by <person>
```

Approval is scoped to the spec. It does not replace provider permissions or
permit committing raw private material.

## Report a problem locally

```text
foo report add --expected "what should happen" --actual "what happened" --reproduction "steps to reproduce" --json
foo report show <capsule-id>
foo report delete <capsule-id> --approve <payload-digest>
```

Reports stay local in the public build. Review the exact bytes before sharing
through another tool; prefer synthetic reproductions. The public package needs
no productfoo account or service token.

## Full syntax and contributor checks

Run `foo help --all` or read the generated [CLI reference](cli-reference.md).
Contributor commands and generated-file checks live in
[verification](contributing/verification.md). This Markdown file is the source
for the [printable cheatsheet](cheatsheet.html); regenerate it with
`node scripts/gen-cheatsheet.mjs` and check drift with `--check`.
