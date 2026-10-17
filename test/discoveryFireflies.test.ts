// fireflies-discovery-connector-v0: the contract-only slice. These tests
// prove classification (T-002) and the path-based link rule (T-002/R-006).
// They prove nothing about live Fireflies access — support stays
// contract_only until the feasibility task (T-001) and the dogfood run
// (T-008) close with receipts.
import assert from "node:assert/strict";
import test from "node:test";
import { firefliesDiscoveryAdapter, firefliesInternalOnly, type FirefliesTranscriptRecord } from "../src/discoveryProviders.js";
import { assertNormalizedSessionShape, sanitizeDiscoveryStableUrl } from "../src/discoverySources.js";
import { firefliesConnectionReady, classifyProvider, SourceWriteRefused } from "../src/sourceIngress.js";
import { firefliesScopeValidationError, firefliesSelectorsFromInboxScope } from "../src/discoveryFireflies.js";
import { FirefliesClient, FirefliesRuntimeError, firefliesConnectionConfigured, firefliesCredentialBroker, resolveFirefliesConnection, FIREFLIES_POLICY, type FetchLike, type FirefliesRuntimeErrorCode } from "../src/firefliesClient.js";
import { GONG_POLICY } from "../src/gongNango.js";

const FIREFLIES: FirefliesTranscriptRecord = {
  id: "8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d",
  title: "Discovery call — Exampleton Brothers",
  started_at: "2026-09-01T16:00:00.000Z",
  ended: "2026-09-01T16:42:00.000Z",
  status: "completed",
  participants: [
    { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
    { display_name: "Taylor Fixture", email: "taylor@foo.example" },
  ],
  url: "https://app.fireflies.ai/transcript/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d",
  transcript_access: "granted",
};

// --- T-002: registry --------------------------------------------------------

test("fireflies is a registered meeting_transcript source with the Gong classification", () => {
  const c = classifyProvider("fireflies");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "meeting_transcript");
  assert.equal(c.evidence_class, "communication");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.model_exposure, "summary_only");
  assert.deepEqual({ ...classifyProvider("gong"), registered: undefined }, { ...c, registered: undefined });
  // Registration is classification, not a live-support claim, and does not
  // loosen the most-restrictive default for anything else.
  assert.equal(classifyProvider("fireflies-teams").registered, false);
  assert.equal(classifyProvider("FIREFLIES").registered, true, "provider matching is case-insensitive");
});

// --- T-002/R-006: path-based link form --------------------------------------

test("Fireflies canonical links are path-based, HTTPS, and host-allowlisted; query strings are refused, never cleaned", () => {
  assert.equal(
    sanitizeDiscoveryStableUrl("fireflies", "https://app.fireflies.ai/transcript/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d"),
    "https://app.fireflies.ai/transcript/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d",
  );
  assert.throws(() => sanitizeDiscoveryStableUrl("fireflies", "https://app.fireflies.ai/transcript/abc?token=secret"), /query string/);
  assert.throws(() => sanitizeDiscoveryStableUrl("fireflies", "https://evil.example/transcript/abc"), /approved host/);
  assert.throws(() => sanitizeDiscoveryStableUrl("fireflies", "http://app.fireflies.ai/transcript/abc"), /HTTPS/);
  assert.throws(() => sanitizeDiscoveryStableUrl("fireflies", "https://user:pw@app.fireflies.ai/transcript/abc"), /credentials/);
});

// --- T-003: adapter ---------------------------------------------------------

test("Fireflies raw payload keys stay in the adapter and normalize to the shared model", () => {
  const normalized = firefliesDiscoveryAdapter.normalizeSession(FIREFLIES, "personal");
  assertNormalizedSessionShape(normalized);
  assert.equal(normalized.provider, "fireflies");
  assert.equal(normalized.connection_alias, "personal");
  assert.equal(normalized.runtime_handle, "8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d");
  // The meeting's end time, not the start (R-005).
  assert.equal(normalized.completed_at, "2026-09-01T16:42:00.000Z");
  assert.equal(normalized.completion_state, "completed");
  // Speaker display names plus a domain-only label per emailed participant
  // (OQ-002: no affiliation, so none is filtered); the raw local part of every
  // address is gone — only the @domain labels survive, by design.
  assert.deepEqual(normalized.participants, ["Chris Exampleton", "@exampletonbros.example", "Taylor Fixture", "@foo.example"]);
  assert.equal(normalized.stable_url, "https://app.fireflies.ai/transcript/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d");
  assert.deepEqual(normalized.capabilities, { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true });
  const json = JSON.stringify(normalized);
  assert.doesNotMatch(json, /display_name|started_at|transcript_access/);
  assert.doesNotMatch(json, /chris@|taylor@/);
});

test("Fireflies contact hints are domain-only company candidates plus parsed names; the raw email dies in the adapter", () => {
  const hints = firefliesDiscoveryAdapter.normalizeSession(FIREFLIES, "personal").contact_hints ?? [];
  // OQ-002: a mixed-domain transcript cannot attribute internality per
  // participant, so every emailed participant's domain becomes a company
  // CANDIDATE — including the rep's own — for a person to confirm.
  assert.deepEqual(hints, [
    { field: "full_name", value: "Chris Exampleton", source: "fireflies:participant" },
    { field: "company", value: "Exampletonbros", source: "fireflies:participant_email_domain" },
    { field: "full_name", value: "Taylor Fixture", source: "fireflies:participant" },
    { field: "company", value: "Foo", source: "fireflies:participant_email_domain" },
  ]);
});

test("Fireflies transcript access is observed, never assumed: an absent grant fails closed", () => {
  const { transcript_access: _omit, ...withoutGrant } = FIREFLIES;
  assert.equal(firefliesDiscoveryAdapter.normalizeSession(withoutGrant, "personal").capabilities.open_transcript, false);
  assert.equal(firefliesDiscoveryAdapter.normalizeSession({ ...FIREFLIES, transcript_access: "missing" }, "personal").capabilities.open_transcript, false);
});

test("Fireflies completion and links fall back honestly: no end keeps the start, an unknown status is in_progress, a bad id yields no link", () => {
  const noEnd = firefliesDiscoveryAdapter.normalizeSession({ ...FIREFLIES, ended: undefined }, "personal");
  assert.equal(noEnd.completed_at, "2026-09-01T16:00:00.000Z");
  assert.equal(firefliesDiscoveryAdapter.normalizeSession({ ...FIREFLIES, status: "processing" }, "personal").completion_state, "in_progress");
  // Belief (T-001): Fireflies' own terminal status is "processed".
  assert.equal(firefliesDiscoveryAdapter.normalizeSession({ ...FIREFLIES, status: "processed" }, "personal").completion_state, "completed");
  const noLink = firefliesDiscoveryAdapter.normalizeSession({ ...FIREFLIES, id: "id with spaces", url: undefined }, "personal");
  assert.equal(noLink.stable_url, undefined);
  assert.equal(noLink.capabilities.stable_link, false);
});

test("an internal-only Fireflies transcript (every identified participant on one domain) yields no contact hints", () => {
  const internal = firefliesDiscoveryAdapter.normalizeSession(
    { ...FIREFLIES, participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }, { display_name: "Samcolleague", email: "sam@foo.example" }] },
    "personal",
  );
  assert.equal(internal.contact_hints, undefined);
});

// --- T-004: bounded selector scopes (R-004) ---------------------------------

test("windowless and selector-less fireflies scopes are invalid; include_internal_only is refused in V0", () => {
  const windowed = { window: { start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" } };
  // A window alone is never enough.
  assert.match(firefliesScopeValidationError(windowed) ?? "", /customer selector/);
  // An unbounded or inverted window is invalid before any selector question.
  assert.match(firefliesScopeValidationError({ ...windowed, external_domains: ["exampletonbros.example"], window: {} }) ?? "", /bounded time window/);
  assert.match(firefliesScopeValidationError({ ...windowed, external_domains: ["exampletonbros.example"], window: { start: "2026-09-02T00:00:00Z", end: "2026-09-01T00:00:00Z" } }) ?? "", /must end after it starts/);
  // Each selector kind alone satisfies the rule; blank entries do not.
  assert.equal(firefliesScopeValidationError({ ...windowed, external_names: ["Chris Exampleton"] }), null);
  assert.equal(firefliesScopeValidationError({ ...windowed, external_domains: ["exampletonbros.example"] }), null);
  assert.equal(firefliesScopeValidationError({ ...windowed, title_tokens: ["migration"] }), null);
  assert.match(firefliesScopeValidationError({ ...windowed, external_domains: ["  "] }) ?? "", /customer selector/);
  // Internal-only meetings are excluded by default and a scope cannot ask in.
  assert.match(firefliesScopeValidationError({ ...windowed, external_domains: ["exampletonbros.example"], include_internal_only: true }) ?? "", /internal-only/);
  // The inbox scope mapping carries the generic fields onto the selector kinds.
  const mapped = firefliesSelectorsFromInboxScope({ scope_id: "s", provider: "fireflies", connection_alias: "personal", time_window: { start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" }, participant_allowlist: [], domain_allowlist: ["exampletonbros.example"], title_tokens: [], state: "approved" });
  assert.deepEqual(mapped, { window: { start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" }, external_names: [], external_domains: ["exampletonbros.example"], title_tokens: [] });
});

// --- T-004: internal-only exclusion (R-004, OQ-002) --------------------------

test("the internal-only rule is email-domain-derived: single shared domain excluded, mixed domains and email-less rosters stay in", () => {
  // Every identified participant on one shared domain: no external party by
  // domain — excluded by default.
  assert.equal(firefliesInternalOnly({ ...FIREFLIES, participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }, { display_name: "Samcolleague", email: "sam@foo.example" }] }), true);
  // Mixed domains: an external party is present.
  assert.equal(firefliesInternalOnly(FIREFLIES), false);
  // Email-less rosters carry no externality signal either way: gong precedent
  // keeps them in and lets the scope's selectors admit them.
  assert.equal(firefliesInternalOnly({ ...FIREFLIES, participants: [{ display_name: "Taylor Fixture" }] }), false);
  assert.equal(firefliesInternalOnly({ ...FIREFLIES, participants: [] }), false);
});

// --- T-004: per-user ownership honesty (R-010, OQ-001) ------------------------

test("fireflies_connection_ready reports user ownership with no admin_ref, opaque refs only", () => {
  const ref = "fireflies:direct:9f3a2b7c1d5e4082";
  const ready = firefliesConnectionReady({ connection_ref: ref });
  assert.equal(ready.event, "discovery_connection_ready");
  assert.equal(ready.connection_owner, "user");
  assert.equal(ready.admin_ref, undefined);
  assert.equal(ready.connection_ref, ref);
  assert.deepEqual(Object.keys(ready).sort(), ["connection_owner", "connection_ref", "event"]);
  // Readiness refs are opaque: no emails, no display names, no key material.
  assert.throws(() => firefliesConnectionReady({ connection_ref: "taylor@foo.example" }), /opaque/);
  assert.throws(() => firefliesConnectionReady({ connection_ref: "Taylor Fixture" }), /opaque/);
  assert.throws(() => firefliesConnectionReady({ connection_ref: "" }), /connection_ref/);
});

// --- T-005: direct-key client ------------------------------------------------

test("FIREFLIES_POLICY keeps gong's hard ceilings; the broker type makes a nango-brokered fireflies connection inexpressible", () => {
  assert.equal(FIREFLIES_POLICY.max_response_bytes, GONG_POLICY.max_response_bytes);
  assert.equal(FIREFLIES_POLICY.fetch_timeout_ms, GONG_POLICY.fetch_timeout_ms);
  assert.equal(FIREFLIES_POLICY.max_model_input_tokens, GONG_POLICY.max_model_input_tokens);
  assert.equal(FIREFLIES_POLICY.max_list_pages, GONG_POLICY.max_list_pages);
  assert.equal(FIREFLIES_POLICY.min_request_interval_ms, GONG_POLICY.min_request_interval_ms);
  // R-004: no Nango for this source — the broker is direct or absent.
  assert.equal(firefliesCredentialBroker({}), null);
  assert.equal(firefliesCredentialBroker({ FOO_FIREFLIES_API_KEY: "   " }), null);
  assert.equal(firefliesCredentialBroker({ FOO_FIREFLIES_API_KEY: "ff_key_live" }), "direct");
  assert.equal(firefliesConnectionConfigured({ FOO_FIREFLIES_API_KEY: "ff_key_live" }), true);
});

test("resolveFirefliesConnection reads the user's key directly: stable opaque ref, transcript_access unknown, ref never carries the key", async () => {
  await assert.rejects(
    async () => resolveFirefliesConnection({ env: {} }),
    (error: unknown) => error instanceof FirefliesRuntimeError && error.code === "not_connected",
  );
  const first = resolveFirefliesConnection({ env: { FOO_FIREFLIES_API_KEY: "ff_key_1" } });
  const again = resolveFirefliesConnection({ env: { FOO_FIREFLIES_API_KEY: "ff_key_1" } });
  const other = resolveFirefliesConnection({ env: { FOO_FIREFLIES_API_KEY: "ff_key_2" } });
  assert.match(first.connection_ref, /^fireflies:direct:[0-9a-f]{16}$/);
  assert.equal(first.connection_ref, again.connection_ref);
  assert.notEqual(first.connection_ref, other.connection_ref);
  assert.equal(first.broker, "direct");
  // Observed, never assumed (R-005): readiness starts at unknown.
  assert.equal(first.transcript_access, "unknown");
  assert.ok(!first.connection_ref.includes("ff_key_1"));
});

function firefliesStub(responder: (request: { url: string; query: string; variables: Record<string, unknown>; init: RequestInit }) => Response): { fetch: FetchLike; log: Array<{ url: string; query: string }> } {
  const log: Array<{ url: string; query: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as { query?: string; variables?: Record<string, unknown> };
    log.push({ url, query: parsed.query ?? "" });
    return responder({ url, query: parsed.query ?? "", variables: parsed.variables ?? {}, init: init ?? {} });
  };
  return { fetch, log };
}

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

test("listTranscripts pages with offset pagination, maps metadata only, and never requests sentence content", async () => {
  const stub = firefliesStub(({ variables }) => {
    const offset = Number(variables.offset ?? 0);
    const count = offset === 0 ? 50 : 3;
    return graphqlResponse({
      transcripts: Array.from({ length: count }, (_, index) => ({
        id: `t${offset + index}`,
        title: `Call ${offset + index}`,
        date: "2026-09-01T16:00:00.000Z",
        end_date: "2026-09-01T16:42:00.000Z",
        status: "completed",
        participants: [{ display_name: "Chris Exampleton", email: "chris@exampletonbros.example" }],
      })),
    });
  });
  const client = new FirefliesClient({ type: "key", api_key: "ff_key_live" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const listed = await client.listTranscripts({ from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" });
  assert.equal(listed.pages, 2);
  assert.equal(listed.truncated, false);
  assert.equal(listed.transcripts.length, 53);
  assert.deepEqual(listed.transcripts[0], {
    id: "t0",
    title: "Call 0",
    started_at: "2026-09-01T16:00:00.000Z",
    ended: "2026-09-01T16:42:00.000Z",
    status: "completed",
    participants: [{ display_name: "Chris Exampleton", email: "chris@exampletonbros.example" }],
  });
  // R-004: the metadata listing never asks for sentence content.
  for (const entry of stub.log) assert.ok(!entry.query.includes("sentences"));
  // The key rides only in the bearer header; the endpoint is /graphql.
  assert.equal(stub.log.length, 2);
  assert.equal(new URL(stub.log[0].url).pathname, "/graphql");
});

test("listing stops at the page ceiling and reports truncated", async () => {
  const stub = firefliesStub(() =>
    graphqlResponse({ transcripts: Array.from({ length: 50 }, (_, index) => ({ id: `t${index}` })) }),
  );
  const client = new FirefliesClient({ type: "key", api_key: "k" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const listed = await client.listTranscripts({ from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" });
  assert.equal(listed.truncated, true);
  assert.equal(listed.pages, FIREFLIES_POLICY.max_list_pages);
  assert.equal(stub.log.length, FIREFLIES_POLICY.max_list_pages);
});

test("a graphql mutation is refused at the single choke point and no request is ever issued", async () => {
  const stub = firefliesStub(() => graphqlResponse({}));
  const client = new FirefliesClient({ type: "key", api_key: "k" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const request = (client as unknown as { request: (query: string, variables: Record<string, unknown>) => Promise<unknown> }).request.bind(client);
  await assert.rejects(request('mutation FooDelete { deleteTranscript(id: "x") { id } }', {}), SourceWriteRefused);
  assert.equal(stub.log.length, 0);
  assert.deepEqual(client.requests, { viewer: 0, list: 0, transcript: 0 });
});

test("transcript fetches exactly one well-formed identifier and maps speakers and sentences; bad ids fail before any request", async () => {
  const stub = firefliesStub(({ variables }) =>
    graphqlResponse({
      transcript: {
        title: "Discovery call — Exampleton Brothers",
        speakers: [{ name: "Chris Exampleton" }, { name: "Taylor Fixture" }],
        sentences: [
          { text: "Thanks for making time.", start_date: "2026-09-01T16:00:05.000Z", speaker_id: "s1" },
          { text: 42 as unknown as string },
        ],
      },
    }),
  );
  const client = new FirefliesClient({ type: "key", api_key: "k" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
  await assert.rejects(client.transcript("one two"), (error: unknown) => error instanceof FirefliesRuntimeError && error.code === "provider_failure");
  assert.equal(stub.log.length, 0);
  const content = await client.transcript("8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d");
  assert.equal(content.title, "Discovery call — Exampleton Brothers");
  assert.deepEqual(content.speakers, [{ name: "Chris Exampleton" }, { name: "Taylor Fixture" }]);
  assert.deepEqual(content.sentences, [{ text: "Thanks for making time.", start_date: "2026-09-01T16:00:05.000Z", end_date: undefined, speaker_id: "s1" }]);
  assert.equal(client.requests.transcript, 1);
});

test("fireflies failures are typed and content-free: statuses map to codes and error messages never carry provider responses", async () => {
  const cases: Array<[number, FirefliesRuntimeErrorCode]> = [
    [401, "auth_expired"],
    [403, "access_denied"],
    [429, "budget_exhausted"],
    [500, "provider_failure"],
  ];
  for (const [status, code] of cases) {
    const stub = firefliesStub(() => new Response(JSON.stringify({ errors: [{ message: "SECRET-PROVIDER-DETAIL ff_key_live" }] }), { status }));
    const client = new FirefliesClient({ type: "key", api_key: "ff_key_live" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
    await assert.rejects(
      client.probe(),
      (error: unknown) => {
        assert.ok(error instanceof FirefliesRuntimeError);
        assert.equal(error.code, code);
        assert.ok(!error.message.includes("SECRET-PROVIDER-DETAIL"));
        assert.ok(!error.message.includes("ff_key_live"));
        return true;
      },
    );
  }
  // A graphql error payload is a provider failure; unparseable JSON too.
  const errorPayload = firefliesStub(() => graphqlResponse({ viewer: null }));
  (errorPayload as { fetch: FetchLike }).fetch = async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const broken = new FirefliesClient({ type: "key", api_key: "k" }, { fetchImpl: errorPayload.fetch, sleep: async () => undefined });
  await assert.rejects(broken.probe(), (error: unknown) => error instanceof FirefliesRuntimeError && error.code === "provider_failure");
  const unparseable = new FirefliesClient({ type: "key", api_key: "k" }, { fetchImpl: async () => new Response("<html>", { status: 200 }), sleep: async () => undefined });
  await assert.rejects(unparseable.probe(), (error: unknown) => error instanceof FirefliesRuntimeError && error.code === "provider_failure");
});
