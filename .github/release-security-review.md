# 1.0.0 release security review

The first public CodeQL scan completed successfully but reported 30 findings:
https://github.com/rwo572/productfoo/actions/runs/39056541136
A successful scanner job alone is not a clean security verdict. npm publication
was cancelled pending the following focused fixes and fresh release verification.

## Scope and judgment

Preserve the approved CLI behavior and release contents while fixing reproducible
input-handling defects. Only public repository source and synthetic fixtures were
used. The maintainer's launch authorization covers release preparation; publication
remains subject to fresh payload verification and the protected environment.
No credentials, private archive contents, or connector data belong in this record.

Belief: the reproducible runtime defects should be fixed before 1.0.0.
Confidence: high for the four corrected cases, supported by failing regression
tests before changes. Dissent: most alerts are syntactic pattern matches rather
than exposed vulnerabilities; do not rewrite unrelated parsers solely to silence
alerts. The immutable release tag requires a deliberate maintainer decision before
it can be replaced with a corrected, reverified candidate.

## Findings and dispositions

| Alerts | Disposition and evidence |
| --- | --- |
| 2, 6 | Fixed. Adversarial stack text and a long non-email token exceeded a three-second subprocess timeout. Stack matching now starts at a frame line; summary email redaction scans delimiters without repeated suffix matching. Regressions also preserve adjacent email redaction. |
| 19 | Fixed. Candidate `T.[001]` previously selected no evidence because the ID was interpreted as a regex. Escape the literal ID before matching. The regression checks the recorded evidence URL. |
| 13, 14 | Fixed. The example HTML renderer escaped text characters but not attribute quotes. Escape both quote types; regression executes the renderer with hostile attribute values. The renderer still requires trusted input for deliberately supported rich HTML. |
| 1, 3, 4, 5 | False positives: the preceding replacement collapses every non-alphanumeric run, including hyphens, into one hyphen. The trailing-hyphen matcher cannot receive the long runs named by the alert. |
| 7 | Test fixture identity replacement, not a runtime security boundary. |
| 8 | Example preview renders `stepKey()` from validated direction and constant step IDs, not raw URL hash text. |
| 9 | Example-only localStorage comment rendering. Comments originate in this local preview; this is not an npm-delivered or hosted service. The preview should not be hosted on an origin containing sensitive state or fed untrusted stored comments without additional validation. Kept as a documented hardening follow-up, not dismissed as fixed. |
| 10 | The input is already split into lines. This expression removes single-line comments from prose; it is not an HTML security sanitizer. |
| 11, 12 | Text extraction from XML/captions, not an HTML trust boundary. Extracted content remains untrusted and must be escaped if later rendered as HTML. |
| 15, 16 | npm names are unscoped or have one scope separator. This replacement encodes that separator, not a general path sanitizer. |
| 17, 18 | Cosmetic punctuation cleanup in terminal prose, not path traversal prevention. |
| 20, 21, 22 | Stable connection identifiers, not password-verification hashes. Zendesk hashes subdomain and email; Notion/Fireflies fingerprint provider-issued API credentials without storing or printing the credentials. |
| 23–30 | Test assertions on controlled response URLs, not runtime host authorization. |

## Validation required

- Regression tests must fail on the original implementation and pass after fixes.
- Full unit suite, public source/package inventory, installed CLI smoke tests,
  repository checks, CodeQL and full-history secret scan.
- Freeze a new exact tarball digest and verify the corrected merged payload.
- Update the release tag only after an explicit maintainer decision; do not silently
  weaken tag immutability or publish the old candidate.

Attribution was reviewed; these fixes introduce no outside code or new dependency.
The spec router's targeted adapter is unavailable; this narrow behavior-preserving
repair uses the existing source, focused regression proof, and this judgment record.
