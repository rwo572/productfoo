// zoom-discovery-connector-v0: the contract-only local slice. These tests
// prove classification (T-002), normalization (T-003), and the stable-link
// rules (T-004). They prove nothing about live Zoom access — support stays
// contract_only until the feasibility task (T-001) and the dogfood run
// (T-010) exist with receipt-backed evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { zoomDiscoveryAdapter, type ZoomRecordingRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, providerLinkForm, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { classifyProvider } from "../src/sourceIngress.js";

const ZOOM: ZoomRecordingRecord = {
  meeting_uuid: "9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
  topic: "Discovery call — Exampleton Brothers",
  start_time: "2026-09-01T16:00:00.000Z",
  end_time: "2026-09-01T16:30:00.000Z",
  state: "completed",
  host_display_name: "Taylor Fixture",
  participants: [
    { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
    { display_name: "Taylor Fixture", email: "taylor@foo.example" },
  ],
  transcript_available: true,
  url: "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
};

// --- T-002: registry --------------------------------------------------------

test("zoom is a registered meeting_transcript source with the Granola/Gong classification", () => {
  const c = classifyProvider("zoom");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "meeting_transcript");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.model_exposure, "summary_only");
  assert.deepEqual({ ...classifyProvider("granola"), registered: undefined }, { ...c, registered: undefined });
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("zoom-us").registered, false);
  assert.equal(classifyProvider("cloud recording").registered, false);
});

// --- T-003: adapter ---------------------------------------------------------

test("Zoom raw payload keys stay in the adapter and normalize to the shared model", () => {
  const normalized = zoomDiscoveryAdapter.normalizeSession(ZOOM, "company");
  assertNormalizedSessionShape(normalized);
  assert.equal(normalized.provider, "zoom");
  assert.equal(normalized.connection_alias, "company");
  assert.equal(normalized.runtime_handle, "9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6");
  // Honest completion: the recording's own end time, not a fabricated one.
  assert.equal(normalized.completed_at, "2026-09-01T16:30:00.000Z");
  assert.equal(normalized.completion_state, "completed");
  // Names plus a domain-only label for the external party: the host (the
  // account's own person) contributes no domain label, and no address or
  // local part survives.
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture"]);
  assert.equal(normalized.stable_url, "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6");
  assert.deepEqual(normalized.capabilities, { list_sessions: true, open_transcript: true, stable_link: true, timestamps: false });
  const json = JSON.stringify(normalized);
  assert.doesNotMatch(json, /meeting_uuid|display_name|host_display_name|start_time|end_time|transcript_available|tracking/);
  assert.doesNotMatch(json, /chris@|taylor@|foo\.example/);
});

test("Zoom contact hints come only from non-host participants; the raw email dies in the adapter", () => {
  const hints = zoomDiscoveryAdapter.normalizeSession(ZOOM, "company").contact_hints ?? [];
  assert.deepEqual(hints, [
    { field: "full_name", value: "Chris Exampleton", source: "zoom:participant" },
    { field: "company", value: "Exampletonbros", source: "zoom:participant_email_domain" },
  ]);
  assert.ok(!hints.some((hint) => hint.value === "Taylor Fixture" || hint.value === "CEO"));
});

test("Zoom transcript availability is observed, never assumed: an absent flag fails closed", () => {
  const { transcript_available: _omit, ...withoutFlag } = ZOOM;
  assert.equal(zoomDiscoveryAdapter.normalizeSession(withoutFlag, "company").capabilities.open_transcript, false);
  assert.equal(zoomDiscoveryAdapter.normalizeSession({ ...ZOOM, transcript_available: false }, "company").capabilities.open_transcript, false);
});

test("Zoom completion falls back honestly: no end time means the meeting start, an unprocessed state is in_progress, a recording without a link carries none", () => {
  const noEnd = zoomDiscoveryAdapter.normalizeSession({ ...ZOOM, end_time: undefined }, "company");
  assert.equal(noEnd.completed_at, "2026-09-01T16:00:00.000Z");
  assert.equal(zoomDiscoveryAdapter.normalizeSession({ ...ZOOM, state: "recording_in_progress" }, "company").completion_state, "in_progress");
  const { url: _omit, ...withoutUrl } = ZOOM;
  const noLink = zoomDiscoveryAdapter.normalizeSession(withoutUrl, "company");
  assert.equal(noLink.stable_url, undefined);
  assert.equal(noLink.capabilities.stable_link, false);
  // The adapter builds no canonical URL from the bare UUID: the account
  // subdomain is unknown to the adapter, not assumed.
  const bare = zoomDiscoveryAdapter.normalizeSession({ ...ZOOM, url: undefined }, "company");
  assert.equal(bare.stable_url, undefined);
});

test("a host name that matches nobody leaves every participant external — nothing is assumed", () => {
  const normalized = zoomDiscoveryAdapter.normalizeSession({ ...ZOOM, host_display_name: "Somebody Else" }, "company");
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture", "@foo.example"]);
});

// --- T-004: stable-link rules ----------------------------------------------

test("Zoom canonical recording links are accepted on one account subdomain, with no declared ProviderLinkForm", () => {
  // The canonical form carries no query parameter, so no ProviderLinkForm is
  // declared — the global no-query rule applies to Zoom unchanged.
  assert.equal(providerLinkForm("zoom"), undefined);
  assert.equal(sanitizeDiscoveryStableUrl("zoom", "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6"), "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6");
  // Hostname case is normalized; the identifier is preserved as-is.
  assert.equal(sanitizeDiscoveryStableUrl("zoom", "https://FOO.ZOOM.US/recording/AbC123defG456hiJ789klMnopqrstuvwx"), "https://foo.zoom.us/recording/AbC123defG456hiJ789klMnopqrstuvwx");
});

test("Zoom links outside the canonical form are refused, never cleaned", () => {
  const refused = [
    // Tokenized share variants: credential-bearing query parameters.
    "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6?access_token=secret",
    "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6?pwd=abc123",
    // Tokenized share paths are not the canonical form.
    "https://foo.zoom.us/rec/share/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6?pwd=abc",
    "https://foo.zoom.us/recording/detail?meeting_id=9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    // Fragments, credentials, plaintext HTTP.
    "https://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6#t=120",
    "https://user:pw@foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    "http://foo.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    // Bare zoom.us, nested subdomains, lookalike hosts.
    "https://zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    "https://a.b.zoom.us/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    "https://evil.foo.zoom.us.example/recording/9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6",
    // Identifier shapes productfoo does not believe: too short, nested, empty.
    "https://foo.zoom.us/recording/x",
    "https://foo.zoom.us/recording/one/two",
    "https://foo.zoom.us/recording/",
    "https://foo.zoom.us/recording",
  ];
  for (const url of refused) assert.throws(() => sanitizeDiscoveryStableUrl("zoom", url), url);
});

test("other providers' link behavior is byte-for-byte unchanged by the Zoom rules", () => {
  assert.equal(sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=7782342274025937895"), "https://app.gong.io/call?id=7782342274025937895");
  assert.equal(sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc"), "https://app.granola.ai/meeting/abc");
  assert.equal(sanitizeDiscoveryStableUrl("fakecalls", "https://review.fakecalls.test/c/9"), "https://review.fakecalls.test/c/9");
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc?id=abc"), /query string/);
});
