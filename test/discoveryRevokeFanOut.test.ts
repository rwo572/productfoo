// #898: `foo discovery revoke` must not silently drop a hosted target. It fans
// out the same privilege-reducing discovery_suspend_target call `foo source
// revoke` sends (nango-discovery-connector-v0 R-008), limited to the study's
// own target, and keeps the registration while the suspension is pending so a
// later `foo source revoke` can retry instead of finding nothing.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runDiscoveryCommand } from "../src/discoveryCommand.js";
import { approvalLedgerDigest } from "../src/discoveryProof.js";
import {
  fanOutDiscoveryTargetSuspension,
  recordDiscoveryTargetRegistration,
  type DiscoveryTargetManifest,
} from "../src/discoveryConnections.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const STUDY_ID = "study_granola_shape_up_20260720";
const OTHER_STUDY = "study_granola_other_20260720";
const NOW = "2026-09-24T12:00:00.000Z";

function register(root: string, studyDir: string, targetId: string, targetRefDigit: string): string {
  const manifest: DiscoveryTargetManifest = {
    schema_version: "0.1",
    kind: "discovery_target_manifest",
    packet: "nango-discovery-connector-v0",
    spec_id: "nango_discovery_connector_v0",
    workspace_ref: "ws_test_workspace",
    target_id: targetId,
    lane: "study",
    connection_ref: `conn:${"1".repeat(32)}`,
    approved_selectors: ["customer:example"],
    approval_digest: approvalLedgerDigest(studyDir),
    revocation_epoch: 3,
  };
  const target_ref = `dtarget:${targetRefDigit.repeat(32)}` as const;
  recordDiscoveryTargetRegistration(root, {
    manifest,
    confirmation: { confirmed_by: "tester", confirmed_at: NOW, confirmed_via: "fixture-confirmation" },
    result: {
      target_ref,
      grant: {
        schema_version: "0.1", kind: "discovery_service_grant", subject_ref: "subj_tester", workspace_ref: manifest.workspace_ref,
        target_ref, target_id: targetId, lane: "study", connection_ref: manifest.connection_ref,
        approved_selectors: [...manifest.approved_selectors], approval_digest: manifest.approval_digest,
        revocation_epoch: 3, issued_at: NOW, expires_at: "2026-09-25T12:00:00.000Z", budget: { max_operations: 10, window: "day" },
      },
    },
    local: { subject_ref: "subj_tester", provider: "granola", connection_id: "primary" },
    at: NOW,
  });
  return path.join(root, ".foo", "discovery", targetId, "target.json");
}

test("discovery revoke fans out suspension for the study's hosted target and keeps it while pending", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-revoke-fanout-"));
  try {
    const studyDir = seedDiscoveryFixture(root);
    writeFileSync(path.join(studyDir, "run.yaml"), readFileSync(path.join(studyDir, "run.yaml"), "utf8").replace("state: awaiting_interview", "state: ready_to_synthesize"));
    const ownTarget = register(root, studyDir, STUDY_ID, "2");
    const otherTarget = register(root, studyDir, OTHER_STUDY, "3");

    const revoked = await runDiscoveryCommand(root, ["revoke", STUDY_ID, "--by", "tester", "--json"], "", NOW);
    assert.equal(revoked.result.status, "ok");
    const hosted = revoked.result.coverage.hosted as { registered: number; acknowledged: number; pending: number; outcomes: Array<{ status: string; reason?: string }> };
    assert.equal(hosted.registered, 1, "only this study's target — another study on the same connection is untouched");
    assert.equal(hosted.pending, 1);
    assert.equal(hosted.outcomes[0]?.status, "revocation_pending");
    assert.equal(hosted.outcomes[0]?.reason, "service_unreachable");
    assert.ok(revoked.result.next_actions.some((line) => /REVOCATION_PENDING/.test(line)), "the pending remote suspension is reported, not silent");

    assert.ok(existsSync(ownTarget), "the registration survives the purge while suspension is pending");
    assert.equal((JSON.parse(readFileSync(ownTarget, "utf8")) as { suspension?: { state: string } }).suspension?.state, "revocation_pending");
    assert.equal((JSON.parse(readFileSync(otherTarget, "utf8")) as { suspension?: unknown }).suspension ?? null, null, "the other study's target was not suspended");

    // A later `foo source revoke` for the same approval can still find and retry it.
    const retry = await fanOutDiscoveryTargetSuspension({
      localRoot: root, provider: "granola", connection_id: "primary",
      revocation_event_digest: `sha256:${"a".repeat(64)}`, requested_by: "tester", at: NOW,
    });
    assert.ok(retry.outcomes.some((outcome) => outcome.target_id === STUDY_ID), "the retry reaches the revoked study's target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
