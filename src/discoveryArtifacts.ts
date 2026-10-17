import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "./vendorYaml.js";
import { providerLinkForm, sanitizeDiscoveryStableUrl } from "./discoverySources.js";

export const DISCOVERY_SCHEMA_VERSION = "0.1" as const;

export type DiscoveryLifecycle =
  | "draft"
  | "awaiting_interview"
  | "awaiting_match"
  | "ambiguous_match"
  | "needs_source_approval"
  | "needs_provider_access"
  | "needs_provider_connector"
  | "needs_research_proof"
  | "ready_to_synthesize"
  | "needs_review"
  | "complete"
  | "revoked";

export type DiscoveryActor = { type: "human" | "agent"; id: string };
export type DiscoveryWrite = { path: string; action: "created" | "updated" | "removed" };

export type DiscoveryRun = {
  schema_version: "0.1";
  study_id: string;
  goal: string;
  lane: "study_linked";
  target: { name: string; organization: string; public_url?: string; provenance: string };
  match: {
    provider: string;
    connection_alias: string;
    expected_local_date: string | null;
    timezone: string;
    required_participants: string[];
    required_title_tokens: string[];
  };
  source: { provider: string; connection_alias: string; stable_url: string | null };
  state: DiscoveryLifecycle;
  source_state: "excluded" | "approved" | "revoked";
  access_state: "unknown" | "available" | "denied";
  proof_state: "missing" | "ready" | "consumed";
  created_at: string;
  updated_at: string;
  provenance: string;
};

export type DiscoveryValidation = { ok: boolean; errors: string[]; studies: number; inbox: boolean };

const LIFECYCLES = new Set<DiscoveryLifecycle>([
  "draft",
  "awaiting_interview",
  "awaiting_match",
  "ambiguous_match",
  "needs_source_approval",
  "needs_provider_access",
  "needs_provider_connector",
  "needs_research_proof",
  "ready_to_synthesize",
  "needs_review",
  "complete",
  "revoked",
]);

const ALLOWED_TRANSITIONS: Record<DiscoveryLifecycle, DiscoveryLifecycle[]> = {
  draft: ["awaiting_interview", "revoked"],
  awaiting_interview: ["awaiting_match", "revoked"],
  awaiting_match: ["ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "ready_to_synthesize", "revoked"],
  ambiguous_match: ["awaiting_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "ready_to_synthesize", "revoked"],
  needs_source_approval: ["awaiting_match", "ambiguous_match", "needs_provider_access", "needs_provider_connector", "needs_research_proof", "ready_to_synthesize", "revoked"],
  needs_provider_access: ["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_connector", "needs_research_proof", "ready_to_synthesize", "revoked"],
  needs_provider_connector: ["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_research_proof", "ready_to_synthesize", "revoked"],
  needs_research_proof: ["awaiting_match", "ambiguous_match", "needs_source_approval", "needs_provider_access", "needs_provider_connector", "ready_to_synthesize", "revoked"],
  ready_to_synthesize: ["needs_review", "needs_provider_access", "needs_research_proof", "revoked"],
  needs_review: ["complete", "awaiting_match", "revoked"],
  complete: ["revoked"],
  revoked: [],
};

const FORBIDDEN_PRIVATE_KEYS = new Set([
  "runtime_handle",
  "session_handle",
  "meeting_id",
  "connector_receipt",
  "transcript",
  "raw_transcript",
  "raw_content",
  "turns",
  "utterances",
]);
const PROVENANCE = new Set(["approved-context", "agent-inference", "legacy-untrusted"]);
const PROPOSAL_STATES = new Set(["draft", "needs_review", "promoted", "dismissed"]);

function readYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkPrivateKeys(value: unknown, at: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkPrivateKeys(entry, `${at}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PRIVATE_KEYS.has(key.toLowerCase())) errors.push(`${at}: forbidden private field ${key}`);
    walkPrivateKeys(entry, `${at}.${key}`, errors);
  }
}

function validateStableUrl(value: unknown, provider: string, at: string, errors: string[]): void {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string") {
    errors.push(`${at}: stable_url must be a string or null`);
    return;
  }
  // A provider with a declared canonical link form (gong-discovery-connector-v0
  // R-006) is judged by that single form — the shared sanitizer is the only
  // authority for it, so the two validators cannot drift for such providers.
  if (providerLinkForm(provider)) {
    try {
      sanitizeDiscoveryStableUrl(provider, value);
    } catch (error) {
      errors.push(`${at}: ${error instanceof Error ? error.message : "stable_url is invalid"}`);
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${at}: stable_url is invalid`);
    return;
  }
  if (parsed.protocol !== "https:") errors.push(`${at}: stable_url must use HTTPS`);
  if (parsed.search) errors.push(`${at}: stable_url must not contain a query string`);
  if (parsed.hash) errors.push(`${at}: stable_url must not contain a fragment`);
  // Keep in lockstep with PROVIDER_HOSTS in discoverySources.ts (notes.granola.ai
  // is Granola's share-link host — the divergence of these two lists refused an
  // owner-approved ingestion once already; consolidation is a recorded follow-up).
  const hosts: Record<string, string[]> = { granola: ["app.granola.ai", "granola.ai", "notes.granola.ai"] };
  const approved = hosts[provider.toLowerCase()];
  if (approved && !approved.includes(parsed.hostname.toLowerCase())) errors.push(`${at}: stable_url host is not approved for ${provider}`);
}

export function loadDiscoveryRun(studyDir: string): DiscoveryRun {
  const file = path.join(studyDir, "run.yaml");
  if (!existsSync(file)) throw new Error(`missing discovery run: ${file}`);
  return readYaml(file) as DiscoveryRun;
}

function validateRun(studyDir: string, errors: string[]): void {
  const required = ["run.yaml", "study.md", "findings.yaml", "proposals.yaml", "report.md", "events.jsonl"];
  for (const name of required) if (!existsSync(path.join(studyDir, name))) errors.push(`${path.basename(studyDir)}: missing ${name}`);
  if (!existsSync(path.join(studyDir, "run.yaml"))) return;
  let run: unknown;
  try {
    run = readYaml(path.join(studyDir, "run.yaml"));
  } catch {
    errors.push(`${path.basename(studyDir)}: run.yaml is not valid YAML`);
    return;
  }
  walkPrivateKeys(run, `${path.basename(studyDir)}/run.yaml`, errors);
  if (!isRecord(run)) {
    errors.push(`${path.basename(studyDir)}: run.yaml must be an object`);
    return;
  }
  if (run.schema_version !== DISCOVERY_SCHEMA_VERSION) errors.push(`${path.basename(studyDir)}: schema_version must be 0.1`);
  if (typeof run.study_id !== "string" || !/^study_[a-z0-9_]+$/.test(run.study_id)) errors.push(`${path.basename(studyDir)}: invalid study_id`);
  if (!LIFECYCLES.has(run.state as DiscoveryLifecycle)) errors.push(`${path.basename(studyDir)}: invalid lifecycle state`);
  if (run.lane !== "study_linked") errors.push(`${path.basename(studyDir)}: study lane must be study_linked`);
  if (!PROVENANCE.has(String(run.provenance))) errors.push(`${path.basename(studyDir)}: invalid run provenance`);
  const target = isRecord(run.target) ? run.target : {};
  if (!PROVENANCE.has(String(target.provenance))) errors.push(`${path.basename(studyDir)}: invalid target provenance`);
  const source = isRecord(run.source) ? run.source : {};
  const provider = typeof source.provider === "string" ? source.provider : "";
  validateStableUrl(source.stable_url, provider, `${path.basename(studyDir)}/run.yaml`, errors);
  validateDerivedArtifacts(studyDir, provider, errors);
}

function validateDerivedArtifacts(dir: string, provider: string, errors: string[]): void {
  const label = path.basename(dir);
  const findingsPath = path.join(dir, "findings.yaml");
  const proposalsPath = path.join(dir, "proposals.yaml");
  const findingIds = new Set<string>();
  if (existsSync(findingsPath)) {
    try {
      const doc = readYaml(findingsPath);
      walkPrivateKeys(doc, `${label}/findings.yaml`, errors);
      if (!isRecord(doc) || doc.schema_version !== DISCOVERY_SCHEMA_VERSION || !Array.isArray(doc.findings)) {
        errors.push(`${label}/findings.yaml must contain schema_version 0.1 and findings[]`);
      } else {
        for (const [index, raw] of doc.findings.entries()) {
          if (!isRecord(raw)) {
            errors.push(`${label}/findings.yaml finding ${index + 1} must be an object`);
            continue;
          }
          if (typeof raw.finding_id !== "string" || !raw.finding_id.trim()) errors.push(`${label}/findings.yaml finding ${index + 1}: finding_id is required`);
          else if (findingIds.has(raw.finding_id)) errors.push(`${label}/findings.yaml finding ${index + 1}: duplicate finding_id ${raw.finding_id}`);
          else findingIds.add(raw.finding_id);
          if (raw.lane !== undefined && raw.lane !== "study_linked" && raw.lane !== "unassigned_call_evidence") errors.push(`${label}/findings.yaml finding ${index + 1}: invalid lane`);
          if (raw.source_fingerprint !== undefined && (typeof raw.source_fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(raw.source_fingerprint))) errors.push(`${label}/findings.yaml finding ${index + 1}: invalid source_fingerprint`);
          const sourceProvider = typeof raw.source_provider === "string" ? raw.source_provider : provider;
          validateStableUrl(raw.source_url, sourceProvider, `${label}/findings.yaml finding ${index + 1} source_url`, errors);
        }
      }
    } catch {
      errors.push(`${label}/findings.yaml is not valid YAML`);
    }
  }
  if (existsSync(proposalsPath)) {
    try {
      const doc = readYaml(proposalsPath);
      walkPrivateKeys(doc, `${label}/proposals.yaml`, errors);
      if (!isRecord(doc) || doc.schema_version !== DISCOVERY_SCHEMA_VERSION || !Array.isArray(doc.proposals)) {
        errors.push(`${label}/proposals.yaml must contain schema_version 0.1 and proposals[]`);
      } else {
        const proposalIds = new Set<string>();
        for (const [index, raw] of doc.proposals.entries()) {
          if (!isRecord(raw)) {
            errors.push(`${label}/proposals.yaml proposal ${index + 1} must be an object`);
            continue;
          }
          if (typeof raw.proposal_id !== "string" || !raw.proposal_id.trim()) errors.push(`${label}/proposals.yaml proposal ${index + 1}: proposal_id is required`);
          else if (proposalIds.has(raw.proposal_id)) errors.push(`${label}/proposals.yaml proposal ${index + 1}: duplicate proposal_id ${raw.proposal_id}`);
          else proposalIds.add(raw.proposal_id);
          if (!PROPOSAL_STATES.has(String(raw.state))) errors.push(`${label}/proposals.yaml proposal ${index + 1}: invalid state`);
          const refs = Array.isArray(raw.source_finding_ids) ? raw.source_finding_ids : [];
          for (const ref of refs) if (typeof ref !== "string" || !findingIds.has(ref)) errors.push(`${label}/proposals.yaml proposal ${index + 1}: ${String(ref)} references an unknown finding`);
        }
      }
    } catch {
      errors.push(`${label}/proposals.yaml is not valid YAML`);
    }
  }
  const eventsPath = path.join(dir, "events.jsonl");
  if (existsSync(eventsPath)) {
    for (const [index, line] of readFileSync(eventsPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        walkPrivateKeys(JSON.parse(line), `${label}/events.jsonl line ${index + 1}`, errors);
      } catch {
        errors.push(`${label}/events.jsonl line ${index + 1} is not valid JSON`);
      }
    }
  }
}

function validateInbox(inboxDir: string, errors: string[]): void {
  for (const name of ["scope.yaml", "findings.yaml", "proposals.yaml", "events.jsonl"]) {
    if (!existsSync(path.join(inboxDir, name))) errors.push(`inbox: missing ${name}`);
  }
  const scopePath = path.join(inboxDir, "scope.yaml");
  if (!existsSync(scopePath)) return;
  let doc: unknown;
  try {
    doc = readYaml(scopePath);
  } catch {
    errors.push("inbox/scope.yaml is not valid YAML");
    return;
  }
  walkPrivateKeys(doc, "inbox/scope.yaml", errors);
  if (!isRecord(doc) || doc.schema_version !== DISCOVERY_SCHEMA_VERSION || !Array.isArray(doc.scopes)) {
    errors.push("inbox/scope.yaml must contain schema_version 0.1 and scopes[]");
    return;
  }
  const scopeIds = new Set<string>();
  for (const [index, raw] of doc.scopes.entries()) {
    if (!isRecord(raw)) {
      errors.push(`inbox scope ${index + 1} must be an object`);
      continue;
    }
    if (typeof raw.scope_id !== "string" || !/^[a-z0-9_]+$/.test(raw.scope_id)) errors.push(`inbox scope ${index + 1}: invalid scope_id`);
    else if (scopeIds.has(raw.scope_id)) errors.push(`inbox scope ${index + 1}: duplicate scope_id ${raw.scope_id}`);
    else scopeIds.add(raw.scope_id);
    if (raw.state !== "draft" && raw.state !== "approved" && raw.state !== "revoked") errors.push(`inbox scope ${index + 1}: invalid state`);
    if (raw.state === "approved" && (!raw.approved_by || !raw.approved_at)) errors.push(`inbox scope ${index + 1}: approved scope requires attribution`);
    // At least one customer selector; call_owners is a gong kind
    // (gong-discovery-connector-v0 R-004) and is empty/absent elsewhere.
    const selectors = [raw.participant_allowlist, raw.domain_allowlist, raw.title_tokens, raw.call_owners];
    if (!selectors.some((entry) => Array.isArray(entry) && entry.some((item) => typeof item === "string" && item.trim()))) {
      errors.push(`inbox scope ${index + 1}: approved ingestion requires at least one customer selector`);
    }
    if (!isRecord(raw.time_window) || !raw.time_window.start || !raw.time_window.end) errors.push(`inbox scope ${index + 1}: time_window requires start and end`);
    else {
      const start = Date.parse(String(raw.time_window.start));
      const end = Date.parse(String(raw.time_window.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) errors.push(`inbox scope ${index + 1}: time_window must contain valid ordered timestamps`);
    }
  }
  validateDerivedArtifacts(inboxDir, "", errors);

  // Contact cards (discovery-insight-ties-v0 R-007): optional, human-corrected
  // identity per scope. Absent is valid; present must be well-formed.
  const contactsPath = path.join(inboxDir, "contacts.yaml");
  if (existsSync(contactsPath)) {
    let contactsDoc: unknown;
    try {
      contactsDoc = readYaml(contactsPath);
    } catch {
      errors.push("inbox/contacts.yaml is not valid YAML");
      return;
    }
    walkPrivateKeys(contactsDoc, "inbox/contacts.yaml", errors);
    if (!isRecord(contactsDoc) || contactsDoc.schema_version !== DISCOVERY_SCHEMA_VERSION || !Array.isArray(contactsDoc.contacts)) {
      errors.push("inbox/contacts.yaml must contain schema_version 0.1 and contacts[]");
      return;
    }
    const contactScopeIds = new Set<string>();
    for (const [index, raw] of contactsDoc.contacts.entries()) {
      if (!isRecord(raw)) {
        errors.push(`inbox contact ${index + 1} must be an object`);
        continue;
      }
      if (typeof raw.scope_id !== "string" || !scopeIds.has(raw.scope_id)) errors.push(`inbox contact ${index + 1}: scope_id must name a known inbox scope`);
      else if (contactScopeIds.has(raw.scope_id)) errors.push(`inbox contact ${index + 1}: duplicate scope_id ${raw.scope_id}`);
      else contactScopeIds.add(raw.scope_id);
      for (const field of ["full_name", "linkedin", "company", "title"] as const) {
        if (raw[field] !== null && raw[field] !== undefined && typeof raw[field] !== "string") errors.push(`inbox contact ${index + 1}: ${field} must be a string or null`);
      }
      if (typeof raw.linkedin === "string" && raw.linkedin && !isLinkedinUrl(raw.linkedin)) {
        errors.push(`inbox contact ${index + 1}: linkedin must be an https linkedin.com URL`);
      }
      // Candidate layer (discovery-contact-capture-v0 R-002/R-004): inferred
      // suggestions with provenance, beneath the human-confirmed fields. A
      // candidate value carrying an email or phone number is a privacy leak,
      // not a candidate — the company is derived from the domain at ingest and
      // the raw address must never reach this committed file.
      if (raw.candidates !== undefined) {
        if (!Array.isArray(raw.candidates)) {
          errors.push(`inbox contact ${index + 1}: candidates must be an array`);
          continue;
        }
        for (const [candidateIndex, candidate] of raw.candidates.entries()) {
          const label = `inbox contact ${index + 1} candidate ${candidateIndex + 1}`;
          if (!isRecord(candidate)) {
            errors.push(`${label} must be an object`);
            continue;
          }
          for (const key of Object.keys(candidate)) {
            if (!CONTACT_CANDIDATE_KEYS.has(key)) errors.push(`${label}: unknown field ${key}`);
          }
          if (candidate.field !== "full_name" && candidate.field !== "company" && candidate.field !== "title" && candidate.field !== "linkedin") errors.push(`${label}: field must be full_name, company, title, or linkedin`);
          if (candidate.inferred !== true) errors.push(`${label}: candidates are always inferred: true — confirmed values live on the card fields`);
          if (typeof candidate.source !== "string" || !candidate.source.trim()) errors.push(`${label}: source is required`);
          if (typeof candidate.value !== "string" || !candidate.value.trim()) errors.push(`${label}: value is required`);
          else {
            if (CONTACT_EMAIL.test(candidate.value) || CONTACT_PHONE.test(candidate.value)) errors.push(`${label}: value must not contain an email address or phone number`);
            if (candidate.field === "linkedin" && !isLinkedinUrl(candidate.value)) errors.push(`${label}: linkedin value must be an https linkedin.com URL`);
          }
        }
      }
    }
  }
}

const CONTACT_CANDIDATE_KEYS = new Set(["field", "value", "inferred", "source"]);
const CONTACT_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const CONTACT_PHONE = /\+?\d[\d\s().-]{7,}\d/;

function isLinkedinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"));
  } catch {
    return false;
  }
}

export function validateDiscoveryPath(root: string, target?: string): DiscoveryValidation {
  const discoveryRoot = path.resolve(root, target ?? "discovery");
  const errors: string[] = [];
  if (!existsSync(discoveryRoot)) return { ok: false, errors: [`discovery path not found: ${discoveryRoot}`], studies: 0, inbox: false };
  const directRun = existsSync(path.join(discoveryRoot, "run.yaml"));
  const studyDirs = directRun
    ? [discoveryRoot]
    : readdirSync(discoveryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "inbox")
      .map((entry) => path.join(discoveryRoot, entry.name));
  const studyIds = new Set<string>();
  for (const studyDir of studyDirs) {
    validateRun(studyDir, errors);
    try {
      const studyId = loadDiscoveryRun(studyDir).study_id;
      if (studyIds.has(studyId)) errors.push(`${path.basename(studyDir)}: duplicate study_id ${studyId}`);
      else studyIds.add(studyId);
    } catch {
      continue;
    }
  }
  const inboxDir = directRun ? "" : path.join(discoveryRoot, "inbox");
  const inbox = Boolean(inboxDir && existsSync(inboxDir));
  if (inbox) validateInbox(inboxDir, errors);
  return { ok: errors.length === 0, errors, studies: studyDirs.length, inbox };
}

export function locateStudy(root: string, studyId: string): string | null {
  const discoveryRoot = path.join(root, "discovery");
  if (!existsSync(discoveryRoot)) return null;
  for (const entry of readdirSync(discoveryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "inbox") continue;
    const dir = path.join(discoveryRoot, entry.name);
    try {
      if (loadDiscoveryRun(dir).study_id === studyId) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

function repositoryRootForStudy(studyDir: string): string {
  return path.dirname(path.dirname(path.resolve(studyDir)));
}

export function transitionDiscoveryRun(studyDir: string, next: DiscoveryLifecycle, actor: DiscoveryActor, now: string): DiscoveryWrite[] {
  if (!actor.id.trim()) throw new Error("discovery transition requires an attributed actor");
  const run = loadDiscoveryRun(studyDir);
  const prior = run.state;
  if (!ALLOWED_TRANSITIONS[prior].includes(next)) throw new Error(`invalid discovery transition: ${prior} -> ${next}`);
  if ((next === "complete" || next === "revoked") && actor.type !== "human") throw new Error(`${next} is a human transition`);
  run.state = next;
  run.updated_at = now;
  const runPath = path.join(studyDir, "run.yaml");
  writeFileSync(runPath, stringify(run));
  const event = {
    specversion: "1.0",
    id: `evt_discovery_${run.study_id}_${next}_${Date.parse(now)}`,
    source: "agent://foo/discovery",
    type: "com.adaptivespec.discovery.state_changed",
    subject: `study:${run.study_id}`,
    time: now,
    actor,
    data: { from: prior, to: next },
  };
  // The event intentionally carries only lifecycle provenance, never evidence.
  appendFileSync(path.join(studyDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
  const root = repositoryRootForStudy(studyDir);
  return [runPath, path.join(studyDir, "events.jsonl")].map((file) => ({ path: path.relative(root, file).split(path.sep).join("/"), action: "updated" as const }));
}

export type DiscoveryCandidateClass = "real-study" | "product-spec" | "method-research" | "synthetic-rehearsal" | "not-discovery";

export function classifyDiscoveryCandidate(filePath: string, text: string): DiscoveryCandidateClass {
  const normalizedPath = filePath.toLowerCase();
  const normalizedText = text.toLowerCase();
  if (normalizedPath.includes("/specs/") || normalizedPath.startsWith("specs/") || /product requirements|spec id/.test(normalizedText)) return "product-spec";
  if (normalizedPath.includes("research/") || /research:|interview methods|method research/.test(normalizedText)) return "method-research";
  if (/synthetic|rehearsal|mock interview/.test(normalizedText)) return "synthetic-rehearsal";
  if (/customer interview|discovery call/.test(normalizedText) && /completed call|findings|evidence/.test(normalizedText)) return "real-study";
  return "not-discovery";
}
