# Verdict artifact migration

## What is untrusted

The following artifacts remain legacy/untrusted and are never auto-converted:

- policy objects with schema `0.1`, `signer_public_key`, and `signature`;
- attestation objects with schema `0.1`, `approved_by`,
  `signer_public_key`, and `signature`;
- ledger rows with `seq` and `prev_hash`.

An embedded public key is artifact content, not a trust root. A display string in
`approved_by` is not authenticated approval. A legacy ledger row does not gain a
stronger hash by being copied into the new format.

## Deliberate reissue path

1. Keep the legacy artifact for audit, clearly labeled `legacy/untrusted`. Do
   not edit it into the new shape.
2. Recover the original policy source, exact diff input, pure-check inputs,
   approval record, and checkpoint evidence from an independently trusted
   source. Re-evaluate the verified policy; do not copy free-form legacy result
   text into a new attestation. If the original bound evidence is unavailable,
   the artifact cannot be reissued.
3. Configure the customer's Ed25519 trust root outside the artifact in a
   `SplitTrustStores.customer` store. Establish accepted sequence state outside
   the artifact too. Customer enrollment/rotation/recovery ceremony is still a
   human decision and blocks public reactivation.
4. Create a schema-1 policy payload, issue a `customer` / `verdict-policy`
   `SignedEnvelope`, then accept it with `verifyPolicyEnvelope`. Preserve the
   returned sequence state.
5. Evaluate only supported pure checks. `coverage-delta` is available;
   `command` returns `command_isolation_unavailable` and never executes.
6. Configure an external approver-to-signing-key mapping. Issue a `customer` /
   `verdict-attestation` envelope from the authenticated evaluation result. Its
   closed payload carries hashes, enums, booleans, coverage counts, version and
   canonical timestamps—not titles, findings, source, diffs, logs, prompts, or
   secret strings. Verify it with the exact diff, the authenticated
   `VerifiedPolicy` handle, trust store, sequence state, and approver mapping.
7. Start a new schema-1 local log. Append only one of the exact kind-specific
   payloads: attestation rows use envelope/policy/diff/approver hashes plus
   approval time; billable rows use an attestation-envelope hash plus ISO week.
   Do not copy old rows or add generic fields. Treat the result as a `local
   tamper-evident log`, and retain the stated tail-deletion limitation until an
   independent witness is selected and proven.

## Current capability state

`foo gate` is still quarantined. Command-kind is unavailable on every platform.
The pure foundation is reviewable through the module API only; it is not a
public capability-state decision.
