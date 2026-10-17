// logged-in-experience-v0 T-009 (C-017, C-018): the probe-packet proof that a
// browser OAuth handshake admits no packet content. Runs fully offline — the
// handshake is simulated as the connection object web/foo-site stores, and the
// packet ledger is a temp dir. Pins the OQ-010 decision: the handshake emits
// no ledger event, admits nothing, changes no classification, and revocation
// stops ingress at the gate (liveness) and the ledger (revoke + purge).

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  approvalStates,
  approve,
  browserConnectionReady,
  browserConnectionRef,
  browserConnectionSourceId,
  browserIngressDecision,
  discover,
  recordClaim,
  recordSummary,
  revoke,
  sourceKey,
  SOURCE_CATEGORY_REGISTRY,
  type BrowserConnection,
} from "../src/sourceIngress.js";

const TEAM = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const RECONNECT = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const AT = "2026-09-25T00:00:00.000Z";

function conn(connection_ref: string = GRANT, revoked_at: string | null = null): BrowserConnection {
  return { provider: "linear", team_ref: TEAM, connection_ref, revoked_at };
}

function probePacket(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-t009-probe-"));
}

// --- C-017: the probe packet admits nothing on a handshake alone ------------

test("C-017 probe: a browser handshake writes no ledger event and admits no content", () => {
  const dir = probePacket();

  // The handshake's ONLY emission is payload-free readiness provenance — a
  // value handed back, never a ledger write.
  const ready = browserConnectionReady(conn(), ACTOR);
  assert.equal(ready.event, "discovery_connection_ready");
  assert.equal(ready.connection_owner, "workspace");
  assert.equal(ready.admin_ref, ACTOR);
  assert.equal(ready.connection_ref, `${TEAM}/${GRANT}`);
  assert.ok(!("content" in ready) && !("payload" in ready));
  assert.equal(existsSync(path.join(dir, "events.jsonl")), false, "connect wrote nothing to the packet");

  // Repeated ingress attempts stay refused and stay read-only over the ledger.
  for (let i = 0; i < 3; i++) {
    const decision = browserIngressDecision(dir, conn());
    assert.equal(decision.allowed, false);
    assert.equal(decision.stage, "approval");
    assert.equal(decision.approval_state, "excluded");
  }
  assert.equal(existsSync(path.join(dir, "events.jsonl")), false, "the decision never mints its own permission");

  // Discovery sees the connected source honestly: registered provider, real
  // classification, but excluded — connecting is not approval (G-4).
  const sid = browserConnectionSourceId(conn());
  const rows = discover(dir, [{ ingress_path: "browser", provider: sid.provider, connection_id: sid.connection_id }], AT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ingress_path, "browser");
  assert.equal(rows[0].approval_state, "excluded");
  assert.equal(rows[0].registered, true);
  assert.equal(rows[0].sensitivity, "medium"); // linear's registry classification, unchanged

  // Content refuses at the ledger gates.
  assert.equal(recordSummary(dir, sid, { selection: "issue/1", summary: "customer chris@exampletonbros.example needs this", at: AT }).recorded, false);
  assert.equal(recordClaim(dir, sid, { selection: "issue/1", claim: "blocks", cites_task: "T-1", direction: "supports", at: AT }).recorded, false);
  assert.equal(existsSync(path.join(dir, "integration-events.jsonl")), false, "no content landed in the local-only ledger either");
});

test("C-017 probe: an unknown provider stays most-restrictive through the browser path", () => {
  const dir = probePacket();
  const stranger: BrowserConnection = { provider: "novel-crm", team_ref: TEAM, connection_ref: GRANT };

  const refused = browserIngressDecision(dir, stranger);
  assert.equal(refused.allowed, false);
  assert.equal(refused.classification.registered, false);
  assert.equal(refused.classification.sensitivity, "high");
  assert.equal(refused.classification.evidence_class, "context_only");
  assert.equal(refused.classification.model_exposure, "summary_only");

  // Even after an explicit per-packet approval, the classification does not
  // upgrade: the most-restrictive default is a floor, not a gate bypass.
  approve(dir, browserConnectionSourceId(stranger), { packet: "probe", scope: "*", by: "owner", at: AT });
  const allowed = browserIngressDecision(dir, stranger);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.classification.registered, false);
  assert.equal(allowed.classification.sensitivity, "high");
  assert.equal(allowed.classification.evidence_class, "context_only");
});

test("explicit per-packet approval admits minimized content through the browser source id", () => {
  const dir = probePacket();
  const sid = browserConnectionSourceId(conn());
  approve(dir, sid, { packet: "probe", scope: "issues:read", by: "owner", at: AT });

  const decision = browserIngressDecision(dir, conn());
  assert.equal(decision.allowed, true);
  assert.equal(decision.approval_state, "approved");

  const recorded = recordSummary(dir, sid, { selection: "issue/1", summary: "ping chris@exampletonbros.example or +1 415 555 0100", at: AT });
  assert.equal(recorded.recorded, true);
  const ledger = readFileSync(path.join(dir, "integration-events.jsonl"), "utf8");
  assert.match(ledger, /\[email\]/);
  assert.match(ledger, /\[phone\]/);
  assert.ok(!ledger.includes("chris@exampletonbros.example"), "raw PII never lands");
});

test("the OAuth granted-scope string is not a ledger scope: unapproved selections stay refused", () => {
  const dir = probePacket();
  const sid = browserConnectionSourceId(conn());
  // The connection's OAuth grant was Linear `read`; the approver scoped THIS
  // packet to issues only. Nothing auto-derives a broader ledger scope.
  approve(dir, sid, { packet: "probe", scope: "issues:read", by: "owner", at: AT });
  const refused = recordClaim(dir, sid, { selection: "opportunities/all", claim: "revenue signal", cites_task: "T-1", direction: "supports", at: AT });
  assert.equal(refused.recorded, false);
  assert.match(refused.reason ?? "", /outside the approved scope/);
});

// --- C-018: revoking the connection stops future ingress ---------------------

test("C-018: a revoked connection refuses at the gate even where the ledger still says approved", () => {
  const dir = probePacket();
  const sid = browserConnectionSourceId(conn());
  approve(dir, sid, { packet: "probe", scope: "issues:read", by: "owner", at: AT });
  assert.equal(browserIngressDecision(dir, conn()).allowed, true);

  // Revoke the connection in the browser (T-008 tombstones the row); the
  // packet ledger has not heard about it yet — and the gate still refuses.
  const revoked = conn(GRANT, AT);
  const decision = browserIngressDecision(dir, revoked);
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "liveness");
  assert.equal(decision.approval_state, "approved", "the stale ledger row is reported honestly");
  assert.match(decision.reason, /C-018/);

  // The honest ingress flow consults the decision first and aborts, so no
  // content lands anywhere.
  assert.equal(existsSync(path.join(dir, "integration-events.jsonl")), false);
});

test("C-018: the ledger-layer revoke purges recorded summaries and flips the source to revoked", () => {
  const dir = probePacket();
  const sid = browserConnectionSourceId(conn());
  approve(dir, sid, { packet: "probe", scope: "issues:read", by: "owner", at: AT });
  assert.equal(recordSummary(dir, sid, { selection: "issue/1", summary: "pre-revoke summary", at: AT }).recorded, true);

  // The owner-side revoke flow calls the substrate's revoke with the browser
  // source id — revoke event + summary tombstone, unchanged substrate.
  const result = revoke(dir, sid, { packet: "probe", by: "owner", at: AT });
  assert.equal(result.revoked, true);
  assert.equal(result.purged, 1);
  assert.equal(approvalStates(dir).get(sourceKey(sid))?.state, "revoked");
  const ledger = readFileSync(path.join(dir, "integration-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(ledger[0].tombstoned, true);
  assert.ok(!JSON.stringify(ledger).includes("pre-revoke summary"), "the summary text is gone, the line count preserved");

  // And the gate refuses the revoked source on every path.
  assert.equal(browserIngressDecision(dir, conn()).allowed, false);
});

test("C-018: a re-connect is a new source to every ledger — stale approvals cannot ride the fresh credential", () => {
  const dir = probePacket();
  approve(dir, browserConnectionSourceId(conn(GRANT)), { packet: "probe", scope: "issues:read", by: "owner", at: AT });

  const fresh = conn(RECONNECT); // T-008 mints a fresh row per grant
  assert.notEqual(browserConnectionSourceId(fresh).connection_id, browserConnectionSourceId(conn(GRANT)).connection_id);
  const decision = browserIngressDecision(dir, fresh);
  assert.equal(decision.allowed, false);
  assert.equal(decision.stage, "approval");
  assert.equal(decision.approval_state, "excluded");
});

// --- Identity and registry floors --------------------------------------------

test("browser source identity is opaque, team-scoped, per-grant, and case-stable", () => {
  assert.equal(browserConnectionSourceId(conn()).ingress_path, "browser");
  assert.equal(browserConnectionSourceId(conn()).connection_id, `${TEAM}/${GRANT}`);
  assert.notEqual(
    browserConnectionSourceId({ ...conn(), team_ref: "99999999-9999-4999-8999-999999999999" }).connection_id,
    browserConnectionSourceId(conn()).connection_id,
  );
  assert.equal(browserConnectionSourceId({ ...conn(), provider: "LINEAR" }).provider, "linear");
  assert.throws(() => browserConnectionRef({ team_ref: "team@corp.com", connection_ref: GRANT }), /opaque/);
  assert.throws(() => browserConnectionRef({ team_ref: TEAM, connection_ref: "the grant row" }), /opaque/);
});

test("G-4 registry floor: prospect/opportunity-adjacent classes stay sensitivity high", () => {
  for (const [provider, entry] of Object.entries(SOURCE_CATEGORY_REGISTRY)) {
    if (entry.source_category === "app_data" || entry.evidence_class === "communication" || entry.evidence_class === "support_context") {
      assert.equal(entry.sensitivity, "high", `${provider} carries prospect/opportunity-adjacent data and must register high`);
    }
  }
});
