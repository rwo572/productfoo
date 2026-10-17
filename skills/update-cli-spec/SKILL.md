---
name: update-cli-spec
description: "Use after adding, removing, renaming, or changing foo CLI commands, flags, runtime skill installation behavior, packet validation behavior, or command output; use when the user says update the CLI spec, sync the CLI docs, record the CLI change in the Adaptive Spec Packet, or make CLI behavior durable in spec/task/event artifacts."
---

# Update CLI Spec

Keep executable CLI behavior, user-facing command docs, and the Adaptive Spec Packet contract aligned in one change.

## Usage

Use this workflow whenever a CLI change affects how a user or agent should invoke `foo`, understand its output, install runtime skills, validate packets, or reconcile work.

1. Identify the behavior change.
   - Read the changed CLI files, tests, and command output.
   - Determine whether the change is a new command, flag, validation rule, output contract, install behavior, or error path.
   - Do not update spec artifacts from intent alone; verify the actual behavior or add tests that define it.

2. Update executable coverage first when behavior changed.
   - Add or update focused CLI tests for the new contract.
   - Cover safety behavior for install, delete, overwrite, path, or runtime-environment changes.
   - Prefer temp directories and explicit roots in tests so validation does not mutate the user's real runtime environment.

3. Update tracked command documentation.
   - Update `README.md` for clone/setup or top-level command workflows.
   - Update other tracked docs only when they are committed artifacts.
   - Treat `docs/` as local scratch unless the repo has explicitly changed that rule; do not rely on ignored docs as the only durable documentation.

4. Update `specs/adaptive-spec-packet-v0/spec.md` when the CLI contract changed.
   - Add or revise a requirement for durable behavior.
   - Add or revise a decision when the change chooses a product or workflow direction.
   - Add risk and validation bullets when the behavior has safety, portability, or trust implications.
   - Add evidence links to the implementation, tests, and tracked docs.

5. Update `specs/adaptive-spec-packet-v0/tasks.yaml`.
   - Add a new task for new accepted CLI behavior.
   - Mark it `done` only when tests and docs are complete.
   - Include touched files, done checks, proof paths, completion metadata, and the corresponding event ID.
   - Use UTC timestamps in task completion metadata.

6. Append to `specs/adaptive-spec-packet-v0/events.jsonl`.
   - Append exactly one JSON object per event; do not rewrite existing ledger lines.
   - Use the next `evt_asp_###` ID.
   - Include actor identity, skills or prompt modules when known, adapter/runtime when known, and a concise reason.
   - Keep raw private notes, transcripts, prompts, and tool payloads out of the event.

7. Validate before reporting completion.
   - Run the CLI tests that cover the changed behavior.
   - Run `bin/foo asp validate specs/adaptive-spec-packet-v0`.
   - Run the root README skill checks if skill files or registry entries changed.
   - Run the root README spec placement and duplicate `Spec ID` check when spec files changed.
   - Manually smoke-test important commands when the change concerns install paths, symlinks, destructive operations, or outside-repo invocation.

## Output

Report:

- The behavior that changed.
- The spec/docs/task/event artifacts updated.
- The exact validation commands and results.
- Any user-facing caveats, especially ignored docs, skipped destructive checks, or runtime roots not touched.

## Error Handling

- If behavior cannot be verified, stop and say what evidence is missing; do not update packet truth from guesses.
- If a command touches a user runtime, use a temp root or dry-run equivalent first. Ask for explicit approval before mutating a real runtime root when the user did not request it.
- If `docs/` is ignored, mirror any durable user-facing documentation in a tracked artifact such as `README.md` or the packet spec.
- If event IDs or task IDs conflict, inspect existing packet files and choose the next unused ID rather than editing historical IDs.
- If validation fails, fix the source behavior or the spec artifact and rerun validation before claiming the CLI spec is updated.
