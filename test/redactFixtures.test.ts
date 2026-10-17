// prompt-redaction-safety-v0 — T-006 fixture corpus + validation harness, and
// T-008 R-007 must-not proofs. The corpus lives in test/fixtures/redaction/:
// hot fixtures are committed with a splice marker inside every secret-shaped
// token (the committed bytes are never live-shaped — the corpus is itself a B1
// surface), and the harness strips the marker in memory before scanning.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { redactText, scanText } from "../src/redactEngine.js";
import { decideGate, runRedactGate } from "../src/redactGate.js";
import { REDACT_ALLOW_FILE } from "../src/redactConfig.js";

const CORPUS_DIR = path.resolve("test/fixtures/redaction");

type ManifestFixture = {
  file: string;
  kind: "hot" | "benign";
  description: string;
  expectDetectors?: string[];
};
type Manifest = { marker: string; fixtures: ManifestFixture[] };

const manifest: Manifest = JSON.parse(readFileSync(path.join(CORPUS_DIR, "manifest.json"), "utf8"));
const hot = manifest.fixtures.filter((f) => f.kind === "hot");
const benign = manifest.fixtures.filter((f) => f.kind === "benign");

function atRest(f: ManifestFixture): string {
  return readFileSync(path.join(CORPUS_DIR, f.file), "utf8");
}
function decoded(f: ManifestFixture): string {
  return atRest(f).split(manifest.marker).join("");
}
// The secret-shaped values a fixture reconstitutes: whitespace-delimited raw
// tokens that carried a splice marker, marker stripped. Used to prove no
// output artifact ever contains one.
function secretValues(f: ManifestFixture): string[] {
  return atRest(f)
    .split(/\s+/)
    .filter((tok) => tok.includes(manifest.marker))
    .map((tok) => tok.split(manifest.marker).join(""))
    .filter((v) => v.length >= 10);
}

test("corpus covers every fixture file on disk (manifest completeness)", () => {
  const onDisk = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".txt")).sort();
  const listed = manifest.fixtures.map((f) => f.file).sort();
  assert.deepEqual(onDisk, listed);
  assert.ok(hot.length >= 4 && benign.length >= 2, "corpus needs both hot and benign coverage");
});

test("committed corpus bytes are never live-shaped: every fixture scans clean at rest (R-007 synthetic corpus)", () => {
  for (const f of manifest.fixtures) {
    const result = scanText(atRest(f));
    assert.equal(result.counts.high, 0, `${f.file} contains a live-shaped token at rest — move the splice marker`);
  }
});

test("every hot fixture trips its expected detectors once decoded, with at least one high-confidence hit", () => {
  for (const f of hot) {
    const result = scanText(decoded(f));
    const fired = new Set(result.findings.map((x) => x.detector));
    for (const d of f.expectDetectors ?? []) {
      assert.ok(fired.has(d), `${f.file}: expected detector ${d}, fired: [${[...fired].join(", ")}]`);
    }
    assert.ok(result.counts.high >= 1, `${f.file}: a hot fixture must carry at least one gate-relevant (high) finding`);
  }
});

test("the gate blocks every hot fixture and passes every benign fixture (C-006 headline)", () => {
  for (const f of hot) {
    const decision = decideGate([{ file: f.file, text: decoded(f) }]);
    assert.equal(decision.blocked, true, `${f.file} must block`);
    assert.equal(decision.overridden, false);
  }
  for (const f of benign) {
    const decision = decideGate([{ file: f.file, text: decoded(f) }]);
    assert.equal(decision.blocked, false, `${f.file} must not block`);
    assert.equal(decision.high.length, 0, `${f.file} produced high findings: ${JSON.stringify(decision.high)}`);
  }
});

test("zero high-confidence leaks past redaction: redacted hot fixtures scan clean (C-006)", () => {
  for (const f of hot) {
    const { redactedText } = redactText(decoded(f));
    const rescan = scanText(redactedText);
    assert.equal(rescan.counts.high, 0, `${f.file}: a high-confidence secret survived redaction`);
  }
});

test("redaction is idempotent with stable placeholders on the whole corpus (C-006)", () => {
  for (const f of hot) {
    const once = redactText(decoded(f));
    const twice = redactText(once.redactedText);
    assert.equal(twice.redactedText, once.redactedText, `${f.file}: redaction is not idempotent`);
    assert.equal(twice.receipt.redactions, 0, `${f.file}: second pass redacted again`);
  }
});

test("no scan finding or redaction receipt ever contains a reconstituted secret value (R-007 metadata-only)", () => {
  for (const f of hot) {
    const text = decoded(f);
    const artifacts = JSON.stringify([scanText(text).findings, redactText(text).receipt]);
    for (const value of secretValues(f)) {
      assert.ok(!artifacts.includes(value), `${f.file}: an output artifact contains a secret value`);
    }
  }
});

// --- T-008: R-007 must-nots ---------------------------------------------------

test("the block decision is deterministic: same staged input, identical decision (R-007 no-LLM gate)", () => {
  const staged = hot.map((f) => ({ file: f.file, text: decoded(f) }));
  const a = decideGate(staged);
  const b = decideGate(staged);
  assert.deepEqual(a, b);
  assert.equal(a.blocked, true);
});

test("the override is human-only: no reason or whitespace reason never bypasses (R-007)", () => {
  const staged = [{ file: hot[0].file, text: decoded(hot[0]) }];
  assert.equal(decideGate(staged).blocked, true);
  assert.equal(decideGate(staged, { overrideReason: "" }).blocked, true);
  assert.equal(decideGate(staged, { overrideReason: "   " }).blocked, true);
  const overridden = decideGate(staged, { overrideReason: "rotated already, fixture for incident review" });
  assert.equal(overridden.blocked, false);
  assert.equal(overridden.overridden, true);
});

function gitFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "foo-redact-gate-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(root, rel), body);
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

test("an override audit record is written but never persists a secret value (R-007)", () => {
  const f = hot[0];
  const root = gitFixtureRepo({ "paste.txt": decoded(f) });
  const result = runRedactGate(root, { overrideReason: "synthetic fixture, harness proof", at: "2026-07-06T00:00:00Z" });
  assert.equal(result.exitCode, 0);
  const audit = readFileSync(path.join(root, ".foo", "redaction-overrides.jsonl"), "utf8");
  const record = JSON.parse(audit.trim());
  assert.equal(record.reason, "synthetic fixture, harness proof");
  assert.ok(record.total_high >= 1);
  for (const value of secretValues(f)) {
    assert.ok(!audit.includes(value), "audit record contains a secret value");
    assert.ok(!result.output.includes(value), "gate output contains a secret value");
  }
});

test("a blocked gate run persists nothing: no audit record, no secret anywhere in output (R-007)", () => {
  const f = hot[1];
  const root = gitFixtureRepo({ "paste.txt": decoded(f) });
  const result = runRedactGate(root);
  assert.equal(result.exitCode, 1);
  assert.ok(!existsSync(path.join(root, ".foo", "redaction-overrides.jsonl")), "blocked run must not write an audit record");
  for (const value of secretValues(f)) {
    assert.ok(!result.output.includes(value), "blocked output contains a secret value");
  }
});

test("scanning and gating never create or grow the allowlist (R-007 no auto-population)", () => {
  const f = hot[0];
  const root = gitFixtureRepo({ "paste.txt": decoded(f), [REDACT_ALLOW_FILE]: "known-benign-value-1234\n" });
  const before = readFileSync(path.join(root, REDACT_ALLOW_FILE), "utf8");
  runRedactGate(root);
  runRedactGate(root, { overrideReason: "harness proof", at: "2026-07-06T00:00:00Z" });
  scanText(decoded(f));
  redactText(decoded(f));
  assert.equal(readFileSync(path.join(root, REDACT_ALLOW_FILE), "utf8"), before, "allowlist changed during scan/gate");

  const bare = gitFixtureRepo({ "paste.txt": decoded(f) });
  runRedactGate(bare);
  assert.ok(!existsSync(path.join(bare, REDACT_ALLOW_FILE)), "a scan/gate run created an allowlist");
});

test("the gate module imports no network or LLM surface (R-007 deterministic-gate inspection)", () => {
  // Inspection encoded as a test: the gate's import graph is fs + git + the
  // deterministic engine. Any http/https/fetch/model dependency fails here.
  for (const rel of ["src/redactGate.ts", "src/redactEngine.ts", "src/redactConfig.ts"]) {
    const source = readFileSync(path.resolve(rel), "utf8");
    assert.doesNotMatch(
      source,
      /from "node:https?"|require\("(?:node:)?https?"\)|fetch\(|@anthropic-ai|from "openai"/,
      `${rel} imports a network or LLM surface`,
    );
  }
});
