import { parseBugCapsule, uuidV7, type BugCapsule, type FieldValue } from "./bugCapsule.js";
import { savePending, type LocalBugRecord } from "./bugReportStore.js";
import type { BugSpecContext } from "./bugSpecContext.js";
import { errorFingerprint, pages, UsageError, type FailureMark } from "./errorTaxonomy.js";
import { redactText } from "./redactEngine.js";

const MAX_STRING_LENGTH = 4_096;
const MAX_PATH_TOKEN_LENGTH = 16_384;

export type FailureCaptureInput = {
  failure: FailureMark;
  command: string;
  version: string;
  specContext?: BugSpecContext;
  isTest?: boolean;
};

export type ManualCaptureInput = {
  expected?: string;
  actual?: string;
  reproduction?: string;
  command?: string;
  version: string;
  specContext?: BugSpecContext;
};

function bounded(value: string): string {
  return value.slice(0, MAX_STRING_LENGTH);
}

type AbsolutePathKind = "posix" | "windows";

function absolutePathKind(text: string, index: number): AbsolutePathKind | undefined {
  const first = text[index];
  if (/[A-Za-z]/.test(first ?? "") && text[index + 1] === ":" && /[\\/]/.test(text[index + 2] ?? "")) return "windows";
  if (first === "\\" && text[index + 1] === "\\") return "windows";
  if (first === "/" && (index === 0 || !/[\p{L}\p{N}._@+-]/u.test(text[index - 1]))) return "posix";
  return undefined;
}

function safePathBasename(raw: string): string | undefined {
  const withoutLocation = raw.replace(/:\d+(?::\d+)?$/, "").replace(/[.,;!?]+$/, "");
  const basename = withoutLocation.split(/[\\/]/).at(-1);
  return basename && /^[A-Za-z0-9._@+-]{1,255}$/.test(basename) && basename !== "." && basename !== ".."
    ? basename
    : undefined;
}

function nextSpaceChunkHasSeparator(text: string, index: number, closing: string | undefined): boolean {
  let start = index;
  while (text[start] === " ") start += 1;
  let end = start;
  while (end < text.length && !/\s/.test(text[end]) && (!closing || text[end] !== closing)) end += 1;
  return /[\\/]/.test(text.slice(start, end));
}

function basenameLooksComplete(raw: string): boolean {
  const basename = safePathBasename(raw);
  return Boolean(basename && /\.[A-Za-z0-9]{1,16}$/.test(basename));
}

function remainderCouldContinueAbsolutePath(text: string, index: number): boolean {
  // The chunk straight after the punctuation may still be this path's next
  // segment ("customer) records/private/file.txt"), so any separator there
  // keeps the boundary unproven.
  if (nextSpaceChunkHasSeparator(text, index, undefined)) return true;
  // Beyond that chunk, only an absolute-looking start (/x, C:\x, \\share)
  // keeps the boundary unproven. Repo-relative tokens such as src/x.ts,
  // bin/foo, or discovery/inbox are the vocabulary of a bug report about foo
  // itself: they say nothing about the reporter's machine and must never
  // poison an otherwise provable boundary into withholding the field.
  for (let scan = index; scan < text.length; scan += 1) {
    if (absolutePathKind(text, scan)) return true;
  }
  return false;
}

function punctuationBoundaryIsProven(text: string, index: number): boolean {
  if (index + 1 === text.length) return true;
  if (!/\s/.test(text[index + 1])) return false;
  return !remainderCouldContinueAbsolutePath(text, index + 1);
}

/**
 * Linear path tokenizer. Only absolute/home/drive/UNC starts are treated as
 * paths; repo-relative tokens (src/x.ts, bin/foo) pass through untouched. An
 * unprovable boundary on an absolute path withholds the whole field.
 */
function scrubAbsolutePaths(text: string): string | undefined {
  const wrappers: Readonly<Record<string, string>> = { '"': '"', "'": "'", "`": "`", "(": ")", "[": "]", "{": "}" };
  let result = "";
  let index = 0;
  while (index < text.length) {
    const kind = absolutePathKind(text, index);
    if (!kind) {
      result += text[index];
      index += 1;
      continue;
    }

    const closing = wrappers[text[index - 1] ?? ""];
    let end = index;
    while (end < text.length) {
      const char = text[end];
      if (char === "\n" || char === "\r" || char === "\t") break;
      if (closing && char === closing) {
        if (punctuationBoundaryIsProven(text, end)) break;
        return undefined;
      }
      if (!closing && char === " ") {
        if (nextSpaceChunkHasSeparator(text, end, closing)) {
          end += 1;
          continue;
        }
        if (!basenameLooksComplete(text.slice(index, end))) return undefined;
        break;
      }
      if (!closing && /[\])}'"`]/.test(char)) {
        if (punctuationBoundaryIsProven(text, end)) break;
        return undefined;
      }
      if (!closing && /[,;!?]/.test(char) && (end + 1 === text.length || /\s/.test(text[end + 1]))) break;
      end += 1;
      if (end - index >= MAX_PATH_TOKEN_LENGTH) {
        while (end < text.length && !/[\n\r\t]/.test(text[end])) end += 1;
        break;
      }
    }
    const basename = safePathBasename(text.slice(index, end));
    result += basename ? `<path>/${basename}` : "<path>";
    index = Math.max(end, index + 1);
  }
  return result;
}

/** Secret-redact and path-scrub one diagnostic without ever returning raw text on failure. */
export function scrubDiagnostic(text: string, root: string): FieldValue {
  try {
    void root;
    // Order matters: remove complete URLs and credentials before their slashes or
    // punctuation can be mistaken for filesystem tokens. Each matcher is linear,
    // whitespace-bounded, and refuses to span prose or surrounding punctuation.
    let scrubbed = text.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, "[URL_REDACTED]");
    scrubbed = scrubbed.replace(/\bBearer[ \t]+[^\s,;'"<>()\[\]{}]+/gi, "Bearer [REDACTED]");
    const pathScrubbed = scrubAbsolutePaths(scrubbed);
    if (pathScrubbed === undefined) return { state: "withheld", reason: "ambiguous_path_boundary" };
    scrubbed = pathScrubbed;
    return { state: "collected", value: redactText(scrubbed).redactedText };
  } catch {
    return { state: "withheld", reason: "scrubbing_failed" };
  }
}

function boundedField(field: FieldValue): FieldValue {
  return field.state === "collected" ? { state: "collected", value: bounded(field.value) } : field;
}

function absent(reason: string): FieldValue {
  return { state: "not_collected", reason };
}

function diagnostic(value: string | undefined, root: string, reason: string): FieldValue {
  return value === undefined ? absent(reason) : boundedField(scrubDiagnostic(value, root));
}

function evidenceState(fields: FieldValue[]): FieldValue["state"] {
  if (fields.some((field) => field.state === "withheld")) return "withheld";
  if (fields.some((field) => field.state === "collected")) return "collected";
  if (fields.some((field) => field.state === "unavailable")) return "unavailable";
  return "not_collected";
}

function invocationCommand(command: string): string {
  return bounded(command.startsWith("foo ") ? command : `foo ${command}`);
}

function capsuleBase(
  version: string,
  command: string,
  occurredAt: Date,
  specContext: BugSpecContext | undefined,
): Pick<BugCapsule, "schema_version" | "capsule_id" | "occurred_at" | "producer" | "product" | "invocation" | "links" | "extensions"> {
  const boundedVersion = bounded(version);
  return {
    schema_version: "0.1",
    capsule_id: uuidV7(occurredAt.getTime()),
    occurred_at: occurredAt.toISOString(),
    producer: { name: "foo", version: boundedVersion },
    product: { name: "productfoo", component: "cli", version: boundedVersion },
    invocation: {
      command: invocationCommand(command),
      runtime: {
        node: bounded(process.version.replace(/^v/, "")),
        platform: bounded(process.platform),
        arch: bounded(process.arch),
      },
    },
    links: [],
    extensions: specContext ? { foo: { spec_context: specContext } } : {},
  };
}

export function captureFailureCapsule(
  root: string,
  input: FailureCaptureInput,
  now: Date = new Date(),
): LocalBugRecord | undefined {
  if (input.isTest || !pages(input.failure.errorClass)) return undefined;
  try {
    const message = diagnostic(input.failure.message, root, "failure did not provide a message");
    const stack = diagnostic(input.failure.stack, root, "failure did not provide a stack");
    const fingerprint = errorFingerprint(input.failure.errorCode, input.failure.stack);
    const capsule = parseBugCapsule({
      ...capsuleBase(input.version, input.command, now, input.specContext),
      failure: {
        class: input.failure.errorClass,
        code: input.failure.errorCode,
        classifier_version: "0.1",
        classification: input.failure.errorCode === "E_UNKNOWN" ? "fallback" : "known",
        message,
        stack,
      },
      report: {
        expected: absent("automatic failure capture"),
        actual: absent("automatic failure capture"),
        reproduction: absent("automatic failure capture"),
      },
      evidence: [{ kind: "diagnostic", state: evidenceState([message, stack]), content_type: "text/plain" }],
      similarity: {
        version: "0.1",
        signals: fingerprint ? [{ kind: "error_fingerprint", value: fingerprint }] : [],
      },
    });
    return savePending(root, capsule);
  } catch {
    return undefined;
  }
}

export type FailureCapsuleCapture = (
  root: string,
  input: FailureCaptureInput,
  now?: Date,
) => LocalBugRecord | undefined;

/** Create the once-only capture boundary owned by one main() invocation. */
export function createFailureCapsuleCapture(): FailureCapsuleCapture {
  let captured = false;
  return (root, input, now = new Date()) => {
    if (captured) return undefined;
    const record = captureFailureCapsule(root, input, now);
    if (record) captured = true;
    return record;
  };
}

export function captureManualCapsule(
  root: string,
  input: ManualCaptureInput,
  now: Date = new Date(),
): LocalBugRecord {
  if (!input.expected?.trim()) throw new UsageError("expected behavior is required", "E_BAD_FLAG");
  if (!input.actual?.trim()) throw new UsageError("actual behavior is required", "E_BAD_FLAG");

  const expected = boundedField(scrubDiagnostic(input.expected, root));
  const actual = boundedField(scrubDiagnostic(input.actual, root));
  const reproduction = input.reproduction?.trim()
    ? boundedField(scrubDiagnostic(input.reproduction, root))
    : absent("not provided");
  const capsule = parseBugCapsule({
    ...capsuleBase(input.version, input.command ?? "report add", now, input.specContext),
    failure: {
      class: "command_error",
      code: "E_UNKNOWN",
      classifier_version: "0.1",
      classification: "fallback",
      message: absent("manual report"),
      stack: absent("manual report"),
    },
    report: { expected, actual, reproduction },
    evidence: [{ kind: "user_report", state: evidenceState([expected, actual, reproduction]), content_type: "text/plain" }],
    similarity: { version: "0.1", signals: [] },
  });
  return savePending(root, capsule);
}
