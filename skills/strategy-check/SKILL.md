---
name: strategy-check
description: "Use when the the user says \"check strategy alignment\", \"strategy drift\", \"coverage map\", or invokes /strategy-check."
---

# Skill: Strategy Check

Check whether PRDs align with the active product strategy. Surfaces misalignment, stale strategy references, and coverage gaps across strategic objectives.

Two modes:
- **Single PRD**: `/strategy-check <feature-slug>` — scores one PRD against the active strategy
- **Portfolio coverage**: `/strategy-check --coverage` — maps all PRDs against strategic objectives

This skill is **advisory only** — it surfaces signal but does not block PRD status transitions.

## Usage

```
/strategy-check <feature-slug>
/strategy-check --coverage
```

## Examples

- `/strategy-check agentic-workflows` — Check alignment of the agentic workflows PRD
- `/strategy-check --coverage` — See which strategic objectives have strong/weak PRD coverage

## Instructions

When this skill is invoked:

### Step 1: Load the Active Strategy

1. Glob `docs/strategy/*.md`
2. Read the YAML frontmatter of each file. Find the file with `active: true`.
3. **Error handling:**
   - If **no file** has `active: true`: report "No active strategy found — create or activate a strategy file in `docs/strategy/`" and exit.
   - If **multiple files** have `active: true`: warn the user listing the conflicting filenames. Use the file with the most recent `date` field. Suggest the PM fix the duplicate.
   - If the active strategy file is **missing the `objectives` field**: report "Active strategy file `{filename}` is missing the `objectives` field in frontmatter" and exit.
4. Extract the `objectives` array (each has `id`, `name`, `priority`) and the `deprioritized` array from frontmatter.
5. Read the full prose body for richer context when judging alignment.
6. Also read all inactive strategy files (`active: false`) to identify retired themes and objectives.

### Step 2: Route by Mode

- If a `<feature-slug>` was provided → go to **Step 3: Single PRD Alignment Check**
- If `--coverage` was provided → go to **Step 4: Portfolio Coverage Map**

### Step 3: Single PRD Alignment Check

1. Read `docs/prds/<feature-slug>.md`. If it doesn't exist, report "No PRD found at `docs/prds/<feature-slug>.md` — check the filename or run `ls docs/prds/`" and exit.
2. Parse the PRD's frontmatter and full content.
3. **Alignment scoring:** For each objective in the active strategy, use your judgment to assess how strongly this PRD supports it:
   - **High** — The PRD directly advances this objective; it's a primary focus
   - **Medium** — The PRD partially supports this objective or enables it indirectly
   - **Low** — Tangential connection only
   - **None** — No meaningful connection
4. **Stale reference detection:** Check if the PRD's content references themes, objectives, or terminology from older (inactive) strategy versions that are no longer in the active strategy. Examples: referencing "Unity" when the active strategy is "Marketing Harness", or citing objectives that have been retired.
5. **Consistency check:** Read the PRD's freeform strategy alignment field (the text under "How does this project fit into <your-company>'s broader strategy?"). Compare what the PM wrote against the actual active objectives. Flag if the stated alignment is inconsistent with or contradicts your assessment.
6. **Context note:** If the PRD was last modified before the active strategy's `date`, note this: "This PRD predates the current strategy (active since {date}). Alignment may need re-evaluation."
7. Output the report (see **Step 5: Output Format — Single PRD**).

### Step 4: Portfolio Coverage Map

1. Glob `docs/prds/*.md`. Exclude `_manifest.md` and `TEMPLATE.md`.
2. **Process PRDs one at a time** — read each PRD individually, assess alignment to each objective (high/medium/low/none), then move to the next. This avoids context window pressure.
   - If a PRD has malformed frontmatter or cannot be read, **skip it with a warning** and continue to the next PRD. Do not abort the entire run.
3. For each objective, count how many PRDs score "high" or "medium" alignment.
4. **Coverage ratings:**
   - **Strong**: 3+ PRDs with high/medium alignment
   - **Good**: 2 PRDs with high/medium alignment
   - **Light**: 1 PRD with high/medium alignment
   - **Gap**: 0 PRDs with high/medium alignment
5. **Unmapped PRDs:** List any PRDs where no objective scores above "low" alignment.
6. **Stale references:** Flag PRDs that reference themes from inactive strategy versions.
7. Output the report (see **Step 6: Output Format — Coverage Map**).

### Step 5: Output Format — Single PRD

```
Strategy Alignment Check: {feature name}
Active Strategy: {strategy title} ({strategy date})
══════════════════════════════════════════════════════

┌─────────────────────────────────────────────────┐
│  QUICK READ                                     │
├─────────────────────────────────────────────────┤
│  Primary alignment: {strongest objective match} │
│  Overall signal: {Strong / Moderate / Weak / None} │
│  {1-2 key observations}                        │
└─────────────────────────────────────────────────┘

Alignment by Objective:
─────────────────────────────────────────────────────
  OBJ-1: {name}                              {High/Med/Low/None}
    {Brief rationale}

  OBJ-2: {name}                              {High/Med/Low/None}
    {Brief rationale}

  [... for each objective]
─────────────────────────────────────────────────────

Stale Strategy References:
  {List any references to retired themes/objectives, or "None found"}

Strategy Field Consistency:
  PM wrote: "{text from PRD strategy field}"
  Assessment: {Consistent / Inconsistent — with explanation}

Suggestions:
  - {Actionable suggestion, e.g., "Consider connecting this to OBJ-3 (Land new business agentically) — the migration tooling aspect is a strong fit"}
  - {Actionable suggestion, e.g., "This references 'Unity' theme which was retired in the Apr 2026 strategy"}
```

### Step 6: Output Format — Coverage Map

```
Strategy Coverage Map
Active Strategy: {strategy title} ({strategy date})
══════════════════════════════════════════════════════

┌─────────────────────────────────────────────────┐
│  QUICK READ                                     │
├─────────────────────────────────────────────────┤
│  {X} objectives covered, {Y} gaps              │
│  {Z} PRDs unmapped to any objective             │
│  {Key insight about portfolio balance}          │
└─────────────────────────────────────────────────┘

Coverage by Objective:
─────────────────────────────────────────────────────
  OBJ-1 (P1): {name}
    Coverage: {Strong/Good/Light/Gap}  ({N} PRDs)
    PRDs: {list of PRD names with alignment level}

  OBJ-2 (P2): {name}
    Coverage: {Strong/Good/Light/Gap}  ({N} PRDs)
    PRDs: {list of PRD names with alignment level}

  [... for each objective]
─────────────────────────────────────────────────────

Unmapped PRDs (no objective above "low"):
  - {prd-name.md} — {brief description of what it covers}

Stale Strategy References:
  - {prd-name.md} references "{retired theme}" from {old strategy date}

Skipped PRDs:
  - {prd-name.md} — {reason, e.g., "malformed frontmatter"}

Summary:
  Total PRDs scanned: {N}
  Objectives with strong coverage: {N}
  Objectives with gaps: {N}
  PRDs with stale strategy refs: {N}
```

## Notes

- This skill uses LLM judgment to assess alignment — the same approach as `/cpo-lens`. It reads both the strategy frontmatter objectives and the PRD prose to reason about connections. It does not use keyword matching or embedding similarity.
- PRDs do **not** need to contain explicit objective IDs. The skill infers alignment from prose content. However, if a PRD's strategy field references objective IDs (e.g., "Supports OBJ-3"), the skill will use those as additional signal.
- When a new strategy version becomes active, existing PRDs are not retroactively flagged as "drifted." They appear as-is in the next alignment check — PRDs written for a previous strategy may appear as "unmapped" in the coverage map, which is expected and useful signal.
- The coverage map processes PRDs one at a time to avoid context window pressure. Expect 2-3 minutes for a full portfolio scan.

## Error Handling

- If required files, tools, connectors, credentials, or source artifacts are unavailable, state the blocker clearly and continue only with safe local evidence.
- If the user request requires missing product judgment or source-boundary approval, ask one focused question before proceeding.
