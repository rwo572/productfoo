# Agent Skill Governance

This directory contains the canonical agent skills. The skills should stay runtime-neutral: write for agents and humans first, then let each runtime map tools, connectors, and packaging details.

## Directory Contract

- Keep one folder per skill.
- Keep folders flat; do not nest by domain.
- Name each folder exactly the same as the skill frontmatter `name`.
- Put executable behavior in `SKILL.md`.
- Keep broad product direction, RFCs, and research outside this directory.
- Keep raw private notes, transcripts, and source dumps out of this repo.

## Canonical Skills vs Installed Helper Skills

`skills/` is the canonical productfoo skill tree. Edit this directory when changing productfoo product behavior, routing, governance, or reusable role patterns.

The root `.agents/` directory is different: it is an installed helper-skill bundle pinned by `skills-lock.json`. It may contain third-party or imported skills such as Impeccable and frontend-design helpers. Do not treat `.agents/skills/*` as a second canonical productfoo skill home, and do not patch it to change productfoo behavior. If behavior should become part of productfoo, promote it into `skills/<name>/SKILL.md` and add or update `skills/skill-registry.yaml`.

## Skill Anatomy

Every skill must have:

- YAML frontmatter with `name` and `description`.
- A clear `## Usage` section.
- A clear `## Error Handling` section.
- Trigger language that says when to use the skill.
- Runtime-neutral instructions unless the skill is explicitly an adapter.
- Agent-native technology choices by default: shared workspaces, primitive tools, prompt-defined behavior, explicit judgment, and human-visible artifacts. If a choice cannot be made agent-native, ask the human to choose the tradeoff.

Prefer these terms:

- `agent` instead of naming a specific runtime.
- `tool` or `connector` instead of a vendor-specific API name, unless the dependency is real.
- `artifact` instead of a platform-specific output type.
- `source` and `evidence` instead of opaque context.

## Shared Human-Output Voice

`product-copywriting/references/foo-voice.md` is the canonical productfoo voice block,
implementing the accepted brand guidance. The existing swarm generator embeds
it in all 25 persona files; standalone roast, interview, CPO, grilling, generic
swarm and copywriting skills load it with the trusted `foo skill` reference path.
Do not fork the rules by model or hand-edit their generated copies. Regenerate
reviewers and the tree anchor after editing the reference. Evidence types,
output schemas, consultation and question budgets remain owned by their existing
contracts. Delivery checks do not prove model compliance or user comprehension.

## Registry Governance

`skills/skill-registry.yaml` is the canonical inventory. Update it when adding, renaming, removing, deprecating, or reclassifying a skill.

Each registry entry should make routing legible:

- `domain`: capability family for grouping.
- `surface`: interaction shape, such as `workflow_agent`, `advisor_agent`, `router_agent`, `domain_tool`, `scheduled_agent`, or `output_transformer`.
- `callers`: whether humans, agents, or schedulers may invoke it.
- `connectors`: external systems the skill may read or write.
- `side_effects`: operational risks such as writing artifacts, reading external context, sending messages, scheduling work, or modifying data.

Do not use the registry as a prose doc. Use it for structured routing metadata.

## Bundled Trust Anchor

The installed product runs these skills with no hosted call and no per-machine
approval, so the build pins a digest of this tree — the anchor in
`src/skillClientPolicy.ts` — and resolves bundled skill text only while the
tree matches it. If you edit anything under `skills/` (content, registry,
generated swarm personas), regenerate the anchor and commit it with your
change:

```bash
node scripts/skill-tree-anchor.mjs
```

CI fails with a re-anchor instruction otherwise, and `npm test` includes the
same drift check. The package's own integrity (npm tarball hashes) binds the
install; the anchor binds every read of the shipped tree.

## Runtime Adapters

Canonical skills stay in `skills/`. Runtime command launchers are generated from
`commands/` and the CLI adapter renderer; do not mirror the skill tree into a
runtime directory or depend on compatibility symlinks.

Claude Code uses native command files for CLI-managed setup. The separately
packaged Anthropic plugin lives in `plugins/foo-anthropic/` and exposes its
namespaced commands. Codex uses a personal plugin installed with explicit global
setup. See [agent adapters](../docs/agent-adapters.md) for supported setup and
refresh instructions. Preview actual targets with:

```bash
bin/foo agent setup --agent all --scope project --dry-run
```

## Domain Taxonomy

Use the existing domains unless a new skill clearly does not fit:

- `product-planning`: specs, PRDs, expert review, release readiness, and strategy checks.
- `product-intelligence`: customer, roadmap, and project signal gathering.
- `research-ops`: research planning and synthesis capabilities. `customer-discovery` uses a proof-gated in-memory transcript path and commits sanitized evidence only. `study-digest` processes approved sanitized evidence, names every omitted source, and never invents quotes. `synthetic-customer` remains rehearsal-only agent inference, never real interview evidence.
- `comms-positioning`: competitive, positioning, PMM, and launch outputs.
- `research`: external paper and literature synthesis.
- `data-safety`: safety checks before source material is committed.
- `executive-work-os`: executive-readiness review.
- `design-system`: ThisProduct visual and interface guidance.

If a domain starts to hold unrelated skills, split the domain in the registry and update this README.

## Skill Types

- `workflow_agent`: Runs a multi-step workflow and usually writes artifacts.
- `advisor_agent`: Applies a focused expert lens or review pattern.
- `router_agent`: Chooses and coordinates other skills or lenses.
- `domain_tool`: Performs a bounded operation inside a domain.
- `scheduled_agent`: Can run on a recurring cadence.
- `output_transformer`: Rewrites, adapts, or packages an output.

Choose the smallest type that matches the skill. Do not create a workflow agent when an advisor or transformer is enough.

## Role Skill Rules

Role and swarm skills must preserve the product principle:

- Make human-agent collaboration stronger: clarify intent, inspect sources, route expert judgment, maintain packet truth, and surface only decisions that require human judgment.
- Make judgment legible: belief, evidence, confidence, dissent, and user-only decisions.
- Ask whether artifacts or expert lenses can answer before escalating to the user.
- Ask one question at a time when user input is required.
- Include a recommended answer when the skill has enough evidence; when presenting options, lead with that recommendation (mark it "(recommended)") then number the options (1, 2, …) so the user can reply with a single digit.
- Inspect source artifacts before asking questions that the repo or approved context can answer.
- When a role or swarm skill generates a runnable artifact, consult relevant builder experts before generation and make that preflight legible. Do not hand-roll established interaction, data, security, deployment, or accessibility patterns without an expert lens recommending the pattern or accepting the tradeoff.

### Generated Swarm Persona Skills

The 25 `spec-swarm-<persona>` skills are generated files: one canonical skeleton
(`spec-swarm/template/SKILL.template.md`, which carries the shared Expert
Preflight and Legible Judgment sections) plus one differentiated data block per
persona (`spec-swarm/template/personas/<persona>.md`). Edit the template or the
data block — never a generated `SKILL.md` — then run
`node scripts/build-swarm-skills.mjs`; CI runs its `--verify` drift check. The
rendered files stay full flat skills, so consumers and harnesses need no
knowledge of the template.

## Spec Finalization Skills

`spec-swarm` sharpens product judgment; `spec-cleanup` finalizes the packet for implementation.

Use `spec-cleanup` after accepted swarm changes, after major packet edits, or before implementation when a spec may contain mixed release tiers, underspecified JSON contracts, broad task dependencies, weak reconciliation mapping, or unresolved privacy and approval boundaries. It is the deterministic finalization gate, not another expert panel.

## Research Maintenance

Use `research-refresh` for decision-relevant upkeep of an existing brief or
analysis from approved evidence: claim-level amendments, preserved structure,
visible contradictions and a scoped no-change result. It does not schedule work
or create a new evidence-ingress lane. `competitive-positioning` reuses this
method for battlecard upkeep and offers optional strategic alternative analysis.
`discussion-guide` adds live question craft while retaining its draft lifecycle
and in-context sanitized-source boundary.

## Loop Evaluation Skills

Loop quality is judged separately from loop schema. `foo loop check` (and the B4 budget handshake) validate that a `loops.yaml` contract is well-formed; the loop-evaluation skills judge whether the loop is strong enough to trust for delegated work — a checkable goal, a visible check, a bounded stop, a proof-bearing handoff, and second-case reuse.

- Use `review-loop` to grade one loop spec (a `loops.yaml` entry, a routine, or a prose loop) in depth and produce candidate evals plus a next step; it can propose safe `--fix` edits but never widens a loop's permitted actions, boundaries, or budget.
- Use `loop-library-audit` for the roll-up across a loop library, registry, or every loop in a packet: proof coverage, second-case coverage, and which loops would push review burden back to a human. It delegates per-loop detail and fixes to `review-loop`.

This mirrors the `review-spec` (single, detailed) / `check-spec-health` (portfolio roll-up) split. Both loop skills are advisory judgment surfaces: they report and score, and route any change to what an acting loop may do back to a human decision.

## Preview And Shaping Skills

Build Preview and artifact-shaping skills are part of product planning, not a separate design playground.

- Use `product-shape-interview` when the next useful step is one accepted Shape Brief before generating a scenario artifact, workbench, Build Preview, or HTML mock.
- Use `preview-swarm` when the spec or packet needs a reviewable Build Preview, especially when divergent product theses, selectable/commentable preview elements, convergence controls, or exportable feedback bundles matter.
- Use `build-preview-spec` as the lightweight control-preview pattern for app-building agents that need to expose product shape, workflow, states, assumptions, and approval boundaries before implementation.
- Use `foo-roast` before another generation pass when the artifact needs cuts, preserved product loops, drift warnings, candidate evals, and a sharper next prompt.

Generated preview artifacts should live under the source packet or example packet, usually in `artifacts/previews/<run-id>/`, `artifacts/shapes/<run-id>/`, or another clearly named packet-local artifact folder. Exported feedback is review input, not product truth. Do not let static HTML or preview output directly edit `spec.md`, `tasks.yaml`, or `events.jsonl`; accepted feedback requires a separate human-approved agent step before canonical files change.

## Design Artifact Review

Generated UI artifacts need a design-review gate before they are treated as done.

- When Impeccable is available, run `$impeccable critique <artifact>` for UX, visual hierarchy, information architecture, and product-interface review.
- Use `$impeccable audit <artifact>` when accessibility, performance, responsive behavior, or technical quality is part of the artifact promise.
- Use `$impeccable polish <artifact>` when a critique already exists and the next step is refinement rather than diagnosis.
- Persist and report the critique snapshot path, score, P0/P1 findings, and whether detector/browser checks ran.
- Commit `.impeccable/critique/` snapshots when they are evidence for committed UI artifacts, and reference the relevant snapshot from artifact notes when practical.
- If Impeccable is unavailable, record a design-review gap and perform the closest equivalent manual review instead of skipping review silently.

## Lifecycle

Use these statuses in the registry:

- `active`: available for normal use.
- `draft`: present but not ready for routing.
- `deprecated`: kept for compatibility; prefer another skill.
- `archived`: retained only for history.

When adding a skill:

1. Create `<skill-root>/<name>/SKILL.md` under the configured skill root.
2. Add a registry entry with domain, surface, callers, connectors, side effects, and description.
3. Run the structural validation below.
4. Preview adapter generation with the validation command below.
5. If the skill changes governance, taxonomy, or adapter behavior, update this README.

When renaming or removing a skill:

1. Update the folder name and frontmatter together.
2. Update registry `id`, `path`, aliases, and descriptions.
3. Search for references across the repo.
4. Preview adapter generation with the validation command below.
5. Run structural validation.

When changing runtime adapter layout:

1. Update the canonical command contract and runtime adapter renderer.
2. Regenerate owned launchers; do not maintain independent copies.
3. Update the `Runtime Adapters` section in this README in the same change.
4. Update root docs only if the user-facing repo layout changes.
5. Run adapter validation below.

## Validation

Run from the repo root:

```bash
python3 - <<'PY'
from pathlib import Path
import re
reg = Path("skills/skill-registry.yaml").read_text()
for p in sorted(Path("skills").glob("*/SKILL.md")):
    name = p.parent.name
    text = p.read_text()
    assert re.match(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$", name), name
    assert text.startswith("---\n"), name
    assert f"name: {name}" in text.split("---", 2)[1], name
    assert f'id: "{name}"' in reg, name
    assert "## Usage" in text, name
    assert "## Error Handling" in text, name
print("skill checks passed")
PY
```

Validate canonical skill wording stays runtime-neutral:

```bash
python3 - <<'PY'
from pathlib import Path
forbidden = [
    "AskUserQuestion",
    "AskQuestion",
    "TodoWrite",
    "Task tool",
    "Skill tool",
    "Read tool",
    "WebFetch",
    "ToolSearch",
    "mcp__",
    "Claude Code",
    "Codex",
]
hits = []
for p in sorted(Path("skills").glob("*/SKILL.md")):
    text = p.read_text()
    for line_no, line in enumerate(text.splitlines(), 1):
        for token in forbidden:
            if token in line:
                hits.append(f"{p}:{line_no}: {token}")
assert not hits, "runtime-specific wording in canonical skills:\n" + "\n".join(hits)
print("runtime-neutral wording checks passed")
PY
```

For role or swarm skills, also inspect manually for the judgment-ledger and expert-preflight rules above.

Validate adapter generation without modifying a contributor's configuration:

```bash
bin/foo agent setup --agent all --scope project --dry-run
```

For all generated surfaces, run `npm run check:generated`. After changing their
canonical inputs, run `npm run generate`, inspect the outputs, then build and test
again. See [verification](../docs/contributing/verification.md).
