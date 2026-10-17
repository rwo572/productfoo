# The `Foo-Spec` commit trailer — an open format

**Status:** v0 · **License:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication)

This document defines the `Foo-Spec` git commit trailer as an **open,
vendor-neutral convention**. The format is free for anyone to emit, parse, or
build on — with or without the `foo` tool. (The `foo` product itself is closed
source but free; only this convention is the open artifact. See spec-linked-commits-v0 D4.)

## Purpose

`Foo-Spec` links a commit to the **spec packet** whose intent it implements, so
that a reader — human, agent, or reviewer — can trace built code back to the
agreed product contract. It is modeled on existing git-trailer conventions
(`Signed-off-by:` / DCO, `Co-Authored-By:`) and is **additive**: it never
replaces the subject line and coexists with any subject style, including
Conventional Commits.

## Format

A `Foo-Spec` trailer is a standard git trailer (a `Key: value` line in the
commit message footer, parseable by `git interpret-trailers`).

```
Foo-Spec: <packet-path> (<spec-id>) <url>
```

- `<packet-path>` — repo-relative path to the spec packet directory, e.g.
  `specs/alpha-onboarding-v0`.
- `<spec-id>` — the packet's unique Spec ID in parentheses, e.g. `(alpha_onboarding_v0)`.
- `<url>` — an optional discoverable pointer to the project's public home. It may
  be a placeholder until a real URL is configured.

### Exemption marker (optional)

Build work with no owning packet may carry an explicit exemption instead:

```
Foo-Spec: none (<reason>)
```

This is **optional**, not required — pure chores, merges, and docs-only commits
are exempt without any marker. The marker exists to deliberately record "build
work with no owning packet, and why." (See spec-linked-commits-v0 D6/OQ1.)

### Grammar (ABNF-ish)

```
foo-spec-trailer = "Foo-Spec:" SP value
value           = packet-ref / exemption
packet-ref      = packet-path SP "(" spec-id ")" [ SP url ]
exemption       = "none" SP "(" reason ")"
packet-path     = 1*( VCHAR )            ; repo-relative path, no spaces
spec-id         = 1*( ALPHA / DIGIT / "_" )
url             = URI                     ; optional pointer
reason          = 1*( VCHAR / SP )
```

## Examples

```
Implement the alpha getting-started path

Foo-Spec: specs/alpha-onboarding-v0 (alpha_onboarding_v0) https://example.com/foo
Co-Authored-By: A. Builder <a@example.com>
```

```
Bump CI runner image

Foo-Spec: none (infra chore, no product packet)
```

## Parsing

- Detect with the case-sensitive key `Foo-Spec:` at the start of a trailer line
  (regex: `^Foo-Spec:\s*\S`).
- A value beginning with `none` is an exemption; otherwise the first
  whitespace-delimited token is the packet path, a parenthesized token is the
  spec id, and a trailing token (if a URI) is the pointer.
- Multiple `Foo-Spec` trailers on one commit are permitted (a commit spanning
  packets); consumers should treat them as a set.

## Conformance

A producer is conformant if every commit that changes product substance tied to
a packet carries at least one `Foo-Spec` packet-ref trailer (or an explicit
`none` exemption). A consumer is conformant if it parses the format above and
treats absence as an advisory signal, **never a hard block** — provenance is
surfaced for judgment, not enforced as a gate.

## Why open

Cross-tool conventions (Conventional Commits, SPDX, DCO) reach standard status
because the *spec* is open and vendor-neutral; nobody builds on a convention a
rival privately controls. Keeping this format open — while the tool stays
closed — preserves the standards-adoption path. Reach beats lock-in for a
top-of-funnel provenance marker.
