# Public product design

This guide covers productfoo's CLI output and generated review artifacts. It does
not specify a hosted website or require a frontend framework. Product intent lives
in [PRODUCT.md](PRODUCT.md); output wording lives in the
[shared voice reference](../../skills/product-copywriting/references/foo-voice.md).

## CLI output

Lead with the result, the evidence behind it, and the next useful command. Keep
approval requests explicit about the action, scope, and remaining uncertainty.
Distinguish a plan, an attempted action, and verified completion.

`src/statusGlyphs.ts` owns status labels and symbols. Pair symbols with text on
interactive surfaces. Preserve machine states such as `claimed` in JSON and
contracts; do not put decorative glyphs in piped output or event records.

Use compact prose and tables where comparison helps. Do not rely on color alone,
and keep plain-text output useful without terminal styling.

## Generated artifacts

Design each preview around the task and the decision a person needs to make.
Show realistic states, source limitations, unresolved questions, and approval
boundaries. Label synthetic data and proposed behavior. A rendered preview is
review evidence, not proof that an implementation works.

Use the target project's existing design system when one is available. Choose
readable typography, clear hierarchy, responsive layouts, keyboard access,
visible focus, and sufficient contrast. Respect reduced-motion settings. Do not
introduce a mandatory productfoo color palette or component library into another
project.

Keep artifacts with their source packet or example. Feedback does not directly
rewrite the accepted spec: route changes through the recorded decision process.
Before handoff, follow the design and marketing review workflow in
[AGENTS.md](../../AGENTS.md) and record checks actually performed, findings, and
remaining gaps. Automated checks do not establish that a design is usable.
