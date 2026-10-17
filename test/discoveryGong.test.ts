// gong-discovery-connector-v0: the contract-only local slice. These tests
// prove classification (T-002), normalization (T-003), and the declared
// canonical link form (T-004). They prove nothing about live Gong access —
// support stays contract_only until the feasibility task and dogfood run.
import assert from "node:assert/strict";
import test from "node:test";
import { gongDiscoveryAdapter, type GongCallRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, providerLinkForm, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { classifyProvider } from "../src/sourceIngress.js";

const GONG: GongCallRecord = {
  id: "7782342274025937895",
  title: "Discovery call — Exampleton Brothers",
  started: "2026-09-01T16:00:00.000Z",
  duration_seconds: 1800,
  state: "completed",
  parties: [
    { name: "Chris Exampleton", email: "chris@exampletonbros.example", title: "CEO", affiliation: "external", speaker_id: "spk-1" },
    { name: "Taylor Fixture", email: "taylor@example.com", title: "AE", affiliation: "internal", speaker_id: "spk-2" },
  ],
  transcript_access: "granted",
};

// --- T-002: registry --------------------------------------------------------

test("gong is a registered meeting_transcript source with the Granola classification", () => {
  const c = classifyProvider("gong");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "meeting_transcript");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.model_exposure, "summary_only");
  assert.deepEqual({ ...classifyProvider("granola"), registered: undefined }, { ...c, registered: undefined });
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("gong-oauth").registered, false);
});

// --- T-003: adapter ---------------------------------------------------------

test("Gong raw payload keys stay in the adapter and normalize to the shared model", () => {
  const normalized = gongDiscoveryAdapter.normalizeSession(GONG, "company");
  assertNormalizedSessionShape(normalized);
  assert.equal(normalized.provider, "gong");
  assert.equal(normalized.connection_alias, "company");
  assert.equal(normalized.runtime_handle, "7782342274025937895");
  assert.equal(normalized.completed_at, "2026-09-01T16:30:00.000Z");
  assert.equal(normalized.completion_state, "completed");
  // Names plus a domain-only label for the external party: the local part of
  // the address is gone, and the internal rep contributes no domain label.
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture"]);
  assert.equal(normalized.stable_url, "https://app.gong.io/call?id=7782342274025937895");
  assert.deepEqual(normalized.capabilities, { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true });
  const json = JSON.stringify(normalized);
  assert.doesNotMatch(json, /parties|speaker_id|spk-|affiliation|duration_seconds|started|transcript_access/);
  assert.doesNotMatch(json, /chris@|taylor@|example\.com/);
});

test("Gong contact hints come only from external parties; the rep contributes none and the raw email dies in the adapter", () => {
  const hints = gongDiscoveryAdapter.normalizeSession(GONG, "company").contact_hints ?? [];
  assert.deepEqual(hints, [
    { field: "full_name", value: "Chris Exampleton", source: "gong:party" },
    { field: "company", value: "Exampletonbros", source: "gong:party_email_domain" },
    { field: "title", value: "CEO", source: "gong:party" },
  ]);
  assert.ok(!hints.some((hint) => hint.value === "Taylor Fixture" || hint.value === "AE"));
});

test("Gong transcript access is observed, never assumed: an absent grant fails closed", () => {
  const { transcript_access: _omit, ...withoutGrant } = GONG;
  const normalized = gongDiscoveryAdapter.normalizeSession(withoutGrant, "company");
  assert.equal(normalized.capabilities.open_transcript, false);
  assert.equal(gongDiscoveryAdapter.normalizeSession({ ...GONG, transcript_access: "missing" }, "company").capabilities.open_transcript, false);
});

test("Gong completion falls back honestly: an explicit end wins, an unknown state is in_progress, a bad id yields no link", () => {
  const ended = gongDiscoveryAdapter.normalizeSession({ ...GONG, ended: "2026-09-01T16:42:00.000Z" }, "company");
  assert.equal(ended.completed_at, "2026-09-01T16:42:00.000Z");
  assert.equal(gongDiscoveryAdapter.normalizeSession({ ...GONG, state: "processing" }, "company").completion_state, "in_progress");
  const noLink = gongDiscoveryAdapter.normalizeSession({ ...GONG, id: "id with spaces" }, "company");
  assert.equal(noLink.stable_url, undefined);
  assert.equal(noLink.capabilities.stable_link, false);
});

// --- T-004: declared canonical link form -----------------------------------

test("Gong canonical call links are accepted in exactly one declared form", () => {
  assert.ok(providerLinkForm("gong"));
  assert.equal(sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=7782342274025937895"), "https://app.gong.io/call?id=7782342274025937895");
  // A company subdomain of app.gong.io is the same form.
  assert.equal(sanitizeDiscoveryStableUrl("gong", "https://acme.app.gong.io/call?id=abc_123"), "https://acme.app.gong.io/call?id=abc_123");
  // Hostname case is normalized; the identifier is preserved as-is.
  assert.equal(sanitizeDiscoveryStableUrl("gong", "https://APP.GONG.IO/call?id=AbC-9"), "https://app.gong.io/call?id=AbC-9");
});

test("Gong links outside the declared form are refused, never partially cleaned", () => {
  const refused = [
    "https://app.gong.io/call?id=7782342274025937895&token=secret",
    "https://app.gong.io/call?token=secret",
    "https://app.gong.io/call?callId=7782342274025937895",
    "https://app.gong.io/call",
    "https://app.gong.io/calls?id=7782342274025937895",
    "https://app.gong.io/call?id=7782342274025937895#t=120",
    "https://user:pw@app.gong.io/call?id=7782342274025937895",
    "http://app.gong.io/call?id=7782342274025937895",
    "https://gong.io/call?id=7782342274025937895",
    "https://evil.app.gong.io.example/call?id=7782342274025937895",
    "https://a.b.app.gong.io/call?id=7782342274025937895",
    "https://app.gong.io/call?id=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz", // foo-redact: allow — synthetic JWT fixture (same example token as redactEngine.test.ts)
    "https://app.gong.io/call?id=x",
  ];
  for (const url of refused) assert.throws(() => sanitizeDiscoveryStableUrl("gong", url), url);
});

test("Providers without a declared form keep the global no-query rule byte-for-byte", () => {
  assert.equal(providerLinkForm("granola"), undefined);
  assert.equal(sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc"), "https://app.granola.ai/meeting/abc");
  assert.equal(sanitizeDiscoveryStableUrl("fakecalls", "https://review.fakecalls.test/c/9"), "https://review.fakecalls.test/c/9");
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc?id=abc"), /query string/);
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "https://app.gong.io/call?id=7782342274025937895"), /query string/);
});
