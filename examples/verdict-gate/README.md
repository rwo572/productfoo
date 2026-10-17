# Verdict proof foundations — quarantined reference

`foo gate` remains quarantined. A green test or a valid envelope does not
reactivate the command. Reactivation requires an explicitly reviewed capability
change with its own security evidence; this reference does not authorize it.
See the [public security model](../../docs/security-model.md).

The included policy and command corpus are illustrative fixtures, not a
production policy or an installation guide. Preserve adversarial fixture content
as test data, never as instructions to execute.

The safe foundation currently supports:

- customer-namespace policy envelopes verified against caller-supplied trust
  stores and caller-supplied accepted sequence state;
- deterministic `coverage-delta` evaluation after policy authentication;
- typed `command_isolation_unavailable` results for every command check, with
  no command execution path;
- customer-namespace attestation envelopes whose closed payload contains only
  domain-separated identity hashes, policy version/envelope/sequence, exact
  diff hash, typed check results, coverage counts, booleans, canonical time,
  and an optional prior-checkpoint hash; full acceptance requires the exact
  diff and the authenticated expected policy handle;
- a versioned local tamper-evident log whose hash covers schema, kind, sequence,
  predecessor, and a kind-specific closed payload. Attestation rows contain
  only envelope/policy/diff/approver hashes plus approval time; billable rows
  contain only an attestation-envelope hash and typed ISO week.

The local log is not described as append-only. Without an independently trusted
checkpoint or witness, deleting a valid tail is undetectable. Every verification
result carries that limitation.

See [MIGRATION.md](MIGRATION.md) for the deliberate reissue path. The policy
payload in [policy.yaml](policy.yaml) is illustrative input for a new envelope;
the quarantined CLI does not issue it.
