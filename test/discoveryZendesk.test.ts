// zendesk-discovery-connector-v0: the contract-only local slice. These tests
// prove classification (T-002), the ticket-as-session adapter (T-003), bounded
// selector scopes and the workspace-ownership contract (T-004), and the
// declared canonical ticket-link form (R-006). They prove nothing about live
// Zendesk access — support stays contract_only until the feasibility task
// (T-001) and the dogfood run (T-008) produce receipt-backed evidence.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zendeskDiscoveryAdapter, type ZendeskTicketRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { classifyProvider, approve, approvalStates, revoke, sourceKey } from "../src/sourceIngress.js";
import { zendeskScopeValidationError } from "../src/discoveryCommand.js";

function packetFixture(): string {
  return mkdtempSync(path.join(tmpdir(), "foo-zendesk-packet-"));
}

const SOLVED_TICKET: ZendeskTicketRecord = {
  id: "4321",
  subject: "Exports fail for workspaces over 50 GB",
  status: "solved",
  solved_at: "2026-09-20T14:12:00.000Z",
  requester: { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
  assignee_display_name: "Taylor Fixture",
  brand: "Exampleton Brothers Help",
  url: "https://exampletonbros.zendesk.com/agent/tickets/4321",
  comment_access: "granted",
};

// --- T-002: the support class and the zendesk registration -------------------

test("zendesk is a registered support source, not a reused meeting classification", () => {
  const c = classifyProvider("zendesk");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "support");
  assert.equal(c.authority, "supporting");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.evidence_class, "support_context");
  assert.equal(c.model_exposure, "summary_only");
  // The support class is its own class: no meeting-transcript field is reused.
  assert.notEqual(c.evidence_class, classifyProvider("gong").evidence_class);
  assert.notEqual(c.source_category, classifyProvider("gong").source_category);
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else (V-002).
  assert.equal(classifyProvider("zendesk-oauth").registered, false);
  const unknown = classifyProvider("no-such-provider");
  assert.equal(unknown.registered, false);
  assert.equal(unknown.source_category, "unknown");
  assert.equal(unknown.authority, "context_only");
  assert.equal(unknown.sensitivity, "high");
  assert.equal(unknown.evidence_class, "context_only");
  assert.equal(unknown.model_exposure, "summary_only");
});

// --- T-003: the ticket-as-session adapter (D-001) ----------------------------

test("a solved ticket normalizes to the shared session contract with no raw fields surviving", () => {
  const normalized = zendeskDiscoveryAdapter.normalizeSession(SOLVED_TICKET, "company");
  assertNormalizedSessionShape(normalized);
  assert.equal(normalized.provider, "zendesk");
  assert.equal(normalized.connection_alias, "company");
  assert.equal(normalized.runtime_handle, "4321");
  assert.equal(normalized.completed_at, "2026-09-20T14:12:00.000Z");
  assert.equal(normalized.completion_state, "completed");
  assert.equal(normalized.title, "Exports fail for workspaces over 50 GB");
  // Display names plus a domain-only label for the external requester: the
  // local part of the address is gone, and the assignee contributes no
  // domain label (the assignee is the company's own agent).
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture"]);
  assert.equal(normalized.stable_url, "https://exampletonbros.zendesk.com/agent/tickets/4321");
  assert.deepEqual(normalized.capabilities, { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true });
  const json = JSON.stringify(normalized);
  // The raw record's field names and the address's local part are gone (the
  // hint-source tags like "zendesk:requester" are provenance labels by
  // design, matching the gong adapter's "gong:party"); the domain-only
  // participant label is the surviving trace by design.
  assert.doesNotMatch(json, /"requester"|"assignee_display_name"|"comment_access"|"solved_at"|"brand"|chris@/);
});

test("contact hints come only from the requester — the assignee is company staff, the raw email dies in the adapter", () => {
  const hints = zendeskDiscoveryAdapter.normalizeSession(SOLVED_TICKET, "company").contact_hints ?? [];
  assert.deepEqual(hints, [
    { field: "full_name", value: "Chris Exampleton", source: "zendesk:requester" },
    { field: "company", value: "Exampletonbros", source: "zendesk:requester_email_domain" },
  ]);
  assert.ok(!hints.some((hint) => hint.value === "Taylor Fixture"));
});

test("unsolved tickets never normalize to completed, and solved/closed is the completed evidence set (D-001)", () => {
  for (const status of ["new", "open", "pending", "hold"]) {
    const session = zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, status }, "company");
    assert.equal(session.completion_state, "in_progress", status);
  }
  for (const status of ["solved", "closed"]) {
    const session = zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, status }, "company");
    assert.equal(session.completion_state, "completed", status);
    assert.equal(session.completed_at, "2026-09-20T14:12:00.000Z");
  }
  // A solved-class ticket with no observed solved time is not honestly
  // completed: nothing may claim a completion instant productfoo never observed.
  const withoutSolvedAt = zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, solved_at: undefined }, "company");
  assert.equal(withoutSolvedAt.completion_state, "in_progress");
});

test("comment access is observed, never assumed: an absent or missing grant fails closed (R-005)", () => {
  const { comment_access: _omit, ...withoutGrant } = SOLVED_TICKET;
  assert.equal(zendeskDiscoveryAdapter.normalizeSession(withoutGrant, "company").capabilities.open_transcript, false);
  assert.equal(zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, comment_access: "missing" }, "company").capabilities.open_transcript, false);
  assert.equal(zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, comment_access: "missing" }, "company").capabilities.timestamps, false);
});

test("a ticket without a usable link carries no stable_url, and an off-form link is refused rather than cleaned", () => {
  const { url: _omit, ...unlinked } = SOLVED_TICKET;
  assert.equal(zendeskDiscoveryAdapter.normalizeSession(unlinked, "company").stable_url, undefined);
  assert.equal(zendeskDiscoveryAdapter.normalizeSession(unlinked, "company").capabilities.stable_link, false);
  assert.throws(() => zendeskDiscoveryAdapter.normalizeSession({ ...SOLVED_TICKET, url: "https://exampletonbros.zendesk.com/agent/tickets/4321?token=secret" }, "company"));
});

// --- R-006: the declared canonical ticket-link form --------------------------

test("Zendesk canonical ticket links are path-based and accepted with subdomain handling", () => {
  assert.equal(sanitizeDiscoveryStableUrl("zendesk", "https://exampletonbros.zendesk.com/agent/tickets/4321"), "https://exampletonbros.zendesk.com/agent/tickets/4321");
  // One workspace subdomain label, exactly like the gong form's one label.
  assert.equal(sanitizeDiscoveryStableUrl("zendesk", "https://acme.zendesk.com/agent/tickets/987654"), "https://acme.zendesk.com/agent/tickets/987654");
  // Hostname case is normalized; the identifier is preserved as-is.
  assert.equal(sanitizeDiscoveryStableUrl("zendesk", "https://ExampletonBros.Zendesk.com/agent/tickets/4321"), "https://exampletonbros.zendesk.com/agent/tickets/4321");
});

test("Zendesk links outside the canonical form are refused, never cleaned; other providers keep their own rules", () => {
  const refused = [
    "https://exampletonbros.zendesk.com/agent/tickets/4321?token=secret",
    "https://exampletonbros.zendesk.com/agent/tickets/4321?auth=jwt",
    "https://exampletonbros.zendesk.com/agent/tickets/",
    "https://exampletonbros.zendesk.com/agent/tickets/not-a-number",
    "https://exampletonbros.zendesk.com/requests/4321",
    "https://exampletonbros.zendesk.com/agent/tickets/4321/deep/nested",
    "https://exampletonbros.zendesk.com/agent/tickets/4321#note-3",
    "https://user:pw@exampletonbros.zendesk.com/agent/tickets/4321",
    "http://exampletonbros.zendesk.com/agent/tickets/4321",
    "https://zendesk.com/agent/tickets/4321",
    "https://evil.exampletonbros.zendesk.com.example/agent/tickets/4321",
    "https://a.b.zendesk.com/agent/tickets/4321",
  ];
  for (const url of refused) assert.throws(() => sanitizeDiscoveryStableUrl("zendesk", url), url);
  // A tokenized link is refused, never cleaned.
  assert.throws(() => sanitizeDiscoveryStableUrl("zendesk", "https://exampletonbros.zendesk.com/agent/tickets/4321?token=secret"), /query string/);
  // No declared form exists for providers that keep the exact-host rule.
  assert.equal(sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc"), "https://app.granola.ai/meeting/abc");
});

// --- T-004: bounded selector scopes (R-004) ----------------------------------

test("a zendesk scope needs a bounded window plus at least one customer selector; a window alone is never enough", () => {
  const window = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" };
  assert.match(zendeskScopeValidationError({ window }) ?? "", /customer selector/);
  // Each selector kind alone satisfies the rule.
  assert.equal(zendeskScopeValidationError({ window, external_domains: ["exampletonbros.example"] }), null);
  assert.equal(zendeskScopeValidationError({ window, organizations: ["Exampleton Brothers"] }), null);
  assert.equal(zendeskScopeValidationError({ window, brands: ["Exampleton Brothers Help"] }), null);
  // Empty-string selectors are not selectors.
  assert.match(zendeskScopeValidationError({ window, external_domains: [""] }) ?? "", /customer selector/);
  // Window rules: valid bounds, end after start.
  assert.match(zendeskScopeValidationError({ window: { start: "2026-09-01T00:00:00.000Z" }, external_domains: ["a.com"] }) ?? "", /time window/);
  assert.match(zendeskScopeValidationError({ window: { start: window.end, end: window.start }, external_domains: ["a.com"] }) ?? "", /end after it starts/);
});

test("internal and agent-only tickets are excluded by default and a scope cannot opt in", () => {
  const window = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" };
  assert.match(
    zendeskScopeValidationError({ window, external_domains: ["exampletonbros.example"], include_internal_only: true }) ?? "",
    /internal/,
  );
  assert.equal(zendeskScopeValidationError({ window, external_domains: ["exampletonbros.example"], include_internal_only: false }), null);
});

// --- T-004: the workspace-ownership contract (R-010/D-002) --------------------

test("the ledger approves and revokes a workspace-scoped zendesk connection unchanged", () => {
  const packetDir = packetFixture();
  try {
    // The workspace-owned identity per the gong ruling direction: tenant-scoped
    // connection id, provider-pinned, on the substrate's existing SourceId.
    const sourceId = { ingress_path: "nango" as const, provider: "zendesk", connection_id: "ws_foo_inc/zendesk-exampleton" };
    approve(packetDir, sourceId, { packet: "zendesk-discovery-connector-v0", scope: "scope:zendesk_exampleton_q3", by: "taylor", at: "2026-09-24T00:00:00.000Z" });
    const approved = approvalStates(packetDir).get(sourceKey(sourceId));
    assert.equal(approved?.state, "approved");
    // The accountable administrator revoking through the ledger clears the
    // approval — workspace-owned, not the connecting person's private source.
    revoke(packetDir, sourceId, { packet: "zendesk-discovery-connector-v0", by: "taylor", at: "2026-09-24T00:01:00.000Z" });
    assert.equal(approvalStates(packetDir).get(sourceKey(sourceId))?.state, "revoked");
  } finally {
    rmSync(packetDir, { recursive: true, force: true });
  }
});
