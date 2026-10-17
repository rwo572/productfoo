// notion-discovery-connector-v0: the contract-only docs slice. These tests
// prove classification (T-002), explicit selection parsing (T-003), the
// canonical link form (R-006), and read-only refusal (T-005). They prove
// nothing about live Notion access — support stays contract_only until the
// receipt-backed feasibility report (T-001) and the dogfood run (T-007).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyProvider, EVIDENCE_CLASS_GLOSS, notionScopeValidationError, parseNotionScope, notionScopeAllowsSelection, approve, revoke, approvalStates, MOST_RESTRICTIVE_DEFAULT, type SourceId } from "../src/sourceIngress.js";
import { sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";

// A throwaway packet ledger per run: approvals append real ledger events.
const PACKET = path.join(mkdtempSync(path.join(tmpdir(), "foo-notion-scope-")), "packet");
mkdirSync(PACKET, { recursive: true });

function ledgerId(): SourceId {
  return { ingress_path: "nango", provider: "notion", connection_id: "workspace/notion-main" };
}

// --- T-002: the docs class and the notion registration ----------------------

test("notion is the first registered docs source with the approved_source_artifact class", () => {
  const c = classifyProvider("notion");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "docs");
  assert.equal(c.authority, "supporting");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.evidence_class, "approved_source_artifact");
  assert.equal(c.model_exposure, "summary_only");
});

test("the docs class never reuses the meeting-transcript classification", () => {
  const notion = classifyProvider("notion");
  for (const meeting of ["gong", "granola"]) {
    const c = classifyProvider(meeting);
    assert.notEqual(c.source_category, notion.source_category);
    assert.notEqual(c.evidence_class, notion.evidence_class);
    assert.equal(c.source_category, "meeting_transcript");
    assert.equal(c.evidence_class, "communication");
  }
});

test("unknown providers stay most-restrictive", () => {
  const c = classifyProvider("confluence");
  assert.deepEqual(c, MOST_RESTRICTIVE_DEFAULT);
  assert.equal(classifyProvider("").registered, false);
  assert.equal(classifyProvider("NOTION").registered, true, "classification is case-insensitive");
});

test("the approved_source_artifact class carries a human gloss (R-006: raw token never alone)", () => {
  assert.ok(EVIDENCE_CLASS_GLOSS.approved_source_artifact.includes("selected"));
  assert.ok(EVIDENCE_CLASS_GLOSS.approved_source_artifact.includes("summarized"));
});

// --- T-003: explicit page/container selection parsing (R-004) ----------------

const GOOD_SCOPE = JSON.stringify({
  page_ids: ["12345678-1234-4234-8234-123456789abc"],
  database_ids: ["87654321-4321-4432-a321-cba987654321"],
  window: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-24T00:00:00.000Z" },
});

test("a scope with explicit page and database selections parses and canonicalizes", () => {
  const scope = parseNotionScope(GOOD_SCOPE);
  assert.deepEqual(scope.page_ids, ["12345678-1234-4234-8234-123456789abc"]);
  assert.deepEqual(scope.database_ids, ["87654321-4321-4432-a321-cba987654321"]);
  assert.equal(notionScopeValidationError(GOOD_SCOPE), null);
  // Undashed UUIDs are accepted and normalized to the dashed canonical form.
  const undashed = parseNotionScope(JSON.stringify({ page_ids: ["12345678123442348234123456789abc"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } }));
  assert.deepEqual(undashed.page_ids, ["12345678-1234-4234-8234-123456789abc"]);
});

test("selector-less scopes are invalid — empty arrays, missing keys, whitespace ids", () => {
  assert.match(notionScopeValidationError("{}") ?? "", /no explicit selection/);
  assert.match(notionScopeValidationError(JSON.stringify({ page_ids: [], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } })) ?? "", /no explicit selection/);
  assert.match(notionScopeValidationError(JSON.stringify({ database_ids: ["  "], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } })) ?? "", /invalid.*identifier/i);
  assert.match(notionScopeValidationError(JSON.stringify({ page_ids: ["not-a-uuid"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } })) ?? "", /invalid.*identifier/i);
});

test("workspace-wide scopes are refused — wildcard, unknown keys, missing window", () => {
  assert.match(notionScopeValidationError("*") ?? "", /workspace-wide/i);
  assert.match(notionScopeValidationError(JSON.stringify({ workspace: true, page_ids: ["12345678-1234-4234-8234-123456789abc"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } })) ?? "", /unknown field|workspace/i);
  assert.match(notionScopeValidationError(JSON.stringify({ page_ids: ["12345678-1234-4234-8234-123456789abc"] })) ?? "", /window/);
  assert.match(notionScopeValidationError(JSON.stringify({ page_ids: ["12345678-1234-4234-8234-123456789abc"], window: { from: "2026-09-24T00:00:00Z", to: "2026-09-01T00:00:00Z" } })) ?? "", /window/);
  assert.match(notionScopeValidationError("not json at all") ?? "", /JSON/i);
});

test("selection is closed — a scope can only shrink, never widen (R-004)", () => {
  // parseNotionScope canonicalizes to exactly the approved keys: any attempt to
  // carry extra reach (all_pages, workspace, union flags) is refused above, and
  // the parsed object carries nothing but the declared selections and window.
  const scope = parseNotionScope(GOOD_SCOPE) as Record<string, unknown>;
  assert.deepEqual(Object.keys(scope).sort(), ["database_ids", "page_ids", "window"]);
});

test("a selection is admitted only by an accumulated scope that names it; * never admits docs reads", () => {
  const selection = { page_id: "12345678-1234-4234-8234-123456789abc" };
  assert.equal(notionScopeAllowsSelection(GOOD_SCOPE, selection), true);
  assert.equal(
    notionScopeAllowsSelection(
      JSON.stringify({ database_ids: ["87654321-4321-4432-a321-cba987654321"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } }),
      selection,
    ),
    false,
  );
  // The substrate wildcard grants everything EXCEPT a docs read: a
  // workspace-wide Notion listing is exactly what R-004 refuses.
  assert.equal(notionScopeAllowsSelection("*", selection), false);
  assert.equal(notionScopeAllowsSelection(undefined, selection), false);
});

test("approvals accumulate per scope and revoke cleanly, per substrate (#528)", () => {
  const id = ledgerId();
  const t0 = "2026-09-24T00:00:00.000Z";
  const pagesOnly = JSON.stringify({ page_ids: ["12345678-1234-4234-8234-123456789abc"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } });
  const dbOnly = JSON.stringify({ database_ids: ["87654321-4321-4432-a321-cba987654321"], window: { from: "2026-09-01T00:00:00Z", to: "2026-09-24T00:00:00Z" } });
  approve(PACKET, id, { packet: "notion-test", scope: pagesOnly, by: "Taylor Fixture", at: t0 });
  approve(PACKET, id, { packet: "notion-test", scope: dbOnly, by: "Taylor Fixture", at: t0 });
  const state = approvalStates(PACKET).get("notion::workspace/notion-main");
  assert.equal(state?.state, "approved");
  assert.equal(state?.scopes.length, 2);
  // Revocation clears every accumulated scope at once (substrate semantics).
  revoke(PACKET, id, { packet: "notion-test", by: "Taylor Fixture", at: t0 });
  assert.equal(approvalStates(PACKET).get("notion::workspace/notion-main")?.state, "revoked");
  assert.deepEqual(approvalStates(PACKET).get("notion::workspace/notion-main")?.scopes, []);
});

// --- R-006: canonical page links, tokenized forms refused --------------------

test("a canonical Notion page URL is accepted and kept; tokenized share links are refused", () => {
  // Canonical form derived from the page id — no query string, no fragment.
  assert.equal(sanitizeDiscoveryStableUrl("notion", "https://www.notion.so/12345678-1234-4234-8234-123456789abc"), "https://www.notion.so/12345678-1234-4234-8234-123456789abc");
  // A tokenized share link carries a query string — refused, never stored.
  assert.throws(() => sanitizeDiscoveryStableUrl("notion", "https://www.notion.so/12345678-1234-4234-8234-123456789abc?xs=secret-token"), /query string/);
  assert.throws(() => sanitizeDiscoveryStableUrl("notion", "https://www.notion.so/page?v=share-view#fragment"), /query string|fragment/);
  assert.throws(() => sanitizeDiscoveryStableUrl("notion", "https://evil.example/12345678-1234-4234-8234-123456789abc"), /approved host/);
});
