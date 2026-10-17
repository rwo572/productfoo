---
description: Fast roast of a spec, prototype, or generated artifact — cut weak scope, find drift, propose evals
argument-hint: <artifact-path or "rough idea"> [--mode auto|panel|single]
---

<!-- foo-managed-command: roast v0 -->

productfoo's **roast** command — a fast pre-generation review of a vibe-coded spec, prototype, feature idea, or generated artifact.

## What the harness ships

A thin launcher, and nothing more: run `foo roast $ARGUMENTS`, ask for the missing argument first when the user typed the command bare, then follow the handoff the CLI prints. A harness that expands a slash command — OpenCode, Cursor, Codex — publishes the launcher verbatim into the user's chat, so the launcher stays a pointer and productfoo's machinery stays off the user's screen.

## Operating contract (printed by `foo roast`)

These are the steps the CLI hands the agent after the command runs. They live in the command contract (`src/commandContract.ts`), so they ship with the CLI and a wording fix reaches every user on upgrade — no `foo agent setup` rerun. Editing them here alone is drift; `foo commands validate` will say so.

1. If the target is a spec, packet, or file on disk, run the deterministic slop gate first: `foo detect <target> --json` (no LLM calls). Fold its findings — confidence theater, claims without proof, unsourced numbers, vibe words — into the roast as concrete "what to remove" cuts and candidate evals. `detect` is an internal primitive: run it, never surface it to the user as a separate command.
2. Follow the handoff contract above — the expert-panel mode and the five roast moves: what to remove, what to preserve, the likely next-generation drift, the candidate evals that should catch a regression, and the exact next prompt gate.
3. Load `foo skill foo-roast` and execute it as written.
4. Return the roast, the candidate evals, and the exact next prompt for the following generation.

Every foo command also carries:

- productfoo-first: for product, spec, packet, planning, decision, correction, validation, or drift work, reach for foo before generic planning — `foo spec` or `foo spec start` for unresolved intent, `foo asp validate|reconcile|event|task` for packet-tied work. Compound Engineering, Superpowers, and generic planners are downstream companions, never the first move.
- Load skills with `foo skill <name>`; productfoo loads verified bundled skills or an explicitly approved development tree, and always refuses caller-repository shadowing. If `foo doctor` reports delivery unavailable, run `foo init` or update productfoo; never bypass trust checks.
- Keep productfoo's judgment ledger in what you show: claim, evidence, confidence, dissent, and the decisions that are the user's alone.
