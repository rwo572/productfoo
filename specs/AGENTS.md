# Spec Packet Instructions

The root `AGENTS.md` still applies. This file adds procedure for work under
`specs/`; it cannot weaken a root boundary or approval requirement.

## Packet Layout

- A real packet lives at `specs/<name>/` and contains `spec.md`, `tasks.yaml`,
  and the append-only `events.jsonl` ledger.
- Root boundary B2 requires each committed `spec.md` to have a unique `Spec ID`.
- Put runnable examples under `examples/<name>/`, not in the real packet home.
  Use gitignored `.foo/docs/` for scratch material.

## Packet Edits

- Record durable events with `bin/foo asp event <packet-dir> ...`; update task
  state and proof with `bin/foo asp task <packet-dir> ...`. Do not rewrite prior
  event lines.
- After packet edits, run `bin/foo asp validate <packet-dir>`. Treat a draft loop
  budget gap as a signal and the armed case as root boundary B4.
- After implementation-relevant changes tied to the packet, run
  `bin/foo asp reconcile <packet-dir> --git-diff` or provide the explicit changed
  files or approved pull-request source.

## Verification

- Finish with `bin/foo self check` as well as packet validation.
