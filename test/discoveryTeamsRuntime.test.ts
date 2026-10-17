// microsoft-teams-discovery-connector-v0 local worker: end-to-end against
// stubbed Nango, Microsoft Graph, and model endpoints (T-006; the gong
// runtime fixture port with Graph deltas). The fixtures pin the provider
// shapes the packet believes (T-001 owns verifying them live); the assertions
// pin the boundaries that must hold regardless: zero transcript calls before
// the gates, exactly one content call carrying exactly one meeting id and one
// transcript id after them, a raw-transcript canary absent from every file
// and output, ceilings that fail closed, the Nango-only tenant-owned
// credential (no direct fallback, R-002), and read-only Graph.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runTeamsDiscovery, type TeamsDiscoveryDeps } from "../src/discoveryTeams.js";
import { TEAMS_POLICY, TeamsGraphClient, TeamsRuntimeError, resolveTeamsConnection } from "../src/teamsNango.js";
import { approve, SourceWriteRefused } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";

const CANARY = "CANARY_RAW_TRANSCRIPT_9f3a";
const MEETING_ID = "meetingA1b2C3d4e5";
const INTERNAL_MEETING_ID = "meetingF6g7H8i9j0";
const TRANSCRIPT_ID = "transcriptK1l2M3n4o5";
const NOW = "2026-07-20T18:00:00.000Z";
const TARGET = "inbox:teams_exampleton_q3";

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string; body?: unknown }>;
  transcriptBody?: () => unknown;
  transcriptsBody?: () => unknown;
  attendanceBody?: () => unknown;
  listBody?: () => unknown;
  endlessPages?: boolean;
  modelReply?: () => string;
  nangoStatus?: number;
  nangoScope?: string;
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function meetingEntry(id: string, subject: string, start: string, end: string, organizer: string): Record<string, unknown> {
  return {
    id,
    subject,
    startDateTime: start,
    endDateTime: end,
    state: "completed",
    joinWebUrl: `https://teams.microsoft.com/l/meetup-join/19:meeting_${id}/0`,
    organizer: { information: { displayName: organizer } },
  };
}

const DEFAULT_MEETINGS = [
  meetingEntry(MEETING_ID, "Discovery call with Exampleton Brothers", "2026-07-20T16:00:00Z", "2026-07-20T16:30:00Z", "Chris Exampleton"),
  meetingEntry(INTERNAL_MEETING_ID, "Internal pipeline review", "2026-07-20T15:00:00Z", "2026-07-20T15:15:00Z", "Taylor Fixture"),
];

function makeStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    stub.log.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      assert.equal(parsed.pathname, "/connection/conn_teams");
      assert.equal(parsed.searchParams.get("provider_config_key"), "microsoft-teams");
      assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, "Bearer nango-secret-test");
      return jsonResponse(200, {
        id: 42,
        connection_id: "conn_teams",
        provider_config_key: "microsoft-teams",
        metadata: { tenant_domain: "foo.example" },
        credentials: { type: "OAUTH2", access_token: "graph-token", raw: { scope: stub.nangoScope ?? "https://graph.microsoft.com/.default offline_access OnlineMeetingTranscript.Read.All" } },
      });
    }
    if (parsed.hostname === "graph.microsoft.com") {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer graph-token");
      assert.equal(method, "GET");
      if (parsed.pathname === "/v1.0/communications/onlineMeetings") {
        if (stub.listBody) return jsonResponse(200, stub.listBody());
        if (stub.endlessPages) {
          const page = Number(parsed.searchParams.get("page") ?? "1");
          return jsonResponse(200, {
            value: [DEFAULT_MEETINGS[0]],
            "@odata.nextLink": `https://graph.microsoft.com/v1.0/communications/onlineMeetings?startDateTime=${encodeURIComponent(parsed.searchParams.get("startDateTime") ?? "")}&endDateTime=${encodeURIComponent(parsed.searchParams.get("endDateTime") ?? "")}&page=${page + 1}`,
          });
        }
        return jsonResponse(200, { value: DEFAULT_MEETINGS });
      }
      if (parsed.pathname === `/v1.0/communications/onlineMeetings/${MEETING_ID}/transcripts`) {
        if (stub.transcriptsBody) return jsonResponse(200, stub.transcriptsBody());
        return jsonResponse(200, { value: [{ id: TRANSCRIPT_ID }] });
      }
      if (parsed.pathname === `/v1.0/communications/onlineMeetings/${MEETING_ID}/attendanceReports`) {
        if (stub.attendanceBody) return stub.attendanceBody() instanceof Response ? (stub.attendanceBody() as Response) : jsonResponse(200, stub.attendanceBody());
        return jsonResponse(200, {
          value: [
            { attendanceRecords: [
              { emailAddress: { name: "Chris Exampleton", address: "chris@exampletonbrothers.example" } },
              { emailAddress: { name: "Taylor Fixture", address: "taylor@foo.example" } },
            ] },
          ],
        });
      }
      if (parsed.pathname === `/v1.0/communications/onlineMeetings/${INTERNAL_MEETING_ID}/attendanceReports`) {
        return jsonResponse(200, {
          value: [
            { attendanceRecords: [
              { emailAddress: { name: "Taylor Fixture", address: "taylor@foo.example" } },
            ] },
          ],
        });
      }
      if (parsed.pathname === `/v1.0/communications/onlineMeetings/${MEETING_ID}/transcripts/${TRANSCRIPT_ID}/content`) {
        if (stub.transcriptBody) {
          const custom = stub.transcriptBody();
          return custom instanceof Response ? custom : jsonResponse(200, custom);
        }
        return jsonResponse(200, { content: ["WEBVTT", "", "00:00.000 --> 00:05.000", "Taylor: Thanks for joining, Chris.", "", "00:05.000 --> 00:30.000", `Chris: We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}`, ""].join("\n") });
      }
      return new Response("", { status: 405 });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      assert.equal(JSON.parse(String(init?.body)).model, "claude-opus-5");
      assert.match(JSON.parse(String(init?.body)).messages[0].content, /TRANSCRIPT/);
      const text = stub.modelReply ? stub.modelReply() : JSON.stringify({
        findings: [
          { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: null, confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
          { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: null, confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
          { headline: "No tooling change is planned", paraphrase: "The customer did not mention any plan to replace the notebook.", evidence_type: "observed", locator: null, confidence: "low", dissent: "Absence of a statement is weak evidence.", relationship_hint: "new" },
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
  const root = mkdtempSync(path.join(tmpdir(), "foo-teams-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: teams_exampleton_q3",
    "    provider: microsoft-teams",
    "    connection_alias: teams",
    "    time_window: {start: 2026-07-19T00:00:00Z, end: 2026-07-21T00:00:00Z}",
    "    participant_allowlist: [Chris Exampleton]",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  return { root, inbox };
}

function approveScope(inbox: string): void {
  approve(inbox, { ingress_path: "nango", provider: "microsoft-teams", connection_id: "teams" }, { packet: "discovery-inbox", scope: "scope:teams_exampleton_q3", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_TEAMS_NANGO_CONNECTION: "conn_teams", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<TeamsDiscoveryDeps> = {}): TeamsDiscoveryDeps {
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

function transcriptReads(stub: Stub) {
  return stub.log.filter((entry) => entry.url.includes("/transcripts"));
}

function listCalls(stub: Stub) {
  return stub.log.filter((entry) => entry.url.includes("/v1.0/communications/onlineMeetings?"));
}

test("ready: Nango brokers the tenant credential, Graph is probed with one metadata call, nothing private is printed", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const ready = await runTeamsDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "workspace");
  assert.equal(coverage.credential_broker, "nango");
  assert.equal(coverage.credential_type, "oauth2");
  assert.equal(coverage.capabilities.open_transcript, true);
  assert.equal(coverage.policy.max_response_bytes, TEAMS_POLICY.max_response_bytes);
  assert.match(String(coverage.connection), /^microsoft-teams:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_teams|nango-secret|graph-token/);
  assert.equal(stub.log.filter((entry) => entry.url.includes("/transcripts")).length, 0, "readiness never reads transcript content");
});

test("not connected: without Nango configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0);
});

// R-002: the Teams connection is tenant-owned through Nango only. There is no
// direct-credential path to configure, so plausible direct-credential
// variables are simply never read.
test("no direct fallback: credential-shaped environment variables without Nango are never read", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const direct = { FOO_TEAMS_ACCESS_TOKEN: "personal-token", FOO_TEAMS_TENANT_ID: "tenant", ANTHROPIC_API_KEY: "x" };
  const ready = await runTeamsDiscovery(root, ["ready", "--json"], deps(stub, { env: direct }));
  assert.equal(ready.result.status, "needs_provider_connector");
  assert.match(String(ready.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0, "no provider call is made without the tenant-owned connection");
});

test("list + process: bounded listing, non-selected meeting excluded, one matched meeting, exactly one content request with one meeting id and one transcript id, sanitized evidence applied, canary absent everywhere", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);

  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.meetings_listed, 2);
  assert.equal(listCoverage.internal_only_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.transcript_opened, false);
  assert.equal(transcriptReads(stub).length, 0, "listing never opens a transcript");
  assert.doesNotMatch(listed.output, new RegExp(`${MEETING_ID}|chris@|exampletonbros\\.com`), "no meeting id or address on the list surface");

  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.transcript_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  const reads = transcriptReads(stub);
  assert.equal(reads.length, 2, "one metadata read and one content read");
  assert.equal(reads.filter((entry) => entry.url.endsWith("/content")).length, 1);
  assert.ok(reads.find((entry) => entry.url.endsWith("/content"))!.url.includes(`/onlineMeetings/${MEETING_ID}/transcripts/${TRANSCRIPT_ID}/content`), "the one content request carries exactly one meeting id and one transcript id");

  // Evidence landed, review stops automation, and the raw transcript is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds transcript text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|graph-token|nango-secret-test/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|graph-token|nango-secret/);
  // The one-time proof was consumed: a repeat cannot open the meeting again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_teams_exampleton_q3", "proof.json")), false);
  const again = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.notEqual(again.result.status, "needs_review");
  assert.equal(transcriptReads(stub).filter((entry) => entry.url.endsWith("/content")).length, 1, "no second transcript fetch without a fresh match and proof");
});

test("unapproved ingress: a unique match stops at needs_source_approval with the exact handoff and no content read", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "needs_source_approval");
  assert.match(String(listed.result.handoff), /foo source approve .* --provider microsoft-teams --connection teams --scope scope:teams_exampleton_q3/);
  assert.equal(transcriptReads(stub).length, 0);
  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_research_proof");
  assert.equal(transcriptReads(stub).length, 0);
});

// R-004 fixtures: the no-selector and internal-only cases, each proving the
// run stops where the scope ends instead of widening.

test("no-selector scope: a window with no customer selector is invalid before any provider call", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: teams_window_only",
    "    provider: microsoft-teams",
    "    connection_alias: teams",
    "    time_window: {start: 2026-07-19T00:00:00Z, end: 2026-07-21T00:00:00Z}",
    "    participant_allowlist: []",
    "    domain_allowlist: []",
    "    title_tokens: []",
    "    state: approved",
    "    approved_by: taylor",
    `    approved_at: ${NOW}`,
    "",
  ].join("\n"));
  const listed = await runTeamsDiscovery(root, ["list", "inbox:teams_window_only", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.equal(listed.exitCode, 1);
  // Pre-flight: an invalid scope never reaches the network, not even Nango.
  assert.equal(stub.log.length, 0);
});

test("non-selected window: every listed meeting is the tenant talking to itself, so the scope reports awaiting_match with an empty list and never widens", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.listBody = () => ({ value: [DEFAULT_MEETINGS[1]] });
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "awaiting_match", listed.output);
  assert.equal(listed.exitCode, 0);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.internal_only_excluded, 1);
  assert.equal(coverage.candidates_evaluated, 0);
  // The empty result is final: no widening round, no transcript, no match file.
  assert.equal(listCalls(stub).length, 1);
  assert.equal(transcriptReads(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_teams_exampleton_q3", "match.json")), false);
});

test("page ceiling: a nextLink that never ends stops with budget_exhausted at the policy ceiling, repeats the same window on every page, and halts all provider reads", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.endlessPages = true;
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "budget_exhausted");
  assert.equal(listed.exitCode, 1);
  const coverage = listed.result.coverage as Record<string, any>;
  assert.equal(coverage.provider_error, "budget_exhausted");
  assert.equal(coverage.pages, TEAMS_POLICY.max_list_pages);
  // Every page repeats the approved window byte-for-byte: the stop never widens it.
  const windows = new Set(listCalls(stub).map((entry) => {
    const params = new URL(entry.url).searchParams;
    return `${params.get("startDateTime")}..${params.get("endDateTime")}`;
  }));
  assert.equal(windows.size, 1);
  // Stopped means stopped: no transcript metadata or content after the ceiling.
  assert.equal(transcriptReads(stub).length, 0);
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_teams_exampleton_q3", "match.json")), false);
});

test("study lane: a teams study scope with a window but no customer selector is invalid before any provider call", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8")
    .replace(/provider: granola/g, "provider: microsoft-teams")
    .replace(/connection_alias: primary/g, "connection_alias: teams")
    .replace("state: awaiting_interview", "state: awaiting_match")
    .replace("name: Casey Sample", 'name: ""')
    .replace("organization: Example Research", 'organization: ""');
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  const listed = await runTeamsDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "invalid");
  assert.match(listed.result.errors[0].message, /customer selector/);
  assert.equal(stub.log.length, 0);
});

test("study lane: hypotheses from study.md are required and every finding is tied to one", async () => {
  const stub = makeStub();
  const { root } = fixture();
  const studyDir = path.join(root, "discovery", "2026-07-20-granola-shape-up");
  const run = readFileSync(path.join(studyDir, "run.yaml"), "utf8")
    .replace("state: awaiting_interview", "state: awaiting_match")
    .replace(/provider: granola/g, "provider: microsoft-teams")
    .replace(/connection_alias: primary/g, "connection_alias: teams")
    .replace("expected_local_date: null", 'expected_local_date: "2026-07-20"');
  writeFileSync(path.join(studyDir, "run.yaml"), run);
  writeFileSync(path.join(studyDir, "study.md"), "# Study\n\n## Hypotheses\n\n- H-001: Teams value reversible workflows over speed.\n");
  approve(studyDir, { ingress_path: "nango", provider: "microsoft-teams", connection_id: "teams" }, { packet: "study", scope: "study:study_granola_shape_up_20260720", by: "taylor", at: NOW });
  stub.listBody = () => ({ value: [DEFAULT_MEETINGS[0]] });
  const listed = await runTeamsDiscovery(root, ["list", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Reversibility drives the notebook choice", paraphrase: "The customer chose the shared notebook because mistakes can be undone.", evidence_type: "stated", locator: null, confidence: "high", dissent: "One customer.", hypothesis_id: "H-001", relationship_hint: "supports" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runTeamsDiscovery(root, ["process", "study_granola_shape_up_20260720", "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_review", processed.output);
  assert.match(readFileSync(path.join(studyDir, "findings.yaml"), "utf8"), /H-001/);
});

test("ceilings fail closed: an oversized transcript writes nothing, retries nothing, and reports the policy code", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.transcriptBody = () => new Response("x".repeat(TEAMS_POLICY.max_response_bytes + 1), { status: 200, headers: { "content-type": "application/json" } });
  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.equal((processed.result.coverage as any).provider_error, "transcript_too_large");
  assert.equal(transcriptReads(stub).filter((entry) => entry.url.endsWith("/content")).length, 1);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, "no synthesis after an overflow");
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("no transcript recorded: the observed metadata is empty, so the run degrades with needs_provider_access and never reads content", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.transcriptsBody = () => ({ value: [] });
  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_provider_access", processed.output);
  assert.match(processed.result.errors[0].message, /No transcript is recorded/);
  assert.equal(transcriptReads(stub).filter((entry) => entry.url.endsWith("/content")).length, 0);
  assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0);
});

// C-010: every failure class after the gates — timeout, cancel, crash, and
// lost response — stops at exactly one content request carrying exactly one
// meeting id and one transcript id: no second attempt, no synthesis, nothing
// written.
type TranscriptFailureMode = "timeout" | "cancel" | "crash" | "lost_response";

async function processWithFailure(mode: TranscriptFailureMode): Promise<{ stub: Stub; processed: Awaited<ReturnType<typeof runTeamsDiscovery>>; inbox: string }> {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  if (mode === "timeout") {
    // A fetch that only settles when its abort signal fires: with the ceiling
    // narrowed to 50 ms the transport times out; the valve keeps a broken
    // ceiling from hanging the suite (it fails the test instead).
    const inner = stub.fetch;
    stub.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/content")) {
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
    return { stub, processed: await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub, { fetchTimeoutMs: 50 })), inbox };
  }
  if (mode === "cancel") {
    // Headers arrive, then the body stream is torn down mid-read.
    stub.transcriptBody = () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":'));
          controller.error(new Error("stream canceled"));
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (mode === "crash") stub.transcriptBody = () => { throw new Error("connection reset"); };
  if (mode === "lost_response") stub.transcriptBody = () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
  return { stub, processed: await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub)), inbox };
}

test("no automatic retry: timeout, cancel, crash, and lost response each stop at exactly one content request with one meeting id and one transcript id and nothing written", async () => {
  const expected: Record<TranscriptFailureMode, { status: string; provider_error?: string; handoff?: RegExp }> = {
    timeout: { status: "invalid", provider_error: "provider_timeout", handoff: /no retry was attempted/ },
    cancel: { status: "needs_research_proof", handoff: /fresh proof/ },
    crash: { status: "needs_research_proof", handoff: /fresh proof/ },
    lost_response: { status: "invalid", provider_error: "provider_failure" },
  };
  for (const mode of ["timeout", "cancel", "crash", "lost_response"] as TranscriptFailureMode[]) {
    const { stub, processed, inbox } = await processWithFailure(mode);
    const contents = transcriptReads(stub).filter((entry) => entry.url.endsWith("/content"));
    assert.equal(contents.length, 1, `${mode}: exactly one content request, no second attempt`);
    assert.ok(contents[0].url.includes(`/onlineMeetings/${MEETING_ID}/transcripts/${TRANSCRIPT_ID}/content`), `${mode}: the one request carries exactly one meeting id and one transcript id`);
    assert.equal(stub.log.filter((entry) => entry.url.includes("anthropic")).length, 0, `${mode}: no synthesis after the failure`);
    assert.equal(processed.result.status, expected[mode].status, `${mode}: ${processed.output}`);
    if (expected[mode].provider_error) assert.equal((processed.result.coverage as Record<string, unknown>).provider_error, expected[mode].provider_error, mode);
    if (expected[mode].handoff) assert.match(String(processed.result.handoff), expected[mode].handoff, mode);
    assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/, `${mode}: nothing was written`);
  }
});

test("privacy screen: derived text naming a participant identity is refused and nothing is written", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [{ headline: "Notebook workflow", paraphrase: "Chris Exampleton keeps exercises in a notebook.", evidence_type: "stated", locator: null, confidence: "high", dissent: "none recorded" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  assert.match(processed.result.errors[0].message, /identity/);
  assert.doesNotMatch(readFileSync(path.join(inbox, "findings.yaml"), "utf8"), /F-001/);
});

test("sync: metadata and match across Teams lanes only; a transcript is never opened by sync", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runTeamsDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.result.status, "ok", synced.output);
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.lanes, 1);
  assert.equal(coverage.transcripts_opened, 0);
  assert.equal(transcriptReads(stub).length, 0);
  assert.match(synced.result.next_actions.join("\n"), /process inbox:teams_exampleton_q3/);
});

test("read-only: any non-read Graph operation, foreign path, traversal, or malformed identifier is refused at the single choke point", async () => {
  const stub = makeStub();
  const client = new TeamsGraphClient({ type: "oauth2", access_token: "graph-token" }, { fetchImpl: stub.fetch, sleep: async () => undefined });
  const request = (client as unknown as { request: (method: string, pathname: string, maxBytes?: unknown) => Promise<unknown> }).request.bind(client);
  await assert.rejects(request("POST", "/v1.0/communications/onlineMeetings", 4096), SourceWriteRefused);
  await assert.rejects(request("GET", "/v1.0/me"), SourceWriteRefused);
  await assert.rejects(request("GET", "/v1.0/communications/onlineMeetings/../users"), SourceWriteRefused);
  await assert.rejects(request("DELETE" as never, `/v1.0/communications/onlineMeetings/${MEETING_ID}`), SourceWriteRefused);
  await assert.rejects(client.transcriptContent("a%2Fb", TRANSCRIPT_ID), TeamsRuntimeError);
  await assert.rejects(client.transcriptContent("m1 t", TRANSCRIPT_ID), TeamsRuntimeError);
  assert.equal(stub.log.filter((entry) => entry.url.includes("graph.microsoft.com")).length, 0, "refusals happen before any network");
});

test("Nango failures are typed and content-free: a refused secret is not_connected, and an OAuth token without the transcript scope reports it missing", async () => {
  const stub = makeStub();
  stub.nangoStatus = 401;
  await assert.rejects(resolveTeamsConnection({ env: env(), fetchImpl: stub.fetch }), (error: unknown) => error instanceof TeamsRuntimeError && error.code === "not_connected");
  stub.nangoStatus = 0;
  stub.nangoScope = "User.Read Calendars.Read";
  const connection = await resolveTeamsConnection({ env: env(), fetchImpl: stub.fetch });
  assert.equal(connection.credential_type, "oauth2");
  assert.equal(connection.transcript_scope, "missing");
});

test("missing transcript scope: readiness reports the degraded capability, and processing refuses before any transcript metadata or content read", async () => {
  const stub = makeStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  stub.nangoScope = "User.Read Calendars.Read";
  const ready = await runTeamsDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.result.status, "ok", ready.output);
  const capabilities = (ready.result.coverage as Record<string, any>).capabilities;
  assert.equal(capabilities.open_transcript, false);
  assert.equal(capabilities.transcript_scope, "missing");
  const listed = await runTeamsDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);
  const processed = await runTeamsDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "needs_provider_access", processed.output);
  assert.equal(transcriptReads(stub).length, 0, "a missing scope is refused before transcript metadata, let alone content");
});
