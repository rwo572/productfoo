// outlook-discovery-connector-v0: the contract-only local slice. These tests
// prove classification (T-002), normalization (T-003), scope composition and
// ownership honesty (T-004), and the admissibility + link rules (T-005). They
// prove nothing about live Outlook access — support stays contract_only until
// the feasibility report (T-001) and a real per-user dogfood run (T-008).
import assert from "node:assert/strict";
import test from "node:test";
import { outlookScopeValidationError } from "../src/discoveryCommand.js";
import { outlookDiscoveryAdapter, outlookConversationAdmissibility, type OutlookConversationRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { classifyProvider } from "../src/sourceIngress.js";

// --- T-002: registry --------------------------------------------------------

test("outlook registers into the existing email class without forking it", () => {
  const c = classifyProvider("outlook");
  const g = classifyProvider("gmail");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "email");
  assert.equal(c.authority, "supporting");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.model_exposure, "summary_only");
  // The class is shared, not forked (R-002): every value equals Gmail's, so
  // the email lane stays one lane. Meeting-transcript classification is never
  // reused for mail.
  assert.deepEqual(c, g);
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("outlook-web").registered, false);
  assert.equal(classifyProvider("mailinator").registered, false);
});

// --- T-003: adapter normalization -------------------------------------------

// The provider fixture: a settled external conversation with the body scope
// granted and the believed Graph web URL attached — the URL shape T-001 owns
// verifying, so normalization must drop it rather than store it (R-006).
const FIXTURE: OutlookConversationRecord = {
  conversation_id: "AAQkADk2",
  subject: "Workshop follow-up",
  last_message_at: "2026-07-17T12:00:00Z",
  participants: [
    { display_name: "Chris Exampleton", smtp: "chris@exampletonbros.example" },
    { display_name: "Taylor Fixture", smtp: "taylor@foo.example" },
  ],
  folders: ["Inbox"],
  url: "https://outlook.office.com/mail/deeplink/read/AQQkADk2",
  quiet_period_ends_at: "2026-07-18T00:00:00Z",
  mailbox_owner_email: "taylor@foo.example",
  body_access: "granted",
};

test("the outlook fixture passes the unchanged normalized-session contract", () => {
  const session = outlookDiscoveryAdapter.normalizeSession(FIXTURE, "company");
  assertNormalizedSessionShape(session);
  assert.equal(session.provider, "outlook");
  assert.equal(session.runtime_handle, "AAQkADk2");
  assert.equal(session.connection_alias, "company");
  assert.equal(session.completed_at, "2026-07-17T12:00:00.000Z");
  assert.equal(session.title, "Workshop follow-up");
});

test("raw smtp addresses, raw Graph keys, folders, and the believed URL die in the adapter", () => {
  const session = outlookDiscoveryAdapter.normalizeSession(FIXTURE, "company");
  const serialized = JSON.stringify(session);
  // R-005: the local part of every address is discarded; the domain-only
  // label survives, the mailbox owner's own domain yields no label at all,
  // and the conversation's folder set (scope vocabulary) is not stored.
  assert.ok(!serialized.includes("chris@"), "the customer's local part survived");
  assert.ok(!serialized.includes("taylor@"), "the owner's address survived");
  assert.ok(!serialized.includes("foo.example"), "the internal domain survived");
  assert.ok(serialized.includes("@exampletonbros.example"), "the external domain label is the selector vocabulary");
  assert.ok(!serialized.includes("Inbox"), "the conversation's folder set survived normalization");
  assert.ok(!serialized.includes("outlook.office.com"), "the believed URL survived normalization");
  assert.equal(session.stable_url, undefined);
  // The owner's display name participates honestly; their domain label is
  // suppressed (the internal domain yields no label), and no address of
  // anyone survives.
  assert.deepEqual(session.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture"]);
  // Contact hints keep display name and domain, never the address.
  for (const hint of session.contact_hints ?? []) assert.ok(!String(hint.value).includes("@") || String(hint.value).startsWith("@"), `hint ${hint.field}=${hint.value} carries a raw address`);
});

test("open_transcript is observed from the connection, never assumed", () => {
  assert.equal(outlookDiscoveryAdapter.normalizeSession(FIXTURE, "company").capabilities.open_transcript, true);
  const missing: OutlookConversationRecord = { ...FIXTURE, body_access: "missing" };
  assert.equal(outlookDiscoveryAdapter.normalizeSession(missing, "company").capabilities.open_transcript, false);
  const without: OutlookConversationRecord = { conversation_id: "c", subject: "s", last_message_at: "2026-07-17T12:00:00Z" };
  assert.equal(outlookDiscoveryAdapter.normalizeSession(without, "company").capabilities.open_transcript, false);
});

// --- T-004: scope composition -------------------------------------------------

const WINDOW = { start: "2026-07-06T00:00:00Z", end: "2026-07-20T00:00:00Z" };
const SELECTED = { window: WINDOW, folders: ["Inbox"], external_domains: ["exampletonbros.example"], external_names: [], include_internal_only: false as const };

test("forbidden outlook scope shapes are invalid: no window, no folder, no customer selector, internal included", () => {
  // The mailbox itself is never a scope (R-004): a window without folders is
  // a mailbox-wide read even with a selector.
  assert.match(outlookScopeValidationError({ ...SELECTED, folders: [] })!, /explicit Outlook folder/);
  // A folder without a customer selector reads a whole folder.
  assert.match(outlookScopeValidationError({ ...SELECTED, external_domains: [], external_names: [] })!, /customer selector/);
  assert.match(outlookScopeValidationError({ ...SELECTED, external_domains: [], external_names: ["  "] })!, /customer selector/);
  // A window is mandatory and must be ordered.
  assert.match(outlookScopeValidationError({ ...SELECTED, window: undefined as unknown as typeof WINDOW })!, /bounded time window/);
  assert.match(outlookScopeValidationError({ ...SELECTED, window: { start: WINDOW.end, end: WINDOW.start } })!, /end after it starts/);
  // The internal mailbox is never includable.
  assert.match(outlookScopeValidationError({ ...SELECTED, include_internal_only: true })!, /internal mailbox/);
  // The valid shape: folders + window + one selector.
  assert.equal(outlookScopeValidationError(SELECTED), null);
  assert.equal(outlookScopeValidationError({ ...SELECTED, external_domains: [], external_names: ["Chris Exampleton"] }), null);
});

// --- T-005: admissibility and link form --------------------------------------

test("admissibility: the quiet-period boundary decides, the done category overrides, and an unsettled conversation stays in_progress", () => {
  const settled: Pick<OutlookConversationRecord, "last_message_at" | "categories" | "quiet_period_ends_at"> = { last_message_at: "2026-07-17T12:00:00Z", categories: [], quiet_period_ends_at: "2026-07-18T00:00:00Z" };
  assert.equal(outlookConversationAdmissibility(settled), "completed");
  // On the boundary is not yet settled: strictly-before is the rule.
  assert.equal(outlookConversationAdmissibility({ ...settled, last_message_at: "2026-07-18T00:00:00Z" }), "in_progress");
  assert.equal(outlookConversationAdmissibility({ ...settled, last_message_at: "2026-07-19T23:00:00Z" }), "in_progress");
  // The done-category override applies regardless of recency.
  assert.equal(outlookConversationAdmissibility({ ...settled, last_message_at: "2026-07-19T23:00:00Z", categories: ["done"] }), "completed");
  assert.equal(outlookConversationAdmissibility({ ...settled, categories: ["Done"] }), "completed");
  // No boundary stamped and no done category — never guessed.
  assert.equal(outlookConversationAdmissibility({ ...settled, quiet_period_ends_at: undefined }), "in_progress");
});

test("R-006: with no declared link form, outlook Graph web links are refused in every shape, and declared providers still sanitize", () => {
  for (const url of [
    "https://outlook.office.com/mail/deeplink/read/AQQkADk2", // tokenized path form
    "https://outlook.office365.com/mail/inbox/AQQkADk2?query=workshop", // path + query form
  ]) {
    assert.throws(() => sanitizeDiscoveryStableUrl("outlook", url), `outlook url accepted: ${url}`);
  }
  // Other providers are unchanged: a declared form still sanitizes, and the
  // outlook refusals come from outlook's own absence, not a global break.
  assert.doesNotThrow(() => sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=7782342274025937895"));
});
