// gmail-discovery-connector-v0 local worker: end-to-end against stubbed Nango,
// Gmail, and model endpoints. The fixtures pin the provider shapes the packet
// believes (T-001 owns verifying them live); the assertions pin the boundaries
// that must hold regardless: the readiness probe never lists (R-004 forbids a
// label-less read), listing fetches headers only, exactly one full thread read
// carrying exactly one thread id after the gates, a message-body canary absent
// from every file and output, no attachment fetch ever, ceilings that fail
// closed, and a client that cannot write (R-009) and cannot even be asked to.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGmailDiscovery, type GmailDiscoveryDeps } from "../src/discoveryGmail.js";
import { GMAIL_POLICY, GmailClient, GmailRuntimeError, resolveGmailConnection } from "../src/gmailNango.js";
import { approve, SourceWriteRefused } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const CANARY = "CANARY_MAIL_BODY_7c21";
const THREAD_ID = "th_ext_exampleton";
const OWNER = "taylor@foo.example";
const NOW = "2026-07-20T18:00:00.000Z";
// The approved window ends 2026-07-20T00:00:00Z; the quiet-period boundary is
// 48h earlier (2026-07-18T00:00:00Z, D-001's pinned quiet period).
const WINDOW_START = "2026-07-06T00:00:00Z";
const WINDOW_END = "2026-07-20T00:00:00Z";
const AFTER = Math.floor(Date.parse(WINDOW_START) / 1000);
const BEFORE = Math.floor(Date.parse(WINDOW_END) / 1000);

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: unknown }>;
  listBody?: () => unknown;
  threadBody?: () => unknown;
  modelReply?: () => string;
  nangoStatus?: number;
  nangoScope?: string;
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function modelBody(init: RequestInit | undefined): { model: string; messages: Array<{ content: string }> } {
  return JSON.parse(String(init?.body));
}

function message(input: { id: string; threadId: string; from: string; to: string; subject: string; date: string; labels?: string[]; bodyText?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: input.from },
      { name: "To", value: input.to },
      { name: "Subject", value: input.subject },
      { name: "Date", value: input.date },
    ],
  };
  if (input.bodyText !== undefined) {
    // The message body arrives as parts inside the thread response. The
    // attachment part exists so the test can prove it is never fetched or
    // decoded (D-003) — the fixture fails loudly if a body is pulled through
    // the attachments endpoint or the html twin leaks.
    payload.parts = [
      { mimeType: "text/plain", body: { data: base64(input.bodyText) } },
      { mimeType: "text/html", body: { data: base64("<p>html twin</p>") } },
      { mimeType: "application/pdf", filename: "proposal.pdf", body: { attachmentId: "att_1", size: 99999 } },
    ];
  }
  return { id: input.id, threadId: input.threadId, labelIds: input.labels ?? [], internalDate: String(Date.parse(input.date)), payload };
}

// The four listed threads, one per selector/admissibility outcome: a settled
// external thread (the one match), an internal-only thread, an external
// thread still inside the quiet period, and a thread settled by the done-label
// override. Metadata reads carry headers only; only the matched thread's full
// response carries body parts.
function threadMessages(id: string, withBody: boolean): Array<Record<string, unknown>> {
  switch (id) {
    case THREAD_ID:
      return [
        message({ id: "m1", threadId: id, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Workshop follow-up", date: "2026-07-15T09:00:00Z", ...(withBody ? {} : {}) }),
        message({ id: "m2", threadId: id, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Re: Workshop follow-up", date: "2026-07-17T12:00:00Z", labels: ["Label_1"], ...(withBody ? { bodyText: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}` } : {}) }),
      ];
    case "th_int_internal":
      return [message({ id: "i1", threadId: id, from: "Sam Park <sam@foo.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Internal pipeline review", date: "2026-07-10T09:00:00Z" })];
    case "th_recent_ext":
      return [message({ id: "r1", threadId: id, from: "Chris Exampleton <chris@exampletonbros.example>", to: `Taylor Fixture <${OWNER}>`, subject: "Fresh thread", date: "2026-07-19T23:00:00Z" })];
    case "th_done_otherco":
      return [message({ id: "d1", threadId: id, from: "Dev Lead <dev@otherco.io>", to: `Taylor Fixture <${OWNER}>`, subject: "Closed thread", date: "2026-07-16T09:00:00Z", labels: ["done"] })];
    default:
      throw new Error(`unknown fixture thread ${id}`);
  }
}

function defaultListBody(): Record<string, unknown> {
  return {
    threads: [
      { id: THREAD_ID, snippet: "Workshop follow-up" },
      { id: "th_int_internal", snippet: "Internal pipeline review" },
      { id: "th_recent_ext", snippet: "Fresh thread" },
      { id: "th_done_otherco", snippet: "Closed thread" },
    ],
  };
}

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    stub.log.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_company");
      assert.equal(parsed.searchParams.get("provider_config_key"), "google-mail");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      const scope = stub.nangoScope ?? "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.profile";
      return jsonResponse(200, { id: 42, connection_id: "conn_company", provider_config_key: "google-mail", credentials: { type: "OAUTH2", access_token: "gmail-oauth-token", raw: { scope } } });
    }
    if (parsed.hostname === "gmail.googleapis.com") {
      assert.equal(method, "GET", "the Gmail client is read-only");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer gmail-oauth-token");
      if (parsed.pathname === "/gmail/v1/users/me/profile") return jsonResponse(200, { emailAddress: OWNER, messagesTotal: 4, threadsTotal: 4 });
      if (parsed.pathname === "/gmail/v1/users/me/threads") {
        assert.deepEqual(parsed.searchParams.getAll("labelIds"), ["workshop"]);
        assert.equal(parsed.searchParams.get("q"), `after:${AFTER} before:${BEFORE}`);
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        return jsonResponse(200, defaultListBody());
      }
      const threadMatch = /\/gmail\/v1\/users\/me\/threads\/([^?]+)/.exec(parsed.pathname);
      if (threadMatch) {
        const requestedId = decodeURIComponent(threadMatch[1]);
        // No attachment is ever fetched (D-003): the attachments endpoint
        // would fail this stub loudly if the client grew a method for it.
        assert.ok(!parsed.pathname.includes("attachments"), "no attachment fetch");
        if (parsed.search.includes("format=metadata")) {
          // Header-only reads happen for every listed thread; any listed id
          // is legitimate here.
          return jsonResponse(200, { id: requestedId, messages: threadMessages(requestedId, false).map((entry) => ({ ...entry, payload: { headers: (entry.payload as Record<string, unknown>).headers } })) });
        }
        if (parsed.search.includes("format=full")) {
          assert.equal(requestedId, THREAD_ID, "exactly one thread identifier is ever read in full");
          if (stub.threadBody) {
            const custom = stub.threadBody();
            return custom instanceof Response ? custom : jsonResponse(200, custom);
          }
          return jsonResponse(200, { id: THREAD_ID, messages: threadMessages(THREAD_ID, true) });
        }
        return new Response("", { status: 400 });
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
  const root = mkdtempSync(path.join(tmpdir(), "foo-gmail-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: gmail_workshop_q3",
    "    provider: gmail",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-06T00:00:00Z, end: 2026-07-20T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: [exampletonbros.example]",
    "    title_tokens: []",
    "    labels: [workshop]",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function approveScope(inbox: string): void {
  approve(inbox, { ingress_path: "nango", provider: "gmail", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:gmail_workshop_q3", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_GMAIL_NANGO_CONNECTION: "conn_company", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<GmailDiscoveryDeps> = {}): GmailDiscoveryDeps {
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

function fullThreadRequests(stub: Stub) {
  return stub.log.filter((entry) => entry.url.includes("format=full"));
}

const TARGET = "inbox:gmail_workshop_q3";

test("ready: Nango brokers the per-user OAuth grant, the probe is one profile call and never a listing, nothing private is printed", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runGmailDiscovery(root, ["ready", "--json"], deps(stub));
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
  assert.equal(coverage.capabilities.list_sessions, "pending_approved_scope");
  assert.equal(coverage.capabilities.stable_link, false);
  assert.equal(coverage.policy.quiet_period_hours, GMAIL_POLICY.quiet_period_hours);
  assert.match(String(coverage.connection), /^gmail:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|gmail-oauth-token/, "no connection id or token on the surface");
  // R-004: the probe proves the credential with one metadata call; a
  // label-less threads.list would be a mailbox-wide read, so none happens.
  assert.equal((coverage.provider_calls as Record<string, number>).profile, 1);
  assert.equal((coverage.provider_calls as Record<string, number>).list, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("/threads")).length, 0);
});

test("not connected: without Nango configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /FOO_GMAIL_NANGO_CONNECTION/);
  assert.equal(stub.log.length, 0);
});

test("list + process: bounded label+window listing, internal-only and unsettled threads excluded, one matched thread, exactly one full thread read with one id, sanitized evidence applied, canary absent everywhere", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.threads_listed, 4);
  assert.equal(listCoverage.internal_only_excluded, 1);
  // D-001: the recent external thread is in_progress (its last message is
  // after the quiet-period boundary and it carries no done label).
  assert.equal(listCoverage.incomplete_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.bodies_opened, false);
  // Listing fetches headers only: every thread read is format=metadata.
  assert.equal(fullThreadRequests(stub).length, 0, "listing never opens a message body");
  assert.doesNotMatch(listed.output, new RegExp(`${THREAD_ID}|chris@|exampletonbros\\.com`), "no thread id or address on the list surface");

  const processed = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.thread_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const full = fullThreadRequests(stub);
  assert.equal(full.length, 1);
  assert.match(full[0].url, /\/gmail\/v1\/users\/me\/threads\/th_ext_exampleton\?format=full$/, "the one read carries exactly one thread id");

  // Evidence landed, review stops automation, and the raw mailbox is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds message text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|gmail-oauth-token|nango-secret-test/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|gmail-oauth-token|nango-secret/);
  // The one-time proof was consumed: a repeat cannot open the thread again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gmail_workshop_q3", "proof.json")), false);
  const again = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(fullThreadRequests(stub).length, 1, "no second thread fetch without a fresh match and proof");
});

test("unapproved scope: a unique match stops at needs_source_approval with the exact handoff and no thread-body read", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider gmail --connection company --scope scope:gmail_workshop_q3/);
  assert.equal(fullThreadRequests(stub).length, 0);
  const processed = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(fullThreadRequests(stub).length, 0);
});

// R-004 / C-007 fixtures: the label-less, selector-less, and ceiling cases,
// each proving the run stops where the scope ends instead of widening.

test("label-only scope: labels without a customer selector are invalid before any provider call", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: gmail_labels_only",
    "    provider: gmail",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-06T00:00:00Z, end: 2026-07-20T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    labels: [workshop]",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  const listed = await runGmailDiscovery(root, ["list", "inbox:gmail_labels_only", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.equal(listed.exitCode, 1);
  // Pre-flight: an invalid scope never reaches the network, not even Nango.
  assert.equal(stub.log.length, 0);
});

test("selector-less scope without labels is invalid before any provider call: the mailbox itself is never a scope", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: gmail_no_labels",
    "    provider: gmail",
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
  const listed = await runGmailDiscovery(root, ["list", "inbox:gmail_no_labels", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /explicit Gmail label/);
  assert.equal(stub.log.length, 0);
});

test("study lane: gmail evidence is inbox-scoped in V0, so a study target is refused before any provider call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8").replace(/provider: granola/g, "provider: gmail");
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  const listed = await runGmailDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /inbox-scoped in V0/);
  assert.equal(stub.log.length, 0);
});

test("page ceiling: a cursor that never ends stops with budget_exhausted at the policy ceiling, repeats the same window on every page, and halts all provider reads", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    threads: [{ id: THREAD_ID, snippet: "Workshop follow-up" }],
    nextPageToken: "next-page",
  });
  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, GMAIL_POLICY.max_list_pages);
  // Every page repeats the approved window and labels byte-for-byte: the
  // stop never widens them.
  const queries = new Set(stub.log.filter((entry) => entry.url.includes("/gmail/v1/users/me/threads?")).map((entry) => {
    const params = new URL(entry.url).searchParams;
    return `${params.get("q")}|${params.getAll("labelIds").join(",")}`;
  }));
  assert.equal(queries.size, 1);
  // Stopped means stopped: no header reads after the ceiling, no body ever.
  assert.equal(stub.log.filter((entry) => entry.url.includes("format=metadata")).length, 0);
  assert.equal(fullThreadRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gmail_workshop_q3", "match.json")), false);
});

test("missing body scope: metadata matches survive, and list and process both stop at needs_provider_access with the match state intact (R-008)", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.nangoScope = "https://www.googleapis.com/auth/userinfo.profile";
  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_provider_access", listed.output);
  assert.match(String(listed.result.handoff), /gmail\.readonly/);
  assert.equal(fullThreadRequests(stub).length, 0);
  // R-008: matching state survives the degradation — the match the shared
  // command wrote before the access gate is intact.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gmail_workshop_q3", "match.json")), true);
  const processed = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_provider_access");
  assert.match(String(processed.result.handoff), /gmail\.readonly/);
  assert.equal(fullThreadRequests(stub).length, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis without body access");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("ceilings fail closed: an oversized thread response writes nothing, retries nothing, and reports the policy code", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.threadBody = () => new Response("x".repeat(GMAIL_POLICY.max_response_bytes + 1), { status: 200, headers: { "content-type": "application/json" } });
  const processed = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.equal((processed.result.coverage as any).provider_error, "thread_too_large");
  assert.equal(fullThreadRequests(stub).length, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis after an overflow");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

// C-010: every failure class after the gates — timeout, cancel, crash, and
// lost response — stops at exactly one full thread request carrying exactly
// one id: no second attempt, no synthesis, nothing written.
type ThreadFailureMode = "timeout" | "cancel" | "crash" | "lost_response";

async function processWithFailure(mode: ThreadFailureMode): Promise<{ stub: Stub; processed: Awaited<ReturnType<typeof runGmailDiscovery>>; inbox: string }> {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  if (mode === "timeout") {
    // A fetch that only settles when its abort signal fires: with the ceiling
    // narrowed to 50 ms the transport times out. The valve keeps a broken
    // ceiling from hanging the suite (it fails the test instead).
    const inner = stub.fetch;
    stub.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("format=full")) {
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
    return { stub, processed: await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub, { fetchTimeoutMs: 50 })), inbox };
  }
  if (mode === "cancel") {
    // Headers arrive, then the body stream is torn down mid-read.
    stub.threadBody = () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"th_ext_exampleton","messages":'));
          controller.error(new Error("stream canceled"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (mode === "crash") stub.threadBody = () => { throw new Error("connection reset"); };
  if (mode === "lost_response") stub.threadBody = () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  return { stub, processed: await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub)), inbox };
}

test("no automatic retry: timeout, cancel, crash, and lost response each stop at exactly one thread request with one id and nothing written", async () => {
  const expected: Record<ThreadFailureMode, { status: string; provider_error?: string; handoff?: RegExp }> = {
    timeout: { status: "invalid", provider_error: "provider_timeout", handoff: /no retry was attempted/ },
    cancel: { status: "needs_research_proof", handoff: /fresh proof/ },
    crash: { status: "invalid", provider_error: "network" },
    lost_response: { status: "invalid", provider_error: "provider_failure" },
  };
  for (const mode of ["timeout", "cancel", "crash", "lost_response"] as ThreadFailureMode[]) {
    const { stub, processed, inbox } = await processWithFailure(mode);
    const calls = fullThreadRequests(stub);
    assert.equal(calls.length, 1, `${mode}: exactly one thread request, no second attempt`);
    assert.match(calls[0].url, /threads\/th_ext_exampleton\?format=full$/, `${mode}: the one request carries exactly one thread id`);
    assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, `${mode}: no synthesis after the failure`);
    assert.equal(processed.result.status, expected[mode].status, `${mode}: ${processed.output}`);
    if (expected[mode].provider_error) assert.equal((processed.result.coverage as Record<string, unknown>).provider_error, expected[mode].provider_error, mode);
    if (expected[mode].handoff) assert.match(String(processed.result.handoff), expected[mode].handoff, mode);
    assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/, `${mode}: nothing was written`);
  }
});

test("privacy screen: derived text naming a thread participant is refused and nothing is written", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runGmailDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Notebook workflow", paraphrase: "Chris Exampleton keeps exercises in a notebook.", evidence_type: "stated", locator: "none available", confidence: "high", dissent: "none recorded" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runGmailDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.match(processed.result.errors[0].message, /identity/);
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("sync: metadata and match across Gmail lanes only; a message body is never opened by sync", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runGmailDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.result.status, "ok", synced.output);
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.lanes, 1);
  assert.equal(coverage.threads_opened, 0);
  assert.equal(fullThreadRequests(stub).length, 0);
  assert.match(synced.result.next_actions.join("\n"), /process inbox:gmail_workshop_q3/);
});

test("read-only: any non-read Gmail operation is refused at the single choke point, no attachment method exists, and a malformed thread id is refused before the network", async () => {
  const stub = makeStub();
  const connection = await resolveGmailConnection({ env: env(), fetchImpl: stub.fetch });
  const client = new GmailClient(connection.credential, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const request = (client as unknown as { request: (method: "GET" | "POST", pathname: string, maxBytes?: number) => Promise<unknown> }).request.bind(client);
  await assert.rejects(request("POST", "/gmail/v1/users/me/threads/x"), SourceWriteRefused, "a write attempt lands at the one choke point");
  // A read passes the same gate and reaches the transport: the stub answers
  // the profile call, proving reads are not collateral damage of the gate.
  await request("GET", "/gmail/v1/users/me/profile", 16 * 1024);
  // R-009's structural half (D-003): there is no attachment fetch to misuse —
  // the method does not exist on the class.
  const methods = Object.getOwnPropertyNames(GmailClient.prototype);
  assert.ok(!methods.some((name) => /attach/i.test(name)), `no attachment method on ${methods.join(", ")}`);
  await assert.rejects(client.thread("one two"), GmailRuntimeError);
  await assert.rejects(client.threadMetadata(""), GmailRuntimeError);
  // Only the explicit profile read reached the transport; the malformed ids
  // never did.
  assert.deepEqual(stub.log.filter((entry) => entry.url.includes("gmail.googleapis.com")).map((entry) => entry.url), ["https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
});

test("Nango failures are typed and content-free: a refused secret is not_connected, a grant without the body scope reports it missing", async () => {
  const stub = makeStub();
  stub.nangoStatus = 401;
  await assert.rejects(resolveGmailConnection({ env: env(), fetchImpl: stub.fetch }), (error: unknown) => error instanceof GmailRuntimeError && error.code === "not_connected");
  const readonly: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "https://www.googleapis.com/auth/gmail.readonly" } } });
  const granted = await resolveGmailConnection({ env: env(), fetchImpl: readonly });
  assert.equal(granted.body_scope, "granted");
  const narrow: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "https://www.googleapis.com/auth/userinfo.profile" } } });
  const missing = await resolveGmailConnection({ env: env(), fetchImpl: narrow });
  assert.equal(missing.body_scope, "missing");
  const opaque: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok" } });
  const unknown = await resolveGmailConnection({ env: env(), fetchImpl: opaque });
  assert.equal(unknown.body_scope, "unknown");
});
