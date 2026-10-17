# Product Shape Brief

Source: examples/calpal-scheduling/spec.md
Run ID: 2026-06-20-calpal-email-delegation
Status: draft
Created: 2026-06-20T00:00:00-07:00

## Optimization Target

End-to-end scenario realism. The artifact should make CalPal feel like delegated scheduling help in an existing email thread, not a scheduling-link builder, packet-review UI, or traditional wireframe gallery.

The reviewer should be able to feel the loop from Taylor cc'ing CalPal through guest coordination, final availability recheck, calendar writeback, hold cleanup, and approval boundaries.

## Artifact Type

Scenario workbench.

The primary artifact should be a low-fidelity but realistic HTML simulation of one scheduling delegation workflow. It should prioritize realistic interaction, state, and agent behavior over visual polish or divergent design directions.

## Primary Scenario

Taylor cc's CalPal on an email thread with Daniel and asks it to coordinate a 30-minute product review next week.

CalPal reads the thread, extracts participant, purpose, duration, and rough time window, checks Taylor's calendar, proposes safe held options to Daniel, waits for Daniel's reply, rechecks availability, books an accepted proposed option, releases unused holds, and preserves a concise audit trail.

The artifact should also include two branch moments:

- Daniel proposes an alternate time that fits Taylor's calendar but was not pre-approved, so CalPal asks Taylor for quick approval before booking.
- Daniel replies ambiguously, so CalPal asks one specific clarification in-thread before interrupting Taylor.

## Primary Reviewer

A product reviewer evaluating whether CalPal's agentic EA model feels useful, safe, and credible enough to build.

The reviewer is not the end user inside the product. Taylor and Daniel experience the email thread. The reviewer-only context pane exposes what CalPal read, inferred, checked, held, proposed, and refused to do.

## Product Model

Email-native delegated assistant with reviewer-only agent context.

The product surface is the existing email thread. CalPal is a disclosed delegated assistant acting on Taylor's behalf. Calendar state, holds, privacy translations, and approval boundaries are supporting context, not the primary guest-facing surface.

This is closer to an operating surface for delegated work than a dashboard, booking page, public link builder, or calendar settings app.

## Core Objects

- `email_thread`: the conversation among Taylor, Daniel, and CalPal.
- `delegation_instruction`: Taylor's cc-based scheduling request with participant, purpose, and rough time window.
- `meeting_intent`: product review, 30 minutes, next week, Google Meet.
- `principal`: Taylor in Los Angeles.
- `guest`: Daniel in New York.
- `calendar_snapshot`: Taylor's private calendar reality, including busy events, buffers, and freshness.
- `availability_option`: guest-safe proposed times in host and guest timezones.
- `calendar_hold`: temporary protection for proposed options, expiring after the proposed window or 48 hours.
- `guest_reply`: accepted option, proposed alternate, or ambiguous response.
- `approval_request`: Taylor's quick approval for guest-proposed alternates.
- `calendar_writeback`: final Google Calendar event creation after recheck.
- `audit_trail`: visible record of what CalPal believed, checked, sent, held, released, and booked.

## Agent Loop

`read -> infer -> check -> hold -> send -> wait -> parse -> recheck -> decide -> book or ask -> release -> confirm -> export/audit`

CalPal should:

- read the email thread before asking Taylor anything;
- infer meeting intent only when participant, purpose, and rough timing are present;
- check calendar availability, buffers, minimum notice, and timezone context;
- translate private calendar reality into guest-safe options;
- hold all proposed options while waiting for Daniel;
- parse Daniel's reply from email without requiring an account;
- recheck availability before any writeback;
- book an accepted proposed option when it still matches Taylor's delegated instruction;
- release unused holds immediately after booking;
- ask Taylor before booking guest-proposed alternates;
- clarify ambiguous guest replies once before escalating;
- avoid sending false confirmations after stale availability or failed writeback.

## Human Decision

The artifact should help the reviewer decide:

Does CalPal's email-native delegated assistant loop feel more valuable and trustworthy than a scheduling link, while keeping Taylor in control at the right approval boundaries?

Secondary decisions:

- Does the reviewer-only context pane show enough reasoning without turning the product into an operations dashboard?
- Does the approval model feel right for accepted proposed options versus guest-proposed alternates?
- Does the dummy data make privacy, timezone, stale availability, and writeback risks concrete?

## Realistic Dummy Data Contract

Use named, domain-specific data instead of placeholder boxes.

Actors:

- Taylor Fixture, principal, Los Angeles, Pacific time.
- Daniel Cho, guest, New York, Eastern time.
- CalPal, disclosed delegated assistant.

Meeting:

- "Product review"
- 30 minutes
- Google Meet
- Target window: next week

Email data:

- Taylor's original delegation with CalPal cc'd.
- CalPal's disclosed assistant reply to Daniel.
- Daniel accepting a proposed option.
- Daniel proposing "Friday after 2 ET" as an alternate.
- Daniel replying "morning works" as an ambiguous response.
- CalPal asking Taylor "Approve booking it?" for the guest-proposed alternate.
- CalPal asking Daniel one clarifying question when the guest reply lacks date or timezone.

Calendar data:

- Private event at 9:30 AM PT with title hidden from Daniel.
- Tue Jun 24 at 10:30 AM PT / 1:30 PM ET as an available proposed option.
- Wed Jun 25 at 9:00 AM PT / 12:00 PM ET as an available proposed option.
- Thu Jun 26 at 11:00 AM PT / 2:00 PM ET as an available proposed option.
- Fri Jun 27 at 11:30 AM PT / 2:30 PM ET as a viable guest-proposed alternate requiring Taylor approval.
- Holds marked active, released, expired, or booked.
- Last-checked timestamps that distinguish fresh availability from stale availability.

Privacy data:

- Private event title, attendees, notes, location, and calendar identifier are available to CalPal but never exposed to Daniel.
- Guest-facing language should say available options or unavailable windows without explaining why Taylor is unavailable.

Avoid fake precision:

- Do not invent numeric confidence scores, ROI, productivity gains, or exact automation quality metrics.
- Use qualitative confidence and visible evidence, such as "fresh", "needs Taylor", "stale", "blocked", or "recheck required".

## Required States

- Delegated: Taylor has cc'd CalPal with enough instruction to begin.
- Proposed: CalPal has sent guest-safe options and placed holds.
- Waiting: Daniel has not replied yet and holds remain active.
- Accepted proposed option: Daniel chooses a pre-approved option.
- Final recheck passes: CalPal can book and release unused holds.
- Guest-proposed alternate: time is viable but requires Taylor approval.
- Ambiguous guest reply: CalPal asks Daniel one clarifying question.
- Stale or conflicting availability: CalPal does not book or falsely confirm.
- Writeback failure: CalPal shows recovery path without sending a false confirmation.
- Completed: Google Calendar event exists, unused holds are released, thread is confirmed, audit trail is saved.

## Trust And Provenance

The artifact must make private-to-public translation visible:

- What CalPal can see: private calendar events, buffers, holds, freshness, guest reply parse.
- What Daniel can see: safe proposed options, timezone labels, concise assistant language.
- What Taylor controls: original delegation scope, quick approval for guest-proposed alternates, cancellation or revised instructions.

The reviewer-only agent context should show:

- CalPal's read of the email thread.
- What it believes is safe to do.
- What evidence supports the next action.
- What it is waiting on.
- What requires Taylor's approval.
- What would make the action unsafe.

## Visual And Interaction Posture

Use a low-fidelity wired application artifact, not a polished marketing page.

The first useful surface should be the email thread. Reviewer controls should be compact and clearly separate from the product UX. The artifact should have enough application realism to feel inspectable, including responsive behavior for desktop and mobile:

- Desktop: email thread as the main pane, reviewer-only agent context and calendar state as supporting panes.
- Mobile: tabbed review surfaces for `Thread`, `Context`, and `Calendar`, with `Thread` as the default.

Use restrained styling, realistic copy, direct controls, and clear state transitions. Do not rely on gray skeleton boxes as primary content.

## Non-Goals

- Do not generate four divergent directions.
- Do not create a public booking page as the primary artifact.
- Do not make the artifact a packet-review dashboard or spec-ledger UI.
- Do not add dashboard, settings, onboarding, rescheduling, travel planning, inbox-wide automation, billing, admin, teams, multi-principal delegation, Outlook support, fallback forms, booking pages, or provider expansion.
- Do not directly edit canonical packet files from static HTML.
- Do not expose private calendar metadata to Daniel.
- Do not imply Google Calendar writeback is implemented beyond the artifact simulation.
- Do not let reviewer-only context become product UI. Behind-the-scenes panes may explain agent behavior for shaping, but Taylor and Daniel should experience the email thread.

## Open Questions

- How much reasoning should CalPal show by default before it feels noisy?
- After the email-native loop is proven, should ambiguous replies get a fallback form, or should CalPal stay purely email-native?
- What exact Google Calendar hold semantics should the product use when provider credentials and sandbox behavior are approved?
- Should attendee invitation emails be sent by Google Calendar or CalPal after writeback?

## Generator Prompt

Use $wireframe-swarm on examples/calpal-scheduling/artifacts/shapes/2026-06-20-calpal-email-delegation/shape.md, but treat the Shape Brief as authoritative: generate one email-native scenario workbench, not divergent wireframe directions.

Generate one self-contained HTML artifact under examples/calpal-scheduling/artifacts/agent-workbench/<run-id>/workbench.html. Optimize for the approved scenario, realistic dummy data, agent behavior, approval boundaries, and private-to-public translation. Do not generate four directions unless this Shape Brief is revised to make comparison the optimization target.

Roast-driven constraint: focus only on the email-native delegated scheduling loop:

`Taylor cc's assistant -> assistant extracts intent -> checks Google Calendar -> proposes guest-safe held options -> parses Daniel's reply -> rechecks availability -> books accepted proposed option -> releases unused holds -> confirms in-thread.`

Do not add dashboard, settings, onboarding, Outlook, booking pages, fallback forms, provider expansion, or extra product surfaces. If you add visibility, make it prove private-to-public translation, approval boundaries, or writeback safety. Keep reviewer-only context separate from product UI.

Pincus lens: treat CalPal through Proven / Better / New.

- Proven: people already understand delegating scheduling in an email thread and receiving calendar invites.
- Better: CalPal must make that proven loop feel safer and less effortful by checking Google Calendar, using guest-safe language, holding options, rechecking before writeback, and asking Taylor only at the approval boundary.
- New: the agentic EA behavior is the one novel bet. Do not add more novelty until the email-native Google Calendar loop is proven.
