---
spec_id: reengagement_v0
title: Inactive-User Re-engagement Email V0
mode: product-definition
lifecycle: active
stage: shaping
owner: founder
autonomy: human-in-loop
updated: 2026-07-14
---

# Inactive-User Re-engagement Email V0

## Intent

Win back accounts that signed up and stalled — without emailing the customers who never stalled at all, and who happen to be the ones paying the most.

## Current Understanding

The request was four words: *email our inactive users.* The schema answers almost none of it.

`users.last_login_at` is the only per-user timestamp in the database. `documents` and `comments` carry an `author_id` but no `created_at`. `api_keys` and `api_requests` are scoped to a **team**, not a person. So the one signal available for "inactive" is *did this human open the web app* — and that is not what inactive means.

The failure this packet exists to prevent is concrete: an account that hammers the API every day through a service key, whose human has not logged into the dashboard since March, is "inactive" under the obvious query. They are also, by volume, the best customer on the list. The obvious build sends them a "we miss you!" email. That mistake is unrecoverable — you cannot unsend.

This is not a hypothetical about a careless agent. Run *"add a feature to email our inactive users"* against this exact schema four times, and a competent coding agent warns you about the API customer **twice** — and says nothing the other two times. The judgment is real, it is good, and it is a coin flip. The point of this packet is to make it survive.

## Requirements

### R-001 "Inactive" means no activity, not no login

- Priority: P1
- Risk: high
- Confidence: high

Inactivity is computed from every available signal of a person actually getting value — API traffic on their team, documents and comments they authored — never from `last_login_at` alone. Any account with real activity inside the window is not inactive, whatever the login column says.

### R-002 Nothing sends without a human release

- Priority: P1
- Risk: high
- Confidence: high

The job drafts a batch; a person reads it and releases it. No code path in V0 reaches the mailer without an explicit human action, and no schedule fires on its own.

### R-003 The dry run names names

- Priority: P1
- Risk: medium
- Confidence: high

Before the first send, the job emits every recipient with the reason it was selected. A count is not a dry run. The list is the artifact a human reads in order to release.

### R-004 The heaviest accounts are provably excluded

- Priority: P1
- Risk: high
- Confidence: high

The ten accounts with the most API traffic in the window appear in no recipient list, checked mechanically rather than by eye — the whole point is that a human scanning 400 rows will not spot the one that matters.

### R-005 Every recipient carries its reason

- Priority: P2
- Risk: medium
- Confidence: medium

Each row in the batch records which signals were checked and when each last fired. A recipient with no legible reason is a bug, not a send.

## Decisions

- **D-001 (agreed) — Activity, not login.** The cheap build (`WHERE last_login_at < now() - 30 days`) was rejected. It is one line, it is what the schema invites, and it emails your best customer. The cost is real: activity must be derived from team-scoped tables, which means a new per-user signal.
- **D-002 (agreed) — Draft-and-release, not send-on-a-schedule.** The literal request was to *automate* it. We are not automating the send. An unattended sender is a loop, and a loop needs a budget, terminal states, and an approval boundary (B4) — a contract we have not written and do not need in order to learn whether the email works at all.
- **D-003 (agreed) — The exclusion is a test, not a habit.** "Remember not to email the API customers" is not a mitigation, it is a wish. R-004 is enforced by an assertion that fails the build.
- **D-004 (agreed) — A missing signal excludes, it never includes.** If we cannot tell whether an account was active, it is not mailed. The asymmetry is brutal: a missed win-back costs nothing visible; a wrong send costs a customer.

## Risks

- **The activity signal is incomplete.** `documents` and `comments` have no timestamps, so "authored recently" is currently uncomputable per user. V0 leans on team-level API traffic, and D-004 turns the gap into an exclusion rather than a bad send. The missing columns are T-001.
- **Nobody releases the batch.** A draft that requires a human is a draft a busy founder never sends, and the feature quietly does nothing. This is the strongest argument against D-002 and it is **not resolved** — it is a cost we are choosing, not a cost we are denying.
- **Over-exclusion.** Lean hard enough on D-004 and the list is empty, which looks like safety and is actually failure. The dry run therefore reports how many accounts were excluded and why, so an empty list is legible rather than mysterious.

## Validation

- `test/inactive.test.ts` — an account with API traffic in the window is never selected, even with a null `last_login_at`; an account with no signal at all is excluded rather than included; every selected row carries a non-empty reason.
- `test/release.test.ts` — no code path reaches the mailer without an explicit release call, and the scheduled entrypoint does not exist.
- `npm run email:inactive -- --dry-run` prints every recipient with its reason and sends nothing.
- R-004 is checked mechanically: seed the ten heaviest API accounts, run the selector, assert none appear.

## Evidence

- `schema.sql` — `users.last_login_at` is the only per-user timestamp; `api_keys` and `api_requests` are team-scoped. This is why the obvious query is wrong.
- `src/mailer.js` — Resend is wired and live, so "it accidentally sent" is one careless import away. That is what R-002 exists to prevent.
- Four independent runs of the naive request against this schema: two warned about the API customer, two did not. The judgment is a coin flip, which is why it is written down instead of remembered.

## Non-Goals

- Sending on a schedule. That is a loop, and it needs a budget and a contract before it is allowed to exist (B4).
- Email copy, subject lines, send-time optimization. *Who receives this* is the whole risk; what it says is a separate, cheaper problem.
- Backfilling `created_at` across historical rows. V0 works with what exists.

## Open Questions

- **OQ1** — Is a lapsed trial "inactive" (win them back) or "churned" (a different email, or none)? A positioning call, not a data question, and the owner's alone.
- **OQ2** — Does a team's API traffic count as activity for *every* member of that team, or only for the member whose key it is? The schema cannot tell them apart today, and the answer changes who gets mailed.
