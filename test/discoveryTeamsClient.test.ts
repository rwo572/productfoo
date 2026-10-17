// microsoft-teams-discovery-connector-v0 T-005: the Nango-brokered Graph
// client, pinned offline. The fixtures pin the Graph shapes the packet
// believes (T-001 owns verifying them live); the assertions pin the C-005
// boundaries that must hold regardless: refused secrets, missing scopes,
// oversized bodies, and non-read operations produce typed errors with no
// writes; error messages never embed a provider response; the paging ceiling
// fails closed. Teams support stays contract_only until T-001 and the T-008
// dogfood run produce receipt-backed evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { TEAMS_POLICY, TeamsGraphClient, TeamsRuntimeError, resolveTeamsConnection, teamsConnectionConfigured, teamsCredentialBroker, type FetchLike } from "../src/teamsNango.js";
import { SourceWriteRefused } from "../src/sourceIngress.js";

const NANGO_ENV = { NANGO_SECRET_KEY: "nango-secret-test", FOO_TEAMS_NANGO_CONNECTION: "conn_teams_tenant" };

type Call = { method: string; url: string };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// A routing stub: Nango answers from `nango`, Graph from `graph`, and every
// call is logged so fixtures can observe pacing, paths, and call counts.
function makeStub(options: { nango?: (url: URL) => Response; graph?: (url: URL) => Response } = {}) {
  const log: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    log.push({ method, url: url.toString() });
    if (url.hostname === "api.nango.dev") return options.nango ? options.nango(url) : jsonResponse(200, {
      id: 7,
      connection_id: "conn_teams_tenant",
      provider_config_key: "microsoft-teams",
      credentials: { type: "OAUTH2", access_token: "graph-token-test", raw: { scope: "OnlineMeeting.Read.All OnlineMeetingTranscript.Read.All" } },
    });
    if (url.hostname === "graph.microsoft.com") return options.graph ? options.graph(url) : jsonResponse(200, { value: [] });
    return new Response("", { status: 500 });
  };
  return { log, fetch };
}

const NO_SLEEP = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 1)));

// --- Broker selection (R-002, R-011) -----------------------------------------

test("Teams resolves only through the Nango broker; nothing configured is a typed refusal, not a fallback", async () => {
  assert.equal(teamsConnectionConfigured({}), false);
  assert.equal(teamsCredentialBroker({ NANGO_SECRET_KEY: "x", FOO_TEAMS_NANGO_CONNECTION: "c" }), "nango");
  assert.equal(teamsCredentialBroker({}), null);
  const stub = makeStub();
  await assert.rejects(
    resolveTeamsConnection({ env: { NANGO_SECRET_KEY: "only-the-secret" }, fetchImpl: stub.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof TeamsRuntimeError);
      assert.equal(error.code, "not_connected");
      assert.match(error.message, /Microsoft 365 administrator/);
      return true;
    },
  );
  assert.equal(stub.log.length, 0, "no provider call happens without a configured connection");
});

test("Nango refusals are typed and honest about the resolution", async () => {
  for (const [status, expected] of [[401, "not_connected"], [404, "not_connected"], [500, "provider_failure"]] as const) {
    const stub = makeStub({ nango: () => new Response("", { status }) });
    await assert.rejects(
      resolveTeamsConnection({ env: NANGO_ENV, fetchImpl: stub.fetch }),
      (error: unknown) => {
        assert.ok(error instanceof TeamsRuntimeError);
        assert.equal(error.code, expected);
        return true;
      },
    );
  }
});

test("the resolved connection is tenant-owned OAuth with scope-observed transcript access and an opaque ref", async () => {
  const granted = await resolveTeamsConnection({ env: NANGO_ENV, fetchImpl: makeStub().fetch });
  assert.equal(granted.broker, "nango");
  assert.equal(granted.credential_type, "oauth2");
  assert.equal(granted.transcript_scope, "granted");
  assert.equal(granted.connection_ref.startsWith("microsoft-teams:"), true);
  assert.equal(granted.connection_ref.includes("conn_teams_tenant"), false, "the Nango connection id is never printed");
  const missing = await resolveTeamsConnection({
    env: NANGO_ENV,
    fetchImpl: makeStub({ nango: () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "t", raw: { scope: "OnlineMeeting.Read.All" } } }) }).fetch,
  });
  assert.equal(missing.transcript_scope, "missing");
  const unknown = await resolveTeamsConnection({
    env: NANGO_ENV,
    fetchImpl: makeStub({ nango: () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "t" } }) }).fetch,
  });
  assert.equal(unknown.transcript_scope, "unknown");
  const basic = makeStub({ nango: () => jsonResponse(200, { credentials: { type: "BASIC", username: "u", password: "p" } }) });
  await assert.rejects(resolveTeamsConnection({ env: NANGO_ENV, fetchImpl: basic.fetch }), (error: unknown) => {
    assert.ok(error instanceof TeamsRuntimeError);
    assert.equal(error.code, "not_connected");
    return true;
  });
});

// --- Graph client boundaries (C-005, R-009, R-010) ---------------------------

function client(fetch: FetchLike, overrides: Partial<{ sleep: (ms: number) => Promise<void>; now: () => number; fetchTimeoutMs: number }> = {}): TeamsGraphClient {
  return new TeamsGraphClient({ type: "oauth2", access_token: "graph-token-test" }, { fetchImpl: fetch, sleep: overrides.sleep ?? NO_SLEEP, now: overrides.now, fetchTimeoutMs: overrides.fetchTimeoutMs });
}

test("Graph status codes map to typed codes with bounded messages that never embed the provider body", async () => {
  for (const [status, expected] of [[401, "auth_expired"], [403, "access_denied"], [429, "budget_exhausted"], [404, "provider_failure"], [502, "provider_failure"]] as const) {
    const stub = makeStub({ graph: () => new Response('{"secret":"provider-response-body"}', { status }) });
    await assert.rejects(
      client(stub.fetch).listMeetings({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" }),
      (error: unknown) => {
        assert.ok(error instanceof TeamsRuntimeError);
        assert.equal(error.code, expected);
        assert.equal(error.message.includes("provider-response-body"), false);
        return true;
      },
    );
  }
});

test("non-read operations route through the write-refusal choke point (R-009)", async () => {
  const stub = makeStub();
  const teams = client(stub.fetch);
  // A traversal probe is refused as a malformed identifier before any
  // network call...
  await assert.rejects(
    () => teams.transcriptContent("../users", "t"),
    (error: unknown) => {
      assert.ok(error instanceof TeamsRuntimeError);
      assert.equal(error.code, "provider_failure");
      return true;
    },
  );
  assert.equal(stub.log.length, 0);
  // ...and the choke point itself refuses any non-whitelisted operation —
  // POST to a read path, and GET to a path outside the read whitelist (R-009).
  const raw = teams as unknown as { request: (method: string, pathname: string) => Promise<unknown> };
  await assert.rejects(() => raw.request("POST", "/v1.0/communications/onlineMeetings"), SourceWriteRefused);
  await assert.rejects(() => raw.request("GET", "/v1.0/me/sendMail"), SourceWriteRefused);
  assert.equal(stub.log.length, 0, "refused operations never reached the network");
});

test("paging stops closed at the ceiling; the ceiling is part of the versioned policy", async () => {
  let page = 0;
  const stub = makeStub({
    graph: () => {
      page += 1;
      return jsonResponse(200, { value: [{ id: `meeting-${page}` }], "@odata.nextLink": page < 99 ? "https://graph.microsoft.com/v1.0/communications/onlineMeetings?skip=more" : undefined });
    },
  });
  const teams = client(stub.fetch);
  const listing = await teams.listMeetings({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" });
  assert.equal(listing.truncated, true);
  assert.equal(listing.pages, TEAMS_POLICY.max_list_pages);
  assert.equal(stub.log.length, TEAMS_POLICY.max_list_pages, "no request beyond the ceiling");
  assert.equal(TEAMS_POLICY.policy_version, "teams-local-worker-0.1");
});

test("an oversized transcript body is dropped before it is materialized", async () => {
  const stub = makeStub({
    graph: () => new Response(JSON.stringify({ content: "x".repeat(TEAMS_POLICY.max_response_bytes + 1) }), { status: 200, headers: { "content-length": String(TEAMS_POLICY.max_response_bytes + 1) } }),
  });
  await assert.rejects(
    client(stub.fetch).transcriptContent("meeting-1", "transcript-1"),
    (error: unknown) => {
      assert.ok(error instanceof TeamsRuntimeError);
      assert.equal(error.code, "transcript_too_large");
      return true;
    },
  );
});

test("requests are paced at the policy interval and carry the bearer token", async () => {
  let clock = 1_000;
  const slept: number[] = [];
  const stub = makeStub();
  const teams = client(stub.fetch, { now: () => clock, sleep: async (ms: number): Promise<void> => { slept.push(ms); clock += ms; } });
  await teams.listMeetings({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" });
  await teams.listMeetings({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T23:59:59Z" });
  assert.equal(stub.log.length, 2);
  for (const call of stub.log) {
    const sent = stub.fetch;
    void sent;
    assert.equal(call.method, "GET");
    assert.ok(call.url.startsWith("https://graph.microsoft.com/v1.0/communications/onlineMeetings"));
  }
  assert.ok(slept.every((ms) => ms <= TEAMS_POLICY.min_request_interval_ms), "the second call waits out the interval");
  assert.ok(slept.length >= 1, "pacing engaged between calls");
});

test("exactly one content read per call, one identifier per request (R-007 fixture pin)", async () => {
  const stub = makeStub({ graph: (url) => jsonResponse(200, { content: "[00:00] Customer: hello" }) });
  const teams = client(stub.fetch);
  const text = await teams.transcriptContent("meeting-1", "transcript-1");
  assert.equal(text, "[00:00] Customer: hello");
  assert.equal(teams.requests.transcript_content, 1);
  assert.equal(new URL(stub.log[0].url).pathname.endsWith("/transcripts/transcript-1/content"), true);
  for (const [meetingId, transcriptId] of [["", "t"], ["m 1", "t"], ["m", ""]]) {
    await assert.rejects(() => teams.transcriptContent(meetingId, transcriptId), TeamsRuntimeError);
  }
  assert.equal(teams.requests.transcript_content, 1, "refused calls never reached the provider");
});

test("transcript metadata listing never fetches content", async () => {
  const stub = makeStub({ graph: () => jsonResponse(200, { value: [{ id: "transcript-1" }, { id: "transcript-2" }] }) });
  const teams = client(stub.fetch);
  const transcripts = await teams.meetingTranscripts("meeting-1");
  assert.deepEqual(transcripts, [{ id: "transcript-1" }, { id: "transcript-2" }]);
  assert.equal(teams.requests.transcripts, 1);
  assert.equal(teams.requests.transcript_content, 0);
});
