---
spec_id: calpal_scheduling_v0
title: CalPal Agentic EA V0
mode: greenfield
lifecycle: active
stage: shaping
owner: product
autonomy: human-in-loop
updated: "2026-06-19T00:00:00-07:00"
---

# CalPal Agentic EA V0

<!-- Identity (`spec_id`) is read from the YAML frontmatter above. Progress is rendered by `foo asp status`, never stored here. -->

## Intent

Create a fictitious agentic executive assistant that helps a user hand off scheduling work in natural language, protects their calendar and private context, negotiates with guests when needed, and commits meetings only when the action is safe or explicitly approved.

This example is intentionally product-domain specific so Adaptive Spec Packet readers can understand the format without confusing the example assistant with the Adaptive Spec Packet format itself.

## Current Understanding

CalPal is not primarily a scheduling-link builder. CalPal is an agentic EA for small-team operators and independent executives who want to stop managing scheduling logistics themselves.

V0 focuses on one principal delegating a scheduling request to CalPal from an email thread. Taylor cc's CalPal, gives a specific instruction, and CalPal reads the thread, checks Taylor's calendar, proposes safe held options to the guest, protects private calendar metadata, asks for approval at the right moments, and writes the confirmed meeting back to Google Calendar.

V0 does not include enterprise admin, billing, multi-principal delegation, inbox-wide email automation, travel planning, rescheduling, full calendar replacement, public booking pages, or autonomous outreach without a specific cc-based delegation.

## Experience Thesis

The user should feel like they have delegated scheduling to a competent EA, not configured a booking form.

The assistant should:

- understand the scheduling goal from a plain-language request;
- inspect calendar reality before asking the user anything;
- coordinate in the existing email thread as a disclosed assistant;
- expose only the minimum safe information to guests;
- hold proposed options while waiting for the guest and clean them up promptly;
- negotiate or propose alternatives when the first option is not possible;
- escalate only when the choice requires judgment, risk appetite, or permission;
- keep the user informed about what it believes, why, and what it will do next.

## Requirements

### R-001: Interpret scheduling intent

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

The user must be able to cc CalPal on an email thread and ask for scheduling help in natural language, such as "CalPal, find 30 minutes with Daniel next week for a product review." CalPal must extract the meeting goal, participants, duration, timing constraints, urgency, and missing information.

A specific enough instruction for V0 includes participant, meeting purpose, and a rough time window. CalPal may infer sane defaults and should ask Taylor only when missing information changes the scheduling decision, privacy boundary, or approval scope.

CalPal should inspect available artifacts before asking follow-up questions. It should ask the user only when the missing answer requires personal judgment, privacy approval, or a choice between materially valid options.

### R-002: Build an availability strategy

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

CalPal must compute a scheduling strategy from working hours, busy events, buffers, minimum notice, meeting duration, user preferences, guest constraints, and calendar freshness.

The strategy should explain which options CalPal believes are best and why, including confidence, known constraints, and what would make an option unsafe.

### R-003: Coordinate with guests without forcing an account

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: medium

CalPal must coordinate with a guest in the existing email thread as a disclosed delegated assistant acting on Taylor's behalf. The guest does not need a CalPal account or public booking page.

Guest-facing communication should feel like a concise assistant interaction, not a generic booking page. CalPal may present pre-approved options, explain timezone context, ask for alternatives if none work, and ask one clarifying question if a reply cannot be parsed, but it must not expose private host calendar context.

### R-004: Protect against stale or conflicting calendar state

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

CalPal must place temporary holds on all proposed options while waiting for the guest. Holds expire at the end of the proposed window or after 48 hours, whichever comes first.

Before committing any meeting, CalPal must recheck availability and reject, refresh, or renegotiate stale options that became unavailable. If held options become invalid before the guest replies, CalPal refreshes the guest with remaining valid options using only availability-safe language and involves Taylor only if no valid options remain.

If a conflict appears after a guest accepts a time, CalPal must avoid creating a bad event, avoid sending a false confirmation, and recover with a clear next step for the guest and Taylor.

### R-005: Handle timezone and context translation

Priority: must
Confidence: medium
Evidence: derived
Needs validation: true
Risk: high

CalPal must translate time clearly between the user's timezone, the guest's timezone, and the calendar provider's event representation.

The assistant should make timezone assumptions explicit when they affect the decision. It should avoid over-explaining when both sides are in the same timezone or when the context is already unambiguous.

### R-006: Commit meetings with appropriate approval

Priority: must
Confidence: medium
Evidence: derived
Needs validation: true
Risk: high

When a meeting is ready to commit, CalPal must create a Google Calendar event for the user and include the guest as an attendee when provider permissions allow it.

CalPal must use an approval model based on delegation, stakes, and reversibility:

- auto-apply low-risk, reversible preparation work;
- treat Taylor cc'ing CalPal with a specific enough instruction as approval to send the first scheduling email;
- book an accepted proposed option after final recheck when it still matches Taylor's delegated instruction;
- release unused holds immediately after booking the accepted option;
- ask Taylor for quick approval before booking a guest-proposed alternate, even when the alternate fits Taylor's calendar;
- suggest and apply for high-stakes reversible edits;
- require explicit approval before sending outreach, committing calendar changes, or disclosing sensitive context.

### R-007: Protect calendar privacy and user discretion

Priority: must
Confidence: high
Evidence: human-judgment
Needs validation: true
Risk: high

CalPal must not expose private event titles, attendees, notes, locations, calendar identifiers, or inferred sensitive context to guests.

The assistant should translate private calendar reality into safe public statements, such as available options, unavailable windows, or "I can offer these times," without explaining why the user is unavailable.

### R-008: Keep the user informed and in control

Priority: should
Confidence: medium
Evidence: human-judgment
Needs validation: true
Risk: medium

CalPal should maintain a visible email-native work state for delegated scheduling: what it believes, what it checked, what it is waiting on, what it has proposed to the guest, what holds are active, and what requires user approval.

Taylor should be able to intervene, revise instructions, approve, cancel, or ask why CalPal chose a path from email. CalPal should preserve a concise audit trail of decisions, holds, and external communications.

## Decisions

- D-001: V0 is an agentic EA for delegated scheduling, not a self-serve scheduling-link product.
- D-002: The principal actor is one host delegating scheduling work to CalPal.
- D-003: Google Calendar is the first calendar provider, hold surface, and writeback surface.
- D-004: Guests do not need CalPal accounts.
- D-005: CalPal is a disclosed delegated assistant; Taylor cc'ing CalPal with participant, purpose, and rough time window approves the first scheduling email.
- D-006: Private calendar metadata must never appear in guest-facing communication.
- D-007: Calendar writeback must be preceded by a final availability recheck.
- D-008: Timezone rendering is a trust and comprehension requirement, not cosmetic UI.
- D-009: Outlook support is plausible but not agreed for V0.
- D-010: Proposed options are held until the guest replies or until the end of the proposed window / 48 hour expiration.
- D-011: Guest-proposed alternate times require Taylor's quick approval before booking.
- D-012: V0 supersedes the public scheduling link / booking page with email-thread coordination.
- D-013: Rescheduling is out of scope for V0.

## Risks

- The assistant could overstep by contacting guests or committing meetings without enough approval.
- Holds could clutter Taylor's calendar if expiration and cleanup are not reliable.
- Calendar providers can return stale availability if sync is delayed.
- Timezone conversion errors can create missed meetings.
- Guest-facing communication could accidentally reveal private calendar metadata or sensitive inferred context.
- Email replies can be ambiguous or hard to parse.
- The assistant could ask too many questions and feel less useful than a manual scheduling link.
- Suggested provider integrations can become unbounded scope.
- External tracker status may claim done before the agentic scheduling loop is actually proven.

## Validation

V0 is valid when:

- A user can delegate a scheduling request by cc'ing CalPal on an email thread.
- CalPal extracts intent, participants, constraints, and missing information.
- CalPal inspects calendar availability before asking the user avoidable questions.
- CalPal proposes safe meeting options in-thread as a disclosed assistant.
- Proposed options are held while waiting for the guest and released when no longer needed.
- A guest can respond by email without a CalPal account or public booking page.
- Guest-facing communication does not expose private event metadata.
- Confirmation rechecks the slot before calendar writeback.
- Guest-proposed alternates route to Taylor for quick approval before booking.
- Confirmed meetings write to Google Calendar.
- Failed writeback or stale availability does not send false confirmation messages.
- Timezone cases pass for host and guest in different timezones.
- The example packet detects suggested Outlook work as unagreed scope.
- The example packet detects external tracker status that claims completion without mapped writeback evidence.

## Evidence

- `examples/calpal-scheduling/tasks.yaml`
- `examples/calpal-scheduling/events.jsonl`
- `examples/calpal-scheduling/integration-events.jsonl`
- `examples/calpal-scheduling/reconcile.ts`
- `examples/calpal-scheduling/artifacts/agent-workbench/2026-06-19-calpal-scheduling/workbench.html`

## Open Questions

- How much reasoning should CalPal show by default before it feels noisy?
- Should Outlook be accepted into V0 or stay suggested until Google writeback is proven?
- Should V0 include a lightweight fallback form if an email reply becomes too ambiguous, or should CalPal stay purely email-native?
