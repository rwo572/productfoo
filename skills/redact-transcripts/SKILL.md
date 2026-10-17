---
name: redact-transcripts
description: "Use when transcript handling needs a redaction plan but observing or rewriting the source would require private-file access."
---

# Redact Transcripts

## Usage

This draft keeps its file-ingress boundary. It may provide an in-chat redaction
checklist or local outline without seeing the transcript; it must stop before
opening, enumerating, fingerprinting, rewriting, or reporting metadata about a file.

The checklist covers direct identifiers, quasi-identifiers, credentials, private
URLs, company-confidential facts, quoted third parties, and re-identification risk.
It is not proof that an unseen transcript is safe.

## Error Handling

- When a path or upload is supplied, return `status: blocked`, `did_not_run:
  transcript observation`, `missing: safe file-ingress`, `next action: use the
  approved in-memory discovery flow to produce sanitized evidence`, `exit: nonzero`.
- Do not ask the user to paste raw content into chat as a workaround.
