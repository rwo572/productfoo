// error-instrumentation-v0 T-001 (R-001, R-002, D-001): what kind of failure was
// that, actually?
//
// Before this module, `main()` bucketed EVERY nonzero exit as "command_error", so
// `foo swarm` typed without an argument — which prints a correct usage line and
// exits 1 — was recorded identically to an unhandled crash. Across 14,492 events
// the field only ever held "none" or "command_error", and not one genuine crash
// was ever distinguishable. The dashboard cried wolf; the owner learned to ignore it.
//
// Three outcomes were collapsed into one. They are not the same thing:
//
//   usage_error  the human mistyped. foo printed usage. Nothing is broken.
//   gate_block   a boundary (B1/B2/B4) refused by design. The product WORKED.
//   command_error  something genuinely, unexpectedly failed. THIS is worth waking someone for.
//
// Only the last one should ever page a human. That is the whole point of the file.
//
// D-001: the code is a BOUNDED SYMBOL, never free text. It crosses the wire, where
// productfoo's disclosure promises metadata only — so it must never be able to carry a path,
// an argument, a filename, or user content. Adding a code means adding it to ErrorCode
// below, on purpose, where it can be read and reviewed. Rich detail (message, stack)
// stays in the local event log, which never leaves the machine.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";


/** What kind of failure. Only `command_error` and `io_error` are worth paging a human for. */
export type ErrorClass =
  | "none" // exit 0
  | "usage_error" // bad invocation — a typo, not a defect
  | "gate_block" // a boundary refused by design — the product working
  | "not_found" // the thing asked for does not exist
  | "io_error" // the filesystem/network failed under us
  | "command_error"; // genuine, unexpected — page someone

/**
 * Bounded, symbolic failure codes. NEVER free text: these cross the wire under a
 * metadata-only disclosure, so a code may not embed a path, an arg, or user content.
 * Each maps to exactly one failure site, so a code in a digest greps straight to source.
 */
export type ErrorCode =
  // usage_error
  | "E_COMMAND_MISSING"
  | "E_PACKET_DIR_MISSING"
  | "E_SWARM_TARGET_MISSING"
  | "E_IDEATE_IDEA_MISSING"
  | "E_SPEC_WORK_MISSING"
  | "E_UNKNOWN_DOMAIN"
  | "E_BAD_FLAG"
  | "E_NOT_A_RESEARCH_PAPER"
  // not_found
  | "E_PACKET_NOT_FOUND"
  | "E_SPEC_NOT_FOUND"
  | "E_SKILL_NOT_FOUND"
  | "E_SDR_EVENT_NOT_FOUND"
  // gate_block
  | "E_GATE_B1_SECRET"
  | "E_GATE_B2_SPEC_ID"
  | "E_GATE_B4_BUDGET"
  // B5: a research paper that cannot name a governed run. The reading was never blocked —
  // it cannot be, in a harness productfoo has no hook in — but the result is refused as evidence.
  | "E_GATE_B5_UNGOVERNED"
  | "E_GATE_B5_CLAIM_UNLABELED"
  | "E_GATE_BLOCKED"
  // The interview gate refusing a questionnaire, and the command-contract checker finding
  // drift. Both are the tool WORKING. They are here because they exited nonzero and nothing
  // marked them, so they were logged as unhandled E_UNKNOWN crashes — foo paging itself for
  // its own boundaries. A deliberate nonzero exit needs a code, or the default invents one.
  | "E_GATE_INTERVIEW"
  | "E_CONTRACT_DRIFT"
  // Skill text that no approval on this machine covers. A refusal with a real
  // fix (`foo skill trust`), so it is a gate_block and never an outage.
  | "E_SKILL_SOURCE_UNAPPROVED"
  // io_error / catch-all
  | "E_IO"
  | "E_UNKNOWN";

/** Does a failure of this class deserve a human's attention at 3am? */
export function pages(errorClass: ErrorClass): boolean {
  return errorClass === "command_error" || errorClass === "io_error";
}

export type FailureMark = {
  errorClass: ErrorClass;
  errorCode: ErrorCode;
  /** Rich, LOCAL-ONLY. Never sent by default (D-001) — stripped from the wire payload. */
  message?: string;
  stack?: string;
};

type FailureScope = { pending?: FailureMark };
const failureScopes = new AsyncLocalStorage<FailureScope>();
let unscopedPending: FailureMark | undefined;

/** Give one top-level invocation its own mark across every awaited dispatch path. */
export function runWithFailureScope<T>(operation: () => T): T {
  return failureScopes.run({}, operation);
}

/** Record what kind of failure just happened. Called at the failure site. */
export function markFailure(mark: FailureMark): void {
  const scope = failureScopes.getStore();
  if (scope) scope.pending = mark;
  else unscopedPending = mark;
}

/** Take the mark and clear it. Cleared on read so it can never bleed into the next run. */
export function consumeFailure(): FailureMark | undefined {
  const scope = failureScopes.getStore();
  const mark = scope ? scope.pending : unscopedPending;
  if (scope) scope.pending = undefined;
  else unscopedPending = undefined;
  return mark;
}

/** Drop any mark. Called at the start of each run so a prior command can't contaminate this one. */
export function resetFailure(): void {
  const scope = failureScopes.getStore();
  if (scope) scope.pending = undefined;
  else unscopedPending = undefined;
}

/**
 * "You invoked this wrong" — thrown rather than returned. Same meaning as failWith: a typo.
 * Throw this instead of a bare Error and the failure classifies itself correctly.
 */
export class UsageError extends Error {
  readonly errorCode: ErrorCode;
  constructor(message: string, errorCode: ErrorCode = "E_BAD_FLAG") {
    super(message);
    this.name = "UsageError";
    this.errorCode = errorCode;
  }
}

/**
 * A boundary refused by design — B1 safety, B2 spec identity, B4 autonomy, a default-deny
 * policy. THE PRODUCT IS WORKING. It exits nonzero because it stopped you on purpose, and it
 * must never, ever page anyone.
 */
export class GateBlock extends Error {
  readonly errorCode: ErrorCode;
  constructor(message: string, errorCode: ErrorCode = "E_GATE_BLOCKED") {
    super(message);
    this.name = "GateBlock";
    this.errorCode = errorCode;
  }
}

/**
 * The thing you asked for does not exist — a packet dir, a loop id, a file. Nonzero, but not
 * a defect: foo worked, the target just isn't there. Classifies as `not_found`, which never
 * pages. Thrown rather than returned so the caller doesn't thread a special return value out.
 */
export class NotFoundError extends Error {
  readonly errorCode: ErrorCode;
  constructor(message: string, errorCode: ErrorCode = "E_PACKET_NOT_FOUND") {
    super(message);
    this.name = "NotFoundError";
    this.errorCode = errorCode;
  }
}

// productfoo throws from 255 places. Most are genuine faults, but two families are not, and both
// were being reported as crashes until a dogfood run caught them:
//
//   "work missing — usage: foo spec <work>"        — a typo. The command printed its usage.
//   "loop(s) without an agreed budget: L-001"      — B4 refusing. The product WORKED.
//
// Converting all 255 call sites is not realistic, so new and converted code throws UsageError
// or GateBlock (checked first, below) and these patterns bridge the rest. They are deliberately
// narrow: a usage line and a named boundary are unmistakable, and anything we are not sure
// about stays `command_error` and pages. A false "typo" hides a real bug; a false "bug" only
// pings someone. When in doubt, ping.
const LOOKS_LIKE_USAGE = /\busage: foo\b|\bunknown foo command\b/i;
const LOOKS_LIKE_GATE = /without an agreed budget|default-deny|\bB[124]\b (?:safety|boundary|blocks)/i;

/**
 * Classify a thrown error that nothing marked. An `E*` errno (ENOENT, EACCES) is the
 * filesystem or network failing under us; a typo and a gate refusal are not failures at all;
 * anything else is a genuine unexpected fault, and gets someone's attention.
 */
export function classifyThrown(error: unknown): FailureMark {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // The command said what it was. Believe it.
  if (error instanceof UsageError) return { errorClass: "usage_error", errorCode: error.errorCode, message, stack };
  if (error instanceof GateBlock) return { errorClass: "gate_block", errorCode: error.errorCode, message, stack };
  if (error instanceof NotFoundError) return { errorClass: "not_found", errorCode: error.errorCode, message, stack };

  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return { errorClass: "io_error", errorCode: "E_IO", message, stack };
  }

  if (LOOKS_LIKE_GATE.test(message)) return { errorClass: "gate_block", errorCode: "E_GATE_BLOCKED", message, stack };
  if (LOOKS_LIKE_USAGE.test(message)) return { errorClass: "usage_error", errorCode: "E_BAD_FLAG", message, stack };

  return { errorClass: "command_error", errorCode: "E_UNKNOWN", message, stack };
}

// The one frame that says WHERE a failure came from, reduced to something safe to fingerprint
// AND stable across the people who hit the same bug. Three reductions, each load-bearing:
//
//   - the absolute path is dropped to a basename — a stack names `/Users/taylor/...`, and the
//     whole point of the disclosure promise is that a tester's home directory is not ours;
//   - :line:col is dropped — the same bug drifts a few lines between releases, and a
//     fingerprint that changes every version cannot say "this is the same bug, still";
//   - only the first real frame is kept — deeper frames are shared plumbing that would make
//     unrelated failures collide.
//
// What remains is `functionName (basename.js)`: enough to tell two bugs apart, free of any
// path, argument, or user content — the same content-free bar the bounded error code meets.
function fingerprintFrame(stack?: string | null): string | null {
  if (!stack) return null;
  const m = stack.split(/\r?\n/).map(line => /^\s*at\s+(\S+)\s+\(([^)]+)\)/.exec(line)).find(Boolean);
  if (!m) return null;
  const file = m[2].split(/[\\/]/).pop()?.replace(/:\d+:\d+$/, "") ?? m[2];
  return `${m[1]} (${file})`;
}

/**
 * A stable, privacy-safe grouping key for a failure: the bounded code plus the normalized
 * origin frame. Two failures with the same code AND the same frame are the same bug — which
 * is what lets the digest tell "one bug hit nine people" apart from "nine unrelated
 * E_UNKNOWNs in the same command".
 *
 * It is a one-way hash of content-free inputs (a bounded code and a `fn (basename)` string —
 * no path, no line, no argument, no message), so it is safe on the metadata-only wire.
 *
 * NO STACK MEANS NO FINGERPRINT. This used to hash a `<no-stack>` sentinel instead, and the
 * comment defended it as degrading "deterministically ... rather than collapsing at random".
 * It had it exactly backwards: hashing a constant does not spread stackless failures out, it
 * funnels EVERY one of them that shares a code into a single identity. In production that
 * produced `3b07a3cdfb33` = sha256("E_UNKNOWN\n<no-stack>") on eight unrelated commands at
 * once — asp reconcile, self check, self gate, research gate, asp validate, research
 * validate, commands validate, reconcile — which the console then drew as ONE bug, named
 * after whichever row happened to sort first, with the blast radius of all eight.
 *
 * It also silently broke the join to error reports: a report fingerprints WITH a stack and
 * these rows fingerprinted WITHOUT one, so the two could never match. 0 of 140 did. Every
 * stack the console displayed came from a fallback that guessed by error code, which is how
 * `foo redact` came to show a "work-item missing" crash from specCmd.js.
 *
 * Returning undefined is the honest answer: callers already group by command + code when
 * there is no fingerprint, which keeps unrelated commands apart instead of fusing them.
 */
export function errorFingerprint(errorCode: string, stack?: string | null): string | undefined {
  const frame = fingerprintFrame(stack);
  if (!frame) return undefined;
  return createHash("sha256").update(`${errorCode}\n${frame}`).digest("hex").slice(0, 12);
}
