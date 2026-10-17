# The eval calibration protocol

productfoo's judges are calibrated before their verdicts count. This page is the public
statement of that protocol — the mechanism and the numbers, stated where anyone
can check them against the code. The corpus stays private: golden sets, owner
labels, and labeled artifacts live under `.foo/eval-corpus/` (never in git,
never in a published package), and committed eval records reference them by
content hash and pointer only. Public claims about the eval system stop at
mechanism and protocol; score and accuracy numbers are never published, because
a number you cannot reproduce is a number you cannot falsify.

Code: `src/evalCalibration.ts` (the gate), `src/evalLabels.ts` (blind capture),
`src/commands/evalCmd.ts` (the `foo eval` verbs).

## The gate

A judge's verdicts gate nothing until a blind, binary, owner-labeled validation
clears every part of this bar (all constants live in `src/evalCalibration.ts`):

| Element | Value | Constant |
| --- | --- | --- |
| Blind owner labels | **30**, all with a judge sample | `CALIBRATION_LABEL_COUNT = 30` |
| Per-class rate bar | **min(TPR, TNR) ≥ 0.9** | `CALIBRATION_MIN_RATE = 0.9` |
| Fail-class floor | **≥ 10** fail labels | `CALIBRATION_MIN_FAIL_LABELS = 10` |

Why these three and not something fancier:

- **Per-class, not accuracy.** TPR (the judge agrees when the owner says pass)
  and TNR (the judge agrees when the owner says fail) are scored separately and
  the *worse* one must clear the bar. A judge that answers "pass" to everything
  scores perfect TPR and fails the gate on TNR — accuracy would hide exactly
  that judge.
- **The fail-class floor.** Without at least 10 real fail-class labels the
  false-pass rate is unmeasured, so the report refuses to certify with a named
  reason ("without real failures the false-pass rate is unmeasured"). Fail labels
  come from real roast findings or observed failures — never manufactured.
- **Blind labels only.** Labels given with the judge's critique or round order
  visible are not blind; they are counted in the report as
  `non_blind_excluded` and never scored. Improve-loop rulings are provisional
  signal (D-007) and can never certify a judge.

At 30 labels the confidence interval is wide and the report says so rather than
smoothing it over. The bar is a retirement test for judges, not a peer review.

## Blind labeling, in batches of ten

The owner labels artifacts one at a time with `foo eval label`:

```
foo eval label <packet-dir> [--count=10] [--suite <name>] [--judge <E-xxx>]
```

- **Blind by construction.** Each item shows the artifact the way the user saw
  it (rendered view and raw payload) plus shape metadata — never the record's
  criterion, never a judge verdict, never the private trace. The presentation
  type cannot carry any of those, and the test suite proves the surface stays
  clean.
- **Stratified sampling.** The batch picks one representative per shape class
  first (first-appearance order), then fills randomly. One shape cannot crowd
  out the others, and clean artifacts cannot crowd out the interesting ones.
- **Batches of ~10.** The capture rhythm is short sessions on the owner's
  schedule — `--count=10` is the default — not one long labeling slog. Three or
  four sessions clear the 30-label bar.
- **Append-only, content-hashed.** Each verdict appends an `OwnerLabel` (artifact
  hash, verdict, `blind: true`, ISO timestamp, optional free-text note) to the
  suite's `labels.jsonl` in the private corpus. The latest line per artifact
  wins; the file is never repaired in place, and malformed lines are counted,
  not dropped.

## Drift voids certification

Calibration is keyed to `judge_key = hash(judge prompt, judge model)`. Edit the
prompt or rotate the model and the judge is uncalibrated from that moment —
`judgeMayGate` refuses with the reason. Re-validation re-runs the blind scoring
**against the existing labels**: no new owner labeling is needed, which is what
keeps model rotations cheap enough to do honestly.

## Disputes refine the criteria, not the score

When a judge's verdict and the owner's disagree, `foo eval label --dispute
<hash-prefix>` presents the disputed artifact blind again and appends a relabel.
The relabel supersedes the original by later append and is reported as a
dispute signal — a refinement signal for the record's criterion or the judge
prompt, never a gate input. A dispute-triggered edit to the judge prompt changes
the `judge_key`, which voids certification and forces recalibration: the loop
closes itself by construction.

## Cohen's kappa is reported, never gating

The calibration report includes Cohen's kappa over the blind labels that have a
judge sample — chance-corrected agreement, with the expected-agreement term
taken from both marginals of the same set. Kappa answers "is the agreement
better than chance?", which raw TPR/TNR do not tell you. It is a diagnostic:
`certified` never reads it, the gate is untouched by it, and a low or null
kappa never blocks anything. Kappa is null when the agreement set is empty or
is a single class (nothing left for chance to explain away).

## Judges run advisory until certified

Until a judge posts a certified report under its current key, its verdicts are
**advisory-only**: reported in run output and improve-loop landings, never
counted toward "every check passes," never able to stop or extend a loop round.
`foo eval run` tags every advisory verdict as such and prints the gating reason.
Uncalibrated output is signal, not authority.

## Where criteria come from (discovery guidance, not a gate)

Criteria are read off failures, not the reverse. Before records are minted:

1. **Sample a diverse artifact set** — shape-class representatives plus random
   fill, never only clean artifacts.
2. **Draft free-text failure notes** — failures-only, stop at the first
   upstream error, no root-cause analysis; describe the failure so a colleague
   could act on it.
3. **Mint the criteria from the notes**, citing the sample in the record's
   `provenance`. When review later changes what "good" means, the criteria are
   re-edited — and the judge's key changes with them, forcing recalibration.

Practitioner guidance for the discovery stage (Husain & Shankar, "Advanced
evals," Lenny's Newsletter, September 22, 2026 — free portion) suggests on the
order of 100 traces to set criteria for a new surface. That figure is
**discovery-stage guidance, not a gate**: it is about how much material a human
should read before writing criteria, and it does not change the calibration bar
above, which stays 30 blind labels with a 10-fail floor. The paid portion of
that piece was not consulted.
