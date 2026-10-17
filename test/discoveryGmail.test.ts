// gmail-discovery-connector-v0: the contract-only local slice. These tests
// prove classification (T-002), normalization (T-003), scope composition and
// ownership honesty (T-004), and the admissibility + link rules (T-005). They
// prove nothing about live Gmail access — support stays contract_only until
// the feasibility report (T-001) and a real per-user dogfood run (T-008).
import assert from "node:assert/strict";
import test from "node:test";
import { gmailScopeValidationError } from "../src/discoveryCommand.js";
import { gmailDiscoveryAdapter, gmailThreadAdmissibility, type GmailThreadRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { classifyProvider } from "../src/sourceIngress.js";

// --- T-002: registry --------------------------------------------------------

test("gmail is a registered email source with its own communication class", () => {
  const c = classifyProvider("gmail");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "email");
  assert.equal(c.authority, "supporting");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.model_exposure, "summary_only");
  // The email class is its own lane: meeting-transcript classification is
  // never reused for mail (R-002).
  assert.notEqual(c.source_category, classifyProvider("gong").source_category);
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("gmail-api").registered, false);
  // outlook registers into the SAME email class (outlook-discovery-connector-v0
  // R-002) — the assertion becomes "shares the class", not "is unregistered".
  assert.deepEqual(
    { source_category: classifyProvider("outlook").source_category, evidence_class: classifyProvider("outlook").evidence_class, model_exposure: classifyProvider("outlook").model_exposure },
    { source_category: c.source_category, evidence_class: c.evidence_class, model_exposure: c.model_exposure },
  );
  assert.equal(classifyProvider("mailinator").registered, false);
});

// --- T-003: adapter normalization -------------------------------------------

// The provider fixture: a settled external thread with the body scope granted
// and the believed web URL attached — the URL shape T-001 owns verifying, so
// normalization must drop it rather than store it (R-006).
const FIXTURE: GmailThreadRecord = {
  thread_id: "th_ext_exampleton",
  snippet_subject: "Workshop follow-up",
  last_message_at: "2026-07-17T12:00:00Z",
  participants: [
    { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
    { display_name: "Taylor Fixture", email: "taylor@foo.example" },
  ],
  labels: ["Label_1"],
  url: "https://mail.google.com/mail/u/0/#inbox/th_ext_exampleton",
  quiet_period_ends_at: "2026-07-18T00:00:00Z",
  mailbox_owner_email: "taylor@foo.example",
  body_access: "granted",
};

test("the gmail fixture passes the unchanged normalized-session contract", () => {
  const session = gmailDiscoveryAdapter.normalizeSession(FIXTURE, "company");
  assertNormalizedSessionShape(session);
  assert.equal(session.provider, "gmail");
  assert.equal(session.runtime_handle, "th_ext_exampleton");
  assert.equal(session.connection_alias, "company");
  assert.equal(session.completed_at, "2026-07-17T12:00:00.000Z");
  assert.equal(session.title, "Workshop follow-up");
});

test("raw emails, raw keys, and the believed URL die in the adapter", () => {
  const session = gmailDiscoveryAdapter.normalizeSession(FIXTURE, "company");
  const serialized = JSON.stringify(session);
  // R-005: the local part of every address is discarded; the domain-only
  // label survives, the mailbox owner's own domain yields no label at all.
  assert.ok(!serialized.includes("chris@"), "the customer's local part survived");
  assert.ok(!serialized.includes("taylor@"), "the owner's address survived");
  assert.ok(!serialized.includes("foo.example"), "the internal domain survived");
  assert.ok(serialized.includes("@exampletonbros.example"), "the external domain label is the selector vocabulary");
  assert.ok(!serialized.includes("mail.google.com"), "the believed URL survived normalization");
  assert.equal(session.stable_url, undefined);
  // The owner's display name participates honestly; their domain label is
  // suppressed (the internal domain yields no label), and no address of
  // anyone survives.
  assert.deepEqual(session.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture"]);
  // Contact hints keep display name and domain, never the address.
  for (const hint of session.contact_hints ?? []) assert.ok(!String(hint.value).includes("@") || String(hint.value).startsWith("@"), `hint ${hint.field}=${hint.value} carries a raw address`);
});

test("open_transcript is observed from the connection, never assumed", () => {
  assert.equal(gmailDiscoveryAdapter.normalizeSession(FIXTURE, "company").capabilities.open_transcript, true);
  const missing: GmailThreadRecord = { ...FIXTURE, body_access: "missing" };
  assert.equal(gmailDiscoveryAdapter.normalizeSession(missing, "company").capabilities.open_transcript, false);
  const without: GmailThreadRecord = { thread_id: "t", snippet_subject: "s", last_message_at: "2026-07-17T12:00:00Z" };
  assert.equal(gmailDiscoveryAdapter.normalizeSession(without, "company").capabilities.open_transcript, false);
});

// --- T-004: scope composition -------------------------------------------------

const WINDOW = { start: "2026-07-06T00:00:00Z", end: "2026-07-20T00:00:00Z" };
const SELECTED = { window: WINDOW, labels: ["workshop"], external_domains: ["exampletonbros.example"], external_names: [], include_internal_only: false as const };

test("forbidden gmail scope shapes are invalid: no window, no label, no customer selector, internal included", () => {
  // The mailbox itself is never a scope (R-004): a window without labels is
  // a mailbox-wide read even with a selector.
  assert.match(gmailScopeValidationError({ ...SELECTED, labels: [] })!, /explicit Gmail label/);
  // A label without a customer selector reads a whole label.
  assert.match(gmailScopeValidationError({ ...SELECTED, external_domains: [], external_names: [] })!, /customer selector/);
  assert.match(gmailScopeValidationError({ ...SELECTED, external_domains: [], external_names: ["  "] })!, /customer selector/);
  // A window is mandatory and must be ordered.
  assert.match(gmailScopeValidationError({ ...SELECTED, window: undefined as unknown as typeof WINDOW })!, /bounded time window/);
  assert.match(gmailScopeValidationError({ ...SELECTED, window: { start: WINDOW.end, end: WINDOW.start } })!, /end after it starts/);
  // The internal mailbox is never includable.
  assert.match(gmailScopeValidationError({ ...SELECTED, include_internal_only: true })!, /internal mailbox/);
  // The valid shape: labels + window + one selector.
  assert.equal(gmailScopeValidationError(SELECTED), null);
  assert.equal(gmailScopeValidationError({ ...SELECTED, external_domains: [], external_names: ["Chris Exampleton"] }), null);
});

// --- T-005: admissibility and link form --------------------------------------

test("admissibility: the quiet-period boundary decides, the done label overrides, and an unsettled thread stays in_progress", () => {
  const settled: Pick<GmailThreadRecord, "last_message_at" | "labels" | "quiet_period_ends_at"> = { last_message_at: "2026-07-17T12:00:00Z", labels: [], quiet_period_ends_at: "2026-07-18T00:00:00Z" };
  assert.equal(gmailThreadAdmissibility(settled), "completed");
  // On the boundary is not yet settled: strictly-before is the rule.
  assert.equal(gmailThreadAdmissibility({ ...settled, last_message_at: "2026-07-18T00:00:00Z" }), "in_progress");
  assert.equal(gmailThreadAdmissibility({ ...settled, last_message_at: "2026-07-19T23:00:00Z" }), "in_progress");
  // The done-label override applies regardless of recency.
  assert.equal(gmailThreadAdmissibility({ ...settled, last_message_at: "2026-07-19T23:00:00Z", labels: ["done"] }), "completed");
  assert.equal(gmailThreadAdmissibility({ ...settled, labels: ["Done"] }), "completed");
  // No boundary stamped and no done label — never guessed.
  assert.equal(gmailThreadAdmissibility({ ...settled, quiet_period_ends_at: undefined }), "in_progress");
});

test("R-006: with no declared link form, gmail URLs are refused in every shape, and declared providers still sanitize", () => {
  for (const url of [
    "https://mail.google.com/mail/u/0/#inbox/th_ext_exampleton", // fragment form
    "https://mail.google.com/mail/u/0/?thread_id=th_ext_exampleton", // query form
  ]) {
    assert.throws(() => sanitizeDiscoveryStableUrl("gmail", url), `gmail url accepted: ${url}`);
  }
  // Other providers are unchanged: a declared form still sanitizes, and the
  // gmail refusals come from gmail's own absence, not a global break.
  assert.doesNotThrow(() => sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=7782342274025937895"));
});
