// slack-discovery-connector-v0: the contract-only slice. These tests prove
// classification (T-002), scope selection parsing (T-003), thread
// normalization plus the declared permalink form (T-004), and the local
// worker's boundaries end to end against stubbed endpoints. They prove nothing
// about live Slack access — support stays contract_only until the feasibility
// task (T-001) and the company-connected dogfood run (T-007) exist.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runSlackDiscovery, type SlackDiscoveryDeps } from "../src/discoverySlack.js";
import { SLACK_POLICY, SlackClient, SlackRuntimeError } from "../src/slackNango.js";
import { approve, revoke, approvalStates, classifyProvider, slackScopeValidationError, SLACK_SCOPE_LIMITS, type SlackScope } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

// --- T-002: registry --------------------------------------------------------

test("slack is a registered chat source with the strictest classification of the ten", () => {
  const c = classifyProvider("slack");
  assert.equal(c.registered, true);
  assert.equal(c.source_category, "chat");
  assert.equal(c.authority, "supporting");
  assert.equal(c.evidence_class, "decision_context");
  assert.equal(c.sensitivity, "high");
  assert.equal(c.model_exposure, "summary_only");
});

test("registration is classification, not support, and unknown providers stay most-restrictive", () => {
  assert.equal(classifyProvider("slack-hub").registered, false);
  const unknown = classifyProvider("never-heard-of-it");
  assert.equal(unknown.registered, false);
  assert.equal(unknown.source_category, "unknown");
  assert.equal(unknown.authority, "context_only");
  assert.equal(unknown.evidence_class, "context_only");
  assert.equal(unknown.sensitivity, "high");
  assert.equal(unknown.model_exposure, "summary_only");
});

// --- T-003: scope selection -------------------------------------------------

const VALID_SCOPE: SlackScope = {
  channel_ids: ["C0123456789", "C0987654321"],
  thread_ts: ["C0123456789/1679237238.123456"],
  window: { start: "2026-09-01T00:00:00Z", end: "2026-09-15T00:00:00Z" },
};

test("a closed scope with explicit channels, threads, and a window validates", () => {
  assert.equal(slackScopeValidationError(VALID_SCOPE), null);
});

test("windowless and selector-less scopes are invalid (V-003)", () => {
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, window: {} }) ?? "", /bounded time window/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, window: { start: "2026-09-01T00:00:00Z" } }) ?? "", /bounded time window/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, window: { start: "nope", end: "2026-09-15T00:00:00Z" } }) ?? "", /bounded time window/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, window: { start: "2026-09-15T00:00:00Z", end: "2026-09-01T00:00:00Z" } }) ?? "", /must end after it starts/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: [] }) ?? "", /explicit channel IDs/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, thread_ts: ["not-a-ts"] }) ?? "", /thread bounds must be explicit/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, thread_ts: ["C05555555555/1679237238.123456"] }) ?? "", /channels listed in the same scope/);
  // R-004: a channel-and-window scope without thread bounds is not a broad
  // channel grant — it is invalid.
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, thread_ts: undefined }) ?? "", /explicit thread bounds/);
});

test("workspace-wide and wildcard scopes are refused (V-003)", () => {
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: ["*"] }) ?? "", /wildcards/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: ["C0123456789", "*"] }) ?? "", /wildcards/);
});

test("DM and group-DM scopes are refused by construction, not by toggle (V-003, D-002)", () => {
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: ["D0123456789"] }) ?? "", /D-002/);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: ["G0123456789"] }) ?? "", /D-002/);
  // A DM smuggled in beside approved channels refuses the whole scope.
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: ["C0123456789", "D0123456789"] }) ?? "", /D-002/);
});

test("scope ceilings fail closed instead of truncating (RISK-003)", () => {
  const many = Array.from({ length: SLACK_SCOPE_LIMITS.max_channels_per_scope + 1 }, (_, i) => `C01234567${String(i).padStart(2, "0")}`);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, channel_ids: many }) ?? "", /limited to/);
  const threads = Array.from({ length: SLACK_SCOPE_LIMITS.max_threads_per_scope + 1 }, (_, i) => `C0123456789/16792372${String(30 + i)}.123456`);
  assert.match(slackScopeValidationError({ ...VALID_SCOPE, thread_ts: threads }) ?? "", /limited to/);
});

test("approvals accumulate per scope and revoke clears, per the unchanged substrate (C-003)", () => {
  const packetDir = mkdtempSync(path.join(tmpdir(), "foo-slack-scope-"));
  writeFileSync(path.join(packetDir, "events.jsonl"), "");
  const id = { ingress_path: "nango" as const, provider: "slack", connection_id: "company" };
  approve(packetDir, id, { packet: "slack-packet", scope: "scope:slack_customers_q4", by: "taylor", at: "2026-09-24T00:00:00Z" });
  approve(packetDir, id, { packet: "slack-packet", scope: "scope:slack_pricing", by: "taylor", at: "2026-09-24T00:00:00Z" });
  const approved = approvalStates(packetDir).get("slack::company");
  assert.equal(approved?.state, "approved");
  assert.deepEqual(approved?.scopes, ["scope:slack_customers_q4", "scope:slack_pricing"]);
  revoke(packetDir, id, { packet: "slack-packet", by: "taylor", at: "2026-09-24T01:00:00Z" });
  const revoked = approvalStates(packetDir).get("slack::company");
  assert.equal(revoked?.state, "revoked");
  assert.deepEqual(revoked?.scopes, []);
});

// --- T-004: the local worker, end to end against stubbed Nango, Slack, and
// model endpoints. The fixtures pin the provider shapes the packet believes
// (T-001 owns verifying them live); the assertions pin the boundaries that
// must hold regardless: zero provider calls at list time, exactly one thread
// read carrying exactly the approved selector, member labels instead of raw
// workspace identities, a canary absent from every file and output, and
// read-only Slack.

const NOW = "2026-09-24T18:00:00.000Z";
const CHANNEL = "C0123456789";
const THREAD_TS = "1679237238.123456";
const THREAD_SELECTOR = `${CHANNEL}/${THREAD_TS}`;
const MEMBER_A = "U0ABCDEF23";
const MEMBER_B = "U0FEDCBA32";
const CANARY = "CANARY_RAW_THREAD_5b2c";
const TARGET = "inbox:slack_customers_q4";

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: unknown }>;
  repliesBody?: () => unknown;
  modelReply?: () => string;
  nangoStatus?: number;
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    stub.log.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_company");
      assert.equal(parsed.searchParams.get("provider_config_key"), "slack");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      return jsonResponse(200, { id: 7, connection_id: "conn_company", provider_config_key: "slack", credentials: { type: "OAUTH2", access_token: "xoxb-test-token" } }); // foo-redact: allow (synthetic fixture token)
    }
    if (parsed.hostname === "slack.com") {
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer xoxb-test-token"); // foo-redact: allow (synthetic fixture token)
      assert.equal(method, "GET", "Slack reads are GET-only in V0");
      if (parsed.pathname === "/api/conversations.list") {
        return jsonResponse(200, { ok: true, channels: [{ id: CHANNEL, name: "customers" }] });
      }
      if (parsed.pathname === "/api/conversations.replies") {
        assert.equal(parsed.searchParams.get("channel"), CHANNEL);
        assert.equal(parsed.searchParams.get("ts"), THREAD_TS);
        if (stub.repliesBody) {
          const custom = stub.repliesBody();
          return custom instanceof Response ? custom : jsonResponse(200, custom);
        }
        return jsonResponse(200, {
          ok: true,
          messages: [
            { ts: THREAD_TS, user: MEMBER_A, text: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}` },
            { ts: "1679237300.000001", user: MEMBER_B, text: `Same — like ${MEMBER_A} says, the undo path is the whole point for us.` },
            { ts: "1679237400.000001", bot_id: "B01234567", subtype: "thread_broadcast", text: "Automated bookkeeping message." },
          ],
          has_more: false,
        });
      }
      return jsonResponse(200, { ok: false, error: "method_not_supported_for_channel_type" });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.equal(body.model, "claude-opus-5");
      const rendered = body.messages[0].content as string;
      // R-005: thread CONTENT reaches the model in memory (the canary is
      // content); raw member identities do not. The canary screen applies to
      // every durable surface, asserted below over allFiles(root).
      assert.doesNotMatch(rendered, new RegExp(`${MEMBER_A}|${MEMBER_B}`), "the model request must not carry raw member identities");
      assert.match(rendered, /member-/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Reversibility drives the notebook choice", paraphrase: "Members described keeping workshop exercises in a shared notebook so mistakes can be undone.", evidence_type: "stated", locator: THREAD_TS, confidence: "high", dissent: "Only one workflow was described; other teams may differ." },
          { headline: "The undo path matters more than speed", paraphrase: "The thread framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "1679237300.000001", confidence: "medium", dissent: "Inferred from one exchange." },
        ],
        contact_candidates: [{ title: "Director of Ops" }],
        coverage: { transcript_complete: true, caveats: [] },
      });
      return jsonResponse(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 250 } });
    }
    return new Response("", { status: 404 });
  };
  return stub;
}

function fixture(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-slack-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: slack_customers_q4",
    "    provider: slack",
    "    connection_alias: company",
    "    time_window: {start: 2026-09-01T00:00:00Z, end: 2026-09-15T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    `    channel_ids: [${CHANNEL}]`,
    `    thread_ts: ["${THREAD_SELECTOR}"]`,
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function approveScope(inbox: string): void {
  approve(inbox, { ingress_path: "nango", provider: "slack", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:slack_customers_q4", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_SLACK_NANGO_CONNECTION: "conn_company", FOO_SLACK_WORKSPACE_HOST: "acme.slack.com", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<SlackDiscoveryDeps> = {}): SlackDiscoveryDeps {
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

function replyRequests(stub: Stub) {
  return stub.log.filter((entry) => new URL(entry.url).pathname === "/api/conversations.replies");
}

test("ready: Nango brokers the company token, Slack is probed with one metadata call, nothing private is printed", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runSlackDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "workspace");
  assert.equal(coverage.capabilities.open_threads, true);
  assert.equal(coverage.capabilities.stable_link, true);
  assert.equal(coverage.policy.max_response_bytes, SLACK_POLICY.max_response_bytes);
  assert.match(String(coverage.connection), /^slack:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|xoxb/);
  assert.equal(replyRequests(stub).length, 0, "readiness never reads a thread");
});

test("not connected: without Nango configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0, "an unconfigured runtime makes no calls at all");
});

test("list is content-free: the scope's own selection is the listing, zero provider calls, proof minted", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  assert.equal(stub.log.length, 0, "listing performs no provider read; the selection was approved by a person");
  assert.equal(listed.result.coverage.selected_threads, 1);
  assert.equal(listed.result.coverage.transcript_opened, false);
  const local = path.join(root, ".foo", "discovery", "inbox_slack_customers_q4");
  assert.equal(existsSync(path.join(local, "match.json")), true);
  assert.equal(existsSync(path.join(local, "proof.json")), true);
  const match = JSON.parse(readFileSync(path.join(local, "match.json"), "utf8")) as { candidates: Array<{ session: { stable_url?: string } }> };
  assert.equal(match.candidates[0].session.stable_url, `https://acme.slack.com/archives/${CHANNEL}/p${THREAD_TS.replace(".", "")}`);
  assert.doesNotMatch(JSON.stringify(match), new RegExp(`${MEMBER_A}|${MEMBER_B}`), "channel-level provenance only");
});

test("multi-thread scope: list reports ambiguous with the selectors and still makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), readFileSync(path.join(inbox, "scope.yaml"), "utf8").replace(
    `thread_ts: ["${THREAD_SELECTOR}"]`,
    `thread_ts: ["${THREAD_SELECTOR}", "${CHANNEL}/1679237500.123456"]`,
  ));
  approveScope(inbox);
  const listed = await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ambiguous_match");
  assert.match(String(listed.result.handoff), /--thread/);
  assert.equal(stub.log.length, 0);
});

test("list + process: exactly one thread read with the approved selector, member labels only, canary nowhere, contact capture suppressed, proof consumed", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);

  const processed = await runSlackDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review", processed.output);
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.transcript_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const replyCalls = replyRequests(stub);
  assert.equal(replyCalls.length, 1);
  assert.equal(new URL(replyCalls[0].url).searchParams.get("channel"), CHANNEL);
  assert.equal(new URL(replyCalls[0].url).searchParams.get("ts"), THREAD_TS);

  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversibility drives the notebook choice/i);
  assert.match(findings, /unassigned_call_evidence/);
  assert.match(findings, /decision_context/);
  // Contact capture is suppressed for chat: the model proposed a title, and
  // nothing landed on the scope's card.
  assert.doesNotMatch(findings, /Director of Ops/);
  assert.doesNotMatch(findings, /transcript_complete: true/, "summary-only envelopes never claim a raw transcript exists");
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds thread text`);
    assert.doesNotMatch(text, new RegExp(`${MEMBER_A}|${MEMBER_B}|xoxb-test-token|nango-secret-test`), `${file} holds a private value`); // foo-redact: allow (synthetic fixture token)
  }
  assert.doesNotMatch(processed.output, new RegExp(`${CANARY}|${MEMBER_A}|${MEMBER_B}|xoxb`));
  // The one-time proof was consumed: a repeat cannot open the thread again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_slack_customers_q4", "proof.json")), false);
  const again = await runSlackDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(replyRequests(stub).length, 1, "no second thread fetch without a fresh match and proof");
});

test("process --thread: a selector outside the approved scope is refused before any provider call", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const processed = await runSlackDiscovery(root, ["process", TARGET, "--thread", "C0999999999/1679237238.123456", "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.match(processed.result.errors[0].message, /not in the approved scope/);
  assert.equal(stub.log.length, 0);
});

test("unapproved scope: the match stops at needs_source_approval and process opens nothing", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider slack --connection company --scope scope:slack_customers_q4/);
  assert.equal(stub.log.length, 0);
  const processed = await runSlackDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_source_approval");
  assert.equal(stub.log.length, 0);
});

test("truncated thread: has_more is recorded as transcript_complete false with an explicit caveat", async () => {
  const stub = makeStub();
  stub.repliesBody = () => jsonResponse(200, {
    ok: true,
    messages: [{ ts: THREAD_TS, user: MEMBER_A, text: `We keep exercises in a shared notebook. ${CANARY}` }],
    has_more: true,
  });
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runSlackDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  const processed = await runSlackDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_review", processed.output);
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /transcript_complete: false/);
  assert.match(findings, /later replies were not read/);
});

test("the Slack client refuses every write-shaped call before it leaves productfoo (T-005)", async () => {
  // The request surface is (api, params) and GET-only by construction: the
  // method is not a parameter anyone can set. A write-shaped api name must
  // refuse before any network call happens, whatever the caller wanted.
  let networkCalls = 0;
  const client = new SlackClient({ connection_ref: "slack:test", broker: "direct", token: "xoxb-test-token" }, { fetchImpl: async () => { networkCalls += 1; return new Response("", { status: 200 }); }, sleep: async () => undefined }); // foo-redact: allow (synthetic fixture token)
  for (const api of ["chat.postMessage", "chat.update", "chat.delete", "conversations.create", "admin.users.assignment.add"]) {
    let error: unknown;
    try {
      // @ts-expect-error — exercising the private request surface on purpose
      await client.request(api, {});
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, `${api} must be refused`);
    assert.equal((error as Error).name, "SourceWriteRefused", `${api} must be refused as a source write`);
  }
  assert.equal(networkCalls, 0, "refusals happen before any network call");
  assert.equal(client.requests.conversations_replies, 0);
});

test("Slack runtime errors map to the closed discovery status set (T-005)", () => {
  assert.equal(new SlackRuntimeError("auth_expired", "x").code, "auth_expired");
  assert.equal(new SlackRuntimeError("budget_exhausted", "x").code, "budget_exhausted");
  assert.equal(new SlackRuntimeError("thread_too_large", "x").code, "thread_too_large");
  assert.equal(new SlackRuntimeError("not_connected", "x").code, "not_connected");
});
