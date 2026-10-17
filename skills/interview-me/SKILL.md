---
name: interview-me
description: "Run an adaptive one-question-at-a-time product/spec interview before writing or modifying Adaptive Spec Packets, PRD-like specs, RFC-derived specs, implementation plans, or prototype specs. Use when intent is under-specified, when the user says interview me, ask me questions first, give me options, don't write the spec yet, before you write the spec, or when a coding agent would otherwise invent product judgment, scope, users, evidence, acceptance checks, or validation criteria. Also use when the user asks to reimagine, rewrite, pivot, or make a product agentic and the delegation, identity, autonomy, approval, or outbound communication boundaries are not already settled."
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.

## Usage

Use this skill when its frontmatter description matches the user request. Follow the workflow and constraints below.


# Interview Me

Interview the user before writing the spec. This skill exists to extract product judgment, constraints, source boundaries, and acceptance criteria through a real conversation, not a generic questionnaire.

This is the basic product-management function: gather enough intelligence to create an elegant spec packet that can survive Product, Design, Engineering, and GTM scrutiny. The deeper product goal is to make agent judgment legible: show what the agent believes, why it believes it, how confident it is, who disagrees, and what still requires human judgment.

## Hard Rules

- Ask one question at a time, using numbered options and a visually distinct recommendation when a recommendation is defensible.
- The question budget and depth tiers are owned by the conductor: the run contract emitted by `foo spec` / `foo shape` states the depth and the budget for this run. If this file and the emitted contract disagree, the contract wins.
- Stack-rank candidate questions before asking. Ask the highest-leverage unresolved question first; do not ask lower-ranked questions unless they would materially change the spec, source boundary, risk posture, or validation bar.
- Do not write, edit, scaffold, or summarize a spec until the interview is complete or the user explicitly cancels it.
- Do not treat "rewrite the spec" as execution approval when the request also changes product shape. Product pivots, agentic reframes, delegation models, identity, approval, and outbound communication require this interview first.
- Do not dump the full question bank unless the user explicitly asks for "20 questions" or a worksheet.
- Do not ask questions whose answers can be discovered cheaply from the repo, existing docs, prior context, or explicitly provided evidence.
- Do not treat a user's silence, impatience, or short answer as permission to invent product intent.
- Separate spec discovery from implementation. Do not create files, fork prototypes, run migrations, ingest sources, or modify spec packet artifacts during the interview unless the user explicitly switches from interview to execution.
- Separate known facts, user decisions, and agent inferences. Never smuggle an inference into the spec as if the user decided it.
- If another skill such as `ce-plan`, `ce-work`, `create-prd`, or `rfc-from-research` also applies, run this skill first. Continue to the other skill only after the interview has produced an approved intake summary.

## Compound Engineering Posture

Borrow Compound Engineering's execution discipline, but apply it to discovery:

1. Scan the work area before asking: read the relevant product docs, spec packet files, prototype files, plans, and tests that are likely to constrain the spec.
2. Route the work: decide whether the request is a small spec patch, a new capability, a prototype fork, an RFC, or an implementation plan. Say your current routing hypothesis briefly.
3. Keep a decision ledger: track confirmed decisions, open decisions, rejected options, source boundaries, acceptance checks, and validation evidence.
4. Work in short loops: generate candidate questions, rank them by expected spec impact, ask the highest-leverage question with options, wait, update the ledger, then re-rank before asking anything else.
5. Use the strongest available verification standard when the interview completes: specify exactly what would need to be checked before implementation can be called done.

When the user says to leverage Compound Engineering, prefer its habits: repo-first discovery, explicit scope boundaries, task/validation traceability, and crisp handoff to `ce-plan`, `ce-work`, or productfoo workflow skills after the interview. Do not turn the interview into implementation.

## Interview Flow

### 1. Establish Known Context

Before the first question, gather enough context to avoid wasting the user's attention:

- Read the current request and any immediately relevant conversation history.
- Inspect likely affected files with `rg`, `rg --files`, `sed`, or equivalent fast reads.
- For productfoo spec packet work, check likely owning packets under `specs/` and sample packets under `examples/`.
- For prototype work, identify the current prototype entrypoint, adjacent tests, and whether the request implies preserving or forking an existing surface.
- If memory or private notes informed the context, distinguish verified repo facts from memory-derived or private/context-only signal.

Then start with a short statement.

#### Announce and teach (productfoo brand presence, R-004)

Before the `What I already know:` statement — i.e. before the first question — emit the signature frame and a compact announce-and-teach block, so the user knows productfoo has taken over the agent's default behavior and learns the loop in the same beat. Show it in full on the first interview of a session; use a one-line version on later interviews.

**If a run contract is in front of you, its banner and its stated depth win** — copy
the banner verbatim and take one number from its budget for both the count and the
counter. `foo spec` runs the shape-fast lane and emits its own frame; the interview
family emits another. A literal in this file cannot be right for every lane, and
when it tried, it paired one lane's frame with the other lane's tagline (#665).

The block below is the fallback for the one case with no contract to read: this
skill invoked on its own, as `foo spec start` does when it points straight here.
Its values are the interview family's own — the conductor's banner, and its default
depth — so standalone output matches what the contract would have said.

```
── foo ▸ interview ──  questions the user alone can answer ──
You're in foo: I'll ask a few focused questions, then write the spec — not autocomplete a guess.
I'll ask only what the sources can't tell me — about 3 questions.
Say "go deeper" for more, or "just write it" to skip.
Progress: Q1 / ~3
```

- Before claiming inspection, name the sources you actually read and any relevant limits. If none were available, say so; never copy a stock claim that the repo was read.
- Say what is about to happen, in the user's words. Do **not** list the fields a spec contains: "the product bet", "source and approval boundaries", "MVP scope and the validation bar", "what still needs human judgment" are productfoo's filing labels, not a first-time user's language, and a list of them is the machinery showing through on the first screen anyone ever sees. The one thing worth teaching is the loop itself — productfoo reads the repo and asks only the gaps — so say that, and get to Q1.
- The only count you state is the one the contract gave you, and the progress counter must match it. State the depth you are actually running, not a generic one.
- Name the escape hatches ("go deeper" / "just write it") explicitly.
- Show a progress counter (`Q1 / ~N`, N from the contract) and advance it as you ask.
- The frame is for an interactive human surface; when output is piped or read by an agent, drop the box-drawing and keep the plain text (R-008).

Then continue with a short statement:

- `What I already know:` 2-5 bullets, only concrete facts.
- State the recommended next step and its concrete reason in one sentence, without a routing label.
- `Next question:` one numbered question with concise options.

### Mandatory Product-Shape Rewrite Triggers

Route here before editing when the user's request contains a rewrite verb plus unresolved product-shape language:

- Rewrite verbs: `reimagine`, `rewrite`, `pivot`, `turn this into`, `make this`, `change the spec to`.
- Agentic shape terms: `agentic`, `EA`, `assistant`, `delegate`, `acts for me`, `autonomous`, `approval`, `identity`, `outbound`, `communicate with users`, `on my behalf`.
- Boundary questions: who the agent represents, whether it discloses itself, what it can send, what it can commit, when it must ask approval, and what private context it may translate.

For agentic products, the first question should usually resolve the delegation and identity boundary:

```text
Question: How should the assistant identify itself when coordinating with another person?

1. **Delegated assistant with disclosure (Recommended)**
   The assistant can say it is coordinating on the user's behalf, which makes agency and trust boundaries clear.
2. User-authored messages drafted by the assistant
   Best when the product should avoid any separate assistant identity in V0.
3. Named assistant persona
   Best when the product intentionally creates a durable assistant character.
4. No outbound communication in V0
   Best when calendar reasoning should be proven before any guest-facing agency.
```

### 2. Choose The Spec Mode

Early in the interview, classify the work. This prevents an elegant spec packet from becoming a catch-all document.

| Mode | Use when | Preferred next artifact |
| --- | --- | --- |
| `capability` | new product behavior needs durable requirements | Adaptive Spec Packet |
| `prototype-fork` | an old prototype must stay accessible while a new one explores product shape | narrow packet update plus prototype plan |
| `spec-patch` | accepted behavior needs a small correction | delta spec patch |
| `rfc-first` | the product bet is still strategic or architectural | RFC or research note |
| `implementation-plan` | requirements are settled and sequencing is the hard part | `ce-plan` or implementation plan |

### 2a. Spend The Question Budget Well

The depth and the budget belong to the conductor; the run contract states both.
This file used to restate them in a table, and the table drifted: it said to default
to the standard tier while every emitter defaults to the fast one, so one request
drew three questions or seven depending on which text the model believed (#665).
Read the depth off the contract and run it; with no contract, run the family default
shown in the frame above.

Do not spend the question budget on facts that repo evidence, accepted specs, tests, docs, approved context, or other expert lenses can answer. Preserve unresolved lower-ranked questions as assumptions or open questions instead of extending the interview by default.

### 3. Ask Like A Product Partner

Prefer pointed, choice-making questions over broad prompts.

Good interview questions:

- force prioritization between plausible product directions
- expose the user's real buyer/user assumption
- identify what would make the spec dangerous or misleading
- clarify what must be preserved from the current system
- establish source authority and privacy boundaries
- define the smallest useful testable slice
- reveal what should be cut when scope expands

Avoid:

- "What is the goal?" when the goal is already implied
- asking all 20 questions at once
- asking for implementation details before product behavior is clear
- asking for facts the repo can answer
- offering too many choices at once

Default to one question at a time. Give concise numbered options unless the question is inherently free-form. Include `(Recommended)` on the option you would choose and explain the tradeoff in one sentence if helpful. If the user's answer might be "some combination," include that as an option. Wait for the reply before asking the next question.

Before each user-facing question, rank the candidate list by:

1. Whether the answer changes the product bet, source boundary, approval boundary, or cut line.
2. Whether the answer changes MVP scope or validation requirements.
3. Whether the answer prevents misleading, unsafe, or fake-precision output.
4. Whether the answer prevents implementation churn.
5. Whether the answer is merely useful background.

Ask from the top of the list only. If several questions tie, ask the one with the strongest recommended answer and carry the others forward as assumptions unless the user disagrees.

### Recommended Option Style

Use the same visible recommendation style in every interview question so the user can scan and answer with a number:

```text
Question: What kind of artifact should this become?

1. **Spec packet (Recommended)**
   Best when the decision should become durable product truth.
2. HTML review artifact
   Best when the decision needs visual comparison before becoming canonical.
3. Implementation plan
   Best when the product behavior is already agreed.
4. RFC first
   Best when the bet is still strategic or architectural.
```

Rules:

- Keep options numbered `1` through `4` when the question can reasonably fit four choices.
- Mark exactly one option with `(Recommended)` when there is enough evidence to recommend.
- Bold the recommended option label in Markdown responses.
- In generated HTML artifacts, render the recommended option as a visibly distinct card or row with a `Recommended` badge, stronger border, and subtle background.
- If no recommendation is defensible, say `No recommendation yet` before the options instead of faking one.

### 4. Maintain The Decision Ledger

After each user response, silently map the answer into this ledger. Share the ledger only when it helps the user see progress or when asking the next round.

- `Confirmed decisions`
- `Open decisions`
- `Rejected / out of scope`
- `Authoritative evidence`
- `Private or context-only evidence`
- `Acceptance checks`
- `Validation evidence`
- `Spec owner candidate`
- `Cut line`
- `Spec mode`
- `Assumption status`

If the user gives a terse answer, infer only the mapping, not missing intent. Ask the next best question.

### 5. Complete The Interview

The interview is complete only when these topics are covered enough to write a responsible spec:

1. Intent: the product bet in one sentence.
2. User: primary user, buyer, or reviewer.
3. Pain: the broken workflow, risk, or opportunity.
4. Existing surface: what this touches and what must remain accessible.
5. Evidence: authoritative sources and excluded/private sources.
6. MVP: smallest useful version.
7. Danger: what would make the first version misleading, unsafe, or fake.
8. Language: framing to preserve and framing/metrics to avoid.
9. Decisions: already made, still open, and assumptions to call out.
10. Validation: acceptance checks and done evidence.
11. Ownership: existing/new spec packet owner candidate.
12. Cut line: what to remove first if the spec bloats.

Unknown is acceptable. Preserve unknowns as open questions instead of inventing answers.

## Spec Decision Ladders

Use explicit ladders instead of yes/no answers.

### Evidence Authority

| Level | Meaning |
| --- | --- |
| `repo-truth` | accepted specs, code, tests, committed docs |
| `active-change` | draft packet changes and unaccepted proposal material |
| `approved-private-context` | private notes or meetings the user explicitly allows as directional input |
| `memory-derived` | prior-run memory that may be stale and should be verified before becoming canonical |
| `agent-inference` | useful hypothesis; must be labeled and confirmed |
| `excluded` | must not influence the spec |

### Spec Commitment

| Level | Meaning |
| --- | --- |
| `explore` | clarify product direction only |
| `propose` | write or update a reviewable spec packet with design notes, tasks, and validation evidence |
| `prototype` | specify a testable UI/workflow slice without promising production architecture |
| `baseline` | sync accepted behavior into `specs/<name>/spec.md`, `tasks.yaml`, and `events.jsonl` |
| `archive` | completed accepted change ready to archive |

### Requirement Strength

| Level | Meaning |
| --- | --- |
| `must` | required behavior; failing it invalidates the spec |
| `should` | expected behavior unless implementation evidence shows a better tradeoff |
| `may` | allowed but not required |
| `must-not` | explicit exclusion or safety boundary |
| `open` | unresolved and should appear as an open question, not hidden scope |

### Validation Strength

| Level | Meaning |
| --- | --- |
| `inspection` | files and requirements read back cleanly |
| `static-check` | linters, smoke tests, parser checks, or targeted unit tests pass |
| `rendered-flow` | user-visible flow checked in browser or equivalent UI runtime |
| `data-backed` | fixture or source evidence proves the behavior with representative inputs |
| `dogfood` | ThisProduct uses the behavior on its own initiative/spec work |

## High-Risk Defaults

Offer these defaults unless the user has already chosen otherwise:

- Private notes, meeting transcripts, vault dumps, messages, and personal context are context-only by default, not canonical spec packet evidence.
- Existing accepted specs are `repo-truth`; active changes are draft until accepted into packet artifacts.
- A new idea starts as one spec packet or packet update unless the user explicitly asks for a research note or implementation-only work.
- One requirement has one owner. If two specs seem to own the same behavior, ask which one should own it before writing.
- Prototype metrics that imply precision, ROI, confidence, cost, or impact require visible provenance or should be framed qualitatively.
- Preserving an old prototype means a visible route, link, or documented path; do not rely on a git branch as the only access path unless the user chooses that.
- If the spec gets big, cut integrations, automation, inference, and dashboards before cutting the core user decision the spec is meant to support.

## Question Patterns

Ask one of these, wait, then record the answer before continuing:

- "Which object should anchor this spec: initiative, spec, evidence packet, task, or decision?"
- "Should this be a new capability, a patch to an existing capability, a prototype-only change, or an RFC first?"
- "What should be authoritative evidence: accepted specs, active changes, approved private context, runtime behavior, or a mix?"
- "Where should the old surface stay accessible: same prototype navigation, `/v1`, docs link, branch only, or archived screenshot?"
- "What is the smallest dogfoodable slice: one initiative, one spec, one source packet, one task, or one decision review?"
- "What should the first version refuse to show because it would create fake precision?"
- "Which validation bar is enough for v1 of the spec: inspection, static tests, rendered flow, data-backed demo, or dogfood run?"
- "If this bloats, should we cut integrations, automation, analytics, collaboration, or polish first?"

## Question Bank

Use this as coverage guidance, not as a script:

1. What product bet are we making?
2. Who needs this badly enough to change behavior?
3. What decision or workflow fails in the current version?
4. What must stay accessible from the current version?
5. What source of truth should the system trust?
6. What source should remain private or context-only?
7. What is the smallest version worth testing?
8. What would make the prototype/spec fake precision?
9. What should a user be able to do that they cannot do now?
10. What should the system refuse to do?
11. What words should appear in the product surface?
12. What words, metaphors, or metrics should be avoided?
13. What decision has the user already made?
14. What decision should remain open until implementation?
15. What existing spec likely owns the behavior?
16. What should a test or demo prove?
17. What evidence is required before calling the work done?
18. What should be cut first if the work grows?

## Intake Summary

After the interview is complete or the selected interview budget is reached, produce a compact intake summary before writing any spec:

- `Spec intent`: one sentence.
- `Owner candidate`: the existing or new capability likely to own it.
- `MVP boundary`: what the first version includes.
- `Preserve`: what existing behavior/surface must remain accessible.
- `Cut line`: what should not be included.
- `Evidence boundary`: authoritative vs private/context-only sources.
- `Validation bar`: what must be checked before completion.
- `Decision map`: object anchor, spec mode, requirement strength, and validation strength.
- `Open questions`: unresolved context. Classify it explicitly at packet handoff; ordinary questions stay deferred, and only a complete user-only blocker becomes `State: needs-decision`.
- `Deferred questions`: lower-ranked questions intentionally not asked, with the assumption being carried forward.
- `Swarm packet`: the minimal context cross-functional reviewers need to sharpen the spec without rereading the whole interview.

Then ask for confirmation to proceed unless the user already gave explicit post-interview permission.

If useful, include a compact spec-decision table:

| Decision | Answer | Status | Evidence level | Spec impact |
| --- | --- | --- | --- | --- |

### Swarm Packet

When a spec will sit across Product, Design, Engineering, and GTM, include this packet so role-lens skills can ask precise follow-up questions:

- `Spec draft or intake path`
- `Product bet`
- `Primary user / buyer / reviewer`
- `Initiative and progress model`
- `Core workflow`
- `MVP boundary`
- `Evidence boundary`
- `Known risks`
- `Validation bar`
- `Cut line`
- `Open questions already asked`
- `Agent judgments to inspect`: claims, assumptions, inferred decisions, confidence, dissent, and evidence links that the swarm should make legible.

## Handoff

After approval:

- Use `bin/foo spec start <work-item>` for new or under-specified product/spec work.
- Use `ce-work` only when implementing an approved spec or plan.
- Use `ce-plan` for substantial implementation planning that is not yet a spec packet change.
- Use `spec-swarm` after a draft spec or approved intake exists and the user wants Product, Design, Engineering, Data Science, and GTM perspectives to sharpen it.
- Use a lighter RFC or research note if the interview reveals that a spec is premature.

Carry forward only the approved intake summary, repo evidence, and explicitly approved source material. Do not import raw private notes into canonical repo artifacts unless the user explicitly asks.

When the packet gets written, write it in the packet grammar (`specs/packet-grammar-v1`): requirements as `### R-001 Title` headings followed by separate `Priority`, `Risk`, and `Confidence` bullets; decisions, risks, validation checks, and open questions as bullets leading with their IDs (`- D-001 — …`, `- RISK-001 — …`, `- V-001 — …`, `- OQ-001 — …`). Mint IDs once, never renumber. A plain open-question bullet is a deferred note and never means “ask now.” Only when active work truly cannot continue without a person, copy the complete `State: needs-decision` block from the fresh packet scaffold. It must name why the choice matters now, what it unblocks, recommendation-first numbered options and outcomes, a real pause/defer/do-not-do option, evidence, confidence, dissent, and the answer effect. `foo asp migrate <packet>` inserts missing IDs without touching prose; `foo asp validate <packet>` reports incomplete decision requests, and renderers do not promote them.

## Error Handling

- If the user asks to skip the interview and write the spec immediately, state that this skill requires enough interview coverage first, then ask whether to continue or cancel.
- If the user answers only part of a question set, ask the next highest-value missing question instead of restarting.
- If many required topics remain uncovered, do not exceed the selected interview depth by default. Ask the next highest-value question, then preserve the rest as labeled assumptions or open questions unless the user explicitly asks for a deeper interview.
- If the conversation reveals the wrong artifact type, say so and recommend the lighter or more appropriate artifact.

## Common Mistakes

- Do not turn the interview into a survey.
- Do not turn the interview into implementation.
- Do not ask the user to restate repo facts.
- Do not collapse initiative progress, spec progress, task progress, and business impact into one vague status concept.
- Do not let a prototype fork become a rewrite mandate unless the user chooses that.
- Do not write requirements that merely describe UI panels; tie each requirement to a user decision, source boundary, or validation outcome.
- Do not hide uncertainty in polished spec language. Mark assumptions and open questions explicitly.
