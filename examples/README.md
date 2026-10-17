# Examples and fixtures

These nine directories serve different purposes. Spec examples show how intent,
work, and proof fit together; experiments and test fixtures are labeled separately.
They are source-checkout material, not additional installed CLI capabilities.

| Directory | Purpose and status | Start here |
|---|---|---|
| `agentic-todo-app` | Illustrative task-dispatch spec; the proposed app is not implemented here. | [Spec](agentic-todo-app/spec.md) |
| `calpal-scheduling` | Fictional scheduling-agent spec with static simulations and synthetic evidence. | [Spec](calpal-scheduling/spec.md) |
| `shirrts-design-intake` | Demonstration interview implementation with deliberately incomplete work. | [README](shirrts-design-intake/README.md) |
| `inactive-reengagement` | Illustrative schema and partial app for shaping an email feature; not deployable. | [README](inactive-reengagement/README.md) |
| `outside-in-audit` | Experimental public-source audit-page template and historical writing playbook. | [README](outside-in-audit/README.md) |
| `true-c-spike` | Local synthetic egress experiment, not product security certification. | [README](true-c-spike/README.md) |
| `verdict-gate` | Quarantined capability reference and illustrative policy data. | [README](verdict-gate/README.md) |
| `research` | Synthetic adversarial inputs consumed by automated tests. | [README](research/README.md) |

## Reading a packet

Start with `spec.md`, then compare `tasks.yaml` and `events.jsonl` with the
implementation, if one is included. Historical task statuses and recorded checks
are example evidence, not a fresh test result. The [spec guide](../docs/foo-spec.md)
and [CLI reference](../docs/cli-reference.md) describe current commands.

CalPal is a fictional example, with no real users or operating data, and no
endorsement by any similarly named product. Its evidence directory explicitly
uses synthetic material. The todo app is an illustrative proposal, not evidence
that its proposed integrations or dogfood checks were completed. The other
examples document their own provenance and limitations; do not supply real
customer data or credentials to experiments.
