# Supported-agent cleanup review

This is a single-agent review using six role lenses, not independent subagent verification.

## Highest-leverage question

Should the five-agent list govern installer behavior as well as the README? Yes: `--agent all` currently enumerates every command adapter. A wording-only change leaves unintended installations possible.

## Expert answers to override

| Candidate | Lens | Evidence and recommendation | Ask user? |
|---|---|---|---|
| Which agents remain? | Product | Approved context: the maintainer named five; use exactly those. | No |
| Does removing adapters imply new headless bindings? | Architecture | `AGENT_ADAPTERS` and command adapters have different contracts; preserve that distinction and the CI scheduling substrate. | No |
| Should old installed files be removed? | Security | Setup writes outside this repository; do not introduce deletion or migrate external config. Preserve generic web-tool recognition. | No |
| How do we prevent silent extra installs? | Evaluation | Test actual all-agent output and exact allowlists, plus unsupported selection before writes. | No |
| Remove all matching words? | Business | Model catalog entries and source quotations are unrelated to integration support; retain them. | No |
| Are user-facing flags correct? | Developer experience | Actual IDs are claude-code and grok; Codex needs global scope. Keep explicit instructions. | No |

## Deferred questions

None required to complete this bounded cleanup. Adding any future agent is separate work.

## Judgment ledger

Belief: a single five-agent installation boundary matches the requested product scope. Confidence: high, based on the explicit maintainer selection and inspected registries. Dissent: removing implementations reduces compatibility for previous users; external configuration remains untouched and obsolete IDs fail clearly. No model pricing or attribution removal is justified. The CLI recommended a targeted review but reported its adapter unavailable; this manual scoped review records that workflow limitation rather than claiming independent review.

## Spec changes implied

Requirements separate supported installation/gates, documentation, and regression proof. Generic safety matching remains covered; examples use the selected agents.

## Finalization gate

Spec-cleanup checks applied: requirements are testable, task touches map to implementation, scope/approval boundaries are explicit, no unresolved user choice remains. Validate before implementation and reconcile afterward.

## Do not expand yet

Do not add agents, promote provisional gate coverage, install plugins, remove user configuration, publish npm, or change repository visibility.
