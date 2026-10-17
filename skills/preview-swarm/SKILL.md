---
name: preview-swarm
description: "Use when a spec packet, PRD-like spec, or approved intake summary needs a visual build preview, divergent product theses, selectable/commentable preview elements, convergence controls, or spec-updating feedback bundles before implementation."
---

# Preview Swarm

Generate a self-contained, production-grade mini app that helps a user inspect and steer the agent's product judgment before implementation, then export agreed feedback back into the spec loop. Hold the `## Visual Quality Bar` below: a rough wireframe is a defect, not the target.

The goal is to make product and design judgment legible: what each direction believes, why it believes it, what it sacrifices, how confident it is, where dissent exists, and what still requires human judgment. Legibility leads and never gets traded away for decoration — but legibility no longer excuses low fidelity. The artifact must clear the `## Visual Quality Bar`; a wireframe register reads as broken software, not as "this is only a preview."

A Build Preview is a control surface, not a design handoff or stage gate. Default to one strong Build Preview when the spec points to a clear product shape. Use divergent directions only when comparison is the real product question or when multiple materially valid app structures remain unresolved.

The artifact must zoom out before it zooms in, but it must not bury the Build Preview under meta-review UI. Default to a Loopframe workbench: compact direction and page controls, one dominant preview canvas, and a right rail that explains the selected panel through the agentic loop. Let the user compare or borrow from other directions only in the context of the selected preview panel. If the user is forced to parse tables, chip walls, or separate mix-and-match inventories before the Build Preview becomes useful, the artifact has failed.

A Loopframe previews agency, not only layout:

`user surface -> agent read -> evidence thread -> action proposal -> approval boundary -> outcome/regeneration note`

Every selected panel should show what the agent believes, why it believes it, what it would do next, and where human approval is required.

## Visual Quality Bar

A Build Preview must clear a real visual-craft bar. "Make product judgment legible" is the job; a rough wireframe is a defect, not the intended register. Generate the artifact at the fidelity a designer expects from a modern frontend tool — clear hierarchy, deliberate type and spacing, realistic data, finished interaction states — then hold the clarity-first defaults on top of it. Polish never outranks legibility, but low fidelity is no longer acceptable.

Reach the bar through whatever generation capability the running harness actually has. Detect the affordance; do not assume it — productfoo runs in arbitrary harnesses and must fall back gracefully:

1. **Harness with a design-generation skill (for example `frontend-design`):** generate the artifact UI through that skill so the preview inherits its production-grade, non-generic frontend output. Give it the spec's product bet, domain data, and the Loopframe / divergence / feedback requirements below as the brief.
2. **Harness without one:** generate with a shadcn/React/Tailwind component vocabulary and use Impeccable as the craft gate (see `## Impeccable Collaboration Contract`). Port shadcn component patterns into the artifact; the npm package is not required.
3. **Neither a design-generation skill nor Impeccable:** fall back to the editorial visual grammar in `references/html-effectiveness-build-previews.md` when that local reference is available. If it is missing, record the unavailable local reference and craft-gate gap; do not fetch it remotely or silently ship the fallback as if the bar was met.

Whatever path runs, preserve the properties that make a Build Preview a control surface rather than just a mockup:

- **Self-contained and runnable with no local setup.** One artifact the user can open or paste-run with no build step, server, or account. React and Tailwind are allowed via CDN (a CDN React runtime plus the Tailwind CDN and an in-browser transform); a local build toolchain is not. The `localStorage` feedback persistence in `## HTML Mini App Requirements` must keep working.
- **The productfoo layer is non-negotiable** and is exactly what the mockup tools do not do: divergent product theses (`## Divergence Contract`), the Loopframe read (agent belief, evidence, approval boundary), and the comment-to-spec feedback loop (`## Comment Handoff`). The quality bar is additive — it never displaces these.
- **Clarity-first still governs.** Higher fidelity is not license for more surface area: `## Clarity-First Defaults`, "overwhelm is a P1," and "each revision subtracts" all still apply.

## Usage

Use with a spec packet, PRD-like spec, approved `interview-me` intake summary, or `spec-swarm` report:

```text
Use $preview-swarm on <path-or-summary>
```

If no artifact is provided, ask for the spec path, packet path, or approved intake summary before generating Build Previews.

## Preview Speed Contract

The mini app must feel faster than recovering from a plausible wrong build:

- Default to one strong preview when the source material already implies the product model.
- Divergent variants are only required when the app shape, audience, workflow model, or trust posture has multiple materially valid answers.
- Keep the first screen skimmable in under 60 seconds.
- Put explicit control actions in the artifact: `Build this`, `Revise direction`, `Show alternatives`, and `Skip preview next time`.
- Do not ask the user to review layout details that will be cheaper to fix after generation.
- Do not create a Build Preview checkpoint at all when the user clearly wants direct-to-app exploration and the risk is low.

## Clarity-First Defaults

The artifact has failed if a developer finds it confusing. Apply before the first show, every time. Full version in `references/html-effectiveness-build-previews.md`.

- One decision per screen, three choices or fewer; frame trade-offs as a labeled spectrum with exactly one recommendation.
- Plain language leads. Put commands, JSON, event schemas, and requirement IDs behind a single "show detail" disclosure — a terminal or raw-JSON default reads as a wireframe.
- Show outcomes with plain cards and state chips, not command output.
- Each revision subtracts: fewer words, controls, and detector findings. Adding surface area needs a reason.
- Fix detector P0/P1 before showing, do not merely report them; the user calling it busy or confusing is itself a P1.

## Inputs

Read the provided artifact and extract:

- Product bet
- Primary user, buyer, or reviewer
- Core workflow
- Page inventory implied by the workflow
- Component inventory implied by the workflow
- Required decisions the UI must support
- Trust, provenance, confidence, or dissent requirements
- Evidence boundary and private-source restrictions
- MVP boundary and explicit non-goals
- Existing open questions
- Swarm judgments or role-lens dissent, if available

Do not use raw private notes, transcripts, or source material unless the user explicitly approved them for this work.

## HTML Effectiveness Style

Before generating or materially revising the HTML mini app, read `references/html-effectiveness-build-previews.md`. Use it to translate the spec into a spatial, interactive artifact rather than a styled Markdown document.

Required style commitments:

- Make the artifact self-contained: one artifact the user can open or paste-run, no local build step, no server, no account. CDN-loaded React/Tailwind is allowed; a build toolchain is not.
- Put the Build Preview workbench above the fold: selected direction, selected page, dominant preview canvas, and right rail context.
- Use compact direction/page controls for divergence. Do not use a table, chip wall, or card gallery as the primary experience unless the user explicitly asks for comparison-first review.
- Do not render a separate storyboard when direction/page controls already switch the preview. Option switching must stay visually secondary: compact labels or segmented controls, no duplicate navigation rails, and the preview canvas should get the width.
- Start with the selected option's Build Preview immediately. Page purpose, promises, trace IDs, and evidence should appear in the rail after selection.
- Make the Build Preview the dominant object in the focused view. Keep page purpose, promises, and entry/exit context compact or in the rail so the sketch is not pushed below the fold.
- Do not render decision context as a permanent full-width card strip above the workbench. Put product bet, evidence boundary, source spec, and human-judgment context in a compact header line, the rail, or a closed `details` disclosure unless that context is the decision being reviewed.
- Use realistic fake product data inside preview panels. Fake names, records, dates, states, source labels, and edge cases should feel grounded in the spec domain. Avoid anonymous gray bars except as subtle secondary texture.
- In the context rail, render a Loopframe read for the selected panel: what this proves, agent belief, evidence, risk/gap, proposed spec change, approval boundary, and regeneration note.
- Keep rationale close to the thing it explains: inline chips, compact captions, hover/focus detail, or an adjacent detail tray; avoid long detached explanation panels.
- Use a sticky toolbar for mode, filters, feedback handoff, and convergence state.
- Treat feedback handoff as one clear path: a floating composer opens from the selected target or rail, saves locally, and immediately prepares an agent-ready Markdown handoff; JSON stays behind `Show details` for debugging, never as a competing primary action.
- When the generation path falls back to hand-written styling (no design-generation skill, no shadcn/Tailwind, no product design system), prefer warm editorial structure, thin borders, compact mono labels, serif display headings, and restrained color accents — the visual grammar in `references/html-effectiveness-build-previews.md`. This is the floor, not the target; prefer the `## Visual Quality Bar` paths above it.

Do not copy the guide's examples verbatim. Borrow the communication patterns: spatial comparison, live rendered choices, annotated structure, compact summaries, and export back into the agent/spec loop.

## Builder Expert Preflight

Before generating or materially revising the mini app, consult builder experts on the interaction patterns the artifact will use. Do this before writing HTML, CSS, or JavaScript.

Required builder lenses for every Build Preview mini app:

- `design engineer`: information hierarchy, interaction affordances, rationale placement, responsive composition, and whether the UI explains itself through controls instead of instruction prose.
- `front-end engineer`: browser interaction patterns, established libraries, gesture behavior, drag/drop, zoom/pan, state management, export behavior, and where hand-rolled code is risky.
- `accessibility engineer`: keyboard paths, focus states, hover alternatives, touch targets, labels, contrast, and screen-reader impact.
- `QA engineer`: the minimum visual and interaction checks needed before showing the artifact.

Conditional builder lenses:

- `back-end engineer`: required when comments, decisions, exports, auth, collaboration, persistence, or APIs need server ownership.
- `data engineer`: required when the artifact defines events, feedback schemas, metrics, provenance, freshness, or downstream analysis fields.
- `infrastructure engineer`: required when hosting, deployment, storage, background jobs, performance envelopes, or environment configuration matter.
- `security engineer`: required when the artifact touches private sources, PII, permissions, sharing, exports, auth, or source-boundary approval.

If a named builder skill is not available, apply the closest existing role lens and record the gap. Do not silently skip a missing builder expert.

Render a compact builder-preflight ledger before or alongside the artifact:

| Pattern / decision | Builder experts consulted | Recommendation | Applied? | Residual risk |
| --- | --- | --- | --- | --- |

Do not hand-roll established interaction primitives such as pan/zoom canvases, drag/drop, comment anchoring, keyboard navigation, or export schemas until the front-end engineer lens has either recommended a proven library/pattern or accepted a self-contained implementation with a clear reason.

When using a self-contained HTML artifact, still consult library and platform patterns. The final artifact may remain dependency-free, but its behavior should follow proven patterns for the interaction.

Builder pattern gaps must be included in the output when the current skill library lacks a distinct builder lens, especially for front-end engineering, design engineering, back-end engineering, data engineering, infrastructure engineering, or security engineering.

## Impeccable Collaboration Contract

Use Impeccable in concert with `preview-swarm` whenever the installed skill is available. Impeccable owns frontend craft pressure; `preview-swarm` owns packet traceability, divergence, comments, and spec feedback.

Start every material Build Preview run by loading project context for the source or expected artifact:

```bash
node .agents/skills/impeccable/scripts/context.mjs --target <artifact-or-source>
```

Apply the returned product/design context to the Build Preview artifact before choosing layout, density, visual register, interaction vocabulary, or review depth.

Use the Impeccable command that matches the moment:

- `$impeccable shape <source-or-shape-brief>` before generation when there is no accepted Shape Brief, design direction, product model, or visual/interaction posture.
- `$impeccable critique <artifact>` after every generated or materially revised HTML artifact.
- `$impeccable audit <artifact>` when the artifact is responsive, interactive, accessibility-sensitive, keyboard-driven, state-rich, or production-like.
- `$impeccable polish <artifact>` when critique or audit reports P0/P1 issues, detector hits, weak hierarchy, confusing affordances, low realism, contrast problems, or interaction gaps.

Do not mark the preview-swarm output complete until one of these is true:

- Impeccable critique ran, the persisted critique path and score are recorded, and all P0/P1 findings are fixed or explicitly accepted as residual risk.
- Impeccable was unavailable, and a manual review gap is recorded with equivalent findings for hierarchy, realism, interaction clarity, responsive behavior, accessibility, and product-register fit.

Record the Impeccable results beside the artifact when possible. If working inside a packet, include critique, audit, or polish paths in the artifact notes or exported feedback bundle so later spec updates can trace design-review evidence.

## Interview Before Generation

Before generating the mini app, ask one question at a time when the spec does not already answer the decision. Use numbered options and the shared recommended-option style:

```text
Question: What kind of divergence should this run optimize for?

1. **Different product theses (Recommended)**
   Best when the goal is to discover the strongest product model, not just compare layouts.
2. Different interaction models
   Best when the product thesis is clear but the shape could be dashboard, board, wizard, canvas, or review queue.
3. Different review audiences
   Best when the same spec must work for PM, designer, engineer, exec, or customer reviewer.
4. Maximum spread
   Best for early exploration, but harder to converge because variants may differ on too many axes.
```

Rules:

- Keep options numbered `1` through `4` when the question can reasonably fit four choices.
- Mark exactly one option with `(Recommended)` when there is enough evidence to recommend.
- Bold the recommended option label in Markdown responses.
- In generated HTML, render recommended choices as cards or rows with a `Recommended` badge, stronger border, and subtle background.
- If no recommendation is defensible, say `No recommendation yet` before the options instead of faking one.
- Wait for the user's answer before asking the next question.
- Do not ask questions that can be answered from the spec, packet, code, design system, or approved evidence.

High-value interview questions:

- What should divergent Build Previews optimize for first?
- What object model should anchor the IA: user journey, page map, entity map, task flow, or review workflow?
- Which pages must exist before component details make sense?
- Which reusable components are strategic decisions rather than implementation details?
- What decision should the user be able to make from the first screen?
- What must be visible without clicking?
- What should stay hidden until needed?
- What trust or provenance must the UI show?
- What would make the Build Preview misleading or fake?
- What is the convergence rule: pick one direction, merge parts, or annotate until accepted?

## Divergence Contract

Generate divergence through different product theses, not only through styling. Divergent variants are only valuable when they expose a real product decision. If the source artifact already supports one clear build direction, generate one strong preview and put alternatives behind `Show alternatives`.

When divergence is warranted, default to 3-5 variants:

- `workflow-first`: fastest path through the user job.
- `trust-first`: provenance, confidence, dissent, and human judgment are most visible.
- `comparison-first`: alternatives are side by side and easy to evaluate.
- `decision-ledger-first`: changes, rationale, and agreement state are primary.
- `collaboration-first`: comments, owners, decisions, and handoffs are primary.
- `radical-alt`: intentionally challenges the obvious screen model.

Each variant must include:

- An IA summary that names the variant's pages, page relationships, and core objects.
- A page map that lets the user click into each page.
- Large clickable preview panels that let the user click important reusable components from the selected page.
- A rendered preview panel.
- A short thesis or rationale available on demand, such as an `i` control attached to the Build Preview.
- Requirement coverage.
- The tradeoff it makes.
- What it sacrifices.
- Confidence.
- Dissent or caveat.
- What still needs human judgment.

Do not make rationale, confidence, or agent opinion the dominant persistent UI unless the user explicitly asks for a review ledger view. Prefer compact, on-demand rationale attached to the relevant preview element.

## IA Drilldown Contract

Every generated mini app must support this zoom path:

1. **Option switcher:** Show each divergent option as a compact control with option ID, thesis, and recommendation status.
2. **Page switcher:** Show the selected option's pages as a compact segmented control or minimal stepper, with the current page selected.
3. **Page focus:** Let the user select a page to see its purpose, entry conditions, exit conditions, primary components, and requirements covered.
4. **Component context:** Let the user click a reusable component from the selected page and show its context in the same lightweight rail or tray used for comments.
5. **Element detail:** Let the user select/comment on specific elements only after their page context is visible. Infer or attach component context when the element belongs to a component.

Model option labels like `1a`, `1b`, `1c`, and `1d` as variants of the same IA problem. Each option must make clear:

- Which pages exist.
- Which pages are omitted or deferred.
- Which components are shared.
- Which components are variant-specific.
- Which spec requirements are covered by each page/component.
- Which user decision the structure optimizes.

Do not produce four disconnected page mockups. Produce four navigable product structures with clickable pages and contextual component targets.

Avoid showing all pages and all components for all options at once. Prefer one selected option in focus, with lightweight controls to switch options.

Only add a storyboard when the storyboard itself is the product object being reviewed or when the IA cannot be understood from compact page controls and the preview canvas. Do not duplicate page controls with a storyboard rail.

## HTML Mini App Requirements

Generate one self-contained artifact the user can open or paste-run with no local setup. Reach the `## Visual Quality Bar` through the harness's generation path — a design-generation skill such as `frontend-design`, or shadcn/React/Tailwind via CDN with Impeccable as the gate, or the editorial fallback when neither exists. Do not require a build toolchain, server, or external account; CDN-loaded React/Tailwind is fine, a local build step is not.

Apply the Clarity-First Defaults first: the list below is a menu of elements to use when they earn their place under the clarity gate, not a mandate to render all of them at once. Default to the minimal set that makes the decision legible; add an element only when the artifact would fail the decision without it.

The mini app must include:

- A top decision strip with product bet, user/reviewer, decision to make, evidence boundary, and convergence status.
- Primary controls for `Build this`, `Revise direction`, `Show alternatives`, and `Skip preview next time`.
- Compact direction and page controls before the preview canvas.
- Contextual alternatives in the rail for the currently selected panel, so the user can borrow from other directions without leaving the Build Preview.
- A minimal page switcher for the selected variant, unless the artifact is explicitly about a storyboard.
- Clickable component panels inside the Build Preview. Avoid a separate component chip/list when the panel itself can be clicked.
- Realistic fake data in the preview canvas that demonstrates the workflow, records, states, errors, and privacy/provenance boundaries the spec cares about.
- A selected-page detail view with purpose, user promises, states, unresolved questions, and secondary requirement trace IDs.
- Component context shown in the click target summary or comment rail; do not require a separate selected-component inventory rail.
- Agent judgment for the selected panel: belief, evidence, uncertainty, proposed action, approval boundary, accepted spec changes, unresolved questions, and regeneration notes.
- Divergent variants represented as digestible thumbnails plus focused drilldown, not a wall of equally detailed panels.
- Stable `data-node-id` attributes on meaningful preview elements.
- Click-to-select preview elements.
- Comment entry for the selected element.
- Comment tags for `visual`, `workflow`, `copy`, `requirement`, `open-question`, and `cut`.
- Comment statuses for `proposed`, `accepted`, `rejected`, and `unresolved`.
- Client-side comment persistence: store comments in `localStorage` keyed by the packet Spec ID (set `data-spec-id` on `<body>`), load and re-render them on `DOMContentLoaded`, and save on every add/edit/delete/status change so feedback survives a reload without a server. Persistence is local convenience only; it must not write canonical packet files (R-009) and must not imply the comment is shared, synced, or applied.
- A canonical reference per comment of the form `<spec-id>#<node-id>`, plus an in-artifact deep link `#node=<node-id>`. On load, read `location.hash`; if it names a node, scroll to that `data-node-id` element and briefly flash it so the link round-trips.
- An obvious, persistent comment affordance with exactly one primary hand-back action: `Send to agent chat`. It compiles all saved comments into agent-ready Markdown, writes it to the clipboard, updates a visible "ready to paste" state, and (when embedded in an agent host) may post a `window.postMessage({ type: "foo.preview.feedback", format: "markdown", text })` event for automatic chat insertion. Do not present parallel primary actions such as Copy Markdown, Copy JSON, Export, or Download in the main review path.
- Controls to mark each variant as `keep`, `maybe`, or `cut`.
- A way to select one base direction.
- A way to mark specific panel-level ideas borrowed from other variants, shown beside the panel being reviewed rather than in a separate inventory.
- One primary `Send to agent chat` button that writes the compiled Markdown bundle to the clipboard (`navigator.clipboard.writeText`) with a confirmation toast and tries the host handoff event above. Each Markdown entry must render its canonical `#node=<node-id>` deep link inline so a downstream agent or person can jump back to the exact element. A secondary `Show details` disclosure may expose JSON for debugging or trace review, but JSON must not compete with the main hand-back action.
- Rationale, confidence, and dissent available on demand on the Build Preview itself, not as a large instruction panel.
- Direct affordances for important interactions. Prefer visible controls and familiar icons over instructional copy.
- A lightweight context rail on desktop, or tray on narrow screens, that shows the selected target and component information. The comment box itself should open as a floating composer/popover from a compact `Add comment` affordance, not live permanently inside the rail. Keep status, tags, spec impact, and export metadata minimal or progressive; do not make a persistent review-ops panel the dominant UI unless the user asks for it.
- A compact user-promise strip so the user can see which outcomes each direction protects or sacrifices. Keep raw requirement IDs as secondary trace metadata in the context/comment rail and export.

Recommended options and selected options inside the mini app must be separate states. The selected option owns the filled highlight: stronger border, filled background, and optional shadow/ring. A recommended-but-not-selected option must stay quieter than the selected option, using a badge plus a quiet outline or neutral background instead of the same filled treatment. Direction controls must update `aria-pressed` whenever selection changes.

Use this reusable pattern as a starting point:

```css
.option.active {
  border: 2px solid #7c5cff;
  background: #f4f1ff;
  box-shadow: 0 0 0 3px rgba(124, 92, 255, .14);
}

.option.recommended:not(.active) {
  border: 2px solid #c7bfff;
  background: #fff;
}

.recommended-badge {
  display: inline-block;
  font-weight: 700;
}
```

Adapt colors to the repo or product design system when one exists, but preserve the pattern: the selected state is the only filled card state; the recommendation is a badge or quieter secondary treatment when it is not selected.

## Design Review Gate

Before returning a generated or materially revised HTML artifact, run a design review on the written file.

- Follow the `Impeccable Collaboration Contract` above before using this fallback checklist.
- When Impeccable is available, run `$impeccable critique <artifact>` and persist the critique snapshot.
- If the artifact promises responsive behavior, accessibility, production-like polish, or important interaction mechanics, also run `$impeccable audit <artifact>` or `$impeccable polish <artifact>` as appropriate.
- Report the critique snapshot path, score, P0/P1 findings, detector/browser checks, and unresolved design risks in the final output.
- If Impeccable is unavailable, record the gap and perform a manual review against the same concerns: hierarchy, realism, interaction clarity, responsive behavior, accessibility, and whether the artifact feels like usable software.

## Comment Handoff

The comment path must feel like chatting with the preview, not managing an export panel:

1. The user selects a preview element.
2. The right rail or selected target shows one compact `Add comment` control.
3. Pressing it opens a floating composer near the selected target or lower-right viewport. The composer contains one textarea and one primary button: `Send to agent chat`.
4. Pressing the primary button saves the comment locally, compiles every saved comment into Markdown, copies that Markdown to the clipboard, and fires `window.postMessage({ type: "foo.preview.feedback", format: "markdown", text })` for hosts that can insert the feedback into chat automatically.
5. The UI confirms the next step in plain language: `Copied for chat` or `Sent to agent chat`.
6. JSON is available only inside `Show details`; it is a support artifact, not the user-facing handoff path.

The generated Markdown is the primary handoff. It should start with a direct instruction the user can paste without editing, for example:

```markdown
Please apply this Build Preview feedback. Treat proposed comments as review input; ask before changing spec requirements.

## Comments
- [workflow · proposed] The approval step is too hidden. (foo_preview_v0#approval-panel, #node=approval-panel)
```

The JSON details must remain structured enough for an agent to update the mini app and, after agreement, update the spec:

```json
{
  "source_spec": "specs/example/spec.md",
  "build_preview_artifact": "preview.html",
  "selected_direction": "trust-first",
  "adopted_panels": [
    {
      "from_variant": "comparison-first",
      "from_option": "1C",
      "from_page": "compare",
      "label": "Tradeoff summary",
      "description": "Explains what the host gains and gives up with each setup."
    }
  ],
  "comments": [
    {
      "id": "cmt_001",
      "node_id": "trust-first.confidence-chip",
      "ref": "build_preview_mini_apps_v0#trust-first.confidence-chip",
      "link": "#node=trust-first.confidence-chip",
      "variant": "trust-first",
      "spec_trace": ["R-003", "R-007"],
      "comment": "This needs to explain why confidence is low.",
      "tag": "requirement",
      "status": "accepted",
      "spec_impact": "Add requirement for low-confidence explanation."
    }
  ]
}
```

The `ref` and `link` fields are the canonical element pointers. `ref` is the paste-able `<spec-id>#<node-id>` token; `link` is the deep link that re-focuses the element when the artifact is reopened. The bundle is sourced from the persisted `localStorage` comments, so a reload-then-export still produces a complete bundle.

## Updating The Spec

Do not treat every comment as product truth. A comment may update the spec only when it is explicitly marked `accepted` or the user separately approves it.

When applying an accepted bundle:

1. Separate visual-only feedback from product requirements.
2. Update the HTML mini app for visual or interaction changes.
3. Update `spec.md` only for accepted requirement, workflow, source-boundary, validation, or non-goal changes.
4. Preserve unresolved comments as open questions.
5. Append a decision or review event to `events.jsonl` when working inside a spec packet.

## Output

Return:

- The generated HTML artifact path.
- The HTML Effectiveness patterns applied.
- The builder-preflight ledger.
- Whether the run produced one strong preview or divergent variants, and why.
- The divergence axes used, if divergence was warranted.
- The recommended base direction, if one is defensible.
- The single comment handoff path, including whether host auto-insert was available or the fallback was clipboard-ready Markdown.
- Builder pattern gaps and whether new swarm skills are needed.
- The Impeccable collaboration result: context target, shape decision, critique path, score, P0/P1 findings, audit/polish status, detector/browser checks, or the recorded review gap.
- Any user-judgment questions that remain.

## Error Handling

- If the spec or intake summary is missing, ask for it before generating Build Previews.
- If the artifact is too thin to support real divergence, route back to `interview-me` before generating fake options.
- If the request requires product taste or source-boundary approval, ask one focused question before proceeding.
- If comments are handed back without accepted statuses, summarize them as proposed feedback and ask for agreement before updating the spec.
- If the HTML artifact cannot be written, provide the complete artifact content in the response only as a fallback.
