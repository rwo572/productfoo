---
name: product-copywriting
description: "Use when working on ThisProduct copy, reducing jargon, explaining the product, editing the static prototype under design system/thisproduct, or deciding whether terms like Spec, Cross-functional Spec, drift, evidence, provenance, source packets, tokens, routing, or agents should appear in user-facing language."
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.

## Usage

Use this skill when its frontmatter description matches the user request. Follow the workflow and constraints below.


# ThisProduct Copywriting

Use this skill to make ThisProduct understandable without flattening the product. The working test is: a product leader should be able to explain the screen out loud after reading it once.

## Source Of Truth

Before rewriting, read the smallest relevant set:

- `AGENTS.md` for product constraints and source boundaries.
- `README.md` for the current product definition.
- `docs/prototypes/2026-06-11-thisproduct-jargon-audit.md` for the full jargon backlog.
- `design system/thisproduct/components.jsx` and `design system/thisproduct/data.js` when changing prototype UI text.

Do not import private Obsidian notes, meeting notes, or local context into repo copy unless the user explicitly asks.

## Protected Product Language

Keep these terms, but define or contextualize them early:

- `ThisProduct`: product name.
- `Initiative`: the main unit of product work.
- `Cross-functional Spec`: the core spec object. Use this exact capitalization.
- `Spec`: product-facing shorthand. Use `Spec`, not `Adaptive Spec Packet`, in UI and marketing copy.
- `Evidence`: the trust layer behind every claim.
- `Agent`: acceptable because ThisProduct is about people working with agents.
- `Drift`: acceptable only after explaining it as work changing from the approved plan.

Use repo paths such as `specs/<name>/` only when they are real implementation source references. Product-facing labels should say `Spec`.

## Default Translations

Use these replacements unless the source context requires the exact technical term:

| Avoid | Prefer |
|---|---|
| Adaptive Spec Packet | Spec |
| Cross-functional spec | Cross-functional Spec |
| provenance | where this came from |
| source-backed | with links back to the source |
| source-agnostic | works across your tools |
| demo substrate | demo source |
| source packets | approved source bundles |
| expected output fixture | expected result |
| thisproduct graph | initiative map |
| lens | view |
| product implication | why this matters |
| agent decision | what the agent changed |
| result contract | agent result report |
| trace | record of what happened |
| telemetry | usage data or activity data |
| routing receipts | savings proof |
| task class | type of work |
| callsite | AI call |

## Page Jobs

Rewrite page by page. Do not try to explain the whole system on every screen.

- Home: answer what is happening, what needs attention, and what can be trusted.
- Initiative Spec: explain the Cross-functional Spec before showing views, requirements, or source links.
- Drift: say what changed, why it matters, and what the user should do.
- Spend and Impact: make cost decision-oriented before showing tokens, routing, or ROI.
- Routing: first say ThisProduct helps spend less on AI calls without lowering quality; only then introduce modes or receipts.
- Ideas: emphasize grouped inputs and a ranked list; keep scoring methods secondary.
- Forecast: separate real forecasts from demo forecasts, then say what action changes a date.
- Activity: keep it as a plain event feed.

## Voice Rules

The shared productfoo voice reference loaded above governs human explanations across
products. The protected ThisProduct terms and prototype paths in this skill are
local product rules, not a vocabulary to impose on every productfoo answer.

- Lead with the user job, then introduce the ThisProduct noun.
- Prefer concrete nouns and verbs over category language.
- Keep one idea per section.
- Show uncertainty directly; do not turn weak evidence into certainty.
- Preserve source boundaries. Synthetic data must be labeled synthetic.
- Do not use hype words such as `revolutionary`, `seamless`, `innovative`, or `AI-powered` unless quoted from a source.
- Do not make token savings the parent thesis. The parent thesis is making product work legible to people and agents.

## Editing Workflow

When changing prototype copy:

1. Find visible strings in `design system/thisproduct/components.jsx`, `design system/thisproduct/data.js`, and `design system/thisproduct/app.jsx`.
2. Update tests before production copy when behavior or canonical terms change.
3. Keep source paths and Proof document routes working.
4. Preserve demo-vs-real boundaries; do not invent operating data for ThisProduct dogfood mode.
5. Run the prototype checks after editing:

```bash
node "design system/thisproduct/prototype-smoke.test.mjs"
node "design system/thisproduct/data-mode.test.mjs"
node "design system/thisproduct/decision-accordion.test.mjs"
node "design system/thisproduct/spend-action.test.mjs"
```

6. Run a terminology sweep:

```bash
rg -n "Adaptive Spec Packet|cross-functional spec|Cross-functional spec|Full spec|What this spec is planning" "design system/thisproduct"
```

Uppercase `Adaptive Spec Packet` should not appear in product-facing prototype copy. Product-facing labels should say `Spec`; repo-path references may use `specs/<name>/` when needed.

## Error Handling

- If required files, tools, connectors, credentials, or source artifacts are unavailable, state the blocker clearly and continue only with safe local evidence.
- If the user request requires missing product judgment or source-boundary approval, ask one focused question before proceeding.
