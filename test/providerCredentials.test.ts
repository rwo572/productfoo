import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { firecrawlKeyStatus, firecrawlLoginCommand, firecrawlLogoutCommand } from "../src/commands/login.js";
import { credentialsPath, resolveFirecrawlKey } from "../src/tokenStore.js";

const key = ["fc", "synthetic", "provider", "credential"].join("-");

test("direct provider login validates at Firecrawl, stores privately, and preserves unrelated credentials", async (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-provider-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const legacy = ["legacy", "inert", "credential"].join("-");
  const env = { FOO_STATE_DIR: state, FOO_SKILL_SERVER: "https://legacy.invalid", FOO_SKILL_TOKEN: legacy };
  writeFileSync(credentialsPath(env), JSON.stringify({ skill_token: legacy, other_provider: "unchanged" }));
  chmodSync(state, 0o755);
  chmodSync(credentialsPath(env), 0o644);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    return new Response("{}", { status: 200 });
  });
  const result = await firecrawlLoginCommand(key, { env });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requests, ["https://api.firecrawl.dev/v1/team/credit-usage"]);
  assert.doesNotMatch(result.output, /alpha|hosted|bridge/);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(credentialsPath(env)).mode & 0o777, 0o600);
  assert.deepEqual(resolveFirecrawlKey(env), { key, source: "stored" });
  assert.deepEqual(resolveFirecrawlKey({ ...env, FIRECRAWL_API_KEY: "explicit-key" }), { key: "explicit-key", source: "env" });
  assert.equal(firecrawlKeyStatus(env).present, true);
  assert.equal(firecrawlLogoutCommand(env).exitCode, 0);
  assert.deepEqual(resolveFirecrawlKey(env), { key: null, source: "none" });
  assert.deepEqual(JSON.parse(readFileSync(credentialsPath(env), "utf8")), { skill_token: legacy, other_provider: "unchanged" });
  assert.equal(requests.length, 1, "logout and status remain local");
});

test("rejected provider login preserves existing key; forced login and logout stay offline", async (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-provider-rejection-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const env = { FOO_STATE_DIR: state };
  const network = t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
  assert.equal((await firecrawlLoginCommand(key, { env, force: true })).exitCode, 0);
  assert.equal(network.mock.callCount(), 0);
  assert.equal((await firecrawlLoginCommand("rejected-key", { env })).exitCode, 1);
  assert.equal(resolveFirecrawlKey(env).key, key);
  const result = firecrawlLogoutCommand({ ...env, FIRECRAWL_API_KEY: "explicit-key" });
  assert.match(result.output, /remains set in this shell/);
  assert.equal(existsSync(credentialsPath(env)), false);
  assert.equal(network.mock.callCount(), 1);
});

test("malformed stored provider values are ignored", (t) => {
  const state = mkdtempSync(path.join(tmpdir(), "foo-provider-malformed-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const env = { FOO_STATE_DIR: state };
  for (const value of ["{", "[]", "null", '{"firecrawl_api_key":42}']) {
    writeFileSync(credentialsPath(env), value);
    assert.deepEqual(resolveFirecrawlKey(env), { key: null, source: "none" });
  }
});
