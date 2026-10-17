// alpha-distribution-telemetry-v0 (T-009 / T-010 / T-011) — satisfaction signal,
// friction-triggered error feedback, and the consented eval-capture lane.
//
// D-011: reuse the existing telemetry substrate — the append-only
// `.foo/agent-events.jsonl` ledger, the pseudonymous tester id, and the
// enabled/opt-out gate — never a parallel ledger. Existing ledger readers
// filter by `event_type`, so the new `feedback` events are additive and ignored
// by `foo agent logs`.
//
// D-010: every default signal is CONTENT-FREE. Solicited free-text is
// redacted-before-store (same engine as B1). The ONLY place raw (idea, record)
// content is retained is the explicit opt-in eval lane (T-011) — encrypted at
// rest, TTL'd, and tester-deletable. Not opted in ⇒ nothing beyond the envelope.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readJson } from "./jsonFile.js";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { agentLogPath, nextAgentEventId, readAgentTelemetryConfig, resolveTesterId } from "./commands/agent.js";
import { redactText } from "./redactEngine.js";

// --- content-free feedback events (T-009 satisfaction, T-010 friction) --------

export type FeedbackSignal = "revealed" | "solicited" | "friction";

export type FeedbackEvent = {
  schema_version: "0.1";
  event_type: "feedback";
  id: string;
  timestamp: string;
  signal: FeedbackSignal;
  // revealed: handoff | abandon | override | kept · solicited: rating | spontaneous · friction: error
  kind: string;
  domain?: string;
  command?: string;
  rating?: number; // solicited one-keystroke micro-poll (glyph → 1..N)
  reason_code?: string; // friction structured pick: too_slow | wrong | crashed | other
  error_class?: string; // friction: mirrors the cli_usage error_class
  note?: string; // redacted free-text (spontaneous / "other")
  redactions?: number; // spans the redactor removed from note (metadata, never the value)
  tester_id?: string;
  packet_slug?: string;
};

// Gate: opted-in config AND not DO_NOT_TRACK — the same posture as recordCliUsage,
// so feedback honors the exact opt-out testers already have (OQ-4 / D-010).
export function feedbackEnabled(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DO_NOT_TRACK === "1" || env.DO_NOT_TRACK === "true") return false;
  return readAgentTelemetryConfig(root).config.enabled;
}

// Redact a tester-authored note before it is ever stored (D-010). Returns the
// redacted text and the count of spans removed — never the secret value.
export function redactNote(note: string): { text: string; redactions: number } {
  const result = redactText(note, { threshold: "medium" });
  return { text: result.redactedText, redactions: result.receipt.redactions };
}

// Append a content-free feedback event to the shared ledger. Fire-and-forget:
// like recordCliUsage, a failure here never alters CLI behavior.
export function recordFeedback(
  root: string,
  event: Omit<FeedbackEvent, "schema_version" | "event_type" | "id" | "timestamp" | "tester_id">,
  env: NodeJS.ProcessEnv = process.env,
): FeedbackEvent | null {
  try {
    if (!feedbackEnabled(root, env)) return null;
    const testerId = resolveTesterId(root);
    const full: FeedbackEvent = {
      schema_version: "0.1",
      event_type: "feedback",
      id: nextAgentEventId(),
      timestamp: new Date().toISOString(),
      ...event,
      ...(testerId ? { tester_id: testerId } : {}),
    };
    const logPath = agentLogPath(root);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(full)}\n`);
    return full;
  } catch {
    return null;
  }
}

// Revealed preference (T-009): behavioral, zero-friction, no content. The
// strongest satisfaction signal — what the tester DID with the output.
export function recordRevealed(
  root: string,
  kind: "handoff" | "abandon" | "override" | "kept",
  ctx: { domain?: string; command?: string; packet_slug?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): FeedbackEvent | null {
  return recordFeedback(root, { signal: "revealed", kind, ...ctx }, env);
}

// Sampled solicited micro-poll (T-009): one keystroke → a small integer rating.
export function recordRating(
  root: string,
  rating: number,
  ctx: { domain?: string; command?: string; packet_slug?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): FeedbackEvent | null {
  return recordFeedback(root, { signal: "solicited", kind: "rating", rating, ...ctx }, env);
}

// Spontaneous `foo feedback "..."` (T-009): tester-authored product feedback,
// redacted-before-store. The text is the tester's, about the product — never
// their idea/prompt — but it is scrubbed for secrets all the same (B1).
export function recordSpontaneous(root: string, note: string, env: NodeJS.ProcessEnv = process.env): FeedbackEvent | null {
  const { text, redactions } = redactNote(note);
  return recordFeedback(root, { signal: "solicited", kind: "spontaneous", note: text, redactions }, env);
}

// Revealed preference from an ideate record (T-009): the strongest signal is
// whether the human kept the AI's recommendation or overrode it. Content-free —
// it compares the record's `recommendation:` and `pick:` fields and returns only
// the CLASS ("override" | "kept"), never either value. "undecided" = no pick yet;
// null = decided but nothing to compare against.
export function classifyDecision(recordText: string): "override" | "kept" | "undecided" | null {
  const grab = (re: RegExp): string | null => recordText.match(re)?.[1] ?? null;
  const norm = (v: string | null): string | null => {
    if (v == null) return null;
    const t = v.trim().replace(/^["']|["']$/g, "").trim();
    return t === "" || t === "null" ? null : t;
  };
  const rec = norm(grab(/^recommendation:\s*(.+)$/m));
  const pick = norm(grab(/^pick:\s*(.+)$/m));
  if (pick == null) return "undecided";
  if (rec == null) return null;
  return rec === pick ? "kept" : "override";
}

// Fire-and-forget instrumentation for `foo ideate check`: read the record,
// classify the decision, and record the content-free revealed event. Never
// throws, never alters the caller's exit code (mirrors recordCliUsage).
export function recordIdeateDecision(
  root: string,
  recordPath: string,
  env: NodeJS.ProcessEnv = process.env,
): "override" | "kept" | null {
  try {
    if (!feedbackEnabled(root, env)) return null;
    const full = path.resolve(root, recordPath);
    if (!existsSync(full)) return null;
    const kind = classifyDecision(readFileSync(full, "utf8"));
    if (kind === "override" || kind === "kept") {
      recordRevealed(root, kind, { domain: "ideate", command: "ideate check" }, env);
      return kind;
    }
    return null;
  } catch {
    return null;
  }
}

// --- friction-triggered feedback (T-010) -------------------------------------

// Error classes that are transient / auto-recovered — never worth interrupting
// a tester over. A blip that recovers is not a satisfaction event.
export const TRANSIENT_ERROR_CLASSES: ReadonlySet<string> = new Set(["offline", "network", "io_error", "none"]);

export type Sampler = () => number; // returns [0,1); injectable for deterministic tests

// Decide whether to interrupt the tester after an error. Only on a real
// (non-transient) failure, and only a sampled fraction of the time — over-
// prompting trains reflexive dismissal and destroys the signal (D-012).
export function shouldPromptOnError(
  errorClass: string,
  opts: { sampleRate?: number; sampler?: Sampler } = {},
): boolean {
  if (TRANSIENT_ERROR_CLASSES.has(errorClass)) return false;
  const rate = opts.sampleRate ?? 0.5;
  const draw = (opts.sampler ?? Math.random)();
  return draw < rate;
}

export const ERROR_REASON_CODES = ["too_slow", "wrong", "crashed", "other"] as const;
export type ErrorReasonCode = (typeof ERROR_REASON_CODES)[number];

// Record the tester's answer to "what happened?". The structured reason is the
// analyzable label (D-012); an optional free-text note (on "other") is redacted
// before it is stored. The content-free cli_usage error event fires separately
// and unconditionally (recordCliUsage) — this only adds the human's intent.
export function recordErrorFeedback(
  root: string,
  input: { reason_code: ErrorReasonCode; error_class?: string; note?: string; domain?: string; command?: string },
  env: NodeJS.ProcessEnv = process.env,
): FeedbackEvent | null {
  let note: string | undefined;
  let redactions: number | undefined;
  if (input.note && input.note.trim()) {
    const r = redactNote(input.note);
    note = r.text;
    redactions = r.redactions;
  }
  return recordFeedback(
    root,
    {
      signal: "friction",
      kind: "error",
      reason_code: input.reason_code,
      ...(input.error_class ? { error_class: input.error_class } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(note !== undefined ? { note, redactions } : {}),
    },
    env,
  );
}

// The one-keystroke prompt the CLI renders after a real error. Kept as a pure
// string so the copy is testable; the TTY read is a thin wrapper in the CLI.
export function renderErrorPrompt(): string {
  return "That didn't work. What happened?  [1] too slow  [2] output wrong  [3] crashed  [4] other  (enter to skip)";
}

export function reasonForKey(key: string): ErrorReasonCode | null {
  return ({ "1": "too_slow", "2": "wrong", "3": "crashed", "4": "other" } as Record<string, ErrorReasonCode>)[key.trim()] ?? null;
}

// Feedback is durably recorded in the local ledger without network access.
export function feedbackIsOfflineDurable(): boolean {
  return true;
}

// --- consented eval-capture lane (T-011) -------------------------------------
// The "separate consent gate" R-005/D-004 deferred, made concrete. Opt-in only.
// Retains the (idea, record, label) triple for consenting testers — redacted,
// AES-256-GCM encrypted at rest, TTL'd, and tester-visible/deletable.

const EVAL_DIR = ".foo/eval-capture";
const CONSENT_FILE = ".foo/eval-consent.json";

function evalDir(root: string): string {
  return path.join(root, EVAL_DIR);
}
function consentPath(root: string): string {
  return path.join(root, CONSENT_FILE);
}

export function readEvalConsent(root: string): boolean {
  const p = consentPath(root);
  if (!existsSync(p)) return false; // opt-IN: default is no capture
  try {
    return readJson<{ opted_in?: boolean }>(p).opted_in === true;
  } catch {
    return false;
  }
}

export function setEvalConsent(root: string, optedIn: boolean): void {
  mkdirSync(path.dirname(consentPath(root)), { recursive: true });
  writeFileSync(
    consentPath(root),
    `${JSON.stringify({ schema_version: "0.1", opted_in: optedIn, updated: new Date().toISOString() }, null, 2)}\n`,
  );
}

// Local at-rest key: 32 random bytes, mode 0600, gitignored under .foo. Genuine
// encryption for the local skeleton (the hosted lane would use a managed key).
function evalKey(root: string): Buffer {
  const keyPath = path.join(evalDir(root), ".key");
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8"), "hex");
  mkdirSync(evalDir(root), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

export type EvalTriple = { idea: string; record: string; label: string };
export type EvalCaptureMeta = { id: string; captured_at: string; expires_at: string; label: string; redactions: number };

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Capture a run for eval — ONLY if the tester opted in. Idea + record are
// redacted (B1) then encrypted at rest. Returns the capture id, or null when
// not consented (nothing is written). The label is the satisfaction signal
// (e.g. "bad", "override") that makes this a curated example, not noise.
export function captureForEval(
  root: string,
  triple: EvalTriple,
  opts: { ttlMs?: number; now?: number } = {},
): string | null {
  if (!readEvalConsent(root)) return null; // not opted in ⇒ retain nothing

  const idea = redactNote(triple.idea);
  const record = redactNote(triple.record);
  const now = opts.now ?? Date.now();
  const id = `ev_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
  const payload = JSON.stringify({ idea: idea.text, record: record.text, label: triple.label });

  const key = evalKey(root);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const meta: EvalCaptureMeta = {
    id,
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    label: triple.label,
    redactions: idea.redactions + record.redactions,
  };
  mkdirSync(evalDir(root), { recursive: true });
  writeFileSync(
    path.join(evalDir(root), `${id}.enc`),
    JSON.stringify({ meta, iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc.toString("hex") }),
  );
  return id;
}

// Tester-visible: list metadata only (never decrypts). This is the "show me
// what's retained" surface the consent story requires.
export function listEvalCaptures(root: string): EvalCaptureMeta[] {
  const dir = evalDir(root);
  if (!existsSync(dir)) return [];
  const out: EvalCaptureMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".enc")) continue;
    try {
      out.push(readJson<{ meta: EvalCaptureMeta }>(path.join(dir, f)).meta);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

// Tester-deletable: forget one capture, or all of them.
export function deleteEvalCapture(root: string, id: string): boolean {
  const p = path.join(evalDir(root), `${id}.enc`);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export function forgetAllEvalCaptures(root: string): number {
  const before = listEvalCaptures(root);
  for (const m of before) deleteEvalCapture(root, m.id);
  return before.length;
}

// TTL enforcement: drop expired captures. The maintainer (or a cron) calls this;
// retention is a promise, so it must be mechanical, not aspirational.
export function pruneExpiredEvalCaptures(root: string, now: number = Date.now()): number {
  let pruned = 0;
  for (const m of listEvalCaptures(root)) {
    if (new Date(m.expires_at).getTime() <= now) {
      if (deleteEvalCapture(root, m.id)) pruned += 1;
    }
  }
  return pruned;
}

// Decrypt one capture — the eval-set builder's read path (maintainer-side, with
// the local key). Returns null if expired, tampered, or missing.
export function readEvalCapture(root: string, id: string, now: number = Date.now()): EvalTriple | null {
  const p = path.join(evalDir(root), `${id}.enc`);
  if (!existsSync(p)) return null;
  try {
    const box = readJson<{
      meta: EvalCaptureMeta;
      iv: string;
      tag: string;
      data: string;
    }>(p);
    if (new Date(box.meta.expires_at).getTime() <= now) return null;
    const decipher = createDecipheriv("aes-256-gcm", evalKey(root), Buffer.from(box.iv, "hex"));
    decipher.setAuthTag(Buffer.from(box.tag, "hex"));
    const dec = Buffer.concat([decipher.update(Buffer.from(box.data, "hex")), decipher.final()]).toString("utf8");
    return JSON.parse(dec) as EvalTriple;
  } catch {
    return null;
  }
}
