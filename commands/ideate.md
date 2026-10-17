---
description: Turn a raw idea into a ranked, stress-tested shortlist before any spec exists — independent ideator pools, a diversity meter, adversarial stress, then hand off to shape
argument-hint: <raw idea> [--depth fast|standard|deep]
---

<!-- foo-managed-command: ideate v0 -->

productfoo's **ideate** command — the pre-spec front door for the raw idea. It turns a vague idea into a ranked, stress-tested shortlist by having a team of agents brainstorm *independently* (to defeat groupthink), then *as an expert panel*, then *converge* — and hands the winner into `foo spec`. The rejected directions are kept as recorded optionality, not deleted. It implements `specs/ideate-command-v0/` (origin design: `specs/storming-mode-v0/`).

## What the harness ships

A thin launcher, and nothing more: run `foo ideate $ARGUMENTS`, ask for the missing argument first when the user typed the command bare, then follow the handoff the CLI prints. A harness that expands a slash command — OpenCode, Cursor, Codex — publishes the launcher verbatim into the user's chat, so the launcher stays a pointer and productfoo's machinery stays off the user's screen.

## Operating contract (printed by `foo ideate`)

These are the steps the CLI hands the agent after the command runs. They live in the command contract (`src/commandContract.ts`), so they ship with the CLI and a wording fix reaches every user on upgrade — no `foo agent setup` rerun. Editing them here alone is drift; `foo commands validate` will say so.

1. Load `foo skill ideate` and follow the emitted phases: GROUND → FRAME → DIVERGE → FALSIFY → PANEL → REVEAL → BUILD_ON → STRESS → CONVERGE → CAPTURE. Start from relevant existing research and ideas. Keep pools blind until REVEAL; falsify shared empirical premises before build-on, then recheck new claims. The CLI supplies the contract and scaffold; it never generates ideas or picks a winner.
2. Preserve dissent and be honest about diversity. A panel of agents on one base model groupthinks by construction, so independence is engineered, not assumed. Every ideator returns an idea object, not prose; compute the diversity meter (`raw`, `distinct_clusters`, `near_dupes_merged`, `exhausted`) from those objects with `foo ideate diversity <record> --write` instead of counting near-dupes by reading, and a meter you did reach by eye must say `diversity_method: estimated`. Keep the strongest surviving objection plus the runner-up as the minority report. Never vote dissent away; a homogeneous pool is flagged, not smoothed over.
3. Converge, then verify with `foo ideate check <record>`. Render `foo ideate result <record>` as the primary answer: a concrete recommendation, what it adds to prior work, conditional alternatives, evidence limits, a cheap test with pass/fail criteria, dissent, cuts, and next action. Keep the full rank and source pool as backing evidence; never hand off an unverified shortlist.
4. The human is the Decider (B4/D6). Never auto-promote a direction to a spec, and never ship, send, commit, or auto-select. Your allowed actions are frame, generate, cluster, critique, and score — nothing else. Offer the hand-off: `foo spec "<winning direction>"`.

Every foo command also carries:

- productfoo-first: for product, spec, packet, planning, decision, correction, validation, or drift work, reach for foo before generic planning — `foo spec` or `foo spec start` for unresolved intent, `foo asp validate|reconcile|event|task` for packet-tied work. Compound Engineering, Superpowers, and generic planners are downstream companions, never the first move.
- Load skills with `foo skill <name>`; productfoo loads verified bundled skills or an explicitly approved development tree, and always refuses caller-repository shadowing. If `foo doctor` reports delivery unavailable, run `foo init` or update productfoo; never bypass trust checks.
- Keep productfoo's judgment ledger in what you show: claim, evidence, confidence, dissent, and the decisions that are the user's alone.
