# Security Policy

productfoo is a personal open-source project. Security reports are welcome;
maintenance and response are best effort. The controls below reduce some risks
but do not make the project a sandbox or guarantee that sensitive data is safe.

## Reporting a Vulnerability

**Please do not open a public issue, pull request, or discussion for a security
vulnerability.** Public reports expose users before a fix is available.

Report privately through **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   ("Advisories" → "Report a vulnerability").
2. Describe the issue with enough detail to reproduce it (see below).

This opens a private advisory visible only to you and the maintainers. If you
cannot use GitHub's flow, open a minimal public issue that says only *"security
issue — requesting a private channel"* (no details) so a maintainer can arrange a
private channel when available.

A good report includes:

- The affected component (CLI command, skill, hook, workflow, or source file) and version/commit.
- Reproduction steps or a proof-of-concept.
- Impact: what an attacker can read, write, run, or exfiltrate.
- Any suggested remediation.

**Never include real secrets in a report.** productfoo's own redaction engine exists for
this purpose, but it can miss information. Prefer a synthetic reproduction;
if you use `foo redact <file>`, manually review the output before sharing it.

## Maintenance and response

There is no guaranteed acknowledgment, triage, fix, or disclosure timeline.
When a maintainer can investigate, disclosure and attribution can be coordinated
with the reporter. Do not rely on a response or a future fix to protect a system.

Any fixes made will normally target the latest published version. Older versions
do not have a backport commitment. Version 1.0.0 remains a release candidate until
published; the version number is not a production-safety certification.

## Safe Harbor

We support good-faith security research. If you make a good-faith effort to comply
with this policy, we will:

- Consider your research **authorized** under the Computer Fraud and Abuse Act (and
  equivalent laws) and **will not pursue or support legal action** against you for it.
- Consider reports and remediation as maintainer availability permits.

Good-faith research means you:

- Only interact with accounts, data, and repositories you own or have explicit
  permission to test — **no accessing, modifying, or destroying others' data**.
- **Do not run denial-of-service, spam, social-engineering, or physical attacks.**
- Give us a reasonable time to remediate before any public disclosure, and avoid
  privacy violations and service disruption during your research.

This policy covers the productfoo project's own code (CLI, skills, hooks, workflows). It
does not authorize testing against third-party services productfoo may integrate with
(e.g. GitHub, npm, model providers) — follow their respective policies.

## Scope Notes

- CI runs the configured secret scan. `foo self gate` inspects staged content
  when invoked explicitly or by a hook you configure; this public repository
  does not ship Git hooks. Report gaps in either path.
- productfoo handles potentially sensitive input (prompts, transcripts, connector
  summaries). Reports about data handling, redaction bypass, or exfiltration
  channels are especially welcome.

## Built-in security tooling

productfoo ships its own secret-handling tools — `scan`, `redact`, `self gate`, and the
content-aware half of `self check` all share one deterministic engine
(`src/redactEngine.ts`) that reports metadata only — detector, category,
confidence, line, length — never the secret value:

| Command / control | What it does |
| --- | --- |
| `foo scan <file\|dir\|->` | Report secrets; `--exit-code` exits 2 on any high-confidence finding. |
| `foo redact <file\|->` | Replace secrets with typed, irreversible placeholders; `--write` to overwrite, `--dry-run` for the receipt. |
| `foo self gate` | Staged-content check (run explicitly or through a configured Git hook): blocks staged high-confidence secrets and any staged entry it cannot completely inspect. Git/index failures, a missing scanner build, unsupported file types, incomplete reads, oversized blobs, binary/NUL content, and decoder failures block with metadata-only remediation. |
| `foo self check` | Content-aware B1: scans tracked text for secrets, not just filenames. |
| Egress guards | Configured egress paths, such as loop-budget token counting, inspect supported secret patterns and local-only markers; these are not a machine-wide network control. |
| CI secret-scan | `.github/workflows/security.yml`: Pinned, checksum-verified Gitleaks over full git history (blocking), plus a synthetic-secret positive control that verifies detection. |

**Known limits.** Scanners recognize supported patterns and can miss secrets,
confidential context, or personal information. A passing scan is not permission
to publish data. Hooks only run where installed; agents and other tools may use
paths that do not invoke these controls. The packet-write path has a separate,
narrower check. Egress checks cover particular commands, not all network traffic.

CI can report a failing check after a push has already reached GitHub. Preventing
a merge requires separately configured repository protections; CI cannot undo
exposure. Review exact file and package contents, limit credentials and tool
permissions, and rotate any credentials that are exposed.

Detection profiles are pluggable: the default `secrets` profile covers
AWS/GitHub/Slack/Stripe/GCP/Azure credentials and productfoo's own `sk-ant-` Anthropic
keys plus an entropy backstop; an opt-in `internal` profile adds private IPs and
internal hostnames. False positives are handled with a human-curated allowlist
(`--allow <file>` or an inline `foo-redact: allow` pragma), never by lowering the
detection bar.
