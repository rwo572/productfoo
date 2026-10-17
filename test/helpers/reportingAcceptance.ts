import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type * as Library from "../../src/index.js";
import type { BugCapsule, DeliveryReceipt } from "../../src/bugCapsule.js";

// Same acceptance cases run against source and the installed package root.
// This harness owns only synthetic data; retired capabilities are outbound traps.
export type ReportingApi = Pick<typeof Library, "runReportCommand" | "createReportRunContext" | "noteCapsuleFromThisRun" | "askToSendReports">;
export type ReportingCase = { id: string; status: "pass" };
const DESTINATION = "foo-owner-relay:bug-capsules/v0";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function receipt(capsule: BugCapsule, digest: string): DeliveryReceipt {
  return { schema_version: "0.1", receipt_id: "018f05d4-54fc-72ab-aa2a-2a2a2a2a2a2a", capsule_id: capsule.capsule_id, payload_digest: digest, accepted_at: "2026-07-19T00:00:01.000Z", destination: DESTINATION, status: "accepted", error: null };
}
export async function reportingAcceptance(api: ReportingApi): Promise<ReportingCase[]> {
  const results: ReportingCase[] = [];
  const homes: string[] = [];
  const home = () => { const root = mkdtempSync(path.join(tmpdir(), "foo-report-acceptance-")); homes.push(root); return root; };
  const check = async (id: string, body: () => Promise<void>) => { await body(); results.push({ id, status: "pass" }); };
  const add = async (root: string, actual = "Observed wrong behavior.") => {
    const added = await api.runReportCommand(root, ["add", "--expected", "Expected behavior.", "--actual", actual, "--json"], {}, {});
    assert.equal(added.status, "ready", added.output);
    assert.equal(added.result.payload, null, "capture response contains metadata only");
    return added.result;
  };
  try {
    await check("manual-capture-preview-redaction", async () => {
      const root = home();
      const saved = await add(root, "Request failed with Bearer fake_report_secret_1234567890123456 at /Users/example/private/project/handler.ts; see https://private.example.test/repo");
      const shown = await api.runReportCommand(root, ["show", saved.capsule_id!, "--json"], {}, {});
      assert.equal(shown.status, "ready");
      const bytes = canonical(shown.result.payload);
      assert.match(bytes, /Request failed/);
      assert.match(bytes, /handler.ts/);
      for (const forbidden of ["fake_report_secret_1234567890123456", "/Users/example/private", "private.example.test"]) assert.ok(!bytes.includes(forbidden), forbidden);
      assert.equal(saved.payload_digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      const disk = readFileSync(path.join(root, ".foo/reports/pending", `${saved.capsule_id}.json`), "utf8");
      for (const forbidden of ["fake_report_secret_1234567890123456", "/Users/example/private", "private.example.test"]) assert.ok(!disk.includes(forbidden));
      assert.equal(shown.result.payload!.failure.stack.state, "not_collected");
    });
    await check("exact-preview-and-approval-before-local-delete", async () => {
      const root = home(); const saved = await add(root); const old = await add(root, "Older unrelated report.");
      const run = (args: string[]) => api.runReportCommand(root, args, {}, {});
      assert.equal((await run(["delete", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"])).result.error?.code, "E_REPORT_PREVIEW_REQUIRED");
      await run(["show", saved.capsule_id!, "--json"]);
      assert.equal((await run(["delete", saved.capsule_id!, "--json"])).result.error?.code, "E_REPORT_APPROVAL_REQUIRED");
      assert.equal((await run(["delete", saved.capsule_id!, "--approve", `sha256:${"f".repeat(64)}`, "--json"])).result.error?.code, "E_REPORT_DIGEST_MISMATCH");
      assert.equal((await run(["delete", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"])).status, "deleted");
      assert.ok(existsSync(path.join(root, ".foo/reports/pending", `${old.capsule_id}.json`)));
    });
    for (const mode of ["interactive", "json", "agent", "noninteractive"] as const) await check(`run-${mode}-never-prompts-or-sends`, async () => {
      const root = home(); const saved = await add(root); let calls = 0; let output = "";
      const run = api.createReportRunContext(); api.noteCapsuleFromThisRun(run, saved.capsule_id!);
      const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
      const stderr = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
      stderr.on("data", chunk => { output += String(chunk); });
      const deps = { mode, stdin, stderr, question: async () => { calls++; return "yes"; }, transport: { destination: DESTINATION, async send() { calls++; throw new Error("retired capability invoked"); } } };
      await api.askToSendReports(root, run, deps);
      await api.askToSendReports(root, run, deps);
      assert.equal(calls, 0);
      assert.equal((output.match(/saved Bug Capsule/g) ?? []).length, 1);
      assert.ok(existsSync(path.join(root, ".foo/reports/pending", `${saved.capsule_id}.json`)));
    });
    await check("removed-send-ignores-injected-capabilities", async () => {
      const root = home(); const saved = await add(root); let calls = 0;
      const deps = { now: () => new Date(), transport: { destination: DESTINATION, async send() { calls++; throw new Error("must stay local"); }, async delete() { calls++; throw new Error("must stay local"); } }, async fetch() { calls++; throw new Error("must stay local"); } };
      await api.runReportCommand(root, ["show", saved.capsule_id!, "--json"], {}, deps);
      const denied = await api.runReportCommand(root, ["send", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"], {}, deps);
      assert.equal(denied.result.error?.code, "E_REPORT_SEND_REMOVED"); assert.equal(calls, 0);
      assert.ok(existsSync(path.join(root, ".foo/reports/pending", `${saved.capsule_id}.json`)));
    });
    await check("removed-send-keeps-local", async () => {
      const root = home(); const saved = await add(root);
      const env = { FOO_STATE_DIR: path.join(root, "isolated-state") };
      await api.runReportCommand(root, ["show", saved.capsule_id!, "--json"], env);
      const sent = await api.runReportCommand(root, ["send", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"], env);
      assert.equal(sent.status, "refused");
      assert.equal(sent.result.error?.code, "E_REPORT_SEND_REMOVED");
      assert.ok(existsSync(path.join(root, ".foo/reports/pending", `${saved.capsule_id}.json`)));
    });
    await check("pending-delete-local", async () => {
      const root = home(); const saved = await add(root);
      await api.runReportCommand(root, ["show", saved.capsule_id!, "--json"]);
      assert.equal((await api.runReportCommand(root, ["delete", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"])).status, "deleted");
      assert.equal((await api.runReportCommand(root, ["delete", saved.capsule_id!, "--approve", saved.payload_digest!, "--json"])).result.error?.code, "E_REPORT_NOT_FOUND");
    });
    return results;
  } finally { for (const root of homes) rmSync(root, { recursive: true, force: true }); }
}


// Run in a disposable, audit-guarded child with a cleanInstallEnv HOME.
export async function localReportingAcceptance(api: ReportingApi, mode: "clean" | "stored" | "ambient" | "combined"): Promise<ReportingCase[]> {
  const fixtureHome = process.env.HOME!;
  assert.ok(fixtureHome, "disposable fixture HOME is required");
  const relativeHome = path.relative(realpathSync(tmpdir()), realpathSync(fixtureHome));
  assert.ok(relativeHome && relativeHome !== ".." && !relativeHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeHome), "fixture HOME must be a disposable directory below the system temp directory");
  if (mode === "stored" || mode === "combined") {
    mkdirSync(path.join(fixtureHome, ".foo"), { recursive: true });
    writeFileSync(path.join(fixtureHome, ".foo", "credentials.json"), JSON.stringify({ skill_token: "synthetic_alpha_report_token" }), { mode: 0o600 });
  }
  if (mode === "ambient" || mode === "combined") {
    process.env.FOO_SKILL_SERVER = "http://127.0.0.1:4020";
    process.env.FOO_SKILL_TOKEN = "synthetic_alpha_report_token";
  }
  const root = mkdtempSync(path.join(fixtureHome, "report-project-"));
  try {
    // Current schema writer with an alpha version label; this proves settings
    // isolation, not historical capsule-format migration.
    const added = await api.runReportCommand(root, ["add", "--expected", "Expected alpha behavior", "--actual", "Synthetic alpha failure", "--json"], process.env, { version: "0.1.25" });
    assert.equal(added.status, "ready");
    const id = added.result.capsule_id!; const digest = added.result.payload_digest!;
    const pending = path.join(root, ".foo/reports/pending", `${id}.json`);
    const priorBytes = readFileSync(pending, "utf8");
    const shown = await api.runReportCommand(root, ["show", id, "--json"]);
    assert.deepEqual(shown.result.next_actions, [], "local preview must not suggest destructive approval");
    const sent = await api.runReportCommand(root, ["send", id, "--approve", digest, "--json"]);
    assert.equal(sent.status, "refused", sent.output);
    assert.equal(sent.result.error?.code, "E_REPORT_SEND_REMOVED");
    assert.match(sent.output, /local|this machine/);
    assert.equal(readFileSync(pending, "utf8"), priorBytes, "upgraded capsule remains byte-identical locally");
    const run = api.createReportRunContext(); api.noteCapsuleFromThisRun(run, id);
    let prompts = 0; let output = "";
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
    const stderr = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    stderr.on("data", chunk => { output += String(chunk); });
    await api.askToSendReports(root, run, { mode: "interactive", stdin, stderr, question: async () => { prompts++; return "yes"; } });
    assert.equal(prompts, 0); assert.match(output, /locally; nothing was sent/);
    assert.equal((await api.runReportCommand(root, ["delete", id, "--approve", digest, "--json"])).status, "deleted");
    assert.ok(!existsSync(pending));
    const acceptedDraft = await api.runReportCommand(root, ["add", "--expected", "Expected behavior", "--actual", "Synthetic previously sent report", "--json"]);
    const acceptedId = acceptedDraft.result.capsule_id!; const acceptedDigest = acceptedDraft.result.payload_digest!;
    // Real legacy archive shape, seeded on disk rather than invoking removed transport.
    const pendingArchive = path.join(root, ".foo/reports/pending", `${acceptedId}.json`);
    const record = JSON.parse(readFileSync(pendingArchive, "utf8"));
    record.state = "accepted";
    record.receipt = receipt(record.capsule, acceptedDigest);
    const archive = path.join(root, ".foo/reports/archive", `${acceptedId}.json`);
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, JSON.stringify(record));
    rmSync(pendingArchive);
    const preview = await api.runReportCommand(root, ["show", acceptedId, "--json"]);
    assert.equal(preview.status, "ready"); assert.ok(preview.result.payload);
    const deletion = await api.runReportCommand(root, ["delete", acceptedId, "--approve", acceptedDigest]);
    assert.equal(deletion.status, "deleted", deletion.output);
    assert.match(deletion.output, /locally.*No remote deletion/);
    assert.ok(!existsSync(archive));
    return [{ id: `${mode}-default-send-keeps-local`, status: "pass" }, { id: `${mode}-no-send-prompt`, status: "pass" }, { id: `${mode}-local-delete`, status: "pass" }, { id: `${mode}-legacy-archive-local-delete`, status: "pass" }];
  } finally { rmSync(root, { recursive: true, force: true }); }
}
