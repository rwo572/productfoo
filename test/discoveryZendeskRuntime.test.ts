// zendesk-discovery-connector-v0 local worker: contract-only runtime tests
// against stubbed Nango and Zendesk endpoints. The fixtures pin the provider
// shapes the packet believes (T-001 owns verifying them live); the assertions
// pin the boundaries that must hold regardless: read-only Zendesk through the
// single write-refusal choke point, exactly one ticket id per comment read,
// observed comment access, and typed failures that never embed a provider
// response. They prove nothing about live Zendesk access (T-008 stays open).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";
import { runZendeskDiscovery, type ZendeskDiscoveryDeps } from "../src/zendeskDiscovery.js";
import { approve, refuseSourceWrite, SourceWriteRefused } from "../src/sourceIngress.js";
import { resolveZendeskConnection, ZendeskClient, ZendeskRuntimeError, ZENDESK_POLICY, type ZendeskConnectionEnv } from "../src/zendeskNango.js";

const NOW = "2026-09-24T18:00:00.000Z";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; headers: Record<string, string> }>;
  nangoBody?: () => unknown;
  nangoStatus?: number;
  zendeskStatus?: number;
  // E2E body hooks, routed by pathname below.
  searchBody?: () => unknown;
  usersBody?: () => unknown;
  brandsBody?: () => unknown;
  commentsBody?: () => unknown;
  modelReply?: () => string;
};

function makeStub(overrides: Partial<ZendeskConnectionEnv> = {}): { stub: Stub; env: ZendeskConnectionEnv } {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    stub.log.push({ method, url, headers });
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      return jsonResponse(200, stub.nangoBody ? stub.nangoBody() : {});
    }
    if (parsed.hostname.endsWith(".zendesk.com")) {
      if (stub.zendeskStatus) return new Response("", { status: stub.zendeskStatus });
      assert.match(headers.authorization, /^(Basic |Bearer )/);
      if (parsed.pathname === "/api/v2/search/export.json") return jsonResponse(200, stub.searchBody ? stub.searchBody() : { results: [], meta: { has_more: false, after_cursor: null } });
      if (parsed.pathname === "/api/v2/users/show_many") return jsonResponse(200, stub.usersBody ? stub.usersBody() : { users: [] });
      if (parsed.pathname === "/api/v2/brands.json") return jsonResponse(200, stub.brandsBody ? stub.brandsBody() : { brands: [] });
      if (/^\/api\/v2\/tickets\/\d+\/comments\.json$/.test(parsed.pathname)) return jsonResponse(200, stub.commentsBody ? stub.commentsBody() : { comments: [] });
      return new Response("", { status: 405 });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.equal(body.model, "claude-opus-5");
      assert.match(String(body.messages[0].content), /TRANSCRIPT/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: "2026-09-24 14:05", confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
          { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "2026-09-24 14:05", confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
        ],
        contact_candidates: [{ title: "Head of Support" }],
        coverage: { transcript_complete: true, caveats: [] },
      });
      return jsonResponse(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 300 } });
    }
    return new Response("", { status: 500 });
  };
  const env: ZendeskConnectionEnv = {
    FOO_ZENDESK_SUBDOMAIN: "foohelp",
    NANGO_SECRET_KEY: "nango-secret-test",
    FOO_ZENDESK_NANGO_CONNECTION: "conn_company",
    ...overrides,
  };
  return { stub, env };
}

// --- T-005: connection resolution ---------------------------------------------

test("direct credentials resolve to Zendesk API-token basic auth with comment access granted", async () => {
  const { stub, env } = makeStub({ NANGO_SECRET_KEY: undefined, FOO_ZENDESK_NANGO_CONNECTION: undefined, FOO_ZENDESK_API_TOKEN: "zendesk-token", FOO_ZENDESK_API_TOKEN_EMAIL: "admin@foo.example" });
  const connection = await resolveZendeskConnection({ env, fetchImpl: stub.fetch });
  assert.equal(connection.broker, "direct");
  assert.equal(connection.credential_type, "basic");
  assert.equal(connection.comment_scope, "granted");
  assert.equal(connection.subdomain, "foohelp");
  if (connection.credential.type === "basic") {
    assert.equal(connection.credential.username, "admin@foo.example/token");
    assert.equal(connection.credential.password, "zendesk-token");
  } else {
    assert.fail("expected basic credentials");
  }
  // The opaque ref never carries the subdomain, email, or token.
  assert.match(connection.connection_ref, /^zendesk:direct:[0-9a-f]{16}$/);
  assert.doesNotMatch(connection.connection_ref, /foohelp|admin@|token/);
});

test("the workspace subdomain is required for both brokers and must be a single label", async () => {
  const direct = makeStub({ NANGO_SECRET_KEY: undefined, FOO_ZENDESK_NANGO_CONNECTION: undefined, FOO_ZENDESK_API_TOKEN: "t", FOO_ZENDESK_API_TOKEN_EMAIL: "a@foo.example" });
  await assert.rejects(resolveZendeskConnection({ env: { ...direct.env, FOO_ZENDESK_SUBDOMAIN: undefined }, fetchImpl: direct.stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "not_connected");
    assert.match(error.message, /FOO_ZENDESK_SUBDOMAIN/);
    return true;
  });
  await assert.rejects(resolveZendeskConnection({ env: { ...direct.env, FOO_ZENDESK_SUBDOMAIN: "https://foohelp.zendesk.com" }, fetchImpl: direct.stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "not_connected");
    assert.match(error.message, /single Zendesk subdomain label/);
    return true;
  });
  const nango = makeStub();
  await assert.rejects(resolveZendeskConnection({ env: { ...nango.env, FOO_ZENDESK_SUBDOMAIN: "" }, fetchImpl: nango.stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "not_connected");
    return true;
  });
});

test("nothing configured fails closed with both broker paths named", async () => {
  const { stub, env } = makeStub({ NANGO_SECRET_KEY: undefined, FOO_ZENDESK_NANGO_CONNECTION: undefined, FOO_ZENDESK_API_TOKEN: undefined, FOO_ZENDESK_API_TOKEN_EMAIL: undefined });
  await assert.rejects(resolveZendeskConnection({ env, fetchImpl: stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "not_connected");
    assert.match(error.message, /FOO_ZENDESK_NANGO_CONNECTION/);
    assert.match(error.message, /FOO_ZENDESK_API_TOKEN/);
    return true;
  });
});

test("Nango OAuth2 comment access is observed from scopes, never assumed (R-005)", async () => {
  const granted = makeStub({ FOO_ZENDESK_NANGO_INTEGRATION: "zendesk" });
  granted.stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "tickets:read read" } } });
  const ok = await resolveZendeskConnection({ env: granted.env, fetchImpl: granted.stub.fetch });
  assert.equal(ok.broker, "nango");
  assert.equal(ok.comment_scope, "granted");
  assert.equal(ok.subdomain, "foohelp");
  assert.equal(ok.credential.type, "oauth2");
  // The Nango request names the zendesk integration and carries the secret.
  assert.equal(granted.stub.log[0]!.url.includes("/connection/conn_company"), true);
  assert.equal(new URL(granted.stub.log[0]!.url).searchParams.get("provider_config_key"), "zendesk");

  const missing = makeStub();
  missing.stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "tickets:write" } } });
  assert.equal((await resolveZendeskConnection({ env: missing.env, fetchImpl: missing.stub.fetch })).comment_scope, "missing");

  const unknown = makeStub();
  unknown.stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "tok" } });
  assert.equal((await resolveZendeskConnection({ env: unknown.env, fetchImpl: unknown.stub.fetch })).comment_scope, "unknown");
});

test("Nango failures map to typed not_connected / provider_failure codes without leaking responses", async () => {
  for (const [status, code] of [[401, "not_connected"], [403, "not_connected"], [404, "not_connected"], [500, "provider_failure"]] as const) {
    const { stub, env } = makeStub();
    stub.nangoStatus = status;
    await assert.rejects(resolveZendeskConnection({ env, fetchImpl: stub.fetch }), (error: ZendeskRuntimeError) => {
      assert.equal(error.code, code, `${status}`);
      assert.doesNotMatch(error.message, /nango-secret-test/);
      return true;
    });
  }
  // An OAuth2 connection with no token is auth_expired, not a crash.
  const empty = makeStub();
  empty.stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "" } });
  await assert.rejects(resolveZendeskConnection({ env: empty.env, fetchImpl: empty.stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "auth_expired");
    return true;
  });
  // A credential type productfoo does not support for Zendesk fails closed.
  const basic = makeStub();
  basic.stub.nangoBody = () => ({ credentials: { type: "BASIC", username: "u", password: "p" } });
  await assert.rejects(resolveZendeskConnection({ env: basic.env, fetchImpl: basic.stub.fetch }), (error: ZendeskRuntimeError) => {
    assert.equal(error.code, "not_connected");
    assert.match(error.message, /credential type productfoo does not support for Zendesk/);
    return true;
  });
});

// --- T-005: the read-only client ----------------------------------------------

function directClient(stub: Stub): ZendeskClient {
  return new ZendeskClient({ type: "basic", username: "admin@foo.example/token", password: "zendesk-token" }, "foohelp", { fetchImpl: stub.fetch, sleep: async () => {}, now: () => Date.parse(NOW) });
}

test("every write-shaped request is refused at the single choke point (R-009)", async () => {
  const { stub } = makeStub();
  const client = directClient(stub);
  // PUT/DELETE are never issued at all (the method type is GET|POST); a POST
  // outside the read-only whitelist is the vector the choke point exists for.
  for (const pathname of ["/api/v2/tickets.json", "/api/v2/tickets/123.json", "/api/v2/organizations.json"]) {
    // @ts-expect-error deliberate hostile call: the public surface only offers read paths
    await assert.rejects(client.request("POST", pathname, { subject: "x" }), (error: unknown) => error instanceof SourceWriteRefused);
  }
  assert.equal(stub.log.length, 0, "no request may leave before the refusal");
  // The substrate's own refusal helper is what the choke point calls.
  assert.throws(() => refuseSourceWrite("zendesk POST /api/v2/tickets.json"), SourceWriteRefused);
});

test("request counters observe exactly what was asked, and the comment read carries exactly one ticket id (R-007)", async () => {
  const { stub } = makeStub();
  const client = directClient(stub);
  await client.listTickets({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }, { external_domains: ["exampletonbros.example"] });
  await client.users([7, 8]);
  await client.brands();
  await client.comments("4321");
  assert.deepEqual(client.requests, { list: 1, users: 1, brands: 1, comments: 1 });
  // Exactly one comment read, one ticket id, no batching seam. Refused ids
  // never count and never reach the wire.
  await assert.rejects(client.comments("4321 999"), (error: ZendeskRuntimeError) => error.code === "provider_failure");
  await assert.rejects(client.comments("../admin"), (error: ZendeskRuntimeError) => error.code === "provider_failure");
  assert.equal(client.requests.comments, 1, "refused calls are not counted at all");
  const commentCalls = stub.log.filter((entry) => entry.url.includes("/api/v2/tickets/") && entry.url.includes("/comments.json"));
  assert.equal(commentCalls.length, 1);
  assert.equal(new URL(commentCalls[0]!.url).pathname, "/api/v2/tickets/4321/comments.json");
});

test("the listing query is the pinned believed construction, narrowed by every selector kind (R-004)", async () => {
  const { stub } = makeStub();
  const client = directClient(stub);
  stub.log.length = 0;
  await client.listTickets({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }, { external_domains: ["exampletonbros.example", "acme.io"], organizations: ["Exampleton Brothers"], brands: ["Exampleton Brothers Help"] });
  const requested = new URL(stub.log[0]!.url);
  assert.equal(requested.pathname, "/api/v2/search/export.json");
  assert.equal(
    requested.searchParams.get("query"),
    `type:ticket status:solved,closed created>=2026-09-01 created<=2026-09-21 (requester.email:*@exampletonbros.example OR requester.email:*@acme.io) organization:"Exampleton Brothers" brand:"Exampleton Brothers Help"`,
  );
});

test("provider error statuses map to typed codes and never embed the response body", async () => {
  for (const [status, code] of [[401, "auth_expired"], [403, "access_denied"], [429, "budget_exhausted"], [404, "provider_failure"], [502, "provider_failure"]] as const) {
    const { stub } = makeStub();
    stub.zendeskStatus = status;
    const client = directClient(stub);
    await assert.rejects(client.comments("4321"), (error: ZendeskRuntimeError) => {
      assert.equal(error.code, code, `${status}`);
      assert.doesNotMatch(error.message, /secret|token/i);
      return true;
    });
  }
});

test("policy ceilings are the versioned constants the worker reports (R-010)", () => {
  assert.equal(ZENDESK_POLICY.policy_version, "zendesk-local-worker-0.1");
  assert.equal(ZENDESK_POLICY.max_list_pages, 5);
  assert.ok(ZENDESK_POLICY.max_model_input_tokens >= 1_000);
  assert.ok(ZENDESK_POLICY.min_request_interval_ms > 0);
});

// --- T-006: the worker end to end ---------------------------------------------
// The same fixture server drives `foo discovery zendesk ready|list|process`:
// metadata-only listing and matching, then exactly one proof-authorized
// comment-thread read and one synthesis request, with canaries proving the raw
// thread and credentials never reach disk, output, or Git.

const CANARY = "CANARY_RAW_THREAD_5e7b";
const TICKET_ID = "4321";
const REQUESTER_USER = 7;
const AGENT_USER = 11;
const OTHER_DOMAIN_USER = 21;
const NOW_TS = "2026-09-24T18:00:00.000Z";
const TARGET = "inbox:zendesk_exampleton_q3";

function workerFixture(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-zendesk-worker-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: zendesk_exampleton_q3",
    "    provider: zendesk",
    "    connection_alias: company",
    "    time_window: {start: 2026-09-23T00:00:00Z, end: 2026-09-25T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: [exampletonbros.example]",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW_TS}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function defaultSearchBody(): unknown {
  return {
    results: [
      { id: 4321, subject: "Notebook export trouble", status: "solved", created_at: "2026-09-24T12:00:00Z", solved_at: "2026-09-24T16:00:00Z", requester_id: REQUESTER_USER, brand_id: 9 },
      { id: 4322, subject: "Billing portal feedback", status: "closed", created_at: "2026-09-24T13:00:00Z", solved_at: "2026-09-24T17:00:00Z", requester_id: OTHER_DOMAIN_USER, brand_id: 9 },
      { id: 4323, subject: "Undo history missing", status: "open", created_at: "2026-09-24T14:00:00Z", requester_id: REQUESTER_USER, brand_id: 9 },
      { id: 4324, subject: "Solved long before the window", status: "solved", created_at: "2026-09-24T15:00:00Z", solved_at: "2026-09-01T00:00:00Z", requester_id: REQUESTER_USER, brand_id: 9 },
    ],
    meta: { has_more: false, after_cursor: null },
  };
}

function defaultUsersBody(): unknown {
  return {
    users: [
      { id: REQUESTER_USER, name: "Chris Exampleton", email: "chris@exampletonbros.example", role: "end-user" },
      { id: AGENT_USER, name: "Taylor Fixture", email: "taylor@foo.example", role: "agent" },
      { id: OTHER_DOMAIN_USER, name: "Other Corp", email: "ceo@othercorp.com", role: "end-user" },
    ],
  };
}

function defaultCommentsBody(): unknown {
  return {
    comments: [
      { id: 1, author_id: REQUESTER_USER, body: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}`, public: true, created_at: "2026-09-24T14:05:00Z" },
      { id: 2, author_id: AGENT_USER, body: "Thanks — we can set that up after the Q3 review.", public: false, created_at: "2026-09-24T15:00:00Z" },
    ],
  };
}

function workerDeps(stub: Stub, extra: Record<string, string | undefined> = {}): ZendeskDiscoveryDeps {
  return {
    fetchImpl: stub.fetch,
    env: {
      FOO_ZENDESK_SUBDOMAIN: "foohelp",
      NANGO_SECRET_KEY: "nango-secret-test",
      FOO_ZENDESK_NANGO_CONNECTION: "conn_company",
      ANTHROPIC_API_KEY: "anthropic-test-key",
      ...extra,
    },
    now: () => NOW_TS,
    sleep: async () => undefined,
  };
}

function commentsRequests(stub: Stub) {
  return stub.log.filter((entry) => /\/api\/v2\/tickets\/\d+\/comments\.json$/.test(new URL(entry.url).pathname));
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

test("worker ready: Nango brokers the company credential, one metadata probe proves listing, nothing private is printed", async () => {
  const { stub } = makeStub();
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "nango-zendesk-token", raw: { scope: "tickets:read read" } } });
  const { root } = workerFixture();
  const ready = await runZendeskDiscovery(root, ["ready", "--json"], workerDeps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "workspace");
  assert.equal(coverage.credential_type, "oauth2");
  assert.equal(coverage.capabilities.open_transcript, true);
  assert.equal(coverage.policy.max_list_pages, ZENDESK_POLICY.max_list_pages);
  assert.match(String(coverage.connection), /^zendesk:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|foohelp|Basic /);
  assert.equal(commentsRequests(stub).length, 0);
});

test("worker not connected: without any Zendesk configuration the run stops with a handoff and makes zero provider calls", async () => {
  const { stub } = makeStub();
  const { root, inbox } = workerFixture();
  approve(inbox, { ingress_path: "nango", provider: "zendesk", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:zendesk_exampleton_q3", by: "taylor", at: NOW_TS });
  const listed = await runZendeskDiscovery(root, ["list", TARGET, "--json"], workerDeps(stub, { NANGO_SECRET_KEY: undefined, FOO_ZENDESK_NANGO_CONNECTION: undefined, FOO_ZENDESK_API_TOKEN: undefined, FOO_ZENDESK_API_TOKEN_EMAIL: undefined }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0);
});

test("worker list + process: bounded listing narrows to the solved window and external domains, one matched ticket, exactly one comments request with one id, sanitized evidence applied, canary absent everywhere", async () => {
  const { stub } = makeStub();
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "nango-zendesk-token", raw: { scope: "tickets:read read" } } });
  stub.searchBody = defaultSearchBody;
  stub.usersBody = defaultUsersBody;
  stub.brandsBody = () => ({ brands: [{ id: 9, name: "Exampleton Brothers Help" }] });
  stub.commentsBody = defaultCommentsBody;
  const { root, inbox } = workerFixture();
  approve(inbox, { ingress_path: "nango", provider: "zendesk", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:zendesk_exampleton_q3", by: "taylor", at: NOW_TS });

  const listed = await runZendeskDiscovery(root, ["list", TARGET, "--json"], workerDeps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.tickets_listed, 4);
  // The solved/closed admissibility gate plus post-list narrowing: the
  // out-of-domain requester is excluded on the domain allowlist, the open
  // ticket (no observed solved_at) and the solved-outside-window ticket fail
  // the window, and exactly one ticket stays a candidate.
  assert.equal(listCoverage.domain_excluded, 1);
  assert.equal(listCoverage.incomplete_excluded, 2);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.thread_opened, false);
  assert.equal(commentsRequests(stub).length, 0, "listing never opens a comment thread");
  assert.doesNotMatch(listed.output, new RegExp(`${TICKET_ID}|chris@|exampletonbros\\.com`), "no ticket id or address on the list surface");

  const processed = await runZendeskDiscovery(root, ["process", TARGET, "--json"], workerDeps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.thread_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const threadCalls = commentsRequests(stub);
  assert.equal(threadCalls.length, 1);
  assert.equal(new URL(threadCalls[0]!.url).pathname, `/api/v2/tickets/${TICKET_ID}/comments.json`, "exactly one ticket id, one read");

  // Evidence landed, review stops automation, and the raw thread is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds thread text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|ceo@othercorp\.com|nango-secret-test|anthropic-test-key/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|nango-secret|anthropic-test/);
  // The one-time proof was consumed: a repeat cannot open the thread again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_zendesk_exampleton_q3", "proof.json")), false);
  const again = await runZendeskDiscovery(root, ["process", TARGET, "--json"], workerDeps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(commentsRequests(stub).length, 1, "no second thread read without a fresh match and proof");
});

test("worker unapproved scope: a unique match stops at needs_source_approval with the exact handoff and no thread read", async () => {
  const { stub } = makeStub();
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "nango-zendesk-token", raw: { scope: "tickets:read read" } } });
  stub.searchBody = defaultSearchBody;
  stub.usersBody = defaultUsersBody;
  const { root } = workerFixture();
  const listed = await runZendeskDiscovery(root, ["list", TARGET, "--json"], workerDeps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider zendesk --connection company --scope scope:zendesk_exampleton_q3/);
  assert.equal(commentsRequests(stub).length, 0);
  const processed = await runZendeskDiscovery(root, ["process", TARGET, "--json"], workerDeps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(commentsRequests(stub).length, 0);
});

test("worker no-selector scope: a window plus only the workspace selector is invalid before any provider call", async () => {
  const { stub } = makeStub();
  const { root, inbox } = workerFixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: zendesk_window_only",
    "    provider: zendesk",
    "    connection_alias: company",
    "    time_window: {start: 2026-09-23T00:00:00Z, end: 2026-09-25T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW_TS}`,
    "",
  ].join("\n"));
  const listed = await runZendeskDiscovery(root, ["list", "inbox:zendesk_window_only", "--json"], workerDeps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0]!.message, /customer selector/);
  assert.equal(listed.exitCode, 1);
  // Pre-flight: an invalid scope never reaches the network, not even Nango.
  assert.equal(stub.log.length, 0);
});

test("worker page ceiling: a cursor that never ends stops with budget_exhausted at the policy ceiling, repeats the same window on every page, and halts all provider reads", async () => {
  const { stub } = makeStub();
  stub.nangoBody = () => ({ credentials: { type: "OAUTH2", access_token: "nango-zendesk-token", raw: { scope: "tickets:read read" } } });
  stub.searchBody = () => ({
    results: [{ id: 4321, subject: "Notebook export trouble", status: "solved", created_at: "2026-09-24T12:00:00Z", solved_at: "2026-09-24T16:00:00Z", requester_id: REQUESTER_USER, brand_id: 9 }],
    meta: { has_more: true, after_cursor: "next-page" },
  });
  const { root, inbox } = workerFixture();
  approve(inbox, { ingress_path: "nango", provider: "zendesk", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:zendesk_exampleton_q3", by: "taylor", at: NOW_TS });
  const listed = await runZendeskDiscovery(root, ["list", TARGET, "--json"], workerDeps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, ZENDESK_POLICY.max_list_pages);
  // Every page repeats the approved window byte-for-byte: the stop never widens it.
  const queries = new Set(stub.log.filter((entry) => entry.url.includes("/api/v2/search/export.json")).map((entry) => new URL(entry.url).searchParams.get("query")));
  assert.equal(queries.size, 1);
  // Stopped means stopped: no user or brand metadata read after the ceiling, no thread ever.
  assert.equal(stub.log.filter((entry) => entry.url.includes("/api/v2/users/show_many.json")).length, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("/api/v2/brands.json")).length, 0);
  assert.equal(commentsRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_zendesk_exampleton_q3", "match.json")), false);
});

test("worker internal-only refusal: an approved scope that requests internal-only tickets is invalid before any provider call", async () => {
  const { stub } = makeStub();
  const { root, inbox } = workerFixture();
  writeFileSync(path.join(inbox, "scope.yaml"), readFileSync(path.join(inbox, "scope.yaml"), "utf8").replace("state: approved", "state: approved\n    include_internal_only: true"));
  const listed = await runZendeskDiscovery(root, ["list", TARGET, "--json"], workerDeps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0]!.message, /internal or agent-only/i);
  assert.equal(stub.log.length, 0);
});
