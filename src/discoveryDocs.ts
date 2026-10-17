// The docs evidence-class runtime (notion-discovery-connector-v0 D-001, T-004).
//
// Documents are not sessions. Evidence runs through the substrate's
// selection-plus-approval model with ONE bounded summarize step under the same
// one-time proof boundary used for research calls — then only the summary
// lands. Nothing else about the model changes: same classification, same
// ledger, same revocation. The raw document content exists in process memory
// for exactly one model request and is never written, logged, or returned.
//
// Contract-only: this module makes no claim about live Notion access — the
// feasibility report (T-001) and the dogfood run (T-007) own that evidence.

import { createHash } from "node:crypto";
import path from "node:path";
import { appendIntegrationRecord, approvalStates, minimizeSummary, notionScopeAllowsSelection, sourceKey, type SourceId } from "./sourceIngress.js";
import { approvalLedgerDigest, consumeApprovedSourceProof, mintApprovedSourceProof, openApprovedSourceContent } from "./discoveryProof.js";
import { defaultSynthesisModel, synthesisCredentialPresent, type SynthesisTransport } from "./discoverySynthesis.js";
import { NOTION_POLICY, NotionClient, NotionRuntimeError, notionConnectionConfigured, resolveNotionConnection, type NotionConnectionEnv } from "./notionNango.js";
import { sanitizeDiscoveryStableUrl } from "./discoverySources.js";

// Typed failure codes for the one-read flow. Every message is bounded and
// content-free: provider errors never embed a response body, and ceiling
// failures never echo what was dropped.
export type DocsFlowErrorCode =
  | "needs_provider_connector"
  | "needs_source_approval"
  | "content_too_large"
  | "model_refused"
  | "model_truncated"
  | "identity_leak_refused"
  | "access_denied"
  | "provider_failure"
  | "invalid";

export class DocsFlowError extends Error {
  constructor(public readonly code: DocsFlowErrorCode, message: string) {
    super(message);
    this.name = "DocsFlowError";
  }
}

// --- Raw provider record -> parse layer ---------------------------------------
//
// The raw record is whatever the provider or a caller hands over; only this
// parse layer reads it. Everything downstream sees the closed, validated
// NotionSourceRecord. Extra provider keys are read and dropped here.

export type NotionSourceRecord = {
  provider: "notion";
  connection_alias: string;
  page_id?: string;
  database_id?: string;
  title?: string;
  last_edited: string;
  // Canonical https://www.notion.so/<page-id> form, derived when the provider
  // did not supply one. Tokenized share links are refused, never de-tokenized.
  stable_url?: string;
  parent_container?: string;
};

const NOTION_UUID = /^[0-9a-f]{32}$/i;

function canonicalNotionId(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new DocsFlowError("invalid", `${label} is missing`);
  const hex = raw.trim().replace(/-/g, "");
  if (!NOTION_UUID.test(hex)) throw new DocsFlowError("invalid", `${label} carries an invalid Notion identifier`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function notionCanonicalPageUrl(pageId: string): string {
  return `https://www.notion.so/${canonicalNotionId(pageId, "page_id")}`;
}

export function parseNotionSourceRecord(raw: Record<string, unknown>, opts: { connection_alias: string }): NotionSourceRecord {
  if (!opts.connection_alias.trim()) throw new DocsFlowError("invalid", "a docs source record needs its connection alias");
  const page_id = raw.page_id !== undefined ? canonicalNotionId(raw.page_id, "page_id") : undefined;
  const database_id = raw.database_id !== undefined ? canonicalNotionId(raw.database_id, "database_id") : undefined;
  if (!page_id && !database_id) throw new DocsFlowError("invalid", "a docs source record names a page or a database");
  if (page_id && database_id) throw new DocsFlowError("invalid", "a docs source record names one selection, not both");
  const lastEdited = raw.last_edited;
  if (typeof lastEdited !== "string" || !Number.isFinite(Date.parse(lastEdited))) throw new DocsFlowError("invalid", "a docs source record carries a last_edited timestamp");
  let stableUrl: string | undefined;
  if (raw.url !== undefined) {
    const sanitized = sanitizeDiscoveryStableUrl("notion", String(raw.url));
    if (sanitized) stableUrl = sanitized;
  }
  if (!stableUrl && page_id) stableUrl = notionCanonicalPageUrl(page_id);
  return {
    provider: "notion",
    connection_alias: opts.connection_alias.trim(),
    ...(page_id ? { page_id } : {}),
    ...(database_id ? { database_id } : {}),
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    last_edited: new Date(lastEdited).toISOString(),
    ...(stableUrl ? { stable_url: stableUrl } : {}),
    ...(typeof raw.parent_container === "string" && raw.parent_container.trim() ? { parent_container: raw.parent_container.trim() } : {}),
  };
}

// Binds the proof to this exact selection on this exact connection.
export function docsSelectionFingerprint(record: Pick<NotionSourceRecord, "connection_alias" | "page_id" | "database_id">): string {
  return `sha256:${createHash("sha256").update(["docs", record.connection_alias, record.page_id ?? "", record.database_id ?? ""].join("\n")).digest("hex")}`;
}

// --- The closed summary shape --------------------------------------------------

export type ApprovedSourceSummary = {
  schema_version: "0.1";
  kind: "approved_source_artifact_summary";
  source: {
    provider: string;
    connection_alias: string;
    stable_url?: string;
    source_fingerprint: string;
    last_edited: string;
    title?: string;
  };
  source_category: "docs";
  evidence_class: "approved_source_artifact";
  model_exposure: "summary_only";
  summary: string;
  coverage: { caveats: string[] };
  privacy_attestation: { pii_redacted: true; direct_quotes: false; raw_content_present: false };
};

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{8,}\d)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The identity screen (R-005): derived text is screened against the workspace's
// own people's identities before any write. A leak refuses the write — the
// summary is discarded, nothing lands in the ledger, and the caller gets a
// typed error with no content echo.
export function containsIdentity(text: string, identities: string[]): boolean {
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text)) return true;
  return identities.some((identity) => identity.trim().length >= 4 && new RegExp(`\\b${escapeRegExp(identity.trim())}\\b`, "i").test(text));
}

function validateApprovedSourceSummary(value: unknown, identities: string[]): ApprovedSourceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocsFlowError("invalid", "the summary payload is not an object");
  const shape = value as Record<string, unknown>;
  const ALLOWED = new Set(["schema_version", "kind", "source", "source_category", "evidence_class", "model_exposure", "summary", "coverage", "privacy_attestation"]);
  for (const key of Object.keys(shape)) {
    if (!ALLOWED.has(key)) throw new DocsFlowError("invalid", `the summary payload carries unknown field ${key}`);
  }
  if (shape.schema_version !== "0.1" || shape.kind !== "approved_source_artifact_summary") throw new DocsFlowError("invalid", "the summary payload is not an approved_source_artifact_summary");
  if (shape.source_category !== "docs" || shape.evidence_class !== "approved_source_artifact" || shape.model_exposure !== "summary_only") throw new DocsFlowError("invalid", "the summary payload does not carry the docs class");
  const summary = shape.summary;
  if (typeof summary !== "string" || !summary.trim()) throw new DocsFlowError("invalid", "the summary payload carries no summary text");
  const coverage = shape.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage) || !Array.isArray((coverage as Record<string, unknown>).caveats)) throw new DocsFlowError("invalid", "the summary payload carries no coverage caveats");
  const attestation = shape.privacy_attestation;
  if (!attestation || (attestation as Record<string, unknown>).pii_redacted !== true || (attestation as Record<string, unknown>).direct_quotes !== false || (attestation as Record<string, unknown>).raw_content_present !== false) {
    throw new DocsFlowError("invalid", "the summary payload carries no privacy attestation");
  }
  if (containsIdentity(summary, identities)) throw new DocsFlowError("identity_leak_refused", "the derived summary carried an identity; it was refused and nothing was written");
  return shape as unknown as ApprovedSourceSummary;
}

// --- The one summarize step --------------------------------------------------

const DOCS_SYSTEM = [
  "You summarize an approved internal document for product-research evidence.",
  "Rules:",
  "- Paraphrase only; never quote the document verbatim.",
  "- Never include email addresses, phone numbers, or other personal contact details.",
  "- Never include people's names; refer to roles (for example \"an engineer\", \"the account owner\").",
  "- The summary must stand alone without the document text.",
  "Output strict JSON with exactly these keys: {\"summary\": string, \"caveats\": string[]}.",
].join("\n");

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new DocsFlowError("invalid", "the model reply carried no JSON object; nothing was written");
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new DocsFlowError("invalid", "the model reply carried no readable JSON object; nothing was written");
  }
}

/**
 * Exactly one bounded model request over the approved content (R-005). The
 * content exists only inside this one request; the reply is closed-validated,
 * identity-screened, and turned into the summary record. On any refusal the
 * caller receives a typed error and no write has happened.
 */
export async function summarizeApprovedSource(input: { record: NotionSourceRecord; content_text: string; identities: string[] }, options: { model: string; transport: SynthesisTransport }): Promise<ApprovedSourceSummary> {
  const estimatedTokens = Math.ceil(input.content_text.length / 4);
  if (estimatedTokens > NOTION_POLICY.max_model_input_tokens) {
    throw new DocsFlowError("content_too_large", "the selected document exceeds the model input ceiling; the content was dropped and nothing was written");
  }
  const user = [
    "Approved document selection. Summarize it for product-research evidence.",
    `Title: ${input.record.title ?? "(untitled)"}`,
    `Last edited: ${input.record.last_edited}`,
    "",
    "Document content:",
    input.content_text,
    "",
    'Respond with strict JSON: {"summary": string, "caveats": string[]}.',
  ].join("\n");
  const reply = await options.transport({ model: options.model, system: DOCS_SYSTEM, user, max_tokens: 4000 });
  if (reply.stop_reason === "refusal") throw new DocsFlowError("model_refused", "the model declined to summarize this document; nothing was written");
  if (reply.stop_reason === "max_tokens") throw new DocsFlowError("model_truncated", "the summary output was truncated; nothing was written");
  const payload = extractJsonObject(reply.text);
  const summaryText = typeof payload.summary === "string" ? payload.summary : "";
  const caveats = Array.isArray(payload.caveats) ? (payload.caveats as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  const built: ApprovedSourceSummary = {
    schema_version: "0.1",
    kind: "approved_source_artifact_summary",
    source: {
      provider: input.record.provider,
      connection_alias: input.record.connection_alias,
      ...(input.record.stable_url ? { stable_url: input.record.stable_url } : {}),
      source_fingerprint: docsSelectionFingerprint(input.record),
      last_edited: input.record.last_edited,
      ...(input.record.title ? { title: input.record.title } : {}),
    },
    source_category: "docs",
    evidence_class: "approved_source_artifact",
    model_exposure: "summary_only",
    summary: summaryText.trim(),
    coverage: { caveats },
    privacy_attestation: { pii_redacted: true, direct_quotes: false, raw_content_present: false },
  };
  if (!built.summary) throw new DocsFlowError("invalid", "the model reply carried no summary text; nothing was written");
  return validateApprovedSourceSummary(built, input.identities);
}

// --- The one-read flow --------------------------------------------------------

export type NotionSelectionInput = {
  packet_dir: string;
  // Proof-receipt home; matches the discovery local root (.foo/discovery).
  local_root: string;
  target_id: string;
  connection_alias: string;
  selection: { page_id?: string; database_id?: string };
  now: string;
  env: NotionConnectionEnv;
  transport: SynthesisTransport;
};

export type ApprovedDocsResult = {
  schema_version: "0.1";
  status: "recorded" | "needs_provider_connector" | "needs_source_approval" | "content_too_large" | "model_refused" | "model_truncated" | "identity_leak_refused" | "failed";
  selection: { page_id?: string; database_id?: string };
  summary?: ApprovedSourceSummary;
  errors: Array<{ code: DocsFlowErrorCode; message: string }>;
  next_action?: string;
};

function fail(status: ApprovedDocsResult["status"], code: DocsFlowErrorCode, message: string, input: NotionSelectionInput, nextAction?: string): ApprovedDocsResult {
  return {
    schema_version: "0.1",
    status,
    selection: input.selection,
    errors: [{ code, message }],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

/**
 * The one-read flow for an explicitly selected Notion page (R-004/R-005):
 * approval-checked against the packet's ledger, proof-gated, one content read,
 * one model request, identity screen, one summary-only ledger record, proof
 * consumed. The canary content appears in no file, log, or output — only the
 * PII-minimized summary survives.
 */
export async function processNotionSelection(input: NotionSelectionInput, deps: { fetchImpl?: typeof globalThis.fetch } = {}): Promise<ApprovedDocsResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (input.selection.database_id) {
    return fail("failed", "invalid", "database selections use the bounded listing flow (listNotionDatabaseSelection), not the one-read summarize flow", input);
  }
  let pageId: string;
  try {
    pageId = canonicalNotionId(input.selection.page_id, "page_id");
  } catch (error) {
    return fail("failed", "invalid", error instanceof Error ? error.message : "invalid selection", input);
  }
  if (!notionConnectionConfigured(input.env)) {
    return fail("needs_provider_connector", "needs_provider_connector", "Notion is not connected; connect the company workspace through Nango", input);
  }
  // Fail-closed approval gate before ANY provider call: the connection must be
  // approved in this packet's ledger and one accumulated scope must explicitly
  // admit this page (never a wildcard).
  const state = approvalStates(input.packet_dir).get(sourceKey({ provider: "notion", connection_id: input.connection_alias }));
  const approved = state?.state === "approved" && state.scopes.some((scope) => notionScopeAllowsSelection(scope, { page_id: pageId }));
  if (!approved) {
    return fail("needs_source_approval", "needs_source_approval", "this page is not inside an approved Notion scope for this packet", input, `foo source approve ${path.relative(process.cwd(), input.packet_dir) || input.packet_dir} --provider notion --connection ${input.connection_alias} --scope '{"page_ids":["${pageId}"],"window":{"from":"<from>","to":"<to>"}}' --by <person>`);
  }
  if (!synthesisCredentialPresent(input.env as NodeJS.ProcessEnv)) {
    return fail("failed", "invalid", "no model credential is configured for the summarize step", input, "set the synthesis credential before processing an approved selection");
  }
  const connection = await resolveNotionConnection({ env: input.env, fetchImpl }).catch((error: unknown) => {
    if (error instanceof NotionRuntimeError && error.code === "not_connected") return null;
    throw error;
  });
  if (!connection) {
    return fail("needs_provider_connector", "needs_provider_connector", "Notion is not connected; connect the company workspace through Nango", input);
  }
  const record: NotionSourceRecord = { provider: "notion", connection_alias: input.connection_alias, page_id: pageId, last_edited: new Date(input.now).toISOString() };
  const fingerprint = docsSelectionFingerprint(record);
  const client = new NotionClient(connection.credential, { fetchImpl, sleep: async () => undefined });
  const digest = approvalLedgerDigest(input.packet_dir);
  mintApprovedSourceProof(input.local_root, {
    target_id: input.target_id,
    provider: "notion",
    connection_alias: input.connection_alias,
    selection_fingerprint: fingerprint,
    approval_digest: digest,
    now: input.now,
  });
  try {
    // Metadata first (listing boundary), then the ONE content read inside the
    // proof-gated open. The open re-verifies approval at the moment of the
    // read — a revocation between mint and open invalidates the proof.
    const meta = await client.page(pageId);
    const fullRecord = parseNotionSourceRecord(
      {
        page_id: meta.id,
        title: meta.title,
        last_edited: meta.last_edited_time ?? input.now,
        url: meta.url,
      },
      { connection_alias: input.connection_alias },
    );
    const identityNames = (input.env.FOO_WORKSPACE_IDENTITIES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const content = await openApprovedSourceContent(
      { packet_dir: input.packet_dir, local_root: input.local_root, target_id: input.target_id, selection_fingerprint: fingerprint, selection: { page_id: pageId }, now: input.now },
      () => client.pageContent(pageId),
    );
    const summary = await summarizeApprovedSource({ record: fullRecord, content_text: content, identities: identityNames }, { model: defaultSynthesisModel(input.env as NodeJS.ProcessEnv), transport: input.transport });
    // The summary-only ledger record. The generic recordSummary entry cannot
    // carry the docs-class freshness/link fields, so the flow writes the full
    // docs entry through the generic append — the approval gate above (and the
    // proof's re-check at open time) is the fail-closed gate.
    appendIntegrationRecord(input.packet_dir, {
      kind: "approved_source_artifact_summary",
      source_id: { ingress_path: "nango", provider: "notion", connection_id: input.connection_alias } satisfies SourceId,
      selection: `page:${pageId}`,
      summary: minimizeSummary(summary.summary),
      evidence_class: "approved_source_artifact",
      source_category: "docs",
      source_fingerprint: fingerprint,
      last_edited: fullRecord.last_edited,
      ...(fullRecord.stable_url ? { stable_url: fullRecord.stable_url } : {}),
      at: input.now,
      tombstoned: false,
    });
    return { schema_version: "0.1", status: "recorded", selection: input.selection, summary, errors: [] };
  } catch (error) {
    if (error instanceof DocsFlowError) {
      const status: ApprovedDocsResult["status"] =
        error.code === "content_too_large" ? "content_too_large" : error.code === "model_refused" ? "model_refused" : error.code === "model_truncated" ? "model_truncated" : error.code === "identity_leak_refused" ? "identity_leak_refused" : "failed";
      return fail(status, error.code, error.message, input);
    }
    if (error instanceof NotionRuntimeError) {
      const code: DocsFlowErrorCode = error.code === "content_too_large" ? "content_too_large" : error.code === "access_denied" ? "access_denied" : "provider_failure";
      const status: ApprovedDocsResult["status"] = code === "content_too_large" ? "content_too_large" : "failed";
      return fail(status, code, error.message, input);
    }
    return fail("failed", "provider_failure", error instanceof Error ? error.message : "the approved-source flow failed; nothing was written", input);
  } finally {
    // Zero residue: consume the proof on every post-open path. A purged or
    // missing receipt is fine — best-effort cleanup.
    try {
      consumeApprovedSourceProof(input.local_root, input.target_id, fingerprint, input.now);
    } catch {
      // The receipt was already purged (failed open) or is missing.
    }
  }
}

/**
 * The listing boundary for an approved database selection: a bounded metadata
 * listing (titles + last-edited, capped by policy) and nothing else. No
 * content read happens here, nothing is written, and the caller decides what
 * the listing is evidence for.
 */
export async function listNotionDatabaseSelection(input: Omit<NotionSelectionInput, "transport">, deps: { fetchImpl?: typeof globalThis.fetch } = {}): Promise<{ schema_version: "0.1"; status: "listed" | "needs_provider_connector" | "needs_source_approval" | "failed"; records: NotionSourceRecord[]; errors: Array<{ code: DocsFlowErrorCode; message: string }> }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let databaseId: string;
  try {
    databaseId = canonicalNotionId(input.selection.database_id, "database_id");
  } catch (error) {
    return { schema_version: "0.1", status: "failed", records: [], errors: [{ code: "invalid", message: error instanceof Error ? error.message : "invalid selection" }] };
  }
  if (!notionConnectionConfigured(input.env)) {
    return { schema_version: "0.1", status: "needs_provider_connector", records: [], errors: [{ code: "needs_provider_connector", message: "Notion is not connected; connect the company workspace through Nango" }] };
  }
  const state = approvalStates(input.packet_dir).get(sourceKey({ provider: "notion", connection_id: input.connection_alias }));
  const approved = state?.state === "approved" && state.scopes.some((scope) => notionScopeAllowsSelection(scope, { database_id: databaseId }));
  if (!approved) {
    return { schema_version: "0.1", status: "needs_source_approval", records: [], errors: [{ code: "needs_source_approval", message: "this database is not inside an approved Notion scope for this packet" }] };
  }
  const connection = await resolveNotionConnection({ env: input.env, fetchImpl }).catch((error: unknown) => {
    if (error instanceof NotionRuntimeError && error.code === "not_connected") return null;
    throw error;
  });
  if (!connection) {
    return { schema_version: "0.1", status: "needs_provider_connector", records: [], errors: [{ code: "needs_provider_connector", message: "Notion is not connected; connect the company workspace through Nango" }] };
  }
  try {
    const client = new NotionClient(connection.credential, { fetchImpl, sleep: async () => undefined });
    const rows = await client.queryDatabase(databaseId);
    const records = rows.map((row) =>
      parseNotionSourceRecord({ page_id: row.id, title: row.title, last_edited: row.last_edited_time ?? input.now, url: row.url, parent_container: `database:${databaseId}` }, { connection_alias: input.connection_alias }),
    );
    return { schema_version: "0.1", status: "listed", records, errors: [] };
  } catch (error) {
    if (error instanceof NotionRuntimeError) {
      return { schema_version: "0.1", status: "failed", records: [], errors: [{ code: error.code === "access_denied" ? "access_denied" : "provider_failure", message: error.message }] };
    }
    return { schema_version: "0.1", status: "failed", records: [], errors: [{ code: "provider_failure", message: error instanceof Error ? error.message : "the listing failed" }] };
  }
}

// ─── CLI worker surfaces (T-005) ─────────────────────────────────────────────
// `foo discovery notion ready | list <packet> | process <packet> --page=<id>`
// — the same worker shape as the Gong runtime, reporting the substrate's
// support states truthfully: this connector is contract_only and read-only.

import { existsSync, statSync } from "node:fs";
import { hasFlag } from "./cliArgs.js";
import { localRoot, type DiscoveryCommandOutcome, type DiscoveryCommandResult, type DiscoveryCommandStatus, type DiscoveryErrorCode } from "./discoveryCommand.js";
import { notionCredentialBroker } from "./notionNango.js";
import { parseNotionScope } from "./sourceIngress.js";

export type NotionDocsDeps = {
  fetchImpl?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  transport?: SynthesisTransport;
};

const MODE = "local_worker";
const SUPPORT_STATE = "contract_only";

function cliResult(status: DiscoveryCommandStatus, options: Partial<Omit<DiscoveryCommandResult, "schema_version" | "status">> = {}): DiscoveryCommandResult {
  return { schema_version: "0.1", status, writes: [], errors: [], handoff: null, next_actions: [], coverage: {}, ...options };
}

function cliExitCode(status: DiscoveryCommandStatus): number {
  return ["needs_source_approval", "needs_provider_connector", "needs_provider_access", "needs_review", "invalid", "budget_exhausted", "needs_research_proof"].includes(status) ? 1 : 0;
}

function cliOutcome(value: DiscoveryCommandResult, json: boolean): DiscoveryCommandOutcome {
  const exitCode = cliExitCode(value.status);
  if (json) return { output: `${JSON.stringify(value, null, 2)}\n`, exitCode, result: value };
  const lines = [`Discovery (notion): ${value.status}.`];
  for (const error of value.errors) lines.push(`- ${error.message}`);
  if (value.handoff) lines.push(`Handoff: ${value.handoff}`);
  for (const action of value.next_actions) lines.push(`Next: ${action}`);
  return { output: `${lines.join("\n")}\n`, exitCode, result: value };
}

function cliInvalid(message: string, json: boolean, code: DiscoveryErrorCode = "E_DISCOVERY_VALIDATION", targetId?: string): DiscoveryCommandOutcome {
  return cliOutcome(cliResult("invalid", { study_id: targetId, errors: [{ code, message }] }), json);
}

// The docs scope for a packet: the accumulated approval scopes for every
// Notion connection, with each scope's page/database ids and window parsed
// fail-closed (an unparseable approved scope never widens what may be read).
export function approvedNotionScopes(packetDir: string): Array<{ connection_id: string; scope: ReturnType<typeof parseNotionScope>; raw: string }> {
  const out: Array<{ connection_id: string; scope: ReturnType<typeof parseNotionScope>; raw: string }> = [];
  for (const [key, state] of approvalStates(packetDir)) {
    if (state.state !== "approved") continue;
    const [provider, connectionId] = key.split("::");
    if (provider !== "notion" || !connectionId) continue;
    for (const raw of state.scopes) {
      try {
        out.push({ connection_id: connectionId, scope: parseNotionScope(raw), raw });
      } catch {
        // A scope that fails the closed parser is not a permission; skip it.
      }
    }
  }
  return out;
}

function resolvePacketDir(root: string, target: string | undefined): string | null {
  if (!target) return null;
  const candidates = [path.join(root, target), path.join(root, "specs", target)];
  for (const candidate of candidates) {
    // The packet directory exists before its first approval; the approval
    // ledger is created by `foo source approve`.
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

async function readyCommand(root: string, json: boolean, deps: { fetchImpl: typeof globalThis.fetch; env: NodeJS.ProcessEnv; now: () => string }): Promise<DiscoveryCommandOutcome> {
  const env = deps.env;
  const coverage: Record<string, unknown> = {
    provider: "notion",
    mode: MODE,
    support_state: SUPPORT_STATE,
    connection_owner: "workspace",
    configured: notionConnectionConfigured(env as NotionConnectionEnv),
    credential_broker: notionCredentialBroker(env as NotionConnectionEnv),
    synthesis: { available: synthesisCredentialPresent(env), model: defaultSynthesisModel(env) },
    policy: { ...NOTION_POLICY },
    // Honest capability map: writes and workspace-wide search do not exist in
    // this client, and page content reads happen only under a one-time proof.
    capabilities: { write_back: false, workspace_search: false, read_page_content: "one-time-proof gated", list_database_selections: "bounded metadata only" },
  };
  try {
    const connection = await resolveNotionConnection({ env, fetchImpl: deps.fetchImpl });
    coverage.connection = connection.connection_ref;
    coverage.credential_broker = connection.broker;
    coverage.credential_type = String(connection.credential.type);
    coverage.provider_reads = "none: readiness proves the credential only; provider content reads happen under an approved selection";
    return cliOutcome(cliResult("ok", { coverage, next_actions: [
      ...(connection.broker === "direct" ? ["Credential broker is direct: this runtime holds an administrator-issued integration token itself. Refresh and revoke happen in Notion, not centrally; move to Nango for the company connection."] : []),
      "Approve a bounded Notion scope with foo source approve --provider notion …, then run foo discovery notion list <packet>.",
      ...(coverage.synthesis && !(coverage.synthesis as { available: boolean }).available ? ["Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) before processing a page."] : []),
    ] }), json);
  } catch (error) {
    if (error instanceof NotionRuntimeError) {
      const status: DiscoveryCommandStatus = "needs_provider_connector";
      return cliOutcome(cliResult(status, { coverage: { ...coverage, provider_error: error.code }, errors: [{ code: "E_DISCOVERY_PROVIDER_CONNECTOR", message: error.message }], handoff: "Connect the company Notion workspace through Nango and set NANGO_SECRET_KEY and FOO_NOTION_NANGO_CONNECTION; or, for this runtime only, set FOO_NOTION_API_TOKEN from an administrator-issued internal integration token." }), json);
    }
    return cliInvalid("Notion readiness failed closed without exposing private source content.", json);
  }
}

// The docs flow's closed statuses map onto the discovery command's closed
// status set without inventing new states.
function flowToCommandStatus(flow: DocsFlowErrorCode): { status: DiscoveryCommandStatus; code: DiscoveryErrorCode } {
  switch (flow) {
    case "needs_source_approval": return { status: "needs_source_approval", code: "E_DISCOVERY_SOURCE_APPROVAL" };
    case "needs_provider_connector": return { status: "needs_provider_connector", code: "E_DISCOVERY_PROVIDER_CONNECTOR" };
    case "content_too_large": return { status: "budget_exhausted", code: "E_DISCOVERY_VALIDATION" };
    case "model_refused":
    case "model_truncated": return { status: "needs_review", code: "E_DISCOVERY_RESEARCH_PROOF" };
    case "identity_leak_refused": return { status: "needs_review", code: "E_DISCOVERY_MANUAL_RESOLUTION" };
    case "access_denied": return { status: "needs_provider_access", code: "E_DISCOVERY_PROVIDER_ACCESS" };
    default: return { status: "invalid", code: "E_DISCOVERY_VALIDATION" };
  }
}

function flowOutcome(flowStatus: string, errors: Array<{ code: DocsFlowErrorCode; message: string }>, targetId: string, coverage: Record<string, unknown>, nextActions: string[], json: boolean): DiscoveryCommandOutcome {
  if (flowStatus === "recorded" || flowStatus === "listed") {
    return cliOutcome(cliResult("ok", { study_id: targetId, coverage, next_actions: nextActions }), json);
  }
  const first = errors[0];
  const mapped = flowToCommandStatus(first?.code ?? "provider_failure");
  return cliOutcome(cliResult(mapped.status, {
    study_id: targetId,
    coverage: { ...coverage, provider_error: first?.code },
    errors: [{ code: mapped.code, message: first?.message ?? "the approved-docs flow stopped without writing anything" }],
    ...(mapped.status === "needs_review" ? { handoff: "A person should review the model output refusal; nothing was written." } : {}),
  }), json);
}

async function listCommand(root: string, target: string | undefined, json: boolean, deps: { fetchImpl: typeof globalThis.fetch; env: NodeJS.ProcessEnv; now: () => string }): Promise<DiscoveryCommandOutcome> {
  const packetDir = resolvePacketDir(root, target);
  if (!packetDir) return cliInvalid("Usage: foo discovery notion list <packet-name-or-path> (a spec packet with an approved Notion scope)", json, "E_DISCOVERY_VALIDATION", target);
  const scopes = approvedNotionScopes(packetDir);
  if (scopes.length === 0) {
    return cliOutcome(cliResult("needs_source_approval", {
      study_id: target,
      errors: [{ code: "E_DISCOVERY_SOURCE_APPROVAL", message: "No approved Notion scope is recorded for this packet; nothing was read." }],
      handoff: "Approve a bounded scope first: foo source approve <packet> --provider notion --connection <alias> --scope '{\"page_ids\":[…],\"database_ids\":[…],\"window\":{…}}' --by <person>",
    }), json);
  }
  const listed: Array<Record<string, unknown>> = [];
  const perDatabase: Array<Record<string, unknown>> = [];
  for (const approved of scopes) {
    for (const databaseId of approved.scope.database_ids ?? []) {
      const result = await listNotionDatabaseSelection({
        packet_dir: packetDir,
        local_root: localRoot(root),
        target_id: `docs_notion_${approved.connection_id}`,
        connection_alias: approved.connection_id,
        selection: { database_id: databaseId },
        now: deps.now(),
        env: deps.env as NotionSelectionInput["env"],
      }, { fetchImpl: deps.fetchImpl });
      if (result.status === "listed") listed.push(...result.records.map((record) => ({ page_id: record.page_id, title: record.title, last_edited: record.last_edited, stable_url: record.stable_url, parent_container: record.parent_container })));
      perDatabase.push({ database: result.status === "listed" ? "listed" : result.status, records: result.status === "listed" ? result.records.length : 0, errors: result.errors });
    }
  }
  const failed = perDatabase.filter((entry) => entry.database !== "listed");
  if (failed.length > 0 && listed.length === 0) {
    const first = failed[0].errors as Array<{ code: DocsFlowErrorCode; message: string }>;
    return flowOutcome("failed", first, target ?? "", { mode: MODE, support_state: SUPPORT_STATE, databases: perDatabase }, [], json);
  }
  return cliOutcome(cliResult("ok", {
    study_id: target,
    coverage: { mode: MODE, support_state: SUPPORT_STATE, content_reads: 0, records: listed.length, records_listed: listed, databases: perDatabase },
    next_actions: [`Run foo discovery notion process ${target} --page <page-id> to open one approved page under a one-time proof.`],
  }), json);
}

async function processCommand(root: string, target: string | undefined, args: string[], json: boolean, deps: { fetchImpl: typeof globalThis.fetch; env: NodeJS.ProcessEnv; now: () => string; transport: SynthesisTransport }): Promise<DiscoveryCommandOutcome> {
  const packetDir = resolvePacketDir(root, target);
  if (!packetDir) return cliInvalid("Usage: foo discovery notion process <packet-name-or-path> --page <page-id>", json, "E_DISCOVERY_VALIDATION", target);
  const pageId = hasFlag(args, "--page") ? args[args.indexOf("--page") + 1] : undefined;
  if (!pageId || pageId.startsWith("--")) return cliInvalid("One explicit --page <page-id> is required: the docs flow opens exactly the approved page you name, never a wider read.", json, "E_DISCOVERY_VALIDATION", target);
  const scopes = approvedNotionScopes(packetDir);
  const connectionAlias = scopes[0]?.connection_id || "workspace";
  const flow = await processNotionSelection({
    packet_dir: packetDir,
    local_root: localRoot(root),
    target_id: `docs_notion_${connectionAlias}`,
    connection_alias: connectionAlias,
    selection: { page_id: pageId },
    now: deps.now(),
    env: deps.env as NotionSelectionInput["env"],
    transport: deps.transport,
  }, { fetchImpl: deps.fetchImpl });
  return flowOutcome(flow.status, flow.errors, target ?? "", {
    mode: MODE,
    support_state: SUPPORT_STATE,
    policy_version: NOTION_POLICY.policy_version,
    content_reads: flow.status === "recorded" ? 1 : 0,
    model_requests: flow.status === "recorded" ? 1 : 0,
    evidence_class: flow.summary?.evidence_class,
  }, flow.status === "recorded" ? ["The summary-only record is in the packet's local integration-events.jsonl; the raw page was never written."] : [], json);
}

export async function runNotionDocsDiscovery(root: string, args: string[], deps: NotionDocsDeps = {}): Promise<DiscoveryCommandOutcome> {
  const json = hasFlag(args, "--json");
  const env = deps.env ?? process.env;
  const resolved = {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    env,
    now: deps.now ?? (() => new Date().toISOString()),
    transport: deps.transport ?? ((request: Parameters<SynthesisTransport>[0]) => { throw new Error("no synthesis transport configured"); }),
  };
  const command = args[0];
  const target = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  try {
    if (command === "ready") return await readyCommand(root, json, resolved);
    if (command === "list") return await listCommand(root, target, json, resolved);
    if (command === "process") return await processCommand(root, target, args, json, resolved);
    return cliInvalid("Try: ready | list <packet-name-or-path> | process <packet-name-or-path> --page <page-id>", json);
  } catch {
    return cliInvalid("Notion discovery failed closed without exposing private source content.", json);
  }
}
