import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runReportCommand, askToSendReports, createReportRunContext, noteCapsuleFromThisRun } from "../src/errorReport.js";
import { archiveAccepted, getLocalBugRecord } from "../src/bugReportStore.js";

for (const archived of [false, true]) test(`local report ${archived ? "legacy archive" : "draft"} stays readable and deletes only local bytes`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-local-report-"));
  try {
    const added = await runReportCommand(root, ["add", "--expected", "Expected behavior", "--actual", "Wrong behavior", "--json"]);
    const id = added.result.capsule_id!; const digest = added.result.payload_digest!;
    if (archived) archiveAccepted(root, id, {
      schema_version: "0.1", receipt_id: "018f05d4-54fc-72ab-aa2a-2a2a2a2a2a2a", capsule_id: id, payload_digest: digest,
      accepted_at: "2026-07-19T00:00:01.000Z", destination: "foo-owner-relay:bug-capsules/v0", status: "accepted", error: null,
    });
    const shown = await runReportCommand(root, ["show", id, "--json"]);
    assert.equal(shown.status, "ready"); assert.ok(shown.result.payload);
    assert.equal(shown.result.destination, null);
    const textPreview = await runReportCommand(root, ["show", id]);
    if (archived) {
      assert.match(textPreview.output, /Historical delivery/);
      assert.match(textPreview.output, /foo-owner-relay:bug-capsules\/v0/);
      assert.match(textPreview.output, /remote retention is unknown/);
      assert.doesNotMatch(textPreview.output, /Storage: this machine only/);
    } else {
      assert.match(textPreview.output, /Storage: this machine only/);
    }
    const denied = await runReportCommand(root, ["delete", id, "--approve", `sha256:${"f".repeat(64)}`, "--json"]);
    assert.equal(denied.result.error?.code, "E_REPORT_DIGEST_MISMATCH");
    assert.ok(getLocalBugRecord(root, id));
    const deleted = await runReportCommand(root, ["delete", id, "--approve", digest]);
    assert.equal(deleted.status, "deleted", deleted.output);
    assert.match(deleted.output, /locally/);
    assert.equal(getLocalBugRecord(root, id), null);
    if (archived) {
      assert.match(deleted.output, /No remote deletion/);
      const marker = JSON.parse(readFileSync(path.join(root, ".foo/reports/remote-deleted", `${id}.json`), "utf8"));
      assert.equal(marker.kind, "local_archive_deleted", "local cleanup cannot fabricate server confirmation");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy injected report capabilities cannot send or prompt, even after exact approval", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-removed-report-"));
  try {
    const added = await runReportCommand(root, ["add", "--expected", "Expected", "--actual", "Actual", "--json"]);
    const id = added.result.capsule_id!; const digest = added.result.payload_digest!;
    let calls = 0;
    const deps = { transport: { destination: "foo-owner-relay:bug-capsules/v0", async send() { calls++; throw new Error("must not run"); }, async delete() { calls++; throw new Error("must not run"); } }, async fetch() { calls++; throw new Error("must not run"); }, now: () => new Date() };
    await runReportCommand(root, ["show", id, "--json"], {}, deps);
    const result = await runReportCommand(root, ["send", id, "--approve", digest, "--json"], { FOO_SKILL_TOKEN: "synthetic-old-token", FOO_SKILL_SERVER: "http://127.0.0.1:4020" }, deps);
    assert.equal(result.status, "refused"); assert.equal(result.result.error?.code, "E_REPORT_SEND_REMOVED");
    const context = createReportRunContext(); noteCapsuleFromThisRun(context, id);
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    await askToSendReports(root, context, { ...deps, mode: "interactive", stdin: stream as unknown as NodeJS.ReadStream, stderr: stream as unknown as NodeJS.WriteStream, question: async () => { calls++; return "yes"; } });
    assert.equal(calls, 0); assert.ok(getLocalBugRecord(root, id));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
