---
spec_id: sog_v0
title: Signals Over Gates V0
mode: product-definition
lifecycle: done
stage: shaping
owner: product
autonomy: human-in-loop
updated: 2026-07-07
---

# Signals Over Gates V0

<!-- Identity (`spec_id`) is read from the YAML frontmatter above. Progress is rendered by `foo asp status`, never stored here. -->

## Intent

Reframe productfoo's collaboration contract away from blocking "gates" and toward
**few hard boundaries plus many advisory signals**, and make "spec it with foo
before you build it" the default reflex rather than an enforced checkpoint.

The product bet: productfoo's differentiator is *legible judgment and preserved
momentum*, not pass/fail enforcement. A tool whose own README preaches "surface
the meaningful result" should surface, not block — except at the narrow places
where being wrong is silent, costly, or irreversible. Spec-first should win
because it is the faster, clearer path, not because the agent is forbidden from
building without it.

## Current Understanding

foo today frames its contract as "Required Gates" (`AGENTS.md`) and "gates" in
the README handoff text (`src/cli.ts`). This language imports a CI compliance
metaphor that fights productfoo's stated values:

- Gates flatten judgment into one red/green bit, discarding the belief /
  evidence / confidence / dissent that foo claims to make legible.
- Gates invite Goodharting: a *gated* judgment ledger gets filled to pass, not
  to think.
- Gates tax the momentum foo sells as its core feel.

Two places genuinely warrant hard enforcement, because there is nothing to
deliberate or the cost of error is high:

1. Objective, cheap, safety-shaped invariants (no raw private material; unique
   Spec ID; parseable frontmatter).
2. The autonomy / loop boundary, where unattended action without a verification
   check and terminal states is unbounded risk.

Everything else — structural validation, drift reconciliation, roast findings,
spec completeness, release readiness — is judgment-shaped and belongs as an
**advisory signal that feeds the ledger**, never a block.

The "spec-first reflex" question is distinct from enforcement: a reflex is
created by low cost and immediate payoff, not by force.

## Requirements

### R1 — Two-tier contract taxonomy
Replace "Required Gates" with **Boundaries** (hard, blocking, narrow) and
**Signals** (advisory, surfaced into the judgment ledger).

Boundaries (the only things that ever block):
- **B1 Safety**: never commit raw private source material (transcripts,
  secrets, vault dumps, env values).
- **B2 Spec identity**: every committed `spec.md` has a present, unique
  `Spec ID`.
- **B3 Risky-work spec-first**: under-specced work that is *irreversible*,
  *agentic/delegated*, or *outbound-facing* (identity, autonomy, approval, or
  external communication boundaries) requires an intake summary or Shape Brief
  before build.
- **B4 Autonomy**: any loop/autonomous action requires a valid loop contract
  (purpose, observation source, allowed actions, verification check, terminal
  states, approval boundaries).

Signals (surface + exit 0 by default; `--strict` may escalate B-class only):
- skill structure and runtime-neutral wording checks
- `asp validate` structural results
- `asp reconcile` drift findings
- `foo-roast` findings
- spec completeness and `ready-for-release` checks

### R2 — Frictionless spec-first reflex
Add a lightweight on-ramp, `foo shape <work>`: a ~30-second shape brief that
asks 1-3 stack-ranked questions, emits a **Shape Brief** artifact plus the
handoff contract, and is genuinely faster than improvising. `spec start`
remains the deeper loop; `shape` is the default reflex for everyday work.

### R3 — Reflex by payoff, boundary only when risky
Spec-first is *advisory everywhere* and *blocking only for B3 risky work*. The
reflex is driven by immediate payoff (a usable handoff + ledger seed), not by a
universal precondition.

### R4 — foo passes its own contract
A `foo self check` runs the boundary invariants (B1, B2) as the only blocking
self-checks and reports the signal-class checks as advisory findings, so foo
demonstrably honors the taxonomy it ships.

## Decisions

Decisions carried from the approved intake (interview-me) and reviewed by the
expert lenses (spec-swarm). Judgment ledger format: claim / evidence /
confidence / dissent / user-only.

- **D1 — Reflex mechanism is the frictionless default.** *(user-only,
  decided)* Make spec-first reflexive via a ~30s Shape Brief that beats
  improvising, not via auto-trigger or hard precondition.
  - Evidence: README "preserve momentum"; interview answer.
  - Confidence: high. Dissent (Product Ops lens): a runtime auto-trigger may
    still be wanted later as an opt-in; recorded as Open Question OQ1.
- **D2 — Spec-first is a boundary for risky work only.** *(user-only,
  decided)* Hard-required for irreversible / agentic / outbound work; advisory
  elsewhere. Resolves the irony that "make spec-first first nature" could
  recreate the gate we are removing.
  - Evidence: interview answer; productfoo's own "capability-gated autonomy" stance.
  - Confidence: high. Dissent (QA lens): the risky-work classifier is itself a
    judgment call and must stay inspectable, not silent — see R1/B3 and OQ2.
- **D3 — Packet scope is reframe + reflex spec; implement in a follow-up.**
  *(user-only, decided)* This packet decides and specifies; it does not yet
  edit `AGENTS.md`/README or add `foo shape`. Keeps spec and build separate,
  which is the behavior the packet is advocating.
  - Evidence: interview answer.
  - Confidence: high. No dissent.
- **D4 — Only B1 and B2 block in `foo self check`; signals never block by
  default.** Derived from R1/R4.
  - Evidence: src/cli.ts shows README validators are unenforced today and no CI
    exists; making them blocking-by-default would contradict the taxonomy.
  - Confidence: med-high. Dissent (Security lens): B1 should be enforced in a
    pre-commit path too, since "exit 0 advisory" is too weak for raw secrets;
    captured as OQ3.

## Risks

- **Re-gating by the back door.** A "frictionless" Shape Brief could grow into a
  mandatory step. Mitigation: D2 scopes hard-required to risky work only; track
  brief-skip rate as a signal.
- **Classifier ambiguity.** "Risky work" (B3) is judgment; misclassification
  either over-blocks or lets risky work through. Mitigation: classifier output
  is a visible signal with rationale, overridable with a recorded reason.
- **Advisory checks ignored.** Signals that never block may be ignored.
  Mitigation: route findings into the ledger and `ready-for-release`, not the
  void.
- **Taxonomy churn.** Renaming "gates" touches `AGENTS.md`, README, and CLI
  handoff text; partial rename leaves mixed language. Mitigation: single
  follow-up task set (T-001..T-002) with a wording check.

## Validation

- `foo asp validate specs/signals-over-gates-v0` passes (packet structural
  contract).
- Spec enumerates exactly the boundary set {B1, B2, B3, B4} and labels every
  other named check as a signal.
- Each user-only decision (D1-D3) is traceable to an interview answer.
- Follow-up acceptance (deferred to implementation packet): `foo self check`
  blocks only on B1/B2; `foo shape` returns a Shape Brief in <= 3 questions;
  `AGENTS.md` contains no "Required Gates" heading.

## Evidence

- `AGENTS.md:11-17` — current "Required Gates" framing.
- `src/cli.ts:246,259` — CLI handoff text uses "gate" language.
- `README.md:196-273` — three validation checks defined as prose, enforced
  nowhere (no `.github/workflows`, not in `npm test`).
- `src/cli.ts:1233` — `asp reconcile` delegates entirely to per-packet modules;
  no shared engine.
- `src/cli.ts:674-698` — `agent doctor` checks adapter files only, not
  prerequisites; fresh clone fails build/test until `npm install` (verified;
  41/41 pass after install).
- README momentum/legibility language: `README.md:5,17,66,111`.

## Open Questions

- **OQ1**: Should an opt-in runtime auto-trigger (SessionStart hook / AGENTS
  rule) be offered alongside the frictionless default later? (Owner: product.)
- **OQ2**: What is the concrete risky-work classifier for B3 — heuristic,
  declared work-type, or agent judgment with recorded rationale? (Owner:
  product + architect.)
- **OQ3**: Should B1 (no raw private material) also run as a blocking pre-commit
  hook, not only in `foo self check`? (Owner: security.)
