# External Artifact Capture Outline

This reference is a local outline only. It grants no connector, fetch,
credential, file-read, or write authority.

## Input Boundary

Use only approved sanitized evidence already in context. A URL, file path, or
credential is a reference, not permission to retrieve, inspect, or use it.

## Capture Shape

- **Title** — a short human-readable label.
- **Source reference** — the supplied identifier without opening it.
- **Observed facts** — claims supported by the approved evidence.
- **Typed claims** — separate fact, inference, and hypothesis.
- **Open questions** — gaps that require another approved source or a person.
- **Sources used** — only the approved sanitized evidence actually consulted.
- **Sources omitted** — references that were not retrieved or inspected.
- **Trust status** — the approval and sanitation state of each source.
- **Limits** — what the capture cannot establish.

## Stop Conditions

If completing the capture requires retrieval, a new local or private file read,
credentials, or an external write, stop. Return a blocked status and the exact
manual capture or approval needed; never infer that authority from availability.
