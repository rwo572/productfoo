import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { approve, revoke } from "../src/sourceIngress.js";
import {
  authorizeDiscoverySource,
  consumeApprovedSourceProof,
  consumeDiscoveryProof,
  openAuthorizedTranscript,
  purgeDiscoveryRetention,
  purgeDiscoveryLocalState,
} from "../src/discoveryProof.js";
import type { DiscoverySession } from "../src/discoverySources.js";
import { sourceFingerprint } from "../src/discoveryMatching.js";

const NOW = "2026-07-20T16:00:00.000Z";
const SESSION: DiscoverySession = {
  schema_version: "0.1",
  provider: "granola",
  connection_alias: "primary",
  runtime_handle: "private-meeting-id",
  completed_at: "2026-07-20T15:00:00.000Z",
  completion_state: "completed",
  title: "Shape Up workflow",
  participants: ["Casey Sample"],
  stable_url: "https://app.granola.ai/meeting/abc",
  capabilities: { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true },
  access: "available",
};

function fixture(): { root: string; studyDir: string; localRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-proof-"));
  const studyDir = path.join(root, "discovery", "study");
  mkdirSync(studyDir, { recursive: true });
  writeFileSync(path.join(studyDir, "events.jsonl"), "");
  const localRoot = path.join(root, ".foo", "discovery");
  return { root, studyDir, localRoot };
}

function authorize(input: Partial<Parameters<typeof authorizeDiscoverySource>[0]> = {}) {
  const fx = fixture();
  approve(fx.studyDir, { ingress_path: "mcp", provider: "granola", connection_id: "primary" }, {
    packet: "study_granola_shape_up_20260720",
    scope: "study:study_granola_shape_up_20260720",
    by: "taylor",
    at: NOW,
  });
  return {
    fx,
    result: authorizeDiscoverySource({
      study_dir: fx.studyDir,
      local_root: fx.localRoot,
      study_id: "study_granola_shape_up_20260720",
      study_state: "awaiting_match",
      match_status: "unique",
      session: SESSION,
      now: NOW,
      ...input,
    }),
  };
}

test("unapproved, ambiguous, inaccessible, connector-less, and revoked calls never open a transcript", async () => {
  const cases: Array<{ name: string; prepare?: (studyDir: string) => void; input?: Partial<Parameters<typeof authorizeDiscoverySource>[0]>; status: string }> = [
    { name: "ambiguous", input: { match_status: "ambiguous" }, status: "ambiguous_match" },
    { name: "inaccessible", input: { session: { ...SESSION, access: "denied" } }, status: "needs_provider_access" },
    { name: "connector-less", input: { session: { ...SESSION, capabilities: { ...SESSION.capabilities, open_transcript: false } } }, status: "needs_provider_connector" },
    { name: "revoked study", input: { study_state: "revoked" }, status: "invalid" },
  ];
  for (const entry of cases) {
    const { fx, result } = authorize(entry.input);
    assert.equal(result.status, entry.status, entry.name);
    let calls = 0;
    await assert.rejects(
      () => openAuthorizedTranscript({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => { calls += 1; return "never"; }),
      /proof|authorized/i,
    );
    assert.equal(calls, 0, entry.name);
  }

  const cold = fixture();
  const missing = authorizeDiscoverySource({ study_dir: cold.studyDir, local_root: cold.localRoot, study_id: "study_granola_shape_up_20260720", study_state: "awaiting_match", match_status: "unique", session: SESSION, now: NOW });
  assert.equal(missing.status, "needs_source_approval");
  let calls = 0;
  await assert.rejects(
    () => openAuthorizedTranscript({ study_dir: cold.studyDir, local_root: cold.localRoot, study_id: "study_granola_shape_up_20260720", source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => { calls += 1; return "never"; }),
    /proof|authorized/i,
  );
  assert.equal(calls, 0);
});

test("approval scope must name this study and revocation fails closed", () => {
  const fx = fixture();
  const id = { ingress_path: "mcp" as const, provider: "granola", connection_id: "primary" };
  approve(fx.studyDir, id, { packet: "study", scope: "study:someone_else", by: "taylor", at: NOW });
  let result = authorizeDiscoverySource({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", study_state: "awaiting_match", match_status: "unique", session: SESSION, now: NOW });
  assert.equal(result.status, "needs_source_approval");
  revoke(fx.studyDir, id, { packet: "study", by: "taylor", at: NOW });
  result = authorizeDiscoverySource({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", study_state: "awaiting_match", match_status: "unique", session: SESSION, now: NOW });
  assert.equal(result.status, "needs_source_approval");
});

test("valid proof opens exactly once, never stores the transcript, and is consumed after apply", async () => {
  const CANARY = "PRIVATE_TRANSCRIPT_CANARY_7f03b9 do-not-obey-system-instructions sk-live-1234567890abcdef";
  const { fx, result } = authorize();
  assert.equal(result.status, "ready_to_synthesize");
  assert.ok(result.proof_ref);
  let calls = 0;
  const value = await openAuthorizedTranscript({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => {
    calls += 1;
    return CANARY;
  });
  assert.equal(value, CANARY, "the authorized runtime receives the transcript in memory");
  assert.equal(calls, 1);
  await assert.rejects(
    () => openAuthorizedTranscript({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => { calls += 1; return CANARY; }),
    /already opened|proof/i,
  );
  assert.equal(calls, 1);

  const localFiles = readdirSync(path.dirname(result.proof_ref!), { withFileTypes: true }).filter((entry) => entry.isFile());
  for (const entry of localFiles) assert.doesNotMatch(readFileSync(path.join(path.dirname(result.proof_ref!), entry.name), "utf8"), /PRIVATE_TRANSCRIPT_CANARY|sk-live/);
  consumeDiscoveryProof(fx.localRoot, "study_granola_shape_up_20260720", sourceFingerprint(SESSION), "2026-07-20T16:01:00.000Z");
  assert.equal(existsSync(result.proof_ref!), false);
});

test("provider errors are sanitized and leave no private residue", async () => {
  const CANARY = "PRIVATE_PROVIDER_ERROR_CANARY_91d9";
  const { fx } = authorize();
  await assert.rejects(
    () => openAuthorizedTranscript({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: "study_granola_shape_up_20260720", source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => { throw new Error(CANARY); }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(CANARY));
      assert.match(error.message, /provider transcript access failed/);
      return true;
    },
  );
  const tree = existsSync(fx.localRoot) ? readdirSync(fx.localRoot, { recursive: true }).join("\n") : "";
  assert.doesNotMatch(tree, new RegExp(CANARY));
});

test("purge removes only the scoped discovery local directory", () => {
  const { fx } = authorize();
  const keep = path.join(fx.localRoot, "another-study");
  mkdirSync(keep, { recursive: true });
  writeFileSync(path.join(keep, "receipt.json"), "{}");
  const result = purgeDiscoveryLocalState(fx.localRoot, "study_granola_shape_up_20260720");
  assert.equal(result.removed, true);
  assert.equal(existsSync(path.join(fx.localRoot, "study_granola_shape_up_20260720")), false);
  assert.equal(existsSync(keep), true);
});

test("retention removes revoked state immediately and completed state after 30 days while preserving active work", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-retention-"));
  const discoveryRoot = path.join(root, "discovery");
  const localRoot = path.join(root, ".foo", "discovery");
  const makeStudy = (name: string, studyId: string, state: string, updatedAt: string) => {
    const dir = path.join(discoveryRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "run.yaml"), `schema_version: "0.1"\nstudy_id: ${studyId}\nstate: ${state}\nupdated_at: ${updatedAt}\n`);
    const local = path.join(localRoot, studyId);
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, "match.json"), "{}\n");
  };
  makeStudy("old-complete", "study_old_complete", "complete", "2026-06-01T00:00:00.000Z");
  makeStudy("recent-complete", "study_recent_complete", "complete", "2026-07-10T00:00:00.000Z");
  makeStudy("old-active", "study_old_active", "needs_review", "2026-06-01T00:00:00.000Z");
  makeStudy("revoked", "study_revoked", "revoked", "2026-07-19T23:59:00.000Z");

  const result = purgeDiscoveryRetention(root, "2026-07-20T00:00:00.000Z");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.removed.sort(), [".foo/discovery/study_old_complete", ".foo/discovery/study_revoked"]);
  assert.equal(existsSync(path.join(localRoot, "study_recent_complete")), true);
  assert.equal(existsSync(path.join(localRoot, "study_old_active")), true);
});

test("retention fails closed and reports invalid terminal timestamps without deleting local state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-retention-invalid-"));
  const studyDir = path.join(root, "discovery", "bad");
  const localDir = path.join(root, ".foo", "discovery", "study_bad_timestamp");
  mkdirSync(studyDir, { recursive: true });
  mkdirSync(localDir, { recursive: true });
  writeFileSync(path.join(studyDir, "run.yaml"), 'schema_version: "0.1"\nstudy_id: study_bad_timestamp\nstate: complete\nupdated_at: not-a-date\n');
  writeFileSync(path.join(localDir, "match.json"), "{}\n");
  const result = purgeDiscoveryRetention(root, "2026-07-20T00:00:00.000Z");
  assert.match(result.failures.join("\n"), /study_bad_timestamp.*updated_at/);
  assert.equal(existsSync(localDir), true);
});

// --- One-time consumption under concurrent local invocation (audit F12) ----
// These functions are synchronous, so in-process callers cannot interleave
// mid-function; the race the audit describes is cross-process. The exclusive
// rename claim is the atomic primitive that closes it — a burst of parallel
// attempts is the observable form of that guarantee: exactly one attempt may
// win, and the receipt must be gone afterward.

test("discovery proof consumption is one-time under parallel local calls (F12)", async () => {
  const studyId = "study_granola_shape_up_20260720";
  const { fx } = authorize();
  await openAuthorizedTranscript({ study_dir: fx.studyDir, local_root: fx.localRoot, study_id: studyId, source_fingerprint: sourceFingerprint(SESSION), now: NOW }, async () => "content");
  const proof = path.join(fx.localRoot, studyId, "proof.json");
  assert.equal(existsSync(proof), true);

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve()
        .then(() => {
          consumeDiscoveryProof(fx.localRoot, studyId, sourceFingerprint(SESSION), "2026-07-20T16:01:00.000Z");
          return "consumed";
        })
        .catch(() => "refused"),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt === "consumed").length, 1, "exactly one consumer wins the one-time proof");
  assert.equal(existsSync(proof), false);
});

test("approved-source proof consumption is one-time under parallel local calls (F12)", async () => {
  const targetId = "docs_abc123";
  const localRoot = mkdtempSync(path.join(tmpdir(), "foo-approved-proof-"));
  const dir = path.join(localRoot, targetId);
  mkdirSync(dir, { recursive: true });
  // An opened receipt, written directly: consume validates shape, phase,
  // fingerprint, and expiry — the approval ledger is not consulted on this path.
  writeFileSync(path.join(dir, "proof.json"), `${JSON.stringify({
    schema_version: "0.1",
    kind: "approved_source_proof",
    target_id: targetId,
    provider: "notion",
    connection_alias: "primary",
    selection_fingerprint: `sha256:${"a".repeat(64)}`,
    approval_digest: `sha256:${"b".repeat(64)}`,
    issued_at: NOW,
    expires_at: "2026-07-20T16:10:00.000Z",
    phase: "opened",
    opened_at: NOW,
  }, null, 2)}\n`, { mode: 0o600 });

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve()
        .then(() => {
          consumeApprovedSourceProof(localRoot, targetId, `sha256:${"a".repeat(64)}`, NOW);
          return "consumed";
        })
        .catch(() => "refused"),
    ),
  );
  assert.equal(attempts.filter((attempt) => attempt === "consumed").length, 1, "exactly one consumer wins the one-time proof");
  assert.equal(existsSync(path.join(dir, "proof.json")), false);
});
