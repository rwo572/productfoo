// microsoft-teams-discovery-connector-v0 T-004: the tenant-owned connection
// contract (R-002). These are the ownership-isolation fixtures, built by the
// gong playbook with the spec's one delta — ownership transfer IS in scope,
// gated by a second administrator's out-of-band confirmation. They prove the
// pinned contract only — Teams support stays contract_only until the
// feasibility task (T-001) and dogfood run (T-008) produce receipt-backed
// evidence. A parallel PR owns the existing discovery test files; the Teams
// ownership fixtures live here alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvalStates,
  approve,
  assertCanApproveTeamsScope,
  connectTeamsTenantConnection,
  disconnectTeamsTenantConnection,
  teamsCanonicalSourceIdentity,
  teamsConnectionReady,
  teamsTenantSourceId,
  TeamsMemberConnectionRefusal,
  TeamsPersonalCredentialRefused,
  removeTeamsWorkspaceMember,
  revoke,
  revokeTeamsTenantConnection,
  rotateTeamsTenantConnection,
  sourceKey,
  transferTeamsTenantConnection,
  type SourceId,
  type TeamsTenantConnection,
} from "../src/sourceIngress.js";

const WORKSPACE = "ws_foo_inc";
const TENANT = "9f3a2b7c-1d5e-4082-a1b2-c3d4e5f60718";
const ADMIN = "subject_admin_01";
const MEMBER_A = "subject_member_a";
const MEMBER_B = "subject_member_b";
const SECOND_ADMIN = "subject_admin_02";
const CONNECTION_REF = "teams:conn_01";

function tenantConnection(): TeamsTenantConnection {
  const identity = teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: TENANT });
  const state = connectTeamsTenantConnection({ identity, connection_ref: CONNECTION_REF, admin_ref: ADMIN, presented_credential: { issued_for: "tenant" } });
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

test("the Teams canonical source identity is workspace-scoped and tenant-pinned", () => {
  const identity = teamsCanonicalSourceIdentity({ foo_workspace: ` ${WORKSPACE} `, tenant_id: TENANT });
  assert.deepEqual(identity, { foo_workspace: WORKSPACE, provider: "microsoft-teams", tenant_id: TENANT });
  assert.throws(() => teamsCanonicalSourceIdentity({ foo_workspace: "  ", tenant_id: TENANT }), /foo_workspace/);
  assert.throws(() => teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: "" }), /tenant_id/);
});

test("the ledger identity reuses the substrate SourceId, tenant-scoped so two workspaces sharing an Entra tenant never share approval state", () => {
  const identity = teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: TENANT });
  const sourceId = teamsTenantSourceId(identity);
  assert.deepEqual(sourceId, { ingress_path: "nango", provider: "microsoft-teams", connection_id: `${WORKSPACE}/${TENANT}` });
  const otherWorkspace = teamsTenantSourceId(teamsCanonicalSourceIdentity({ foo_workspace: "ws_other", tenant_id: TENANT }));
  assert.notEqual(sourceKey(sourceId), sourceKey(otherWorkspace));
});

// --- Connection and readiness (R-002, Contracts) -----------------------------

test("connecting records the workspace as owner with one accountable administrator", () => {
  const state = tenantConnection();
  assert.equal(state.connection_owner, "workspace");
  assert.equal(state.connection_owner_role, "admin");
  assert.equal(state.admin_ref, ADMIN);
  assert.equal(state.connected, true);
});

test("discovery_connection_ready reports workspace ownership, an opaque admin_ref, and no calls", () => {
  const ready = teamsConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: ADMIN });
  assert.equal(ready.event, "discovery_connection_ready");
  assert.equal(ready.connection_owner, "workspace");
  assert.equal(ready.admin_ref, ADMIN);
  assert.equal(ready.connection_ref, CONNECTION_REF);
  // Hosts receive only the opaque refs: the canonical identity never crosses
  // the host boundary, and the payload carries no call data.
  const serialized = JSON.stringify(ready);
  assert.equal(serialized.includes(WORKSPACE), false);
  assert.equal(serialized.includes(TENANT), false);
  assert.deepEqual(Object.keys(ready).sort(), ["admin_ref", "connection_owner", "connection_ref", "event"]);
});

test("readiness refs are opaque: no emails, no display names", () => {
  assert.throws(() => teamsConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: "taylor@foo.example" }), /opaque/);
  assert.throws(() => teamsConnectionReady({ connection_ref: CONNECTION_REF, admin_ref: "Taylor Fixture" }), /opaque/);
});

// --- Member versus administrator (R-002) -------------------------------------

test("a member cannot disconnect, rotate, revoke, or transfer the tenant connection", () => {
  const before = tenantConnection();
  for (const [attempt, action] of [
    [() => disconnectTeamsTenantConnection(before, MEMBER_A), "disconnect"],
    [() => rotateTeamsTenantConnection(before, MEMBER_A, { connection_ref: "teams:rotated" }), "rotate"],
    [() => revokeTeamsTenantConnection(before, MEMBER_A), "revoke"],
    [() => transferTeamsTenantConnection(before, { actor_ref: MEMBER_A, next_admin_ref: MEMBER_B, second_admin_confirmation: { confirmed_by: SECOND_ADMIN } }), "transfer"],
  ] as const) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof TeamsMemberConnectionRefusal);
      assert.equal(error.action, action);
      assert.match(error.message, /ask the administrator/);
      return true;
    });
  }
  // Every refusal leaves the connection exactly as it was.
  assert.equal(before.connected, true);
  assert.equal(before.grants.length, 2);
});

test("the administrator rotates the tenant credential and the rotation changes only the connection_ref", () => {
  const rotated = rotateTeamsTenantConnection(tenantConnection(), ADMIN, { connection_ref: "teams:rotated_01" });
  assert.equal(rotated.connection_ref, "teams:rotated_01");
  assert.equal(rotated.admin_ref, ADMIN);
  assert.equal(rotated.connected, true);
  assert.equal(rotated.grants.length, 2);
});

// --- Tenant-wide administrator revoke (R-002) --------------------------------

test("an administrator disconnect or revoke invalidates every member's references, grants, queued lanes, and receipts", () => {
  for (const torn of [disconnectTeamsTenantConnection(tenantConnection(), ADMIN), revokeTeamsTenantConnection(tenantConnection(), ADMIN)]) {
    assert.equal(torn.connected, false);
    assert.deepEqual(torn.session_refs, []);
    assert.deepEqual(torn.grants, []);
    assert.deepEqual(torn.queued_lanes, []);
    assert.deepEqual(torn.unconsumed_receipts, []);
  }
});

// --- Member removal (R-002) ---------------------------------------------------

test("a removed member loses their approvals and grants while the connection persists", () => {
  const { connection, lapsed } = removeTeamsWorkspaceMember(tenantConnection(), MEMBER_A);
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
  assert.throws(() => assertCanApproveTeamsScope(connection, MEMBER_A), /lapsed/);
  assert.doesNotThrow(() => assertCanApproveTeamsScope(connection, MEMBER_B));
});

test("removing the accountable administrator is refused: transfer is its own second-admin path", () => {
  const state = tenantConnection();
  assert.throws(() => removeTeamsWorkspaceMember(state, ADMIN), /ownership transfer/);
  assert.equal(state.connected, true);
});

// --- Ownership transfer (R-002, the one delta from the Gong ruling) ----------

test("ownership transfer works with a second administrator's out-of-band confirmation and changes only the accountable administrator", () => {
  const transferred = transferTeamsTenantConnection(tenantConnection(), { actor_ref: ADMIN, next_admin_ref: SECOND_ADMIN, second_admin_confirmation: { confirmed_by: "subject_admin_03" } });
  assert.equal(transferred.admin_ref, SECOND_ADMIN);
  assert.equal(transferred.connected, true);
  assert.equal(transferred.connection_ref, CONNECTION_REF);
  assert.equal(transferred.grants.length, 2, "outstanding member state survives an ownership change");
  assert.ok(transferred.members.includes(SECOND_ADMIN), "the incoming administrator is a member");
});

test("ownership transfer is refused without a real second administrator", () => {
  const outgoing = tenantConnection();
  // The outgoing administrator cannot confirm their own transfer...
  assert.throws(
    () => transferTeamsTenantConnection(outgoing, { actor_ref: ADMIN, next_admin_ref: SECOND_ADMIN, second_admin_confirmation: { confirmed_by: ADMIN } }),
    /SECOND administrator/,
  );
  // ...and neither can the incoming one.
  assert.throws(
    () => transferTeamsTenantConnection(outgoing, { actor_ref: ADMIN, next_admin_ref: SECOND_ADMIN, second_admin_confirmation: { confirmed_by: SECOND_ADMIN } }),
    /SECOND administrator/,
  );
  // Every refusal leaves the original administrator accountable.
  assert.equal(outgoing.admin_ref, ADMIN);
});

// --- Personal credential refusal (R-002) --------------------------------------

test("a personal Teams login presented as the tenant connection is refused with an honest handoff", () => {
  const identity = teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: TENANT });
  assert.throws(
    () => connectTeamsTenantConnection({ identity, connection_ref: CONNECTION_REF, admin_ref: ADMIN, presented_credential: { issued_for: "personal" } }),
    (error: unknown) => {
      assert.ok(error instanceof TeamsPersonalCredentialRefused);
      assert.match(error.handoff, /Microsoft 365 administrator/);
      return true;
    },
  );
});

// --- Ledger reuse: the existing approve/revoke gate accepts the tenant id -----

test("the packet-local ledger approves and revokes the tenant-scoped connection unchanged", () => {
  const packetDir = mkdtempSync(path.join(tmpdir(), "teams-ownership-"));
  try {
    const sourceId: SourceId = teamsTenantSourceId(teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: TENANT }));
    approve(packetDir, sourceId, { packet: "microsoft-teams-discovery-connector-v0", scope: "study:2026-09-exampleton", by: MEMBER_A, at: "2026-09-24T00:00:00.000Z" });
    const approved = approvalStates(packetDir).get(sourceKey(sourceId));
    assert.equal(approved?.state, "approved");
    // The accountable administrator revoking through the ledger clears the
    // approval — the tenant-wide effect R-002 pins, on the shared identity.
    revoke(packetDir, sourceId, { packet: "microsoft-teams-discovery-connector-v0", by: ADMIN, at: "2026-09-24T00:01:00.000Z" });
    assert.equal(approvalStates(packetDir).get(sourceKey(sourceId))?.state, "revoked");
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});
