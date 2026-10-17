# Security model

productfoo works in repositories that may contain source code, customer context, product
decisions, and credentials. Its trust model separates information an agent can see
from evidence it is allowed to use and actions it is allowed to take.

For vulnerability reporting and safe-harbor terms, see the
[security policy](../.github/SECURITY.md).

## Limits of the controls

productfoo is a review framework, not a sandbox or a guarantee of safe agent
behavior. Scans can miss sensitive data, instructions can be ignored, and a
passing check proves only what that check inspected. Enforcement depends on the
runtime, hooks, permissions, and repository protections actually configured.
See [project status and responsible use](../README.md#project-status-and-responsible-use).

## Local by default

productfoo's specs, status, validation, reconciliation, and deterministic checks run from
local files. Bundled skills are verified locally, and local feedback and
comprehension records stay on disk. The CLI does not send automatic productfoo
service telemetry, fetch hosted skills, or deliver bug reports remotely.

Update checks can query the public npm registry. Research and discovery can use
explicitly configured external providers, including Firecrawl with your own
credentials. These integrations remain available and retain their approval
boundaries. Some optional workflows use external services. The surrounding
coding agent, model provider, and connected tools may transmit data and incur
charges under their own settings. CLI checks do not govern all of those paths.
Inspect the destination, permissions, and payload before approving an external
action.

Runtime memory, logs, messages, transcripts, caches, and private notes are context,
not automatically trusted evidence.

## External content is untrusted input

Public webpages, connector results, transcripts, issues, and model output can
contain incorrect claims or instructions written for an agent. productfoo treats that
material as data to inspect, not commands to follow.

Research or discovery output becomes useful evidence only after its source and
claims have been checked. Moving evidence into a product decision remains a
deliberate step.

## Source access is not source approval

A connected tool may make a source technically accessible. That does not give productfoo
permission to use it for every product decision.

Source approval should be:

- explicit;
- scoped to the relevant productfoo Spec;
- limited to the needed resource;
- attributable to the approver;
- revocable;
- represented without committing raw private material.

Discovery is designed to produce reviewable derived evidence. Keep raw transcripts
out of Git yourself, and inspect derived output for sensitive content before sharing.

Source-approval records are workflow controls, not replacements for permissions
in a connected service. Some integration contracts are preparatory and are not
end-to-end supported connections. Confirm the actual adapter and authorization
path before relying on them.

## Scan before committing or sharing

productfoo uses one deterministic scanning and redaction engine across its local commands
and repository checks:

```bash
bin/foo scan src/ --exit-code
bin/foo redact transcript.txt
bin/foo self gate
```

Findings report metadata such as category, confidence, line, and length without
printing the secret itself. Supported high-confidence findings block the staged-content
gate when it runs; hooks require installation. This does not prevent every secret
or private document from being committed or sent.
Do not raise thresholds to make a real finding pass; remove or redact the value.

## Proof does not mean “the agent said so”

A completion claim should point to a check, artifact, test, source, or review that
supports it. productfoo preserves the difference between:

- work marked done;
- proof still pending;
- proof that satisfies the agreed check;
- implementation that drifted from the spec.

This distinction is part of the product contract, not an optional reporting detail.

## Autonomous work stays bounded

Repeated or autonomous work needs an explicit operating definition that states:

- purpose;
- observation source;
- allowed actions;
- verification check;
- record format;
- terminal states;
- approval boundaries;
- agreed budget.

productfoo can inspect and price that definition without executing the work. Widening what
an agent may read, write, send, or spend remains a human decision.

## Failures must be visible

A missing required source, connector, permission, receipt, or approval should
produce a visible failure and a next action. Optional sources may be omitted only
when the output names the omission and remains honest about what the remaining
evidence supports.

Silent fallback is especially dangerous in product work because it can produce a
plausible-looking artifact whose evidence or approval path never ran.

## Public distribution boundary

The public package contains the local CLI and bundled skills. It does not include
productfoo-hosted services or managed credentials. Optional workflows that use
your own model or connector access remain subject to those services' permissions,
data policies, and costs.

## Reporting a problem safely

productfoo's bug flow creates one local redacted diagnostic capsule at a time:

```bash
bin/foo bug "what went wrong"
bin/foo report show <capsule-id>
bin/foo report delete <capsule-id> --approve <payload-digest>
```

The public build keeps reports on this machine. Review each capsule manually
before sharing it through a separate tool; automated redaction can miss private
information. Local deletion requires approval of the exact capsule digest.
Prefer synthetic reproductions and never include a real secret in a report.
