import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const smokeCore = (await import(new URL("../../scripts/lib/publicSmokeCore.mjs", import.meta.url).href)) as typeof import("../scripts/lib/publicSmokeCore.mjs");

function isolated(code: string): unknown {
  const root = mkdtempSync(path.join(tmpdir(), "foo-report-child-"));
  const guard = path.join(root, "network-deny.cjs");
  const attempts = path.join(root, "network-attempts.log");
  writeFileSync(guard, smokeCore.REPORTING_NET_DENY_PRELOAD_SOURCE);
  writeFileSync(attempts, "");
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...smokeCore.cleanInstallEnv(root), NODE_OPTIONS: `--require=${guard}`, FOO_REPORT_NETWORK_ATTEMPTS: attempts },
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, `${child.error ?? ""}${child.stdout}${child.stderr}`);
    assert.equal(readFileSync(attempts, "utf8"), "", "a caught network attempt must still fail acceptance");
    return JSON.parse(child.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("public reporting acceptance exercises capture, privacy, local approval, canonical payload and removed sending offline", () => {
  const results = isolated(`
    const api = await import(${JSON.stringify(new URL("../src/index.js", import.meta.url).href)});
    const { reportingAcceptance } = await import(${JSON.stringify(new URL("./helpers/reportingAcceptance.js", import.meta.url).href)});
    console.log(JSON.stringify(await reportingAcceptance(api)));
  `) as { status: string }[];
  assert.equal(results.length, 9);
  assert.ok(results.every(result => result.status === "pass"));
});

test("CLI report dispatch and bug alias ignore retired transport injection in a piped child process", () => {
  const result = isolated(`
    const { main } = await import(${JSON.stringify(new URL("../src/cli.js", import.meta.url).href)});
    const originalWrite = process.stdout.write;
    let output = ""; let sends = 0;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    const deps = { report: { env: {}, transport: {
      destination: "foo-owner-relay:bug-capsules/v0",
      async send(capsule, digest) {
        sends++;
        return { schema_version: "0.1", receipt_id: "018f05d4-54fc-72ab-aa2a-2a2a2a2a2a2a", capsule_id: capsule.capsule_id, payload_digest: digest, accepted_at: "2026-07-19T00:00:01.000Z", destination: "foo-owner-relay:bug-capsules/v0", status: "accepted", error: null };
      }, async delete() { throw new Error("unused"); },
    } } };
    const invoke = async (args) => {
      output = "";
      const code = await main(["--root", process.cwd(), ...args, "--json"], deps);
      return { code, result: JSON.parse(output) };
    };
    const added = await invoke(["bug", "Synthetic wrong behavior", "--expected", "Expected behavior"]);
    const { capsule_id: id, payload_digest: digest } = added.result;
    const shown = await invoke(["report", "show", id]);
    const sent = await invoke(["report", "send", id, "--approve", digest]);
    process.stdout.write = originalWrite;
    console.log(JSON.stringify({ added, shown, sent, sends }));
  `) as { added: { code: number }; shown: { code: number }; sent: { result: { status: string } }; sends: number };
  assert.equal(result.added.code, 0); assert.equal(result.shown.code, 0);
  assert.equal(result.sent.result.status, "refused"); assert.equal(result.sends, 0);
});


for (const mode of ["clean", "stored", "ambient", "combined"] as const) test(`public reporting stays local on ${mode} alpha settings`, () => {
  const results = isolated(`
    const api = await import(${JSON.stringify(new URL("../src/index.js", import.meta.url).href)});
    const { localReportingAcceptance } = await import(${JSON.stringify(new URL("./helpers/reportingAcceptance.js", import.meta.url).href)});
    console.log(JSON.stringify(await localReportingAcceptance(api, ${JSON.stringify(mode)})));
  `) as { status: string }[];
  assert.equal(results.length, 4); assert.ok(results.every(result => result.status === "pass"));
});

test("reporting fixtures reject unsafe HOME before changing credentials or environment", () => {
  const result = isolated(`
    const assert = (await import("node:assert/strict")).default;
    const { tmpdir } = await import("node:os");
    const { localReportingAcceptance } = await import(${JSON.stringify(new URL("./helpers/reportingAcceptance.js", import.meta.url).href)});
    const token = process.env.FOO_SKILL_TOKEN;
    const endpoint = process.env.FOO_SKILL_SERVER;
    for (const home of ["/", tmpdir()]) {
      process.env.HOME = home;
      await assert.rejects(localReportingAcceptance({}, "combined"), /disposable directory below/);
      assert.equal(process.env.FOO_SKILL_TOKEN, token);
      assert.equal(process.env.FOO_SKILL_SERVER, endpoint);
    }
    console.log(JSON.stringify({ rejected: 2 }));
  `) as { rejected: number };
  assert.equal(result.rejected, 2);
});
