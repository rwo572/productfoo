// Top-level packet-free `foo reconcile` (reconcile-anywhere-v0 T-003/T-004).
//
// The adoption wedge: a stranger in a repo that has never heard of packets runs
// `foo reconcile --source github:<pr-url>` and gets value in one command — no
// specs/ dir, no init, no config. It recovers the PR's intent, diffs what the
// change actually does against that recovered intent, and reports drift, silent
// scope, and unproven claims.
//
// Two hard rules from the packet Decisions:
//   D-001 — this is a NEW top-level command, but it shares ONE engine with
//     `asp reconcile` (githubReconcile.reconcilePrProof / packetReconcile
//     .classifyChangedFiles), so the two entry points can never drift.
//   D-002 — zero side effects by default. Read-only. `--adopt` is the ONLY write
//     path (T-004), and it goes through the spec-after machinery in specCmd.
//
// Report ORDER is load-bearing (R-003, the anti-"PR linter" defense): it LEADS
// with recovered intent, not lint findings. Intent is the reference point.

import { readJson } from "../jsonFile.js";
import path from "node:path";
import type { BehaviorStory, ExtractionCoverage } from "../codeCatalog.js";
import { extractBehaviorStories } from "../codeCatalog.js";
import { parseGithubSource, type GithubFixture } from "../sourceIngress.js";
import { evidenceFromFixture } from "../githubReconcile.js";
import {
  type DriftItem,
  recoverPrIntent,
  type RecoveredIntent,
  suggestDrift,
} from "../specAfter.js";
import { adoptReconcileIntent } from "./specCmd.js";
import { STATUS_GLYPHS, withGlyph } from "../statusGlyphs.js";
import { flagValue } from "./shared.js";
import { classifyThrown, markFailure } from "../errorTaxonomy.js";

// A malformed reconcile invocation returns exit 1 with a usage line rather than
// throwing, so it must mark itself usage_error — otherwise a codeless nonzero
// exit files as a command_error crash and pages for a typo.
function reconcileUsageFail(output: string): { output: string; exitCode: number } {
  markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: output.trim() });
  return { output, exitCode: 1 };
}

// The offline PR evidence a runtime (or a fixture) hands in. Extends the
// substrate's GithubFixture with the free-text and file-list fields the
// packet-free report reads. A full unified `diff` is preferred when available
// (richer behavior stories); otherwise a `files` list is enough.
export type ReconcileFixture = GithubFixture & {
  diff?: string;
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
  linked_issue?: { key?: string; title?: string; body?: string };
};

export type CheckSummary = "pass" | "fail" | "absent" | "mixed";

export interface ProofSummary {
  merged: boolean | null;
  checks: CheckSummary;
  declared_packet: string | null;
  // Every recovered intent item is a claim until a typed fact proves it.
  claimed: string[];
  // Only typed GitHub facts (merge state, check conclusions) can prove anything.
  proven: string[];
  contradicted: string[];
}

export interface ReconcileReport {
  schema_version: "0.1";
  source: string;
  packet_free: true;
  recovered_intent: RecoveredIntent;
  behavior: BehaviorStory[];
  coverage: ExtractionCoverage;
  drift: DriftItem[];
  proof: ProofSummary;
}

// Collect changed file paths from whichever field the fixture carries.
function changedFilePaths(fixture: ReconcileFixture): Array<{ path: string; additions?: number; deletions?: number }> {
  if (fixture.files && fixture.files.length) return fixture.files;
  const paths = new Set<string>();
  for (const f of fixture.files_changed ?? []) paths.add(f);
  for (const c of fixture.commits ?? []) for (const f of c.files ?? []) paths.add(f);
  return [...paths].map((p) => ({ path: p }));
}

function storyFromFile(file: { path: string; additions?: number; deletions?: number }, seq: number): BehaviorStory {
  const added = file.additions ?? 0;
  const removed = file.deletions ?? 0;
  const delta = added || removed ? ` (+${added}/-${removed})` : "";
  return {
    id: `bs-${String(seq + 1).padStart(3, "0")}`,
    file: file.path,
    change_kind: "modified",
    title: `changes ${file.path}`,
    expected_behavior: `Changes \`${file.path}\`${delta}.`,
    evidence: [],
    added_symbols: [],
    removed_symbols: [],
    added_lines: added,
    removed_lines: removed,
    // File-list-derived from the PR's own changed files — repo truth, not a
    // guess about symbols.
    provenance: "repo-truth",
    self_reported: true,
  };
}

// What the change does. A full diff yields symbol-level behavior stories; a plain
// file list yields one story per changed file.
function behaviorFromFixture(fixture: ReconcileFixture): { stories: BehaviorStory[]; coverage: ExtractionCoverage } {
  if (fixture.diff && fixture.diff.trim()) {
    const { stories, coverage } = extractBehaviorStories(fixture.diff);
    return { stories, coverage };
  }
  const files = changedFilePaths(fixture);
  const stories = files.map((f, i) => storyFromFile(f, i));
  return {
    stories,
    coverage: {
      scanned_files: files.length,
      story_files: stories.length,
      stories: stories.length,
      basis: "PR changed-file list (no unified diff supplied); one behavior story per changed file. Code-derived, self-reported.",
      skipped: [],
    },
  };
}

function summarizeChecks(fixture: ReconcileFixture): CheckSummary {
  const checks = fixture.checks ?? [];
  if (checks.length === 0) return "absent";
  if (checks.some((c) => c.conclusion === "failure")) return "fail";
  if (checks.every((c) => c.conclusion === "success")) return "pass";
  return "mixed";
}

export function buildReconcileReport(source: string, fixture: ReconcileFixture): ReconcileReport {
  const recovered = recoverPrIntent({ title: fixture.title, body: fixture.body, linked_issue: fixture.linked_issue });
  const { stories, coverage } = behaviorFromFixture(fixture);
  const drift = suggestDrift(
    recovered.items.map((item, index) => ({ id: item.id, text: item.text, source: "prompt", raw_index: index })),
    stories,
  );

  const evidence = evidenceFromFixture(fixture);
  const checks = summarizeChecks(fixture);
  const proven: string[] = [];
  const contradicted: string[] = [];
  if (evidence.merged === true) proven.push("PR is merged (typed fact)");
  if (evidence.merged === false) contradicted.push(`PR is not merged (state: ${evidence.state ?? "open"})`);
  if (checks === "pass") proven.push(`required checks green (${(fixture.checks ?? []).length}/${(fixture.checks ?? []).length})`);
  if (checks === "fail") contradicted.push("a required check reports failure");

  return {
    schema_version: "0.1",
    source,
    packet_free: true,
    recovered_intent: recovered,
    behavior: stories,
    coverage,
    drift,
    proof: {
      merged: evidence.merged ?? null,
      checks,
      declared_packet: recovered.declares_packet,
      // Recovered intent is a claim, never proven by a title/body — only typed
      // facts corroborate (🟡 claimed vs ✅ proven).
      claimed: recovered.items.map((i) => i.text),
      proven,
      contradicted,
    },
  };
}

const JUDGMENT_GLOSS: Record<RecoveredIntent["items"][number]["judgment"], string> = {
  "repo-evidence": "repo evidence",
  "approved-context": "approved context",
  "role-expertise": "role expertise",
  "agent-inference": "agent inference",
  "user-judgment": "user judgment",
};

const SOURCE_GLOSS: Record<RecoveredIntent["items"][number]["source"], string> = {
  "pr-title": "PR title",
  "pr-body": "PR body",
  "linked-issue": "linked issue",
};

export function renderReconcileReport(report: ReconcileReport, glyphsOn: boolean): string {
  const lines: string[] = [];
  lines.push(`foo reconcile — packet-free drift-against-intent for ${report.source}`);
  lines.push("");

  // (1) Recovered intent — LEADS the report (R-003). Intent is the reference
  //     point, not findings volume.
  lines.push(withGlyph("classification", "Recovered intent (provisional — recovered from the PR, not agreed):", glyphsOn));
  if (report.recovered_intent.recovered) {
    for (const item of report.recovered_intent.items) {
      lines.push(`  ${item.id} [${JUDGMENT_GLOSS[item.judgment]} · ${SOURCE_GLOSS[item.source]}] ${item.text}`);
    }
  } else {
    lines.push(withGlyph("needs_input", `  ${report.recovered_intent.reason}`, glyphsOn));
  }
  if (report.recovered_intent.declares_packet) {
    lines.push(`  (the PR declares Foo-Spec: ${report.recovered_intent.declares_packet})`);
  }
  if (report.recovered_intent.screening.triggered) {
    lines.push(`  ${report.recovered_intent.screening.stripped.length} injected directive(s) in the PR text were neutralized as inert data.`);
  }
  if (report.recovered_intent.redaction.quarantined) {
    lines.push("  a secret-shaped token in the PR text was quarantined — a human must clear it before --adopt.");
  }
  lines.push("");

  // (2) What the diff actually does.
  lines.push("What the change does:");
  if (report.behavior.length) {
    for (const story of report.behavior) lines.push(`  ${story.id}: ${story.expected_behavior}`);
  } else {
    lines.push("  (no changed files in the supplied evidence)");
  }
  lines.push("");

  // (3) Drift / silent scope.
  lines.push("Drift & silent scope:");
  const intentOnly = report.drift.filter((d) => d.category === "INTENT_ONLY");
  const codeOnly = report.drift.filter((d) => d.category === "CODE_ONLY");
  if (!intentOnly.length && !codeOnly.length) {
    lines.push("  (recovered intent and the change line up — nothing unmatched)");
  }
  for (const d of intentOnly) lines.push(withGlyph("drift", `  [asked, not built] ${d.label}`, glyphsOn));
  for (const d of codeOnly) lines.push(withGlyph("drift", `  [silent scope — built, not stated] ${d.label}`, glyphsOn));
  lines.push("  note: deterministic keyword-overlap suggestions over recovered (not agreed) intent — you reconcile.");
  lines.push("");

  // (4) Unproven claims — the internal `claimed` state gets an actionable
  // human label while the report/JSON contract remains unchanged.
  lines.push(`Proof — ${STATUS_GLYPHS.claimed.label} vs proven:`);
  lines.push(withGlyph("claimed", `  ${STATUS_GLYPHS.claimed.label}: ${report.proof.claimed.length} recovered intent item(s) — the PR asserts them; typed facts have not proven them.`, glyphsOn));
  for (const p of report.proof.proven) lines.push(withGlyph("proven", `  proven: ${p}`, glyphsOn));
  for (const c of report.proof.contradicted) lines.push(withGlyph("drift", `  contradicted: ${c}`, glyphsOn));
  if (report.proof.checks === "absent") lines.push("  no required checks present — merge/verify state cannot be proven from typed facts.");
  lines.push("");
  lines.push("Next: `foo reconcile --source github:<pr-url> --adopt --packet <name>` writes the recovered intent as a spec-after packet you can keep honest with `foo asp reconcile`.");
  return lines.join("\n");
}

function reconcileUsageHandoff(): string {
  return [
    "usage: foo reconcile --source github:<pr-url> [--source-fixture <file.json>] [--json] [--adopt --packet <name> [--by <who>]]",
    "  Packet-free: recovers a PR's intent, diffs the change against it, reports drift and unproven claims.",
    "  Read-only by default; --adopt is the only write path.",
  ].join("\n");
}

export function runReconcileCommand(root: string, args: string[], glyphsOn: boolean): { output: string; exitCode: number } {
  const json = args.includes("--json");
  const source = flagValue(args, "--source");
  if (!source) return reconcileUsageFail(`${reconcileUsageHandoff()}\n`);
  if (!source.startsWith("github:")) {
    return reconcileUsageFail(`--source '${source}' is not supported; V0 admits only github:<pr-url>\n`);
  }

  let selection: ReturnType<typeof parseGithubSource>;
  try {
    selection = parseGithubSource(source);
  } catch (error) {
    return { exitCode: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  if (selection.unit !== "pr") {
    return {
      exitCode: 1,
      output: `point foo reconcile at a specific pull request (…/pull/<n>); a whole-repo URL is out of scope for the packet-free wedge: ${selection.url}\n`,
    };
  }

  const fixturePath = flagValue(args, "--source-fixture");
  if (!fixturePath) {
    return {
      exitCode: 1,
      output:
        `no GitHub evidence for ${selection.url}. productfoo's CLI has no live GitHub MCP — supply the PR payload with --source-fixture <file.json>, then re-run:\n` +
        `  foo reconcile --source ${source} --source-fixture <file.json>\n`,
    };
  }
  let fixture: ReconcileFixture;
  try {
    fixture = readJson<ReconcileFixture>(path.resolve(root, fixturePath));
  } catch {
    return { exitCode: 1, output: `--source-fixture is not readable JSON: ${fixturePath}\n` };
  }

  const report = buildReconcileReport(source, fixture);

  // --adopt (T-004): the ONLY write path (D-002). Graduates the one-shot run into
  // a spec-after packet via the spec-after machinery (specCmd). Refuses when
  // there is no recoverable intent — never writes a hallucinated contract.
  if (args.includes("--adopt")) {
    if (!report.recovered_intent.recovered) {
      return { exitCode: 1, output: `nothing to adopt: ${report.recovered_intent.reason}\n` };
    }
    const packetName = flagValue(args, "--packet");
    if (!packetName) return reconcileUsageFail("foo reconcile --adopt needs --packet <name>\n");
    const by = flagValue(args, "--by") ?? "reconcile-adopt";
    try {
      const result = adoptReconcileIntent(root, {
        target: selection.url,
        recovered: report.recovered_intent,
        behavior: report.behavior,
        coverage: report.coverage,
        packetName,
        by,
      });
      if (json) return { exitCode: result.canonized ? 0 : 1, output: `${JSON.stringify({ schema_version: "0.1", report, adopt: result }, null, 2)}\n` };
      if (!result.canonized) return { exitCode: 1, output: `Not adopted: ${result.reason}\n` };
      const rel = packetName.includes("/") ? packetName : `specs/${packetName}`;
      return {
        exitCode: 0,
        output:
          `${renderReconcileReport(report, glyphsOn)}\n\n` +
          `Adopted recovered intent into ${rel} (spec-after draft — provisional, agent-inference).\n` +
          `Validate it: foo asp validate ${rel}\n`,
      };
    } catch (error) {
      markFailure(classifyThrown(error));
      return { exitCode: 1, output: `${error instanceof Error ? error.message : String(error)}\n` };
    }
  }

  if (json) return { exitCode: 0, output: `${JSON.stringify(report, null, 2)}\n` };
  return { exitCode: 0, output: `${renderReconcileReport(report, glyphsOn)}\n` };
}
