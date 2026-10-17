// fireflies-discovery-connector-v0 local worker: end-to-end against stubbed
// Fireflies and model endpoints. The fixtures pin the provider shapes the
// packet believes (T-001 owns verifying them live); the assertions pin the
// boundaries that must hold regardless: zero transcript calls before the
// gates, exactly one call carrying exactly one id after them, a raw-transcript
// canary absent from every file and output, ceilings that fail closed, a
// personal key that never leaks, and read-only Fireflies.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runFirefliesDiscovery, type FirefliesDiscoveryDeps } from "../src/discoveryFireflies.js";
import { FIREFLIES_POLICY } from "../src/firefliesClient.js";
import { approve } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const CANARY = "CANARY_RAW_TRANSCRIPT_9f3a";
const TRANSCRIPT_ID = "ff-transcript-9182";
const INTERNAL_TRANSCRIPT_ID = "ff-transcript-0001";
const NOW = "2026-07-20T18:00:00.000Z";
const SCOPE_ID = "fireflies_exampleton_q3";
const TARGET = `inbox:${SCOPE_ID}`;

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: { query?: string; variables?: Record<string, unknown> } }>;
  transcriptBody?: () => unknown;
  listBody?: () => unknown;
  listStatus?: number;
  modelReply?: () => string;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    stub.log.push({ method, url, body });
    const parsed = new URL(url);
    if (parsed.hostname === "api.fireflies.ai") {
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer ff-key-test");
      assert.equal(method, "POST");
      const query = body.query as string;
      assert.doesNotMatch(query, /\bmutation\b/, "only GraphQL queries leave the process");
      if (query.includes("query FooViewer")) return jsonResponse(200, { data: { viewer: { user_id: "u1", email: "taylor@foo.example" } } });
      if (query.includes("query FooListTranscripts")) {
        assert.equal(body.variables.limit, 50);
        if (stub.listStatus) return new Response("", { status: stub.listStatus });
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        return jsonResponse(200, {
          data: {
            transcripts: [
              { id: TRANSCRIPT_ID, title: "Discovery call with Exampleton Brothers", date: Date.parse("2026-07-20T16:00:00Z"), end_date: Date.parse("2026-07-20T16:30:00Z"), status: "processed", participants: [{ display_name: "Chris Exampleton", email: "chris@exampletonbros.example" }, { display_name: "Taylor Fixture", email: "taylor@foo.example" }] },
              { id: INTERNAL_TRANSCRIPT_ID, title: "Internal pipeline review", date: Date.parse("2026-07-20T15:00:00Z"), status: "processed", participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }] },
            ],
          },
        });
      }
      if (query.includes("query FooTranscript")) {
        assert.equal(Object.keys(body.variables).length, 1, "a transcript read carries exactly one selector");
        if (stub.transcriptBody) return jsonResponse(200, stub.transcriptBody());
        return jsonResponse(200, {
          data: {
            transcript: {
              title: "Discovery call with Exampleton Brothers",
              speakers: [{ name: "Chris Exampleton" }, { name: "Taylor Fixture" }],
              sentences: [
                { text: "Thanks for joining, Chris.", start_date: "2026-07-20T16:00:00.000Z", speaker_id: "spk-int" },
                { text: `We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}`, start_date: "2026-07-20T16:00:05.000Z", speaker_id: "spk-ext" },
              ],
            },
          },
        });
      }
      return new Response("", { status: 404 });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.match(body.messages[0].content, /TRANSCRIPT/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: "00:00-00:05", confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
          { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "00:00-00:05", confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
          { headline: "No tooling change is planned", paraphrase: "The customer did not mention any plan to replace the notebook.", evidence_type: "observed", locator: "00:00-00:05", confidence: "low", dissent: "Absence of a statement is weak evidence.", relationship_hint: "new" },
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
  const root = mkdtempSync(path.join(tmpdir(), "foo-fireflies-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    `  - scope_id: ${SCOPE_ID}`,
    "    provider: fireflies",
    "    connection_alias: primary",
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
  approve(inbox, { ingress_path: "custom", provider: "fireflies", connection_id: "primary" }, { packet: "discovery-inbox", scope: `scope:${SCOPE_ID}`, by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { FOO_FIREFLIES_API_KEY: "ff-key-test", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<FirefliesDiscoveryDeps> = {}): FirefliesDiscoveryDeps {
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
  return stub.log.filter((entry) => (entry.body?.query ?? "").includes("query FooTranscript"));
}

function listRequests(stub: Stub) {
  return stub.log.filter((entry) => (entry.body?.query ?? "").includes("query FooListTranscripts"));
}

test("ready: the user's own key answers one identity probe, nothing private is printed, and the isolation gap is stated", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runFirefliesDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "user");
  assert.equal(coverage.credential_broker, "direct");
  // R-005, keyed-direct edition: the presented key answered the identity
  // probe, which is the one observable grant a scopeless personal key offers
  // — authentication and content access are the same grant. A transcript read
  // that still fails maps to needs_provider_access.
  assert.equal(coverage.capabilities.open_transcript, true);
  assert.equal(coverage.capabilities.transcript_access, "granted");
  assert.equal(coverage.policy.max_response_bytes, FIREFLIES_POLICY.max_response_bytes);
  assert.match(String(coverage.connection), /^fireflies:direct:[0-9a-f]{16}$/);
  assert.match(ready.result.next_actions.join("\n"), /member isolation|OQ-001/);
  assert.doesNotMatch(ready.output, /ff-key-test|taylor@foo\.example|u1/);
  assert.equal(stub.log.length, 1, "readiness is one identity probe");
  assert.equal(transcriptRequests(stub).length, 0);
});

test("not connected: without the user's key the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /FOO_FIREFLIES_API_KEY/);
  assert.equal(stub.log.length, 0);
});

test("list + process: bounded listing, internal-only transcript excluded, one match, exactly one transcript request with one id, sanitized evidence applied, canary absent everywhere", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.transcripts_listed, 2);
  assert.equal(listCoverage.internal_only_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.transcript_opened, false);
  assert.equal(transcriptRequests(stub).length, 0, "listing never opens a transcript");
  assert.doesNotMatch(listed.output, new RegExp(`${TRANSCRIPT_ID}|chris@|exampletonbros\\.com`), "no transcript id or address on the list surface");

  const processed = await runFirefliesDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.transcript_body_requests, 1);
  const transcriptCalls = transcriptRequests(stub);
  assert.equal(transcriptCalls.length, 1);
  assert.deepEqual(transcriptCalls[0].body?.variables, { id: TRANSCRIPT_ID });

  // Evidence landed, review stops automation, and the raw transcript is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds transcript text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|ff-key-test/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|ff-key|Chris Exampleton|spk-ext/);
  // The one-time proof was consumed: a repeat cannot open the transcript again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_fireflies_exampleton_q3", "proof.json")), false);
  const again = await runFirefliesDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(transcriptRequests(stub).length, 1, "no second transcript fetch without a fresh match and proof");
});

test("unapproved scope: a unique match stops at needs_source_approval with the exact handoff and no transcript call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider fireflies/);
  assert.equal(transcriptRequests(stub).length, 0);
  const processed = await runFirefliesDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(transcriptRequests(stub).length, 0);
});

test("internal-only window: every listed transcript is the user talking to productfoo itself, so the scope reports awaiting_match and never widens", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    data: {
      transcripts: [
        { id: INTERNAL_TRANSCRIPT_ID, title: "Internal pipeline review", date: Date.parse("2026-07-20T15:00:00Z"), status: "processed", participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }] },
      ],
    },
  });
  const listed = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "awaiting_match", listed.output);
  assert.equal(listed.exitCode, 0);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.internal_only_excluded, 1);
  assert.equal(coverage.candidates_evaluated, 0);
  assert.equal(listRequests(stub).length, 1, "the empty result is final: no widening round");
  assert.equal(transcriptRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_fireflies_exampleton_q3", "match.json")), false);
});

test("page ceiling: offset pagination that never ends stops with budget_exhausted at the policy ceiling, repeats the same window on every page, and halts all reads", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({
    data: { transcripts: Array.from({ length: 50 }, (_, index) => ({ id: `ff-bulk-${index}`, title: "Discovery call with Exampleton Brothers", date: Date.parse("2026-07-20T16:00:00Z"), status: "processed", participants: [{ display_name: "Chris Exampleton", email: "chris@exampletonbros.example" }] })) },
  });
  const listed = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, FIREFLIES_POLICY.max_list_pages);
  // Every page repeats the approved window byte-for-byte: the stop never widens it.
  const windows = new Set(listRequests(stub).map((entry) => `${entry.body?.variables?.from}..${entry.body?.variables?.to}`));
  assert.equal(windows.size, 1);
  assert.equal(transcriptRequests(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_fireflies_exampleton_q3", "match.json")), false);
});

test("ceilings fail closed: a transcript over the model-input ceiling writes nothing, synthesizes nothing", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.transcriptBody = () => ({ data: { transcript: { title: "Discovery call", speakers: [{ name: "Chris Exampleton" }], sentences: [{ text: "x".repeat(FIREFLIES_POLICY.max_model_input_tokens * 6), start_date: "2026-07-20T16:00:00.000Z", speaker_id: "spk-ext" }] } } });
  const processed = await runFirefliesDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid", processed.output);
  assert.equal((processed.result.coverage as any).provider_error, "transcript_too_large", processed.output);
  assert.equal(transcriptRequests(stub).length, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis after an overflow");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("privacy screen: derived text naming a participant is refused and nothing is written", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Notebook workflow", paraphrase: "Chris Exampleton keeps exercises in a notebook.", evidence_type: "stated", locator: "00:00-00:05", confidence: "high", dissent: "none recorded" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runFirefliesDiscovery(root, ["process", TARGET, "--json"], deps(stub));
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
    .replace(/provider: granola/g, "provider: fireflies")
    .replace(/connection_alias: primary/g, "connection_alias: primary")
    .replace("expected_local_date: null", 'expected_local_date: "2026-07-20"');
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  writeFileSync(path.join(studyDir, "study.md"), "# Study\n\n## Hypotheses\n\n- H-001: Teams value reversible workflows over speed.\n");
  approve(studyDir, { ingress_path: "custom", provider: "fireflies", connection_id: "primary" }, { packet: "study", scope: "study:study_granola_shape_up_20260720", by: "taylor", at: NOW });
  stub.listBody = () => ({
    data: {
      transcripts: [
        { id: TRANSCRIPT_ID, title: "Discovery call with Casey Sample", date: Date.parse("2026-07-20T16:00:00Z"), status: "processed", participants: [{ display_name: "Casey Sample", email: "chris@sample.example" }, { display_name: "Taylor Fixture", email: "taylor@foo.example" }] },
      ],
    },
  });
  const listed = await runFirefliesDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Reversibility drives the notebook choice", paraphrase: "The customer chose the shared notebook because mistakes can be undone.", evidence_type: "stated", locator: "00:00-00:05", confidence: "high", dissent: "One customer.", hypothesis_id: "H-001", relationship_hint: "supports" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runFirefliesDiscovery(root, ["process", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_review", processed.output);
  assert.match(readFileSync(path.join(studyDir, "findings.yaml"), "utf8"), /H-001/);
});

test("sync: metadata and match across Fireflies lanes only; a transcript is never opened by sync", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runFirefliesDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.result.status, "ok", synced.output);
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.lanes, 1);
  assert.equal(coverage.transcripts_opened, 0);
  assert.equal(transcriptRequests(stub).length, 0);
  assert.match(synced.result.next_actions.join("\n"), /process inbox:fireflies_exampleton_q3/);
});

test("provider failures map to typed stops: an expired key reports needs_provider_access and a rate limit stops without retrying", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listStatus = 401;
  const expired = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(expired.result.status, "needs_provider_access");
  assert.equal((expired.result.coverage as any).provider_error, "auth_expired");
  assert.equal(listRequests(stub).length, 1, "no retry after an auth failure");
  stub.listStatus = 429;
  const limited = await runFirefliesDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(limited.result.status, "budget_exhausted");
  assert.equal((limited.result.coverage as any).provider_error, "budget_exhausted");
  assert.equal(listRequests(stub).length, 2, "a rate limit stops the run; productfoo never auto-retries");
  assert.equal(transcriptRequests(stub).length, 0);
});
