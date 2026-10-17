// gong-discovery-connector-v0 T-006: the company-owned connection contract
// (R-002/D-002), fixed after the owner's OQ-001 ruling (2026-09-24). These are
// the V-005 ownership-isolation fixtures: member versus administrator
// boundaries, tenant-wide administrator revoke, member-removal lapse, and the
// refusal of a personal credential presented as the company connection. They
// prove the pinned contract only — Gong support stays contract_only until the
// feasibility task and dogfood run (R-008). A parallel PR owns the existing
// discovery test files; the ownership fixtures live here alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvalStates,
  assertCanApproveScope,
  approve,
  connectCompanyConnection,
  disconnectCompanyConnection,
  gongCanonicalSourceIdentity,
  gongConnectionReady,
  gongWorkspaceSourceId,
  MemberConnectionRefusal,
  PersonalCredentialRefused,
  removeWorkspaceMember,
  revoke,
  revokeCompanyConnection,
  rotateCompanyConnection,
  sourceKey,
  type GongCompanyConnection,
} from "../src/sourceIngress.js";

const WORKSPACE = "ws_foo_inc";
const CANONICAL_KEY = "gong-account-7782";
const ADMIN = "subject_admin_01";
const MEMBER_A = "subject_member_a";
const MEMBER_B = "subject_member_b";
const CONNECTION_REF = "gong:9f3a2b7c1d5e4082";

function companyConnection(): GongCompanyConnection {
  const identity = gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY });
  const state = connectCompanyConnection({ identity, connection_ref: CONNECTION_REF, admin_ref: ADMIN, presented_credential: { issued_for: "company" } });
  // Seed outstanding state held by two members, as a member's approved-scope
  // listing, grant, queued lane, and receipt would leave behind.
  return {
    ...state,
    members: [ADMIN, MEMBER_A, MEMBER_B],
    session_refs: [
      { session_ref: "sess_a_1", member_ref: MEMBER_A },
      { session_ref: "sess_b_1", member_ref: MEMBER_B },
    ],
    grants: [
      { grant_ref: "grant_a_1", member_ref: MEMBER_A },
      { grant_ref: "grant_b_1", member_ref: MEMBER_B },
    ],
    queued_lanes: [
      { lane_ref: "lane_a_1", member_ref: MEMBER_A },
      { lane_ref: "lane_b_1", member_ref: MEMBER_B },
    ],
    unconsumed_receipts: [
      { receipt_ref: "receipt_a_1", member_ref: MEMBER_A },
      { receipt_ref: "receipt_b_1", member_ref: MEMBER_B },
    ],
  };
}

// --- Canonical source identity (R-002) --------------------------------------

test("the canonical source identity is workspace-scoped and provider-pinned", () => {
  const identity = gongCanonicalSourceIdentity({ foo_workspace: ` ${WORKSPACE} `, canonical_connection_key: CANONICAL_KEY });
  assert.deepEqual(identity, { foo_workspace: WORKSPACE, provider: "gong", canonical_connection_key: CANONICAL_KEY });
  assert.throws(() => gongCanonicalSourceIdentity({ foo_workspace: "  ", canonical_connection_key: CANONICAL_KEY }), /foo_workspace/);
  assert.throws(() => gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: "" }), /canonical_connection_key/);
});

test("the ledger identity reuses the substrate SourceId, tenant-scoped so shared Gong accounts never share approval state", () => {
  const identity = gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY });
  const sourceId = gongWorkspaceSourceId(identity);
  assert.deepEqual(sourceId, { ingress_path: "nango", provider: "gong", connection_id: `${WORKSPACE}/${CANONICAL_KEY}` });
  const otherWorkspace = gongWorkspaceSourceId(gongCanonicalSourceIdentity({ foo_workspace: "ws_other", canonical_connection_key: CANONICAL_KEY }));
  assert.notEqual(sourceKey(sourceId), sourceKey(otherWorkspace));
});

// --- Connection and readiness (R-002, Contracts) -----------------------------

test("connecting records the workspace as owner with one accountable administrator", () => {
  const state = companyConnection();
  assert.equal(state.connection_owner, "workspace");
  assert.equal(state.connection_owner_role, "admin");
  assert.equal(state.admin_ref, ADMIN);
  assert.equal(state.connected, true);
});

test("discovery_connection_ready reports workspace ownership, an opaque admin_ref, and no calls", () => {
  const ready = gongConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: ADMIN });
  assert.equal(ready.event, "discovery_connection_ready");
  assert.equal(ready.connection_owner, "workspace");
  assert.equal(ready.admin_ref, ADMIN);
  assert.equal(ready.connection_ref, CONNECTION_REF);
  // Hosts receive only the opaque refs: the canonical identity never crosses
  // the host boundary, and the payload carries no call data.
  const serialized = JSON.stringify(ready);
  assert.equal(serialized.includes(WORKSPACE), false);
  assert.equal(serialized.includes(CANONICAL_KEY), false);
  assert.deepEqual(Object.keys(ready).sort(), ["admin_ref", "connection_owner", "connection_ref", "event"]);
});

test("readiness refs are opaque: no emails, no display names", () => {
  assert.throws(() => gongConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: "taylor@foo.example" }), /opaque/);
  assert.throws(() => gongConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: "Taylor Fixture" }), /opaque/);
});

// --- Member versus administrator (C-008) -------------------------------------

test("a member cannot disconnect, rotate, or revoke the company connection", () => {
  const before = companyConnection();
  for (const [attempt, action] of [
    [() => disconnectCompanyConnection(before, MEMBER_A), "disconnect"],
    [() => rotateCompanyConnection(before, MEMBER_A, { connection_ref: "gong:rotated" }), "rotate"],
    [() => revokeCompanyConnection(before, MEMBER_A), "revoke"],
  ] as const) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof MemberConnectionRefusal);
      assert.equal(error.action, action);
      assert.match(error.message, /ask the administrator/);
      return true;
    });
  }
  // Every refusal leaves the connection exactly as it was.
  assert.equal(before.connected, true);
  assert.equal(before.grants.length, 2);
});

test("the administrator rotates the company credential and the rotation changes only the connection_ref", () => {
  const rotated = rotateCompanyConnection(companyConnection(), ADMIN, { connection_ref: "gong:rotated_01" });
  assert.equal(rotated.connection_ref, "gong:rotated_01");
  assert.equal(rotated.admin_ref, ADMIN);
  assert.equal(rotated.connected, true);
  assert.equal(rotated.grants.length, 2);
});

// --- Tenant-wide administrator revoke (C-008) --------------------------------

test("an administrator disconnect or revoke invalidates every member's references, grants, queued lanes, and receipts", () => {
  for (const torn of [disconnectCompanyConnection(companyConnection(), ADMIN), revokeCompanyConnection(companyConnection(), ADMIN)]) {
    assert.equal(torn.connected, false);
    assert.deepEqual(torn.session_refs, []);
    assert.deepEqual(torn.grants, []);
    assert.deepEqual(torn.queued_lanes, []);
    assert.deepEqual(torn.unconsumed_receipts, []);
  }
});

// --- Member removal (C-008) ---------------------------------------------------

test("a removed member loses their approvals and grants while the connection persists", () => {
  const { connection, lapsed } = removeWorkspaceMember(companyConnection(), MEMBER_A);
  // The member's own outstanding state lapsed...
  assert.deepEqual(lapsed, { session_refs: ["sess_a_1"], grants: ["grant_a_1"], queued_lanes: ["lane_a_1"], unconsumed_receipts: ["receipt_a_1"] });
  // ...the connection survived — it was never theirs...
  assert.equal(connection.connected, true);
  assert.equal(connection.connection_ref, CONNECTION_REF);
  assert.equal(connection.admin_ref, ADMIN);
  // ...the other member kept everything, and the removed member's approval
  // rights lapsed with their membership.
  assert.deepEqual(connection.grants, [{ grant_ref: "grant_b_1", member_ref: MEMBER_B }]);
  assert.deepEqual(connection.session_refs, [{ session_ref: "sess_b_1", member_ref: MEMBER_B }]);
  assert.throws(() => assertCanApproveScope(connection, MEMBER_A), /lapsed/);
  assert.doesNotThrow(() => assertCanApproveScope(connection, MEMBER_B));
});

test("removing the accountable administrator is refused: ownership transfer stays out of V0 scope", () => {
  const state = companyConnection();
  assert.throws(() => removeWorkspaceMember(state, ADMIN), /ownership transfer/);
  assert.equal(state.connected, true);
});

// --- Personal credential refusal (C-009) --------------------------------------

test("a personal Gong credential presented as the company connection is refused with an honest handoff", () => {
  const identity = gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY });
  assert.throws(
    () => connectCompanyConnection({ identity, connection_ref: CONNECTION_REF, admin_ref: ADMIN, presented_credential: { issued_for: "personal" } }),
    (error: unknown) => {
      assert.ok(error instanceof PersonalCredentialRefused);
      assert.match(error.handoff, /ask your Gong administrator/);
      return true;
    },
  );
});

// --- Ledger reuse: the existing approve/revoke gate accepts the workspace id --

test("the packet-local ledger approves and revokes the workspace-scoped connection unchanged", () => {
  const packetDir = mkdtempSync(path.join(tmpdir(), "gong-ownership-"));
  try {
    const sourceId = gongWorkspaceSourceId(gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY }));
    approve(packetDir, sourceId, { packet: "gong-discovery-connector-v0", scope: "study:2026-09-exampleton", by: MEMBER_A, at: "2026-09-24T00:00:00.000Z" });
    const approved = approvalStates(packetDir).get(sourceKey(sourceId));
    assert.equal(approved?.state, "approved");
    // The accountable administrator revoking through the ledger clears the
    // approval — the tenant-wide effect R-002 pins, on the shared identity.
    revoke(packetDir, sourceId, { packet: "gong-discovery-connector-v0", by: ADMIN, at: "2026-09-24T00:01:00.000Z" });
    assert.equal(approvalStates(packetDir).get(sourceKey(sourceId))?.state, "revoked");
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});
