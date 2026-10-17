# Shirrts design intake — demonstration

A small TypeScript interview example for a fictional shirt-shop scenario. Use
synthetic answers. The packet's business narrative and historical task events
illustrate a product contract; they do not establish real customer metrics or a
fresh test result.

Read [the spec](specs/design-intake-agent-v0/spec.md) and
[task ledger](specs/design-intake-agent-v0/tasks.yaml), then compare them with
`src/` and `test/`. From this directory:

```sh
npm ci
npm test
npm run typecheck
```

The example has its own lockfile and TypeScript configuration. Its tests compile
into local `dist/`; no model key, provider connection, or hosted service is needed.
There is no web UI or deployed shop in this directory.

The missing printable confirmation (`T-006`) is intentional: it remains `todo`,
and its proposed source/test files are absent. `src/pricing.ts` is an example of
implementation outside the agreed task scope. Preserve both when demonstrating
missing proof and drift rather than making the example appear fully complete.

The keyword refusal rules are a demonstration policy, not a comprehensive rights
decision system. Review any real order with the responsible shop owner. The
historical packet format may need migration before serving as a new template;
use the current [spec guide](../../docs/foo-spec.md) for new work.
