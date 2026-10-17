import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DiscoveryEvidenceEnvelope } from "../src/discoveryEvidence.js";

// Synthetic discovery tree written from constants, never copied from a real
// discovery directory. Identities, organizations and observations are invented;
// the empty inbox lets each test state exactly the scopes it exercises.
const STUDY_DIR_NAME = "2026-07-20-granola-shape-up";

const STUDY_RUN_YAML = [
  'schema_version: "0.1"',
  "study_id: study_granola_shape_up_20260720",
  "goal: exercise matching and evidence validation with a synthetic team workflow",
  "lane: study_linked",
  "target:",
  "  name: Casey Sample",
  "  organization: Example Research",
  "  public_url: https://www.linkedin.com/in/productfoo-fixture-casey-sample/",
  "  provenance: approved-context",
  "match:",
  "  provider: granola",
  "  connection_alias: primary",
  "  expected_local_date: null",
  "  timezone: America/Los_Angeles",
  "  required_participants: []",
  "  required_title_tokens: []",
  "source:",
  "  provider: granola",
  "  connection_alias: primary",
  "  stable_url: null",
  "state: awaiting_interview",
  "source_state: excluded",
  "access_state: unknown",
  "proof_state: missing",
  "created_at: 2026-07-20T02:57:47.315Z",
  "updated_at: 2026-07-20T05:00:00.000Z",
  "provenance: approved-context",
  "",
].join("\n");

const EMPTY_FINDINGS = 'schema_version: "0.1"\nfindings: []\n';
const EMPTY_PROPOSALS = 'schema_version: "0.1"\nproposals: []\n';
const EMPTY_SCOPES = 'schema_version: "0.1"\nscopes: []\n';

// Seeds root/discovery with one awaiting_interview study and an empty inbox.
// Returns the study directory. Tests mutate state via run.yaml's
// "state: awaiting_interview" line, exactly as they did against the copy.
export function seedDiscoveryFixture(root: string): string {
  const studyDir = path.join(root, "discovery", STUDY_DIR_NAME);
  mkdirSync(studyDir, { recursive: true });
  writeFileSync(path.join(studyDir, "run.yaml"), STUDY_RUN_YAML);
  writeFileSync(path.join(studyDir, "study.md"), "# Granola Shape Up study\n\nHermetic test fixture study document.\n");
  writeFileSync(path.join(studyDir, "report.md"), "# Discovery report\n\nNo evidence ingested yet.\n");
  writeFileSync(path.join(studyDir, "findings.yaml"), EMPTY_FINDINGS);
  writeFileSync(path.join(studyDir, "proposals.yaml"), EMPTY_PROPOSALS);
  writeFileSync(path.join(studyDir, "events.jsonl"), "");
  const inboxDir = path.join(root, "discovery", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(path.join(inboxDir, "scope.yaml"), EMPTY_SCOPES);
  writeFileSync(path.join(inboxDir, "findings.yaml"), EMPTY_FINDINGS);
  writeFileSync(path.join(inboxDir, "proposals.yaml"), EMPTY_PROPOSALS);
  writeFileSync(path.join(inboxDir, "events.jsonl"), "");
  return studyDir;
}

export function validEnvelope(): DiscoveryEvidenceEnvelope {
  return {
    schema_version: "0.1",
    kind: "discovery_evidence",
    study_id: "study_granola_shape_up_20260720",
    lane: "study_linked",
    source: {
      provider: "granola",
      stable_url: "https://app.granola.ai/meeting/abc",
      source_fingerprint: `sha256:${"a".repeat(64)}`,
      completed_at: "2026-07-20T16:00:00.000Z",
      locator_capability: "timestamp",
    },
    findings: [{
      finding_id: "F-001",
      headline: "Wants evidence reviewed before the pitch changes",
      paraphrase: "The team keeps shaping lightweight and reviews evidence before changing a pitch.",
      evidence_type: "stated",
      locator: "00:14:32",
      confidence: "medium",
      dissent: "One participant preferred more structure for cross-team work.",
      hypothesis_id: "H-001",
      // D-011: exact mapping requires the packet-qualified reference; a bare
      // id would be review-only.
      explicit_refs: ["specs/nango-discovery-connector-v0:R-001"],
      relationship_hint: "supports",
    }],
    coverage: { transcript_complete: true, caveats: [] },
    privacy_attestation: { pii_redacted: true, direct_quotes: false },
    raw_content_present: false,
  };
}
