# Product workflows

productfoo exposes a small set of product-management workflows to people and coding
agents. Run `foo help` for the current command list and `foo help --all` for
lower-level checks and maintainer tooling.

Repository examples below use `bin/foo.mjs`. An installed package uses `foo`.

## Orient the agent with `init`

```bash
bin/foo.mjs init
```

productfoo reads the project, identifies a useful first move, and helps turn the selected
move into an agreed spec. Use this when the agent needs context before you know
which workflow to request.

## Research an unfamiliar area

```bash
bin/foo.mjs research "how teams evaluate autonomous coding loops" --depth standard
```

This command creates a bounded research plan; your coding agent carries it out
and writes the paper. To execute a Firecrawl search directly after saving your
API key, supply explicit public search terms:

```bash
bin/foo.mjs research "Coding agent evaluation methods" \
  --firecrawl api \
  --public-query "coding agent evaluation methods" --json
```

Already connected Firecrawl in your agent? Use plugin mode and let the agent
execute and record the prepared search. The [Firecrawl guide](firecrawl.md)
walks through both connection options, expected results, paper completion,
and troubleshooting. Gathered text remains untrusted input: check its provenance
and claims before deliberately carrying it into a product decision.

## Discover customer pain

```bash
bin/foo.mjs discovery plan --study customer-onboarding
bin/foo.mjs discovery validate
bin/foo.mjs discovery sync --json
```

Discovery turns approved customer calls into reviewable derived evidence without
committing raw transcripts. People retain control of source approval, attachment,
promotion, dismissal, and completion.

## Decide whether an opportunity is worth pursuing

```bash
bin/foo.mjs pitch "help coding agents preserve product intent" --stage 0to1
```

Pitch builds the case for and against an opportunity. It separates evidence from
hypotheses and can conclude `GO`, `NOT-NOW`, or `NO-GO` before implementation
scope starts to harden.

## Generate and challenge product ideas

```bash
bin/foo.mjs ideate "ways to reduce spec-review time" --depth standard
```

Ideate produces independent directions, compares them, tests the strongest
candidates, and hands a ranked shortlist to shaping. Rejected directions remain
visible as optionality rather than disappearing from the record.

## Turn intent into a productfoo Spec

```bash
bin/foo.mjs spec "add saved filters" \
  --request "customers keep re-creating the same filters"
```

Spec is the everyday shaping reflex. It resolves the smallest important questions,
states what is agreed, identifies proof, and gives the coding agent a clear next
handoff. Deeper work can use `foo spec start`.

## Critique weak scope or drift

```bash
bin/foo.mjs roast specs/my-feature
```

Roast finds weak scope, unclear decisions, missing evidence, and likely drift. It
returns cuts and candidate checks rather than silently rewriting the source.

## Preview what will be built

```bash
bin/foo.mjs preview specs/my-feature
```

Preview turns an agreed spec into a reviewable product artifact before the build is
treated as settled. Feedback remains review input until a person accepts the
resulting change to the spec.

## Report a productfoo problem

```bash
bin/foo.mjs bug "doctor did not explain the next step"
```

Bug reporting creates a local, secret-redacted diagnostic capsule. Review the exact
payload before sharing it with a separate tool. `foo report show` and
`foo report delete` manage local capsules; the CLI has no remote report-send action.

## Work beneath the main workflows

Coding agents also use lower-level commands to validate a productfoo Spec, record work,
reconcile implementation with intent, scan for secrets, and inspect bounded loops.
Those commands are part of the inspectable CLI contract, but they are not separate
product workflows a new user must learn first.

See [productfoo Spec](foo-spec.md) for that lifecycle and `foo help --all` for the full
command surface.
