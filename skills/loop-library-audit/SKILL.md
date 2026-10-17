---
name: loop-library-audit
description: "Use when invoking /loop-library-audit or when the user wants to evaluate a whole loop library, loop registry, loop template set, or every loop in a packet against the loop-library trust standard — proof as part of the design, second-case evidence, visible checks, bounded stops, and template completeness across many loops — and get a roll-up of which loops are trustworthy and which push review burden back to the human."
---

# Skill: Loop Library Audit

Evaluate a **collection** of loops against the standard a public loop library must hold: every loop makes its goal, check, stop condition, proof, and handoff visible, and proof is part of the design — not an afterthought. Trust cannot come from a clever name.

This is the portfolio-level companion to `review-loop`. Where `review-loop` grades one loop in depth, `loop-library-audit` grades many, produces a distribution, and surfaces the top gaps across the set. It mirrors the relationship between `review-spec` (single, detailed) and `check-spec-health` (roll-up across initiatives).

## Usage

```
/loop-library-audit <library-source> [--json] [--report]
```

`<library-source>` may be:

- a packet dir or `loops.yaml` with multiple loops
- a folder of loop spec files or loop templates
- a pasted or linked loop registry / marketplace / template collection
- several loops the user names inline

Examples:

- `/loop-library-audit specs/portable-routines-v0` — audit every loop in a packet
- `/loop-library-audit ./loops/` — audit a folder of loop templates
- `/loop-library-audit --report` — health report across all discoverable loops without changes

If no source is given, ask for the smallest thing that enumerates the loops — a `loops.yaml`, a folder, or a list. Do not invent loops.

This skill does not edit loops. It produces an audit, a distribution, and a prioritized fix list. Route per-loop fixes to `review-loop --fix`.

## Core Rule

**A loop library is only as trustworthy as its weakest visible standard.** The audit's job is to make that standard measurable across the set — proof coverage, second-case coverage, and the count of loops that would push review burden back to a human — not to hand back a pile of per-loop opinions.

## The Library Standard

A reusable loop in a library should make all of these visible. Score each loop for template completeness against this checklist, then roll the results up.

- **Goal, trigger, input** — where the work must land, what starts it, what it starts from.
- **Context, tools, preserved state** — what the loop reads, acts through, and remembers between passes.
- **Evaluator (check) and proof** — how progress is measured and what evidence rides with the result.
- **Stop conditions and escalation rules** — the bounded exits, including the give-up cases, and when it asks a human.
- **Boundaries** — what the loop may never do unattended.
- **Handoff** — what the receiver gets, and whether they can trust it in ~2 minutes.
- **Failure modes** — the known ways it goes wrong.
- **Second-case evidence** — proof the method worked on a second, independent input, so it is not one-off knowledge.

Visibility is the point: an inspectable loop can be sharpened, guard-railed, and made easier to review. Assumptions trapped inside a prompt cannot be improved.

## Method

1. **Enumerate** the loops in the source. For a `loops.yaml`, run `foo loop check <packet-dir>` first and note any that fail the structural/budget contract — a loop that does not parse cannot be trusted and counts as a failing library entry.
2. **Grade each loop** against the template checklist and the six-question Practical Test. For depth on a specific loop, delegate to `review-loop`; for the roll-up, a compact per-loop verdict is enough. Record for each loop:
   - a completeness result per checklist item (present / weak / missing),
   - a trust verdict: **✅ trustworthy** (proof-bearing, bounded, reusable) · **🟡 partial** (works but pushes some review burden back) · **🚧 unsafe/incomplete** (missing proof, stop, or boundary).
3. **Roll up** the cross-library signals (see below).
4. **Rank the gaps** by how much they erode trust across the set, and give a prioritized fix list.

Use the foo status-glyph vocabulary only on a human terminal, always paired with its word; never in `--json`.

## Cross-Library Signals

Report these portfolio metrics — they are the ones that tell a team whether the library can be trusted for delegated work:

- **Proof coverage**: share of loops whose handoff carries evidence (the check result + what changed + which risk remains). Low coverage means the library is automation theater.
- **Second-case coverage**: share of loops with evidence they worked on a second case. Low coverage means dead knowledge dressed as reusable assets.
- **Visible-check rate**: share of loops with an inspectable, runnable evaluator vs. "the agent reviews it."
- **Bounded-stop rate**: share of loops with real terminal states (including `exhausted`/`stagnated`) vs. fuzzy "stop when done."
- **Reactivity rate**: share of loops where the latest check result actually drives the next attempt vs. cron-style repetition.
- **Unsafe count**: loops that can reach an irreversible/outbound action with no human gate, or (for acting loops) with no agreed budget under B4. These are surfaced first, regardless of other strengths.
- **Naming-vs-substance flags**: loops whose value rests on a clever name but whose check, proof, or stop condition is missing.

## Output Format

```text
Loop Library Audit: <source>
Loops evaluated: N   (structural failures: k)

Trust distribution
  ✅ trustworthy: a loops   — <ids>
  🟡 partial:     b loops   — <ids>
  🚧 unsafe/incomplete: c loops — <ids>

Cross-library coverage
  Proof in handoff:     X% (n/N)
  Second-case evidence: X% (n/N)
  Visible check:        X% (n/N)
  Bounded stop:         X% (n/N)
  Latest-result-drives-next: X% (n/N)

Top gaps across the library
  1. <gap>  — affects <k> loops  — <why it erodes trust>
  2. ...

Unsafe loops (fix first)
  - <id>: <the missing boundary, gate, or budget>

Recommended sequence
  1. <recommended first fix>  (recommended)
  2. ...
```

Lead with a recommendation, then number the options. Keep the evidence behind each metric visible — a percentage without the loop ids behind it is fake precision.

## Integration With Other Skills And CLI

- `review-loop <loop>` — deep, per-loop grade + candidate evals + `--fix`. This audit delegates to it for detail and for fixes.
- `foo loop check <packet-dir>` — structural + B4 budget validation; run before grading a `loops.yaml` library.
- `foo loop status <packet-dir>` — per-loop state, evidence, and approval boundary.
- `check-spec-health` — the analogous roll-up for specs; use when the loops live inside specs that also need health review.

## Error Handling

- If the source does not enumerate any loops, say so and ask for a `loops.yaml`, a folder, or an explicit list rather than guessing.
- If some loops fail `foo loop check`, count them as failing library entries and report the structural blocker before grading their quality.
- If the library is large, sample transparently: state how many loops were graded in depth vs. counted, and never present a partial sweep as full coverage.
- If a loop references private or sensitive material, audit its structure and boundaries only; do not copy raw source material into the report.
- If a metric cannot be computed because loops omit a field entirely, report it as missing rather than assuming a passing value.
- Route any change to what an acting loop is permitted to do back to a human decision; this skill reports, it does not widen boundaries or budgets.
