import assert from "node:assert/strict";
import test from "node:test";
import { fakeDiscoveryAdapter, gongDiscoveryAdapter, granolaDiscoveryAdapter, teamsDiscoveryAdapter, type FakeCallsRecord, type GongCallRecord, type GranolaMeetingRecord, type TeamsMeetingRecord } from "../src/discoveryProviders.js";
import type { DiscoverySourceAdapter } from "../src/discoverySources.js";

function contract<TRaw>(adapter: DiscoverySourceAdapter<TRaw>, raw: TRaw): void {
  test(`${adapter.provider} satisfies the provider-neutral session contract`, () => {
    const normalized = adapter.normalizeSession(raw, "primary");
    assert.equal(normalized.schema_version, "0.1");
    assert.equal(normalized.provider, adapter.provider);
    assert.equal(normalized.connection_alias, "primary");
    assert.equal(normalized.completion_state, "completed");
    assert.ok(normalized.runtime_handle);
    assert.ok(normalized.title);
    assert.ok(normalized.completed_at.endsWith("Z"));
    assert.ok(normalized.capabilities.list_sessions);
    assert.ok(normalized.capabilities.open_transcript);
  });
}

const GRANOLA: GranolaMeetingRecord = {
  id: "granola-private-id",
  title: "Shape Up workflow",
  datetime: "2026-07-20T16:00:00.000Z",
  attendees: [{ name: "Casey Sample" }],
  url: "https://app.granola.ai/meeting/abc",
  status: "completed",
  transcript_access: "granted",
};

const FAKE: FakeCallsRecord = {
  key: "fake-private-id",
  ended: "2026-07-20T16:00:00.000Z",
  subject: "Shape Up workflow",
  people: { labels: ["Casey Sample"] },
  review_link: "https://review.fakecalls.test/c/9",
  done: true,
  transcript_available: true,
};

// gong-discovery-connector-v0 T-003: the Gong fixture passes the SAME contract
// suite, unchanged. Its own behavior lives in test/discoveryGong.test.ts.
const GONG: GongCallRecord = {
  id: "7782342274025937895",
  title: "Shape Up workflow",
  started: "2026-07-20T15:30:00.000Z",
  duration_seconds: 1800,
  state: "completed",
  parties: [{ name: "Casey Sample", affiliation: "external" }],
  transcript_access: "granted",
};

contract(granolaDiscoveryAdapter, GRANOLA);
contract(fakeDiscoveryAdapter, FAKE);
contract(gongDiscoveryAdapter, GONG);

// microsoft-teams-discovery-connector-v0 T-003: the Teams fixture passes the
// SAME contract suite, unchanged. Its own behavior lives in
// test/discoveryTeams.test.ts.
const TEAMS: TeamsMeetingRecord = {
  meeting_id: "MSltYjAzNjRiZC1kZGZlLTQ2Y2YtYWRlOS1iZTUzNjAyNTNlNDU",
  subject: "Shape Up workflow",
  start_time: "2026-07-20T15:30:00.000Z",
  end_time: "2026-07-20T16:00:00.000Z",
  state: "completed",
  organizer_display_name: "Taylor Fixture",
  attendees: [{ display_name: "Casey Sample", email: "chris@exampletonbros.example" }, { display_name: "Taylor Fixture" }],
  transcript_available: true,
};

contract(teamsDiscoveryAdapter, TEAMS);

test("Granola raw payload keys stay in the adapter and normalize to the shared model", () => {
  const normalized = granolaDiscoveryAdapter.normalizeSession(GRANOLA, "primary");
  assert.deepEqual(normalized.participants, ["Casey Sample"]);
  assert.equal(normalized.stable_url, "https://app.granola.ai/meeting/abc");
  assert.doesNotMatch(JSON.stringify(normalized), /attendees|datetime/);
});

test("Granola derives its stable note link from a UUID when the connector omits url", () => {
  const normalized = granolaDiscoveryAdapter.normalizeSession({
    ...GRANOLA,
    id: "85dcd97c-8924-4ad8-baa6-8166457180b6",
    url: undefined,
  }, "primary");
  assert.equal(normalized.stable_url, "https://notes.granola.ai/d/85dcd97c-8924-4ad8-baa6-8166457180b6");
  assert.equal(normalized.capabilities.stable_link, true);
});

// nango-discovery-connector-v0 R-004 (the Gong treatment): transcript access is
// observed per record, and absence fails closed — a fixture cannot manufacture
// it by omission or by an unrecognized value.
test("Granola fails transcript capability closed when access is absent or missing", () => {
  const absent = granolaDiscoveryAdapter.normalizeSession({ ...GRANOLA, transcript_access: undefined }, "primary");
  assert.equal(absent.capabilities.open_transcript, false);
  const missing = granolaDiscoveryAdapter.normalizeSession({ ...GRANOLA, transcript_access: "missing" }, "primary");
  assert.equal(missing.capabilities.open_transcript, false);
  // Listing stays available; only the transcript read degrades.
  assert.equal(absent.capabilities.list_sessions, true);
});

test("fakecalls fails transcript capability closed when availability is absent", () => {
  const absent = fakeDiscoveryAdapter.normalizeSession({ ...FAKE, transcript_available: undefined }, "primary");
  assert.equal(absent.capabilities.open_transcript, false);
  assert.equal(absent.capabilities.list_sessions, true);
});

// discovery-contact-capture-v0 R-003/R-004: attendee metadata becomes contact
// hints; the raw email dies in the adapter and only its DOMAIN survives as a
// company candidate.
test("Granola attendee metadata yields contact hints — name+company from display strings, company from email domain, title and linkedin only when carried", () => {
  const normalized = granolaDiscoveryAdapter.normalizeSession({
    ...GRANOLA,
    attendees: [
      { name: "Chris Exampleton from Exampleton Brothers", email: "chris@exampletonbros.example", title: "CEO", linkedin: "https://www.linkedin.com/in/productfoo-fixture-chris-exampleton" },
      { name: "Taylor Fixture" },
    ],
  }, "primary");
  const hints = normalized.contact_hints ?? [];
  assert.deepEqual(hints.find((hint) => hint.field === "full_name" && hint.value === "Chris Exampleton"), { field: "full_name", value: "Chris Exampleton", source: "granola:attendee" });
  assert.deepEqual(hints.find((hint) => hint.field === "company" && hint.value === "Exampleton Brothers"), { field: "company", value: "Exampleton Brothers", source: "granola:attendee" });
  assert.deepEqual(hints.find((hint) => hint.value === "Exampletonbros"), { field: "company", value: "Exampletonbros", source: "granola:attendee_email_domain" });
  assert.deepEqual(hints.find((hint) => hint.field === "title"), { field: "title", value: "CEO", source: "granola:attendee" });
  assert.deepEqual(hints.find((hint) => hint.field === "linkedin"), { field: "linkedin", value: "https://www.linkedin.com/in/productfoo-fixture-chris-exampleton", source: "granola:attendee" });
  assert.ok(hints.some((hint) => hint.field === "full_name" && hint.value === "Taylor Fixture"));
  // The raw address never persists anywhere in the normalized session (R-004).
  assert.doesNotMatch(JSON.stringify(normalized), /chris@|exampletonbros\.com/);
});

test("Granola contact hints stay honest: no provider title/linkedin means no hint, free-mail domains yield nothing", () => {
  const normalized = granolaDiscoveryAdapter.normalizeSession({
    ...GRANOLA,
    attendees: [{ name: "Dana Smith", email: "dana@gmail.com" }],
  }, "primary");
  const hints = normalized.contact_hints ?? [];
  assert.deepEqual(hints, [{ field: "full_name", value: "Dana Smith", source: "granola:attendee" }]);
  assert.ok(!hints.some((hint) => hint.field === "title" || hint.field === "linkedin" || hint.field === "company"));
  // No attendee identity at all -> the field is honestly absent, not empty.
  const bare = granolaDiscoveryAdapter.normalizeSession({ ...GRANOLA, attendees: [] }, "primary");
  assert.equal(bare.contact_hints, undefined);
});
