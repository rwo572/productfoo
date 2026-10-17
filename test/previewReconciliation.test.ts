import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runPreviewCommand } from "../src/commands/specCmd.js";
import { GateBlock } from "../src/errorTaxonomy.js";

type Event = {
  id: string;
  type: string;
  time: string;
  actor: { type: string; id: string };
  data: Record<string, unknown>;
};

function userCorrection(summary: string): Event {
  return {
    id: "evt-user-correction",
    type: "com.adaptivespec.decision.recorded",
    time: "2026-07-20T00:01:00.000Z",
    actor: { type: "human", id: "taylor" },
    data: { source: "user-correction", summary },
  };
}

function unrelatedDecision(actor: "human" | "agent"): Event {
  return {
    id: `evt-${actor}-decision`,
    type: "com.adaptivespec.decision.recorded",
    time: "2026-07-20T00:00:00.000Z",
    actor: { type: actor, id: actor },
    data: { summary: `${actor} decision already represented by the packet` },
  };
}

function packetFixture(options: { spec: string; events: Array<Event | string> }): string {
  const packetDir = mkdtempSync(path.join(tmpdir(), "foo-preview-reconcile-"));
  writeFileSync(path.join(packetDir, "spec.md"), options.spec);
  writeFileSync(
    path.join(packetDir, "tasks.yaml"),
    'schema_version: "0.1"\nspec_id: preview_fixture_v0\ntasks: []\n',
  );
  writeFileSync(
    path.join(packetDir, "events.jsonl"),
    `${options.events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n")}\n`,
  );
  return packetDir;
}

function snapshotPacket(packetDir: string): Record<string, string> {
  return Object.fromEntries(
    ["spec.md", "tasks.yaml", "events.jsonl"].map((file) => [
      file,
      readFileSync(path.join(packetDir, file), "utf8"),
    ]),
  );
}

test("Preview blocks on an explicit user correction missing from the packet", async () => {
  const packetDir = packetFixture({
    spec: "# Preview fixture\n\n## Decisions\n\n- Existing decision\n",
    events: [userCorrection("Follow-along mode must include visual and audio cues")],
  });
  const before = snapshotPacket(packetDir);

  await assert.rejects(
    () => runPreviewCommand(process.cwd(), packetDir),
    (error: unknown) => {
      assert.ok(error instanceof GateBlock);
      assert.equal(error.errorCode, "E_CONTRACT_DRIFT");
      assert.match(error.message, /drift/i);
      assert.match(error.message, /Follow-along mode must include visual and audio cues/);
      assert.match(error.message, /requires human approval, nothing written/);
      assert.doesNotMatch(error.message, /Prompt: Use \$preview-swarm|Artifact target:|Cost:/);
      return true;
    },
  );

  assert.deepEqual(snapshotPacket(packetDir), before);
});

test("Preview proceeds after the exact correction is represented across whitespace", async () => {
  const packetDir = packetFixture({
    spec: "# Preview fixture\n\n## Decisions\n\n- Follow-along mode must include visual\n  and audio cues\n",
    events: [userCorrection("Follow-along mode must include visual and audio cues")],
  });

  const output = await runPreviewCommand(process.cwd(), packetDir);

  assert.match(output, /Prompt: Use \$preview-swarm/);
});

test("Preview ignores human and agent decisions without the explicit correction marker", async () => {
  const packetDir = packetFixture({
    spec: "# Preview fixture\n",
    events: [unrelatedDecision("human"), unrelatedDecision("agent")],
  });

  const output = await runPreviewCommand(process.cwd(), packetDir);

  assert.match(output, /Prompt: Use \$preview-swarm/);
});

test("Preview reconciliation skips malformed event lines without crashing", async () => {
  const packetDir = packetFixture({ spec: "# Preview fixture\n", events: ["{not-json"] });

  const output = await runPreviewCommand(process.cwd(), packetDir);

  assert.match(output, /Prompt: Use \$preview-swarm/);
});
