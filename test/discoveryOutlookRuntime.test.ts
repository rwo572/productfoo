// outlook-discovery-connector-v0 local worker: end-to-end against stubbed
// Nango, Microsoft Graph, and model endpoints. The fixtures pin the Graph
// shapes the packet believes (T-001 owns verifying them live); the assertions
// pin the boundaries that must hold regardless: the readiness probe never
// lists (R-004 forbids a folder-less read), listing fetches metadata only
// (no body select, pinned filter on every page), exactly one full
// conversation read carrying exactly one conversation id after the gates, a
// message-body canary absent from every file and output, the html twin
// dropped, no attachment fetch ever, ceilings that fail closed, and a client
// that cannot write (R-009) and cannot even be asked to.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runOutlookDiscovery, type OutlookDiscoveryDeps } from "../src/discoveryOutlook.js";
import { OUTLOOK_POLICY, OutlookClient, OutlookRuntimeError, resolveOutlookConnection } from "../src/outlookNango.js";
import { approve, SourceWriteRefused } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const CANARY = "CANARY_MAIL_BODY_7c21";
const CONVERSATION_ID = "conv_ext_exampleton";
const OWNER = "taylor@foo.example";
const NOW = "2026-07-20T18:00:00.000Z";
// The approved window ends 2026-07-20T00:00:00Z; the quiet-period boundary is
// 48h earlier (2026-07-18T00:00:00Z, D-001's pinned quiet period).
const WINDOW_START = "2026-07-06T00:00:00Z";
const WINDOW_END = "2026-07-20T00:00:00Z";
// The pinned OData filter the worker issues for the approved window: byte-
// identical on every page of the listing.
const PINNED_FILTER = `receivedDateTime ge ${WINDOW_START} and receivedDateTime le ${WINDOW_END}`;

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: unknown }>;
  listBody?: () => unknown;
  conversationBody?: () => Response;
  modelReply?: () => string;
  nangoStatus?: number;
  nangoScope?: string;
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function modelBody(init: RequestInit | undefined): { model: string; messages: Array<{ content: string }> } {
  return JSON.parse(String(init?.body));
}

function parseLoggedBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Graph's structured address: { emailAddress: { name, address } }.
function graphAddress(display: string): Record<string, unknown> {
  const match = /^(.*) <([^>]+)>$/.exec(display);
  if (!match) throw new Error(`bad fixture address ${display}`);
  return { emailAddress: { name: match[1], address: match[2] } };
}

function message(input: { id: string; conversationId: string; from: string; to: string; subject: string; date: string; categories?: string[]; bodyText?: string; bodyHtml?: string; hasAttachments?: boolean }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    receivedDateTime: input.date,
    categories: input.categories ?? [],
    hasAttachments: input.hasAttachments === true,
    from: graphAddress(input.from),
    toRecipients: [graphAddress(input.to)],
    ccRecipients: [],
  };
  if (input.bodyText !== undefined) payload.body = { contentType: "text", content: input.bodyText };
  else if (input.bodyHtml !== undefined) payload.body = { contentType: "html", content: input.bodyHtml };
  return payload;
}

// The four listed conversations, one per selector/admissibility outcome: a
// settled external conversation (the one match), an internal-only
// conversation, an external conversation still inside the quiet period, and
// a conversation settled by the done-category override. The folder listing
// carries metadata only — bodies appear solely in the matched conversation's
// full read, where the html twin on m1 carries the canary too: the transcript
// must show it exactly once (m2's text body), proving the twin was dropped
// rather than stored.
function conversationMessages(conversationId: string, withBody: boolean): Array<Record<string, unknown>> {
  switch (conversationId) {
    case CONVERSATION_ID:
      return [
        message({ id: "m1", conversationId, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Workshop follow-up", date: "2026-07-15T09:00:00Z", ...(withBody ? { bodyHtml: `<p>html twin ${CANARY}</p>` } : {}) }),
        message({ id: "m2", conversationId, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Re: Workshop follow-up", date: "2026-07-17T12:00:00Z", categories: ["workshop"], ...(withBody ? { bodyText: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}`, hasAttachments: true } : {}) }),
      ];
    case "conv_int_internal":
      return [message({ id: "i1", conversationId, from: "Sam Park <sam@foo.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Internal pipeline review", date: "2026-07-10T09:00:00Z" })];
    case "conv_recent_ext":
      return [message({ id: "r1", conversationId, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Fresh thread", date: "2026-07-19T23:00:00Z" })];
    case "conv_done_otherco":
      return [message({ id: "d1", conversationId, from: "Dev Lead <dev@otherco.io>", to: `Taylor Fixture <${OWNER}>`, subject: "Closed thread", date: "2026-07-16T09:00:00Z", categories: ["done"] })];
    default:
      throw new Error(`unknown fixture conversation ${conversationId}`);
  }
}

function defaultListBody(): Record<string, unknown> {
  return {
    value: [
      ...conversationMessages(CONVERSATION_ID, false),
      ...conversationMessages("conv_int_internal", false),
      ...conversationMessages("conv_recent_ext", false),
      ...conversationMessages("conv_done_otherco", false),
    ],
  };
}

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    stub.log.push({ method, url, body: parseLoggedBody(init?.body) });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_company");
      assert.equal(parsed.searchParams.get("provider_config_key"), "microsoft-outlook");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      const scope = stub.nangoScope ?? "Mail.Read User.Read";
      return jsonResponse(200, { id: 42, connection_id: "conn_company", provider_config_key: "microsoft-outlook", credentials: { type: "OAUTH2", access_token: "outlook-oauth-token", raw: { scope } } });
    }
    if (parsed.hostname === "graph.microsoft.com") {
      assert.equal(method, "GET", "the Outlook client is read-only");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer outlook-oauth-token");
      assert.equal(parsed.pathname.startsWith("/v1.0/"), true, "all reads stay on the pinned Graph version");
      // No attachment resource is ever fetched (D-003): the attachments path
      // would fail this stub loudly if the client grew a method for it.
      assert.ok(!parsed.pathname.includes("attachments"), "no attachment fetch");
      if (parsed.pathname === "/v1.0/me") {
        assert.equal(parsed.searchParams.get("$select"), "mail,userPrincipalName");
        return jsonResponse(200, { mail: OWNER, userPrincipalName: OWNER });
      }
      const folderMatch = /\/v1\.0\/me\/mailFolders\/([^/]+)\/messages$/.exec(parsed.pathname);
      if (folderMatch) {
        // Metadata-only listing: the select never carries a body, the filter
        // pins the approved window, and the folder is the approved one.
        assert.equal(decodeURIComponent(folderMatch[1]), "Inbox");
        assert.ok(!parsed.searchParams.get("$select")!.includes("body"), "listing never selects a body");
        assert.equal(parsed.searchParams.get("$filter"), PINNED_FILTER);
        assert.equal(parsed.searchParams.get("$orderby"), "receivedDateTime asc");
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        return jsonResponse(200, defaultListBody());
      }
      if (parsed.pathname === "/v1.0/me/messages") {
        const filter = parsed.searchParams.get("$filter") ?? "";
        const ids = filter.match(/conversationId eq '([^']+)'/g) ?? [];
        assert.equal(ids.length, 1, "every conversation read carries exactly one conversation id");
        const requestedId = /conversationId eq '([^']+)'/.exec(filter)![1];
        if (parsed.searchParams.get("$select")!.includes("body")) {
          assert.equal(requestedId, CONVERSATION_ID, "exactly one conversation identifier is ever read in full");
          assert.equal((init?.headers as Record<string, string>).prefer, 'outlook.body-content-type="Text"');
          if (stub.conversationBody) return stub.conversationBody();
          return jsonResponse(200, { value: conversationMessages(CONVERSATION_ID, true) });
        }
        // The headers-only read: participants and dates, no body selected.
        return jsonResponse(200, { value: conversationMessages(requestedId, false) });
      }
      return new Response("", { status: 404 });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.equal(init?.method, "POST");
      assert.equal(modelBody(init).model, "claude-opus-5");
      assert.match(modelBody(init).messages[0].content, /TRANSCRIPT/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: "none available", confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
          { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "none available", confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
        ],
        contact_candidates: [{ full_name: "Chris Exampleton", company: "Exampleton Brothers" }],
        coverage: { transcript_complete: true, caveats: [] },
      });
      return jsonResponse(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 300 } });
    }
    return new Response("", { status: 404 });
  };
  return stub;
}

function fixture(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-outlook-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: outlook_workshop_q3",
    "    provider: outlook",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-06T00:00:00Z, end: 2026-07-20T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: [exampletonbros.example]",
    "    title_tokens: []",
    "    folders: [Inbox]",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function approveScope(inbox: string): void {
  approve(inbox, { ingress_path: "nango", provider: "outlook", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:outlook_workshop_q3", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_OUTLOOK_NANGO_CONNECTION: "conn_company", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<OutlookDiscoveryDeps> = {}): OutlookDiscoveryDeps {
  return { fetchImpl: stub.fetch, env: env(), now: () => NOW, sleep: async () => undefined, ...extra };
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

function fullConversationRequests(stub: Stub) {
  return stub.log.filter((entry) => entry.url.includes("/me/messages?") && new URL(entry.url).searchParams.get("$select")?.includes("body"));
}

const TARGET = "inbox:outlook_workshop_q3";

test("ready: Nango brokers the per-user OAuth grant, the probe is one profile call and never a listing, nothing private is printed", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runOutlookDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  // R-010: the mailbox is personal even at work — ownership is reported as
  // the user's, never as the workspace's.
  assert.equal(coverage.connection_owner, "user");
  assert.equal(coverage.credential_type, "oauth2");
  assert.equal(coverage.credential_broker, "nango");
  assert.equal(coverage.body_scope, "granted");
  assert.equal(coverage.capabilities.list_conversations, "pending_approved_scope");
  assert.equal(coverage.capabilities.stable_link, false);
  assert.equal(coverage.policy.quiet_period_hours, OUTLOOK_POLICY.quiet_period_hours);
  assert.match(String(coverage.connection), /^outlook:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|outlook-oauth-token/, "no connection id or token on the surface");
  // R-004: the probe proves the credential with one metadata call; a
  // folder-less messages list would be a mailbox-wide read, so none happens.
  assert.equal((coverage.provider_calls as Record<string, number>).profile, 1);
  assert.equal((coverage.provider_calls as Record<string, number>).list, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("/mailFolders/")).length, 0);
});

test("not connected: without Nango configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /FOO_OUTLOOK_NANGO_CONNECTION/);
  assert.equal(stub.log.length, 0);
});

test("list + process: bounded folder+window listing, internal-only and unsettled conversations excluded, one matched conversation, exactly one full read with one id, html twin dropped, sanitized evidence applied, canary absent everywhere", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.conversations_listed, 4);
  assert.equal(listCoverage.internal_only_excluded, 1);
  // D-001: the recent external conversation is in_progress (its last message
  // is after the quiet-period boundary and it carries no done category).
  assert.equal(listCoverage.incomplete_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.bodies_opened, false);
  // Listing fetches metadata only: no conversation read ever selects a body.
  assert.equal(fullConversationRequests(stub).length, 0, "listing never opens a message body");
  assert.doesNotMatch(listed.output, new RegExp(`${CONVERSATION_ID}|chris@|exampletonbros\\.com`), "no conversation id or address on the list surface");

  const processed = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.conversation_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const full = fullConversationRequests(stub);
  assert.equal(full.length, 1);
  const fullFilter = new URL(full[0].url).searchParams.get("$filter")!;
  assert.match(fullFilter, new RegExp(`^conversationId eq '${CONVERSATION_ID}'$`), "the one read carries exactly one conversation id");
  // The html twin is dropped, not stored: the transcript the model received
  // shows the canary exactly once (m2's text body), though both bodies
  // carried it into process memory.
  const anthropic = stub.log.find((entry) => entry.url.includes("api.anthropic.com"));
  const transcript = (anthropic!.body as { messages: Array<{ content: string }> }).messages[0].content;
  assert.equal(transcript.split(CANARY).length - 1, 1, "the html twin never reaches the model transcript");

  // Evidence landed, review stops automation, and the raw mailbox is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds message text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|outlook-oauth-token|nango-secret-test/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|outlook-oauth-token|nango-secret/);
  // The one-time proof was consumed: a repeat cannot open the conversation again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_outlook_workshop_q3", "proof.json")), false);
  const again = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(fullConversationRequests(stub).length, 1, "no second conversation fetch without a fresh match and proof");
});

test("unapproved scope: a unique match stops at needs_source_approval with the exact handoff and no conversation-body read", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider outlook --connection company --scope scope:outlook_workshop_q3/);
  assert.equal(fullConversationRequests(stub).length, 0);
  const processed = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(fullConversationRequests(stub).length, 0);
});

// R-004 / C-007 fixtures: the folder-less, selector-less, and ceiling cases,
// each proving the run stops where the scope ends instead of widening.

test("folder-only scope: folders without a customer selector are invalid before any provider call", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: outlook_folders_only",
    "    provider: outlook",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-06T00:00:00Z, end: 2026-07-20T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    folders: [Inbox]",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  const listed = await runOutlookDiscovery(root, ["list", "inbox:outlook_folders_only", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.equal(listed.exitCode, 1);
  // Pre-flight: an invalid scope never reaches the network, not even Nango.
  assert.equal(stub.log.length, 0);
});

test("selector-less scope without folders is invalid before any provider call: the mailbox itself is never a scope", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: outlook_no_folders",
    "    provider: outlook",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-06T00:00:00Z, end: 2026-07-20T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: [exampletonbros.example]",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  const listed = await runOutlookDiscovery(root, ["list", "inbox:outlook_no_folders", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /explicit Outlook folder/);
  assert.equal(stub.log.length, 0);
});

test("study lane: outlook evidence is inbox-scoped in V0, so a study target is refused before any provider call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8").replace(/provider: granola/g, "provider: outlook");
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  const listed = await runOutlookDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /inbox-scoped in V0/);
  assert.equal(stub.log.length, 0);
});

test("page ceiling: a nextLink that never ends stops with budget_exhausted at the policy ceiling, repeats the same pinned filter on every page, and halts all provider reads", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    value: conversationMessages(CONVERSATION_ID, false),
    "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$select=id&$filter=${encodeURIComponent(PINNED_FILTER)}&$skiptoken=next-page`,
  });
  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, OUTLOOK_POLICY.max_list_pages);
  // Every page repeats the approved filter and folder byte-for-byte: the
  // stop never widens them, and only the skiptoken advances.
  const pages = stub.log.filter((entry) => entry.url.includes("/mailFolders/"));
  assert.equal(pages.length, OUTLOOK_POLICY.max_list_pages);
  const filters = new Set(pages.map((entry) => new URL(entry.url).searchParams.get("$filter")));
  assert.equal(filters.size, 1);
  assert.equal(new URL(pages[0].url).searchParams.get("$skiptoken"), null, "the first page carries no token");
  assert.equal(new URL(pages[pages.length - 1].url).searchParams.get("$skiptoken"), "next-page");
  // Stopped means stopped: no conversation read after the ceiling, no body ever.
  assert.equal(stub.log.filter((entry) => entry.url.includes("/me/messages?")).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_outlook_workshop_q3", "match.json")), false);
});

test("missing body scope: metadata matches survive, and list and process both stop at needs_provider_access with the match state intact (R-008)", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.nangoScope = "User.Read";
  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_provider_access", listed.output);
  assert.match(String(listed.result.handoff), /Mail\.Read/);
  assert.equal(fullConversationRequests(stub).length, 0);
  // R-008: matching state survives the degradation — the match the shared
  // command wrote before the access gate is intact.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_outlook_workshop_q3", "match.json")), true);
  const processed = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_provider_access");
  assert.match(String(processed.result.handoff), /Mail\.Read/);
  assert.equal(fullConversationRequests(stub).length, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis without body access");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("ceilings fail closed: an oversized conversation response writes nothing, retries nothing, and reports the policy code", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.conversationBody = () => new Response("x".repeat(OUTLOOK_POLICY.max_response_bytes + 1), { status: 200, headers: { "content-type": "application/json" } });
  const processed = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.equal((processed.result.coverage as any).provider_error, "conversation_too_large");
  assert.equal(fullConversationRequests(stub).length, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis after an overflow");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

// C-010: every failure class after the gates — timeout, cancel, crash, and
// lost response — stops at exactly one full conversation request carrying
// exactly one id: no second attempt, no synthesis, nothing written.
type ConversationFailureMode = "timeout" | "cancel" | "crash" | "lost_response";

async function processWithFailure(mode: ConversationFailureMode): Promise<{ stub: Stub; processed: Awaited<ReturnType<typeof runOutlookDiscovery>>; inbox: string }> {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  if (mode === "timeout") {
    // A fetch that only settles when its abort signal fires: with the ceiling
    // narrowed to 50 ms the transport times out. The valve keeps a broken
    // ceiling from hanging the suite (it fails the test instead).
    const inner = stub.fetch;
    stub.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/me/messages?") && new URL(url).searchParams.get("$select")?.includes("body")) {
        stub.log.push({ method: init?.method ?? "GET", url });
        return new Promise<Response>((resolve, reject) => {
          const valve = setTimeout(() => reject(new Error("fixture safety valve: the fetch ceiling never fired")), 2000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(valve);
            reject(new Error("This operation was aborted"));
          });
        });
      }
      return inner(input, init);
    };
    return { stub, processed: await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub, { fetchTimeoutMs: 50 })), inbox };
  }
  if (mode === "cancel") {
    // Headers arrive, then the body stream is torn down mid-read.
    stub.conversationBody = () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"value":${JSON.stringify(conversationMessages(CONVERSATION_ID, true).slice(0, 1))}`));
          controller.error(new Error("stream canceled"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (mode === "crash") stub.conversationBody = () => { throw new Error("connection reset"); };
  if (mode === "lost_response") stub.conversationBody = () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  return { stub, processed: await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub)), inbox };
}

test("no automatic retry: timeout, cancel, crash, and lost response each stop at exactly one conversation request with one id and nothing written", async () => {
  const expected: Record<ConversationFailureMode, { status: string; provider_error?: string; handoff?: RegExp }> = {
    timeout: { status: "invalid", provider_error: "provider_timeout", handoff: /no retry was attempted/ },
    cancel: { status: "needs_research_proof", handoff: /fresh proof/ },
    crash: { status: "invalid", provider_error: "network" },
    lost_response: { status: "invalid", provider_error: "provider_failure" },
  };
  for (const mode of ["timeout", "cancel", "crash", "lost_response"] as ConversationFailureMode[]) {
    const { stub, processed, inbox } = await processWithFailure(mode);
    const calls = fullConversationRequests(stub);
    assert.equal(calls.length, 1, `${mode}: exactly one conversation request, no second attempt`);
    assert.match(new URL(calls[0].url).searchParams.get("$filter")!, new RegExp(`^conversationId eq '${CONVERSATION_ID}'$`), `${mode}: the one request carries exactly one conversation id`);
    assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, `${mode}: no synthesis after the failure`);
    assert.equal(processed.result.status, expected[mode].status, `${mode}: ${processed.output}`);
    if (expected[mode].provider_error) assert.equal((processed.result.coverage as Record<string, unknown>).provider_error, expected[mode].provider_error, mode);
    if (expected[mode].handoff) assert.match(String(processed.result.handoff), expected[mode].handoff, mode);
    assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/, `${mode}: nothing was written`);
  }
});

test("privacy screen: derived text naming a conversation participant is refused and nothing is written", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runOutlookDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Notebook workflow", paraphrase: "Chris Exampleton keeps exercises in a notebook.", evidence_type: "stated", locator: "none available", confidence: "high", dissent: "none recorded" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runOutlookDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.match(processed.result.errors[0].message, /identity/);
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("sync: metadata and match across Outlook lanes only; a message body is never opened by sync", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runOutlookDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.result.status, "ok", synced.output);
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.lanes, 1);
  assert.equal(coverage.conversations_opened, 0);
  assert.equal(fullConversationRequests(stub).length, 0);
  assert.match(synced.result.next_actions.join("\n"), /process inbox:outlook_workshop_q3/);
});

test("read-only: any non-read Graph operation is refused at the single choke point, no attachment method exists, and a malformed conversation id is refused before the network", async () => {
  const stub = makeStub();
  const connection = await resolveOutlookConnection({ env: env(), fetchImpl: stub.fetch });
  const client = new OutlookClient(connection.credential, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const request = (client as unknown as { request: (method: "GET" | "POST", pathname: string, maxBytes?: number) => Promise<unknown> }).request.bind(client);
  await assert.rejects(request("POST", "/v1.0/me/messages"), SourceWriteRefused, "a write attempt lands at the one choke point");
  // A read passes the same gate and reaches the transport: the stub answers
  // the profile call, proving reads are not collateral damage of the gate.
  await request("GET", "/me?$select=mail,userPrincipalName", 16 * 1024);
  // R-009's structural half (D-003): there is no attachment fetch to misuse —
  // the method does not exist on the class.
  const methods = Object.getOwnPropertyNames(OutlookClient.prototype);
  assert.ok(!methods.some((name) => /attach/i.test(name)), `no attachment method on ${methods.join(", ")}`);
  await assert.rejects(client.conversation("one two"), OutlookRuntimeError);
  await assert.rejects(client.conversationMetadata(""), OutlookRuntimeError);
  // Only the explicit profile read reached the transport; the malformed ids
  // never did.
  const graphCalls = stub.log.filter((entry) => entry.url.includes("graph.microsoft.com")).map((entry) => new URL(entry.url));
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0].pathname, "/v1.0/me");
  assert.deepEqual([...graphCalls[0].searchParams.keys()], ["$select"]);
  assert.equal(graphCalls[0].searchParams.get("$select"), "mail,userPrincipalName");
});

test("Nango failures are typed and content-free: a refused secret is not_connected, a grant without the body scope reports it missing", async () => {
  const stub = makeStub();
  stub.nangoStatus = 401;
  await assert.rejects(resolveOutlookConnection({ env: env(), fetchImpl: stub.fetch }), (error: unknown) => error instanceof OutlookRuntimeError && error.code === "not_connected");
  const readonly: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "Mail.Read" } } });
  const granted = await resolveOutlookConnection({ env: env(), fetchImpl: readonly });
  assert.equal(granted.body_scope, "granted");
  const narrow: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "User.Read" } } });
  const missing = await resolveOutlookConnection({ env: env(), fetchImpl: narrow });
  assert.equal(missing.body_scope, "missing");
  const opaque: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok" } });
  const unknown = await resolveOutlookConnection({ env: env(), fetchImpl: opaque });
  assert.equal(unknown.body_scope, "unknown");
});
