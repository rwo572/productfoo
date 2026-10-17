---
name: review-loop
description: "Use when invoking /review-loop or when the user wants to evaluate, grade, audit, or sanity-check a single loop spec, loop contract, loops.yaml entry, routine, or a plainly-described AI loop against the 'a good loop ends with proof' bar — does it have a checkable goal, a visible check, a stop condition, and a proof-bearing handoff someone could trust on a second case."
---

# Skill: Review Loop

Evaluate one loop spec against the quality bar for delegated, repeated work: **a good loop ends with proof.**

A loop is a standard that runs — a goal the work must reach, a check that measures progress, revision that uses the check to choose the next move, and a stop condition that bounds the work and forces a handoff. This skill judges whether a given loop actually clears that bar, or whether it is "automation theater" that returns output while pushing the hard review back onto a human.

This is the **judgment** layer, not the schema layer. productfoo already ships a structural validator — `foo loop check <packet-dir>` enforces the `loops.yaml` contract shape and the B4 budget handshake. `review-loop` is complementary: it asks whether the *content* of the loop is strong enough to trust, not just whether the fields are present. Run the structural check first when the loop is a `loops.yaml` contract, then run this for quality.

## Usage

```
/review-loop <loop-source> [--fix] [--json]
```

`<loop-source>` may be:

- a packet dir containing `loops.yaml` (evaluate each loop, or one via `--loop <id>`)
- a path to a `loops.yaml` or a single loop spec file
- a prose loop: a slash-command loop, a `/loop` recurring task, a scheduled routine, or a plainly-described "keep doing X until Y" instruction
- a pasted loop template from a public loop library or registry

Examples:

- `/review-loop specs/portable-routines-v0` — grade the loop contracts in a packet
- `/review-loop specs/adaptive-spec-packet-v0 --loop L-001` — grade one loop
- `/review-loop "keep re-running the tests and fixing failures until they pass"` — grade a prose loop
- `/review-loop ./my-ticket-to-pr-loop.md` — grade a library loop template

If no loop source is given, ask for the smallest thing that describes the loop: a `loops.yaml`, a file path, or a short description of the goal, the check, and when it stops. Do not invent the loop.

Do not edit the loop unless the user passes `--fix` or explicitly asks. By default this skill returns a scorecard, observable checks, and a next action.

## Core Rule

**An evaluation is not done until it produces observable checks and a trust verdict, not opinions.**

If the review cannot name what evidence the loop must return, which check must stay visible, or what would make its handoff untrustworthy, it has not finished. Every finding should convert into something a later run can be judged against — the same discipline the loop itself is supposed to have.

## What A Good Loop Has (the bar)

Map the loop onto these pieces before scoring. For a `loops.yaml` contract the field names are shown; for a prose loop, infer the same pieces from the description.

| Piece | Question it answers | `loops.yaml` field |
|-------|--------------------|--------------------|
| Goal + standard | Where must the work land? | `goal` |
| Check / evaluator | How is progress measured? | `verify.check`, `verify.method` |
| Revision rule | Does the latest result choose the next move? | `choose.criteria` (uses check output) |
| Stop conditions | When does it stop and hand back? | `stop.*`, `lifecycle.terminal_states` |
| Proof + record | What evidence rides with the handoff? | `record.artifact`, `record.required_fields` |
| Boundaries | What may it never do unattended? | `act.forbidden` |
| Escalation | When must it ask a human? | `ask_user_when` |
| Reusability | Could someone run it on a second case? | `refs`, `observe.sources`, `act.allowed`, `adapters.runtimes` |

## The Practical Test

Score the loop on the six questions from the standard. For each: give a verdict, cite the specific evidence in the loop (or note its absence), and — this is the point — name the failure it causes downstream when the answer is weak.

Use the foo status-glyph vocabulary for the per-axis verdict on a human terminal (always pair the glyph with its word): **✅ proven** (clear, checkable, present) · **🟡 claimed** (present but weak or unverifiable) · **🚧 blocked / missing** (absent — the loop cannot clear the bar here). Never emit glyphs in `--json`.

### 1. Can you tell what it is trying to achieve?

The goal must name a specific target *and* a standard the loop keeps applying.

- ✅ proven: "Reduce the failing test count to zero." "Produce a reviewer-ready PR." "Extract a reusable skill that works on a second case."
- 🟡 claimed: "Improve the code." "Make it better." "Handle the tickets." — loose goals create wandering.
- Downstream failure of a vague goal: the loop drifts and never converges; token spend climbs because there is no target to reach.

### 2. Is the check visible?

There must be an inspectable evaluator, and its form must fit the work.

- Code loops: tests, builds, logs, diffs, benchmarks.
- Research loops: source coverage, citation quality, confidence thresholds, missing-evidence notes.
- Writing loops: style rules, reader questions, repetition scans, weak-claim checks.
- Product loops: customer evidence, risk reviews, success criteria, decision quality.
- ✅ proven: the check is named, runnable, and someone else could apply it.
- 🟡 claimed: "the agent reviews the output" — a check the human still has to redo.
- Downstream failure of a weak check: the hardest part of the work gets pushed back to the person receiving the output.

### 3. Does the latest result decide the next attempt?

This is the property that makes it a *loop* and not a checklist or a one-pass workflow. The result of the check must change what happens next.

- ✅ proven: the revision rule reads the check output and picks the next move (e.g. `choose.criteria: highest-risk failing check`).
- 🚧 missing: the "loop" just repeats the same action on a schedule and never reacts to its own last result — that is a cron, not a loop.
- Downstream failure: repeated attempts that do not shrink the gap; motion mistaken for progress.

### 4. Can you tell when the loop should stop?

Stop conditions must be visible and must force a handoff — including the non-success exits.

- ✅ proven: distinct terminal states for success, clean no-op, blocked/approval-needed, exhausted (no progress after N passes), stagnated. productfoo's contract enumerates these in `stop.*` and `lifecycle.terminal_states`.
- 🟡 claimed: "stop when it's done" with no definition of done or of the give-up cases.
- Downstream failure of fuzzy stops: wasted attempts and climbing token spend when the gap never shrinks; no clean point to hand back.

### 5. Does the handoff include proof?

The final handoff must let a reviewer understand it in ~2 minutes. Proof can be simple: tests passed, the issue was reproduced and fixed, sources support the claim, a second case worked, the benchmark improved, screenshots show the change.

Check that the record answers the reviewer's real questions: **What changed in the latest attempt? Which source supports this claim? Did the check pass? Which risk remains? Where should I review first? How much can I trust?**

- ✅ proven: the record/artifact carries the check result and the evidence behind it (productfoo: `record.required_fields` includes `verification_result`, `observed_sources`, `action_taken`).
- 🟡 claimed: the loop returns an artifact but no evidence — confidence barely moves; the reviewer must reconstruct the reasoning. This is the automation-theater tell.
- Downstream failure: the loop shifts uncertainty to the human instead of reducing it.

### 6. Could someone else use it on a second case?

A reusable loop defines its goal, inputs, context, tools, preserved state, check, proof, stop conditions, escalation rules, boundaries, handoff, and failure modes — and ideally shows second-case evidence that the method stands on its own.

- ✅ proven: inputs and boundaries are explicit; the loop is runtime-portable (productfoo: `adapters.runtimes`) and has been shown to work on a second case.
- 🟡 claimed: assumptions are trapped inside one prompt or one repo; "trust from a clever name" with no template behind it.
- Downstream failure: the loop is dead knowledge — the result was saved but the method cannot be re-run.

## Boundary And Autonomy Check (productfoo B4)

For any loop that acts, not just observes, additionally check the approval surface — this is where productfoo's autonomy boundary meets the proof bar:

- **Boundaries present** (`act.forbidden`): the loop names what it must never do unattended — edit canonical files, import raw private sources, take irreversible/outbound/financial actions.
- **Escalation present** (`ask_user_when`): the loop hands back when product meaning changes, a source boundary changes, or a destructive/production/outbound action would be enabled.
- **Budget agreed** (B4): defer to `foo loop check` / `foo loop estimate` for the budget handshake; note if an acting loop has no agreed budget, since an unbudgeted loop is a malformed contract.

If an acting loop can reach an irreversible or outbound action with no human gate, that is a blocking finding regardless of how good its check is — surface it first.

## Turn Findings Into Evals

For each weak axis, emit at least one **observable check** the next version of the loop should be judged against — mirroring how a good loop turns repeated corrections into checks. Examples:

- Goal eval: the loop's target is stated as a measurable end state, not a direction.
- Check-visibility eval: the evaluator is runnable by someone other than the author and returns a pass/fail plus evidence.
- Reactivity eval: given a failing check, the next attempt differs from the last in a way the check output explains.
- Stop eval: a run that makes no progress for N passes exits via `exhausted`/`stagnated`, not indefinitely.
- Proof eval: the handoff answers the six reviewer questions without the reviewer opening the source.
- Second-case eval: the loop produces a trustworthy handoff on a second, independent input.

## Output Format

Keep it short enough to act on immediately.

```text
Loop: <id or one-line description>
What it is trying to become: <goal in one sentence, or "unclear — see axis 1">

Practical Test
1. Checkable goal      ✅/🟡/🚧  — <evidence or gap>  → <downstream failure if weak>
2. Visible check       ✅/🟡/🚧  — ...
3. Latest result drives next  ✅/🟡/🚧  — ...
4. Bounded stop        ✅/🟡/🚧  — ...
5. Proof in handoff    ✅/🟡/🚧  — ...
6. Second-case reuse   ✅/🟡/🚧  — ...

Boundary & autonomy (acting loops): <ok / gap / BLOCKING gap>

Verdict: <Ready to delegate | Not yet — pushes review burden to the human | Blocked on a safety gap>

Weakest link: <the one axis that most limits trust>

Candidate evals (add these to the loop):
- ...

Recommended next step: <recommendation>
Then, if the user wants options:
  1. <recommended option>  (recommended)
  2. <option>
  3. <option>
```

Lead the decision with a recommendation, then number the options so the user can answer with a single digit. Keep belief, evidence, and dissent visible — do not reduce the verdict to a bare menu.

## With `--fix`

Only when the user asks. Safe, in-place improvements to a `loops.yaml` loop:

- Tighten a vague `goal` into a checkable target + standard (propose wording; confirm before writing).
- Add missing `stop.*` terminal states (`exhausted`, `stagnated`, `clean_no_op`) and their conditions.
- Add missing `record.required_fields` so the handoff carries `verification_result` and `observed_sources`.
- Add `ask_user_when` escalation entries for irreversible/outbound actions.

Never widen `act.allowed` to enable a riskier action as a "fix." Never raise a budget or weaken a boundary to make a loop pass. Changing what a loop is *allowed to do* is a product decision — surface it, do not auto-apply. After any write to a packet loop, re-run `foo loop check <packet-dir>` and, for packet-tied changes, `foo asp validate <packet-dir>`.

## Integration With Other Skills And CLI

- `foo loop check <packet-dir>` — structural + budget (B4) validation. Run first for `loops.yaml` loops; `review-loop` adds the quality judgment on top.
- `foo loop status <packet-dir>` — renders the loop's current state, evidence, and approval boundary.
- `foo loop estimate <packet-dir> --agree` — the budget handshake for an acting loop.
- `loop-library-audit` — evaluate a whole loop library or registry; it delegates per-loop grading to this skill.
- `foo-roast` — when the loop is embedded in a spec/prototype that also needs product-shape cuts.

## Error Handling

- If no loop source is available, ask for the smallest description: goal, check, and stop condition — or a `loops.yaml` path. Do not fabricate the loop.
- If the source is a `loops.yaml` that fails `foo loop check` (schema or budget), report that structural failure first; a malformed contract cannot be meaningfully graded for quality until it parses.
- If the loop description is too vague to locate a check or a stop condition, say so plainly and treat those axes as 🚧 missing rather than guessing a passing grade.
- If the loop references private or sensitive source material, do not copy raw material into the review; evaluate only the loop's structure and boundaries.
- If a claim about what the loop does depends on running it, label it an assumption or inspect the referenced sources before scoring.
- If the user asks to change what an acting loop is permitted to do, route that decision back to the human (and to `interview-me` / `foo spec` when product meaning is at stake) rather than editing boundaries silently.
