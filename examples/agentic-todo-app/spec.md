---
spec_id: agentic_todo_app_v1
title: Agentic To-Do App V1
mode: capability
lifecycle: draft
stage: shaping
owner: product
autonomy: human-in-loop
updated: "2026-06-18T00:00:00-07:00"
---

# Agentic To-Do App V1

<!-- Identity (`spec_id`) is read from the YAML frontmatter above. Progress is rendered by `foo asp status`, never stored here. -->

## Intent

Create a local web app, launched and operated from Codex, where a user can manage a task inbox and dispatch selected tasks to agents. The app must make delegation inspectable: what the user asked for, what scope and tools were approved, what the agent did, what proof it returned, what remains unresolved, and what still requires human judgment.

## Current Understanding

This example packet models a personal operator-facing task inbox. A task can remain manual, be scoped for agent work, run in an external or local agent runtime, return for review, and then be approved, rejected, blocked, or completed.

V1 should support broad task categories, including workspace work, research, synthesis, and life-admin preparation, but connector depth is explicitly out of scope when it competes with a strong Codex/local runtime loop. Codex is the first likely runtime target. The app owns task state, dispatch scope, permission gates, evidence requirements, review decisions, and the local ledger; the app does not need to own every agent runtime internally.

The core task lifecycle visible to the user is:

- `Inbox`: a task has been captured but not scoped for agent execution.
- `Scoped`: the user approved an objective, allowed tools/connectors, files/accounts in scope, and proof requirements.
- `Running`: an agent has been dispatched under the approved scope.
- `Needs Review`: an agent has returned a result and the user must inspect it.
- `Done`: the user accepted the result or completed the task manually.
- `Blocked`: progress requires a missing permission, source, decision, or external action.

The durable local data model should preserve:

- task ledger entries
- dispatch packets
- scope and permission decisions
- status changes
- agent results
- artifact and proof links
- review decisions
- suggested follow-up tasks awaiting user acceptance

The product principle is the same as this repo: make agent judgment legible. The app must show what the agent believes, why it believes it, confidence, evidence, unresolved risks, and what still needs human judgment.

## Requirements

### R-001: Provide a local task inbox

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: medium

The app must provide a local web task inbox launched from Codex. The user must be able to create tasks, view task status, and choose whether a task stays manual, is scoped for agent dispatch, or is completed directly.

### R-002: Support scoped agent dispatch

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

Before an agent starts, the app must present a dispatch gate that includes the task objective, allowed tools or connectors, files/accounts in scope, out-of-scope actions, and proof the agent must return.

### R-003: Block irreversible actions without separate approval

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

Agents must not send, purchase, delete, publish, commit, or perform equivalent irreversible external actions without a separate explicit approval. Agents may draft, prepare, research, edit local artifacts within approved scope, and propose irreversible actions for user review.

### R-004: Track the visible task lifecycle

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: medium

The app must expose the statuses `Inbox`, `Scoped`, `Running`, `Needs Review`, `Done`, and `Blocked`. Status changes must be persisted in the local ledger with enough context to explain why the status changed.

### R-005: Return evidence-backed agent results for review

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

When an agent finishes, the app must show a review result containing a summary, created or changed artifacts, key action log, tool/source links, validation checks, confidence, unresolved risks, and approve/reject controls.

### R-006: Persist a local task and dispatch ledger

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

The app must persist task ledger entries, dispatch packets, scope/permission decisions, status changes, agent outputs, proof links, and review decisions locally. The ledger must be inspectable by the user and usable by agents as a source of execution context.

### R-007: Allow follow-up suggestions without inbox clutter

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: medium

Agents may suggest follow-up tasks, but suggested work must remain in an approval area or inline review list until the user accepts it into the active inbox. Agents must not flood the active inbox with unapproved follow-ups.

### R-008: Dispatch to external or local agent runtimes

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

The app should treat agent runtimes as external or local execution targets. V1 should optimize for Codex/local runtime dispatch and should keep runtime-specific behavior behind a narrow adapter boundary.

### R-009: Design against agent overreach and fake completion

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

The app must make approved scope and proof requirements visible before dispatch and compare returned results against that scope before the user marks work done. The review state must call out missing proof, out-of-scope actions, and unresolved risks.

### R-010: Validate with rendered flow and dogfood

Priority: must
Confidence: high
Evidence: user-interview
Needs validation: true
Risk: high

V1 is ready only after a rendered local flow proves create/scope/dispatch/review behavior with fixture dispatch packets and after the app is used to run and review one real Codex task.

## Decisions

- D-001: Use a task inbox as the primary user mental model.
- D-002: Use `Inbox`, `Scoped`, `Running`, `Needs Review`, `Done`, and `Blocked` as the v1 visible lifecycle.
- D-003: Require a scope gate before agent dispatch.
- D-004: Require evidence-backed review before accepting agent results.
- D-005: Block irreversible external actions unless separately approved.
- D-006: Allow agents to suggest follow-ups, but require user approval before adding them to the active inbox.
- D-007: Use external/local agent runtimes first, with Codex as the first likely runtime target.
- D-008: Persist a local task ledger, dispatch packets, results, proof, and review decisions.
- D-009: Cut connector depth before cutting the core Codex/local dispatch and review loop.
- D-010: Treat rendered local flow plus one real Codex dogfood task as the v1 validation bar.

## Spec Swarm Summary

| Role | Expert-resolved judgments | User-judgment questions | Dissent / caveat | Likely spec impact |
| --- | --- | --- | --- | --- |
| CPO | The sharp product bet is delegated execution with reviewable proof, not generic task tracking. | None remaining. | Outcome metrics should stay qualitative until dogfood evidence exists. | Keep v1 focused on delegation trust. |
| Principal Product Designer | The main screen should prioritize task state, dispatch readiness, and review evidence. | None remaining. | Rich dashboard/history can wait. | Add state and hierarchy requirements. |
| Technical Architect | The app should own ledger and dispatch packets while runtimes remain adapters. | None remaining. | Runtime integration details need implementation discovery. | Add adapter boundary and local ledger requirements. |
| Technical Lead | The smallest buildable slice is inbox, scope gate, fixture dispatch, result review, and persisted ledger. | None remaining. | Real runtime dispatch may need a fixture/manual fallback during first build. | Add validation and task sequencing. |
| Security / Privacy / Legal | Irreversible actions require separate approval and private raw material must not enter canonical artifacts by default. | None remaining. | Connector-specific permissions are deferred. | Add approval and source-boundary requirements. |
| QA / Release | Readiness requires rendered flow and a dogfood Codex task, not just static validation. | None remaining. | No release readiness should be claimed before dogfood proof exists. | Add validation bar and release gate. |
| Content Design | Avoid overclaiming agent certainty; show proof, confidence, and unresolved risks. | None remaining. | Final copy can come during UI design. | Add terminology and review-state constraints. |

### Judgment Ledger

| Judgment | Owner lens | Type | Evidence | Confidence | Dissent / caveat | Needs user judgment? |
| --- | --- | --- | --- | --- | --- | --- |
| V1 should be a task inbox with dispatch actions. | CPO | user-judgment | Interview answer selecting task inbox. | high | None. | No |
| Dispatch must show scope, tools, accounts/files, and proof. | Security / Privacy / Legal | user-judgment | Interview answer selecting scope/tools/evidence. | high | Connector-specific policy deferred. | No |
| Irreversible external actions need separate approval. | Security / Privacy / Legal | user-judgment | Interview answer selecting approval boundary. | high | Must define "irreversible" in implementation copy. | No |
| Follow-ups should be suggested, not auto-added. | Product Designer | user-judgment | Interview answer selecting suggested follow-ups. | high | Needs clutter controls in UI. | No |
| Codex/local runtime should be the first runtime target. | Technical Architect | user-judgment | Interview answer naming Codex. | high | Keep runtime adapter boundary narrow. | No |
| Validation must include rendered flow and dogfood. | QA / Release | user-judgment | Interview answer selecting both. | high | Dogfood task must be real enough to expose workflow issues. | No |

## Risks

- Agent overreach: an agent may act outside approved task scope or use an unapproved tool.
- Fake completion: an agent may claim work is done without enough proof.
- Inbox clutter: agent-discovered follow-ups may overwhelm the active task list.
- Runtime coupling: Codex-specific assumptions may leak into the product model if the adapter boundary is weak.
- Permission ambiguity: broad task categories may blur what files, accounts, or connectors an agent may access.
- Audit gaps: missing logs, source links, or artifact references may make review untrustworthy.

## Validation

V1 must pass these checks before it is considered ready:

- Static packet validation: `foo asp validate examples/agentic-todo-app` succeeds.
- Rendered local flow: a user can create a task, scope it, simulate or dispatch an agent run, review the returned result, and approve or reject it.
- Fixture dispatch packets: representative tasks cover workspace work, research/synthesis, and life-admin preparation without requiring deep connector integrations.
- Scope enforcement: a review result can flag out-of-scope actions and missing proof.
- Follow-up control: an agent can suggest follow-up tasks without adding them to the active inbox until approved.
- Dogfood run: the app is used to dispatch and review one real Codex task.
- Ledger inspection: persisted task, dispatch, status, proof, and review records can be inspected locally.

## Evidence

- User interview on 2026-06-18 selected: task inbox, broad but gated delegation, scoped dispatch, evidence-backed review, no irreversible actions without approval, Codex/local runtime, local web app, local ledger persistence, connector-depth cut line, and rendered-flow plus dogfood validation.
- Repo governance in `AGENTS.md` and `README.md` requires agent judgment to remain legible and keeps runnable/sample product specs under `examples/<name>/`.
- Expert swarm pass on the approved interview intake resolved CPO, design, architecture, technical lead, security/privacy/legal, QA/release, and content-design questions without additional blocking user questions.

## Open Questions

- Which concrete local web stack should implement the first UI?
- What is the exact Codex runtime adapter contract for dispatching a real task from the app?
- What local persistence format should v1 use: JSONL files, SQLite, or another inspectable store?
- What labels should distinguish "agent suggested" follow-ups from accepted inbox tasks?
- What is the first dogfood task that should be run through the app?
