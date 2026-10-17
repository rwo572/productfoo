import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseAnchors, parseDecisionRequests, parseOpenQuestions, parseRequirementHeadings, requirementIds } from "../src/specSections.js";
import { initPacket, updateTask } from "../src/packetWrite.js";
import { derivePacketStatus } from "../src/packetStatus.js";
import { linkCorrection } from "../src/packetCorrections.js";

// These fixtures pin the formats real packets use — colon and em-dash
// requirement headings, and Open Questions as plain bullets — so the parsers
// can never again quietly agree with a format the corpus doesn't write.

test("requirement headings: colon, em-dash, and bare forms all parse", () => {
  const spec = [
    "### R-001: Colon form title",
    "### R-002 — Em-dash form title",
    "### R-003 Bare form title",
    "### R4 — No-dash id",
    "### Not a requirement",
  ].join("\n");
  assert.deepEqual(parseRequirementHeadings(spec), [
    { id: "R-001", title: "Colon form title" },
    { id: "R-002", title: "Em-dash form title" },
    { id: "R-003", title: "Bare form title" },
    { id: "R4", title: "No-dash id" },
  ]);
  assert.deepEqual(requirementIds(spec), ["R-001", "R-002", "R-003", "R4"]);
});

test("open questions: plain bullets in the section parse; bullets elsewhere do not", () => {
  const spec = [
    "## Intent",
    "- This bullet is not an open question.",
    "",
    "## Open Questions",
    "- Should the widget MCP be the canonical render surface?",
    "- What is the minimum supported Node version?",
    "",
    "## Decisions",
    "- Neither is this one.",
  ].join("\n");
  const qs = parseOpenQuestions(spec);
  assert.deepEqual(qs, [
    { id: null, text: "Should the widget MCP be the canonical render surface?", title: "Should the widget MCP be the canonical render surface?" },
    { id: null, text: "What is the minimum supported Node version?", title: "What is the minimum supported Node version?" },
  ]);
});

test("open questions: bold-id, inline-title, and strikethrough forms keep their ids", () => {
  const spec = [
    "## Open Questions",
    "- **OQ-1** — Drift detection runs bare against the index.",
    "- **OQ-2 — DST.** Render cron is UTC-only, pin to PDT?",
    "- ~~OQ-3~~ Resolved: the end-to-end command is settled.",
  ].join("\n");
  const qs = parseOpenQuestions(spec);
  assert.deepEqual(qs.map((q) => q.id), ["OQ-1", "OQ-2", "OQ-3"]);
  assert.equal(qs[0].title, "Drift detection runs bare against the index.");
  assert.equal(qs[1].title, "DST. Render cron is UTC-only, pin to PDT?");
  assert.equal(qs[2].title, "Resolved: the end-to-end command is settled.");
});

const canonicalDecision = `## Open Questions
- OQ-007 — Should we keep the current behavior?
  - State: needs-decision
  - Why now: T-002 cannot continue until this choice is made.
  - Unblocks: T-002
  - Option keep: Keep the current behavior
    - Outcome: The agent continues with the existing path.
  - Option pause: Pause this work
    - Outcome: The agent records the pause and does not build it.
  - Recommendation: keep — It is the smallest reversible path.
  - Evidence: The current implementation already supports it.
  - Confidence: high
  - Dissent: Pausing avoids near-term maintenance.
  - Answer effect: The selected option becomes the instruction for T-002.
`;

test("decision requests: canonical blocks compose into the shared question model", () => {
  const parsed = parseDecisionRequests(canonicalDecision, { taskIds: ["T-002"] });
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.requests.length, 1);
  const request = parsed.requests[0];
  assert.equal(request.id, "OQ-007");
  assert.equal(request.why_now, "T-002 cannot continue until this choice is made.");
  assert.deepEqual(request.unblocks, { kind: "task", id: "T-002" });
  assert.equal(request.question.prompt, "Should we keep the current behavior?");
  assert.equal(request.question.recommendedOptionId, "keep");
  assert.deepEqual(request.question.options.map((option) => [option.id, option.label, option.description]), [
    ["keep", "Keep the current behavior", "The agent continues with the existing path."],
    ["pause", "Pause this work", "The agent records the pause and does not build it."],
  ]);
  assert.equal(request.question.judgment.confidence, "high");
});

test("decision requests: legacy questions stay deferred and malformed opt-ins produce precise findings", () => {
  const legacy = parseDecisionRequests("## Open Questions\n- OQ-001 — Maybe revisit this later.\n", { taskIds: ["T-001"] });
  assert.deepEqual(legacy, { requests: [], findings: [] });

  const malformed = parseDecisionRequests(
    `## Open Questions
- OQ-002 — Pick one?
  - State: needs-decision
  - Why now: Work is blocked.
  - Unblocks: T-999
  - Option ship: Ship it
    - Outcome: It ships.
  - Option tune: Tune it
    - Outcome: It takes longer.
  - Recommendation: ship — Fastest.
  - Evidence: A fixture.
  - Confidence: certain
  - Answer effect: The task follows the answer.
`,
    { taskIds: ["T-001"] },
  );
  assert.deepEqual(malformed.requests, []);
  assert.ok(malformed.findings.some((finding) => finding.code === "decision.unknown_unblocks"));
  assert.ok(malformed.findings.some((finding) => finding.code === "decision.invalid_confidence"));
  assert.ok(malformed.findings.some((finding) => finding.code === "decision.missing_opt_out"));
});

test("decision requests: fenced canonical examples stay documentation; the same block unfenced stays live (#775)", () => {
  const example = [
    "- OQ-001 — Which option should we take?",
    "  - State: needs-decision",
    "  - Why now: Work cannot continue until this choice is made.",
    "  - Unblocks: T-002",
    "  - Option continue: Continue with the smallest reversible path",
    "    - Outcome: The agent continues T-002 with that path.",
    "  - Option pause: Pause this work",
    "    - Outcome: The agent records the pause and does not build it.",
    "  - Recommendation: continue — This is the smallest reversible path.",
    "  - Evidence: Name the repo fact that supports the recommendation.",
    "  - Confidence: medium",
    "  - Answer effect: The selected option becomes the instruction for the active task.",
  ];

  // A fenced scaffold (the packet's own copyable example) is documentation:
  // no live request and no decision findings for validate/index to surface.
  const fenced = parseDecisionRequests(
    ["## Open Questions", "", "```md", ...example, "```", ""].join("\n"),
    { taskIds: ["T-002"] },
  );
  assert.deepEqual(fenced, { requests: [], findings: [] });

  // Control: the identical block, unfenced, is a real request.
  const unfenced = parseDecisionRequests(
    ["## Open Questions", "", ...example, ""].join("\n"),
    { taskIds: ["T-002"] },
  );
  assert.deepEqual(unfenced.findings, []);
  assert.equal(unfenced.requests.length, 1);
  assert.equal(unfenced.requests[0].id, "OQ-001");
  assert.deepEqual(unfenced.requests[0].unblocks, { kind: "task", id: "T-002" });

  // The fence actually ends: a live canonical block after it still mints.
  const mixed = parseDecisionRequests(
    ["## Open Questions", "", "```md", ...example, "```", "", ...example.map((line) => line.replace("OQ-001", "OQ-002")), ""].join("\n"),
    { taskIds: ["T-002"] },
  );
  assert.deepEqual(mixed.findings, []);
  assert.deepEqual(mixed.requests.map((request) => request.id), ["OQ-002"]);

  // Sibling parsers are unchanged: they already ignored fences, and still do.
  const fencedSpec = ["## Open Questions", "", "```md", ...example, "```", "", "- A plain deferred note.", ""].join("\n");
  assert.deepEqual(parseOpenQuestions(fencedSpec), [
    { id: null, text: "A plain deferred note.", title: "A plain deferred note." },
  ]);
  assert.deepEqual(parseAnchors(fencedSpec), []);
});

// #3: the decision block collector must observe fences even after it starts
// consuming a preceding bullet. Invalid examples must not emit findings either.
const decisionBody = canonicalDecision.split("\n").slice(1).join("\n");
for (const fence of ["```", "~~~", "````", "~~~~"]) {
  for (const prefix of ["", "- A plain earlier note.\n\n"]) {
    test(`decision examples stay inert in ${fence} fences after ${prefix ? "a bullet" : "the heading"} (#3)`, () => {
      for (const example of [decisionBody, decisionBody.replace("Confidence: high", "Confidence: invalid")]) {
        const spec = `## Open Questions\n${prefix}${fence}md\n${example}${fence}\n`;
        assert.deepEqual(parseDecisionRequests(spec, { taskIds: ["T-002"] }), { requests: [], findings: [] });
        assert.deepEqual(parseAnchors(spec), []);
        assert.deepEqual(parseOpenQuestions(spec).map(q => q.text), prefix ? ["A plain earlier note."] : []);

        const live = parseDecisionRequests(`${spec}\n${decisionBody}`, { taskIds: ["T-002"] });
        assert.deepEqual(live.findings, []);
        assert.deepEqual(live.requests.map(request => request.id), ["OQ-007"]);
      }
    });
  }
}

for (const fence of ["````", "~~~~"]) {
  for (const prefix of ["", "- A plain earlier note.\n\n"]) {
    test(`only a matching delimiter closes ${fence} after ${prefix ? "a bullet" : "the heading"} (#3)`, () => {
      const other = fence[0] === "`" ? "~~~~" : "````";
      for (const falseClose of [fence.slice(1), other, `${fence} trailing text`]) {
        const spec = `## Open Questions\n${prefix}${fence}md\n${falseClose}\n${decisionBody}`;
        // An unclosed fence consumes the rest of the document.
        assert.deepEqual(parseDecisionRequests(spec, { taskIds: ["T-002"] }), { requests: [], findings: [] });
        assert.deepEqual(parseAnchors(spec), []);
        assert.deepEqual(parseOpenQuestions(spec).map(q => q.text), prefix ? ["A plain earlier note."] : []);
        // A longer matching delimiter is a valid close; following decisions survive.
        const closed = `${spec}${fence}${fence[0]}  \n${decisionBody}`;
        const live = parseDecisionRequests(closed, { taskIds: ["T-002"] });
        assert.deepEqual(live.findings, []);
        assert.deepEqual(live.requests.map(request => request.id), ["OQ-007"]);
        assert.deepEqual(parseAnchors(closed).map(anchor => anchor.id), ["OQ-007"]);
        assert.deepEqual(parseOpenQuestions(closed).filter(q => q.id).map(q => q.id), ["OQ-007"]);
      }
    });
  }
}

test("fenced fields cannot opt a plain note into a decision (#3)", () => {
  const fields = decisionBody.split("\n").slice(1).join("\n");
  const spec = `## Open Questions\n- OQ-008 — A deferred note.\n  ~~~md\n${fields}  ~~~\n${decisionBody}`;
  const parsed = parseDecisionRequests(spec, { taskIds: ["T-002"] });
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.requests.map(request => request.id), ["OQ-007"]);
});

test("a fence marker in an HTML comment after a note cannot hide the next decision (#3)", () => {
  for (const comment of ["<!--\n```md\n-->", "<!-- one line -->", `<!--\n${decisionBody}-->`]) {
    const spec = `## Open Questions\n- A plain earlier note.\n${comment}\n${decisionBody}`;
    const parsed = parseDecisionRequests(spec, { taskIds: ["T-002"] });
    assert.deepEqual(parsed.findings, []);
    assert.deepEqual(parsed.requests.map(request => request.id), ["OQ-007"]);
  }
});

test("a real decision survives a following fenced example (#3)", () => {
  const spec = `${canonicalDecision}\n~~~md\n${decisionBody.replace("OQ-007", "OQ-008")}~~~\n`;
  const parsed = parseDecisionRequests(spec, { taskIds: ["T-002"] });
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.requests.map(request => request.id), ["OQ-007"]);
});

test("packet status and validation keep fenced decisions inert after a note (#3)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-decision-fences-"));
  try {
    const { packetDir } = initPacket({ root, name: "fenced-decisions" });
    updateTask({ packetDir, taskId: "T-001", status: "blocked", reason: "Waiting for a dependency." });
    const specPath = path.join(packetDir, "spec.md");
    const base = readFileSync(specPath, "utf8").split("## Open Questions")[0];
    const example = decisionBody.replaceAll("T-002", "T-001");
    const cli = fileURLToPath(new URL("../../bin/foo", import.meta.url));
    for (const fence of ["```", "~~~", "````", "~~~~"]) {
      for (const body of [example, example.replace("Confidence: high", "Confidence: invalid")]) {
        const spec = `${base}## Open Questions\n- A plain earlier note.\n\n${fence}md\n${body}${fence}\n`;
        writeFileSync(specPath, spec);
        const status = derivePacketStatus(packetDir);
        assert.equal(status.next_action.kind, "unblock");
        assert.deepEqual(status.decision_findings, []);
        assert.deepEqual(status.open_questions, ["A plain earlier note."]);
        const child = spawnSync(process.execPath, [cli, "asp", "validate", packetDir, "--json"], {
          cwd: root, encoding: "utf8", timeout: 30_000,
          env: { ...process.env, NODE_ENV: "test" },
        });
        assert.equal(child.status, 0, `${child.error ?? ""}${child.stdout}${child.stderr}`);
        const validation = JSON.parse(child.stdout);
        assert.equal(validation.ok, true);
        assert.deepEqual(validation.findings, []);

        writeFileSync(specPath, `${spec}\n${example}`);
        const live = derivePacketStatus(packetDir);
        assert.equal(live.next_action.kind, "decide");
        assert.deepEqual(live.decision_findings, []);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makePacket(spec: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-sections-"));
  writeFileSync(path.join(dir, "spec.md"), spec);
  return dir;
}

test("linkCorrection links a correction to a plain-bullet open question", () => {
  const dir = makePacket(
    [
      "## Intent",
      "Prove the linker.",
      "",
      "## Open Questions",
      "- Should trace spans live in events.jsonl by default?",
      "- What should the permanent CLI package be named?",
    ].join("\n"),
  );
  const link = linkCorrection(dir, "the permanent CLI package should be named @foo/spec");
  assert.ok(link);
  assert.equal(link.kind, "open_question");
  assert.equal(link.id, "OQ-2");
  assert.equal(link.title, "What should the permanent CLI package be named?");
});

test("linkCorrection links a correction to an em-dash requirement heading", () => {
  const dir = makePacket(
    [
      "### R-001 — Single source of truth for glyphs",
      "### R-002 — Human surfaces only",
    ].join("\n"),
  );
  const link = linkCorrection(dir, "glyphs need a single source of truth");
  assert.ok(link);
  assert.deepEqual(link, { kind: "requirement", id: "R-001", title: "Single source of truth for glyphs" });
});

test("linkCorrection still links colon-form requirement headings", () => {
  const dir = makePacket("### R-001: Provide a compact canonical packet\n");
  const link = linkCorrection(dir, "the canonical packet should stay compact");
  assert.ok(link);
  assert.deepEqual(link, { kind: "requirement", id: "R-001", title: "Provide a compact canonical packet" });
});
