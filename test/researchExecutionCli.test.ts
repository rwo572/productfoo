import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  evaluateResearchGate, markResearchActive, markResearchRequested,
  recordWebRead, researchActive, researchRequested, webReadsLookLikeResearch,
} from "../src/researchGate.js";

// The same behavior suite can target the actual installed public JS entrypoint.
const CLI = process.env.FOO_TEST_PUBLIC_CLI ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
function setup(keyed = true, response: unknown = { success: true, data: { web: [{ url: "https://example.com", title: "Fixture" }] } }) {
  const root = mkdtempSync(path.join(tmpdir(), "foo-public-research-"));
  mkdirSync(path.join(root, "home"));
  const calls = path.join(root, "calls.jsonl");
  const preload = path.join(root, "transport.mjs");
  writeFileSync(preload, `import {appendFileSync} from 'node:fs';
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://api.firecrawl.dev/v2/search') throw new Error('unexpected network');
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url, body: JSON.parse(init.body)})+'\\n');
      return new Response(${JSON.stringify(JSON.stringify(response))});
    };`);
  const env = { ...process.env, HOME: path.join(root, "home"), FOO_STATE_DIR: path.join(root, "state"),
    FIRECRAWL_API_KEY: keyed ? "fixture-key" : "", FOO_SKILL_TOKEN: "", FOO_FIRECRAWL_ENTITLEMENT: "", FIRECRAWL_BASE_URL: "",
    NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_ALLOW_RAW_RESEARCH: "", NODE_OPTIONS: "" };
  const run = (args: string[], input?: string, overrides = {}) => spawnSync(process.execPath,
    ["--import", pathToFileURL(preload).href, CLI, "--root", root, "research", ...args],
    { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", input });
  const paper = (id: string, status = "available", topic = "local private planning topic") => {
    const f = path.join(root, "paper.md");
    writeFileSync(f, `---\ntopic: ${topic}\ndate: 2026-10-13\ndepth: standard\nresearch_run: ${id}\nsources:\n  web_firecrawl: ${status}\n---\n\n## Findings\n\n### 1. Public claim\n- Evidence: \`primary\` · confidence \`high\` · source: https://example.com\n- Dissent: none\n`);
    return f;
  };
  return { root, calls, run, paper };
}

const researchTopic = "Compare local parser approaches";
const webLookup = { tool_name: "WebSearch", tool_input: { query: "parser approaches" } };
const researchLane = { tool_name: "Agent", tool_input: { prompt: "Research parsers using WebSearch and return sources." } };

for (const json of [false, true]) {
  test(`successful research planning clears the matching request and permits bounded work (${json ? "JSON" : "text"})`, () => {
    const { root, calls, run } = setup(false);
    markResearchRequested(root, `  Compare\nlocal   parser approaches  `);
    for (let i = 0; i < 4; i++) recordWebRead(root);
    assert.equal(evaluateResearchGate(webLookup, root, {}).allow, false);
    assert.equal(evaluateResearchGate(researchLane, root, {}).allow, false);
    const result = run([researchTopic, ...(json ? ["--json"] : [])]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(researchRequested(root), null);
    assert.equal(researchActive(root), true);
    assert.equal(webReadsLookLikeResearch(root), false);
    assert.equal(evaluateResearchGate(webLookup, root, {}).allow, true);
    assert.equal(evaluateResearchGate(researchLane, root, {}).allow, true);
    assert.equal(existsSync(calls), false, "planning must remain local");
    const marker = JSON.parse(readFileSync(path.join(root, ".foo", "research-active.json"), "utf8"));
    assert.equal(marker.topic, researchTopic);
    assert.equal(marker.lanes, 8, "preserve the existing bounded allowance");
    for (const call of [webLookup, { tool_name: "Read", tool_input: { file_path: "README.md" } }]) {
      assert.equal(run(["gate"], JSON.stringify(call)).stdout, "");
    }
    assert.equal(run(["gate"], JSON.stringify(researchLane), { FOO_ALLOW_RAW_RESEARCH: "1" }).stdout, "");
    assert.equal(JSON.parse(readFileSync(path.join(root, ".foo", "research-active.json"), "utf8")).lanes, 8,
      "lookups, local reads, and deliberate overrides do not spend governed fan-out lanes");
    for (let i = 0; i < 8; i++) {
      const allowed = run(["gate"], JSON.stringify(researchLane));
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(allowed.stdout, "");
    }
    const denied = run(["gate"], JSON.stringify(researchLane));
    assert.equal(denied.status, 0, "Claude gate denials use structured output, not process failure");
    assert.notEqual(denied.stdout, "", "the ninth CLI gate call must emit a denial");
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny",
      "starting a plan must not grant unlimited fan-out");
  });
}

test("a new research plan activates without a prompt-router request", () => {
  const { root, run } = setup(false);
  const result = run([researchTopic, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(researchActive(root), true);
});

test("a mismatched research plan preserves pending and active state and read counts", () => {
  const { root, run } = setup(false);
  markResearchActive(root, "previous run", Date.now(), 2);
  markResearchRequested(root, researchTopic);
  for (let i = 0; i < 4; i++) recordWebRead(root);
  const marker = path.join(root, ".foo", "research-active.json");
  const before = readFileSync(marker, "utf8");
  const result = run(["Compare unrelated databases", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(researchRequested(root), researchTopic);
  assert.equal(readFileSync(marker, "utf8"), before);
  assert.equal(webReadsLookLikeResearch(root), true);
});

for (const failure of ["invalid-arguments", "unavailable-provider", "failed-retrieval"] as const) {
  test(`failed research start preserves gate state: ${failure}`, () => {
    const { root, run } = setup(failure !== "unavailable-provider", { success: false, error: "synthetic retrieval failure" });
    markResearchRequested(root, researchTopic);
    for (let i = 0; i < 4; i++) recordWebRead(root);
    const args = failure === "invalid-arguments" ? [researchTopic, "--depth", "invalid"]
      : [researchTopic, "--public-query", "public parser approaches", "--json"];
    const result = run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(researchRequested(root), researchTopic);
    assert.equal(researchActive(root), false);
    assert.equal(existsSync(path.join(root, ".foo", "research-active.json")), false);
    assert.equal(webReadsLookLikeResearch(root), true);
    assert.equal(evaluateResearchGate(webLookup, root, {}).allow, false);
  });
}

for (const transport of ["api", "plugin"] as const) {
  test(`successful explicit-query start activates research after ${transport} preparation`, () => {
    const { root, run } = setup();
    markResearchRequested(root, researchTopic);
    const result = run([researchTopic, "--firecrawl", transport, "--public-query", "public parser approaches", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(researchRequested(root), null);
    assert.equal(researchActive(root), true);
    assert.equal(evaluateResearchGate(webLookup, root, {}).allow, true);
  });
}
test("public CLI plans locally, requires Firecrawl, and refuses claimed or excluded retrieval", () => {
  const { calls, run, paper } = setup();
  const result = run(["local private planning topic", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.retrieval.required, true); assert.equal(plan.retrieval.status, "pending");
  assert.equal(existsSync(calls), false);
  for (const status of ["available", "excluded"]) {
    const denied = run(["seal", paper(plan.run_id, status)], undefined, { FOO_ALLOW_RAW_RESEARCH: "1" });
    assert.equal(denied.status, 1); assert.match(denied.stdout + denied.stderr, /required Firecrawl retrieval is missing/);
  }
});
test("public CLI executes one explicit public query and validates its completion", () => {
  const { root, calls, run, paper } = setup();
  const result = run(["local private planning topic", "--public-query", "public CRM", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.retrieval.status, "succeeded");
  const requests = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(requests.length, 1); assert.doesNotMatch(requests[0], /private planning|fixture-key/);
  assert.equal(JSON.parse(requests[0]).body.query, "public CRM");
  const report = paper(plan.run_id);
  assert.equal(run(["seal", report]).status, 0);
  const validated = run(["validate", report, "--json"]);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  assert.equal(JSON.parse(validated.stdout).execution_verified, true);
  const stored = JSON.parse(readFileSync(path.join(root, "research", ".runs", `${plan.run_id}.receipt.json`), "utf8"));
  assert.equal(stored.payload.sources[0].item_count, 1);
  assert.equal(run(["seal", paper(plan.run_id, "available", "a substituted topic")]).status, 1);
});
test("public CLI resumes through --run and rejects arbitrary request fields before network", () => {
  const { calls, run, paper } = setup();
  const plan = JSON.parse(run(["local private planning topic", "--json"]).stdout);
  const args = ["firecrawl", "search", "--run", plan.run_id, "--request-stdin"];
  assert.equal(run(args, '{"query":"public CRM","webhook":"https://example.com"}').status, 1);
  assert.equal(existsSync(calls), false);
  const result = run(args, '{"query":"public CRM","limit":2}');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 0);
});
test("application failure is disclosed and cannot produce completion", () => {
  const { run, paper } = setup(true, { success: false, error: "fixture-key" });
  const result = run(["local private planning topic", "--public-query", "public CRM", "--json"]);
  assert.equal(result.status, 1);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.retrieval.status, "failed"); assert.doesNotMatch(result.stdout, /fixture-key/);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
});
test("unavailable Firecrawl requires explicit disclosure; raw and format checks never claim execution", () => {
  const { calls, run, paper } = setup(false);
  const plan = JSON.parse(run(["local private planning topic", "--json"]).stdout);
  assert.equal(plan.retrieval.status, "unavailable"); assert.equal(existsSync(calls), false);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
  const report = paper(plan.run_id, "excluded");
  assert.equal(run(["seal", report]).status, 0);
  const raw = run(["validate", report, "--json"], undefined, { FOO_ALLOW_RAW_RESEARCH: "1" });
  assert.equal(raw.status, 1);
  assert.equal(JSON.parse(raw.stdout).execution_verified, false);
  const fallback = JSON.parse(run(["validate", report, "--json"]).stdout);
  assert.equal(fallback.completion_verified, true);
  assert.equal(fallback.execution_verified, false);
  assert.equal(fallback.retrieval.status, "unavailable");
  const format = run(["validate", report, "--format", "--json"]);
  assert.equal(JSON.parse(format.stdout).validation_scope, "format_only");
  assert.equal(JSON.parse(format.stdout).execution_verified, false);
});

test("seal rejects invalid first-party evidence before binding paper bytes", () => {
  const { run, paper } = setup();
  const plan = JSON.parse(run(["local private planning topic", "--public-query", "public CRM", "--json"]).stdout);
  const report = paper(plan.run_id);
  const base = readFileSync(report, "utf8");
  const self = '\n## How this paper was produced safely (first-party)\n\n- What productfoo itself ships\n- Evidence: `wrong` · confidence `high` · source: src/research.ts\n- Dissent: none\n';
  writeFileSync(report, base + self);
  assert.equal(run(["seal", report]).status, 1);
  writeFileSync(report, base + self.replace('`wrong`', '`vendor`'));
  assert.equal(run(["seal", report]).status, 0);
  assert.equal(run(["validate", report]).status, 0);
});

test("plugin-only research requires a result and discloses host-reported assurance", () => {
  const { root, calls, run, paper } = setup(false);
  const planResult = run(["local private planning topic", "--firecrawl", "plugin", "--public-query", "public CRM", "--json"]);
  assert.equal(planResult.status, 0, planResult.stdout + planResult.stderr);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.retrieval.transport, "plugin");
  assert.equal(plan.retrieval.status, "pending");
  assert.equal(existsSync(calls), false);
  const attempt = plan.result;
  assert.equal(attempt.tool, "firecrawl_search");
  assert.deepEqual(attempt.arguments, { query: "public CRM", limit: 5, sources: ["web"], domainTools: false });
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
  const record = (result: unknown, attemptId = attempt.attempt_id) => run(["firecrawl", "plugin-record", "--run", plan.run_id, "--result-stdin"], JSON.stringify({ attempt_id: attemptId, result }));
  assert.equal(record({ success: true, data: { web: [{url: "https://example.com"}] } }, "wrong-attempt").status, 1);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
  // Full MCP wrapper from the host, with structured output.
  const recorded = record({ isError: false, structuredContent: { success: true, data: { web: [{url: "https://example.com"}] } } });
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).execution_verified, false);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 0);
  const validation = run(["validate", paper(plan.run_id), "--json"]);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  const verified = JSON.parse(validation.stdout);
  assert.equal(verified.completion_verified, true);
  assert.equal(verified.execution_verified, false);
  assert.equal(verified.retrieval.assurance, "host_reported");
  assert.equal(verified.retrieval.transport, "plugin");
  assert.equal(verified.retrieval.item_count, 1);
  assert.equal(record({ success: true, data: {web: []} }).status, 1);
  const receipt = readFileSync(path.join(root, "research", ".runs", `${plan.run_id}.receipt.json`), "utf8");
  assert.doesNotMatch(receipt, /public CRM|https:\/\/example.com/);
});

test("plugin attempts reject replay, errors, malformed results and API policy downgrade", () => {
  const { run, paper } = setup(true);
  const api = JSON.parse(run(["local private planning topic", "--json"]).stdout);
  const prepare = (id: string) => run(["firecrawl", "plugin-prepare", "--run", id, "--request-stdin"], '{"query":"public CRM","limit":1}');
  assert.equal(prepare(api.run_id).status, 1);
  const plan = JSON.parse(run(["local private planning topic", "--firecrawl", "plugin", "--json"]).stdout);
  const first = JSON.parse(prepare(plan.run_id).stdout);
  const second = JSON.parse(prepare(plan.run_id).stdout);
  const record = (id: string, result: unknown) => run(["firecrawl", "plugin-record", "--run", plan.run_id, "--result-stdin"], JSON.stringify({attempt_id:id,result}));
  assert.equal(record(first.attempt_id, {success:true,data:{web:[]}}).status, 1);
  for (const result of [{ success:false,data:{web:[]} }, {success:true}, {isError:true,structuredContent:{success:true,data:{web:[]}}}, {success:true,data:{web:[{url:"file:///private"}] }}, {success:true,data:{web:[{url:"https://a.example"},{url:"https://b.example"}]}}]) {
    assert.equal(record(second.attempt_id, result).status, 1);
    assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
  }
  const ok = record(second.attempt_id, {content:[{type:"text",text:JSON.stringify({success:true,data:{web:[]}})}]});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(record(second.attempt_id, {success:true,data:{web:[]}}).status, 1);
  // API failure must not resurrect a consumed plugin attempt.
  const failedApi = run(["firecrawl", "search", "--run", plan.run_id, "--request-stdin"], '{"query":"public CRM"}', {FIRECRAWL_API_KEY:""});
  assert.equal(failedApi.status, 1);
  assert.equal(record(second.attempt_id, {success:true,data:{web:[]}}).status, 1);
  // Preparing another attempt invalidates the previous success.
  assert.equal(prepare(plan.run_id).status, 0);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
  // Explicit API execution can satisfy a plugin plan with stronger assurance.
  const direct = run(["firecrawl", "search", "--run", plan.run_id, "--request-stdin"], '{"query":"public CRM"}');
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 0);
  const validated = JSON.parse(run(["validate", paper(plan.run_id), "--json"]).stdout);
  assert.equal(validated.execution_verified, true);
  assert.equal(validated.retrieval.transport, "api");
});

test("plugin recording refuses a stale signed attempt after an interrupted prepare", () => {
  const { root, run, paper } = setup(false);
  const plan = JSON.parse(run(["local private planning topic", "--firecrawl", "plugin", "--public-query", "public CRM", "--json"]).stdout);
  const attemptFile = path.join(root, ".foo", "research-runs", `${plan.run_id}.plugin-attempt.json`);
  const oldAttempt = readFileSync(attemptFile, "utf8");
  const prepared = run(["firecrawl", "plugin-prepare", "--run", plan.run_id, "--request-stdin"], '{"query":"another public query"}');
  assert.equal(prepared.status, 0);
  // A crash between the execution and attempt writes leaves the older signed file.
  writeFileSync(attemptFile, oldAttempt);
  const replay = run(["firecrawl", "plugin-record", "--run", plan.run_id, "--result-stdin"], JSON.stringify({attempt_id:plan.result.attempt_id,result:{success:true,data:{web:[]}}}));
  assert.equal(replay.status, 1, replay.stdout + replay.stderr);
  assert.match(replay.stdout + replay.stderr, /no longer current/);
  assert.equal(run(["seal", paper(plan.run_id)]).status, 1);
});


test("resealing an edited paper refuses clearly, preserves proof, and recovers through a new run (#929)", () => {
  const { root, calls, run, paper } = setup();
  const planArgs = ["local private planning topic", "--public-query", "public CRM", "--json"];
  const planned = run(planArgs);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const report = paper(plan.run_id);
  const original = readFileSync(report, "utf8");
  const firstSeal = run(["seal", report]);
  assert.equal(firstSeal.status, 0, firstSeal.stdout + firstSeal.stderr);
  const receipt = path.join(root, "research", ".runs", `${plan.run_id}.receipt.json`);
  const working = path.join(root, ".foo", "research-runs", `${plan.run_id}.receipt.json`);
  const publishedBytes = readFileSync(receipt);
  const workingBytes = readFileSync(working);

  // Repeating a seal on the same bytes is harmless, including its published copy.
  const repeat = run(["seal", report]);
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.match(repeat.stdout, /already sealed/);
  assert.deepEqual(readFileSync(receipt), publishedBytes);
  assert.deepEqual(readFileSync(working), workingBytes);

  const edited = original.replace("### 1. Public claim", "### 1. Revised public claim");
  writeFileSync(report, edited);
  const reseal = run(["seal", report]);
  assert.equal(reseal.status, 1);
  assert.match(reseal.stdout + reseal.stderr, /paper changed since sealing/);
  assert.match(reseal.stdout + reseal.stderr, /foo research "<topic>"/);
  assert.match(reseal.stdout + reseal.stderr, /research_run/);
  const validation = run(["validate", report, "--json"]);
  assert.equal(validation.status, 1);
  assert.match(validation.stderr, /paper changed since sealing/);
  assert.match(validation.stderr, /paper_mismatch/);
  assert.doesNotMatch(validation.stderr, /no record|no_receipt/);
  assert.deepEqual(readFileSync(receipt), publishedBytes);
  assert.deepEqual(readFileSync(working), workingBytes);

  writeFileSync(report, original);
  assert.equal(run(["validate", report, "--json"]).status, 0);

  // Follow the offered recovery: execute a new run and bind the revision to it.
  const replanned = run(planArgs);
  assert.equal(replanned.status, 0, replanned.stdout + replanned.stderr);
  const next = JSON.parse(replanned.stdout);
  assert.notEqual(next.run_id, plan.run_id);
  writeFileSync(report, edited.replace(plan.run_id, next.run_id));
  const recoveredSeal = run(["seal", report]);
  assert.equal(recoveredSeal.status, 0, recoveredSeal.stdout + recoveredSeal.stderr);
  const recovered = run(["validate", report, "--json"]);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).execution_verified, true);
  assert.deepEqual(readFileSync(receipt), publishedBytes);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
});

test("missing and invalid receipts are not mislabeled as an edited paper (#929)", () => {
  const { root, run, paper } = setup();
  const plan = JSON.parse(run(["local private planning topic", "--public-query", "public CRM", "--json"]).stdout);
  const report = paper(plan.run_id);
  const missing = run(["validate", report]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no_receipt/);
  assert.doesNotMatch(missing.stderr, /paper changed since sealing/);
  assert.equal(run(["seal", report]).status, 0);
  const receipt = path.join(root, "research", ".runs", `${plan.run_id}.receipt.json`);
  const stored = JSON.parse(readFileSync(receipt, "utf8"));
  stored.payload.topic = "tampered topic";
  writeFileSync(receipt, JSON.stringify(stored));
  const invalid = run(["validate", report]);
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /paper changed since sealing|no_receipt/);
  const reseal = run(["seal", report]);
  assert.equal(reseal.status, 1);
  assert.doesNotMatch(reseal.stdout + reseal.stderr, /paper changed since sealing/);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).payload.topic, "tampered topic");
});
