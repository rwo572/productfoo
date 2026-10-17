# HTML Effectiveness Patterns For Spec Build Previews

Use these patterns as the styling fallback when `preview-swarm` cannot reach its `Visual Quality Bar` through a design-generation skill (such as `frontend-design`) or a shadcn/React/Tailwind + Impeccable path, and must hand-write the artifact's HTML/CSS. The information-design, divergence, and convergence patterns below apply on every path; the visual grammar is the floor for the hand-written fallback. They are derived from Thariq Shihipar's "Unreasonable Effectiveness of HTML" examples, especially exploration, visual directions, implementation plans, research explainers, and custom editors.

## Core Pattern

HTML works when it replaces flat prose with a spatial artifact the user can inspect, manipulate, and export.

For spec Build Previews, that means:

- Render competing directions live instead of describing them.
- Put tradeoffs next to the visual choice they explain.
- Make the user's convergence action part of the artifact.
- Use one obvious comment handoff that an agent can apply from chat: open a floating popover composer, save the comment, copy/send Markdown, and hide JSON details unless requested.
- Start at information architecture, then progressively reveal pages, components, and element comments.
- For agentic products, use Loopframes: show the user surface, agent read, evidence thread, action proposal, approval boundary, and regeneration note for the selected panel.

## Clarity-First Defaults

The artifact has failed if a developer finds it confusing. Lead with the decision in plain language; make the technical truth available, never the default surface. Apply these before the first show, every time — they override the maximalist element lists a generator may carry.

1. **One decision per screen, three choices or fewer.** Frame a trade-off as a labeled spectrum (for example cautious -> balanced -> fast) with exactly one recommendation. Cut any mode, tab, or panel that is not load-bearing for the decision.
2. **Plain language leads; jargon follows on demand.** Put commands, JSON, event schemas, requirement IDs, and other implementation detail behind a single "show detail" disclosure. A terminal or raw-JSON surface as the default reads as an unfinished wireframe, not a decision aid.
3. **Show outcomes, not mechanics.** Prefer plain-language cards and state chips (`source -> held`) over command output or config dumps. Keep realistic data minimal and domain-true.
4. **Each revision subtracts.** A good iteration removes words, controls, and panels. Track it concretely: fewer detector findings, fewer lines, fewer choices. If a revision adds surface area, justify why the decision needs it.
5. **Fix before you show.** Run the deterministic detector, fix every P0/P1 rather than merely reporting it, ground the visual register in the product's anti-references so it avoids generic AI slop, then re-run the detector and confirm the count dropped. Showing an unfixed artifact is the failure.
6. **Overwhelm is a P1.** If the user calls the artifact busy, confusing, or hard to parse, treat it as a blocking defect, not polish. The fix is almost always subtraction plus progressive disclosure, not more explanation.

## Page Anatomy

Use this structure by default:

1. Sticky toolbar
   - Mode: compare, annotate, converge.
   - Filters: accepted, proposed, unresolved, cut.
   - One feedback handoff control: `Send to agent chat`; secondary JSON details only inside a disclosure.
   - Current counts: variants kept/cut, comments, accepted spec impacts.

2. Page header
   - Eyebrow: artifact type and source spec.
   - Title: the product/spec decision, not a generic "Build Previews" label.
   - Prompt box: one compact sentence describing what the artifact is trying to help decide.

3. Decision strip
   - Decision context is on-demand by default, not a row of always-visible cards.
   - Keep product bet, primary user/reviewer, core workflow, evidence boundary, current recommendation, and open human judgment in a compact header line, rail, or closed disclosure unless those facts are the current object of review.
   - If a context strip is needed, it must be visually smaller than the direction controls and preview canvas.

4. Build Preview workbench
   - Compact controls for direction and page selection.
   - One large selected Build Preview above the fold.
   - Component panels inside the Build Preview are the primary click targets.
   - Do not make tables, chip walls, card galleries, or separate mix-and-match inventories the primary experience.
   - Do not duplicate page controls with a storyboard or second navigation rail. The preview canvas should get the width.

5. Page and component context
   - Selected page purpose, entry, exit, primary components, states, user promises, and secondary requirement traces.
   - Component context attached to the actual preview panels whenever possible.
   - Selected component usage, ownership, states, and spec impact appears in the context/comment rail or target summary, not a separate component inventory inspector.

6. Lightweight context/comment rail
   - Shows the selected page, component, or element.
   - Shows the agent's read of the selected target: belief, evidence, risk, proposed spec action, approval boundary, and regeneration note.
   - Offers a compact `Add comment` affordance; the textarea and metadata controls open in a floating popover instead of living permanently in the rail.
   - Offers alternatives from other directions only for the selected panel.
   - Records adopted alternatives as structured output.
   - Keeps tags, status, spec impact, and export preview available but not visually dominant.
   - Uses a right rail on desktop and collapses to a tray on narrow screens.
   - Avoids a permanent review-ops panel unless the artifact is explicitly about review operations.

7. Spec impact section
   - Requirement coverage table or chips.
   - Accepted changes grouped by requirement, workflow, source boundary, validation, or non-goal.
   - Unresolved comments as open questions.

## Visual Grammar

When no design-generation skill, shadcn/Tailwind path, or product design system is available, use the guide's broad editorial grammar rather than generic dashboard chrome:

- Warm paper background, white artboards, charcoal text.
- Thin 1.5px borders and small radius.
- Serif display heading, system sans body, mono labels/chips.
- One restrained accent color, but do not collapse selected and recommended into the same treatment: the selected direction owns the filled highlight, while recommended-but-not-selected stays a badge or quiet outline.
- Compact uppercase eyebrows for context.
- Sticky controls, not long instruction copy.
- Cards only for individual artifacts, variants, tickets, or controls; avoid nested card stacks.
- Realistic fake product data: plausible names, records, dates, statuses, source labels, privacy states, and edge cases that make the spec behavior concrete.

Avoid:

- Decorative gradients, large empty hero sections, or marketing layouts.
- Build Previews that are just gray boxes without product meaning.
- Placeholder bars as the main content of a component panel. Use fake data first, then visual texture only if it helps scanning.
- Dense grids that expose every page/component at once.
- Long detached rationale panels that make the user read before seeing.
- Multiple competing export buttons. There should be one obvious path back to the agent chat; JSON/debug details stay secondary.

## Information Design For Specs

Map spec information to visual regions:

| Spec information | HTML treatment |
| --- | --- |
| Product bet | Header title or decision strip |
| Primary user/reviewer | Decision strip chip |
| Core workflow | Compact page switcher or rail context |
| Page inventory | Minimal segmented control or stepper for the selected variant |
| Component inventory | Clickable preview panels scoped to the selected page; use chips only when no panel exists |
| Requirements | Plain-language user-promise chips on each page/component, with raw IDs only in trace metadata |
| Evidence boundary | Small provenance chip or rail |
| Confidence/dissent | Inline badge or on-demand detail near the relevant element |
| Open questions | Context/comment rail and exportable Markdown |
| Accepted comments | Spec impact section and JSON export |
| Non-goals/cut line | Cut column, strike treatment, or explicit chips |
| Validation bar | Footer checklist or spec impact table |
| Agent belief | Loopframe rail attached to the selected panel |
| Agent action proposal | Suggested spec change with explicit approval boundary |
| Regeneration note | Exportable instruction for the next Build Preview iteration |

Fake data should be chosen from the spec's domain. For scheduling, show realistic meeting titles, public links, host and guest timezones, available and blocked slots, stale availability states, masked private calendar fields, and writeback evidence. For another domain, translate the same principle into domain-specific records and states.

## Divergence Patterns

Use real product-shape differences:

- Product thesis: trust-first vs workflow-first vs comparison-first.
- Interaction model: dashboard, board, wizard, canvas, timeline, queue.
- Reviewer lens: PM, designer, engineering, exec, customer-facing reviewer.
- Density: sparse decision surface vs dense review artifact.
- Evidence posture: provenance always visible vs disclosure-on-demand.

Do not produce variants that only change color, spacing, or icon style.

Represent each divergent option as a navigable IA, not only as a screen:

- `1a` can be a linear setup flow with preview and publish pages.
- `1b` can be a trust/proof architecture with privacy review and recheck pages.
- `1c` can be a comparison architecture with multiple link configurations and tradeoff pages.
- `1d` can be a decision-ledger architecture with review queues and unresolved decisions.

Each option should state which pages and components it adds, removes, combines, or defers.

Use Progressive Storyboard only when the IA is hard to digest or when the storyboard itself is the artifact being reviewed. Do not duplicate page controls with a storyboard:

- Put one option in focus.
- Show its journey as a minimal sequence with clear next/previous controls.
- Keep components hidden until a page is selected.
- In the selected page view, let the Build Preview dominate. Keep page summary and promise context compact or move it to the rail.
- Put component context on click in the same right rail or target summary used for comments.
- Prefer one component-click surface. If a preview panel already represents a component, do not also render a separate component chip for it.
- Avoid a separate component inventory rail or selected-component card unless the artifact is explicitly about comparing component inventories.
- Put comments in a lightweight right rail, tray, popover, or bottom sheet rather than around every node.
- Translate requirement IDs into user promises before rendering the canvas. Raw IDs belong in the right rail under `Spec trace`, not as the primary page language.
- Let the user compare options through compact direction controls and contextual alternatives. Use decision boards or thumbnails only when they add evidence, not as the main mechanism.

## Convergence Patterns

Borrow from custom editor examples:

- The artifact should let users manipulate the specific object under review.
- Comments should attach to elements, not only to the whole page.
- Comments should also be able to attach to pages and components.
- Commenting should feel lightweight: select target, write note, save. Advanced metadata can be inferred, hidden, or reviewed at export time.
- Keep/maybe/cut should be visible and reversible.
- Accepted comments should be separated from proposed comments.
- The primary handoff should copy/send only the useful Markdown result, not the whole UI state dump. JSON can exist behind `Show details` for agents that need structure.

The generated JSON should preserve enough structure for an agent to update `spec.md`, regenerate the HTML, or append packet events.
