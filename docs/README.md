# productfoo documentation

productfoo gives coding agents a product-management layer for turning intent and
evidence into work that can be built, reviewed, and verified.

## Start using productfoo

- [Project status and responsible use](../README.md#project-status-and-responsible-use)
  — maintenance expectations, limitations, and safe first steps.

- [Install and quickstart](getting-started.md) — build and install the source package, connect
  an agent, and create a first spec.
- [Runtime and storage support](runtime-support.md) — tested Node/platform
  combinations and contributor test prerequisites.
- [Product workflows](workflows.md) — research, discovery, ideation, shaping,
  critique, and preview.
- [Use Firecrawl](firecrawl.md) — connect a plugin or API key, run a first public
  web search, finish a cited paper, and troubleshoot failures.
- [productfoo Spec](foo-spec.md) — how productfoo keeps intent, decisions, work, and proof
  connected.
- [CLI reference](cli-reference.md) — the complete command surface, generated
  from `foo help --all`.
- [Library exports](library-exports.md) — the supported import surface for code
  that consumes productfoo as a package, including local bug reporting.

## Product and reference

- [Quick reference](CHEATSHEET.md) · [Printable cheatsheet](cheatsheet.html).
- [Product purpose](product/PRODUCT.md), [background](product/about.md),
  [vision](product/vision.md), and [design](product/DESIGN.md).
- [Skill trust](reference/FOO-SKILL-TRUST-V1.md),
  [spec trailers](reference/FOO-SPEC-TRAILER.md), and
  [trust envelopes](reference/TRUST-ENVELOPE-V1.md).

## Connect productfoo to an agent

- [Agent adapters](agent-adapters.md) — how productfoo generates native commands for
  different coding-agent runtimes.
- [Skill governance](../skills/README.md) — how canonical productfoo skills are
  structured and maintained.

## Understand the trust model

- [Security model](security-model.md) — data handling, source approval, secret
  scanning, research inputs, and bounded autonomy.
- [Eval calibration protocol](calibration-protocol.md) — how judges earn the
  right to gate: blind labels, per-class rates, and drift invalidation.
- [Vulnerability reporting](../.github/SECURITY.md) — how to report a security issue
  privately.

## Maintenance and support

- [Maintenance and contribution policy](../.github/CONTRIBUTING.md) — contribution
  review, development setup, and maintainer responsibilities.
- [Code of Conduct](../.github/CODE_OF_CONDUCT.md) — expectations for everyone
  participating in the project.
- [Repository structure](contributing/repository-structure.md) — canonical
  source, generated output, examples, and private boundaries.
- [Verification](contributing/verification.md) — checks for proposed changes and
  independent local builds.
- [Release preparation](contributing/release.md) — verification and evidence without publication.
- [Changelog](CHANGELOG.md) — notable changes by release.
- [Third-party notices](THIRD_PARTY_NOTICES.md) — licenses of the software
  distributed with productfoo.
- [License](../LICENSE) — productfoo is released under the Apache License 2.0.
