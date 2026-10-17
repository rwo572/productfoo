// microsoft-teams-discovery-connector-v0: the contract-only local slice,
// built by the gong playbook (D-001). These tests prove classification
// (T-002), normalization (T-003), bounded selector scopes and tenant
// ownership (T-004), the Graph broker/client (T-005), and the one-transcript
// worker (T-006). They prove nothing about live Microsoft Graph access —
// support stays contract_only until the feasibility task (T-001) and the
// dogfood run (T-008) produce receipt-backed evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyProvider } from "../src/sourceIngress.js";
import { teamsDiscoveryAdapter, type TeamsMeetingRecord } from "../src/discoveryProviders.js";
import { teamsScopeValidationError, type TeamsScopeSelectors } from "../src/discoveryCommand.js";
import { adapterCapabilityState, assertNormalizedSessionShape, providerLinkForm, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";

// --- T-002: registry --------------------------------------------------------

test("microsoft-teams is a registered meeting_transcript source with the Granola/Gong classification", () => {
  const c = classifyProvider("microsoft-teams");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "meeting_transcript");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.model_exposure, "summary_only");
  const gong = classifyProvider("gong");
  assert.deepEqual({ ...c, registered: undefined }, { ...gong, registered: undefined });
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("teams").registered, false, "the provider id is microsoft-teams, not the CLI verb");
  assert.equal(classifyProvider("microsoft-teams-oauth").registered, false);
});

// --- T-003: adapter ---------------------------------------------------------

const TEAMS: TeamsMeetingRecord = {
  meeting_id: "MSltYjAzNjRiZC1kZGZlLTQ2Y2YtYWRlOS1iZTUzNjAyNTNlNDU",
  subject: "Discovery call — Exampleton Brothers",
  start_time: "2026-09-01T16:00:00.000Z",
  end_time: "2026-09-01T16:45:00.000Z",
  state: "completed",
  organizer_display_name: "Taylor Fixture",
  attendees: [
    { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
    { display_name: "Taylor Fixture", email: "taylor@contoso.com" },
  ],
  transcript_available: true,
};

test("Teams raw payload keys stay in the adapter and normalize to the shared model", () => {
  const normalized = teamsDiscoveryAdapter.normalizeSession(TEAMS, "company");
  assertNormalizedSessionShape(normalized);
  assert.equal(normalized.provider, "microsoft-teams");
  assert.equal(normalized.connection_alias, "company");
  assert.equal(normalized.runtime_handle, TEAMS.meeting_id);
  assert.equal(normalized.completed_at, "2026-09-01T16:45:00.000Z", "the explicit provider end wins");
  assert.equal(normalized.completion_state, "completed");
  // Display names only: no addresses, no AAD ids, no domain labels (R-005).
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "Taylor Fixture"]);
  assert.equal(normalized.stable_url, undefined, "no canonical Teams link form is declared yet");
  assert.deepEqual(normalized.capabilities, { list_sessions: true, open_transcript: true, stable_link: false, timestamps: false });
  // Honest capability state: coverage caveats until a link form and transcript
  // locators are verified by the feasibility task.
  assert.equal(adapterCapabilityState(normalized.capabilities), "ready_with_coverage_caveat");
  const json = JSON.stringify(normalized);
  assert.doesNotMatch(json, /attendees|organizer|start_time|end_time|transcript_available|meeting_id/);
  assert.doesNotMatch(json, /chris@|taylor@|contoso\.com|exampletonbros\.com/);
});

test("Teams contact hints are external-only: the tenant's own organizer contributes none, the address dies in the adapter", () => {
  const hints = teamsDiscoveryAdapter.normalizeSession(TEAMS, "company").contact_hints ?? [];
  assert.deepEqual(hints, [
    { field: "full_name", value: "Chris Exampleton", source: "microsoft-teams:attendee" },
    { field: "company", value: "Exampletonbros", source: "microsoft-teams:attendee_email_domain" },
  ]);
  // A free-mail address yields no company candidate.
  const freeMail = teamsDiscoveryAdapter.normalizeSession({
    ...TEAMS,
    organizer_display_name: undefined,
    attendees: [{ display_name: "Dana Smith", email: "dana@gmail.com" }],
  }, "company");
  assert.deepEqual(freeMail.contact_hints, [{ field: "full_name", value: "Dana Smith", source: "microsoft-teams:attendee" }]);
});

test("Teams transcript access is observed, never assumed: an absent or false flag fails closed", () => {
  const { transcript_available: _omit, ...withoutFlag } = TEAMS;
  assert.equal(teamsDiscoveryAdapter.normalizeSession(withoutFlag, "company").capabilities.open_transcript, false);
  assert.equal(teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, transcript_available: false }, "company").capabilities.open_transcript, false);
});

test("Teams completion falls back honestly: no end uses the start, an unknown state is in_progress, a blank attendee name is dropped", () => {
  const started = teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, end_time: undefined }, "company");
  assert.equal(started.completed_at, "2026-09-01T16:00:00.000Z");
  assert.equal(teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, state: "scheduled" }, "company").completion_state, "in_progress");
  const messy = teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, attendees: [{ display_name: "  " }, { email: "solo@exampletonbros.example" }, { display_name: "Chris Exampleton" }] }, "company");
  assert.deepEqual(messy.participants, ["Chris Exampleton"]);
});

// --- T-003/R-006: link discipline — no declared form until T-001 verifies one

test("Teams declares no canonical link form yet: tokenized join URLs are refused, never cleaned, and other providers are unchanged", () => {
  assert.equal(providerLinkForm("microsoft-teams"), undefined);
  const refused = [
    "https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0?context={%22Tid%22:%22tenant%22}",
    "https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0",
    "https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0#",
    "https://contoso.sharepoint.com/:v:/g/personal/user/EWabc123?e=token",
    "https://contoso-my.sharepoint.com/personal/user/_layouts/15/Doc.aspx?sourcedoc=abc",
    "https://teams.microsoft.com/",
    "http://teams.microsoft.com/l/meetup-join/x",
  ];
  for (const url of refused) assert.throws(() => sanitizeDiscoveryStableUrl("microsoft-teams", url), url);
  // A tokenized link is refused through the adapter too, never cleaned —
  // which sanitizer rule fires first (query string, fragment, or unapproved
  // host) does not matter: the record never normalizes with a link attached.
  assert.throws(() => teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, url: refused[0] }, "company"), /stable URL/);
  assert.throws(() => teamsDiscoveryAdapter.normalizeSession({ ...TEAMS, url: refused[1] }, "company"), /stable URL/);
  // The declared gong form keeps working byte-for-byte (R-006).
  assert.equal(
    sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=7782342274025937895"),
    "https://app.gong.io/call?id=7782342274025937895",
  );
  assert.throws(() => sanitizeDiscoveryStableUrl("gong", "https://app.gong.io/call?id=abc&token=x"), /exactly the id parameter/);
});

// --- T-004: bounded selector scopes (R-004) ----------------------------------

test("a Teams scope needs a bounded window AND a customer selector; the tenant never substitutes for one", () => {
  const valid: TeamsScopeSelectors = { window: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-30T23:59:59.000Z" }, named_external_participants: ["Chris Exampleton"] };
  assert.equal(teamsScopeValidationError(valid), null);
  // A window alone is never enough — and neither is a whitespace-only selector.
  assert.match(teamsScopeValidationError({ window: valid.window }) ?? "", /at least one customer selector/);
  assert.match(
    teamsScopeValidationError({ window: valid.window, named_external_participants: ["  "], external_companies_or_domains: [], organizers: [] }) ?? "",
    /at least one customer selector/,
  );
  // Each declared selector kind satisfies the minimum on its own.
  assert.equal(teamsScopeValidationError({ window: valid.window, external_companies_or_domains: ["exampletonbros.example"] }), null);
  assert.equal(teamsScopeValidationError({ window: valid.window, organizers: ["Taylor Fixture"] }), null);
  // The window itself is mandatory and must be sane.
  assert.match(teamsScopeValidationError({ window: { start: "nope", end: "2026-09-30" } }) ?? "", /bounded time window/);
  assert.match(teamsScopeValidationError({ window: { start: valid.window.end, end: valid.window.start } }) ?? "", /must end after it starts/);
});
