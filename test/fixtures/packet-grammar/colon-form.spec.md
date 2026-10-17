---
spec_id: asp_v0
title: Adaptive Spec Packet V0
mode: architecture-decision   # capability | architecture-decision | brand-shape | spec-patch
lifecycle: done
stage: shaping                # exploring | shaping | learning — learning posture (D-003)
owner: product
autonomy: human-in-loop
updated: 2026-07-07
---

# Adaptive Spec Packet V0

<!-- Identity (`spec_id`) is read from the YAML frontmatter above (T-013). Progress is never stored in this header — it is rendered by `foo asp status` (R-019). -->

## Intent

Define an open, portable spec packet for agentic and hybrid product development. The packet should be usable by humans, coding agents, and leaders without forcing waterfall gates or binding the workflow to one coding agent, IDE, tracker, or hosted service.

The packet exists to make agent judgment legible: what the agent believes, why it believes it, confidence, dissent, evidence, conflicts, and what still requires human judgment.

## Current Understanding

The canonical packet has three required files:

- `spec.md`: product truth, learning posture, requirements, decisions, risks, validation, evidence, and open questions.
- `tasks.yaml`: machine-readable work derived from the spec, including task status, agreement state, ownership, review policy, completion proof, and code touchpoints.
- `events.jsonl`: append-only event ledger for decisions, task changes, validation, conflicts, learning, and meaningful agent activity.

The packet may also include:

- `integration-events.jsonl`: external record/work system events from Jira, Linear, GitHub, GitLab, CI, deployment, or sync tools.
- `trace-events.jsonl`: normalized high-volume agent traces when they should be separated from durable packet events.
- `review-events.jsonl`: human approval, signoff, or review events when teams need a distinct audit segment.
- `evidence/`: optional linked evidence, summaries, source maps, or access-controlled references.
- `adapters/`: agent capability manifests for Claude Code, Codex, Cursor, Grok Bot, OpenCode, or future agents.

Stages are learning postures, not gates:

- `exploring`: discovering the problem, codebase, evidence, constraints, and viable paths.
- `shaping`: turning intent into decisions, requirements, task structure, and validation contracts.
- `learning`: building, checking, reconciling, and updating the packet from observed results.

The packet can move backward or sideways between stages. Stage changes must be recorded as events with reasons.

## Requirements

### R-001: Provide a compact canonical packet

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The format must define a small required packet surface that is easy for humans to inspect and easy for agents to consume. V0 requires `spec.md`, `tasks.yaml`, and `events.jsonl`.

### R-002: Support greenfield and brownfield use

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The same format must support specs compiled from existing docs, specs shaped from brainstorms or RFCs, and specs started from existing materials that evolve while a builder builds.

### R-003: Keep tasks as the machine-readable conversion of the spec

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

`tasks.yaml` must represent executable work derived from the spec. It must track what is agreed, discovered, suggested, rejected, todo, doing, blocked, done, or dropped.

### R-004: Track completion with proof

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

A task marked `done` must include completion metadata and should include `done_when` checks with proof references. Status alone is not enough.

### R-005: Allow adaptive task discovery without silent scope drift

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

Agents may add `discovered` or `suggested` tasks when building reveals real work, but they must not silently treat those tasks as agreed scope. Acceptance, rejection, or revision must be visible through task state and events.

### R-006: Require agent self-identification for task changes

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

When an agent creates, accepts, rejects, or materially changes a task, it must identify the actor, provider/runtime, model when known, persona, active skills or prompt modules when known, adapter, and effective autonomy mode.

### R-007: Capture learning as events, not patches

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The event ledger must record meaningful product, task, validation, conflict, external-system, and human-decision events. Events may be summarized or suppressed in human views, but durable event IDs must remain available for status, proof, and conflict resolution.

### R-008: Preserve agent portability

Priority: must
Confidence: high
Evidence: derived
Needs validation: true
Risk: high

The canonical packet must not depend on Claude Code, Codex, Cursor, Grok Bot, OpenCode, or any one agent runtime. Agent-specific capture must live in adapters that normalize native hooks, logs, transcripts, or extension events.

### R-009: Accept incomplete traces

Priority: must
Confidence: high
Evidence: derived
Needs validation: true
Risk: medium

Missing assistant messages, session-end events, tool results, or transcript paths must reduce trace completeness rather than break the packet.

### R-010: Reconcile implementation against agreed tasks

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The CLI must compare changed files, task touchpoints, event history, and external work evidence so it can call out when code changed outside the agreed task list.

### R-011: Map to systems of record and systems of work without ceding authority

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

Jira, Linear, or similar systems may own portfolio visibility. GitHub, GitLab, CI, and deployment systems may own work evidence. The packet remains the agent execution contract and must report conflicts when systems disagree.

### R-012: Support human-in-loop and agent-driven modes

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The packet must represent both `human-in-loop` and `agent-driven` execution. Human review remains mandatory for product meaning changes, high-risk changes, source-boundary changes, destructive operations, public claims, legal/privacy/security concerns, and materially valid tradeoff choices.

### R-013: Make evidence useful but not blocking

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: medium

The format must allow weak or missing evidence without blocking work. Missing evidence should affect confidence, validation needs, proof state, and escalation behavior.

### R-014: Protect private and sensitive source material

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

Canonical packet files must not store raw private notes, transcripts, prompts, tool payloads, credentials, customer data, or sensitive source material by default. Raw payload references require explicit policy and should include sensitivity, retention, redaction, and access metadata.

### R-015: Produce leader-readable status without fake precision

Priority: must
Confidence: medium
Evidence: human-judgment
Needs validation: true
Risk: medium

Leader views must show proof state, blockers, stale suggested/discovered tasks, source authority state, completed tasks, last meaningful learning, and next decision. They must not use percent complete by default.

### R-016: Start product/spec work with interview and expert swarm

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The CLI must expose a first-class product/spec workflow entrypoint that routes new spec work through `interview-me` before spec drafting, then through `spec-swarm` before implementation. Packet validation and reconciliation remain later gates for structural validity and task/work agreement.

### R-017: Make loop contracts inspectable before execution

Priority: should
Confidence: medium
Evidence: derived
Needs validation: true
Risk: medium

The CLI should expose a loop-contract workflow that lets an agent or human draft, check, and inspect bounded repeated behavior attached to a packet before any loop execution exists. Loop contracts must define how an agent observes, chooses, acts, verifies, records, stops, or asks while preserving `spec.md`, `tasks.yaml`, and `events.jsonl` as the canonical packet truth.

### R-018: Route Build Preview generation from the top-level CLI

Priority: should
Confidence: high
Evidence: user-decision
Needs validation: true
Risk: medium

The CLI should expose `foo preview <packet-dir>` as the user-facing Build Preview entrypoint. The command must validate that the packet path exists, require the `preview-swarm` skill to be registered, and print the exact prompt, artifact target, and Impeccable review gate. Build Preview is a user job; it should not require users to know the internal `asp` namespace.

### R-019: Render derived packet status without storing it or faking precision

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: medium

The CLI must expose `foo asp status <packet-dir>` as a derived progress view computed from `tasks.yaml`, never written back into `spec.md`. The default view must stay fast: it reads only `tasks.yaml` and must not call git or the network. It must report task counts (done, doing, blocked, of total), `done_when` proof counts, completed work, blockers, stale suggested or discovered tasks, open questions, requirement coverage, and the next decision, and it must keep task-level progress and spec-level progress on separate lines. It must not emit percent-complete by default, and it must distinguish in-progress work from proven work. Source-authority and work-evidence state (R-011) and last meaningful learning may require git or event replay and must render only under an explicit `--deep` flag, with the fast view marking them as not yet checked. Cross-packet portfolio rollup is out of scope for V0.

The next decision is the highest-ranked actionable task — a `todo` or `doing` task whose `depends_on` are all satisfied — together with any open question blocking it; requirement coverage counts requirements referenced by at least one non-rejected task against the total. Human-readable text is the default output; the command must also support a stable, versioned `--json` output for agents (a `schema_version`, the same counts, `next`, `blocked`, `stale`, and a `deep_checked` flag), and it must exit non-zero only on packet errors, never on incomplete work. Under `--deep`, status may read git and the event ledger but must not print file contents, secrets, or raw prompts.

### R-020: Report runtime-native command invocation honestly

Priority: must
Confidence: high
Evidence: runtime-dogfood
Needs validation: true
Risk: medium

`foo agent setup` and `foo agent status` must distinguish a runtime's native invocation surfaces instead of claiming one syntax across hosts. For the personal Codex plugin, setup remains an explicit global write and status must report the desktop App form (`/foo:<command>`) separately from the Codex CLI skill-mention form (`$foo:<command>`). Both forms must resolve to the same generated plugin skill. Unsupported legacy prompt files must not be installed as a substitute, and installed user-runtime behavior must be verified in a fresh session before productfoo reports it as ready.

## Decisions

- D-001: Use `spec.md`, `tasks.yaml`, and `events.jsonl` as the required packet files.
- D-002: Treat `integration-events.jsonl`, `trace-events.jsonl`, and `review-events.jsonl` as optional segments of one logical event ledger.
- D-003: Use `exploring`, `shaping`, and `learning` as learning postures rather than gates.
- D-004: Keep tasks, not Shape Up scopes, as the executable machine-readable work representation.
- D-005: Use task `agreement` to distinguish `agreed`, `discovered`, `suggested`, and `rejected` work.
- D-006: Use task `status` to distinguish `todo`, `doing`, `blocked`, `done`, and `dropped`.
- D-007: Require agent actor identity on agent-created or agent-modified task events.
- D-008: Treat codebase changes as a self-referential evidence source for brownfield work.
- D-009: Map external record/work systems through events and links, not silent mutation of packet truth.
- D-010: Derive freshness from `observed_at`, `synced_at`, and packet policy rather than storing asserted freshness.
- D-011: Use explicit `ledger.segment_order` for deterministic replay.
- D-012: Start dogfooding with Claude and Codex before expanding adapter coverage.
- D-013: Use `foo` as the temporary top-level CLI command and `asp` as the Adaptive Spec Packet command namespace.
- D-014: Use `foo spec start` as the required entrypoint for product/spec work so agents see the interview, swarm, validation, and reconciliation gates in order.
- D-015: Use `foo loop design`, `foo loop check`, and `foo loop status` as the first loop-contract CLI slice; defer loop execution until contract safety and review behavior are proven.
- D-016: Use `foo preview <packet-dir>` as the top-level Build Preview routing command.
- D-017: Resolve the header open question — packet headers move to YAML frontmatter carrying identity and intent only (`spec_id`, `title`, `mode`, `lifecycle`, `stage`, `owner`, `autonomy`, `updated`); computed progress is never stored in the header.
- D-018: Rename the acceptance field from `Status` to `lifecycle` (`draft` | `active` | `archived`) so it no longer collides with the `foo asp status` command or gets confused with progress.
- D-019: Expose progress as a derived `foo asp status` view computed from `tasks.yaml`, not stored, satisfying R-015 with counts rather than percent-complete.
- D-020: Keep the default status path fast by reading only `tasks.yaml`; defer git, event replay, source-authority, and last-meaningful-learning to an explicit `--deep` flag.
- D-021: Keep cross-packet portfolio rollup and external work-system mapping (Linear, Jira, epics) out of V0, reserving the existing `integration-events.jsonl` and R-011 conflict-reporting seam for a later version.
- D-022: Treat host-native invocation syntax as part of adapter truth: Codex App uses `/foo:*`, Codex CLI uses `$foo:*`, and productfoo reports both rather than inventing slash-command parity.

## Risks

- The format could become too broad if every workflow adds custom first-class fields.
- Agents may overclaim task completion unless `done_when`, completion proof, and reconciliation are enforced.
- Suggested and discovered tasks may become a shadow backlog if stale review policy is weak.
- External tracker status can create false certainty if mapped work evidence is missing.
- Raw agent transcripts and tool payloads may leak sensitive information if imported into canonical packet files.
- Leader views can mislead if confidence, validation state, proof state, and blockers are hidden.
- Adapter capability differences may make traces appear more comparable than they are.
- Loop contracts may be mistaken for permission to run unattended unless the CLI keeps design, check, and status separate from execution.
- A derived status view can still mislead if `done_when` checks are coarse or unproven; status must show proof counts and separate in-progress work from proven work rather than implying completion.
- During the frontmatter migration, a packet carrying both frontmatter and a transitional `Spec ID:` line can drift until the validator reads frontmatter; the migration task must remove the legacy line.

## Validation

V0 is valid when:

- `spec.md` is readable by humans and contains required product truth sections.
- `tasks.yaml` parses as YAML and includes required task identity, status, agreement, review, completion, and proof fields.
- `events.jsonl` parses as JSONL and includes required envelope fields.
- Agent-created task events include actor identity.
- Suggested, discovered, and rejected tasks have event trails.
- Suggested and discovered tasks have review owners and stale policy.
- Event segments replay deterministically using `ledger.segment_order`, event time, segment order, and line order.
- External freshness is derived from timestamp policy.
- Reconciliation detects unmapped changed files, work mapped only to unagreed tasks, stale suggested tasks, and external record/work mismatches.
- Loop contract commands can draft a reviewable `loops.yaml`, validate existing loop contracts, and render loop status without executing a loop.
- `foo preview <packet-dir>` routes an existing packet to `preview-swarm` and names the expected packet-local preview artifact.
- `foo asp status <packet-dir>` renders task counts, `done_when` proof counts, blockers, stale tasks, open questions, requirement coverage, and the next decision from `tasks.yaml` alone, prints no percent-complete, distinguishes in-progress from proven work, and gates source-authority and last-meaningful-learning behind `--deep`.
- The scheduling app example packet passes local validation and reconcile tests.

## Evidence

- `docs/rfcs/2026-06-18-adaptive-spec-packet-v0-rfc.md`
- `docs/brainstorms/2026-06-18-agent-trace-events-best-practices.md`
- `docs/brainstorms/2026-06-18-spec-driven-formats-landscape.md`
- `examples/calpal-scheduling/spec.md`
- `examples/calpal-scheduling/tasks.yaml`
- `examples/calpal-scheduling/events.jsonl`
- `examples/calpal-scheduling/reconcile.ts`
- `examples/calpal-scheduling/reconcile.test.ts`
- `specs/adaptive-spec-packet-v0/loops.yaml`
- `src/loopContracts.ts`
- `src/cli.ts`
- `test/foo_cli.test.ts`
- `README.md`

## Open Questions

- Should V0 publish JSON Schema for `tasks.yaml` and event envelopes immediately, or after another dogfood pass?
- Should trace spans live in `events.jsonl` by default, or only durable spec/task events with traces in `trace-events.jsonl`?
- Should adapter manifests live inside each packet, a global registry, or both?
- What should the permanent CLI package be named after the temporary `foo` name?
