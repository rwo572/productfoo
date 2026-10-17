import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runResearchCommand } from "../src/research.js";

function paper(root: string, run = "r-invented-1234", status = "available"): string {
  const file = path.join(root, "paper.md");
  writeFileSync(file, `---\ntopic: public CRM\ndate: 2026-10-13\ndepth: standard\nresearch_run: ${run}\nsources:\n  web_firecrawl: ${status}\n---\n\n## Findings\n\n### 1. A claim\n- Evidence: \`primary\` · confidence \`high\` · source: https://example.com\n- Dissent: none\n`);
  return file;
}

test("seal cannot turn an invented run and a source declaration into proof", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-execution-"));
  assert.equal(runResearchCommand(root, ["seal", paper(root)]).exitCode, 1);
});

import { readFileSync, rmSync } from "node:fs";
import { createResearchPolicy, executeResearchSearch, loadRetrievalProof, verifyRetrievalProof } from "../src/researchExecution.js";
import { sealPaperReceipt, verifyPaperReceipt, publishPaperReceipt } from "../src/researchCompletion.js";
const NOW = "2026-10-13T12:00:00.000Z";
function setup(required = true) {
  const root = mkdtempSync(path.join(tmpdir(), "foo-execution-"));
  const run = "r-real-1234";
  const runtime = { env: { FOO_STATE_DIR: path.join(root, "state"), FIRECRAWL_API_KEY: required ? "test-credential" : "" }, keyDir: path.join(root, "keys"), now: NOW };
  createResearchPolicy(root, run, "public CRM", runtime);
  return { root, run, runtime };
}
const success: typeof fetch = async () => new Response(JSON.stringify({ success: true, data: { web: [{ url: "https://example.com", title: "Public result" }] } }));
function sealFixture(root: string, run: string, keyDir: string) {
  return sealPaperReceipt(root, { runId: run, topic: "public CRM", paperBytes: Buffer.from("paper"),
    sources: [{ source_class: "web_firecrawl", reached: true, item_count: 999 }],
    provider: { adapter: "single-model", model: "test" }, evaluatorVersion: "research-format-v2", keyDir, now: NOW });
}
test("a real planned run still cannot seal without executing the required source", () => {
  const { root, run, runtime } = setup();
  assert.throws(() => sealFixture(root, run, runtime.keyDir), /required Firecrawl retrieval is missing/);
});
test("direct execution binds real counts, hides credentials and survives a fresh clone", async () => {
  const { root, run, runtime } = setup();
  let calls = 0;
  const result = await executeResearchSearch(root, run, '{"query":"public CRM"}', { ...runtime, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, "https://api.firecrawl.dev/v2/search");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-credential");
    return success(url, init);
  }});
  assert.equal(calls, 1); assert.equal(result.exitCode, 0); assert.doesNotMatch(result.output, /test-credential/);
  sealFixture(root, run, runtime.keyDir);
  publishPaperReceipt(root, run);
  const stored = readFileSync(path.join(root, "research", ".runs", `${run}.receipt.json`), "utf8");
  assert.doesNotMatch(stored, /test-credential|Public result|example.com/);
  rmSync(path.join(root, ".foo"), { recursive: true });
  const verified = verifyPaperReceipt(root, run, Buffer.from("paper"), { now: NOW });
  assert.ok(verified.ok);
  if (verified.ok) assert.deepEqual(verified.receipt.sources, [{ source_class: "web_firecrawl", reached: true, item_count: 1 }]);
});
test("failure after success invalidates the earlier success and blocks sealing", async () => {
  const { root, run, runtime } = setup();
  await executeResearchSearch(root, run, '{"query":"first"}', { ...runtime, fetchImpl: success });
  const failed = await executeResearchSearch(root, run, '{"query":"second"}', { ...runtime,
    fetchImpl: async () => new Response('{"success":false,"error":"test-credential"}') });
  assert.equal(failed.exitCode, 1); assert.doesNotMatch(failed.output, /test-credential/);
  assert.throws(() => sealFixture(root, run, runtime.keyDir), /did not succeed/);
});
test("execution cannot be replayed for another run or topic, or edited", async () => {
  const { root, run, runtime } = setup();
  await executeResearchSearch(root, run, '{"query":"public CRM"}', { ...runtime, fetchImpl: success });
  const proof = loadRetrievalProof(root, run);
  assert.equal(verifyRetrievalProof(root, "r-other-1234", "public CRM", proof, NOW).ok, false);
  assert.equal(verifyRetrievalProof(root, run, "different topic", proof, NOW).ok, false);
  (proof.execution!.payload as Record<string, unknown>).item_count = 100;
  assert.equal(verifyRetrievalProof(root, run, "public CRM", proof, NOW).ok, false);
});
test("key disappearance and endpoint overrides cannot reuse success", async () => {
  for (const env of [{ FIRECRAWL_API_KEY: "" }, { FIRECRAWL_BASE_URL: "http://localhost:9000" }]) {
    const { root, run, runtime } = setup();
    await executeResearchSearch(root, run, '{"query":"first"}', { ...runtime, fetchImpl: success });
    let calls = 0;
    const result = await executeResearchSearch(root, run, '{"query":"second"}', { ...runtime, env: { ...runtime.env, ...env }, fetchImpl: async () => { calls++; return success(""); } });
    assert.equal(result.exitCode, 1); assert.equal(calls, 0);
    assert.equal(verifyRetrievalProof(root, run, "public CRM", loadRetrievalProof(root, run), NOW).ok, false);
  }
});
test("a sealed run cannot execute again or seal changed paper bytes", async () => {
  const { root, run, runtime } = setup();
  await executeResearchSearch(root, run, '{"query":"public CRM"}', { ...runtime, fetchImpl: success });
  sealFixture(root, run, runtime.keyDir);
  await assert.rejects(executeResearchSearch(root, run, '{"query":"again"}', runtime), /already sealed/);
  assert.throws(() => sealPaperReceipt(root, { runId: run, topic: "public CRM", paperBytes: Buffer.from("changed"), sources: [],
    provider: { adapter: "test", model: "test" }, evaluatorVersion: "v2", ...runtime }), /already sealed/);
});
test("unavailable access is signed explicitly, never a reached source", () => {
  const { root, run } = setup(false);
  const result = verifyRetrievalProof(root, run, "public CRM", loadRetrievalProof(root, run), NOW);
  assert.ok(result.ok);
  if (result.ok) { assert.equal(result.availability, "unavailable"); assert.equal(result.source.reached, false); }
});

test("zero results records a successful call with zero items; malformed and failed responses cannot seal", async () => {
  const empty = setup();
  assert.equal((await executeResearchSearch(empty.root, empty.run, '{"query":"public"}', { ...empty.runtime,
    fetchImpl: async () => new Response('{"success":true,"data":{"web":[]}}') })).exitCode, 0);
  const verdict = verifyRetrievalProof(empty.root, empty.run, "public CRM", loadRetrievalProof(empty.root, empty.run), NOW);
  assert.ok(verdict.ok); if (verdict.ok) assert.equal(verdict.source.item_count, 0);
  for (const fetchImpl of [
    async () => new Response('not json'),
    async () => new Response('{"success":true}'),
    async () => new Response('{"success":true,"data":{"web":[]}}', { status: 429 }),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => { throw new Error('timeout or network failure'); },
  ]) {
    const { root, run, runtime } = setup();
    assert.equal((await executeResearchSearch(root, run, '{"query":"public"}', { ...runtime, fetchImpl })).exitCode, 1);
    assert.throws(() => sealFixture(root, run, runtime.keyDir), /did not succeed/);
  }
});

import { mintCompletionReceipt } from "../src/researchReceipt.js";
import { loadOrCreateFooSigningKey } from "../src/researchSigningKey.js";
import { researchDigest } from "../src/researchExecution.js";
import { mkdirSync } from "node:fs";
test("a valid legacy signature over declared sources is not execution verification", () => {
  const { root, run, runtime } = setup();
  const key = loadOrCreateFooSigningKey(root, runtime);
  const receipt = mintCompletionReceipt({ run_id: run, topic: "public CRM", state: "completed",
    sources: [{ source_class: "web_firecrawl", reached: true, item_count: 999 }],
    evidence_sha256: researchDigest("declared"), paper_sha256: researchDigest("paper"),
    provider: { adapter: "single-model", model: "test" }, evaluator_version: "research-format-v1",
    issued_at: NOW, sequence: 1, previous_hash: null }, key.privateKeyPem, key.keyId);
  mkdirSync(path.join(root, "research", ".runs"), { recursive: true });
  writeFileSync(path.join(root, "research", ".runs", `${run}.receipt.json`), JSON.stringify(receipt));
  assert.deepEqual(verifyPaperReceipt(root, run, Buffer.from("paper"), { now: NOW }), { ok: false, reason: "execution_unverified" });
});
