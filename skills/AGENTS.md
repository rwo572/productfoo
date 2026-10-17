# Skill Instructions

The root `AGENTS.md` still applies. This file adds procedure for work under
`skills/`; it cannot weaken a root boundary or approval requirement.

## Layout And Structure

- Keep canonical skills flat at `skills/<name>/SKILL.md`; the folder name must
  match the frontmatter `name`.
- Every new or edited skill needs valid frontmatter, `## Usage`, and
  `## Error Handling`.
- Keep canonical wording runtime-neutral. Put runtime-specific behavior in an
  explicit adapter or shim.

## Governance

- Treat `.agents/` as a pinned helper bundle, not canonical productfoo source. Promote
  durable behavior into canonical skills, the registry, governance, root
  instructions, or an approved spec.
- Update `skills/skill-registry.yaml` for additions, renames, removals,
  deprecations, or reclassification. Update `skills/README.md` when governance,
  taxonomy, lifecycle, or adapter behavior changes.
- Role skills preserve the `grill-me` pattern. Swarm skills preserve the
  judgment ledger and expert preflight.
- Edit generated swarm inputs, not rendered persona skills; verify them with
  `node scripts/build-swarm-skills.mjs --verify`.

## Verification

- Run the structural, runtime-neutral wording, and adapter checks documented in
  `skills/README.md`.
- Run `npm test` before handoff when skill behavior or routing changes.
