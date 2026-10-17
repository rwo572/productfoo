---
description: Start here — productfoo reads your project, points at a first move, and turns the one you pick into an agreed spec
---

<!-- foo-managed-command: init v0 -->

productfoo's **init** command — productfoo's front door. It reads what the developer already has, hands back a recommended first move plus numbered options in plain English, and turns the chosen one into an agreed spec underneath. It is also productfoo's orientation: its very first run in a project opens with two plain lines about what productfoo does, and outside a project it tells the short story instead of erroring. (`foo learn` is a quiet alias for this command.)

Run the foo CLI as `foo`. If the shell reports command-not-found (harness shells can skip interactive profiles like ~/.zshrc), locate it once with `command -v foo || echo "$(npm prefix -g)/bin/foo"` and use that absolute path for every foo call in this session. Load skills with `foo skill <name>`; productfoo loads verified bundled skills or an explicitly approved development tree, and always refuses caller-repository shadowing. If `foo doctor` reports delivery unavailable, run `foo init` or update productfoo; never bypass trust checks.

## What the harness ships

A thin launcher, and nothing more: run `foo init`, ask for the missing argument first when the user typed the command bare, then follow the handoff the CLI prints. A harness that expands a slash command — OpenCode, Cursor, Codex — publishes the launcher verbatim into the user's chat, so the launcher stays a pointer and productfoo's machinery stays off the user's screen.

## Operating contract (printed by `foo init`)

These are the steps the CLI hands the agent after the command runs. They live in the command contract (`src/commandContract.ts`), so they ship with the CLI and a wording fix reaches every user on upgrade — no `foo agent setup` rerun. Editing them here alone is drift; `foo commands validate` will say so.

1. Keep this read intact when you present it — the first run in a project opens with a one-time orientation, and outside a project it tells the story plus the next step. Both are the message, not noise.
2. For sharper options than the deterministic floor, run `foo init --json` and read `agent_contract`: it carries the repo signals and the decision grammar (recommendation first, then numbered options, a comparative why, every option grounded in a concrete repo fact). Never show an option without a repo fact.
3. When the user answers with a number or in their own words, run `foo init --pick <n>` or `foo init --intent "…"` and relay the result — that step creates the agreed spec for them.
4. After the spec is created, keep init's promise: lock the scope. Ask two or three quick questions ONE at a time in your own words — what must be true when this ships, what is explicitly out, and what it touches — then record the agreed answers in the created spec's Intent and Requirements and show the user what you recorded. A spec whose scope was never confirmed is a promise init made and nobody kept.

Every foo command also carries:

- productfoo-first: for product, spec, packet, planning, decision, correction, validation, or drift work, reach for foo before generic planning — `foo spec` or `foo spec start` for unresolved intent, `foo asp validate|reconcile|event|task` for packet-tied work. Compound Engineering, Superpowers, and generic planners are downstream companions, never the first move.
- Load skills with `foo skill <name>`; productfoo loads verified bundled skills or an explicitly approved development tree, and always refuses caller-repository shadowing. If `foo doctor` reports delivery unavailable, run `foo init` or update productfoo; never bypass trust checks.
- Keep productfoo's judgment ledger in what you show: claim, evidence, confidence, dissent, and the decisions that are the user's alone.
