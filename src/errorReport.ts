// Local diagnostic capture, review, and deletion. Reports never leave this machine.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureManualCapsule, scrubDiagnostic } from "./bugCapture.js";
import { canonicalBytes, payloadDigest, type BugCapsule, type DeliveryReceipt } from "./bugCapsule.js";
import {
  deleteLocalArchive,
  deletePending,
  getLocalBugRecord,
  getArchiveDeletionMarker,
  listLocalBugRecords,
  markPreviewed,
  type LocalBugRecord,
} from "./bugReportStore.js";
import { flagValue, hasFlag, readPackageVersion } from "./commands/shared.js";
import { surplusArgs } from "./cliArgs.js";
import { errorFingerprint, type FailureMark } from "./errorTaxonomy.js";
import { readJson } from "./jsonFile.js";

export function reportsDir(root: string): string {
  return path.join(root, ".foo", "reports");
}

export type ErrorReport = {
  schema_version: "0.1";
  id: string;
  timestamp: string;
  command: string;
  version: string;
  error_class: string;
  error_code: string;
  /**
   * Stable, content-free grouping key: hash(code + normalized origin frame). It lets the
   * digest collapse the same bug across testers and rank by blast radius, without the digest
   * ever having to touch the (redacted) message or stack.
   *
   * Absent when the failure carried no stack: there is no frame to fingerprint, and a report
   * with no fingerprint attaches to no bug rather than to every bug sharing its code.
   */
  fingerprint?: string;
  /** Redacted. The whole point of the report — and the reason it needs consent to move. */
  message: string;
  stack?: string;
};

/**
 * Scrub a report before it touches the disk. Two passes, because they catch different things.
 *
 * redactEngine finds SECRETS — tokens, keys, credentials. It does not touch paths, and an
 * error message is mostly paths: `EACCES: permission denied, open '/Users/taylor/work/...'`
 * would retain a person's name and private directory layout in the report. That is
 * not a secret by redactEngine's definition, and it is absolutely not ours to collect.
 *
 * So paths are anchored to placeholders first (longest prefix wins — the packet root is
 * usually inside the home directory), then secrets are redacted. The result still names the
 * FILE that failed, which is what makes the report debuggable; it just no longer names the
 * human it belongs to.
 */
function scrub(text: string, root: string): string {
  const result = scrubDiagnostic(text, root);
  return result.state === "collected" ? result.value : "[redaction failed — content withheld]";
}

/**
 * Write a report for a genuine failure. Callers gate on `pages(errorClass)`, so a typo or
 * a gate refusal never lands here — only something actually broken does.
 */
export function writeErrorReport(
  root: string,
  input: { failure: FailureMark; command: string; version: string },
  now: Date = new Date(),
): string | undefined {
  try {
    const dir = reportsDir(root);
    mkdirSync(dir, { recursive: true });
    const id = `err_${now.getTime().toString(36)}`;
    const fingerprint = errorFingerprint(input.failure.errorCode, input.failure.stack);
    const report: ErrorReport = {
      schema_version: "0.1",
      id,
      timestamp: now.toISOString(),
      command: input.command,
      version: input.version,
      error_class: input.failure.errorClass,
      error_code: input.failure.errorCode,
      // Derived from the raw stack (a basename + function name, never a path) before it is
      // scrubbed — the fingerprint carries no content, so it is safe to compute here. Omitted
      // entirely when there is no stack, rather than sent as a shared no-stack constant.
      ...(fingerprint ? { fingerprint } : {}),
      message: scrub(input.failure.message ?? "", root),
      ...(input.failure.stack ? { stack: scrub(input.failure.stack, root) } : {}),
    };
    const file = path.join(dir, `${id}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
  } catch {
    // A failure to record a failure must never become a second failure.
    return undefined;
  }
}

export function pendingReports(root: string): ErrorReport[] {
  const dir = reportsDir(root);
  if (!existsSync(dir)) return [];
  const out: ErrorReport[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(readJson<ErrorReport>(path.join(dir, name)));
    } catch {
      // A corrupt report is not worth failing over.
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export type ReportInvocationMode = "interactive" | "json" | "agent" | "noninteractive";

export type ReportFinalizationDeps = {
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  now?: () => Date;
  question?: (prompt: string) => Promise<string>;
  onPrompt?: () => void;
  onConsentAction?: () => void;
  /** Retained for invocation compatibility; reporting never reads credentials. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Opaque ownership token for one top-level CLI invocation. The token, rather than module
 * state, keeps overlapping `main()` calls from consuming each other's capsule identity.
 */
export type ReportRunContext = { readonly _reportRunContext: "foo-report-run" };
const reportRunStates = new WeakMap<ReportRunContext, { capsuleId?: string }>();

export function createReportRunContext(): ReportRunContext {
  const run = Object.freeze({ _reportRunContext: "foo-report-run" as const });
  reportRunStates.set(run, {});
  return run;
}

function reportRunState(run: ReportRunContext): { capsuleId?: string } {
  const state = reportRunStates.get(run);
  if (!state) throw new Error("unknown report run context");
  return state;
}

export function noteCapsuleFromThisRun(run: ReportRunContext, capsuleId: string): void {
  // One top-level invocation may create at most one automatic capsule. Keep the first
  // identity even if a caller accidentally reports another one: falling through to a later
  // pending record would make the notice describe something other than the failure
  // that caused this invocation's capture.
  const state = reportRunState(run);
  state.capsuleId ??= capsuleId;
}

/** Compatibility name: announces this invocation's local capture, without asking to send. */
export async function askToSendReports(
  root: string,
  run: ReportRunContext,
  io: ReportFinalizationDeps & { mode: ReportInvocationMode },
): Promise<void> {
  try {
    const state = reportRunState(run);
    const capsuleId = state.capsuleId;
    state.capsuleId = undefined;
    if (!capsuleId || getLocalBugRecord(root, capsuleId)?.state !== "pending") return;
    (io.stderr ?? process.stderr).write(`foo saved Bug Capsule ${capsuleId} locally; nothing was sent. Review it with \`foo report show ${capsuleId}\`.\n`);
  } catch {
    // Reporting a failure must never become a second failure.
  }
}

export type ReportCommandResult = {
  schema_version: "0.1";
  status: "ready" | "accepted" | "kept_local" | "deleted" | "empty" | "selection_required" | "refused" | "retryable";
  capsule_id: string | null;
  payload_digest: string | null;
  destination: string | null;
  payload: BugCapsule | null;
  receipt: DeliveryReceipt | null;
  error: null | { code: string; message: string; retry_after?: string };
  handoff: { required: boolean; reason: string | null; command: string | null };
  next_actions: string[];
  /** Non-fatal problems the human must see at capture time, e.g. a field the scrubber withheld. */
  warnings: string[];
};

export type ReportCommandDeps = {
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  now?: () => Date;
  version?: string;
  onPrompt?: () => void;
  onConsentAction?: () => void;
  question?: (prompt: string) => Promise<string>;
};

export type ReportCommandRun = {
  result: ReportCommandResult;
  output: string;
  exitCode: 0 | 1 | 2 | 3;
  status: ReportCommandResult["status"];
  prompt_count: number;
  consent_actions: number;
};

function commandResult(
  status: ReportCommandResult["status"],
  destination: string | null,
  values: Partial<Omit<ReportCommandResult, "schema_version" | "status" | "destination">> = {},
): ReportCommandResult {
  return {
    schema_version: "0.1", status,
    capsule_id: values.capsule_id ?? null,
    payload_digest: values.payload_digest ?? null,
    destination,
    payload: values.payload ?? null,
    receipt: values.receipt ?? null,
    error: values.error ?? null,
    handoff: values.handoff ?? { required: false, reason: null, command: null },
    next_actions: values.next_actions ?? [],
    warnings: values.warnings ?? [],
  };
}

function refusal(destination: string | null, code: string, message: string, values: Partial<ReportCommandResult> = {}): ReportCommandResult {
  return commandResult("refused", destination, { ...values, payload: null, error: { code, message } });
}

function reportExitCode(value: ReportCommandResult): 0 | 1 | 2 | 3 {
  if (value.status === "selection_required") return 2;
  if (value.status === "retryable") return 3;
  if (value.status === "refused") return 1;
  return 0;
}

export function renderReportCommandResult(value: ReportCommandResult): string {
  const warningLines = value.warnings.map((warning) => `WARNING: ${warning}`);
  if (value.status === "ready" && value.payload) {
    return [
      `Bug Capsule ${value.capsule_id}`,
      ...(value.receipt
        ? ["Storage: local archive on this machine", `Historical delivery: ${value.receipt.destination} at ${value.receipt.accepted_at}. Current remote retention is unknown.`]
        : ["Storage: this machine only"]),
      `Payload digest: ${value.payload_digest}`,
      "Scrubbing claim: secret-redacted and path-scrubbed",
      ...warningLines,
      "Canonical local payload:",
      canonicalBytes(value.payload).toString("utf8"),
      ...value.next_actions,
      "",
    ].join("\n");
  }
  if (value.status === "ready") {
    return [`Bug Capsule ${value.capsule_id} saved locally.`, ...warningLines, ...value.next_actions, ""].join("\n");
  }
  if (value.status === "empty") return "No Bug Capsules are waiting locally.\n";
  if (value.status === "selection_required") return `Choose one Bug Capsule:\n${value.next_actions.join("\n")}\n`;
  if (value.status === "accepted") return `Bug Capsule ${value.capsule_id} was accepted by ${value.destination}. Receipt ${value.receipt?.receipt_id}.\n`;
  if (value.status === "deleted") return [`Bug Capsule ${value.capsule_id} was deleted locally. No remote deletion was requested.`, ...warningLines, ""].join("\n");
  if (value.status === "kept_local") return `Bug Capsule ${value.capsule_id} stays on this machine.\n`;
  const message = value.status === "retryable"
    ? value.error?.message ?? "Local report cleanup must be retried."
    : value.error?.message ?? "The report command was refused.";
  return `${message}${value.next_actions.length ? `\n${value.next_actions.join("\n")}` : ""}\n`;
}

function resumeCommand(action: "delete", id: string, digest: string, json: boolean): string {
  return `foo report ${action} ${id} --approve ${digest}${json ? " --json" : ""}`;
}

function flagsAreExact(args: string[], valueFlags: readonly string[], booleanFlags: readonly string[]): boolean {
  const valueSet = new Set(valueFlags);
  const booleanSet = new Set(booleanFlags);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (valueSet.has(token)) {
      if (seen.has(token)) return false;
      seen.add(token);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return false;
      index += 1;
      continue;
    }
    if (booleanSet.has(token)) {
      if (seen.has(token)) return false;
      seen.add(token);
    }
  }
  return true;
}

async function approveIdentity(
  action: "delete",
  identity: { capsule_id: string; payload_digest: string },
  args: string[],
  json: boolean,
  deps: ReportCommandDeps,
): Promise<{ approved: boolean; prompted: number; supplied: boolean }> {
  const suppliedValue = flagValue(args, "--approve");
  if (suppliedValue !== undefined) return { approved: suppliedValue === identity.payload_digest, prompted: 0, supplied: true };
  const stdin = deps.stdin ?? process.stdin;
  const stderr = deps.stderr ?? process.stderr;
  if (json || !stdin.isTTY || !stderr.isTTY) return { approved: false, prompted: 0, supplied: false };
  if (deps.question) {
    deps.onPrompt?.();
    const answer = (await deps.question(`Delete local Bug Capsule ${identity.capsule_id}? [y/N] `)).trim().toLowerCase();
    return { approved: answer === "y" || answer === "yes", prompted: 1, supplied: false };
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: stdin, output: stderr });
  try {
    deps.onPrompt?.();
    const answer = (await rl.question(`Delete local Bug Capsule ${identity.capsule_id}? [y/N] `)).trim().toLowerCase();
    return { approved: answer === "y" || answer === "yes", prompted: 1, supplied: false };
  } finally { rl.close(); }
}

export async function runReportCommand(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: ReportCommandDeps = {},
): Promise<ReportCommandRun> {
  const json = hasFlag(args, "--json");
  const destination = null;
  let promptCount = 0;
  let consentActions = 0;
  const finish = (value: ReportCommandResult): ReportCommandRun => ({
    result: value,
    output: json ? `${JSON.stringify(value)}\n` : renderReportCommandResult(value),
    exitCode: reportExitCode(value), status: value.status,
    prompt_count: promptCount, consent_actions: consentActions,
  });

  const sub = args[0] ?? "show";
  if (!new Set(["add", "show", "send", "delete"]).has(sub)) {
    return finish(refusal(destination, "E_REPORT_ARGS", "usage: foo report add|show|delete"));
  }

  if (sub === "send") {
    return finish(refusal(destination, "E_REPORT_SEND_REMOVED", "Report sending has been removed. Reports stay on this machine; use foo report show to review them."));
  }

  const valueFlags = sub === "add" ? ["--expected", "--actual", "--reproduction"] : sub === "show" ? [] : ["--approve"];
  if (!flagsAreExact(args.slice(1), valueFlags, ["--json"])) {
    return finish(refusal(destination, "E_REPORT_ARGS", `invalid report ${sub} arguments`));
  }

  if (sub === "add") {
    const surplus = surplusArgs(args.slice(1), { value: ["--expected", "--actual", "--reproduction"], boolean: ["--json"] });
    if (surplus.length) return finish(refusal(destination, "E_REPORT_ARGS", "invalid report add arguments"));
    let expected = flagValue(args, "--expected")?.trim();
    let actual = flagValue(args, "--actual")?.trim();
    const reproduction = flagValue(args, "--reproduction")?.trim();
    const stdin = deps.stdin ?? process.stdin;
    const stderr = deps.stderr ?? process.stderr;
    if ((!expected || !actual) && !json && stdin.isTTY && stderr.isTTY) {
      if (deps.question) {
        if (!expected) { deps.onPrompt?.(); promptCount += 1; expected = (await deps.question("Expected behavior: ")).trim(); }
        if (!actual) { deps.onPrompt?.(); promptCount += 1; actual = (await deps.question("Actual behavior: ")).trim(); }
      } else {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: stdin, output: stderr });
        try {
          if (!expected) { deps.onPrompt?.(); promptCount += 1; expected = (await rl.question("Expected behavior: ")).trim(); }
          if (!actual) { deps.onPrompt?.(); promptCount += 1; actual = (await rl.question("Actual behavior: ")).trim(); }
        } finally { rl.close(); }
      }
    }
    if (!expected || !actual) {
      const command = "foo report add";
      return finish(refusal(destination, "E_REPORT_INCOMPLETE", "expected and actual behavior are required", {
        handoff: { required: true, reason: "missing_required_fields", command },
        next_actions: ["Run `foo report add` in an interactive terminal to enter the missing fields safely."],
      }));
    }
    try {
      const saved = captureManualCapsule(root, { expected, actual, ...(reproduction ? { reproduction } : {}), command: "report add", version: deps.version ?? readPackageVersion(root) }, deps.now?.() ?? new Date());
      const withheld = ([
        ["expected", saved.capsule.report.expected],
        ["actual", saved.capsule.report.actual],
        ["reproduction", saved.capsule.report.reproduction],
      ] as const).filter(([, field]) => field?.state === "withheld");
      return finish(commandResult("ready", destination, {
        capsule_id: saved.capsule.capsule_id, payload_digest: saved.payload_digest,
        warnings: withheld.map(([name, field]) =>
          `your ${name} text was WITHHELD from the capsule (${(field as { reason?: string }).reason ?? "scrubbing_failed"}) — it contains something productfoo could not safely scrub, usually a file path. Reword the ${name} without paths and run foo report add again.`),
        next_actions: [`foo report show ${saved.capsule.capsule_id}${json ? " --json" : ""}`],
      }));
    } catch { return finish(refusal(destination, "E_REPORT_CAPTURE", "Bug Capsule could not be saved locally")); }
  }

  const positional = surplusArgs(args.slice(1), { value: sub === "show" ? [] : ["--approve"], boolean: ["--json"] });
  if (positional.length > 1 || (sub !== "show" && positional.length !== 1)) {
    return finish(refusal(destination, "E_REPORT_ARGS", `invalid report ${sub} arguments`));
  }
  let id = positional[0];
  if (sub === "show" && !id) {
    const pending = listLocalBugRecords(root).records.filter((entry) => entry.state === "pending");
    if (pending.length === 0) return finish(commandResult("empty", destination));
    if (pending.length > 1) return finish(commandResult("selection_required", destination, {
      error: { code: "E_REPORT_SELECTION_REQUIRED", message: "choose one pending Bug Capsule" },
      handoff: { required: true, reason: "multiple_pending", command: null },
      next_actions: pending.map((entry) => `foo report show ${entry.capsule_id}${json ? " --json" : ""}`),
    }));
    id = pending[0].capsule_id;
  }

  if (sub === "delete" && id) {
    let confirmation;
    try { confirmation = getArchiveDeletionMarker(root, id); }
    catch { return finish(refusal(destination, "E_REPORT_CORRUPT", "Bug Capsule deletion confirmation is unknown or corrupt", { capsule_id: id })); }
    if (confirmation !== null) {
      const digest = confirmation.payload_digest;
      const approved = await approveIdentity("delete", { capsule_id: id, payload_digest: digest }, args, json, deps);
      promptCount += approved.prompted;
      if (!approved.approved) {
        if (approved.supplied) return finish(refusal(destination, "E_REPORT_DIGEST_MISMATCH", "approval digest does not match the reviewed payload", { capsule_id: id, payload_digest: digest }));
        if (approved.prompted) return finish(commandResult("kept_local", destination, { capsule_id: id, payload_digest: digest, next_actions: [resumeCommand("delete", id, digest, false)] }));
        const command = resumeCommand("delete", id, digest, json);
        return finish(refusal(destination, "E_REPORT_APPROVAL_REQUIRED", "exact payload approval is required", {
          capsule_id: id, payload_digest: digest,
          handoff: { required: true, reason: "approval_required", command }, next_actions: [command],
        }));
      }
      consentActions += 1;
      deps.onConsentAction?.();
      try { deleteLocalArchive(root, id, digest); }
      catch { return finish(commandResult("retryable", destination, { capsule_id: id, payload_digest: digest, error: { code: "E_REPORT_DELETE_ARCHIVE", message: "local archive cleanup must be retried" }, next_actions: [resumeCommand("delete", id, digest, json)] })); }
      return finish(commandResult("deleted", destination, { capsule_id: id, payload_digest: digest }));
    }
  }

  let record: LocalBugRecord | null;
  try { record = id ? getLocalBugRecord(root, id) : null; }
  catch { return finish(refusal(destination, "E_REPORT_CORRUPT", "Bug Capsule is unknown or corrupt", { capsule_id: id ?? null })); }
  if (!record) return finish(refusal(destination, "E_REPORT_NOT_FOUND", "Bug Capsule was not found", { capsule_id: id ?? null }));
  const digest = payloadDigest(record.capsule);
  if (digest !== record.payload_digest) return finish(refusal(destination, "E_REPORT_DIGEST_CHANGED", "Bug Capsule digest changed", { capsule_id: id!, payload_digest: digest }));

  if (sub === "show") {
    const preview = commandResult("ready", destination, {
      capsule_id: id!, payload_digest: digest, payload: record.capsule,
      receipt: record.receipt,
      next_actions: [],
    });
    try {
      if (json) JSON.stringify(preview); else renderReportCommandResult(preview);
      if (record.state === "pending") markPreviewed(root, id!, digest, "local", (deps.now?.() ?? new Date()).toISOString());
    } catch { return finish(refusal(destination, "E_REPORT_PREVIEW_STORE", "preview snapshot could not be saved", { capsule_id: id!, payload_digest: digest })); }
    return finish(preview);
  }

  if (hasFlag(args, "--approve") && flagValue(args, "--approve") === undefined) {
    return finish(refusal(destination, "E_REPORT_ARGS", "--approve requires a payload digest", { capsule_id: id!, payload_digest: digest }));
  }
  if (sub === "delete" && record.state === "pending" && record.preview?.payload_digest !== digest) {
    const command = `foo report show ${id}${json ? " --json" : ""}`;
    return finish(refusal(destination, "E_REPORT_PREVIEW_REQUIRED", "show this exact Bug Capsule before deleting", {
      capsule_id: id!, payload_digest: digest,
      handoff: { required: true, reason: "preview_required", command }, next_actions: [command],
    }));
  }
  const action = "delete";
  const approved = await approveIdentity(action, {
    capsule_id: record.capsule.capsule_id,
    payload_digest: record.payload_digest,
  }, args, json, deps);
  promptCount += approved.prompted;
  if (!approved.approved) {
    if (approved.supplied) return finish(refusal(destination, "E_REPORT_DIGEST_MISMATCH", "approval digest does not match the reviewed payload", { capsule_id: id!, payload_digest: digest, receipt: record.receipt }));
    if (approved.prompted) return finish(commandResult("kept_local", destination, { capsule_id: id!, payload_digest: digest, receipt: record.receipt, next_actions: [resumeCommand(action, id!, digest, false)] }));
    const command = resumeCommand(action, id!, digest, json);
    return finish(refusal(destination, "E_REPORT_APPROVAL_REQUIRED", "exact payload approval is required", {
      capsule_id: id!, payload_digest: digest, receipt: record.receipt,
      handoff: { required: true, reason: "approval_required", command }, next_actions: [command],
    }));
  }

  consentActions += 1;
  deps.onConsentAction?.();
  if (record.state === "pending") {
    try { deletePending(root, id!); return finish(commandResult("deleted", destination, { capsule_id: id!, payload_digest: digest })); }
    catch { return finish(refusal(destination, "E_REPORT_DELETE_FAILED", "pending Bug Capsule could not be deleted safely", { capsule_id: id!, payload_digest: digest })); }
  }
  try { deleteLocalArchive(root, id!, digest); }
  catch { return finish(commandResult("retryable", destination, { capsule_id: id!, payload_digest: digest, receipt: record.receipt, error: { code: "E_REPORT_DELETE_ARCHIVE", message: "local archive cleanup must be retried" }, next_actions: [resumeCommand("delete", id!, digest, json)] })); }
  return finish(commandResult("deleted", destination, { capsule_id: id!, payload_digest: digest }));
}
