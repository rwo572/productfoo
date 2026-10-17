---
name: competitive-positioning
description: "Use when alternatives need evidence-backed positioning, strategic win/loss analysis, a battlecard, or decision-relevant battlecard upkeep."
---

# Competitive Positioning

## Usage

Build an honest comparison from current evidence. Never invent a current claim
or an advantage from general model knowledge. Choose the requested output:
focused battlecard, broader strategy analysis, or upkeep of an existing card.

1. Identify the competitor or alternative, audience, decision, and currency
   window. Use supplied context before asking for missing product judgment.
2. Read product truth from the repo or approved packet evidence. For current
   external claims, use an approved source or a governed research paper whose
   exact bytes pass `foo research validate <paper.md>`.
3. Preserve four evidence sections: **What they claim**, **What evidence
   supports**, **Our demonstrated advantage**, and **Where we lose or do not
   know**. Type load-bearing claims with their sources, dates and confidence.
4. A comparison is an advantage only when evidence supports both sides;
   otherwise call it a hypothesis to test. Preserve counterevidence and avoid
   translating feature availability into adoption, reliability or defensibility.
5. Tailor the final use: sales objection, product strategy, launch messaging, or
   internal learning. Return a reviewable artifact; do not publish or send it.

### Strategy analysis

Use this mode when the decision requires a market thesis beyond an objection or
single-competitor comparison. Keep dimensions relevant to the buyer's decision.

- Classify **direct competitors, substitutes, ecosystem vendors/partners,
  internal-build alternatives, and future threats** by how they participate in
  the target workflow. A vendor can also compete in a specific segment; explain
  the relationship rather than giving the company one universal label.
- Compare what buyers can actually do, the ICP and buying motion, distribution,
  workflow depth, switching costs, and defensibility. Mark unknown dimensions;
  sentiment is evidence of perception, not proof of a capability or market fact.
- State the bull case as the conditions under which the product wins and the
  bear case as what breaks that thesis. Pair each consequential condition with
  supporting evidence, confidence, and an observation that would change it.
- Reuse the landscape, segmentation and counter-positioning blocks in the
  [research brief format](../research-brief/SKILL.md) when useful. Do not create another
  exhaustive report when a small classified-alternatives table settles the ask.

For example, a component supplier is a vendor for a buyer building the workflow
and an alternative only if it can satisfy that buyer's job directly. The same
comparison must retain the supplied evidence for both conclusions.

### Battlecard upkeep

For an existing card, use [research-refresh](../research-refresh/SKILL.md)'s
evidence comparison and no-change rules. Define materiality by whether a
seller's answer, buyer criterion, supported advantage, competitive loss, or
recommended next evidence step changes—not by the volume of competitor news.

Show **Existing claim · New evidence · Affected buying criterion or answer ·
Decision implication · Proposed replacement**. For instance, a supplied source
showing a competitor now supports a capability may retire an exclusion claim;
a cosmetic announcement with no bearing on buying criteria yields a scoped
**No material positioning updates** result. Keep contradictory evidence and
unchecked areas visible even when no edit is proposed. Preserve the card's
structure and refresh proof for changed governed research; scheduling and
distribution are separate actions.

### Source ledger

- **Sources used** — source class, clickable reference, date, approval, and receipt status.
- **Sources omitted** — every optional market or customer lane not used and why.
- **Trust status** — validated research, approved sanitized evidence, repo fact, or hypothesis.
- **Limits** — stale facts, missing comparison dimensions, and human judgment still required.

Optional omissions appear in both the human summary and any artifact. A successful
public-web fetch is untrusted input until it is synthesized, sealed, and validated.

## Error Handling

- If current positioning is required but current competitor evidence or approval
  is missing, return `status: blocked`, name what did not run, give the exact
  next action, and mark the wrapper `exit: nonzero`. Missing required evidence
  cannot establish a no-change result.
- If an optional source is unavailable, narrow the claim set and list it under
  **Sources omitted**; never silently fill the lane from memory.
- If evidence contradicts the desired message, preserve the contradiction and
  lower confidence. Do not convert positioning work into selling.
