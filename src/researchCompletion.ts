// The research completion lifecycle over a real paper — T-005 wiring.
//
// Ties three proven pieces together: the signed receipt (researchReceipt), productfoo's
// signing key (researchSigningKey), and on-disk storage. `sealPaperReceipt` mints
// a receipt bound to the exact bytes of a finished paper and stores it;
// `verifyPaperReceipt` proves a paper in hand matches its signed receipt under
// productfoo's trusted key. A planning id is a bookmark; only a sealed receipt is
// evidence — so a paper that was never sealed, or was altered after sealing, does
// not verify.
//
// Storage mirrors the existing run-store split: a working store under `.foo/`
// (untracked, per-machine) and a published store under `research/.runs/` (tracked,
// so a paper's proof travels with it to a reviewer's fresh clone).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  mintCompletionReceipt,
  verifyCompletionReceipt,
  type ReceiptSourceFact,
  type VerifyCompletionReceiptResult,
} from "./researchReceipt.js";
import { loadFooResearchTrustStores, loadOrCreateFooSigningKey } from "./researchSigningKey.js";

import { loadRetrievalProof, verifyRetrievalProof, researchEvidenceDigest, lockResearchRun, isResearchSealed } from "./researchExecution.js";
import type { JsonValue } from "./trustEnvelope.js";

const workingDir = (root: string): string => path.join(root, ".foo", "research-runs");
const publishedDir = (root: string): string => path.join(root, "research", ".runs");
const receiptFile = (id: string): string => `${id}.receipt.json`;

const RUN_ID = /^r-[a-z0-9]+-[a-z0-9_-]+$/i;

export interface SealPaperInput {
  runId: string;
  topic: string;
  paperBytes: Buffer;
  sources: ReceiptSourceFact[];
  provider: { adapter: string; model: string };
  evaluatorVersion: string;
  /** Test seams. */
  now?: string;
  keyDir?: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Sign a completion receipt for a finished paper and store it in the working
 *  store. The receipt binds the paper's bytes, so this is a terminal act: seal
 *  the paper you mean to keep. */
export function sealPaperReceipt(root: string, input: SealPaperInput): { run_id: string } {
  if (!RUN_ID.test(input.runId)) throw new TypeError(`invalid run id: ${input.runId}`);
  const unlock = lockResearchRun(root, input.runId);
  try {
    if (isResearchSealed(root, input.runId)) {
      const existing = verifyPaperReceipt(root, input.runId, input.paperBytes, { now: input.now });
      if (existing.ok && existing.receipt.topic === input.topic) return { run_id: input.runId };
      if (!existing.ok && existing.reason === "paper_mismatch") {
        throw new Error('research run already sealed — paper changed since sealing (paper_mismatch). Restore the sealed paper to verify its existing proof. To keep the revision, run foo research "<topic>", complete its required retrieval, update research_run in the paper to the new run id, then seal it. The existing receipt has not been changed.');
      }
      throw new Error("research run already sealed with different or unverified content; start a new run");
    }
    const retrieval = loadRetrievalProof(root, input.runId);
    const verdict = verifyRetrievalProof(root, input.runId, input.topic, retrieval, input.now);
    if (!verdict.ok) throw new Error(verdict.reason);
    const key = loadOrCreateFooSigningKey(root, { keyDir: input.keyDir, now: input.now });
    const now = input.now ?? new Date().toISOString();
    const receipt = mintCompletionReceipt({
      run_id: input.runId, topic: input.topic, state: "completed",
      // Report declarations are not execution evidence. Only this adapter has
      // measured facts; other sources remain claims in the paper.
      sources: [verdict.source],
      evidence_sha256: researchEvidenceDigest(retrieval),
      retrieval: retrieval as unknown as JsonValue,
      provider: input.provider, evaluator_version: "research-execution-v2",
      paper_sha256: sha256Hex(input.paperBytes), issued_at: now, sequence: 1, previous_hash: null,
    }, key.privateKeyPem, key.keyId);
    mkdirSync(workingDir(root), { recursive: true });
    writeFileSync(path.join(workingDir(root), receiptFile(input.runId)), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    return { run_id: input.runId };
  } finally { unlock(); }
}

function loadStoredReceipt(root: string, id: string): unknown | null {
  if (!RUN_ID.test(id)) return null;
  for (const dir of [publishedDir(root), workingDir(root)]) {
    const file = path.join(dir, receiptFile(id));
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
  }
  return null;
}

export type VerifyPaperResult = VerifyCompletionReceiptResult | { ok: false; reason: "no_receipt" | "execution_unverified" };

/** Verify a paper in hand against its stored signed receipt, under productfoo's
 *  published trust store. Missing receipt, altered paper, or untrusted key all
 *  fail — so an ungoverned or tampered paper cannot count as evidence. */
export function verifyPaperReceipt(
  root: string,
  id: string,
  paperBytes: Buffer,
  opts: { now?: string } = {},
): VerifyPaperResult {
  const stored = loadStoredReceipt(root, id);
  if (!stored) return { ok: false, reason: "no_receipt" };
  const result = verifyCompletionReceipt(stored, {
    paper_bytes: paperBytes,
    trust_stores: loadFooResearchTrustStores(root),
    accepted_state: null,
    now: opts.now ?? new Date().toISOString(),
    expected_run_id: id,
  });
  if (!result.ok) return result;
  const proof = result.receipt.retrieval;
  const execution = verifyRetrievalProof(root, id, result.receipt.topic, proof, opts.now);
  if (!execution.ok || result.receipt.evaluator_version !== "research-execution-v2" ||
      result.receipt.evidence_sha256 !== researchEvidenceDigest(proof) ||
      JSON.stringify(result.receipt.sources) !== JSON.stringify([execution.source])) {
    return { ok: false, reason: "execution_unverified" };
  }
  return result;
}

/** Publish a working receipt into the tracked store so a paper's proof travels
 *  with it. Idempotent. */
export function publishPaperReceipt(root: string, id: string): "sealed" | "already-sealed" | "no-receipt" {
  if (!RUN_ID.test(id)) return "no-receipt";
  const published = path.join(publishedDir(root), receiptFile(id));
  if (existsSync(published)) return "already-sealed";
  const working = path.join(workingDir(root), receiptFile(id));
  if (!existsSync(working)) return "no-receipt";
  mkdirSync(publishedDir(root), { recursive: true });
  writeFileSync(published, readFileSync(working, "utf8"));
  return "sealed";
}
