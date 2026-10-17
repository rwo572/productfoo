import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("shipped onboarding and help advertise account-free use and local feedback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-public-copy-"));
  try {
    const env = { PATH: process.env.PATH, HOME: root, NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_STATE_DIR: path.join(root, "state"), FOO_SKIP_UPDATE_CHECK: "1", FOO_HANDOFF: "never" };
    const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve("bin/foo.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    for (const args of [["help"], ["help", "--all"]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /send product feedback|private owner bug queue|foo login --alpha|hosted alpha|alpha token/i);
      if (args.includes("--all")) {
        assert.match(result.stdout, /feedback.*local/i);
        assert.match(result.stdout, /bug log.*your.*private.*FOO_BUG_OWNER_REPO/);
      }
    }
    const retiredLogin = run("login", "--alpha", "synthetic-retired-token");
    assert.notEqual(retiredLogin.status, 0);
    assert.match(retiredLogin.stderr + retiredLogin.stdout, /needs no account/);
    // Deliberately inspect current onboarding only; history and migration notes
    // can describe retired behavior without advertising it as supported.
    for (const file of ["README.md", "docs/README.md", "docs/getting-started.md", "docs/firecrawl.md", "docs/workflows.md", "docs/cli-reference.md"]) {
      const copy = readFileSync(file, "utf8");
      assert.doesNotMatch(copy, /foo login --alpha|hosted alpha access|alpha token|send product feedback|private owner bug queue/i, file);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feedback confirms local storage, honors opt-out and never sends a request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-feedback-copy-"));
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const requests: string[] = [];
  let output = "";
  try {
    delete process.env.DO_NOT_TRACK;
    process.env.FOO_STATE_DIR = path.join(root, "state");
    process.env.FOO_SKIP_UPDATE_CHECK = "1";
    process.env.FOO_HANDOFF = "never";
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input));
      throw new Error("network denied by feedback regression test");
    }) as typeof fetch;
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    const { main } = await import(pathToFileURL(path.resolve("dist/src/cli.js")).href);
    assert.equal(await main(["--root", root, "feedback", "synthetic local feedback"]), 0);
    assert.match(output, /feedback recorded locally.*nothing was sent/i);
    const ledger = path.join(process.env.FOO_STATE_DIR, "agent-events.jsonl");
    const before = readFileSync(ledger, "utf8");
    assert.match(before, /synthetic local feedback/);
    process.env.DO_NOT_TRACK = "1";
    output = "";
    assert.equal(await main(["--root", root, "feedback", "opted out feedback"]), 0);
    assert.match(output, /Feedback not recorded/);
    assert.equal(readFileSync(ledger, "utf8"), before);
    assert.deepEqual(requests, []);
  } finally {
    process.stdout.write = originalWrite;
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

// Exercise actual public commands with legacy alpha configuration still present.
// A trap records even a swallowed fetch: success alone would miss best-effort egress.
test("legacy alpha credentials never activate usage/profile egress or hosted disclosures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-no-alpha-"));
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    delete process.env.DO_NOT_TRACK;
    process.env.FOO_STATE_DIR = path.join(root, "state");
    process.env.FOO_HOME = process.env.FOO_STATE_DIR;
    process.env.FOO_TESTER_ID = "synthetic-local-id";
    process.env.FOO_SKILL_TOKEN = "synthetic-retired-token";
    process.env.FOO_SKILL_SERVER = "http://127.0.0.1:1";
    process.env.FOO_SKIP_UPDATE_CHECK = "1";
    mkdirSync(process.env.FOO_STATE_DIR, { recursive: true });
    writeFileSync(path.join(process.env.FOO_STATE_DIR, "credentials.json"), JSON.stringify({ skill_token: "synthetic-stored-token" }));
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const { main, firstRunNotice, domainHelp } = await import(pathToFileURL(path.resolve("dist/src/cli.js")).href);
    const { reportProfile } = await import(pathToFileURL(path.resolve("dist/src/profile.js")).href);
    const { runAgentCommand } = await import(pathToFileURL(path.resolve("dist/src/commands/agent.js")).href);
    assert.equal(await main(["--root", root, "classify", "Update local documentation"]), 0);
    await reportProfile(root, { roles: ["engineer"], answered_at: "2026-10-16T00:00:00Z", building: "private free text" }, "1.0.0");
    for (const domain of ["alpha", "serve", "debug"]) assert.equal(await main(["--root", root, domain]), 1);
    assert.doesNotMatch(domainHelp("self"), /channels|self use|scripts\/channel/);
    assert.deepEqual(requests, [], "old credentials must not activate any owner-service request");
    const local = readFileSync(path.join(process.env.FOO_STATE_DIR, "agent-events.jsonl"), "utf8");
    assert.match(local, /cli_usage/);
    assert.match(local, /"event_type":"profile"/);
    assert.doesNotMatch(local, /private free text/);
    const disclosure = runAgentCommand(root, "telemetry", ["status", "--json"]);
    assert.match(disclosure, /local/i);
    assert.doesNotMatch(disclosure, /Postgres|\/ingest|alpha|owner service|remote-backed/i);
    assert.doesNotMatch(firstRunNotice(), /alpha|Anthropic|install has no key/i);
    assert.throws(() => runAgentCommand(root, "logs", ["sync", "--endpoint", "https://example.invalid", "--team", "synthetic", "--yes"]), /unknown|not available|local/i);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
