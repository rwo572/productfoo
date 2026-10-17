// A research completion receipt is a productfoo-signed terminal record of a run.
//
// It replaces the pre-quarantine receipt, which was a plain `{run_id, topic, at}`
// file whose "verification" was "a file with this id exists on disk" — forgeable
// by anyone who can write a file (T-005 finding, B5 incident: a paper of invented
// citations passed every check foo had). This record instead binds, under an
// Ed25519 signature over the T-002 canonical envelope, the facts that make a run
// real: its sources, its evidence set, the provider that produced it, the
// evaluator version, and the exact bytes of the final paper. A receipt that does
// not match the paper it is presented with, or is signed by a key productfoo does not
// trust, or is replayed, does not verify — so it cannot become evidence.

import { createHash } from "node:crypto";
import {
  signEnvelope,
  verifyEnvelope,
  type AcceptedEnvelopeState,
  type EnvelopeFailureReason,
  type JsonValue,
  type SignedEnvelope,
  type SplitTrustStores,
} from "./trustEnvelope.js";

export const RESEARCH_COMPLETION_KIND = "research.completion";

/** The only states a *completion* receipt may carry. `planned` and `abandoned`
 *  are real run states, but they are not completions and are never signed as one:
 *  a signed record is a claim that a run finished, and nothing else may wear it. */
export const TERMINAL_STATES = ["completed", "validated"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface ReceiptSourceFact {
  source_class: string;
  reached: boolean;
  item_count: number;
}

export interface CompletionReceiptPayload {
  kind: typeof RESEARCH_COMPLETION_KIND;
  run_id: string;
  topic: string;
  state: TerminalState;
  sources: ReceiptSourceFact[];
  evidence_sha256: string;
  provider: { adapter: string; model: string };
  evaluator_version: string;
  paper_sha256: string;
  /** Versioned executor evidence; absent in legacy, declaration-only receipts. */
  retrieval?: JsonValue;
}

export interface CompletionReceiptInput {
  run_id: string;
  topic: string;
  state: TerminalState;
  sources: ReceiptSourceFact[];
  evidence_sha256: string;
  provider: { adapter: string; model: string };
  evaluator_version: string;
  paper_sha256: string;
  /** Versioned executor evidence; absent in legacy, declaration-only receipts. */
  retrieval?: JsonValue;
  issued_at: string;
  sequence: number;
  previous_hash: string | null;
}

export interface VerifyCompletionReceiptOptions {
  paper_bytes: Buffer;
  trust_stores: SplitTrustStores;
  accepted_state: AcceptedEnvelopeState | null;
  now: string;
  expected_run_id?: string;
  expected_provider?: { adapter: string; model: string };
  expected_sources?: readonly string[];
}

export type CompletionReceiptFailure =
  | EnvelopeFailureReason
  | "malformed_receipt"
  | "not_terminal"
  | "id_mismatch"
  | "paper_mismatch"
  | "provider_mismatch"
  | "source_mismatch";

export type VerifyCompletionReceiptResult =
  | { ok: true; receipt: CompletionReceiptPayload; next_state: AcceptedEnvelopeState }
  | { ok: false; reason: CompletionReceiptFailure };

const TEN_YEARS_MS = 315_576_000_000;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isTerminal(state: string): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Sign a terminal completion record. Refuses any non-terminal state up front:
 *  a planning or abandoned record must never exist as a signed completion. */
export function mintCompletionReceipt(
  input: CompletionReceiptInput,
  privateKeyPem: string,
  keyId: string,
): SignedEnvelope<JsonValue> {
  if (!isTerminal(input.state)) {
    throw new TypeError(`a completion receipt cannot carry the non-terminal state "${input.state}"`);
  }
  const payload: CompletionReceiptPayload = {
    kind: RESEARCH_COMPLETION_KIND,
    run_id: input.run_id,
    topic: input.topic,
    state: input.state,
    sources: input.sources.map((s) => ({
      source_class: s.source_class,
      reached: s.reached,
      item_count: s.item_count,
    })),
    evidence_sha256: input.evidence_sha256,
    provider: { adapter: input.provider.adapter, model: input.provider.model },
    evaluator_version: input.evaluator_version,
    paper_sha256: input.paper_sha256,
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
  };
  const expiresAt = new Date(Date.parse(input.issued_at) + TEN_YEARS_MS).toISOString();
  return signEnvelope(
    {
      namespace: "foo",
      artifact_kind: RESEARCH_COMPLETION_KIND,
      artifact_id: input.run_id,
      payload: payload as unknown as JsonValue,
      key_id: keyId,
      issued_at: input.issued_at,
      not_before: input.issued_at,
      expires_at: expiresAt,
      sequence: input.sequence,
      previous_hash: input.previous_hash,
    },
    privateKeyPem,
  );
}

function readField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[field];
}

function parsePayload(payload: unknown): CompletionReceiptPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== RESEARCH_COMPLETION_KIND) return null;
  if (typeof p.run_id !== "string" || typeof p.topic !== "string") return null;
  if (typeof p.state !== "string" || !isTerminal(p.state)) return null;
  if (!Array.isArray(p.sources)) return null;
  const sources: ReceiptSourceFact[] = [];
  for (const s of p.sources) {
    const sc = readField(s, "source_class");
    const reached = readField(s, "reached");
    const count = readField(s, "item_count");
    if (typeof sc !== "string" || typeof reached !== "boolean" || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    sources.push({ source_class: sc, reached, item_count: count });
  }
  const provider = p.provider as Record<string, unknown> | undefined;
  if (!provider || typeof provider.adapter !== "string" || typeof provider.model !== "string") return null;
  if (typeof p.evidence_sha256 !== "string" || typeof p.evaluator_version !== "string" || typeof p.paper_sha256 !== "string") {
    return null;
  }
  return {
    kind: RESEARCH_COMPLETION_KIND,
    run_id: p.run_id,
    topic: p.topic,
    state: p.state,
    sources,
    evidence_sha256: p.evidence_sha256,
    provider: { adapter: provider.adapter, model: provider.model },
    evaluator_version: p.evaluator_version,
    paper_sha256: p.paper_sha256,
    ...(p.retrieval ? { retrieval: p.retrieval as JsonValue } : {}),
  };
}

/** Verify a completion receipt against the paper it claims to certify.
 *  The signature is necessary but not sufficient: the receipt must also bind the
 *  paper bytes in front of us, and (when the caller knows them) the expected run,
 *  provider, and source set. Any mismatch fails — a valid signature over the wrong
 *  paper is exactly the forgery this record exists to refuse. */
export function verifyCompletionReceipt(
  envelopeValue: unknown,
  options: VerifyCompletionReceiptOptions,
): VerifyCompletionReceiptResult {
  const artifactId = readField(envelopeValue, "artifact_id");
  const env = verifyEnvelope(envelopeValue, {
    expected_namespace: "foo",
    expected_artifact_kind: RESEARCH_COMPLETION_KIND,
    expected_artifact_id: options.expected_run_id ?? (typeof artifactId === "string" ? artifactId : ""),
    trust_stores: options.trust_stores,
    accepted_state: options.accepted_state,
    verification_mode: "accept",
    now: options.now,
  });
  if (!env.ok) return { ok: false, reason: env.reason };

  const payload = parsePayload(env.verified_envelope.payload);
  if (!payload) return { ok: false, reason: "malformed_receipt" };
  if (!isTerminal(payload.state)) return { ok: false, reason: "not_terminal" };
  if (payload.run_id !== env.verified_envelope.artifact_id) return { ok: false, reason: "id_mismatch" };

  if (sha256Hex(options.paper_bytes) !== payload.paper_sha256) {
    return { ok: false, reason: "paper_mismatch" };
  }
  if (
    options.expected_provider &&
    (options.expected_provider.adapter !== payload.provider.adapter ||
      options.expected_provider.model !== payload.provider.model)
  ) {
    return { ok: false, reason: "provider_mismatch" };
  }
  if (options.expected_sources) {
    const have = [...payload.sources.map((s) => s.source_class)].sort();
    const want = [...options.expected_sources].sort();
    if (have.length !== want.length || have.some((c, i) => c !== want[i])) {
      return { ok: false, reason: "source_mismatch" };
    }
  }
  return { ok: true, receipt: payload, next_state: env.next_state };
}
