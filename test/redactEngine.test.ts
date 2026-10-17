import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { knownProfiles, parseAllowlist, redactText, scanText, shannonEntropy } from "../src/redactEngine.js";

const FOO_BIN = path.resolve("bin/foo");

// Synthetic, non-live secrets only (R-007 / T-006). These are AWS's own
// documentation placeholders and equivalents — shaped like real credentials,
// but universally known non-secrets. Each fixture line carries an allow pragma.
const FIXTURES = {
  awsKey: "AKIAIOSFODNN7EXAMPLE", // foo-redact: allow (synthetic fixture)
  githubToken: "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789", // foo-redact: allow (ghp_ + 36)
  slackToken: "xoxb-123456789012-ABCDEFGHIJ", // foo-redact: allow
  stripeLive: "sk_live_0123456789abcdef", // foo-redact: allow
  stripeTest: "sk_test_0123456789abcdef", // foo-redact: allow
  gcpKey: "AIza" + "B".repeat(35), // foo-redact: allow
  openaiKey: "sk-" + "T3BlbkFJ".repeat(3), // foo-redact: allow
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", // foo-redact: allow
  privateKey: "-----BEGIN RSA PRIVATE KEY-----", // foo-redact: allow
  dbUrl: "postgres://admin:s3cr3tpw@db.internal.example.com:5432/app", // foo-redact: allow
  anthropicKey: "sk-ant-api03-" + "Zx9".repeat(31) + "AA", // foo-redact: allow (synthetic, not real)
  azureConn: "DefaultEndpointsProtocol=https;AccountName=devstore;AccountKey=" + "Ab1".repeat(30) + "==;EndpointSuffix=core.windows.net", // foo-redact: allow
  gcpServiceAccount: '{"type": "service_' + 'account", "project_id": "demo"}', // foo-redact: allow
  hex: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // foo-redact: allow (entropy 4.0)
  pureNumeric: "1234567890123456789012345", // foo-redact: allow
};

function detectors(text: string): string[] {
  return scanText(text).findings.map((f) => f.detector);
}

test("scanText detects provider credentials at high confidence", () => {
  for (const value of [FIXTURES.awsKey, FIXTURES.githubToken, FIXTURES.slackToken, FIXTURES.stripeLive, FIXTURES.gcpKey, FIXTURES.privateKey, FIXTURES.dbUrl, FIXTURES.anthropicKey, FIXTURES.azureConn]) {
    const result = scanText(`leak: ${value}\n`);
    assert.equal(result.counts.high >= 1, true, `expected a high-confidence finding for ${value.slice(0, 6)}…`);
  }
});

test("scanText catches every seeded high-confidence secret in one blob (C-001: 0 misses)", () => {
  const text = [
    `aws=${FIXTURES.awsKey}`,
    `gh=${FIXTURES.githubToken}`,
    `slack=${FIXTURES.slackToken}`,
    `stripe=${FIXTURES.stripeLive}`,
    `gcp=${FIXTURES.gcpKey}`,
    FIXTURES.privateKey,
    `db=${FIXTURES.dbUrl}`,
    `anth=${FIXTURES.anthropicKey}`,
    `az=${FIXTURES.azureConn}`,
    `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY`, // foo-redact: allow
  ].join("\n");
  const found = new Set(detectors(text));
  for (const d of ["aws_access_key_id", "github_token", "slack_token", "stripe_secret_key", "gcp_api_key", "private_key_block", "db_connection_string", "secret_assignment", "anthropic_key", "azure_storage_key"]) {
    assert.equal(found.has(d), true, `missed detector: ${d}`);
  }
});

test("scanText classifies test/medium credentials below high", () => {
  assert.equal(scanText(FIXTURES.stripeTest).findings[0]?.confidence, "medium");
  assert.equal(scanText(FIXTURES.openaiKey).findings[0]?.confidence, "medium");
  assert.equal(scanText(FIXTURES.jwt).findings[0]?.confidence, "medium");
  assert.equal(scanText(FIXTURES.gcpServiceAccount).findings[0]?.confidence, "medium");
});

test("scanText is deterministic (same input + options => identical findings)", () => {
  const text = `a=${FIXTURES.awsKey} b=${FIXTURES.githubToken}\nc=${FIXTURES.hex}`;
  assert.deepEqual(scanText(text), scanText(text));
});

test("scanText reports stable, sorted line/column locations", () => {
  const text = `line1 ok\nsecret_token=${FIXTURES.githubToken}\n`;
  const finding = scanText(text).findings.find((f) => f.detector === "github_token");
  assert.ok(finding);
  assert.equal(finding?.line, 2);
  assert.equal(typeof finding?.column, "number");
});

test("allowlist suppresses a known benign value (R-007 human-curated)", () => {
  const text = `key=${FIXTURES.githubToken}`;
  assert.equal(scanText(text).counts.total >= 1, true);
  const allowed = scanText(text, { allowlist: [FIXTURES.githubToken] });
  assert.equal(allowed.findings.some((f) => f.detector === "github_token"), false);
});

test("entropy backstop flags unknown-format high-entropy strings as low (advisory)", () => {
  const finding = scanText(`token ${FIXTURES.hex} end`).findings.find((f) => f.detector === "high_entropy_string");
  assert.ok(finding, "expected an entropy finding");
  assert.equal(finding?.confidence, "low");
  assert.equal(typeof finding?.entropy, "number");
});

test("entropy backstop ignores pure-numeric runs (false-positive cut)", () => {
  const findings = scanText(`id ${FIXTURES.pureNumeric} end`).findings;
  assert.equal(findings.some((f) => f.detector === "high_entropy_string"), false);
});

test("placeholder assignment values are not flagged", () => {
  for (const line of ["API_KEY=changeme", "PASSWORD=<your-password>", "SECRET=${ENV_SECRET}", "token=xxxxxx"]) {
    assert.equal(scanText(line).counts.total, 0, `placeholder leaked: ${line}`);
  }
});

test("ordinary code produces no high/medium findings (precision sanity)", () => {
  const text = "const greeting = 'hello world';\nfunction add(a, b) { return a + b; }\n";
  const result = scanText(text);
  assert.equal(result.counts.high, 0);
  assert.equal(result.counts.medium, 0);
});

test("findings never contain the secret value (R-007 metadata-only)", () => {
  const result = scanText(`aws=${FIXTURES.awsKey}\ngh=${FIXTURES.githubToken}`);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(FIXTURES.awsKey), false);
  assert.equal(serialized.includes(FIXTURES.githubToken), false);
});

test("shannonEntropy and parseAllowlist behave", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("abcd") > 1.9);
  assert.deepEqual(parseAllowlist("# comment\n\nAKIA123\n  ghp_x  \n"), ["AKIA123", "ghp_x"]);
});

// --- CLI smoke tests ---------------------------------------------------------

function runScan(input: string, ...args: string[]) {
  return spawnSync("node", [FOO_BIN, "scan", ...args], { cwd: process.cwd(), encoding: "utf8", input });
}

test("foo scan reads stdin and reports findings without showing the value", () => {
  const result = runScan(`token=${FIXTURES.githubToken}\n`, "-");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /github_token/);
  assert.match(result.stdout, /\[high\]/);
  assert.equal(result.stdout.includes(FIXTURES.githubToken), false);
});

test("foo scan --exit-code returns non-zero on a high-confidence secret", () => {
  const hit = runScan(`k=${FIXTURES.awsKey}\n`, "-", "--exit-code");
  assert.equal(hit.status, 2);
  const clean = runScan("just some ordinary text\n", "-", "--exit-code");
  assert.equal(clean.status, 0, clean.stderr);
});

test("foo scan --json emits machine-readable findings", () => {
  const result = runScan(`k=${FIXTURES.awsKey}\n`, "-", "--json");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.totals.high >= 1, true);
  assert.equal(Array.isArray(payload.results), true);
});

test("foo scan surfaces binary files as skipped instead of silently dropping them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-scan-skip-"));
  writeFileSync(path.join(dir, "clean.txt"), "just some ordinary text\n");
  // NUL byte early in the file trips the binary guard; the rest is text.
  writeFileSync(path.join(dir, "sneaky.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(`k=${FIXTURES.awsKey}\n`)]));

  const result = spawnSync("node", [FOO_BIN, "scan", dir, "--json"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scanned, 1);
  assert.equal(payload.skipped.length, 1);
  assert.match(payload.skipped[0].file, /sneaky\.bin$/);
  assert.equal(payload.skipped[0].reason, "binary");

  const text = spawnSync("node", [FOO_BIN, "scan", dir], { cwd: process.cwd(), encoding: "utf8" });
  assert.match(text.stdout, /Skipped \(not scanned\): 1 file\(s\)/);
  assert.match(text.stdout, /sneaky\.bin — binary/);
});

// --- T-002: redactText (R-002, R-003) ----------------------------------------

test("redactText replaces secrets with typed placeholders and removes the value", () => {
  const { redactedText } = redactText(`tok=${FIXTURES.githubToken}`);
  assert.equal(redactedText, "tok=[GITHUB_TOKEN_1]");
  assert.equal(redactedText.includes(FIXTURES.githubToken), false);
});

test("redactText preserves the KEY= prefix and redacts only the value", () => {
  const { redactedText } = redactText(`API_KEY=${FIXTURES.githubToken}`);
  assert.equal(redactedText, "API_KEY=[GITHUB_TOKEN_1]");
});

test("redactText uses consistent tokens: same value => same token, distinct => numbered", () => {
  const { redactedText } = redactText(`a=${FIXTURES.githubToken}\nb=${FIXTURES.githubToken}\nc=${FIXTURES.awsKey}`);
  assert.equal(redactedText, "a=[GITHUB_TOKEN_1]\nb=[GITHUB_TOKEN_1]\nc=[AWS_ACCESS_KEY_ID_1]");
});

test("redactText default threshold keeps low-confidence (entropy) for review, not redaction", () => {
  const { redactedText, receipt } = redactText(`hex ${FIXTURES.hex} end`);
  assert.equal(redactedText.includes(FIXTURES.hex), true, "entropy hit should be kept at default threshold");
  assert.equal(receipt.redactions, 0);
  assert.equal(receipt.kept.length, 1);
  assert.equal(receipt.kept[0]?.confidence, "low");
});

test("redactText --include-low (threshold low) redacts entropy hits too", () => {
  const { redactedText, receipt } = redactText(`hex ${FIXTURES.hex} end`, { threshold: "low" });
  assert.equal(redactedText.includes(FIXTURES.hex), false);
  assert.equal(receipt.redactions, 1);
});

test("redactText receipt is metadata-only — never contains a secret value (R-007)", () => {
  const result = redactText(`aws=${FIXTURES.awsKey} gh=${FIXTURES.githubToken}`);
  assert.equal(JSON.stringify(result.receipt).includes(FIXTURES.awsKey), false);
  assert.equal(JSON.stringify(result.receipt).includes(FIXTURES.githubToken), false);
});

test("redactText is idempotent (C-002): redacting redacted text is a no-op", () => {
  const text = `aws=${FIXTURES.awsKey}\ndb=${FIXTURES.dbUrl}\nhex=${FIXTURES.hex}`;
  const once = redactText(text, { threshold: "low" }).redactedText;
  const twice = redactText(once, { threshold: "low" }).redactedText;
  assert.equal(once, twice);
});

function runRedact(input: string, ...args: string[]) {
  return spawnSync("node", [FOO_BIN, "redact", ...args], { cwd: process.cwd(), encoding: "utf8", input });
}

test("foo redact prints redacted output to stdout without the secret", () => {
  const result = runRedact(`tok=${FIXTURES.githubToken}\n`, "-");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[GITHUB_TOKEN_1\]/);
  assert.equal(result.stdout.includes(FIXTURES.githubToken), false);
});

test("foo redact --dry-run shows a receipt and preview, no secret value", () => {
  const result = runRedact(`tok=${FIXTURES.githubToken}\n`, "-", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Redactions: 1/);
  assert.match(result.stdout, /\[GITHUB_TOKEN_1\]/);
  assert.equal(result.stdout.includes(FIXTURES.githubToken), false);
});

test("foo redact --json emits redactedText + metadata-only receipt", () => {
  const result = runRedact(`tok=${FIXTURES.githubToken}\n`, "-", "--json");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.receipt.redactions >= 1, true);
  assert.equal(typeof payload.redactedText, "string");
  assert.equal(JSON.stringify(payload.receipt).includes(FIXTURES.githubToken), false);
});

// --- T-005: detection profiles (R-006) ---------------------------------------

test("default profile (secrets) does not flag internal-infra identifiers", () => {
  const result = scanText("connect to host 10.0.0.5 and db.corp now");
  assert.equal(result.findings.some((f) => f.detector === "private_ip"), false);
  assert.equal(result.findings.some((f) => f.detector === "internal_hostname"), false);
});

test("opt-in internal profile detects private IPs and internal hostnames", () => {
  const result = scanText("connect to host 10.0.0.5 and db.corp now", { profiles: ["internal"] });
  assert.equal(result.findings.some((f) => f.detector === "private_ip"), true);
  assert.equal(result.findings.some((f) => f.detector === "internal_hostname"), true);
  assert.equal(result.findings.every((f) => f.confidence === "medium"), true);
});

test("knownProfiles lists registered profiles (a profile is a registry entry)", () => {
  assert.deepEqual(knownProfiles().sort(), ["internal", "pii", "secrets"]);
});

test("the internal profile does not run the entropy backstop", () => {
  assert.equal(scanText(FIXTURES.hex, { profiles: ["internal"] }).counts.total, 0);
});

test("an unknown profile is rejected", () => {
  assert.throws(() => scanText("x", { profiles: ["nope"] }), /unknown redaction profile/);
});

test("foo scan --profile internal selects the profile via the CLI", () => {
  const def = runScan("host 10.0.0.5\n", "-", "--json");
  assert.equal(JSON.parse(def.stdout).totals.total, 0);
  const internal = runScan("host 10.0.0.5\n", "-", "--profile", "internal", "--json");
  assert.equal(JSON.parse(internal.stdout).totals.medium >= 1, true);
});
