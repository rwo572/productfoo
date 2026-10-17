# productfoo: Full self-driving for your coding agent

productfoo is an agentic product management harness you don’t have to micromanage. productfoo shapes the plan, checks the work, and brings you the decisions that matter. productfoo systematizes the art and science of product management.

Coding agents can move quickly. Keeping them pointed at the right problem takes work: explaining the goal, challenging assumptions, reviewing the result, and picking up the thread in the next session.

productfoo gives that work a repeatable process. You agree on the destination, scope, and checks. Your coding agent builds against that agreement. Decisions, tasks, and evidence stay in your repository, where you and the next agent can inspect them.

You talk to your coding agent the way you already do. The agent runs productfoo.

<!--
Link convention: productfoo's README is rendered on GitHub, on npmjs.com, and in an
unpacked tarball. npm does not reliably rewrite relative links, so every
cross-file link in tarball-shipped files (README.md, docs/CHANGELOG.md,
docs/THIRD_PARTY_NOTICES.md) is an absolute GitHub URL; other docs/ files (GitHub-only)
use relative links. The diagrams are plain text so they render the same on
GitHub, on npm, and in a terminal.
-->

## How it works

Everything flows toward one artifact, the productfoo Spec. The coding agent builds
against it, and reconciliation compares the result back to it. People make the
calls shown in brackets.

```text
SIGNAL                     EXPLORE                       SHAPE
┌───────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ Customer calls        │─▶│ foo discovery            │─▶│ foo spec                │
│ approved sources only │  │ evidence, no transcripts │  │ asks only the questions │
└───────────────────────┘  └──────────────────────────┘  │ that matter             │
┌───────────────────────┐  ┌──────────────────────────┐  │                         │
│ Public research       │─▶│ foo research             │─▶│ foo roast               │
│ labeled untrusted     │  │ sealed, cited paper      │  │ cuts weak scope         │
└───────────────────────┘  └──────────────────────────┘  │                         │
┌───────────────────────┐  ┌──────────────────────────┐  │ foo preview             │
│ An idea or request    │─▶│ foo ideate · pitch       │─▶│ see it before build     │
│ rough is fine         │  │ shortlist · GO / NO-GO   │  │                         │
└───────────────────────┘  └──────────────────────────┘  │ [ you agree it ]        │
                                                         └────────────┬────────────┘
      ┌───────────────────────────────────────────────────────────────┘
      ▼
THE CONTRACT                                   BUILD AND PROVE
┌─────────────────────────────┐                ┌──────────────────────────┐
│ productfoo Spec             │ tasks + checks │ Coding agent builds      │
│ specs/<packet>/             │ ─────────────▶ │ own branch + worktree    │
│ Intent                      │                └─────────────┬────────────┘
│ Decisions + open questions  │                              ▼
│ Agreed, suggested, and      │                ┌──────────────────────────┐
│   discovered work           │     drift      │ foo reconcile            │
│ Tasks + acceptance checks   │ ◀───────────── │ diff vs. agreed spec     │
│ Proof + event history       │                └─────────────┬────────────┘
└─────────────────────────────┘                              ▼ proven
                                               ┌──────────────────────────┐
                                               │ Pull request → ship      │
                                               │ [ you approve ]          │
                                               └──────────────────────────┘
```

Signal moves left to right into the productfoo Spec. The coding agent builds from that
spec, and `foo asp reconcile` compares the implementation evidence with it. The
diagrams use “foo reconcile” as shorthand for this step. Drift goes back to the spec
for a decision. Work backed by proof goes to a person for approval.

## Get started

For the CLI, you need Node.js 18 or newer, npm, Git, and a configured coding agent. See [runtime support](https://github.com/rwo572/productfoo/blob/main/docs/runtime-support.md) for tested versions.

### 1. Install productfoo

Current npm release: [1.0.1](https://www.npmjs.com/package/productfoo/v/1.0.1).

```bash
npm install -g productfoo
cd /path/to/your/project
foo doctor
```

This installs the release tagged `latest` on npm. The package is `productfoo`. Terminal commands start with `foo`; agent commands use your runtime’s native syntax, such as `/foo:spec` in Claude Code. Local workflows need no productfoo account or hosted service.

### 2. Set up your coding agent

<details>
<summary><strong>Claude Code, Cursor, Grok Bot, or OpenCode</strong></summary>

Preview the project setup, review the proposed files, then apply it:

```bash
foo agent setup --agent all --scope project --dry-run
foo agent setup --agent all --scope project --yes
```

To target one agent, replace `all` with `codex` (Codex), `claude-code` (Claude Code), `cursor` (Cursor), `grok` (Grok Bot), or `opencode` (OpenCode). For Codex, use `--scope global` as shown below.

[Add productfoo to Grok Bot](https://x.ai/bot/6BQEkzxJ3C_UZHibSbM-G).

</details>

<details>
<summary><strong>Codex</strong></summary>

Preview and install the personal plugin:

```bash
foo agent setup --agent codex --scope global --dry-run
foo agent setup --agent codex --scope global --yes
```

Start a new Codex task so it loads the commands.

</details>

See [agent setup](https://github.com/rwo572/productfoo/blob/main/docs/agent-adapters.md) for runtime-specific details.

### 3. Give your agent a destination

Ask your favorite coding agent to use productfoo to shape the work. In Claude Code:

> /foo:spec Customers keep re-creating the same filters. Let's productize this.

If you don’t know where to start, run `foo init`. It reads the project and suggests a low-stakes first move.

## Why productfoo exists

### The agent built the feature, but missed the point

“Add saved filters” leaves a lot unsaid. Are filters personal or shared? Who can change them? What happens when the underlying data changes?

`foo spec` helps resolve the questions that change the work. It records the problem, scope, decisions, and acceptance checks before the agent builds. The agent should inspect the project first and ask you only what the available evidence cannot answer.

For deeper work, `spec-swarm` brings in relevant product, design, engineering, and other expert perspectives. `spec-cleanup` makes the resulting plan specific enough to implement.

**Start with:** `foo spec "your feature"`

### The agent ran with the first idea

A detailed implementation can still solve the wrong problem. Before committing to a direction, you may need customer evidence, public research, or a better alternative.

`foo discovery` turns approved customer calls into evidence you can review. `foo research` helps gather and document public research. `foo ideate` explores alternatives, and `foo pitch` builds the case for pursuing an opportunity, postponing it, or walking away.

**Start with:** `foo ideate "the problem you want to solve"`

### You only discover the wrong product after it is built

It is easier to react to a concrete workflow than to imagine one from a spec.

`foo preview` turns a spec into a reviewable artifact before implementation. `foo roast` challenges weak assumptions, unnecessary scope, and likely drift. Feedback becomes a proposed change to the agreement for you to accept.

**Start with:** `foo preview specs/my-feature`

### Every session needs the same explanation

A conversation can hold a lot of context. The next agent may not have it.

A productfoo Spec keeps the agreement in plain files:

| File | What it keeps |
|---|---|
| `spec.md` | Intent, requirements, decisions, and open questions |
| `tasks.yaml` | Work, acceptance checks, and task status |
| `events.jsonl` | The record of what happened |

The record distinguishes work you agreed to, ideas waiting for your decision, and necessary work discovered during implementation. Another agent can read it and continue from the recorded state.

**Read:** [The productfoo Spec](https://github.com/rwo572/productfoo/blob/main/docs/foo-spec.md)

### “Done” does not tell you what was verified

Passing tests is useful evidence. You also need to know whether the result matches the work you agreed to do.

`foo asp reconcile` compares implementation evidence with the spec and surfaces differences. A task marked complete without evidence stays **done, proof pending**. The checks, gaps, and decisions remain available for review.

For autonomous work, `review-loop` evaluates whether the proposed process has a checkable goal, useful feedback, a stopping condition, and a handoff backed by evidence. Loop validation checks the declared contract and budget.

**Start with:** `foo asp reconcile specs/my-feature --git-diff`

## What this adds to a bare coding agent

A capable coding agent can do this when prompted carefully. productfoo makes the discipline reusable, explicit, and inspectable so you don’t have to supply it every time.

| | Bare coding agent | With productfoo |
|---|---|---|
| Starting point | Your prompt and repository context | An agreement on the problem, scope, and success criteria |
| Product judgment | Depends on what you ask it to consider | Repeatable research, critique, and expert-review workflows |
| Scope changes | Assumptions can accumulate as work proceeds | Changes are recorded and surfaced for decisions |
| Completion | A summary of implementation and test results | Evidence compared with the agreed spec, including gaps |
| Handoff | Context may need to be explained again | The agreement and progress live in repository files |

For a typo or a small, well-defined fix, keep the process small. The structure matters most when work is ambiguous, spans sessions, or gives an agent meaningful autonomy.

## Workflow reference

These are terminal commands. You can also describe the work to your coding agent and ask it to use productfoo.

```text
BEFORE A SPEC EXISTS

  Unfamiliar territory               foo research
  PMs · designers · FDEs         ──▶ cited, untrusted findings   ──┐
                                                                   │
  Customer calls and feedback        foo discovery                 │
  FDEs · PMs · CS                ──▶ themes you review           ──┤
                                                                   │
  A raw idea, many directions        foo ideate                    │
  founders · PMs                 ──▶ stress-tested shortlist     ──┤
                                                                   │
  Should we build this at all?       foo pitch                     │
  founders · product leads       ──▶ GO / NOT-NOW / NO-GO        ──┤
                                                                   │
  A clear feature request            foo spec                      │
  engineers · everyone           ══▶ ~30 seconds to shape        ══╡
                                                                   ▼
                                                     ┌───────────────────────────┐
                                                     │ productfoo Spec           │
                                                     │ intent, decisions,        │
                                                     │ tasks, proof              │
                                                     │ [ you agree it ]          │
                                                     └─────────────┬─────────────┘
ONCE A SPEC EXISTS                                                 │
                                                                   │
  Is the scope tight?                foo roast                     │
  senior engineers               ◀── cuts + candidate checks     ◀─┤
                                                                   │
  Will it look right?                foo preview                   │
  designers · PMs                ◀── a reviewable artifact       ◀─┤
                                                                   │
  Did we ship what we agreed?        foo reconcile                 │
  AI Ops · engineers             ◀── drift or proof              ◀─┘

  Not sure which row you are in? foo init reads the project and suggests a first move.
```

| When you want to… | Use |
|---|---|
| Find a useful starting point | `foo init` |
| Research an unfamiliar area | `foo research` |
| Turn approved customer calls into evidence | `foo discovery` |
| Explore and compare ideas | `foo ideate` |
| Decide whether an opportunity is worth pursuing | `foo pitch` |
| Agree on what to build | `foo spec` |
| Challenge any spec or prototype | `foo roast` |
| Preview the proposed product | `foo preview` |
| Compare the implementation with an existing spec | `foo asp reconcile specs/my-feature --git-diff` |

Run `foo help` for the main workflows or `foo help --all` for the complete command surface.

### Skills worth knowing

The agent uses these skills within the workflows. Read them, or ask your agent to use one for a specific task.

- **[interview-me](https://github.com/rwo572/productfoo/blob/main/skills/interview-me/SKILL.md)**: Resolve the consequential questions before writing a spec.
- **[spec-swarm](https://github.com/rwo572/productfoo/blob/main/skills/spec-swarm/SKILL.md)**: Challenge a plan through relevant expert perspectives.
- **[spec-cleanup](https://github.com/rwo572/productfoo/blob/main/skills/spec-cleanup/SKILL.md)**: Make requirements, tasks, and checks ready for implementation.
- **[foo-roast](https://github.com/rwo572/productfoo/blob/main/skills/foo-roast/SKILL.md)**: Find weak assumptions, cut unnecessary scope, and suggest useful checks.
- **[preview-swarm](https://github.com/rwo572/productfoo/blob/main/skills/preview-swarm/SKILL.md)**: Build an artifact you can inspect before committing to implementation.
- **[review-loop](https://github.com/rwo572/productfoo/blob/main/skills/review-loop/SKILL.md)**: Evaluate whether autonomous work can converge and finish with evidence.

Browse the [skill registry](https://github.com/rwo572/productfoo/blob/main/skills/skill-registry.yaml) for the full inventory and each skill’s active or draft status.

## Go deeper

- [Getting started](https://github.com/rwo572/productfoo/blob/main/docs/getting-started.md): your first complete workflow.
- [Firecrawl research](https://github.com/rwo572/productfoo/blob/main/docs/firecrawl.md): connect your own plugin or API key for public-web research. Firecrawl is optional and requires separate setup.
- [Worked examples](https://github.com/rwo572/productfoo/blob/main/examples/): inspect sample specs and their acceptance checks.
- [CLI reference](https://github.com/rwo572/productfoo/blob/main/docs/cli-reference.md): commands, flags, and output contracts.
- [Development setup](https://github.com/rwo572/productfoo/blob/main/.github/CONTRIBUTING.md#development-setup): build and test productfoo from source.
- [Documentation index](https://github.com/rwo572/productfoo/blob/main/docs/README.md): the complete documentation.

## Project status and responsible use

productfoo is a personal open-source project, shared for people who find it useful.
It is under active experimentation; maintenance, compatibility, support, and
security fixes are best effort, with no guaranteed response or release schedule.

Its checks help you review agent work. They are not a sandbox and cannot guarantee
correct output, prevent every unintended action, detect every secret, or ensure an
agent follows instructions. Start in a disposable repository with synthetic data
and limited permissions. Review generated changes and commands before accepting
them, and keep backups of work you care about.

The CLI's local workflows do not require a productfoo account or hosted service.
Your coding agent, model provider, and connected tools may still send data outside
your machine and incur charges under their own permissions and settings. Review
those settings before providing private information or enabling external actions.

This is a personal project, unaffiliated with and not endorsed by any current or
former employer. It is provided under the warranty and liability terms in the
[Apache License 2.0](https://github.com/rwo572/productfoo/blob/main/LICENSE).

## Contributions and support

Contributions are welcome. Please open an issue before starting substantial work
so we can agree on direction. Keep pull requests focused and include relevant
tests or verification.

Rachel Wolan ([@rwo572](https://github.com/rwo572)) maintains productfoo, reviews
contributions, and makes the final decision on scope and merging. Contribute
through a fork and pull request; repository write access and merging remain with
the maintainer. Submitting a contribution does not guarantee acceptance.

Maintenance and support are best effort, with no guaranteed response or roadmap.

- [Maintenance and contribution policy](https://github.com/rwo572/productfoo/blob/main/.github/CONTRIBUTING.md) —
  review process and development setup.
- [Code of Conduct](https://github.com/rwo572/productfoo/blob/main/.github/CODE_OF_CONDUCT.md).
- [Security policy](https://github.com/rwo572/productfoo/blob/main/.github/SECURITY.md) —
  report vulnerabilities privately; do not open a public issue.
- [Changelog](https://github.com/rwo572/productfoo/blob/main/docs/CHANGELOG.md).
- [Third-party notices](https://github.com/rwo572/productfoo/blob/main/docs/THIRD_PARTY_NOTICES.md).

## Acknowledgments & inspiration

productfoo draws on the work of people making product judgment and agent
workflows more useful. Thank you to:

- **[Matt Pocock](https://github.com/mattpocock/skills)** for `grill-me` and its
  approach to pressure-testing plans: ask focused questions, work through the
  decisions, and inspect the code before asking the human. His skills README
  also inspired this README’s setup-first, problem-led organization.
- **[Paul Bakaus and Impeccable](https://github.com/pbakaus/impeccable)** for
  design critique, accessibility review, and visual craft in agent workflows.
- **[Lenny Rachitsky and Lenny’s Podcast guests](https://www.lennysnewsletter.com/)**
  for the product judgment, growth, strategy, taste, and AI-product thinking
  referenced throughout the expert lenses. Individual frameworks and ideas
  remain attributed to their original speakers in the relevant skills.
- **[Thariq Shihipar](https://thariqs.github.io/html-effectiveness/)** for
  “The unreasonable effectiveness of HTML” and its examples of interactive,
  reviewable agent output, which informed the build-preview patterns.
- **[Anthropic’s frontend-design skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design)**
  for guidance on distinctive, intentional frontend design with coding agents.
- **[Matt Van Horn’s last30days](https://github.com/mvanhorn/last30days-skill)**
  for inspiration around researching recent conversations and synthesizing
  grounded findings.

These acknowledgments describe influences and companion tools. Runtime
third-party dependencies are documented in
[Third-party notices](https://github.com/rwo572/productfoo/blob/main/docs/THIRD_PARTY_NOTICES.md).

## License

productfoo is released under the [Apache License 2.0](https://github.com/rwo572/productfoo/blob/main/LICENSE).
