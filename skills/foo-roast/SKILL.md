---
name: foo-roast
description: "Roast a spec, prototype, repo, PRD, Figma, or generated artifact in under 60 seconds. Detect who the reader is — PM, engineer, or designer — then lead with one verdict and one sharpest cut in their language, and end with the next step they actually own. The full expert-panel breakdown is available on --deep."
---

## Human-facing voice

Before writing for a person, load `foo skill product-copywriting/references/foo-voice.md`
and apply it within this skill's required output format. Keep the evidence record
and workflow responsibilities intact. If the reference cannot be loaded, report
the delivery gap and preserve evidence, uncertainty and dissent explicitly.


# foo roast

`foo-roast` is a fast shaping review for vibe-coded product work. It turns a messy spec, prototype, PRD, repo, or Figma into a sharper next generation.

The product goal is subtraction plus eval discovery: remove what is not earning its place, preserve the real product loop, and convert the critique into observable checks. But a roast nobody reads changes nothing — so the default output is built to **grab in five seconds**: one verdict, one sharpest cut, addressed to the actual reader. The full expert-panel breakdown is opt-in via `--deep`.

## Usage

Use this skill when the user asks to roast, simplify, sharpen, cut, sanity-check, de-scope, or improve a spec, prototype, feature idea, PRD, repo, Figma, brainstorm, generated app, HTML artifact, or next prompt.

Examples:

```text
Use $foo-roast on examples/calpal-scheduling/spec.md
Use $foo-roast on this prototype
Use $foo-roast --deep on this Claude spec and give me the next prompt
```

If a path, URL, screenshot, branch, or pasted artifact is provided, inspect it before judging. If the artifact is not available, ask for the smallest source that lets you evaluate the product shape.

Do not rewrite the spec, edit files, or generate a replacement artifact unless the user explicitly asks. A roast produces review output, eval candidates, and a next step.

## Core Rule

Every roast should produce observable checks, not better opinions.

If the roast cannot name a behavior, forbidden addition, model gap, taste rule, or false-positive state that the next generation should be judged against, it has not finished. In the default output those checks live behind the verdict and the one cut; in `--deep` they surface as named eval candidates.

## Read The Artifact, Pick The Mode

Before judging, infer who is reading and what they brought. The reasoning underneath is identical; what changes is the lead lens, the section names, and the closer — so the output speaks the reader's language instead of productfoo's.

- **PM mode** — input is a PRD, doc, spec prose, feature idea, or pasted requirements. Lead lens: Product / CPO. The reader wants to know *is this ready to build, what's missing, what will engineering push back on*. Closer is a doc action, not a prompt.
- **Engineer mode** — input is a repo, branch, code, components, or a technical prototype. Lead lens: Technical Lead / Architect. The reader wants *what's over-built, what's the risk, what's the next move*. Closer is a paste-ready next prompt.
- **Designer mode** — input is a Figma, screenshot, brainstorm, flow, or generated UI. Lead lens: Principal Product Design. The reader wants *does the flow hold, what's the taste regression, what reads as slop*. Closer is a flow/redline action.
- **Generic mode** — input doesn't clearly match one reader (a tiny pasted prompt, a mixed artifact). Use one synthesized roast with a neutral closer.

If the artifact is ambiguous, name the mode you picked in one short phrase and offer to re-cut for a different reader.

**Run the slop gate first.** When the artifact is a spec, packet, or file on disk, run `foo detect <target> --json` before you judge — it is the deterministic, zero-LLM linter for product slop (confidence theater, claims without proof, unsourced numbers, vibe words). Treat its findings as free evidence: each one is a candidate "Subtract" cut and a candidate eval, so you spend model judgment on what the linter can't see. `detect` is an internal primitive the roast calls, not a command to surface to the reader.

## Output (default)

Keep the default to **one screen**. Lead with the verdict. Then exactly one sharpest cut. Then the reader-specific middle, one thing to keep, and a closer the reader owns. The frameworks and the full panel stay invisible here — they are the reasoning behind these lines, not the lines themselves.

Shape:

```text
<glyph> ROAST · <artifact name>                 <plain verdict>

The one cut: <single sharpest subtraction, in the reader's language>

<reader-specific middle — see per-mode labels below>
 • ...
 • ...
 • ...

Keep: <the one thing that must not be lost — the real product loop>

→ <closer the reader owns>
```

The verdict glyph uses the foo status-glyph vocabulary, always paired with its text word, and is **terminal-only** — never emit a glyph into `--json`, piped output, `events.jsonl`, or a contract (drop to the bare word there). Pick the glyph from the roast's judgment:

- `🟡 done — proof pending` — it asserts it works but the proof isn't there yet (most roasts).
- `⚠️ drift` — it has wandered from its core job or is becoming a clone of something generic.
- `🚧 blocked` — a real wall (setup, dependency, missing capability) stops the first useful action.
- `✅ proven` — the shape is sound; the cuts are polish, not rescue.

Use the human label above in prose, with or without glyphs. Machine contracts retain the internal `claimed` value; never rename a machine state to its display label.

Plain verdict names the concrete problem: `proof missing` · `too much scope` · `flow breaks` · `ready after these cuts`. Keep dry humor specific to the work; do not invent motives or accuse the author.

Per-mode middle label and closer:

- **PM mode** — middle: `What's missing before eng can build:` plus a one-line `Eng will push back on:`. Closer: `→ Next: <concrete doc fix>.`
- **Engineer mode** — middle: `Risk I'd flag:`. Closer: a fenced `→ Next prompt (paste to your coding agent):` block with the concrete next generation prompt.
- **Designer mode** — middle: `Taste regression to watch:`. Closer: `→ Next: <concrete flow change>.`
- **Generic mode** — middle: `Cut these:`. Closer: `→ Next: <single most useful action>.`

Hold the line on length: the default is the verdict, one cut, three-to-four middle bullets, one keep, one closer. If the artifact genuinely needs the full breakdown, say so in one line and point to `--deep` — do not silently dump it.

## Translate The Dialect

The five moves and the frameworks are reasoning aids. In the default output, never surface their internal names — translate to what the reader already says:

| Internal term        | Say instead                                  |
|----------------------|----------------------------------------------|
| eigenquestion        | the one question that decides this           |
| borrowed legitimacy  | uses <X> without showing why it fits                |
| first-mile           | the first 60 seconds / first useful action   |
| model gap            | where the model may give an unsupported answer                |
| agency boundary      | what needs a human / what AI must not do solo|
| false positive       | looks done but isn't                          |
| 1st / 2nd order      | what it causes next                          |
| no-scope-creep       | don't let X creep back in                    |

In `--deep` mode the internal vocabulary is allowed, because the reader asked for the mechanics.

## Output (--deep)

When the user passes `--deep` (or asks for the full panel, the consequence map, or every eval), run the complete breakdown. This is the long form — the panel, the five moves made explicit, the consequence map, and named eval candidates:

```text
What this is trying to become:
...

Take away:
- ...

Preserve:
- ...

Consequence map:
If kept -> ...
If removed -> ...

Do not ask the coding agent to:
- ...

Candidate evals:
- ...

Panel dissent:
- ...

Next prompt:
"..."
```

The `--deep` output must never repeat or pad sections to look thorough. Each section appears once. A duplicated consequence map or a thrice-printed header is a defect, not detail.

## Expert Panel (--deep)

Use panel mode inside `--deep` for specs, prototypes, generated artifacts, and product-shape questions with more than one discipline at stake. For tiny pasted prompts or one-screen ideas, even `--deep` should stay a single synthesized roast.

Default panel:

- Product / CPO: core job, the one deciding question, scope, product bet, what to delete.
- Principal Product Design: first useful action, interaction shape, visual hierarchy, taste regression, copied legitimacy.
- Technical Lead / Architect: feasibility, recoverability, hidden coupling, premature dependencies, implementation guardrails.
- Research / Data Science: JTBD evidence, looks-done-but-isn't states, signal quality, eval design, fake certainty.
- GTM / Field: proven behavior, better/new distinction, user promise, claims that will not survive contact.
- Security / Privacy / Legal: what AI must not do solo, source boundary, private data, irreversible action, approval.
- QA / Release: regression checks, failure states, readiness, where-AI-will-lie routing, done evidence.

Add these lenses when the artifact is AI-native or developer-facing (productfoo's own domain):

- Applied-AI Eval & Reliability: is non-deterministic output actually measured (error analysis on real traces, a calibrated judge, a golden set), and is the loop's failure observable — or is "the demo looked good" standing in for an eval?
- Responsible-AI & Agent Safety: does the agent hold the lethal trifecta (private data + untrusted content + exfiltration path), can untrusted input reach an irreversible/outbound action without a human gate, and is the defense architectural or just a filter?
- Developer Experience & Ecosystem: time-to-first-value, concept count, errors as DX, the tested compatibility contract, and whether the artifact (CLI, skill file, contract) is legible to the agent that must read it, not only the human.

Add PM-archetype lenses when the product shape itself is at stake (each is the "half-X, half-PM" voice):

- Consumer / Craft PM: is the differentiating moment shipped with extra polish, what do we cut, and does it clear the felt-quality bar — or read as slop?
- Growth PM: is this a loop or a funnel, what activation action correlates with retention, and does the north-star measure value delivered?
- Business / GM PM: what's the value metric, can a power user's cost break margins, and are we force-ranking engagement over monetization?
- AI / Technical PM: does this even need a model, what does the reliability tier do to the UX, and what happens the 1% it's confidently wrong?
- Platform PM: feature or canvas, who wins in the constituent stack-rank, and what's the second-order effect on the other side?

Choose fewer roles when the artifact does not need all of them. A role that cannot add a distinct cut, guardrail, eval, or dissent should be skipped.

Each role runs the five moves from its point of view and returns only:

```text
Role:
Most important cut:
Must preserve:
Likely next-generation drift:
Candidate eval:
Dissent or caveat:
```

Do not allow the panel to become a pile of generic advice. Dedupe overlaps and carry forward only the strongest, most actionable judgments. If roles disagree, make the disagreement explicit and state which judgment is being carried forward unless the user overrides it.

## Five Moves

These run inside the roast for every mode. In the default output they collapse into the verdict, the one cut, the middle bullets, and the keep; in `--deep` they surface fully.

### 1. Core Job

Find the product's irreducible job and first useful moment.

Ask internally:

- What is the user hiring this to do?
- What progress should the user make in the first successful session?
- What is the first moment where the user feels value?
- What is only here because apps like this usually have it?

Return:

- `Core job`: one sentence.
- `First-mile proof`: the smallest user action that proves the job is happening.
- `False positive`: the polished state that could look successful while leaving the job undone.

### 2. Subtract

Remove anything not earning its place yet.

Ask internally:

- What can be deleted without weakening the core job?
- What is the smallest half of the idea that still proves the product?
- Which feature is a B+ hope we are trying to improve into an A?
- Which parts create borrowed legitimacy instead of product proof?

Return:

- `Take away`: 3-5 cuts.
- `Preserve`: 2-4 things that must not be lost.
- `Do not improve`: tempting surfaces that should be deleted or deferred instead.

### 3. Consequences

Show what keeping or removing a questionable part causes next.

Ask internally:

- If we keep this, what does the next prompt likely amplify?
- If we remove this, what becomes easier, clearer, or more recoverable?
- What is the most likely wrong turn?
- Is the risk product-shape failure or model-capability failure?

Return a concise consequence map:

```text
If kept:
1st order:
2nd order:
Likely drift:

If removed:
1st order:
2nd order:
Recovered focus:
```

### 4. Guardrails

Name what the next generation must not do.

Ask internally:

- What would make this worse if we asked a coding agent for it?
- What must the model not add, even if it would make the app feel more complete?
- Where should the model stop, ask, label uncertainty, or route to human review?
- What should be labeled a model gap instead of treated as product truth?

Return:

- `Do not ask the model to`: concrete forbidden prompts or additions.
- `Agency boundary`: what requires human approval or review.
- `Model gap`: what is not reliable enough to hide behind confident UX.
- `Margin of safety`: what keeps the prototype easy to recover or delete.

### 5. Evals

Turn the roast into candidate checks before giving the next step.

Ask internally:

- What behavior must still work after the next generation?
- What should never reappear?
- What user action proves the core job?
- What failure should stop or escalate?
- What taste rule should be preserved?
- What evidence would make us delete this feature instead of improving it?

Return 2-5 eval candidates:

- `Core job eval`: verifies the user can make the intended progress.
- `First-mile eval`: verifies the first useful minute is direct and not blocked by setup chrome.
- `No-scope-creep eval`: verifies forbidden surfaces or features did not reappear.
- `Agency-boundary eval`: verifies the model asks or escalates before irreversible or high-risk action.
- `Model-gap eval`: verifies unsupported capability is labeled, constrained, or routed to review.
- `Taste-regression eval`: verifies the next generation preserves a human-approved taste rule.
- `False-positive eval`: verifies the prototype does not claim success without proof.

## Frameworks Behind The Moves

- First principles: strip to what must be true.
- Occam's razor: prefer the version with fewer unsupported assumptions.
- Subtraction: move toward nothing left to take away.
- Second-order thinking: ask what happens after the immediate effect.
- Feedback loops: identify what the prototype trains the user, builder, or model to do more of.
- Probabilistic thinking: estimate the most likely wrong turn without fake certainty.
- Inversion: name the prompt that would make this worse.
- Margin of safety: preserve recoverability when the next generation is wrong.
- Social proof: catch borrowed legitimacy from generic app patterns.
- Proven / Better / New: copy what is proven, make it better, add only one new bet.
- Jobs to Be Done: keep the critique attached to user progress.
- Eigenquestion: find the one question that changes what should be kept or cut.
- First Mile / Only Do Half: protect the first useful minute and cut the tempting extra half.
- Build Before The Model Is Ready: label capability gaps instead of pretending reliability.
- Taste Feedback As Scoring: turn taste reactions into reusable checks.

## Errors That Teach (productfoo brand presence, R-007)

Roast failures and the roast's own findings are teaching surfaces — hold them to the Rust-compiler bar: every failure states the **concept**, the **fix**, and the **next command**.

- A finding is not done until it names what to do next: end every roast with a closer the reader owns (PM doc fix, engineer next prompt, designer flow re-cut), and `foo spec` the revised work when scope shifts.
- When the roast cannot run (missing artifact, oversized input, unverified claim), say the concept ("a roast needs a concrete artifact"), the fix ("paste the smallest source or a file path"), and the next command ("re-run `foo roast <artifact>`").

## Error Handling

- If no artifact is available, ask for the smallest source that can be roasted: pasted text, file path, URL, screenshot, or branch.
- If the artifact type is ambiguous, pick the most likely reader mode, name it in one phrase, and offer to re-cut for a different reader.
- If the artifact is too large, inspect the product entrypoint, current spec, primary user flow, and any explicit non-goals first.
- If the artifact includes private or sensitive source material, do not copy raw material into the roast; summarize only the product-shape implication.
- If the roast depends on an unverified claim about code or behavior, label it as an assumption or inspect the source before using it.
- If the user asks for implementation after the roast, hand off the next prompt or route to the appropriate planning/execution skill.
