// feedback_triage_v0 T-001 — the `pii` profile, and the B1 refusal that makes it
// load-bearing (RISK-001).
//
// Every fixture below is INVENTED. No real person, address, path, employer, or
// machine appears in this file: a test for a privacy boundary must not itself be
// the leak. The names are fictional and the domains are under the reserved
// `.test`/`.invalid` TLDs, which can never resolve.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { knownProfiles, redactText, scanText } from "../src/redactEngine.js";

const FOO_BIN = path.resolve("bin/foo");

// A synthetic feedback document carrying one item from each of the five
// categories T-001 names.
const FEEDBACK_DOC = [
  "Reporter: Jordan Vance",
  "Employer: Northwind Logistics",
  "Contact: jordan.vance@example-mail.test",
  "I ran the tool from /Users/jvance/projects/atlas and it crashed on step two.",
  "The same run on CI under /home/runner/work/atlas was fine.",
  "She works at Northwind Logistics on the platform team.",
  "Device: Jordans-MacBook-Pro (jvance-laptop.local)",
  "en0 hardware address is a4:83:e7:1b:2c:9d",
  "install id 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "I asked Priya about it and she agreed the wording was confusing.",
].join("\n");

function piiDetectors(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of scanText(text, { profiles: ["pii"] }).findings) found.set(f.detector, f.confidence);
  return found;
}

// --- The profile itself (C-001) ----------------------------------------------

test("pii is a registered profile and stays opt-in (secrets is still the default)", () => {
  assert.deepEqual(knownProfiles().sort(), ["internal", "pii", "secrets"]);
  const byDefault = scanText(FEEDBACK_DOC).findings.map((f) => f.detector);
  assert.equal(byDefault.some((d) => d.startsWith("pii_")), false, "the default profile must not run pii detectors");
});

test("C-001 — a feedback doc with a name and a home path is redacted by the pii profile", () => {
  const { redactedText, receipt } = redactText(FEEDBACK_DOC, { profiles: ["pii"] });
  assert.equal(redactedText.includes("Jordan Vance"), false, "the reporter's name survived redaction");
  assert.equal(redactedText.includes("/Users/jvance"), false, "the home path survived redaction");
  assert.equal(redactedText.includes("[PII_IDENTITY_FIELD_1]"), true);
  assert.equal(redactedText.includes("[PII_HOME_PATH_1]"), true);
  // The document still reads: only the identifying span is replaced.
  assert.equal(redactedText.includes("/projects/atlas"), true);
  // Metadata-only receipt (R-007): no personal value in it.
  assert.equal(JSON.stringify(receipt).includes("Jordan Vance"), false);
  assert.equal(JSON.stringify(receipt).includes("jvance"), false);
});

test("the five categories: which ones are high confidence, and which are best-effort", () => {
  const found = piiDetectors(FEEDBACK_DOC);
  // Reliable — these have a syntax, so they block.
  assert.equal(found.get("pii_identity_field"), "high"); // names, when labelled
  assert.equal(found.get("pii_home_path"), "high");
  assert.equal(found.get("pii_email"), "high");
  assert.equal(found.get("pii_employer"), "high"); // employer, when labelled
  assert.equal(found.get("pii_mac_address"), "high");
  // Best-effort — redacted at the default threshold, never blocking.
  assert.equal(found.get("pii_employer_mention"), "medium");
  assert.equal(found.get("pii_device_name"), "medium");
  assert.equal(found.get("pii_machine_uuid"), "medium");
});

test("KNOWN GAP, pinned on purpose: a personal name in free prose is NOT detected", () => {
  // "I asked Priya about it" carries a real personal name and no marker. No
  // deterministic matcher can separate it from any other capitalised word
  // without a name list, and a capitalised-token heuristic would fire on every
  // sentence start. This assertion exists so the gap stays visible and is never
  // mistaken for coverage: passing the pii profile means no MACHINE-DETECTABLE
  // identifier remains, not that the document is anonymous.
  assert.equal(redactText(FEEDBACK_DOC, { profiles: ["pii"] }).redactedText.includes("Priya"), true);
});

test("a shared-machine home path is not a person (precision, not a lowered threshold)", () => {
  for (const line of ["/home/runner/work/atlas", "/Users/root/bin", "/home/ubuntu/app"]) {
    assert.equal(piiDetectors(line).has("pii_home_path"), false, `flagged an impersonal account: ${line}`);
  }
  assert.equal(piiDetectors("/Users/jvance/bin").get("pii_home_path"), "high");
});

test("a labelled field only fires on a name-shaped value", () => {
  assert.equal(piiDetectors("name: foo\nname: some-package\nfrom: the docs\n").has("pii_identity_field"), false);
  assert.equal(piiDetectors("Author: Jordan Vance\n").get("pii_identity_field"), "high");
});

test("the pii profile does not run the entropy backstop", () => {
  const hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // foo-redact: allow
  assert.equal(scanText(hex, { profiles: ["pii"] }).counts.total, 0);
});

test("foo redact --profile secrets,pii runs both profiles over one document", () => {
  const run = spawnSync("node", [FOO_BIN, "redact", "-", "--profile", "secrets,pii", "--json"], {
    encoding: "utf8",
    input: `${FEEDBACK_DOC}\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n`, // foo-redact: allow
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.redactedText.includes("Jordan Vance"), false);
  assert.equal(payload.redactedText.includes("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"), false); // foo-redact: allow
});

// --- The B1 refusal (C-002) ---------------------------------------------------

function trackedRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "foo-pii-b1-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(repo, file), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  return repo;
}

function selfCheck(repo: string): { exitCode: number; boundaries: Array<{ id: string; message: string }> } {
  const run = spawnSync("node", [FOO_BIN, "--root", repo, "self", "check", "--json"], { encoding: "utf8" });
  const payload = JSON.parse(run.stdout);
  return { exitCode: run.status ?? 0, boundaries: payload.boundaries };
}

test("C-002 — self check refuses a tracked write of unredacted feedback content", () => {
  const repo = trackedRepo({ "feedback/atlas-alpha.md": `${FEEDBACK_DOC}\n` });
  const { exitCode, boundaries } = selfCheck(repo);
  assert.equal(exitCode, 1, "unredacted feedback content must block");
  const pii = boundaries.filter((f) => f.id === "B1" && f.message.includes("feedback content"));
  assert.equal(pii.length >= 1, true, JSON.stringify(boundaries));
  assert.match(pii[0].message, /--profile secrets,pii/);
  // The finding names the file and line but never quotes the personal value.
  assert.equal(JSON.stringify(boundaries).includes("Jordan Vance"), false);
});

test("C-002 — the same content passes once it has been through the profile", () => {
  const redacted = redactText(FEEDBACK_DOC, { profiles: ["pii"] }).redactedText;
  const { exitCode, boundaries } = selfCheck(trackedRepo({ "feedback/atlas-alpha.md": `${redacted}\n` }));
  assert.equal(exitCode, 0, JSON.stringify(boundaries));
});

test("C-002 — a document that declares itself feedback is checked wherever it lives", () => {
  const repo = trackedRepo({ "notes/inbound.md": `foo-feedback: true\n${FEEDBACK_DOC}\n` });
  assert.equal(selfCheck(repo).exitCode, 1);
});

test("the refusal is narrow: source code about feedback is not feedback content", () => {
  // Same personal strings, in a file that merely deals with feedback. A gate
  // that fired here would be one people learn to override on sight.
  const repo = trackedRepo({
    "src/feedback.ts": `// example: Reporter: Jordan Vance at /Users/jvance/x\nexport const feedback = 1;\n`,
    "docs-feedback-notes.txt": "Reporter: Jordan Vance\n",
  });
  assert.equal(selfCheck(repo).exitCode, 0, JSON.stringify(selfCheck(repo).boundaries));
});

test("best-effort findings in feedback content do not block", () => {
  const repo = trackedRepo({
    "feedback/device.md": "Device: Jordans-MacBook-Pro\ninstall id 3f2504e0-4f89-11d3-9a0c-0305e82c3301\n",
  });
  assert.equal(selfCheck(repo).exitCode, 0);
});
