---
name: research-refresh
description: "Use when new approved evidence should refresh an existing research brief, digest, or strategic analysis through decision-relevant amendments or an explicit no-change result."
---

# Research Refresh

## Usage

Refresh what the evidence changes about a named decision. Preserve the existing
artifact's structure; a newer source alone is not a reason to rewrite it.

1. Identify the existing artifact, its decision or working thesis, the currency
   window, and the claims to check. Derive materiality from that decision: an
   affected choice, buying criterion, constraint, confidence, or next evidence
   step. Use criteria already supplied before asking for missing judgment.
2. Read repo truth, explicitly approved packet evidence, or approved sanitized
   findings. Research papers must pass `foo research validate <paper.md>` before
   use. If more public research is needed, use the governed research workflow;
   connector access alone never authorizes new private-source reads.
3. Compare new evidence against existing claims. Distinguish unchanged,
   superseded, contradicted, newly material, and unresolved claims. An event
   outside the requested window can establish a baseline, but cannot be
   presented as a new development inside it.
4. Propose only the smallest decision-relevant amendments. Every proposal names
   the old claim and locator, new evidence and date, relation, changed decision
   implication, and replacement text. Preserve uncertainty and counterevidence;
   a contradiction stays visible even when it changes no recommended action.
5. If nothing material changed, return **No material updates in the checked
   scope**, the window and sources checked, omissions, and unresolved claims.
   This is a result of a completed comparison, not reassurance about unchecked
   sources or stale evidence.
6. Return proposals in chat by default, or at a requested local destination.
   Apply edits only within the user's requested scope. After editing a governed
   research paper, obtain fresh proof through its research workflow and rerun
   `foo research validate <paper.md>` before downstream use; the old receipt
   binds the old bytes. Evidence updates do not automatically change accepted
   specs, requirements, tasks, or human decisions.

### Review output

Lead with the changed implication or scoped no-change result. Follow with a
small amendment table: **Existing claim · New evidence · Relation · Decision
implication · Proposed edit**. Keep contradictions and unresolved claims visible.
Include **Sources used**, **Sources omitted**, **Trust status**, and **Limits**,
with clickable references, source dates, confidence and dissent. For examples
of materiality, no-op and incomplete coverage, read
[the worked cases](references/worked-cases.md).

This method is invoked on demand. Scheduling, publishing, and automatic PRs
are separate work; a refresh does not authorize them.

## Error Handling

- If the decision or materiality criterion is missing, use supplied context to
  resolve it or ask one focused question. Do not invent a universal threshold.
- If required evidence is inaccessible, unapproved, or fails validation, return
  `status: blocked`, name the check that did not run, give the next action, and
  mark the wrapper `exit: nonzero`. Never turn this into a no-change result.
- If optional sources are missing, continue within the checked scope when the
  remaining evidence supports an honest comparison, and disclose the omissions.
- If only raw private material is offered, use productfoo's proof-gated discovery
  workflow; do not read it here or request a raw paste as a workaround.
