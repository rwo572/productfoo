---
name: spec-cleanup
description: Use when a draft Adaptive Spec Packet, PRD-like spec, or spec-swarm output needs cleanup before implementation, commit, validation, or handoff; especially when requirement order, release tiers, JSON contracts, task mapping, reconciliation, privacy boundaries, or implementation readiness may drift.
---

# Spec Cleanup

Finalize a spec after interview or swarm work so an implementation agent can build from it without inventing product, contract, privacy, or sequencing decisions.

This is not another expert panel. It is the deterministic cleanup pass that converts good product thinking into an implementable packet.

## Usage

Use after `spec-swarm`, after major packet edits, or before implementation begins:

```text
Use $spec-cleanup on <packet-dir-or-spec-path>
```

For Adaptive Spec Packets, read `spec.md`, `tasks.yaml`, and `events.jsonl`. For PRD-like specs, read the spec and any linked tasks, decisions, acceptance criteria, design notes, or validation plan.

If the user asks to apply cleanup, edit the packet. If the user asks for review only, return findings and concrete amendments without editing.

## Cleanup Checks

Run these checks in order.

1. Release tier and ordering
   - Group requirements by `core`, `next increment`, `later`, and `deferred` when scope spans multiple releases.
   - Keep documentation requirements beside the capability they document when docs are part of making that capability usable.
   - Move unresolved hosted, privacy, auth, commercial, or runtime-adapter decisions out of core unless the packet already specifies the control.
   - Do not let a later increment block validation or shipment of the core slice.

2. Contract readiness
   - Agent-facing commands need stable JSON fields, schema version, status, errors, handoff, next actions, and exit behavior.
   - CLI behavior needs exact flags, accepted values, empty states, error states, approval states, and examples when agents will consume it.
   - Analytics or event work needs event identity, timestamps, enums, dedupe behavior, denominator rules, and corrupt-record handling.
   - Reject "parseable JSON" as a completion bar when the product depends on stable machine-readable output.

3. Task mapping and sequencing
   - Every task must reference the requirements it implements.
   - Dependencies must reflect release order, not a single all-or-nothing chain.
   - Split validation setup from final validation when the validator is meant to guard the work.
   - Do not let broad packet-maintenance tasks bless unrelated packet self-edits. Packet edits should map to a requirement, event, or explicit maintenance reason.

4. Human and agent workflow
   - Define when prompts appear, whether they are blocking, how users skip or defer, and what non-interactive agents should do.
   - Low-quality or low-rating flows should ask whether the user wants to reroute; never assume reroute.
   - Review surfaces should show what changes, why, risk, provenance, approval boundary, resume command, and no-op or conflict states.

5. Privacy, security, and source boundaries
   - Treat raw prompts, qualitative feedback, customer context, private strategy, transcripts, and small-count aggregates as sensitive by default.
   - Hosted sync or export needs explicit consent, included and excluded fields, local-only proof for dry runs, retention assumptions, and auth or tenancy boundaries.
   - Generated local ledgers should be gitignored and have a local access or retention story when they can contain sensitive context.

6. Implementation readiness
   - Replace vague language such as "handle", "support analytics", "reviewable", "lightweight", or "agent-friendly" with testable behavior.
   - Keep open questions only when the implementation can proceed safely without answering them.
   - Add acceptance checks for fixture outputs, negative cases, stale decisions, privacy boundaries, and reconciliation findings.

## Output

When editing, produce:

- A short summary of packet changes.
- Any human-judgment decisions still required.
- Validation commands run and their results.
- Drift or reconciliation caveats, especially if the packet still has unrelated dirty files.

When reviewing only, produce:

| Finding | Severity | Evidence | Proposed cleanup |
| --- | --- | --- | --- |

Use severity:

- `P0`: implementation would be unsafe or cross an unresolved approval/privacy boundary.
- `P1`: implementers will invent behavior or the core release cannot ship cleanly.
- `P2`: product quality, analytics, or workflow signal will be weak but not blocking.

## Validation

After editing an Adaptive Spec Packet:

```bash
bin/foo asp validate <packet-dir>
```

If implementation-relevant files changed for the same packet, also run the packet reconciliation command supported by that packet, usually:

```bash
bin/foo asp reconcile <packet-dir> --git-diff
```

If the packet has no validator, state that clearly and do the closest structural check manually: required files, duplicate spec IDs, task refs, event JSONL validity, and changed-file mapping.

## Error Handling

- If the artifact is missing or not identifiable, ask for the packet directory or spec path.
- If source files are unavailable, report exactly which cleanup checks could not run.
- If cleanup would require product judgment, source-boundary approval, privacy policy, or release appetite, ask one focused question and explain the default assumption you would otherwise carry.
- If validation fails after edits, fix the packet or report the failing command and do not claim the packet is implementation-ready.
- If unrelated worktree changes are present, do not stage, revert, or reconcile them as part of this skill unless the user explicitly asks.
