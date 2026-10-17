// `foo asp <command>`: the packet-contract dispatch body — validate, reconcile
// (including --source github:), verify, status, index, init, event, task, and
// verdict — plus the per-packet compiled-module loading it prefers in
// transition. cli.ts parses the domain/command tokens and delegates here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "../vendorYaml.js";
import { derivePacketStatus, renderAspStatus } from "../packetStatus.js";
import { costHeadline } from "./loop.js";
import { runAspIndex } from "../packetIndex.js";
import { serveIndex, DEFAULT_SERVE_PORT } from "../packetIndexServe.js";
import { isPacketValidationError, validatePacket as validatePacketGeneric } from "../packetValidation.js";
import { lintAnchors, migrateSpecText } from "../specSections.js";
import { parseReconcileArgs, reconcilePacket as reconcilePacketGeneric } from "../packetReconcile.js";
import { verifyPacket, renderVerifyReport, VERIFY_EVENT_TYPE } from "../packetVerify.js";
import { appendEvent, initPacket, updateTask } from "../packetWrite.js";
import { isTerminal, recordVerdict, VERDICT_STATES, type VerdictState } from "../packetLifecycle.js";
import { glyphsEnabled } from "../statusGlyphs.js";
import { loadLoopContracts } from "../loopContracts.js";
import { estimateLoopBudget, handshakeFloorUsd, hasExternalSources, loadPricing } from "../loopBudget.js";
import {
  appendIntegrationRecord,
  approvalStates,
  type GithubFixture,
  githubSelectionReport,
  githubSourceId,
  parseGithubSource,
  sourceKey,
} from "../sourceIngress.js";
import {
  type DoneWhenCriterion,
  reconcilePrProof,
  recordGithubConflicts,
  renderGithubReceipt,
} from "../githubReconcile.js";
import { classifyThrown, markFailure, UsageError } from "../errorTaxonomy.js";
import { failThrown, failWith, flagValue, hasFlag, resolvePacketDir } from "./shared.js";
import { surplusArgs } from "../cliArgs.js";
import { readJson } from "../jsonFile.js";
import { ASP_USAGE_LINES } from "../commandUsage.js";

export function aspUsage(): string {
  return [
    "foo asp — the packet contract: scaffold it, check it, and record what happened.",
    "",
    ...ASP_USAGE_LINES,
    "",
    "The local event log appends through `foo asp event` without rewriting prior lines.",
    "It is not an independently append-only or tamper-proof guarantee; the command refuses unknown input rather than guess.",
    "",
  ].join("\n");
}

// The flags `foo asp event` actually has. Anything else in its argv is surplus.
const EVENT_VALUE_FLAGS = ["--subject", "--data", "--summary"] as const;

type PacketCommandModule = {
  validatePacket?: (context: PacketContext) => Promise<string> | string;
  reconcilePacket?: (context: PacketContext & { args: string[] }) => Promise<unknown> | unknown;
};

export type PacketContext = {
  root: string;
  packetDir: string;
  packetArg: string;
};

async function loadPacketCommand(root: string, packetArg: string, command: string): Promise<PacketCommandModule | null> {
  const modulePath = path.join(root, "dist", packetArg, `${command}.js`);
  if (!existsSync(modulePath)) return null;

  return import(pathToFileURL(modulePath).href) as Promise<PacketCommandModule>;
}

function readPacketSpecId(packetDir: string): string {
  try {
    const m = readFileSync(path.join(packetDir, "tasks.yaml"), "utf8").match(/^spec_id:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {
    // fall through to a slug-derived guess
  }
  return path.basename(packetDir).replace(/-/g, "_");
}

// Read the packet's done_when criteria (with any check predicates) from tasks.yaml
// (github-integration-v0 T-006). The agreed criteria are the verdict's left side;
// GitHub evidence is the right side.
function readDoneWhenCriteria(packetDir: string): DoneWhenCriterion[] {
  try {
    const doc = parseYaml(readFileSync(path.join(packetDir, "tasks.yaml"), "utf8")) as {
      tasks?: Array<{ done_when?: Array<{ id?: string; text?: string; check?: DoneWhenCriterion["check"] }> }>;
    };
    const out: DoneWhenCriterion[] = [];
    for (const task of doc.tasks ?? []) {
      for (const c of task.done_when ?? []) {
        if (c.id) out.push({ id: c.id, text: c.text, check: c.check });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// foo asp reconcile <packet> --source github:<url> (github-integration-v0 T-002):
// admit a per-PR/per-repo GitHub selection through the substrate gate and report
// its identity, approval, and packet-linkage. No new command (rides reconcile);
// the done_when verdict is T-003. The standalone CLI has no live MCP, so evidence
// arrives via --source-fixture (errors-as-DX hands off when it is missing).
function runGithubSourceReconcile(root: string, packetDir: string, args: string[]): { code: number; out: string } {
  const json = args.includes("--json");
  const source = flagValue(args, "--source") ?? "";
  if (!source.startsWith("github:")) {
    return { code: 1, out: `--source '${source}' is not supported on asp reconcile; V0 admits only github:<pr-or-repo-url>\n` };
  }
  let selection: ReturnType<typeof parseGithubSource>;
  try {
    selection = parseGithubSource(source);
  } catch (error) {
    return { code: 1, out: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  const id = githubSourceId(selection);
  const rel = path.relative(root, packetDir) || packetDir;
  const resume = `foo asp reconcile ${rel} --source ${source} --source-fixture <file.json>`;
  const approvalState = approvalStates(packetDir).get(sourceKey(id))?.state ?? "excluded";
  if (approvalState !== "approved") {
    // Approval is blocking for use; never auto-approve (Contracts approval-state).
    return {
      code: 1,
      out:
        `GitHub source ${selection.connection_id} (${selection.external_id}) is ${approvalState} for this packet — connection is not approval.\n` +
        `Approve it, then re-run:\n` +
        `  foo source approve ${rel} --provider github --connection ${selection.connection_id} --external-id ${selection.external_id} --scope ${selection.external_id} --by <you>\n` +
        `  ${resume}\n`,
    };
  }
  const fixturePath = flagValue(args, "--source-fixture");
  if (!fixturePath) {
    return { code: 1, out: `no GitHub evidence for ${selection.url}. The CLI has no live GitHub MCP — supply it with --source-fixture <file.json>, then re-run:\n  ${resume}\n` };
  }
  let fixture: GithubFixture;
  try {
    fixture = readJson<GithubFixture>(path.resolve(root, fixturePath));
  } catch {
    return { code: 1, out: `--source-fixture is not readable JSON: ${fixturePath}\n` };
  }
  const at = new Date().toISOString();
  const specId = readPacketSpecId(packetDir);

  // Per-PR selection -> the full done_when verdict + dual-reader receipt (T-006).
  if (selection.unit === "pr") {
    // One shared engine for both reconcile entry points (reconcile-anywhere-v0
    // T-001 / D-001): asp reconcile delegates the verdict + receipt here.
    const { result, receipt } = reconcilePrProof({
      packet: path.basename(packetDir),
      sourceId: id,
      fixture,
      specId,
      criteria: readDoneWhenCriteria(packetDir),
      observedAt: at,
    });
    recordGithubConflicts(packetDir, id, result, at);
    // Local-only, gitignored persistence; foo posts nothing to GitHub (R-007/R-008).
    appendIntegrationRecord(packetDir, { kind: "github_receipt", ...receipt });
    if (json) return { code: 0, out: `${JSON.stringify(receipt, null, 2)}\n` };
    return { code: 0, out: `${renderGithubReceipt(receipt)}\nReceipt is local-only — paste the block above into the PR yourself; foo posts nothing.\n` };
  }

  // Per-repo selection -> the packet-linkage selection report (T-002); run per-PR for a verdict.
  const report = githubSelectionReport({ packet: path.basename(packetDir), selection, approvalState, specId, fixture });
  if (json) return { code: 0, out: `${JSON.stringify(report, null, 2)}\n` };
  const linkedList = report.linked.length ? ` — ${report.linked.map((l) => l.external_id).join(", ")}` : "";
  const out = [
    `GitHub source reconcile · ${report.packet}`,
    `  selection: ${selection.unit} ${selection.connection_id} (${selection.external_id}) — approved`,
    `  packet-linked PRs: ${report.linked.length}${linkedList}`,
    ...(report.unlinked_excluded ? [`  excluded (not packet-linked): ${report.unlinked_excluded}`] : []),
    `  ${report.note}`,
    "",
  ].join("\n");
  return { code: 0, out };
}

// Proofs-complete nudge (packet-lifecycle-truth-v0 R-003): when reconcile runs
// on a packet whose derived truth is done but whose header is still non-terminal,
// print the done-verdict suggestion. A printed signal on stderr, never an
// automatic restamp (signals-over-gates-v0) — and never on stdout, where it
// would corrupt the JSON report a pipe is parsing.
function suggestDoneVerdict(root: string, packetDir: string): void {
  try {
    const status = derivePacketStatus(packetDir);
    if (status.lifecycle_effective !== "done" || isTerminal(status.lifecycle_stored)) return;
    const rel = path.relative(root, packetDir).split(path.sep).join("/");
    process.stderr.write(
      `[signal] ${rel} is proofs-complete but lifecycle reads '${status.lifecycle_stored ?? "unset"}' — ` +
        `record the completion: foo asp verdict ${rel} done --reason "<why it is done>" (a suggestion, never automatic)\n`,
    );
  } catch {
    // Advisory only — a failed derivation must never break reconcile itself.
  }
}

export async function runAspCommand(
  root: string,
  command: string,
  packetArg: string | undefined,
  args: string[],
  domainArgs: string[],
): Promise<number> {
  // Answer --help before anything else runs (alpha_tester_fixes_v0 R-001).
  //
  // asp used to take "whatever the first token is" as the subcommand and, inside
  // `event`, as the event type — before any flag was parsed. So `foo asp --help`
  // died with "packet-dir missing", and `foo asp event <packet> --help` appended
  // a literal {"type":"--help"} to the local event log. The `self` domain got
  // this branch (cli.ts); asp never did. Nothing may be written on the way to
  // working out what was asked.
  if (command === "help" || hasFlag(domainArgs, "--help") || hasFlag(domainArgs, "-h")) {
    process.stdout.write(aspUsage());
    return 0;
  }

  // Cross-packet index (packet_index_v0): takes no packet-dir argument.
  if (command === "index") {
    try {
      const indexArgs = domainArgs.slice(1);
      // Live mode: serve the index over localhost, re-rendered per request, with
      // reload-on-change. Long-running until ctrl-c (bin/foo sets exitCode, never
      // process.exit, so the listening server keeps the process alive).
      if (indexArgs.includes("--serve")) {
        const portIdx = indexArgs.indexOf("--port");
        const portRaw = portIdx !== -1 ? indexArgs[portIdx + 1] : undefined;
        const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : DEFAULT_SERVE_PORT;
        const server = serveIndex(root, { port });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.once("listening", () => {
            process.stdout.write(
              `foo live spec dashboard\n  root: ${root}\n  url:  http://localhost:${port}/\n  reloads on spec-state change · ctrl-c to stop\n`,
            );
          });
          server.once("close", () => resolve());
        });
        return 0;
      }
      const htmlIdx = indexArgs.indexOf("--html");
      const html = htmlIdx !== -1;
      const maybePath = html ? indexArgs[htmlIdx + 1] : undefined;
      const htmlPath = maybePath && !maybePath.startsWith("--") ? maybePath : undefined;
      // Drift glyphs on the text index ride the same human-only gate as status
      // (statusGlyphs R-008): interactive TTY only, never --json or a pipe.
      const glyphs = glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args: indexArgs });
      process.stdout.write(runAspIndex(root, { json: indexArgs.includes("--json"), html, htmlPath, glyphs }));
      return 0;
    } catch (error) {
      // A throw here is a real defect, not a typo — classify it so it pages and so the
      // message + stack reach the local log instead of vanishing into a bare exit 1.
      markFailure(classifyThrown(error));
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // Scaffold (asp-cli-lifecycle-v0 T-003): the packet dir does not exist yet, so
  // this runs before packet resolution.
  if (command === "init") {
    try {
      if (!packetArg) return failWith("packet name missing");
      const result = initPacket({ root: root, name: packetArg });
      const rel = path.relative(root, result.packetDir).split(path.sep).join("/");
      process.stdout.write(
        `scaffolded ${rel} (spec_id ${result.specId})\n` +
          `Next: foo asp validate ${rel}\n`,
      );
      return 0;
    } catch (error) {
      return failThrown(error);
    }
  }

  const packet = (() => {
    try {
      return resolvePacketDir(root, packetArg);
    } catch (error) {
      return null;
    }
  })();
  // Two different failures wear the same shape here. No arg is a typo (`foo asp status`
  // — two of the four errors on the owner's dashboard were exactly this). A named packet
  // that does not exist is a real not-found. Only the second is a fact about the repo.
  if (!packet) {
    return packetArg
      ? failWith(`packet directory not found: ${packetArg}`, { errorClass: "not_found", errorCode: "E_PACKET_NOT_FOUND" })
      : failWith("packet-dir missing", { errorCode: "E_PACKET_DIR_MISSING" });
  }

  // Local event-log write (T-004): foo asp event <packet> <type> [flags].
  if (command === "event") {
    try {
      const [type, ...eventArgs] = args;
      if (!type) return failWith("event type missing");
      // A flag is not an event type. Without this, `--anything` became the type
      // and went straight into the ledger (alpha_tester_fixes_v0 R-001).
      if (type.startsWith("-")) {
        return failWith(
          `event type missing — \`${type}\` is a flag, not an event type.\n` +
            `Nothing was written. Try: foo asp event ${packetArg ?? "<packet-dir>"} <type> --summary "<text>"`,
        );
      }
      // Refuse what we did not read. `foo asp event <packet> <type> <summary>`
      // used to drop the bare summary on the floor and commit `data: {}`. For an
      // local event log, refusing loudly is the only safe default — a wrong
      // entry cannot be removed, so productfoo never guesses at one.
      const surplus = surplusArgs(eventArgs, { value: EVENT_VALUE_FLAGS });
      if (surplus.length > 0) {
        const first = surplus[0];
        const problem = first.startsWith("-")
          ? `unknown flag: ${first}`
          : `unexpected argument: ${first} — did you mean --summary "${first}"?`;
        return failWith(
          `${problem}\nNothing was written. The local event log is not rewritten, so productfoo refuses rather than guess.`,
        );
      }
      const subject = flagValue(eventArgs, "--subject");
      const dataRaw = flagValue(eventArgs, "--data");
      const summary = flagValue(eventArgs, "--summary");
      let data: Record<string, unknown> = {};
      if (dataRaw) {
        // Malformed --data is the caller's typo, not productfoo's bug: convert the raw
        // SyntaxError to a UsageError so it exits as a usage error and files no
        // Bug Capsule (#778).
        let parsedData: unknown;
        try {
          parsedData = JSON.parse(dataRaw);
        } catch (error) {
          throw new UsageError(`--data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, "E_BAD_FLAG");
        }
        if (!parsedData || typeof parsedData !== "object" || Array.isArray(parsedData)) {
          return failWith("--data must be a JSON object");
        }
        data = parsedData as Record<string, unknown>;
      }
      if (summary && !("summary" in data)) data.summary = summary;
      const event = appendEvent({ packetDir: packet.packetDir, type, subject, data });
      process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
      return 0;
    } catch (error) {
      return failThrown(error);
    }
  }

  // Lifecycle verdict (packet-lifecycle-v0): foo asp verdict <packet> <state> --reason <text>.
  // parked/killed retire the packet; done completes it (packet-lifecycle-truth-v0
  // R-003); active reopens it. The reason is mandatory — the whole point is that
  // every terminal transition gets a recorded rationale, not silence.
  if (command === "verdict") {
    try {
      const [state, ...verdictArgs] = args;
      if (!state) return failWith(`verdict state missing (expected ${VERDICT_STATES.join(" | ")})`);
      if (!VERDICT_STATES.includes(state as VerdictState)) {
        return failWith(`invalid verdict state: ${state} (expected ${VERDICT_STATES.join(" | ")})`);
      }
      const reason = flagValue(verdictArgs, "--reason");
      if (!reason) return failWith("--reason is required: record why, not just that");
      // A done verdict must be backed by the derived truth (R-003): every task
      // done and every done_when check proven. A human can still overrule the
      // derivation with --force — the event trail then records that they did.
      if (state === "done" && !hasFlag(verdictArgs, "--force")) {
        const status = derivePacketStatus(packet.packetDir);
        if (status.lifecycle_effective !== "done") {
          const open = status.tasks.total - status.tasks.done - status.tasks.dropped;
          return failWith(
            `refusing 'done': packet is not effectively done — ${open} task(s) still open and ` +
              `${status.proof.checks_done} of ${status.proof.checks_total} done_when checks are done (a done verdict needs every check done with a proof). ` +
              `Finish and prove the work, or overrule the derivation with --force.`,
          );
        }
      }
      const result = recordVerdict({ packetDir: packet.packetDir, state: state as VerdictState, reason });
      const rel = path.relative(root, packet.packetDir).split(path.sep).join("/");
      process.stdout.write(
        `${rel}: lifecycle ${result.from ?? "(unset)"} -> ${result.to} (event ${result.event.id})\n` +
          `Next: foo asp status ${rel}\n`,
      );
      return 0;
    } catch (error) {
      return failThrown(error);
    }
  }

  // Task status write (T-004): foo asp task <packet> <id> --status <s> [flags].
  if (command === "task") {
    try {
      const [taskId, ...taskArgs] = args;
      if (!taskId) return failWith("task id missing");
      const status = flagValue(taskArgs, "--status");
      if (!status) return failWith("--status is required");
      const needsRaw = flagValue(taskArgs, "--needs");
      const result = updateTask({
        packetDir: packet.packetDir,
        taskId,
        status,
        proof: flagValue(taskArgs, "--proof"),
        summary: flagValue(taskArgs, "--summary"),
        reason: flagValue(taskArgs, "--reason"),
        needs: needsRaw ? needsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      const rel = path.relative(root, packet.packetDir).split(path.sep).join("/");
      process.stdout.write(
        `${taskId}: ${result.from} -> ${result.to} (event ${result.event.id})\n` +
          `Next: foo asp status ${rel}\n`,
      );
      return 0;
    } catch (error) {
      return failThrown(error);
    }
  }

  // Derived status (R-019): generic over any packet, computed from tasks.yaml —
  // not a per-packet module like validate/reconcile. Exits non-zero only on a
  // packet error (parse/missing file), never on incomplete work.
  if (command === "status") {
    try {
      // --html writes the self-contained single-packet progress card (the visual
      // sibling of asp index --html). Like index, the only write is the artifact.
      const htmlIdx = args.indexOf("--html");
      if (htmlIdx !== -1) {
        const maybePath = args[htmlIdx + 1];
        const explicit = maybePath && !maybePath.startsWith("--") ? maybePath : undefined;
        const outPath = path.resolve(root, explicit ?? `${path.basename(packet.packetDir)}-progress.html`);
        writeFileSync(outPath, renderAspStatus(packet.packetDir, { html: true }));
        process.stdout.write(`wrote progress card to ${outPath}\n`);
        return 0;
      }
      // The rich card is the default in an interactive terminal; pipes, --json,
      // and --plain keep the stable text view so scripts and tests never parse
      // ANSI. --rich forces the layout for capture (without color unless a TTY).
      const json = args.includes("--json");
      const isTty = Boolean((process.stdout as NodeJS.WriteStream).isTTY);
      const rich = !json && (args.includes("--rich") || (isTty && !args.includes("--plain")));
      const color = rich && isTty && !process.env.NO_COLOR && process.env.TERM !== "dumb";
      // Bars/truncation are visual-only and unhelpful (noisy) off a terminal, so
      // they ride the real-TTY signal, not the --rich force used for capture.
      const bars = rich && isTty;
      // Status glyphs (foo-status-glyphs-v0) ride a human-only gate (R-008): off
      // for --json, NO_COLOR, and piped/non-TTY. They decorate the text view
      // (--plain / --deep); the rich card carries its own.
      const glyphs = !json && glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args });
      process.stdout.write(
        renderAspStatus(packet.packetDir, { json, deep: args.includes("--deep"), rich, color, bars, glyphs }),
      );
      // Cost of what is LEFT, at the moment you choose the next task (spec-budget-v0
      // R-010). A packet that is 80% done does not still cost its full build price,
      // so this scales by the open task share rather than reprinting the packet
      // total. Human surfaces only: the --json and --html contracts are untouched.
      // Structural, never egresses, and silently absent when it cannot be honest.
      if (!json) {
        const cost = await costHeadline(root, packet.packetDir, { remainingOnly: true });
        if (cost) process.stdout.write(`\n  Cost: ${cost}\n`);
      }
      return 0;
    } catch (error) {
      // A throw here is a real defect, not a typo — classify it so it pages and so the
      // message + stack reach the local log instead of vanishing into a bare exit 1.
      markFailure(classifyThrown(error));
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // Intent verification (intent-verification-verdict-v0): the third packet read
  // leg — did we ship what we intended, with proof? Advisory by default (a
  // signal, not a boundary): it surfaces the verdict and exits 0. --strict
  // escalates only `drift` (a false "done") to a nonzero exit, never merely
  // unproven or unfinished work. --record appends the portable verdict event so
  // the proof travels in the ledger any runtime reads.
  if (command === "verify") {
    try {
      const json = args.includes("--json");
      const report = verifyPacket({ packetDir: packet.packetDir, root: root });
      if (args.includes("--record")) {
        appendEvent({
          packetDir: packet.packetDir,
          type: VERIFY_EVENT_TYPE,
          data: {
            verdict: report.verdict,
            summary: report.summary,
            tasks: report.tasks,
            checks: report.checks,
            requirements: report.requirements,
            findings: report.findings.length,
          },
        });
      }
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        const glyphs = glyphsEnabled({ isTTY: Boolean(process.stdout.isTTY), env: process.env, args });
        process.stdout.write(renderVerifyReport(report, glyphs));
        process.stdout.write(
          report.verdict === "drift"
            ? "\n[boundary-adjacent] drift is a false completion claim — run with --strict to make it block.\n"
            : "\n[signal] advisory only — asp verify surfaces the verdict, it does not block.\n",
        );
      }
      return hasFlag(args, "--strict") && report.verdict === "drift" ? 1 : 0;
    } catch (error) {
      // A throw here is a real defect, not a typo — classify it so it pages and so the
      // message + stack reach the local log instead of vanishing into a bare exit 1.
      markFailure(classifyThrown(error));
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  // packet-grammar-v1 R-006: mint missing IDs in place, prove it, refuse
  // anything that is not pure insertion. Existing IDs and prose are
  // untouchable (R-003) — the migrator only ever ADDS a token to a line.
  if (command === "migrate") {
    const dryRun = hasFlag(args, "--dry-run");
    const wantJson = hasFlag(args, "--json");
    const specPath = path.join(packet.packetDir, "spec.md");
    if (!existsSync(specPath)) return failWith(`spec.md missing in ${packet.packetDir}`);
    const original = readFileSync(specPath, "utf8");
    const result = migrateSpecText(original);
    const label2 = path.basename(packet.packetDir);
    if (!result.proofOk) {
      // Defensive: a migrator that cannot strip its own insertions back to the
      // original must not write (R-006 contract — exit 2, no files touched).
      process.stderr.write(
        `foo asp migrate — REFUSED: insertion proof failed for ${label2}; no files written.\n`,
      );
      return 2;
    }
    if (!dryRun && result.insertions.length > 0) writeFileSync(specPath, result.text);
    if (wantJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: "0.1",
            packet: label2,
            written: !dryRun && result.insertions.length > 0,
            proof: "insertion-only",
            insertions: result.insertions.map((i) => ({ line: i.line, id: i.id })),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    if (result.insertions.length === 0) {
      process.stdout.write(`${label2} — every anchor already has an ID; nothing to insert.\n`);
      return 0;
    }
    const verb = dryRun ? "would insert" : "inserted";
    process.stdout.write(`${label2} — ${verb} ${result.insertions.length} ID(s), prose untouched (proof: insertion-only):\n`);
    for (const i of result.insertions) process.stdout.write(`  spec.md:${i.line}  ${i.id}\n`);
    if (!dryRun) process.stdout.write(`Next: foo asp validate ${packet.packetArg}\n`);
    return 0;
  }

  if (command !== "validate" && command !== "reconcile") {
    return failWith(`unknown command: ${command}`);
  }

  // A compiled per-packet module is preferred during transition, but no longer
  // required: when a packet ships no validate/reconcile module, both commands
  // fall back to the shared engines (asp-cli-lifecycle-v0 T-002), so any packet
  // dir — including a freshly scaffolded one — validates and reconciles.
  const module = await loadPacketCommand(root, packet.packetArg, command);
  const context = { root: root, packetDir: packet.packetDir, packetArg: packet.packetArg };
  const label = path.basename(packet.packetDir);

  // asp validate is advisory by default (sog_v0 T-004 / R1): it surfaces findings
  // and exits 0. --strict escalates to a nonzero exit only on a boundary-class
  // violation (B2 spec identity); structural findings stay signals even then.
  if (command === "validate") {
    const strict = hasFlag(args, "--strict");
    const wantJson = hasFlag(args, "--json");
    // --fix applies the migrator before validating (R-006): complaining about
    // a missing ID when one command inserts it is friction with no safety.
    if (hasFlag(args, "--fix")) {
      const specPath = path.join(packet.packetDir, "spec.md");
      if (existsSync(specPath)) {
        const fixed = migrateSpecText(readFileSync(specPath, "utf8"));
        if (fixed.proofOk && fixed.insertions.length > 0) {
          writeFileSync(specPath, fixed.text);
          if (!wantJson) {
            process.stdout.write(`--fix: inserted ${fixed.insertions.length} ID(s) via foo asp migrate.\n`);
          }
        }
      }
    }
    try {
      const message = module?.validatePacket
        ? await module.validatePacket(context)
        : validatePacketGeneric({ packetDir: packet.packetDir, label, requireSpecSections: true });
      // Grammar lint (packet-grammar-v1 R-004): advisory findings with stable
      // codes, never touching the exit code — blocking is the commit gate's
      // call (R-005), and only for the malformed/duplicate subset.
      const grammar = lintAnchors(readFileSync(path.join(packet.packetDir, "spec.md"), "utf8")).map(
        (f) => ({ ...f, file: "spec.md" }),
      );
      const decisions = derivePacketStatus(packet.packetDir).decision_findings.map(
        (f) => ({ ...f, file: "spec.md" }),
      );
      const findings = [...grammar, ...decisions];
      if (wantJson) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: "0.1", packet: label, ok: true, findings }, null, 2)}\n`,
        );
        return 0;
      }
      process.stdout.write(`${message}\n`);
      for (const f of findings) {
        process.stdout.write(`[signal] ${f.code} ${f.file}:${f.line} — ${f.detail}\n`);
      }
      // B4 at authoring time. `asp validate` is the reflex an agent runs right after
      // editing a packet (AGENTS.md), and it used to say a plain "ok" for a packet
      // carrying an unbudgeted, spending loop — it never looked at loops.yaml at all.
      // So the one moment someone is actually holding the loop contract was the one
      // moment nothing mentioned the budget. Surfaced here as a SIGNAL (foo blocks in
      // `self check`/CI, per signals-over-gates); the point is to tell the author now,
      // not to ambush them in CI.
      const loopSignal = loopBudgetSignal(root, packet.packetDir);
      if (loopSignal) process.stdout.write(`\n${loopSignal}\n`);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isPacketValidationError(error)) markFailure(classifyThrown(error));
      // B2 spec identity is the only boundary asp validate surfaces; every other
      // structural failure is an advisory signal that never blocks.
      const isBoundary = /spec_id must match/.test(message);
      if (wantJson) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: "0.1", packet: label, ok: false, error: message, findings: [] }, null, 2)}\n`,
        );
        return strict && isBoundary ? 1 : 0;
      }
      process.stdout.write(`${message}\n`);
      process.stdout.write(
        isBoundary
          ? "\n[boundary] B2 spec identity — run with --strict to make this block.\n"
          : "\n[signal] advisory only — asp validate never blocks on structural findings.\n",
      );
      return strict && isBoundary ? 1 : 0;
    }
  }

  try {
    // GitHub source reconcile (github-integration-v0 T-002): `asp reconcile
    // --source github:<url>` admits a PR/repo selection rather than diffing files.
    if (flagValue(args, "--source")) {
      const result = runGithubSourceReconcile(root, packet.packetDir, args);
      process.stdout.write(result.out);
      if (result.code === 0) suggestDoneVerdict(root, packet.packetDir);
      return result.code;
    }
    if (module?.reconcilePacket) {
      const report = await module.reconcilePacket({ ...context, args });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      suggestDoneVerdict(root, packet.packetDir);
      return 0;
    }
    const report = reconcilePacketGeneric({
      ...parseReconcileArgs(args),
      packetDir: packet.packetDir,
      root: root,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    suggestDoneVerdict(root, packet.packetDir);
    return 0;
  } catch (error) {
    // Mark it, like every other catch in this file does. This one did not, so a real crash
    // here reached the top with no class, no code and — worst — no STACK: it fingerprinted
    // as the stackless E_UNKNOWN sentinel and fused with every other unmarked nonzero exit
    // in foo. The bug's own trace was discarded at the only place that still had it.
    markFailure(classifyThrown(error));
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}


// B4 authoring-time signal (see the call site in `asp validate`). Read-only and
// status-aware, mirroring `self check`: a draft contract cannot spend, so it is a
// nudge; an ARMED one that has not been budgeted is called out as the boundary
// violation it is. Returns null when there is nothing to say.
export function loopBudgetSignal(root: string, packetDir: string): string | null {
  if (!existsSync(path.join(packetDir, "loops.yaml"))) return null;

  let loops;
  try {
    loops = loadLoopContracts(packetDir).loops;
  } catch (error) {
    return `[signal] loops.yaml does not parse as a loop contract (${error instanceof Error ? error.message : String(error)}) — foo self check will block on this (B4).`;
  }

  const pricing = loadPricing(root);
  const floor = handshakeFloorUsd();
  const packetRel = path.relative(root, packetDir).split(path.sep).join("/") || packetDir;
  const lines: string[] = [];

  for (const loop of loops) {
    if (loop.budget?.agreed) continue;
    const estimate = estimateLoopBudget({ packetDir, sources: loop.observe.sources, pricing, unit: "usd", budget: loop.budget });
    const unmeasurable = hasExternalSources(estimate.measured);
    // A loop that can prove it is cheap auto-approves on `loop check` — nothing to say.
    if (estimate.priced && !unmeasurable && estimate.usd.expected < floor) continue;

    const armed = loop.status === "ready" || loop.status === "active";
    // Never quote a dollar figure we cannot stand behind.
    const cost = unmeasurable
      ? "its cost is unknown (it reads sources productfoo cannot size)"
      : !estimate.priced
        ? "its cost could not be priced"
        : `it prices at $${estimate.usd.expected.toFixed(2)} expected, at or above the $${floor.toFixed(2)} floor`;
    const fix = unmeasurable
      ? `foo loop estimate ${packetRel} --agree --limit <usd>   (you set the cap; productfoo will not invent one)`
      : `foo loop estimate ${packetRel} --agree`;

    lines.push(
      armed
        ? `[boundary] B4 — loop ${loop.id} is ${loop.status} (armed) with no agreed budget, and ${cost}. foo self check and CI will block this.\n  Authorise it: ${fix}`
        : `[signal] loop ${loop.id} (${loop.status}) has no agreed budget, and ${cost}.\n  Budget it before arming it: ${fix}`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
