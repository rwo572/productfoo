---
name: cpo-lens
description: "Use when invoking /cpo-lens or when the user wants to review readiness before executive review. Surfaces gaps in reasoning, missing connections, and unstated assumptions."
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.


# Skill: CPO Lens

Pressure-test any artifact — PRD, spec, plan, analysis, proposal, pricing model, research plan, or design direction — against the question patterns the CPO would ask. Surfaces gaps in reasoning, missing connections, and unstated assumptions before the work reaches executive review.

This skill encodes the CPO's judgment framework so PMs, Designers, Data Scientists, Researchers, and P&P leaders can self-check their work against the bar they'll be held to.

## Usage

```
/cpo-lens <feature-slug>
/cpo-lens <feature-slug> --function pm|design|content-design|data|analytics-eng|research|pricing|ops
/cpo-lens <file-path>
/cpo-lens --prep <meeting-type>
```

## Examples

- `/cpo-lens agentic-workflows` — Full CPO review of the agentic workflows spec
- `/cpo-lens client-seats --function pm` — PM-focused lens on client seats
- `/cpo-lens docs/plans/2026-03-01-aeo-launch-plan.md` — Review a specific plan
- `/cpo-lens --prep "product office hours"` — Generate the questions the CPO would ask at this meeting type
- `/cpo-lens --function data` — Review the latest D&I analysis against CPO question patterns (will prompt for which analysis)

## The Ten Lenses

These question patterns were extracted from CPO meeting transcripts across Product Office Hours, What's Shipping, Metrics Reviews, SteerCo, and 1:1s. They represent recurring probes — the things that get asked every time, regardless of topic.

### 1. Outcome Orientation
> "Are we anchoring on outcomes or just adoption?"
> "Show me the business result, not just the usage."

- Does this artifact connect to a measurable business outcome (NRR, ARR, publish rate, conversion)?
- Is there a clear line from this work → customer behavior change → revenue impact?
- If the metric is adoption, is there an outcome that normalizes it? (e.g., AI-assisted publish rate normalizes raw AI usage)
- Are we measuring what matters, or what's easy to measure?

### 2. System Thinking
> "Is this cross-cutting or localized?"
> "Why are we building this in one place when it needs to work everywhere?"

- Does this solution work across the full product surface (Designer, CMS, code components, apps)?
- Is there a canonical implementation, or will multiple teams build their own version?
- Have we identified the shared primitives (diff views, action queues, approval flows)?
- Who else will need to use or extend this? Have they been consulted?
- **Strategy alignment** (when active strategy context is available): Which strategic objectives does this work advance? Does it contradict or work against any active objectives? If the PRD doesn't connect to any current objective, flag this as a gap.

### 3. Scope Clarity
> "What do we deprecate?"
> "Does it have to be all or nothing?"

- What existing features get folded in, replaced, or deprecated?
- Is there an incremental path, or is this big-bang?
- What's the smallest version that delivers real value?
- Are we adding complexity to the product surface without removing anything?

### 4. Customer Segment Specificity
> "Which segment? What lifecycle stage?"
> "Don't call them all 'enterprise' — they're three wildly different segments."

- Which segment benefits: Growth (<250 employees), Enterprise, or Strategic?
- At what lifecycle stage: acquisition, onboarding (90-day), expansion (1-year), renewal (multi-year)?
- Does contract length matter? (3-year deals have different adoption curves)
- Is this a buyer need (deal cycle/RFP) or a user need (daily workflow)?
- Will this work for self-serve AND sales-led, or only one?

**Grounding narrative signal:** If the grounding narrative classifies this initiative as `internally-pushed`, this lens cannot score above 1 unless the PM provides explicit justification for why no customer evidence exists. For `customer-informed` initiatives, probe whether the evidence covers the claimed segment.

### 5. Revenue Connection
> "Is this in plan?"
> "What's the revenue target and how does enablement support it?"

- Is there a revenue target tied to this work? What is it?
- Is revenue from this in plan for the current fiscal year?
- Can we pre-sell while building? What's the beta → pipeline motion?
- What's the pricing and packaging model? Is it validated?
- If pricing was set by intuition/benchmarking, has the team pressure-tested it with usage data?

### 6. Enablement Rigor
> "I want to understand the enablement plan in excruciating detail."
> "When do we train sales? What does partner enablement look like?"

- Is there a detailed enablement plan (not just a marketing plan)?
- When does sales training happen relative to launch?
- What does the partner enablement plan look like?
- Is there a "follow the swing" motion — can we be selling ahead?
- Who are the channel owners for customer-facing responses?
- What's the sentiment monitoring plan post-launch?

### 7. Risk Gradient
> "Where do you want more permissiveness vs less?"
> "Not all mistakes are equal — what's high-stakes vs low-stakes?"

- Is there a risk framework? What are the vectors (human-in-the-loop, scope of impact, hallucination likelihood)?
- Where is it safe to be more permissive to drive adoption?
- Where is governance paramount because the outcome IS not having bad things happen?
- What's the "panic moment" — the rare but catastrophic scenario? Is recovery clear?
- Are we building for the default case (enabled, collaborative) or the exception case (restricted, locked down)?

### 8. Forward Compatibility
> "Is this going to work when we have code components?"
> "Think several steps ahead."

- Does this work with the product direction (agentic workflows, code components, component canvas, CMS in components)?
- Will this be a site-level or workspace-level concept?
- What happens when third-party integrations enter the picture?
- Does this hold up in a multiplayer/real-time context?
- Is this designed for where we are today, or where we'll be in 12 months?
- **Strategy alignment** (when active strategy context is available): Is this aligned with the active strategy's priorities? Does it reference any deprioritized items from the current strategy? If the work targets something the strategy explicitly deprioritized, flag this and probe the PM's justification.

### 9. Stack Ranking
> "What's the hypothesis? What's the priority order?"
> "Which activities are most important to surface?"

- Is there a clear hypothesis that can be tested?
- What's the stack rank of importance? Can you defend it?
- What data informed the prioritization?
- If we could only ship one piece of this, which piece and why?
- What's the baseline? What's the target? When do we measure?

### 10. Trust Building
> "How do we earn trust so enterprises let agents do more?"
> "If they need to restore their entire site to undo one AI change, that's a non-starter."

- Does this build trust with the user/buyer/admin?
- Is the visibility sufficient — can people understand what happened?
- Is rollback easy and granular (not "restore entire site")?
- Does governance enable adoption or just add friction?
- Is there a progression path from "human reviews everything" to "agent acts autonomously"?

## Executive's Actual Question Patterns

These patterns were extracted from 45 real comments across 10 PRDs and strategy documents (April 2025 - April 2026). They represent the CPO's most frequent probes — use them to calibrate tone and prioritize which lenses to emphasize.

### Pattern 1: Metric Specificity (most frequent)
Push for ONE primary metric per phase. Challenge whether metrics are aligned with customer success or internal success.
> "If you had to pick one metric we are optimizing for in phase 1, what would it be?"
> "What is a success metric that would be aligned with our customers' success versus our success?"
> "Is that a lot or a little in your opinion? Do we know why? Do they come back?"

### Pattern 2: Persona Clarity
Distinguish primary user from buyer. Clarify which segment, which developer type, which lifecycle stage.
> "Who is the primary user? Who is the buyer?"
> "Is this existing 3p app developers or net new developers?"
> "What % of new users hit the dashboard and when do they hit it in their journey?"

### Pattern 3: Competitive Awareness
Name specific competitors and alternatives the PM may not have considered. Drop links to recent news.
> "Vercel just acquired Gel (Postgres) a week ago: https://www.geldata.com/blog/gel-joins-vercel"

### Pattern 4: Scope Challenge
Question whether something belongs in phase 1. Flag when a feature "feels like a whole project in itself."
> "Why is this not the number one criteria?"
> "Is this still a phase 1 goal?"
> "Would this be dynamic based on who you are and what you are trying to accomplish? This feels like a whole project in itself."

### Pattern 5: Future-State Thinking
Push beyond v1 to the bull/bear case.
> "What is the bull case v. bear case for why this will or will not be important in the new LLM-driven search world?"
> "Will it be 'no code' or 'prompt to code'?"

### Pattern 6: Strategic Reframing
Widen the lens when a PRD frames a problem narrowly.
> "Not just registry for brand identity, but a registry for brand performance or a proxy for how well discovery of your brand is getting converted into actual prospects."
> "I think the thing that people forget about systems of record is that you care about a system of record not just as a database but also as a kind of permissions, an activity log. Those are all the things that you really care about: who changed what and when and why."
> "I would frame this as ensuring that content is performant and potentially on brand"

### Pattern 7: Revenue Instinct
Notice monetization gaps, attach rate opportunities, and metering blind spots.
> "IMO this should be a significantly higher attach than we currently have because so many sites should focus on Spanish translation out of the gate"
> "Metering does not exist today"
> "Does this exclude bandwidth?"

### Pattern 8: Lifecycle Awareness
Push for dynamic, personalized experiences based on user lifecycle stage.
> "Would this change based on your activity and place in lifecycle?"
> "I feel like there is a problem statement that is missing: We are not optimizing for what place on the lifecycle a customer is and how far along their journey they are"

### Pattern 9: Agentic Framing
Challenge whether the feature creates more work for the user, and whether there's an agentic alternative.
> "Does this create more work for the user? If so, is there an agentic flow we could/should consider here? I think detection is tablestakes."
> "I wouldn't underestimate how much speed still is a challenge, especially when there are other humans involved and standards that are not easily enforced by a system."

### Pattern 10: Data Skepticism
Question how numbers were derived, whether they're meaningful, and what they exclude.
> "How did we get this if we didn't have the product at that time?"
> "There is the old trope that you take a 20-50% hit on SEO performance when you do a migration. What if that were not the case?"

## Instructions

When this skill is invoked:

### Step 1: Identify the Artifact

If a feature slug is provided, read the spec and related files:
```
.kiro/specs/<slug>/requirements.md
.kiro/specs/<slug>/design.md
.kiro/specs/<slug>/tasks.md
.kiro/specs/<slug>/launch-artifacts.md
docs/prds/<slug>.md
```

**Also read the grounding narrative** — the `<!-- agent:managed section="grounding-narrative" -->` block at the top of `requirements.md`. This auto-generated narrative classifies the initiative as `customer-pulled`, `customer-informed`, or `internally-pushed` based on evidence file metrics. Use this classification as input when scoring Lens 4 (Customer Segment Specificity) and when probing PM-specific questions about customer conversations.

If a file path is provided, read that file directly.

If `--prep <meeting-type>` is provided, generate the likely CPO questions for that meeting type without reviewing a specific artifact.

**Also read the active product strategy** (if available):
1. Glob `docs/strategy/*.md` and find the file with `active: true` in its YAML frontmatter.
2. If found, extract the `objectives` array (each has `id`, `name`, `priority`) and the `deprioritized` array.
3. Use these as additional context when evaluating **Lens 2 (System Thinking)** and **Lens 8 (Forward Compatibility)** — see the augmented lens instructions below.
4. If no active strategy file exists, or `docs/strategy/` is empty, continue without strategy context. The lenses work as before — no degradation.

### Step 2: Apply Function-Specific Weighting

Different functions should weight the lenses differently:

**Product Management** — Heavy on: Outcome Orientation, System Thinking, Scope Clarity, Revenue Connection, Forward Compatibility
- Additional PM questions:
  - "What's out of scope and are we respecting it?"
  - "What are the open questions and have we made assumptions we shouldn't have?"
  - "Is the PRD anchored on customer problems or internal aspirations?"
  - "Have you talked to customers about this? How many? Which segment?" (Reference the grounding narrative classification — if it says `internally-pushed`, this question becomes the top priority)

**Product Design** — Heavy on: System Thinking, Trust Building, Forward Compatibility, Risk Gradient
- Additional Design questions:
  - "Is this a pattern or a one-off? Will other teams use this?"
  - "How does this work at different scales (1 change vs 100 changes)?"
  - "Can someone understand what happened in a panic moment?"
  - "Are we adding surfaces or consolidating them?"
  - "What's the information hierarchy — what's most important for the user to see first?"

**Content Design** — Heavy on: Trust Building, Risk Gradient, Customer Segment Specificity
- Additional Content Design questions:
  - "How does the AI explain itself to the user?"
  - "Does the language scale across products and AI-mediated experiences?"
  - "Is the voice/tone calibrated to the risk level of the action?"
  - "Will this content system work when agents are the ones communicating?"

**Data Science** — Heavy on: Outcome Orientation, Stack Ranking, Customer Segment Specificity
- Additional D&I questions:
  - "Is this correlation or causation? What would it take to get causal?"
  - "Will this cut by segment and still be statistically significant?"
  - "Is this a one-time analysis or a system that updates itself?"
  - "Who consumes this output and what decision does it inform?"
  - "Are we using legacy data or verified metrics?"

**Analytics Engineering** — Heavy on: System Thinking, Forward Compatibility
- Additional AE questions:
  - "How long until this data source is in Snowflake?"
  - "Can this be queried by a non-technical user?"
  - "Is the semantic layer rich enough for natural language querying?"
  - "What happens when the upstream schema changes?"

**User Research** — Heavy on: Customer Segment Specificity, Outcome Orientation, Stack Ranking
- Additional Research questions:
  - "How many customers? Which segment?"
  - "Is this project-based or contributing to a continuous signal system?"
  - "What's the hypothesis we're validating or invalidating?"
  - "Are we combining what customers say with what they do?"
  - "Could a PM answer this question themselves with existing data?"

**Pricing & Packaging** — Heavy on: Revenue Connection, Customer Segment Specificity, Outcome Orientation
- Additional P&P questions:
  - "What does the consumption data actually show?"
  - "Is this benchmarked against competitors? Which ones?"
  - "What's the willingness-to-pay signal from beta customers?"
  - "Does the pricing model work for both self-serve and sales-led?"
  - "What happens to unit economics at scale (especially AI credit costs)?"

**Product Operations** — Heavy on: Enablement Rigor, System Thinking, Stack Ranking
- Additional Ops questions:
  - "Is launch readiness assessed automatically or in a meeting?"
  - "What's the BOM status? What's blocking?"
  - "Is sentiment tracking real-time or manual reports?"
  - "Does this cadence create leverage for the next launch?"

### Step 3: Generate the Review

For each relevant lens (weighted by function), evaluate the artifact and produce:

1. **Score** (0-3):
   - 0 = Not addressed at all
   - 1 = Mentioned but shallow
   - 2 = Addressed with clear reasoning
   - 3 = Thoroughly addressed with evidence and tradeoffs articulated

2. **Gap** — What the CPO would ask that isn't answered in the artifact. Use the "Executive's Actual Question Patterns" section to calibrate the likely verbatim question. Prefer real examples from the patterns over generic questions.

3. **Suggestion** — How to close the gap before the review

### Step 4: Output the Report

**Always lead with the CPO Quick Read** — this is the first thing anyone sees.

```
CPO Lens Review: {feature or artifact name}
Function: {function or "general"}
══════════════════════════════════════════════════════

┌─────────────────────────────────────────────────┐
│  CPO QUICK READ                                 │
├─────────────────────────────────────────────────┤
│  1. {Most important thing — direct, opinionated}│
│  2. {Key assumption or strategic bet}           │
│  3. {Top risk or missing piece}                 │
│  4. {What's under-examined}                     │
│  5. {Bottom line — ready or not, and why}       │
└─────────────────────────────────────────────────┘

These bullets should be direct, opinionated, and specific.
Not "This document covers pricing."
Instead: "The pricing model assumes 40% attach rate with zero
willingness-to-pay data — that's a $2M bet on intuition."

Overall Readiness: {X}/30 — {Not Ready | Needs Work | Review-Ready | Strong}

Top 3 Gaps (things the CPO will ask that you can't answer):
1. {Gap description}
2. {Gap description}
3. {Gap description}

Detailed Review:
─────────────────────────────────────────────────────
1. Outcome Orientation                    {score}/3
   Gap: {what's missing}
   She'll ask: "{likely verbatim question}"
   Close it: {specific action}

2. System Thinking                        {score}/3
   ...

[continue for all 10 lenses]
─────────────────────────────────────────────────────

Function-Specific Flags ({function}):
- {Additional question that applies to this function}
- {Additional question that applies to this function}

Suggested Prep:
- Before the review, make sure you can answer: {top 3 questions}
- Data you should pull: {specific data requests}
- People you should align with first: {specific names/roles}
```

### Step 5: For --prep Mode

When `--prep <meeting-type>` is invoked, generate the likely agenda and CPO questions:

**Product Office Hours:**
- "Pressure-test the strategy doc" — expect System Thinking and Forward Compatibility probes
- "Where does this fit in the broader vision?" — expect questions about cross-cutting concerns
- "What do we deprecate?" — expect Scope Clarity questions
- Calibrate tone from the written probes above: direct questions about outcomes, tradeoffs and evidence. Use the shared productfoo voice rules; do not seek a private meeting transcript just to imitate someone's tone. Treat predicted questions as examples, never as quotes from an uninspected meeting.

**What's Shipping:**
- "What's the enablement plan?" — expect Enablement Rigor deep-dive
- "Is revenue in plan?" — expect Revenue Connection
- "What's the sentiment monitoring plan?" — expect operational detail
- "What's at risk and what's the mitigation?" — expect candor about blockers

**Metrics Review:**
- "Is this correlation or causation?" — expect statistical rigor
- "Cut it by segment" — expect segmentation requests (even if sample size won't support it)
- "What's the outcome normalization?" — expect pushback on vanity metrics
- "Is this a system or a one-time analysis?" — expect push toward sustainable measurement

**SteerCo:**
- "What's the revenue impact?" — expect financial framing
- "What does this function look like in a year?" — expect forward-looking vision
- "Are we removing handoffs?" — expect efficiency/operating model questions
- "Is this revolutionary or evolutionary?" — expect ambition calibration

## What This Skill Is NOT

- It is not a checklist. Not every lens applies to every artifact.
- It is not a gate. The purpose is to prepare, not to block.
- It does not replace judgment. The CPO will always ask something you didn't expect. This skill covers the ~80% that's predictable.
- It does not evaluate people. It evaluates artifacts and readiness.

## Error Handling

- If required files, tools, connectors, credentials, or source artifacts are unavailable, state the blocker clearly and continue only with safe local evidence.
- If the user request requires missing product judgment or source-boundary approval, ask one focused question before proceeding.
