---
spec_id: cli_first_run_v0
title: "CLI First-Run That Feels Simple"
mode: capability
lifecycle: draft
stage: shaping
owner: product
autonomy: human-in-loop
updated: 2026-07-10
---

# CLI First-Run That Feels Simple

## Intent

An invited tester — or the coding agent working for them — goes from a hand-sent invite to their first proven task through one command, without ever learning productfoo's machinery. Set up once, works every session. Every line foo prints uses the simplest language that gets the point across.

The product bet: productfoo's machinery (packets, ledgers, remote skill delivery, boundaries) is a strength only while it stays invisible. Today's first-run exposes it everywhere — a 70-line help, a doctor that misdiagnoses the alpha client, credentials that die with the terminal window — and each exposure reads as complexity, which reads as "not for me." Invite #2 has a named candidate and a days-away clock; the core of this spec is what unblocks it.

Governing principle (user decision, 2026-07-10): never reveal productfoo's internal complexity to the end user or the coding agent. Plumbing that helps the agent keep things simple for the human (precise exit codes, one canonical next step) is in scope; teaching the agent productfoo's architecture is not.

## Current Understanding

Verified by running the CLI in a clean directory (2026-07-10) and by a six-lens expert swarm (`swarms/2026-07-10-cli-first-run-v0-first-run-that-feels-si.md`):

- The invite's `export` lines are session-scoped; there is no file fallback anywhere in `src/` (`skillDelivery.ts:27-32`). Day 2, or any agent shell, is unconfigured again — the top confusion generator, and it reads as "foo broke."
- `foo doctor` tells a healthy thin-client install to reinstall (`src/commands/setup.ts:149` — `installed` derives from skills-on-disk, absent by design); `foo agent doctor` prints `[object Object]`; git stderr leaks through.
- Missing credentials are typed as "skill not found" (`skillDelivery.ts:104-108`) — the exact conflation this spec bans.
- The skill server has no way to answer "are these credentials good?" — only `GET /disclosure` (unauthenticated) and `GET /skills/:name` (metered, rate-limited, allowlisted) (`skillServe.ts:102-152`).
- README and ALPHA-INSTALL.md tell contradictory install stories; ALPHA-INSTALL.md carries a literal unfilled placeholder.
- `foo init` already embodies the principle (invisible packet scaffold, plain-English read, `PM_SURFACE_FORBIDDEN` word list with a regression test) — this spec extends that pattern to every first-run surface.
- Error text derives a fingerprint from the plaintext token (`skillDelivery.ts:67-68`); agents paste terminals into third-party models.
- A real alpha token pasted into a committed file would slip the secret gate: no detector knows productfoo's own token shape (`redactGate.ts:24-30`, `redactEngine.ts:112-113`).

Supersedes the onboarding sequencing of `specs/alpha-onboarding-v0` (lifecycle: done). Origin: ideate record `ideas/2026-07-10-the-cli-first-run-what-a-new-alpha-teste.md`.

## Requirements

### R-001 Credentials persist — set up once, works every session

- Priority: P1 (core — gates invite #2)
- Risk: medium
- Confidence: high

The invite's paste block writes the two credential values to one protected file (`~/.config/foo/credentials`, mode 0600). Resolution order: environment first, then the file. Every "not set up yet" message names that one file path as the single next step. ALPHA-INSTALL's "nothing is written to your disk" promise is rewritten honestly: the skill text claim stays true; the new line reads like "your invite key lives in one file on your machine — delete it to sign out."

### R-002 A quiet wiring check inside `foo init`

- Priority: P1 (core)
- Risk: medium
- Confidence: high

`foo init` verifies the credentials actually work (a live round-trip, not a presence check) before its repo read. One shared primitive (in `skillDelivery.ts`) owns the verdict and its wording; `foo init`, the doctor, and `foo skill` all consume it — nobody re-derives status. States are never conflated: not-set-up / access-denied / network / our-bug each get their own plain-words line and their own exit code (0 ok · 2 not-set-up · 3 access-denied · 4 network · 5 our-bug) as agent-only plumbing. The check never blocks init's offline work: the repo read and scaffold always complete; the wiring verdict is one final line; timeout ~2 seconds. When skills are present locally (`skills/` on disk), wired = true with zero network. Exit codes report wiring; stdout reports the scaffold — one integer never reports both. The network-failure wording names the sandboxed-shell case and gives one escape-hatch step. `foo init --json` gains a single wiring field; bare `foo` gets no JSON flag.

### R-003 A server endpoint the check can trust

- Priority: P1 (core)
- Risk: medium
- Confidence: high

The skill service gains one authenticated, unmetered, rate-limit-exempt probe route that answers "these credentials are good" without touching the per-token catalog or the usage metering. Server deploys before the client ships. If the client meets an older server (route missing), it falls back to a designated always-available skill fetch and treats a definitive yes/no as the verdict, indeterminate as not-broken.

### R-004 The doctor reassures

- Priority: P1
- Risk: low
- Confidence: high

On a healthy install the doctor's whole story is "you're ready — start with `foo init`." The word "reinstall" never appears on a healthy alpha client (fix the `setup.ts:149` conditional). It checks the credentials (today it never does), consumes the R-002 primitive, captures all subprocess noise (no `fatal:` leaks), and fixes the `[object Object]` rendering in `foo agent doctor`. Outcome language only.

### R-005 The invite is one committed template

- Priority: P1 (core — gates invite #2)
- Risk: low
- Confidence: high

One committed template file holds the canonical paste block: it writes the credentials file (R-001), installs, and ends with `foo init` — one command to remember. Placeholders are structurally incapable of looking like real tokens. README and ALPHA-INSTALL embed the same block between markers; a test fails if they ever differ from the template.

### R-006 Output hygiene: simple words, no machinery, no secrets

- Priority: P1
- Risk: low
- Confidence: high

Every first-run surface uses the simplest language that gets the point across — short sentences, everyday words (user decision, 2026-07-10). Machinery words (the forbidden list: "thin client", "skill server", "packet", and peers — final list settled at build) never render on first-run surfaces. All first-run strings emit through one render module so the eval covers them by construction. No output ever derives a fingerprint from the plaintext token — identifiers come from the server-side token id pattern (`skillServe.ts:145`). Every stopping point ends with one runnable next step; no dead ends.

### R-007 The eval set — simplicity as tests

- Priority: P1
- Risk: medium
- Confidence: high

Shipped as tests and recorded evidence, not vibes:

- (a) Forbidden-words scan over the full first-run corpus (by construction via R-006's render module), case-insensitive, word-boundary aware.
- (b) Default help ≤ ~20 lines (paired with a line-width cap so it can't be met by cramming) — active once R-010 lands.
- (c) No dead ends: every first-run message ends with one runnable next command.
- (d) Doctor-never-lies: "reinstall" absent on a healthy install fixture.
- (e) Failure classes distinct: not-set-up / access-denied / network / our-bug produce different messages AND different exit codes, tested with throwaway in-process fakes (an ephemeral listener per test — no standing mock server, runs free in CI).
- (f) Docs-match-template: README and ALPHA-INSTALL blocks byte-match the template file.
- (g) Golden path: scripted non-interactive run in a fresh-HOME sandbox — paste block → first proven task, no doc reading (scored by checking the transcript for doc reads, not by feel). Run twice, and the second run starts from a fresh shell inheriting nothing but the credentials file (this is the day-2 test). Manual per dist release; transcript and exit codes committed to this packet as evidence. Never in CI. Revisit before tester #4.
- (h) Eval-never-lies: the golden-path script contains zero pre-seeded approvals or override flags a real tester wouldn't have. A foo gate firing on the golden path is a spec bug, filed as drift — resolved by shaping the first task, never by weakening a boundary.
- (i) Secret safety: the template, README, and ALPHA-INSTALL scan clean (`foo scan --exit-code`); a negative fixture with a synthetic real-format token in the template path is blocked by `foo self gate`.
- (j) Judged pass, once per tester onboarding (no timer, no standing infra): the real onboarding transcript scored against three questions — could they proceed without knowing foo internals; was every message's next step the one taken; was any message re-read or retried.

### R-008 Alpha tokens get a recognizable shape

- Priority: P2
- Risk: medium
- Confidence: medium

Tokens are minted with a structured prefix (e.g. `foo_at_…`) and a dedicated high-confidence detector joins the secret scanner (same pattern as the existing `sk-ant-` detector), so a real token pasted into the template is blocked at commit time. Requires re-keying tester-0 — sequence it so it never collides with invite #2.

### R-013 Learn dissolves into init (D-011)

- Priority: P2 — rides with the init work in R-002, never blocks invite #2
- Risk: low
- Confidence: high

Init's first-ever run in a repo opens with two orientation lines in the simplest words ("productfoo helps you agree on work before building, and prove it when it's done"), then goes quiet forever. Init outside a repo prints the short story plus "cd into a project and run me again" — the empty state is the orientation. `foo learn` becomes an alias that runs init; the alias's output joins the first-run eval corpus. The old static learn screen is deleted, not maintained in parallel.

### R-009 Bare `foo` points instead of failing

- Priority: P2 — gated by R-011
- Risk: low
- Confidence: high

Typing `foo` alone prints two plain lines on stdout (what this is, and "start with `foo init`"), exit 0. Repo evidence confirms nothing depends on today's exit-1.

### R-010 Help fits on one screen

- Priority: P2 — gated by R-011; first against the wall per the cut order
- Risk: low
- Confidence: high

Default `--help` shows only the human commands; everything else moves behind a flag. A snapshot test holds the line count.

### R-011 The probe runs before the polish

- Priority: P1 (sequencing gate for R-009/R-010)
- Risk: low
- Confidence: high

Before building R-009/R-010: replay tester-0's usage from productfoo's own telemetry events and server-side metering only — command families, exit codes, timestamps. Never shell history, flag values, or paths (user decision). If bare `foo` and help were never visited pre-activation, R-009 ships anyway (it's two lines) and R-010 is deprioritized or cut.

### R-012 The ship line

- Priority: P1
- Risk: low
- Confidence: high

Invite #2 (named candidate, days away) is gated on the core only: R-001, R-002, R-003, R-005, plus evals (e), (f), (g), (i) passing on a clean machine. R-004 and R-006 ship in the same window if ready; R-008–R-010 never block the invite. This spec closes on observed activation — a real external tester reaches their first proven task after the new first-run — with a two-week fallback (probe evidence stands in if the tester goes dark).

## Decisions

- D-001 (user, 2026-07-10) Governing principle: never expose productfoo's machinery to the end user or the coding agent; it must feel simple. Terminal output uses the simplest language that fits.
- D-002 (user, Q1 of interview) The front door is `foo init`; the invite's paste block ends with it; the wiring check lives inside it; bare `foo` becomes a pointer.
- D-003 (user, Q2 revised) The invite source of truth is a committed template file, not a generator command — invites are hand-sent at this scale. A generator can come later without rework.
- D-004 (user, swarm Q1) Credentials persist to one protected file, written by the paste block; disclosure wording rewritten honestly.
- D-005 (user, swarm Q2) The tester-0 probe reads productfoo's own telemetry only — never shell history.
- D-006 (user, swarm Q3) Invite #2 has a named candidate within days; the core-only ship line (R-012) is therefore live now.
- D-007 (carried expert answer) Golden-path eval runs manually per release with a committed transcript; failure-class evals run in CI with ephemeral in-test fakes. Revisit scoped CI before tester #4.
- D-008 (carried expert answer) One wiring primitive owns the verdict; consumers never re-derive it. Exit codes report wiring; stdout reports scaffold.
- D-009 (carried, from ideate round — not re-litigated) No claim-code/keychain auth, no funnel telemetry, no standing CI mock server, no new tester-facing commands. Falsifiers recorded in the ideate record.
- D-010 (assumption, user may override) Cut order under pressure: help fold first, bare-foo pointer second, never the wiring check or the template.
- D-011 (user, 2026-07-10) `foo learn` collapses into `foo init`. Init's first-ever run in a repo opens with two plain orientation lines (never shown again); init outside a repo prints the 60-second story instead of erroring; `foo learn` stays as a quiet alias for init (same precedent as shape→spec) and is retired when telemetry shows nobody types it. One door, one corpus for the evals, one fewer command in the help. Reversible: a standalone learn is the likely trailer surface if foo ever goes public. The "rebuild a recent commit's missing agreement" demo stays a later candidate, not V0 scope.

## Risks

- The wiring check adds productfoo's first network touch to a previously offline command; a sandboxed agent shell could read "network problem" when productfoo is healthy. Mitigated by R-002 (offline work never blocked, sandbox-aware wording, 2s timeout).
- Writing the token to disk widens exposure on shared machines. Mitigated by 0600 mode, honest disclosure, and the existing revocation path (revoked = next fetch fails).
- The manual golden-path eval gets skipped under deadline (the eval lens's standing dissent — minority report in the swarm record). Mitigated by making it the invite-#2 gate itself this round; revisit CI before tester #4.
- Re-keying tester-0 (R-008) could collide with the invite window. Mitigated by sequencing R-008 after invite #2 ships.
- One integer can't report two outcomes; if exit codes ever report scaffold state too, agents misread success. Settled by D-008; watch it in review.

## Validation

- Core evals (e), (f), (i) green in CI; eval (g) transcript committed to this packet from a clean machine, run twice with a fresh second shell.
- Invite #2 sent once R-012's line is met; activation observed (first proven task) or the two-week fallback documented.
- Doctor, init, and skill fetch all demonstrably consume one wiring primitive (inspection).
- Forbidden-words and language checks (a), (c), (d) green; judged rubric (j) recorded for the invite-#2 onboarding.
- `bin/foo asp validate specs/cli-first-run-v0` passes.

## Evidence

- Ideate record: `ideas/2026-07-10-the-cli-first-run-what-a-new-alpha-teste.md` (30 raw ideas → stress-tested shortlist; not-doing list with falsifiers).
- Swarm record: `swarms/2026-07-10-cli-first-run-v0-first-run-that-feels-si.md` (six lenses, routing table, minority report).
- Repo: `src/skillDelivery.ts:27-32,50,67-68,104-108`; `src/commands/setup.ts:131-152`; `src/skillServe.ts:16-18,102-152`; `src/initCommand.ts:206,230-381`; `src/redactGate.ts:24-30`; `src/redactEngine.ts:112-113`; `test/foo_cli.test.ts:3318-3337`; `ALPHA-INSTALL.md:5-13`; `scripts/sandbox-agent.sh`.
- Session: first-run walked end-to-end in a clean directory 2026-07-10; every defect above reproduced.

## Open Questions

- The final forbidden-word list for first-run surfaces (R-006) — settled at build, reviewed against the judged rubric.
- Whether the render chokepoint is a full module or a golden-transcript fixture sweep (the eval lens's fallback) if the refactor is too heavy for this window.
- Server-side token TTL + manual rotation — still a maybe; revisit with R-008.
- ~~Whether `foo learn` belongs in the invite template's postscript or stays out of the golden path~~ — resolved by D-011: learn collapses into init; the invite names one command and there is only one door.
