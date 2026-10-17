# productfoo Spec

A productfoo Spec is the shared product contract between a person and a coding agent. It
keeps the reason for the work, the decisions that shaped it, the implementation
tasks, and the proof of completion connected.

The command-line domain is named `asp` for compatibility with an earlier format
name. The product concept is a **productfoo Spec**.

## What a productfoo Spec contains

A complete productfoo Spec can include:

- intent and current understanding;
- requirements with priority, risk, confidence, and acceptance;
- accepted decisions and unresolved questions;
- agreed, suggested, and discovered work;
- source and approval records;
- a task graph;
- an append-oriented event history;
- proof attached to completion checks;
- reconciliation results that expose drift.

The format keeps prose readable while giving coding agents stable structure to
validate and inspect.

## Agreed work is different from discovered work

Coding agents regularly uncover necessary work after implementation starts. productfoo
keeps that discovery visible without pretending it was part of the original
agreement.

- **Agreed** work is inside the approved scope.
- **Suggested** work needs a person to accept or reject it.
- **Discovered** work is required to satisfy agreed behavior or protect an existing
  boundary.

This distinction lets an agent handle real implementation detail without silently
turning every useful idea into scope.

## Status comes from proof

productfoo derives status from tasks, acceptance checks, and supporting proof. A task can
be marked done while its proof is still pending; the human status view names that
state directly.

```bash
bin/foo asp status specs/my-feature
bin/foo asp status specs/my-feature --json
```

Machine output stays stable and text-only. Interactive output can add human labels
and symbols without changing the underlying state.

## Reconciliation exposes drift

Reconciliation compares implementation evidence with the accepted productfoo Spec:

```bash
bin/foo asp reconcile specs/my-feature --git-diff
```

It can show:

- agreed work supported by implementation evidence;
- changed files with no mapped task;
- completed tasks without proof;
- implementation behavior that no longer matches intent;
- suggested work that was built without approval.

Reconciliation reports what it can prove. It does not silently edit the spec or
declare ambiguous work accepted.

## Approval boundaries stay explicit

productfoo keeps high-impact choices visible. Examples include approving a private source,
sending information outside the machine, widening an autonomous loop, accepting
new scope, or committing a production action.

An agent should inspect available evidence before asking a person. When a decision
does require a person, productfoo preserves the recommendation, alternatives, evidence,
confidence, and dissent needed to make it.

## Connect commits to intent

productfoo can generate a `Foo-Spec` Git trailer that ties an implementation commit to its
spec:

```bash
bin/foo commit-trailer my-feature
```

The trailer is an open, parseable convention. See the
[Foo-Spec commit-trailer format](reference/FOO-SPEC-TRAILER.md) for its grammar and
conformance rules.

## Learn from the CalPal example

The [CalPal scheduling example](../examples/calpal-scheduling/) shows a complete
product-specific spec, task graph, event history, validation, reconciliation, and
reviewable artifacts. It is intentionally concrete: the format is easier to judge
against a real product problem than an abstract placeholder.
