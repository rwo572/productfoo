import { scanText } from "./redactEngine.js";
import { sanitizeDiscoveryStableUrl } from "./discoverySources.js";

export type DiscoveryLane = "study_linked" | "unassigned_call_evidence";
export type DiscoveryConfidence = "low" | "medium" | "high";
export type DiscoveryRelationship = "supports" | "contradicts" | "new";

export type DiscoveryEvidenceFinding = {
  finding_id: string;
  headline: string;
  paraphrase: string;
  evidence_type: "stated" | "observed" | "inferred";
  locator?: string;
  confidence: DiscoveryConfidence;
  dissent: string;
  hypothesis_id?: string;
  explicit_refs?: string[];
  relationship_hint?: DiscoveryRelationship;
};

// Transcript-derived identity statements (discovery-contact-capture-v0 R-005):
// what the call itself said about who the customer is — "technical
// co-founder", "runs Exampleton Brothers". Name/company/title only; no LinkedIn
// (a URL paraphrased out of transcript text is not a provider-carried
// profile), and never emails or phones — every value passes the same scanner
// gate as paraphrases. Candidates seed the scope's contact card as inferred
// suggestions; they are never confirmed identity.
export type DiscoveryContactCandidate = { name?: string; company?: string; title?: string };

export type DiscoveryEvidenceEnvelope = {
  schema_version: "0.1";
  kind: "discovery_evidence";
  study_id: string;
  lane: DiscoveryLane;
  source: {
    provider: string;
    stable_url?: string;
    source_fingerprint: string;
    completed_at: string;
    locator_capability: "timestamp" | "section" | "none";
  };
  findings: DiscoveryEvidenceFinding[];
  contact_candidates?: DiscoveryContactCandidate[];
  coverage: { transcript_complete: boolean; caveats: string[] };
  privacy_attestation: { pii_redacted: true; direct_quotes: false };
  raw_content_present: false;
};

export type EvidenceContext = { expected_study_id: string; expected_lane: DiscoveryLane };

const TOP_KEYS = new Set(["schema_version", "kind", "study_id", "lane", "source", "findings", "contact_candidates", "coverage", "privacy_attestation", "raw_content_present"]);
const CONTACT_CANDIDATE_KEYS = new Set(["name", "company", "title"]);
const SOURCE_KEYS = new Set(["provider", "stable_url", "source_fingerprint", "completed_at", "locator_capability"]);
const FINDING_KEYS = new Set(["finding_id", "headline", "paraphrase", "evidence_type", "locator", "confidence", "dissent", "hypothesis_id", "explicit_refs", "relationship_hint"]);
const COVERAGE_KEYS = new Set(["transcript_complete", "caveats"]);
const PRIVACY_KEYS = new Set(["pii_redacted", "direct_quotes"]);
const FORBIDDEN_KEY = /(?:^|_)(?:raw(?:_content|_transcript)?|transcript|content|turns?|speaker(?:_utterance)?|utterances?|meeting_id|runtime_handle|session_handle)(?:$|_)/i;

// The versioned source-fingerprint grammar (nango-discovery-connector-v0
// T-005, R-004): exactly two accepted shapes — the local worker's
// sha256-over-session-identity form and the hosted service's
// `hmac-sha256:v1:` form. Both are explicit; anything else is invalid, so the
// grammar is versioned, never loosened.
export const LOCAL_SOURCE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
export const HOSTED_SOURCE_FINGERPRINT = /^hmac-sha256:v1:[a-f0-9]{64}$/;
export function isValidDiscoverySourceFingerprint(value: string): boolean {
  return LOCAL_SOURCE_FINGERPRINT.test(value) || HOSTED_SOURCE_FINGERPRINT.test(value);
}

// Explicit repository references (D-011): a bare local record id is honest
// but ambiguous — reconciliation treats it as review-only and never exact-maps
// it. Exact mapping requires the packet-qualified form `specs/<packet>:<id>`,
// which names the packet directory the record lives in.
export const BARE_DISCOVERY_REF = /^(?:R|D|T|F|P|C|H)-\d{3}$/;
export const PACKET_QUALIFIED_REF = /^specs\/([a-z0-9][a-z0-9._-]*):((?:R|D|T|F|P|C|H)-\d{3})$/;
export function parseDiscoveryQualifiedRef(value: string): { packet_slug: string; record_id: string } | undefined {
  const match = PACKET_QUALIFIED_REF.exec(value);
  return match ? { packet_slug: match[1], record_id: match[2] } : undefined;
}
const INJECTION = /\b(?:ignore|disregard|override)\b.{0,50}\b(?:previous|prior|system|developer)\b.{0,50}\binstructions?\b|\b(?:call|invoke|use)\b.{0,30}\b(?:private source|connector|tool)\b/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertClosed(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    const allowedAttestation = (label === "evidence envelope" && key === "raw_content_present")
      || (label === "coverage" && key === "transcript_complete");
    if (FORBIDDEN_KEY.test(key) && !allowedAttestation) throw new Error(`${label}: forbidden raw/private field ${key}`);
    if (!allowed.has(key)) throw new Error(`${label}: unknown field ${key}`);
  }
}

function walkForbidden(value: unknown, at = "evidence envelope"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkForbidden(entry, `${at}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const allowedAttestation = (at === "evidence envelope" && key === "raw_content_present")
      || (at === "evidence envelope.coverage" && key === "transcript_complete");
    if (FORBIDDEN_KEY.test(key) && !allowedAttestation) throw new Error(`${at}: forbidden raw/private field ${key}`);
    walkForbidden(child, `${at}.${key}`);
  }
}

function assertSafeDerivedText(text: string, label: string): void {
  if (!text.trim()) throw new Error(`${label} must not be empty`);
  const scan = scanText(text);
  if (scan.counts.high > 0 || scan.counts.medium > 0) throw new Error(`${label} contains a secret-shaped value`);
  if (EMAIL.test(text) || PHONE.test(text)) throw new Error(`${label} contains PII`);
  if (INJECTION.test(text)) throw new Error(`${label} contains an untrusted instruction`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${label} must be a string array`);
  return value as string[];
}

function validateEvidenceEnvelope(value: unknown, context: EvidenceContext): DiscoveryEvidenceEnvelope {
  walkForbidden(value);
  const top = record(value, "evidence envelope");
  assertClosed(top, TOP_KEYS, "evidence envelope");
  if (top.schema_version !== "0.1" || top.kind !== "discovery_evidence") throw new Error("invalid discovery evidence schema or kind");
  if (top.study_id !== context.expected_study_id) throw new Error("evidence study_id does not match the target");
  if (top.lane !== context.expected_lane) throw new Error("evidence lane does not match the target");
  if (top.raw_content_present !== false) throw new Error("raw_content_present must be false");

  const source = record(top.source, "source");
  assertClosed(source, SOURCE_KEYS, "source");
  if (typeof source.provider !== "string" || !source.provider.trim()) throw new Error("source.provider is required");
  // One versioned grammar for both paths (T-005): local sha256 and hosted
  // hmac-sha256:v1 fingerprints are the two explicit shapes; everything else
  // is refused. Callers that require one family (the local proof path, the
  // hosted bundle gate) check the family on top — the validator never does.
  if (typeof source.source_fingerprint !== "string" || !isValidDiscoverySourceFingerprint(source.source_fingerprint)) throw new Error("source_fingerprint is invalid");
  if (typeof source.completed_at !== "string" || !Number.isFinite(Date.parse(source.completed_at))) throw new Error("source.completed_at is invalid");
  if (source.locator_capability !== "timestamp" && source.locator_capability !== "section" && source.locator_capability !== "none") throw new Error("locator_capability is invalid");
  if (source.stable_url !== undefined) {
    if (typeof source.stable_url !== "string") throw new Error("stable_url must be a string");
    sanitizeDiscoveryStableUrl(source.provider, source.stable_url);
  }

  if (!Array.isArray(top.findings) || top.findings.length === 0) throw new Error("findings must contain at least one finding");
  for (const [index, candidate] of top.findings.entries()) {
    const finding = record(candidate, `finding ${index + 1}`);
    assertClosed(finding, FINDING_KEYS, `finding ${index + 1}`);
    if (typeof finding.finding_id !== "string" || !/^F-\d{3}$/.test(finding.finding_id)) throw new Error(`finding ${index + 1}: invalid finding_id`);
    if (typeof finding.headline !== "string") throw new Error(`finding ${index + 1}: headline is required`);
    assertSafeDerivedText(finding.headline, `finding ${index + 1} headline`);
    if (finding.headline.trim().split(/\s+/).length > 10) throw new Error(`finding ${index + 1}: headline must be 10 words or fewer`);
    if (typeof finding.paraphrase !== "string") throw new Error(`finding ${index + 1}: paraphrase is required`);
    assertSafeDerivedText(finding.paraphrase, `finding ${index + 1} paraphrase`);
    if (finding.evidence_type !== "stated" && finding.evidence_type !== "observed" && finding.evidence_type !== "inferred") throw new Error(`finding ${index + 1}: invalid evidence_type`);
    if (finding.confidence !== "low" && finding.confidence !== "medium" && finding.confidence !== "high") throw new Error(`finding ${index + 1}: invalid confidence`);
    if (typeof finding.dissent !== "string") throw new Error(`finding ${index + 1}: dissent is required (use an honest none recorded statement)`);
    assertSafeDerivedText(finding.dissent, `finding ${index + 1} dissent`);
    if (context.expected_lane === "unassigned_call_evidence" && finding.hypothesis_id !== undefined) throw new Error("unassigned evidence cannot receive a retrospective hypothesis");
    if (context.expected_lane === "study_linked" && typeof finding.hypothesis_id !== "string") throw new Error("study-linked evidence requires a pre-existing hypothesis_id");
    if (source.locator_capability !== "none" && typeof finding.locator !== "string") throw new Error(`finding ${index + 1}: locator is required for the declared capability`);
    if (finding.locator !== undefined && typeof finding.locator !== "string") throw new Error(`finding ${index + 1}: locator must be a string`);
    if (finding.explicit_refs !== undefined) {
      for (const ref of stringArray(finding.explicit_refs, `finding ${index + 1} explicit_refs`)) {
        if (BARE_DISCOVERY_REF.test(ref)) continue; // review-only: reconciliation never exact-maps a bare id (D-011)
        if (parseDiscoveryQualifiedRef(ref)) continue;
        if (ref.startsWith("https://")) continue;
        throw new Error(`finding ${index + 1}: invalid explicit reference ${ref} (use specs/<packet>:<record-id> to make it exact-mappable, or omit it for semantic review)`);
      }
    }
    if (finding.relationship_hint !== undefined && finding.relationship_hint !== "supports" && finding.relationship_hint !== "contradicts" && finding.relationship_hint !== "new") throw new Error(`finding ${index + 1}: invalid relationship_hint`);
  }

  if (top.contact_candidates !== undefined) {
    if (!Array.isArray(top.contact_candidates) || top.contact_candidates.length === 0) throw new Error("contact_candidates, when present, must contain at least one candidate");
    for (const [index, entry] of top.contact_candidates.entries()) {
      const candidate = record(entry, `contact candidate ${index + 1}`);
      assertClosed(candidate, CONTACT_CANDIDATE_KEYS, `contact candidate ${index + 1}`);
      const keys = Object.keys(candidate);
      if (keys.length === 0) throw new Error(`contact candidate ${index + 1}: at least one of name, company, title is required`);
      for (const key of keys) {
        if (typeof candidate[key] !== "string") throw new Error(`contact candidate ${index + 1}: ${key} must be a string`);
        assertSafeDerivedText(candidate[key] as string, `contact candidate ${index + 1} ${key}`);
      }
    }
  }

  const coverage = record(top.coverage, "coverage");
  assertClosed(coverage, COVERAGE_KEYS, "coverage");
  if (typeof coverage.transcript_complete !== "boolean") throw new Error("coverage.transcript_complete must be boolean");
  const caveats = stringArray(coverage.caveats, "coverage.caveats");
  for (const caveat of caveats) assertSafeDerivedText(caveat, "coverage caveat");
  if ((!source.stable_url || source.locator_capability === "none") && caveats.length === 0) throw new Error("missing source capabilities require an explicit coverage caveat");

  const privacy = record(top.privacy_attestation, "privacy_attestation");
  assertClosed(privacy, PRIVACY_KEYS, "privacy_attestation");
  if (privacy.pii_redacted !== true || privacy.direct_quotes !== false) throw new Error("privacy_attestation must assert pii_redacted true and direct_quotes false");
  return value as DiscoveryEvidenceEnvelope;
}

export function validateDiscoveryEvidence(value: unknown, context: EvidenceContext): DiscoveryEvidenceEnvelope {
  return validateEvidenceEnvelope(value, context);
}

// --- Hosted-path screening (nango-discovery-connector-v0 T-004) ----------------

// The deterministic screen the hosted processing operation runs on a
// synthesized envelope. Since T-005 it is the SAME closed contract as
// validateDiscoveryEvidence — one validator, one versioned fingerprint
// grammar (local sha256 and hosted hmac-sha256:v1, both explicit), closed key
// sets, the forbidden-key walk, PII/secret/injection screens on every derived
// string, locator and caveat honesty, lane hypothesis binding, privacy
// attestation — never a second validator (R-001).
export function screenDiscoveryServiceEnvelope(value: unknown, context: EvidenceContext): DiscoveryEvidenceEnvelope {
  return validateEvidenceEnvelope(value, context);
}
