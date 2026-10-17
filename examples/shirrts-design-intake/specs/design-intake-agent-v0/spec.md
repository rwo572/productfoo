---
spec_id: dia_v0
title: Design Intake Agent V0
mode: product-definition
lifecycle: active
stage: building
owner: shop-owner
autonomy: human-in-loop
updated: 2026-07-12
---

# Design Intake Agent V0

## Intent

Replace the fixed custom-design intake form with an agent that interviews the customer and produces a design brief the shop can cut fabric from — so an order arrives ready to cut instead of starting an email thread.

## Current Understanding

The form we ship today is `src/intakeForm.ts`: five fields (garment, size, color, quantity, and a free-text "describe your design"), each with a shallow check. It cannot ask a follow-up question, so the one field that carries the design — `designDescription` — accepts "something cool" and passes validation. It also has no placement field at all: `guessPlacement` returns `null` because the form never asked where the artwork goes.

Roughly half of submissions reach the shop unusable. Each one becomes a manual email thread that asks the follow-ups the form could not: where does it go, how many colors, what size run, is this a character you own.

The unit of work here is not a better prompt. It is a product: an interviewing agent with a defined set of questions it must land, a defined set of requests it must refuse, and a defined artifact it must produce. That is what this packet specifies.

## Requirements

### R-001 — The agent asks follow-up questions

The agent never accepts a vague design answer as the design. "Something cool", "you decide", "surprise me", "whatever looks good" and their kin are rejected as answers and re-asked with a concrete follow-up. The interview does not advance on a vague answer; it loops on that question.

### R-002 — Pin down what fabric-cutting depends on

Before the interview can finish, the agent must have landed all five things the cutting table depends on: garment, size run, artwork placement, artwork colors, and quantity. Missing any one of them means the interview is not finished, and the agent must be able to name which one is still open.

### R-003 — Refuse and escalate rights problems

The agent refuses to take a design that names a copyrighted character or a trademarked logo, and escalates it to the shop owner instead of silently declining or quietly proceeding. A refusal states which rule it hit and what the customer can do instead.

### R-004 — Produce a design brief the shop can act on

The interview's output is a structured design brief carrying every cut-critical field, the customer's own words for the artwork, and the refusals raised during the interview. A brief is only emitted when the interview is complete; an incomplete interview yields the list of what is still open, never a half-brief.

### R-005 — Printable customer confirmation

The customer gets a printable, plain-language summary of the brief to confirm before the shop cuts anything. It restates the order in the customer's language, not the shop's field names, and it carries a confirm-or-change prompt.

## Decisions

- **D-001 — An agent, not a longer form.** Adding fields (a placement dropdown, a colors picker) was the cheaper move and we rejected it: the failure is not a missing field, it is the absence of a follow-up. A form with twelve fields still cannot ask "you said three colors — which three?"
- **D-002 — The vagueness check is a rejection, not a hint.** A soft "could you add more detail?" that still accepts the answer reproduces today's failure. The interview must refuse to advance.
- **D-003 — Rights problems escalate to the owner, they do not just decline.** A flat "no" loses the order. The owner wants to see these — some are fine with a license, and she is the one who decides.
- **D-004 — Placement is a cut-critical field.** It is the field the current form omits entirely, and the single most common reason a submission becomes an email thread.

## Risks

- **Over-refusal.** A too-eager rights check flags "dragon" or "my dog Ripley" and annoys a paying customer. Mitigation: match on a named list plus explicit ownership language, not on vibes; escalate rather than decline.
- **Under-refusal.** A missed trademark reaches the cutting table and the shop eats a print run. Mitigation: the refusal list is a data file the owner can extend without a code change.
- **Interview fatigue.** Too many questions and the customer leaves. Mitigation: five cut-critical questions, and the agent only follows up when the answer is actually unusable.

## Validation

- Unit tests in `test/interview.test.ts`: a vague answer is rejected and re-asked; a concrete answer advances; the interview cannot finish with a cut-critical field open; a copyrighted character raises an escalating refusal; a completed interview emits a brief carrying all five cut-critical fields.
- Unit tests in `test/refusals.test.ts`: a named character and a named brand each refuse and escalate; an ordinary design does not.
- `npx tsc --noEmit` is clean and `npm test` passes.
- A real transcript, run end to end, produces a brief the shop owner agrees she could cut from (manual review bar).

## Evidence

- `src/intakeForm.ts` `guessPlacement` returns `null` and says so in a comment: the form never asked. That is the omission this packet fixes.
- `validateIntakeForm` accepts any non-empty `designDescription`, so "something cool" is a passing submission today.

## Non-Goals

- Pricing, payment, or checkout. The brief is what the shop cuts from; what it costs is a separate conversation.
- Art generation. The agent interviews; it does not draw.
- Replacing the shop's existing order database.

## Open Questions

- **OQ1** — Should the refusal list ship with a starter set of well-known trademarks, or start empty and grow from the owner's own escalations?
