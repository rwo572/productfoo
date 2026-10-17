---
spec_id: supported_coding_agents
title: Supported Coding Agents
mode: capability
lifecycle: done
stage: exploring
owner: product
autonomy: human-in-loop
updated: 2026-10-17
---

# Supported Coding Agents

<!-- Identity (`spec_id`) is read from the YAML frontmatter above. Progress is rendered by `foo asp status`, never stored here. -->

## Intent

Make installation and advertised coding-agent support match the five selected agents: Codex, Claude Code, Cursor, Grok Bot, and OpenCode.

## Current Understanding

The maintainer selected these five agents and requested a repository-wide sweep. The command registry, gate registry, docs, and examples still contain integrations outside that list. This is a bounded maintenance change; it does not arm a loop, install an agent, publish a package, or change repository visibility.

## Requirements

### R-001 Supported command and gate surfaces

- Priority: P1
- Risk: medium
- Confidence: high

Command setup, readiness, and research-gate listings expose only the five selected agents. Remove obsolete adapter implementations and installer branches. Preserve scope restrictions and gate semantics for retained agents, including provisional coverage reporting for Grok Bot. Portable routine bindings retain only selected coding agents and the GitHub Actions scheduling substrate; do not invent headless support.

### R-002 Consistent documentation and examples

- Priority: P1
- Risk: low
- Confidence: high

README, adapter documentation, examples, and generated references match the retained integrations. Preserve quoted attribution, model pricing, generic research-tool matching, and HTML entities. Keep the separately edited README title out of this change.

### R-003 Regression proof

- Priority: P1
- Risk: medium
- Confidence: high

Verify the exact setup and gate inventories and real all-agent dry-run/write outputs in a disposable project. Unsupported identifiers fail before writing. Existing tests continue to cover supported wire formats, safety matching, and scope behavior. Run full tests, generated checks, public-package verification, and repository checks before merge.

## Decisions

- D-001 — The maintainer’s five-agent list defines support, not the old registry.
- D-002 — Delete obsolete integrations; leave already-installed user configuration untouched. Unknown host detection and tool matching remain conservative.
- D-003 — Gemini models and quoted competitor references are not coding-agent support. Keep them.

## Risks

- RISK-001 — Registry changes can silently alter setup output; lock the allowlist and inspect disposable-project output.
- RISK-002 — Removing obsolete gates must not weaken retained gates or generic web-tool recognition; preserve and run those tests.
- RISK-003 — Existing users of removed integrations lose refresh support. No external configuration is deleted by this change.

## Validation

- V-001 — Exact command registry and setup output equals claude-code, codex, cursor, grok, opencode.
- V-002 — Exact gate inventory equals claude, codex, cursor, grok, opencode; retained denial formats and fail-open behavior pass.
- V-003 — Full tests, generated checks, public verification, and self-check pass; remaining name matches are classified.

## Evidence

- `src/agentAdapters.ts`, `src/harnessGates.ts`, `src/commands/agent.ts`, and `docs/agent-adapters.md`.
- `expert-review.md` records the scoped review and dissent.

## Open Questions

None blocking; supported-agent scope is explicitly decided.
