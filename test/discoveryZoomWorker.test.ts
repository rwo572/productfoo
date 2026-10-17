// zoom-discovery-connector-v0 local worker: e2e half. The gong runtime e2e
// pattern verbatim, ported to cloud recordings: a hermetic discovery tree, a
// stubbed Nango/Zoom/Anthropic fetch, one approved inbox scope, and the
// zero-residue scan — no transcript text, address, or token may land in any
// file or printed surface, and listing/sync never open a transcript.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { approve } from "../src/sourceIngress.js";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";
import { ZOOM_POLICY } from "../src/zoomNango.js";
import { runZoomDiscovery, type ZoomDiscoveryDeps } from "../src/discoveryZoom.js";

const CANARY = "CANARY_ZOOM_VTT_9f3a";
const MEETING_UUID = "9f3a2b7c1d5e4082b0a4c6d8e0f2a4b6";
const INTERNAL_UUID = "aabbccddeeff00112233445566778899";
const TRANSCRIPT_URL = `https://foo.zoom.us/rec/download/${MEETING_UUID}/transcript.vtt?access_token=zoomtok`;
const NOW = "2026-09-14T18:00:00.000Z";
const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.000 --> 00:00:03.000",
  "Taylor Fixture: Thanks for joining, Chris.",
  "",
  "2",
  "00:00:04.000 --> 00:00:30.000",
  `Chris Exampleton: We keep every workshop exercise in a shared notebook so we can undo mistakes. ${CANARY}`,
  "",
].join("\n");

type Stub = {
  fetch: typeof globalThis.fetch;
  log: Array<{ method: string; url: string }>;
  modelReply?: () => string;
  nangoStatus?: number;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeE2EStub(): Stub {
  const stub: Stub = { log: [], fetch: async () => new Response("", { status: 500 }) };
  stub.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    stub.log.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname === "api.nango.dev") {
      if (stub.nangoStatus) return new Response("", { status: stub.nangoStatus });
      return jsonResponse(200, { id: 7, connection_id: "conn_company", provider_config_key: "zoom", credentials: { type: "OAUTH2", access_token: "zoom-oauth-token", raw: { scope: "recording:read:admin user:read:admin" } } });
    }
    if (parsed.hostname === "api.zoom.us") {
      if (method === "GET" && /^\/users\/[^/]+\/recordings$/.test(parsed.pathname)) {
        return jsonResponse(200, {
          from: "2026-09-13",
          to: "2026-09-15",
          recordings: [
            {
              uuid: MEETING_UUID,
              topic: "Discovery call with Exampleton Brothers",
              start_time: "2026-09-14T16:00:00Z",
              end_time: "2026-09-14T16:30:00Z",
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
              start_time: "2026-09-14T15:00:00Z",
              state: "completed",
              host_display_name: "Taylor Fixture",
              participants: [{ display_name: "Taylor Fixture", email: "taylor@foo.example" }],
              recording_files: [{ file_type: "MP4", status: "completed", download_url: `https://foo.zoom.us/rec/download/${INTERNAL_UUID}/mp4` }],
            },
          ],
        });
      }
      return new Response("", { status: 405 });
    }
    if (parsed.hostname === "foo.zoom.us" && parsed.pathname.startsWith("/rec/download/")) {
      return new Response(VTT, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (parsed.hostname === "api.anthropic.com") {
      assert.equal(parsed.pathname, "/v1/messages");
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "anthropic-test-key");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { model: string; messages: Array<{ content: string }> };
      assert.equal(body.model, "claude-opus-5");
      const prompt = body.messages[0].content;
      // The rendered transcript carries roles, never identities: the model
      // request is the first place a leak would be observable.
      assert.match(prompt, /TRANSCRIPT/);
      assert.match(prompt, /Company representative|Customer/);
      assert.doesNotMatch(prompt, /Chris Exampleton|Taylor Fixture|chris@exampletonbros\.com/);
      const text = stub.modelReply
        ? stub.modelReply()
        : JSON.stringify({
            findings: [
              { headline: "Customer keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook specifically so mistakes can be undone.", evidence_type: "stated", locator: "not available", confidence: "high", dissent: "Only one workflow was described; other teams may differ.", relationship_hint: "new" },
              { headline: "Undo matters more than speed", paraphrase: "The customer framed reversibility as the reason for the notebook, not throughput.", evidence_type: "inferred", locator: "not available", confidence: "medium", dissent: "Inferred from one remark.", relationship_hint: "new" },
              { headline: "No tooling change is planned", paraphrase: "The customer did not mention any plan to replace the notebook.", evidence_type: "observed", locator: "not available", confidence: "low", dissent: "Absence of a statement is weak evidence.", relationship_hint: "new" },
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
  const root = mkdtempSync(path.join(os.tmpdir(), "foo-zoom-runtime-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), [
    'schema_version: "0.1"',
    "scopes:",
    "  - scope_id: zoom_exampleton_q3",
    "    provider: zoom",
    "    connection_alias: company",
    "    time_window: {start: 2026-09-13T00:00:00Z, end: 2026-09-15T00:00:00Z}",
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
  approve(inbox, { ingress_path: "nango", provider: "zoom", connection_id: "company" }, { packet: "discovery-inbox", scope: "scope:zoom_exampleton_q3", by: "taylor", at: NOW });
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NANGO_SECRET_KEY: "nango-secret-test", FOO_ZOOM_NANGO_CONNECTION: "conn_company", ANTHROPIC_API_KEY: "anthropic-test-key", ...extra };
}

function deps(stub: Stub, extra: Partial<ZoomDiscoveryDeps> = {}): ZoomDiscoveryDeps {
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

function transcriptDownloads(stub: Stub) {
  return stub.log.filter((entry) => entry.url.includes("foo.zoom.us/rec/download"));
}

const TARGET = "inbox:zoom_exampleton_q3";

test("ready: Nango brokers the company credential, Zoom is probed with one metadata call, nothing private is printed", async () => {
  const stub = makeE2EStub();
  const { root } = fixture();
  const ready = await runZoomDiscovery(root, ["ready", "--json"], deps(stub));
  assert.equal(ready.exitCode, 0, ready.output);
  assert.equal(ready.result.status, "ok");
  const coverage = ready.result.coverage as Record<string, any>;
  assert.equal(coverage.mode, "local_worker");
  assert.equal(coverage.support_state, "contract_only");
  assert.equal(coverage.connection_owner, "workspace");
  assert.equal(coverage.credential_type, "oauth2");
  assert.equal(coverage.capabilities.open_transcript, true);
  assert.equal(coverage.policy.max_list_pages, ZOOM_POLICY.max_list_pages);
  assert.match(String(coverage.connection), /^zoom:[0-9a-f]{16}$/);
  assert.doesNotMatch(ready.output, /conn_company|nango-secret|zoom-oauth-token/);
  assert.equal(transcriptDownloads(stub).length, 0);
});

test("not connected: without configuration the runtime stops with a handoff and makes zero provider calls", async () => {
  const stub = makeE2EStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runZoomDiscovery(root, ["list", TARGET, "--json"], deps(stub, { env: { ANTHROPIC_API_KEY: "x" } }));
  assert.equal(listed.result.status, "needs_provider_connector");
  assert.match(String(listed.result.handoff), /NANGO_SECRET_KEY/);
  assert.equal(stub.log.length, 0);
});

test("list: bounded listing, internal-only recording excluded, one matched recording, no transcript fetch, no address on the surface", async () => {
  const stub = makeE2EStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runZoomDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.result.status, "ok");
  const listCoverage = listed.result.coverage as Record<string, any>;
  assert.equal(listCoverage.recordings_listed, 2);
  assert.equal(listCoverage.internal_only_excluded, 1);
  assert.equal(listCoverage.candidates_evaluated, 1);
  assert.equal(listCoverage.transcript_opened, false);
  assert.equal(transcriptDownloads(stub).length, 0, "listing never opens a transcript");
  assert.doesNotMatch(listed.output, new RegExp(`${MEETING_UUID}|chris@|exampletonbros\\.com`), "no recording id or address on the list surface");
});

test("process: exactly one transcript download, roles rendered, sanitized evidence applied, canary nowhere, one-time proof consumed", async () => {
  const stub = makeE2EStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const listed = await runZoomDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  assert.equal(listed.result.status, "ok", listed.output);

  const processed = await runZoomDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.exitCode, 0, processed.output);
  assert.equal(processed.result.status, "needs_review");
  const processCoverage = processed.result.coverage as Record<string, any>;
  assert.equal(processCoverage.transcript_body_requests, 1);
  assert.equal(processCoverage.model, "claude-opus-5");
  // Budget accounting is on the record: the estimate and the ceiling.
  assert.ok(processCoverage.budget.estimated_model_input_tokens > 0);
  assert.equal(processCoverage.budget.max_model_input_tokens, ZOOM_POLICY.max_model_input_tokens);
  const downloads = transcriptDownloads(stub);
  assert.equal(downloads.length, 1, "processing opens exactly one transcript");
  assert.equal(downloads[0].url, TRANSCRIPT_URL);

  // Evidence landed, review stops automation, and the raw transcript is nowhere.
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.match(findings, /reversible shared notebook|shared notebook/);
  assert.match(findings, /unassigned_call_evidence/);
  for (const file of allFiles(root)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(CANARY), `${file} holds transcript text`);
    assert.doesNotMatch(text, /chris@exampletonbros\.com|nango-secret-test|zoom-oauth-token/, `${file} holds a private value`);
  }
  assert.doesNotMatch(processed.output, new RegExp(CANARY));
  assert.doesNotMatch(processed.output, /chris@|nango-secret|zoom-oauth-token/);
  // The one-time proof was consumed: a repeat cannot open the recording again.
  assert.equal(existsSync(path.join(root, ".foo", "discovery", "inbox_zoom_exampleton_q3", "proof.json")), false);
  const again = await runZoomDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(again.result.status, "needs_research_proof");
  assert.equal(transcriptDownloads(stub).length, 1, "the repeat opened nothing");
});

test("a synthesized identity leak writes nothing: the envelope is refused before any apply", async () => {
  const stub = makeE2EStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  await runZoomDiscovery(root, ["list", TARGET, "--json"], deps(stub));
  stub.modelReply = () => JSON.stringify({
    findings: [
      { headline: "Chris Exampleton keeps exercises in a reversible shared notebook", paraphrase: "The customer described storing workshop exercises in a shared notebook.", evidence_type: "stated", locator: "not available", confidence: "high", dissent: "Only one workflow was described.", relationship_hint: "new" },
    ],
    contact_candidates: [{ title: "CEO" }],
    coverage: { transcript_complete: true, caveats: [] },
  });
  const processed = await runZoomDiscovery(root, ["process", TARGET, "--json"], deps(stub));
  assert.equal(processed.result.status, "invalid");
  const errors = processed.result.errors as Array<{ code: string }>;
  assert.equal(errors[0].code, "E_DISCOVERY_INVALID_ENVELOPE");
  const findings = readFileSync(path.join(inbox, "findings.yaml"), "utf8");
  assert.doesNotMatch(findings, /Chris Exampleton|shared notebook/);
  for (const file of allFiles(root)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(CANARY), `${file} holds transcript text`);
  }
});

test("sync: metadata and match for every approved Zoom lane, and no transcript is ever opened", async () => {
  const stub = makeE2EStub();
  const { root, inbox } = fixture();
  approveScope(inbox);
  const synced = await runZoomDiscovery(root, ["sync", "--json"], deps(stub));
  assert.equal(synced.exitCode, 0, synced.output);
  assert.equal(synced.result.status, "ok");
  const coverage = synced.result.coverage as Record<string, any>;
  assert.equal(coverage.transcripts_opened, 0);
  assert.equal(transcriptDownloads(stub).length, 0, "sync never opens a transcript");
  assert.doesNotMatch(synced.output, new RegExp(CANARY));
  for (const file of allFiles(root)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(CANARY), `${file} holds transcript text`);
  }
});
