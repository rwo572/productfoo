---
name: capture-external-artifact
description: "Use when an external artifact needs a local capture outline but fetching or publishing it would require external transfer."
---

# Capture External Artifact

## Usage

This draft keeps its egress boundary. It may turn explicitly supplied, approved
sanitized evidence into an in-chat or local outline; it must not fetch a URL,
inspect credentials or environment values, upload, publish, or copy to a destination.

Capture title, source reference, observed facts, typed claims, open questions,
**Sources used**, **Sources omitted**, **Trust status**, and **Limits**. A URL by
itself is not approved evidence and is never fetched by this skill.

## Error Handling

- If retrieval or delivery is required, return `status: blocked`, name what did
  not run, identify the egress boundary, provide `next action: supply approved
  sanitized evidence or capture manually`, and set `exit: nonzero`.
- Never inspect `.env`, credentials, destination paths, or private URLs.
