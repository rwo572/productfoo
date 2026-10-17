// zoom-discovery-connector-v0 local worker: client half. The fixtures pin the
// provider shapes the packet believes (T-001 owns verifying them live); the
// assertions pin the boundaries that must hold regardless: observed-only
// transcript availability, links omitted rather than cleaned, typed and
// content-free errors, ceilings that fail closed, and read-only Zoom.
import assert from "node:assert/strict";
import test from "node:test";
import { ZOOM_POLICY, resolveZoomConnection, ZoomClient, ZoomRuntimeError } from "../src/zoomNango.js";
import { SourceWriteRefused } from "../src/sourceIngress.js";

const CANARY = "CANARY_ZOOM_VTT_9f3a";
const MEETING_UUID = "9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6";
const INTERNAL_UUID = "aabbccddeeff00112233445566778899";
const TRANSCRIPT_URL = `https://foo.zoom.us/rec/download/${MEETING_UUID}/transcript.vtt?access_token=zoomtok`;
const VTT = `WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nThanks for joining, Chris. ${CANARY}\n`;

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: string }>;
  listBody?: () => unknown;
  transcriptStatus?: number;
  transcriptBody?: () => string;
  nangoBody?: () => unknown;
  nangoStatus?: number;
  tokenStatus?: number;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function listPage(recordings: unknown[], nextPageToken?: string): unknown {
  return { from: "2026-09-01", to: "2026-09-14", next_page_token: nextPageToken, recordings };
}

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    stub.log.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_company");
      assert.equal(parsed.searchParams.get("provider_config_key"), "zoom");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      return jsonResponse(200, stub.nangoBody?.() ?? { id: 7, connection_id: "conn_company", provider_config_key: "zoom", credentials: { type: "OAUTH2", access_token: "zoom-oauth-token", raw: { scope: "recording:read:admin user:read:admin" } } });
    }
    if (parsed.hostname === "zoom.us" && parsed.pathname === "/oauth/token") {
      if (stub.tokenStatus) return new Response("", { status: stub.tokenStatus });
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
      const form = new URLSearchParams(body ?? "");
      assert.equal(form.get("grant_type"), "account_credentials");
      assert.equal(form.get("account_id"), "acct_123");
      return jsonResponse(200, { access_token: "s2s-token", token_type: "bearer", expires_in: 3600 });
    }
    if (parsed.hostname === "api.zoom.us") {
      const auth = (init?.headers as Record<string, string>).authorization;
      assert.equal(auth, "Bearer zoom-oauth-token");
      if (method === "GET" && /^\/users\/[^/]+\/recordings$/.test(parsed.pathname)) {
        assert.ok(parsed.searchParams.get("from"));
        assert.ok(parsed.searchParams.get("to"));
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        return jsonResponse(200, listPage([
          {
            uuid: MEETING_UUID,
            topic: "Discovery call with Exampleton Brothers",
            start_time: "2026-09-01T16:00:00Z",
            end_time: "2026-09-01T16:30:00Z",
            state: "completed",
            host_display_name: "Taylor Fixture",
            participants: [
              { display_name: "Chris Exampleton", email: "chris@exampletonbros.example" },
              { display_name: "Taylor Fixture", email: "taylor@foo.example" },
            ],
            play_url: `https://foo.zoom.us/recording/${MEETING_UUID}`,
            recording_files: [
              { file_type: "MP4", status: "completed", download_url: `https://foo.zoom.us/rec/download/${MEETING_UUID}/mp4` },
              { file_type: "TRANSCRIPTION", status: "completed", download_url: TRANSCRIPT_URL },
            ],
          },
          {
            uuid: INTERNAL_UUID,
            topic: "Internal pipeline review",
            start_time: "2026-09-01T15:00:00Z",
            state: "completed",
            host_display_name: "Taylor Fixture",
            participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }],
            // Tokenized share form: omitted by the client, never cleaned.
            play_url: `https://foo.zoom.us/rec/play/${INTERNAL_UUID}?access_token=tok`,
            recording_files: [{ file_type: "MP4", status: "completed", download_url: `https://foo.zoom.us/rec/download/${INTERNAL_UUID}/mp4` }],
          },
        ]));
      }
      return new Response("", { status: 405 });
    }
    if (parsed.hostname === "foo.zoom.us" && parsed.pathname.startsWith("/rec/download/")) {
      if (stub.transcriptStatus) return new Response("", { status: stub.transcriptStatus });
      return new Response(stub.transcriptBody?.() ?? VTT, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("", { status: 404 });
  };
  return stub;
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_ZOOM_NANGO_CONNECTION: "conn_company", ...extra };
}

async function connect(stub: Stub, extra: Record<string, string | undefined> = {}): Promise<ZoomClient> {
  const connection = await resolveZoomConnection({ env: env(extra), fetchImpl: stub.fetch });
  return new ZoomClient(connection.credential, { fetchImpl: stub.fetch, sleep: async () => undefined });
}

test("resolveZoomConnection prefers Nango and reports the recording scope as observed, never assumed", async () => {
  const stub = makeStub();
  const granted = await resolveZoomConnection({ env: env(), fetchImpl: stub.fetch });
  assert.equal(granted.broker, "nango");
  assert.equal(granted.credential_type, "oauth2");
  assert.equal(granted.transcript_scope, "granted");
  // The connection ref is opaque: the Nango connection id never appears in it.
  assert.ok(!granted.connection_ref.includes("conn_company"));
});

test("a Nango token without the recording scope reports it missing, and a scopeless token reports unknown", async () => {
  const stub = makeStub();
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "user:read:admin" } } });
  const missing = await resolveZoomConnection({ env: env(), fetchImpl: stub.fetch });
  assert.equal(missing.transcript_scope, "missing");
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "tok" } });
  const unknown = await resolveZoomConnection({ env: env(), fetchImpl: stub.fetch });
  assert.equal(unknown.transcript_scope, "unknown");
});

test("a direct server-to-server app exchanges once and returns a company credential", async () => {
  const stub = makeStub();
  const connection = await resolveZoomConnection({ env: { FOO_ZOOM_ACCOUNT_ID: "acct_123", FOO_ZOOM_CLIENT_ID: "client-id", FOO_ZOOM_CLIENT_SECRET: "client-secret" }, fetchImpl: stub.fetch });
  assert.equal(connection.broker, "direct");
  assert.equal(connection.credential.type, "oauth2");
  // An account_credentials grant carries the account-wide grant the
  // administrator configured; the feasibility run verifies what it reads.
  assert.equal(connection.transcript_scope, "granted");
  assert.ok(!connection.connection_ref.includes("client-id"));
  assert.equal(stub.log.filter((entry) => entry.url === "https://zoom.us/oauth/token").length, 1);
  // A refused server-to-server credential is typed auth_expired, content-free.
  stub.tokenStatus = 400;
  await assert.rejects(resolveZoomConnection({ env: { FOO_ZOOM_ACCOUNT_ID: "acct_123", FOO_ZOOM_CLIENT_ID: "client-id", FOO_ZOOM_CLIENT_SECRET: "wrong" }, fetchImpl: stub.fetch }), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "auth_expired");
});

test("no configuration yields not_connected with both connection paths named", async () => {
  await assert.rejects(resolveZoomConnection({ env: {}, fetchImpl: makeStub().fetch }), (error: unknown) => {
    assert.ok(error instanceof ZoomRuntimeError && error.code === "not_connected");
    assert.match(error.message, /NANGO_SECRET_KEY/);
    assert.match(error.message, /FOO_ZOOM_ACCOUNT_ID/);
    return true;
  });
});

test("listing maps observed recordings, derives transcript availability from the file manifest, and omits non-canonical links without cleaning them", async () => {
  const stub = makeStub();
  const zoom = await connect(stub);
  const listed = await zoom.listSessions("me", { from: "2026-09-01", to: "2026-09-14" });
  assert.equal(listed.pages, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.recordings.length, 2);
  const external = listed.recordings.find((recording) => recording.meeting_uuid === MEETING_UUID);
  assert.equal(external?.topic, "Discovery call with Exampleton Brothers");
  assert.equal(external?.transcript_available, true);
  assert.equal(external?.url, `https://foo.zoom.us/recording/${MEETING_UUID}`);
  const internal = listed.recordings.find((recording) => recording.meeting_uuid === INTERNAL_UUID);
  // No downloadable transcript file observed: the capability fails closed...
  assert.equal(internal?.transcript_available, false);
  // ...and the tokenized share link is omitted entirely — never cleaned.
  assert.equal(internal?.url, undefined);
});

test("an oversized listing page fails closed before any record is emitted", async () => {
  const stub = makeStub();
  stub.listBody = () => ({ recordings: [], padding: "x".repeat(4 * 1024 * 1024 + 1) });
  const zoom = await connect(stub);
  await assert.rejects(zoom.listSessions("me", { from: "2026-09-01", to: "2026-09-14" }), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "transcript_too_large");
  assert.equal(zoom.requests.list, 1);
});

test("listing pages through next_page_token and stops at the policy ceiling", async () => {
  const stub = makeStub();
  let page = 0;
  stub.listBody = () => {
    page += 1;
    return listPage([{ uuid: `${MEETING_UUID.slice(0, 24)}${String(page).padStart(8, "0")}`, topic: `Recording ${page}`, start_time: "2026-09-01T16:00:00Z" }], page < 2 ? "cursor-next" : undefined);
  };
  const zoom = await connect(stub);
  const listed = await zoom.listSessions("me", { from: "2026-09-01", to: "2026-09-14" });
  assert.equal(listed.pages, 2);
  assert.equal(listed.truncated, false);
  assert.equal(zoom.requests.list, 2);
  stub.listBody = () => listPage([{ uuid: INTERNAL_UUID, topic: "More", start_time: "2026-09-01T16:00:00Z" }], "always-more");
  const capped = await connect(stub);
  const cappedList = await capped.listSessions("me", { from: "2026-09-01", to: "2026-09-14" });
  assert.equal(cappedList.pages, ZOOM_POLICY.max_list_pages);
  assert.equal(cappedList.truncated, true);
  assert.equal(capped.requests.list, ZOOM_POLICY.max_list_pages);
});

test("the transcript download fetches exactly one observed file with the company token, and errors are typed and content-free", async () => {
  const stub = makeStub();
  const zoom = await connect(stub);
  const downloaded = await zoom.transcript(TRANSCRIPT_URL);
  assert.match(downloaded.vtt, new RegExp(CANARY));
  assert.equal(zoom.requests.transcript, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("foo.zoom.us/rec/download")).length, 1);
  // The tokenized download URL is used in transit only: no error message ever
  // embeds it or its token.
  stub.transcriptStatus = 401;
  await assert.rejects(zoom.transcript(TRANSCRIPT_URL), (error: unknown) => {
    assert.ok(error instanceof ZoomRuntimeError && error.code === "auth_expired");
    assert.doesNotMatch(error.message, /access_token|zoomtok|rec\/download/);
    return true;
  });
  stub.transcriptStatus = 403;
  await assert.rejects(zoom.transcript(TRANSCRIPT_URL), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "access_denied");
  stub.transcriptStatus = 404;
  await assert.rejects(zoom.transcript(TRANSCRIPT_URL), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "provider_failure");
  stub.transcriptStatus = 429;
  await assert.rejects(zoom.transcript(TRANSCRIPT_URL), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "budget_exhausted");
  // A transcript over the byte ceiling is dropped before it is materialized.
  stub.transcriptStatus = undefined;
  stub.transcriptBody = () => "x".repeat(ZOOM_POLICY.max_transcript_bytes + 1);
  await assert.rejects(zoom.transcript(TRANSCRIPT_URL), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "transcript_too_large");
});

test("read-only: any non-read Zoom operation is refused at the single choke point, and non-Zoom hosts never get a request", async () => {
  const stub = makeStub();
  const zoom = await connect(stub);
  const request = (zoom as unknown as { request: (pathname: string, maxBytes?: number) => Promise<unknown> }).request.bind(zoom);
  // The client only ever issues GETs: anything that is not the pinned read
  // path is refused before any network.
  await assert.rejects(request("users/me/recordings"), SourceWriteRefused);
  await assert.rejects(zoom.transcript("https://evil.example/recording/x"), (error: unknown) => error instanceof ZoomRuntimeError && error.code === "provider_failure");
  assert.equal(stub.log.filter((entry) => entry.url.includes("evil.example")).length, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("zoom.us")).length, 0);
});
