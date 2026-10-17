// gong-discovery-connector-v0 local worker: end-to-end against stubbed Nango,
// Gong, and model endpoints. The fixtures pin the provider shapes the packet
// believes (T-001 owns verifying them live); the assertions pin the boundaries
// that must hold regardless: zero transcript calls before the gates, exactly
// one call carrying exactly one id after them, a raw-transcript canary absent
// from every file and output, ceilings that fail closed, and read-only Gong.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGongDiscovery, type GongDiscoveryDeps } from "../src/discoveryGong.js";
import { buildEnvelopeFromSynthesis, type SynthesisTransport } from "../src/discoverySynthesis.js";
import { GONG_POLICY, GongClient, GongRuntimeError, resolveGongConnection } from "../src/gongNango.js";
import { approve, SourceWriteRefused } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const CANARY = "CANARY_RAW_TRANSCRIPT_9f3a";
const CALL_ID = "7782342274025937895";
const INTERNAL_CALL_ID = "111122223333444";
const NOW = "2026-07-20T18:00:00.000Z";

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: unknown }>;
  transcriptBody?: () => unknown;
  listBody?: () => unknown;
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
    stub.log.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_company");
      assert.equal(parsed.searchParams.get("provider_config_key"), "gong");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      return jsonResponse(200, { id: 42, connection_id: "conn_company", provider_config_key: "gong", credentials: { type: "BASIC", username: "gong-access-key", password: "gong-access-secret" } });
    }
    if (parsed.hostname === "api.gong.io") {
      const auth = (init?.headers as Record<string, string>).authorization;
      assert.equal(auth, `Basic ${Buffer.from("gong-access-key:gong-access-secret").toString("base64")}`);
      if (method === "GET" && parsed.pathname === "/v2/calls") {
        assert.ok(parsed.searchParams.get("fromDateTime"));
        assert.ok(parsed.searchParams.get("toDateTime"));
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        return jsonResponse(200, {
          requestId: "r1",
          records: { totalRecords: 2, currentPageSize: 2, currentPageNumber: 0 },
          calls: [
            { id: CALL_ID, url: `https://app.gong.io/call?id=${CALL_ID}`, title: "Discovery call with Exampleton Brothers", started: "2026-07-20T16:00:00Z", duration: 1800, workspaceId: "ws1" },
            { id: INTERNAL_CALL_ID, url: `https://app.gong.io/call?id=${INTERNAL_CALL_ID}`, title: "Internal pipeline review", started: "2026-07-20T15:00:00Z", duration: 900, workspaceId: "ws1" },
          ],
        });
      }
      if (method === "POST" && parsed.pathname === "/v2/calls/extensive") {
        const ids = body.filter.callIds as string[];
        return jsonResponse(200, {
          calls: ids.map((id) => ({
            metaData: { id },
            parties: id === CALL_ID
              ? [
                  { id: "p1", name: "Chris Exampleton", emailAddress: "chris@exampletonbros.example", title: "CEO", affiliation: "External", speakerId: "spk-ext" },
                  { id: "p2", name: "Taylor Fixture", emailAddress: "taylor@foo.example", title: "Founder", affiliation: "Internal", speakerId: "spk-int" },
                ]
              : [{ id: "p3", name: "Taylor Fixture", emailAddress: "taylor@foo.example", affiliation: "Internal", speakerId: "spk-int" }],
          })),
        });
      }
      if (method === "POST" && parsed.pathname === "/v2/calls/transcript") {
        if (stub.transcriptBody) {
          const custom = stub.transcriptBody();
          return custom instanceof Response ? custom : jsonResponse(200, custom);
        }
        return jsonResponse(200, {
          callTranscripts: [{
            callId: body.filter.callIds[0],
            transcript: [
              { speakerId: "spk-int", topic: "Intro", sentences: [{ start: 0, end: 4000, text: "Thanks for joining, Chris." }] },
              { speakerId: "spk-ext", topic: "Problem", sentences: [{ start: 5000, end: 30000, text: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}` }] },
            ],
          }],
        });
      }
      return new Response("", { status: 405 });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.equal(body.model, "claude-opus-5");
      assert.match(body.messages[0].content, /TRANSCRIPT/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: "00:05-00:30", confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
          { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "00:05-00:30", confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
          { headline: "No tooling change is planned", paraphrase: "The customer did not mention any plan to replace the notebook.", evidence_type: "observed", locator: "00:00-00:30", confidence: "low", dissent: "Absence of a statement is weak evidence.", relationship_hint: "new" },
        ],
        contact_candidates: [{ title: "CEO" }],
        coverage: { transcript_complete: true, caveats: [] },
      });
      return jsonResponse(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 300 } });
    }
    return new Response("", { status: 404 });
  };
  return stub;
}

function fixture(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-gong-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: gong_exampleton_q3",
    "    provider: gong",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-19T00:00:00Z, end: 2026-07-21T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: [exampletonbros.example]",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function approveScope(inbox: string): void {
  approve(inbox, { ingress_path: "nango", provider: "gong", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:gong_exampleton_q3", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_GONG_NANGO_CONNECTION: "conn_company", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<GongDiscoveryDeps> = {}): GongDiscoveryDeps {
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

function transcriptRequests(stub: Stub) {
  return stub.log.filter((entry) => entry.url.endsWith("/v2/calls/transcript"));
}

const TARGET = "inbox:gong_exampleton_q3";

test("ready: Nango brokers the company credential, Gong is probed with one metadata call, nothing private is printed", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runGongDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "workspace");
  assert.equal(coverage.credential_type, "basic");
  assert.equal(coverage.capabilities.open_transcript, true);
  assert.equal(coverage.policy.max_response_bytes, GONG_POLICY.max_response_bytes);
  assert.match(String(coverage.connection), /^gong:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|gong-access|Basic /);
  assert.equal(transcriptRequests(stub).length, 0);
});

test("not connected: without Nango configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0);
});

test("list + process: bounded listing, internal-only call excluded, one matched call, exactly one transcript request with one id, sanitized evidence applied, canary absent everywhere", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.calls_listed, 2);
  assert.equal(listCoverage.internal_only_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.transcript_opened, false);
  assert.equal(transcriptRequests(stub).length, 0, "listing never opens a transcript");
  assert.doesNotMatch(listed.output, new RegExp(`${CALL_ID}|chris@|exampletonbros\\.com`), "no call id or address on the list surface");
  // The extensive read asked for parties only, never content.
  const extensive = stub.log.find((entry) => entry.url.endsWith("/v2/calls/extensive"));
  assert.deepEqual((extensive?.body as any).contentSelector, { exposedFields: { parties: true } });

  const processed = await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.transcript_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const transcriptCalls = transcriptRequests(stub);
  assert.equal(transcriptCalls.length, 1);
  assert.deepEqual((transcriptCalls[0].body as any).filter, { callIds: [CALL_ID] });

  // Evidence landed, review stops automation, and the raw transcript is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds transcript text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|gong-access-secret|nango-secret-test/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|gong-access|nango-secret|spk-ext/);
  // The one-time proof was consumed: a repeat cannot open the call again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gong_exampleton_q3", "proof.json")), false);
  const again = await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(transcriptRequests(stub).length, 1, "no second transcript fetch without a fresh match and proof");
});

test("unapproved scope: a unique match stops at needs_source_approval with the exact handoff and no transcript call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider gong --connection company --scope scope:gong_exampleton_q3/);
  assert.equal(transcriptRequests(stub).length, 0);
  const processed = await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(transcriptRequests(stub).length, 0);
});

// R-004 / C-007 fixtures: the no-selector, internal-only, and ceiling cases,
// each proving the run stops where the scope ends instead of widening.

test("no-selector scope: a window plus only a workspace selector is invalid before any provider call", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: gong_window_only",
    "    provider: gong",
    "    connection_alias: company",
    "    time_window: {start: 2026-07-19T00:00:00Z, end: 2026-07-21T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  const listed = await runGongDiscovery(root, ["list", "inbox:gong_window_only", "--json"], deps(stub, { env: env({ FOO_GONG_WORKSPACE: "ws1" }) }));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.match(listed.result.errors[0].message, /workspace/);
  assert.equal(listed.exitCode, 1);
  // Pre-flight: an invalid scope never reaches the network, not even Nango.
  assert.equal(stub.log.length, 0);
});

test("internal-only window: every listed call is the company talking to itself, so the scope reports awaiting_match with an empty list and never widens", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    requestId: "r-internal",
    records: { totalRecords: 1, currentPageSize: 1, currentPageNumber: 0 },
    calls: [{ id: INTERNAL_CALL_ID, title: "Internal pipeline review", started: "2026-07-20T15:00:00Z", duration: 900, workspaceId: "ws1" }],
  });
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "awaiting_match", listed.output);
  assert.equal(listed.exitCode, 0);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.internal_only_excluded, 1);
  assert.equal(coverage.candidates_evaluated, 0);
  // The empty result is final: no widening round, no transcript, no match file.
  assert.equal(stub.log.filter((entry) => entry.url.includes("/v2/calls?")).length, 1);
  assert.equal(transcriptRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gong_exampleton_q3", "match.json")), false);
});

test("page ceiling: a cursor that never ends stops with budget_exhausted at the policy ceiling, repeats the same window on every page, and halts all provider reads", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    requestId: "r-pages",
    records: { totalRecords: 999, currentPageSize: 1, currentPageNumber: 0, cursor: "next-page" },
    calls: [{ id: CALL_ID, title: "Discovery call with Exampleton Brothers", started: "2026-07-20T16:00:00Z", duration: 1800, workspaceId: "ws1" }],
  });
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, GONG_POLICY.max_list_pages);
  // Every page repeats the approved window byte-for-byte: the stop never widens it.
  const windows = new Set(stub.log.filter((entry) => entry.url.includes("/v2/calls?")).map((entry) => {
    const params = new URL(entry.url).searchParams;
    return `${params.get("fromDateTime")}..${params.get("toDateTime")}`;
  }));
  assert.equal(windows.size, 1);
  // Stopped means stopped: no parties read after the ceiling, no transcript ever.
  assert.equal(stub.log.filter((entry) => entry.url.endsWith("/v2/calls/extensive")).length, 0);
  assert.equal(transcriptRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_gong_exampleton_q3", "match.json")), false);
});

test("study lane: a gong study scope with a window but no customer selector is invalid before any provider call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8")
    .replace(/provider: granola/g, "provider: gong")
    .replace(/connection_alias: primary/g, "connection_alias: company")
    .replace("state: awaiting_interview", "state: awaiting_match")
    .replace("name: Casey Sample", 'name: ""')
    .replace("organization: Example Research", 'organization: ""');
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  const listed = await runGongDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.equal(stub.log.length, 0);
});

test("ceilings fail closed: an oversized transcript writes nothing, retries nothing, and reports the policy code", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.transcriptBody = () => new Response("x".repeat(GONG_POLICY.max_response_bytes + 1), { status: 200, headers: { "content-type": "application/json" } });
  const processed = await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.equal((processed.result.coverage as any).provider_error, "transcript_too_large");
  assert.equal(transcriptRequests(stub).length, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis after an overflow");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

// C-010: every failure class after the gates — timeout, cancel, crash, and
// lost response — stops at exactly one transcript request carrying exactly one
// id: no second attempt, no synthesis, nothing written.
type TranscriptFailureMode = "timeout" | "cancel" | "crash" | "lost_response";

async function processWithFailure(mode: TranscriptFailureMode): Promise<{ stub: Stub; processed: Awaited<ReturnType<typeof runGongDiscovery>>; inbox: string }> {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  if (mode === "timeout") {
    // A fetch that only settles when its abort signal fires: with the ceiling
    // narrowed to 50 ms the transport times out; the valve keeps a broken
    // ceiling from hanging the suite (it fails the test instead).
    const inner = stub.fetch;
    stub.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v2/calls/transcript")) {
        // Record the hung request (the inner fetch never sees it), then only
        // settle when the abort signal fires: with the ceiling narrowed to
        // 50 ms the transport times out. The valve keeps a broken ceiling
        // from hanging the suite (it fails the test instead).
        stub.log.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
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
    return { stub, processed: await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub, { fetchTimeoutMs: 50 })), inbox };
  }
  if (mode === "cancel") {
    // Headers arrive, then the body stream is torn down mid-read.
    stub.transcriptBody = () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"callTranscripts":'));
          controller.error(new Error("stream canceled"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (mode === "crash") stub.transcriptBody = () => { throw new Error("connection reset"); };
  if (mode === "lost_response") stub.transcriptBody = () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  return { stub, processed: await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub)), inbox };
}

test("no automatic retry: timeout, cancel, crash, and lost response each stop at exactly one transcript request with one id and nothing written", async () => {
  const expected: Record<TranscriptFailureMode, { status: string; provider_error?: string; handoff?: RegExp }> = {
    timeout: { status: "invalid", provider_error: "provider_timeout", handoff: /no retry was attempted/ },
    cancel: { status: "needs_research_proof", handoff: /fresh proof/ },
    crash: { status: "invalid", provider_error: "network" },
    lost_response: { status: "invalid", provider_error: "provider_failure" },
  };
  for (const mode of ["timeout", "cancel", "crash", "lost_response"] as TranscriptFailureMode[]) {
    const { stub, processed, inbox } = await processWithFailure(mode);
    const calls = transcriptRequests(stub);
    assert.equal(calls.length, 1, `${mode}: exactly one transcript request, no second attempt`);
    assert.deepEqual((calls[0].body as { filter: unknown }).filter, { callIds: [CALL_ID] }, `${mode}: the one request carries exactly one call id`);
    assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, `${mode}: no synthesis after the failure`);
    assert.equal(processed.result.status, expected[mode].status, `${mode}: ${processed.output}`);
    if (expected[mode].provider_error) assert.equal((processed.result.coverage as Record<string, unknown>).provider_error, expected[mode].provider_error, mode);
    if (expected[mode].handoff) assert.match(String(processed.result.handoff), expected[mode].handoff, mode);
    assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/, `${mode}: nothing was written`);
  }
});

test("privacy screen: derived text naming a participant is refused and nothing is written", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Notebook workflow", paraphrase: "Chris Exampleton keeps exercises in a notebook.", evidence_type: "stated", locator: "00:05-00:30", confidence: "high", dissent: "none recorded" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runGongDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.match(processed.result.errors[0].message, /identity/);
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("study lane: hypotheses from study.md are required and every finding is tied to one", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8")
    .replace("state: awaiting_interview", "state: awaiting_match")
    .replace(/provider: granola/g, "provider: gong")
    .replace(/connection_alias: primary/g, "connection_alias: company")
    .replace("expected_local_date: null", "expected_local_date: \"2026-07-20\"");
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  writeFileSync(path.join(studyDir, "study.md"), "# Study\n\n## Hypotheses\n\n- H-001: Teams value reversible workflows over speed.\n");
  approve(studyDir, { ingress_path: "nango", provider: "gong", connection_id: "company" }, { packet: "study", scope: "study:study_granola_shape_up_20260720", by: "taylor", at: NOW });
  const listed = await runGongDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Reversibility drives the notebook choice", paraphrase: "The customer chose the shared notebook because mistakes can be undone.", evidence_type: "stated", locator: "00:05-00:30", confidence: "high", dissent: "One customer.", hypothesis_id: "H-001", relationship_hint: "supports" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runGongDiscovery(root, ["process", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_review", processed.output);
  assert.match(readFileSync(path.join(studyDir, "findings.yaml"), "utf8"), /H-001/);
});

test("sync: metadata and match across Gong lanes only; a transcript is never opened by sync", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runGongDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.result.status, "ok", synced.output);
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.lanes, 1);
  assert.equal(coverage.transcripts_opened, 0);
  assert.equal(transcriptRequests(stub).length, 0);
  assert.match(synced.result.next_actions.join("\n"), /process inbox:gong_exampleton_q3/);
});

test("direct fallback: an administrator-issued access key works without any Nango call, is labeled direct, and never leaks", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const direct = { FOO_GONG_ACCESS_KEY: "gong-access-key", FOO_GONG_ACCESS_KEY_SECRET: "gong-access-secret", ANTHROPIC_API_KEY: "anthropic-test-key" };
  const ready = await runGongDiscovery(root, ["ready", "--json"], deps(stub, { env: direct }));
  assert.equal(ready.result.status, "ok", ready.output);
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.credential_broker, "direct");
  assert.match(String(coverage.connection), /^gong:direct:[0-9a-f]{16}$/);
  assert.match(ready.result.next_actions[0], /direct/);
  assert.doesNotMatch(ready.output, /gong-access-key|gong-access-secret/);
  assert.equal(stub.log.filter((entry) => entry.url.includes("nango")).length, 0, "no Nango call on the direct path");
  const listed = await runGongDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: direct }));
  assert.equal(listed.result.status, "ok", listed.output);
  assert.equal(stub.log.filter((entry) => entry.url.includes("nango")).length, 0);
  // Nango wins when both are configured: the company connection is primary.
  const both = await runGongDiscovery(root, ["ready", "--json"], deps(stub, { env: { ...env(), ...direct } }));
  assert.equal((both.result.coverage as any).credential_broker, "nango");
  assert.ok(stub.log.some((entry) => entry.url.includes("nango")));
  // Half a direct credential is not a credential.
  const half = await runGongDiscovery(root, ["ready", "--json"], deps(stub, { env: { FOO_GONG_ACCESS_KEY: "only-the-key" } }));
  assert.equal(half.result.status, "needs_provider_connector");
  assert.match(String(half.result.handoff), /FOO_GONG_ACCESS_KEY_SECRET/);
});

test("read-only: any non-read Gong operation is refused at the single choke point", async () => {
  const stub = makeStub();
  const connection = await resolveGongConnection({ env: env(), fetchImpl: stub.fetch });
  const client = new GongClient(connection.credential, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const request = (client as unknown as { request: (method: string, pathname: string, body?: unknown) => Promise<unknown> }).request.bind(client);
  await assert.rejects(request("POST", "/v2/calls", { title: "x" }), SourceWriteRefused);
  await assert.rejects(request("POST", "/v2/calls/7782342274025937895/comments", {}), SourceWriteRefused);
  // R-009 covers CRM write-back too: any non-listed method or path — including
  // a CRM mutation productfoo never issues — is refused before any network.
  await assert.rejects(request("POST", "/v2/crm/entities", { name: "x" }), SourceWriteRefused);
  await assert.rejects(request("DELETE" as never, "/v2/calls/7782342274025937895"), SourceWriteRefused);
  await assert.rejects(client.transcript("one two"), GongRuntimeError);
  assert.equal(stub.log.filter((entry) => entry.url.includes("gong.io")).length, 0);
});

test("Nango failures are typed and content-free: a refused secret is not_connected, an OAuth token without the transcript scope reports it missing", async () => {
  const stub = makeStub();
  stub.nangoStatus = 401;
  await assert.rejects(resolveGongConnection({ env: env(), fetchImpl: stub.fetch }), (error: unknown) => error instanceof GongRuntimeError && error.code === "not_connected");
  const oauth: typeof globalThis.fetch = async () => jsonResponse(200, { credentials: { type: "OAUTH2", access_token: "tok", raw: { scope: "api:calls:read:basic api:users:read" } } });
  const connection = await resolveGongConnection({ env: env(), fetchImpl: oauth });
  assert.equal(connection.credential_type, "oauth2");
  assert.equal(connection.transcript_scope, "missing");
});

test("envelope closure: model output is reduced to findings, candidates, and coverage; missing locators downgrade honestly", () => {
  const base = {
    target_id: "inbox:gong_exampleton_q3",
    lane: "unassigned_call_evidence" as const,
    source: { provider: "gong", stable_url: `https://app.gong.io/call?id=${CALL_ID}`, source_fingerprint: `sha256:${"b".repeat(64)}`, completed_at: NOW, locator_capability: "timestamp" as const },
    title: "Discovery call",
    hypotheses: [],
    transcript_text: "",
    transcript_complete: true,
  };
  const envelope = buildEnvelopeFromSynthesis(base, {
    findings: [{ headline: "Notebook is the system of record", paraphrase: "The customer relies on a shared notebook.", evidence_type: "stated", confidence: "high", dissent: "none recorded", hypothesis_id: "H-999", raw_transcript: CANARY, explicit_refs: ["R-001"] }],
    contact_candidates: [{ name: "", company: "Exampleton Brothers" }, {}],
    coverage: { transcript_complete: true, caveats: ["Tail excluded: a second meeting started."] },
    transcript: CANARY,
  });
  assert.equal(envelope.source.locator_capability, "none");
  assert.equal(envelope.findings[0].finding_id, "F-001");
  assert.equal(envelope.findings[0].hypothesis_id, undefined);
  assert.equal(envelope.findings[0].explicit_refs, undefined);
  assert.deepEqual(envelope.contact_candidates, [{ company: "Exampleton Brothers" }]);
  assert.ok(envelope.coverage.caveats.some((caveat) => /locators/.test(caveat)));
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(CANARY));
  const transport: SynthesisTransport = async () => ({ text: "not json", stop_reason: "end_turn" });
  void transport;
});

