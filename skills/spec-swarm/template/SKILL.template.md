<!--
  SKILL.template.md — the single canonical skeleton for every spec-swarm-<persona> skill.

  The 25 skills/spec-swarm-<persona>/SKILL.md files are GENERATED from this
  template plus one data block per persona in template/personas/<persona>.md.
  Do not hand-edit a generated SKILL.md; edit this template or the persona
  data block and run:

    node scripts/build-swarm-skills.mjs            # regenerate all 25
    node scripts/build-swarm-skills.mjs --verify   # CI drift check

  Placeholder syntax (resolved by scripts/build-swarm-skills.mjs):
    {{field}}                inline substitution from the persona data block
    {{#if field}} {{/if}}    marker lines; block kept only when field present

  Spec packet: specs/swarm-template-v0 (swarm_template_v0).
-->
---
name: {{name}}
description: "Review an Adaptive Spec Packet, PRD-like spec, or interview-me swarm packet from {{description_pov}} perspective. Use inside spec-swarm or when the user wants {{description_wants}}"
---

# Spec Swarm: {{title}}

{{#if intro}}
{{intro}}
{{/if}}
{{#if intro_pov}}
Sharpen the spec from {{intro_pov}} point of view{{intro_flavor}}. Use the `grill-me` interaction model: ask one question at a time, give the recommended answer, and resolve the {{intro_decision}} decision before moving on.{{intro_extra}}
{{/if}}

## Usage

Use inside `spec-swarm` or directly on a draft {{usage_artifacts}}:

```text
Use ${{name}} on <path-or-summary>
```

{{foo_voice}}

## Focus

{{focus}}

{{#if borrow}}
## Borrow From Existing Skills

{{borrow}}

{{/if}}
{{#if grounding}}
## Grounding

{{grounding}}

## Question Bank

Draw the swarm's questions from this ranked bank; each forces a decision, exposes risk, or improves validation.

{{question_bank}}

{{/if}}
## Expert Preflight Before User Questions

Before asking the user, ask the other role lenses whether they can answer the candidate question from expertise or artifacts. Record a compact routing note with the candidate question, experts consulted, proposed expert answer, evidence/reason, and whether user judgment is required. When briefing the user, state the relevant expert answer, its reason, any disagreement, and the choice they need to make; keep the full routing note available with the review. Only ask the user when the answer depends on their unique judgment, risk tolerance, taste, source-boundary approval, or a choice between materially valid options.

## Legible Judgment

For every proposed answer, label the judgment type in the structured record as `repo-evidence`, `approved-context`, `role-expertise`, `agent-inference`, or `user-judgment`. Include evidence, confidence, and any dissent or caveat so the user can steer the agent judgment. In the human explanation, express those same distinctions in ordinary sentences with their sources; keep material uncertainty and disagreement visible.

## Question Selection

Ask only 2-3 questions total, one at a time{{question_bank_clause}}. Prefer questions that expose:

{{question_selection}}

If the answer can be found in {{sources}}, inspect those sources instead of asking.

## Output

For each question, return:

- `Question`: {{question}}
- `Recommended answer`: the answer {{lens}} would push toward, based on the available evidence.
- `Why it matters`: one sentence.
- `Likely spec impact`: {{spec_impact}}

Wait for the user's answer before asking the next question. {{guardrails}}

## Error Handling

- If no spec or packet is provided, ask for one before reviewing.
{{error_handling}}
