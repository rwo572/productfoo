# CalPal Wired Artifact Creation Notes

## What This Artifact Is

This artifact is a low-fidelity, wired simulation of the approved CalPal agentic EA experience in `examples/calpal-scheduling/spec.md`.

It is not a packet-review UI, a wireframe gallery, a public booking page, or a full application. It is one concrete end-user scenario made clickable enough to evaluate the product experience:

1. Taylor cc's the configured scheduling assistant on an email thread.
2. Taylor gives participant, purpose, and rough time window.
3. The assistant replies with the user-configured public name and discloses that it is coordinating for Taylor.
4. The assistant proposes options and holds them while waiting for the guest.
5. The guest accepts a proposed option, or proposes alternatives.
6. The assistant books accepted proposed options after final recheck and releases unused holds.
7. The assistant asks Taylor for quick approval before booking a guest-proposed alternate.
8. The assistant asks one clarifying question when a guest reply is too ambiguous to parse.

## Source Material Used

The artifact was shaped from the approved interview decisions and CalPal V0 requirements:

- `R-001`: cc-based natural-language delegation.
- `R-002`: availability strategy from calendar reality and preferences.
- `R-003`: email-thread guest coordination without an account or booking page.
- `R-004`: holds, stale-option handling, and final recheck.
- `R-005`: host and guest timezone translation.
- `R-006`: approval model and Google Calendar writeback.
- `R-007`: availability-safe guest language only.
- `R-008`: email-native status, approvals, and audit trail.

## Design Direction

The useful artifact shape is an email-client simulation with a reviewer-only behind-the-scenes pane:

- The first screen is the actual email thread, not explanatory artifact chrome.
- Daniel's reply is the branch point: accept a proposed option, suggest an alternate, or answer ambiguously.
- The end-user email uses a configurable assistant name. CalPal remains the product/agent label in reviewer-only context, not the public persona Daniel sees.
- The behind-the-scenes pane is not part of the end-user UX. It explains what CalPal knows, what it can do, what it must protect, and what it will do next.
- The calendar state is represented as visual holds and cleanup, not as a public booking surface.
- The artifact makes the approval boundary visible when Daniel proposes a time Taylor did not pre-approve.

The visual language separates three layers:

- Email cards are the end-user UX.
- Grey dashed blocks are simulator controls used by the reviewer to branch the scenario.
- Dark panels are behind-the-scenes explanations, not product screens.

## Feedback Loop

The artifact supports lightweight element-level feedback:

1. Click a meaningful region in the email thread, simulator control, behind-the-scenes explanation, translation block, calendar slot, or approval note.
2. Add a plain-language note in the feedback tray.
3. Notes are stored locally in the browser by artifact version under `calpal-wired-artifact-feedback-versions-v1`.
4. The `Feedback` selector shows the current artifact version and any previous versions that still have comments.
5. A new artifact version should get a new `currentArtifactVersion.id`; that starts the current version with zero comments while preserving previous comments for review.
6. Use `Copy all feedback` to pass the complete bundle for the selected version back to Codex, Claude, or another model.

The JSON bundle is intentionally model-readable. Each comment includes:

- `node_id`: stable target id in the artifact.
- `node_label`: human-readable target name.
- `node_kind`: email, simulator-control, agent-context, calendar, receipt, or similar.
- `artifact_version_id`: version of the artifact the comment was written against.
- `artifact_version_label`: human-readable version label.
- `tag`: inferred from the note so the UI can stay simple.
- `confidence`: how strongly the artifact inferred the feedback type.
- `status`: proposed by default, or `needs-clarification` when the note is too vague to act on.
- `clarifying_question`: generated only when the artifact should ask the reviewer or model for more specificity.
- `comment`: reviewer feedback text.

The static `file://` artifact cannot directly send comments back into Codex or Claude without a runtime bridge. The current handoff is copy/export; a future Codex or Claude adapter can consume the same versioned JSON bundle directly.

On mobile, the artifact does not simply stack the desktop panes. It uses three review tabs:

- `Thread`: the default, showing the email conversation and inline reply branches.
- `Behind`: reviewer-only explanation of what CalPal knows, can do, must protect, and will do next.
- `Calendar`: reviewer-only calendar state with private events, holds, releases, and final booking status.

This makes the artifact test the real product promise: CalPal should feel like delegated scheduling help, not a configurable scheduling link.

## Scenario Choices

The scenario uses named actors and realistic details:

- Principal: Taylor in Los Angeles.
- Guest: Daniel in New York.
- Meeting: Product review, 30 minutes, Google Meet.
- Delegation: Taylor cc's the configured assistant and asks it to coordinate.
- Provider: Google Calendar.
- Constraint: CalPal can send pre-approved options, but guest-proposed alternates require Taylor approval before booking.

## Interaction Model

The artifact supports six compact scrubber moments:

- `Taylor cc's assistant`: participant, purpose, and rough time window authorize the first scheduling email.
- `Assistant proposes held options`: the assistant replies with the configured public name and holds all proposed options.
- `Daniel replies`: Daniel accepts an option, proposes alternatives, or answers ambiguously by email.
- `Assistant books accepted option`: final recheck passes, the event is written, and unused holds are released.
- `Alternate needs Taylor`: CalPal detects a viable guest-proposed alternate but asks Taylor before booking it.
- `Clarify`: CalPal asks Daniel one specific clarifying question before escalating to Taylor.

The top control jumps to the guest reply moment. The reply buttons inside the email thread drive the happy path, alternate approval path, and clarification path. On mobile, the old timeline cards are hidden so the thread remains the first useful surface.

## Intentional Cuts

These were left out to keep fidelity low and focused:

- No public booking page.
- No rescheduling flow.
- No inbox-wide email automation.
- No authentication, billing, admin, teams, or Outlook setup.
- No real calendar provider integration.
- No packet-review or spec-ledger UI.

## Files

- `workbench.html`: self-contained wired artifact.
- `README.md`: this creation note.

The production-grade Build Preview lives under `examples/calpal-scheduling/artifacts/previews/` and is not used by this artifact. (An earlier low-fidelity wireframe direction was removed once Build Preview moved to a production-grade quality bar.)

## Verification

Recommended commands from the repo root:

```bash
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' examples/calpal-scheduling/artifacts/agent-workbench/2026-06-19-calpal-scheduling/workbench.html > /tmp/calpal-email-artifact-script.js
node --check /tmp/calpal-email-artifact-script.js
node bin/foo asp validate examples/calpal-scheduling
node bin/foo asp reconcile examples/calpal-scheduling --as-of 2026-06-19T20:00:00Z
```

Visual checks should cover desktop and mobile because the artifact relies on side-by-side email and agent-state panes on larger screens.

Feedback checks should cover selecting a target, saving a comment, seeing the selected target count badge, and copying the Markdown or JSON bundle.

## How To Continue

Use this artifact as the baseline for product shaping, but keep the next pass tightly focused on the email-native delegated scheduling loop:

`Taylor cc's assistant -> assistant extracts intent -> checks Google Calendar -> proposes guest-safe held options -> parses Daniel's reply -> rechecks availability -> books accepted proposed option -> releases unused holds -> confirms in-thread.`

Do not add dashboard, settings, onboarding, Outlook, booking pages, fallback forms, provider expansion, or richer scenario chrome in the next pass. If visibility is added, it should prove private-to-public translation, approval boundaries, or writeback safety.

Keep reviewer-only context separate from product UI. The behind-the-scenes pane and calendar strip are shaping aids, not screens Taylor or Daniel should experience.
