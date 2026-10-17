# Redaction fixture corpus (prompt-redaction-safety-v0 T-006)

Real-shaped, **synthetic, non-live** secrets across provider types, plus benign
near-misses, used by `test/redactFixtures.test.js` to prove the headline
acceptance: no high-confidence secret gets past the gate, and redaction is
stable and idempotent.

## The splice-marker contract

Every secret-shaped token in a `hot` fixture is committed with a `%%` splice
marker inside it (e.g. `AKIA%%IOSFODNN7EXAMPLE`). The harness strips `%%`
in memory to reconstitute the real-shaped synthetic value before scanning.

This means the committed bytes of this corpus **never contain a live-shaped
secret** — the corpus itself satisfies the R-007 must-not that the fixture
corpus is a B1 surface. The harness enforces this: every fixture file is also
scanned *at rest* (as committed) and must produce zero high-confidence
findings. If you add a fixture and that assertion fails, your marker placement
is wrong — move the `%%` so it breaks the detector's shape.

Rules for adding a fixture:

- Synthetic values only: provider documentation placeholders (AWS's
  `AKIA%%IOSFODNN7EXAMPLE` family — marker included even in this README, which
  the commit gate scans like everything else) or obviously fabricated repeats.
  Never a value that was ever live.
- Put `%%` inside every secret-shaped token, early enough to break the
  detector prefix or the value body.
- Register the file in `manifest.json` with the detectors it must trip
  (`hot`) or `"kind": "benign"` (must trip nothing high).
