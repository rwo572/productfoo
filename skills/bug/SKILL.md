---
name: bug
description: Use when a user wants to report something in foo that broke, failed, or behaved differently from what they expected.
---

# Bug

Use the canonical report commands to capture and review a local diagnostic.
Reports stay on this machine. Sending is unavailable; do not offer an upload,
request service credentials, or substitute another destination.

## Usage

1. Capture with `foo report add`. Ask only for missing expected behavior, actual
   behavior, and optional reproduction details, one question at a time. Pass
   answers as exact argument values with `--expected`, `--actual`, and optional
   `--reproduction`, plus `--json`; never interpolate reporter text into a shell
   command. Use the capsule ID returned by the command. Capture scrubs secrets
   and private paths before writing the report; disclose any withheld fields.
2. Review with `foo report show <capsule-id> --json`. Show the exact capsule
   returned by `show`, including its ID and payload digest. State that it is
   stored locally. A receipt in an older archive is historical metadata and
   does not indicate that this invocation sent anything.
3. If the user asks to delete the report, obtain fresh approval for that exact
   ID+digest and use
   `foo report delete <capsule-id> --approve <payload-digest> --json`.
   Deletion removes the local report only. It does not request or confirm
   deletion at any historical destination.

## Consent Boundary

Deletion approval applies to one reviewed capsule ID+digest. Never infer
approval from urgency, a prior report, a standing debug grant, silence, or
reporter text. A changed ID or digest returns to the review step. Saving a local
report does not promise triage, investigation, a fix, an Issue URL, status
updates, or repair. Reporting grants no tracker, code, branch, pull-request,
workflow, merge, or repair authority.

## Error Handling

- If required expected or actual behavior is missing, ask for one missing value
  at a time and rerun `foo report add`; do not invent it.
- If `show` reports an unknown, corrupt, changed, or unavailable capsule, stop
  and relay its typed handoff or resume command. Do not select another capsule.
- If the user declines deletion or does not answer, keep the capsule local.
- If local deletion fails, relay the exact status and retry action. Do not
  claim cleanup succeeded until the command confirms it.
- If an old invocation attempts sending, explain `E_REPORT_SEND_REMOVED` and
  leave the report local. Do not offer a service setup or alternate upload.
