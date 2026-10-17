# Agent adapters

productfoo keeps product-management behavior portable while generating the native command
files each coding-agent runtime expects. Examples use the installed `foo`;
in a built source checkout, substitute `bin/foo`.

## Source and output

The canonical inputs are:

- `commands/*.md` for human-facing command entry points;
- `skills/*/SKILL.md` for product reasoning and artifact behavior;
- `skills/skill-registry.yaml` for routing metadata that is not already defined in
  skill frontmatter;
- the CLI's adapter renderer for installation rules, ownership markers, and runtime
  paths.

Supported coding agents are Codex, Claude Code, Cursor, Grok Bot, and OpenCode.

Generated files are outputs. Do not edit a generated Claude Code, Codex, Cursor,
Grok Bot, or OpenCode file to change productfoo's behavior; update the canonical command,
skill, or adapter renderer and regenerate it.

## Grok Bot

[Add productfoo to Grok Bot](https://x.ai/bot/6BQEkzxJ3C_UZHibSbM-G) using the shared Productfoo bot by Rachel. Open the link and choose **Add to Grok Bot**.

For CLI-generated Grok Bot command files, use `foo agent setup --agent grok --scope project --dry-run` to preview the project setup described below.

## Native adapters stay native

productfoo does not consolidate every runtime under `.agents/plugins`. Each host loads a
different native shape, so productfoo generates the smallest compatible adapter for that
host.

Typical targets include:

- Claude Code command files;
- a Codex plugin and its skills;
- Cursor command files and hooks;
- Grok Bot command files;
- OpenCode command files and gate plugins.

These outputs can share one command contract without pretending their packaging is
identical.

## Preview before writing

Use a dry run to inspect target paths and planned changes:

```bash
foo agent setup --agent all --scope project --dry-run
```

Apply the plan only after reviewing it:

```bash
foo agent setup --agent all --scope project --yes
```

Setup refuses to overwrite a file that productfoo does not own. A conflict is reported as
drift with a next action rather than being replaced silently.

## Project and global scope

Project scope writes adapter files into the current project when the runtime
supports that layout. Global scope installs into the user's runtime-level
configuration:

```bash
foo agent setup --agent all --scope project --dry-run
foo agent setup --agent codex --scope global --dry-run
```

After updating productfoo, refresh Codex explicitly and start a new task:

```bash
foo agent setup --agent codex --scope global --dry-run
foo agent setup --agent codex --scope global --yes
```

The Codex CLI must be on `PATH` for installation. Codex loads plugin metadata
for the lifetime of a task, so an already-open task can retain the old commands.
`foo init` does not refresh Codex in a bundled public installation.

## `.agents/` is development tooling

The repository's `.agents/` directory may contain pinned third-party helper skills
used to develop productfoo. It is not a second canonical productfoo skill tree and is not part of
the public product source.

Durable productfoo behavior belongs in `skills/`, `commands/`, the CLI, or an accepted productfoo
Spec. External helpers should be installed through their own supported mechanism
rather than copied into productfoo and maintained as forks.

## Verifying adapters

Adapter tests should generate outputs in a temporary directory and compare them
with focused fixtures. Tests must not modify a contributor's real global runtime
configuration.

See [Verification](contributing/verification.md) for repository checks and
[Skill governance](../skills/README.md) for canonical skill rules.
