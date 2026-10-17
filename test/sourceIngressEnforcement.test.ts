// Audit remediation F3: the company-connection ownership and revocation
// guards previously had zero runtime call sites — contract pins only. These
// fixtures prove the seam enforcement now wired into the packet-ledger
// mutation entry points (approve/revoke, which `foo source approve/revoke`
// and `foo discovery revoke` funnel through): membership on approve,
// administrator-only revoke, lapsed rights after member removal, and
// fail-closed handling of a corrupt state file. They also pin the documented
// limitation: where no connect surface has registered a company connection,
// the ledger mutates exactly as before.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GateBlock } from "../src/errorTaxonomy.js";
import {
  approvalStates,
  approve,
  connectCompanyConnection,
  connectTeamsTenantConnection,
  gongCanonicalSourceIdentity,
  gongWorkspaceSourceId,
  loadPacketConnectionState,
  MemberConnectionRefusal,
  PersonalCredentialRefused,
  removeWorkspaceMember,
  revoke,
  savePacketConnectionState,
  sourceKey,
  teamsCanonicalSourceIdentity,
  teamsTenantSourceId,
  TeamsMemberConnectionRefusal,
  TeamsPersonalCredentialRefused,
  type CompanyConnection,
  type SourceId,
  type TeamsTenantConnection,
} from "../src/sourceIngress.js";

const WORKSPACE = "ws_foo_inc";
const CANONICAL_KEY = "gong-account-7782";
const ADMIN = "subject_admin_01";
const MEMBER_A = "subject_member_a";
const MEMBER_B = "subject_member_b";
const OUTSIDER = "subject_outsider";
const CONNECTION_REF = "gong:9f3a2b7c1d5e4082";
const AT = "2026-09-25T00:00:00.000Z";
const PACKET = "nango_connector_substrate_v0";

function gongSourceId(): SourceId {
  return gongWorkspaceSourceId(gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY }));
}

function teamsSourceId(): SourceId {
  return teamsTenantSourceId(teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: "tenant_01" }));
}

function gongState(): CompanyConnection {
  const state = connectCompanyConnection({
    identity: gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY }),
    connection_ref: CONNECTION_REF,
    admin_ref: ADMIN,
    presented_credential: { issued_for: "company" },
  });
  return { ...state, members: [ADMIN, MEMBER_A, MEMBER_B] };
}

function teamsState(): TeamsTenantConnection {
  const state = connectTeamsTenantConnection({
    identity: teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: "tenant_01" }),
    connection_ref: "teams:9f3a2b7c1d5e4082",
    admin_ref: ADMIN,
    presented_credential: { issued_for: "tenant" },
  });
  return { ...state, members: [ADMIN, MEMBER_A, MEMBER_B] };
}

function newPacket(): string {
  return mkdtempSync(path.join(tmpdir(), "ingress-enforcement-"));
}

function statePath(packetDir: string): string {
  return path.join(packetDir, "integration-connections.json");
}

// --- No connection state: behavior unchanged (the documented limitation) -----

test("without a persisted company connection, approve and revoke behave exactly as before", () => {
  const packetDir = newPacket();
  try {
    // No connect surface exists yet, so no state exists: today any actor may
    // approve and revoke (documented in docs/security-model.md).
    approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: OUTSIDER, at: AT });
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId()))?.state, "approved");
    revoke(packetDir, gongSourceId(), { packet: PACKET, by: OUTSIDER, at: AT });
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId()))?.state, "revoked");
    // The seam read never creates state: enforcement only ever restricts.
    assert.equal(existsSync(statePath(packetDir)), false);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("the seam matches the governing connection by provider and connection_id", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    const loaded = loadPacketConnectionState(packetDir, gongSourceId());
    assert.ok(loaded);
    assert.equal(loaded.identity.provider, "gong");
    assert.equal(loaded.admin_ref, ADMIN);
    // A different connection on the same provider is not governed by it...
    assert.equal(loadPacketConnectionState(packetDir, { ...gongSourceId(), connection_id: "ws_other/other-key" }), null);
    // ...and neither is another provider.
    assert.equal(loadPacketConnectionState(packetDir, { provider: "linear", connection_id: `${WORKSPACE}/${CANONICAL_KEY}` }), null);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- Approve seam: membership (R-002) ----------------------------------------

test("a non-member cannot approve a target against a company-connected source", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    assert.throws(
      () => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: OUTSIDER, at: AT }),
      /only a current workspace member may register a target/,
    );
    // Refused before any ledger event is written.
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId())), undefined);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("a current workspace member may approve, and the approval lands in the ledger", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    const result = approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: MEMBER_A, at: AT });
    assert.deepEqual(result, { approved: true, idempotent: false });
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId()))?.state, "approved");
    // The administrator is a member too.
    assert.doesNotThrow(() => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-10-kwan", by: ADMIN, at: AT }));
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("the membership guard is not bypassed by an already-approved scope", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: MEMBER_A, at: AT });
    // Re-approving the covered scope would be idempotent for a member — for a
    // non-member it is still a refused registration attempt.
    assert.throws(
      () => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: OUTSIDER, at: AT }),
      /only a current workspace member/,
    );
    const memberRetry = approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: MEMBER_A, at: AT });
    assert.deepEqual(memberRetry, { approved: true, idempotent: true });
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- Revoke seam: administrator-only (R-002) ---------------------------------

test("a member cannot revoke a company-connected source; the administrator can", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    assert.throws(
      () => revoke(packetDir, gongSourceId(), { packet: PACKET, by: MEMBER_A, at: AT }),
      (error: unknown) => {
        assert.ok(error instanceof MemberConnectionRefusal);
        assert.equal(error.action, "revoke");
        return true;
      },
    );
    // Refused before any ledger event, and the connection state is untouched.
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId())), undefined);
    const stillConnected = loadPacketConnectionState(packetDir, gongSourceId()) as CompanyConnection;
    assert.equal(stillConnected.connected, true);

    const result = revoke(packetDir, gongSourceId(), { packet: PACKET, by: ADMIN, at: AT });
    assert.equal(result.revoked, true);
    assert.equal(approvalStates(packetDir).get(sourceKey(gongSourceId()))?.state, "revoked");
    // The revocation guard's tenant-wide invalidation is persisted with it.
    const invalidated = loadPacketConnectionState(packetDir, gongSourceId()) as CompanyConnection;
    assert.equal(invalidated.connected, false);
    assert.deepEqual(invalidated.session_refs, []);
    assert.deepEqual(invalidated.grants, []);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- Member removal lapses approval rights through the seam (R-002) ----------

test("a removed member's approval rights lapse through the seam", () => {
  const packetDir = newPacket();
  try {
    const { connection } = removeWorkspaceMember(gongState(), MEMBER_A);
    savePacketConnectionState(packetDir, gongSourceId(), connection);
    assert.throws(
      () => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: MEMBER_A, at: AT }),
      /lapsed/,
    );
    assert.doesNotThrow(() => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: MEMBER_B, at: AT }));
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- Teams tenant connection: the same seam ----------------------------------

test("the tenant-owned Teams connection enforces the same seam", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, teamsSourceId(), teamsState());
    assert.throws(
      () => approve(packetDir, teamsSourceId(), { packet: PACKET, scope: "study:2026-09-exampleton", by: OUTSIDER, at: AT }),
      /only a current workspace member may register a target against the tenant connection/,
    );
    assert.throws(
      () => revoke(packetDir, teamsSourceId(), { packet: PACKET, by: MEMBER_A, at: AT }),
      (error: unknown) => {
        assert.ok(error instanceof TeamsMemberConnectionRefusal);
        assert.equal(error.action, "revoke");
        return true;
      },
    );
    assert.equal(approvalStates(packetDir).get(sourceKey(teamsSourceId())), undefined);
    revoke(packetDir, teamsSourceId(), { packet: PACKET, by: ADMIN, at: AT });
    const invalidated = loadPacketConnectionState(packetDir, teamsSourceId()) as TeamsTenantConnection;
    assert.equal(invalidated.connected, false);
    assert.equal(approvalStates(packetDir).get(sourceKey(teamsSourceId()))?.state, "revoked");
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- Fail-closed on a guard input ---------------------------------------------

test("a corrupt connection-state file fails closed instead of bypassing the guard", () => {
  const packetDir = newPacket();
  try {
    writeFileSync(statePath(packetDir), "{not json", { mode: 0o600 });
    assert.throws(() => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:x", by: ADMIN, at: AT }), /not valid JSON/);
    assert.throws(() => revoke(packetDir, gongSourceId(), { packet: PACKET, by: ADMIN, at: AT }), /not valid JSON/);
    assert.equal(approvalStates(packetDir).size, 0);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("a malformed state record fails closed instead of bypassing the guard", () => {
  const packetDir = newPacket();
  try {
    const malformed = {
      schema_version: "0.1",
      kind: "source_connection_state",
      connections: { gong: { connection_id: gongSourceId().connection_id, state: { connection_owner: "workspace" } } },
    };
    writeFileSync(statePath(packetDir), JSON.stringify(malformed), { mode: 0o600 });
    assert.throws(() => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "study:x", by: ADMIN, at: AT }), /malformed/);
    assert.throws(() => revoke(packetDir, gongSourceId(), { packet: PACKET, by: ADMIN, at: AT }), /malformed/);
    assert.equal(approvalStates(packetDir).size, 0);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("the persisted connection-state file is 0600", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    assert.equal(statSync(statePath(packetDir)).mode & 0o777, 0o600);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- The connect surface's own guard (PersonalCredentialRefused) --------------

test("a personal credential is refused at the connect guard, before any state is persisted", () => {
  const packetDir = newPacket();
  try {
    const identity = gongCanonicalSourceIdentity({ foo_workspace: WORKSPACE, canonical_connection_key: CANONICAL_KEY });
    assert.throws(
      () => connectCompanyConnection({ identity, connection_ref: CONNECTION_REF, admin_ref: ADMIN, presented_credential: { issued_for: "personal" } }),
      (error: unknown) => {
        assert.ok(error instanceof PersonalCredentialRefused);
        assert.match(error.handoff, /ask your Gong administrator/);
        return true;
      },
    );
    assert.throws(
      () => connectTeamsTenantConnection({ identity: teamsCanonicalSourceIdentity({ foo_workspace: WORKSPACE, tenant_id: "tenant_01" }), connection_ref: "teams:x", admin_ref: ADMIN, presented_credential: { issued_for: "personal" } }),
      TeamsPersonalCredentialRefused,
    );
    // The refusal is the connect surface's enforcement point; nothing persisted.
    assert.equal(existsSync(statePath(packetDir)), false);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// --- The discovery revoke entry point shares the seam --------------------------

test("the discovery revoke path (mcp ingress) is governed by the same seam", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    // `foo discovery revoke` funnels through the same revoke() with an
    // ingress_path of "mcp" and the run's connection alias — the seam keys on
    // the substrate identity, not the CLI shape.
    assert.throws(
      () => revoke(packetDir, { ingress_path: "mcp", provider: "gong", connection_id: gongSourceId().connection_id }, { packet: PACKET, by: MEMBER_A, at: AT }),
      MemberConnectionRefusal,
    );
    assert.equal(approvalStates(packetDir).size, 0);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("connection state persists and loads back equal", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    const loaded = loadPacketConnectionState(packetDir, gongSourceId()) as CompanyConnection;
    assert.deepEqual(loaded, gongState());
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

// #889: after the accountable administrator revokes a company connection, a
// member cannot re-approve a scope on it (nor can anyone) until it is reconnected.
test("an administrator-revoked connection takes no new approvals from anyone", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, gongSourceId(), gongState());
    approve(packetDir, gongSourceId(), { packet: PACKET, scope: "call:1", by: MEMBER_A, at: AT });
    revoke(packetDir, gongSourceId(), { packet: PACKET, by: ADMIN, at: AT });
    assert.equal((loadPacketConnectionState(packetDir, gongSourceId()) as CompanyConnection).connected, false);
    const afterRevoke = approvalStates(packetDir).get(sourceKey(gongSourceId()));
    assert.equal(afterRevoke?.state, "revoked");

    for (const by of [MEMBER_A, ADMIN]) {
      assert.throws(
        () => approve(packetDir, gongSourceId(), { packet: PACKET, scope: "call:2", by, at: AT }),
        (error: unknown) => error instanceof GateBlock && /revoked by its accountable administrator/.test(error.message),
        `${by} must not re-approve a revoked connection`,
      );
    }
    // Refused before any ledger event: the source still reads as revoked.
    assert.deepEqual(approvalStates(packetDir).get(sourceKey(gongSourceId())), afterRevoke);
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});

test("the tenant-owned Teams connection refuses approvals once revoked, too", () => {
  const packetDir = newPacket();
  try {
    savePacketConnectionState(packetDir, teamsSourceId(), { ...teamsState(), connected: false });
    assert.throws(
      () => approve(packetDir, teamsSourceId(), { packet: PACKET, scope: "team:1", by: MEMBER_A, at: AT }),
      (error: unknown) => error instanceof GateBlock,
    );
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});
