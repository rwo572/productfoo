---
description: Build Preview — route a spec packet through preview-swarm to show what's about to be built
argument-hint: <packet-dir>
---

<!-- foo-managed-command: preview v0 -->

productfoo's **preview** command — the Build Preview entry point for showing what an agent is about to build from a packet.

## What the harness ships

A thin launcher, and nothing more: run `foo preview $ARGUMENTS`, ask for the missing argument first when the user typed the command bare, then follow the handoff the CLI prints. A harness that expands a slash command — OpenCode, Cursor, Codex — publishes the launcher verbatim into the user's chat, so the launcher stays a pointer and productfoo's machinery stays off the user's screen.

## Operating contract (printed by `foo preview`)

These are the steps the CLI hands the agent after the command runs. They live in the command contract (`src/commandContract.ts`), so they ship with the CLI and a wording fix reaches every user on upgrade — no `foo agent setup` rerun. Editing them here alone is drift; `foo commands validate` will say so.

1. Follow the contract above: it routes to the preview-swarm skill and names the expected output path. Load `foo skill preview-swarm` and execute it as written.
2. Treat Impeccable critique as the completion gate when it is available. When it is not, record a manual-review gap rather than blocking the preview.

Every foo command also carries:

- productfoo-first: for product, spec, packet, planning, decision, correction, validation, or drift work, reach for foo before generic planning — `foo spec` or `foo spec start` for unresolved intent, `foo asp validate|reconcile|event|task` for packet-tied work. Compound Engineering, Superpowers, and generic planners are downstream companions, never the first move.
- Load skills with `foo skill <name>`; productfoo loads verified bundled skills or an explicitly approved development tree, and always refuses caller-repository shadowing. If `foo doctor` reports delivery unavailable, run `foo init` or update productfoo; never bypass trust checks.
- Keep productfoo's judgment ledger in what you show: claim, evidence, confidence, dissent, and the decisions that are the user's alone.
