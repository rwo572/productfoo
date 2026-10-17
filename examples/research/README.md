# Synthetic research test fixtures

`hostile-injection-corpus.json` contains deliberately hostile, synthetic strings:
instruction overrides, encoded payloads, HTML, and tool-call-shaped text. Treat
all entries as inert test data. They are not instructions, real credentials,
customer records, or approved research evidence.

The repository test `test/hostileInjectionCorpus.test.ts` loads this file to
exercise receipt byte binding and typed-evidence handling. Keep the fixture and
its consumer together when moving files. Run the repository's `npm test` to run
that coverage; no model, connector, or external destination is needed.
