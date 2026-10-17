// Light, boot-path agent state: the ledger/event primitives, telemetry config,
// tester identity, and the auto-wire eligibility predicate that cli.ts's
// per-invocation spine uses. This module exists so the every-invocation code
// path (usage telemetry, event ids, log path) does not pull the heavy `agent`
// command domain (harness adapters, redaction, agent setup) into the static
// import graph — cli_performance-v0 R-002 lazy dispatch. The functions are
// moved verbatim from commands/agent.ts, which re-exports them.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readJson } from "./jsonFile.js";
import { machineStateDir } from "./machineState.js";
import { fileStatKey, readMemoized, writeMemoized, type MemoEntry } from "./processMemo.js";

export type AgentTelemetryConfig = {
  enabled: boolean;
  // Opaque local installation identifier; the legacy field name is kept
  // so existing local logs and settings remain readable.
  testerId?: string;
};

// Emitted once per CLI invocation (R-018). Metadata-only, closed allow-list:
// never raw args, prompts, source, file contents, secrets, or absolute paths.
export type CliUsageEvent = {
  schema_version: "0.1";
  event_type: "cli_usage";
  id: string;
  timestamp: string;
  domain: string;
  command: string;
  exit_code: number;
  error_class: string;
  // error-instrumentation-v0 (D-001): a bounded symbol (E_PACKET_DIR_MISSING), never
  // free text. It crosses the wire under a metadata-only disclosure, so it may not
  // carry a path, an arg, or user content. The message and stack stay on disk.
  error_code?: string;
  duration_ms: number;
  version: string;
  tester_id?: string;
  packet_slug?: string;
  // R-004: richer signal rides inside attributes, never as new columns.
  // interactive = stdout was a TTY (a human typed this) vs. an agent harness
  // ran it. A boolean about the terminal, never about content — disclosed on
  // all four OQ-4 surfaces.
  //
  // fingerprint (error-instrumentation-v0): a one-way hash of the bounded code plus the
  // normalized origin frame — content-free by construction (no path, no line, no arg, no
  // message), the same bar `error_code` meets. Present only on nonzero rows, it lets the
  // digest group the same bug across testers and rank by blast radius without ever shipping
  // a stack. Mirrors the existing content-free `token_fp` metering fingerprint.
  attributes?: { interactive: boolean; fingerprint?: string };
};

// The event ledger is MACHINE state, not project state — the same argument that
// already moved the tester id out of the project dir (see machineTelemetryConfigPath
// below). It used to be `<cwd>/.foo/agent-events.jsonl`: foo wrote telemetry INTO
// the user's git repo, on every invocation, and nothing gitignored it. An alpha
// tester found it as an untracked file she had to clean up herself.
//
// It never bit in dogfood for one reason: productfoo's OWN .gitignore has `.foo/`. productfoo
// was the only repo in the world where the bug was invisible.
//
// The other exit — writing `.foo/` into the user's .gitignore for them — is the
// same sin in a different file: editing a tracked project file nobody asked us to
// touch (R-004 says this out loud about shell profiles; a .gitignore is no
// different). So foo writes under its own home instead, and leaves the user's repo
// exactly as it found it. FOO_STATE_DIR overrides for tests. (R-005)
export function agentLogPath(_root?: string): string {
  return path.join(machineStateDir(), "agent-events.jsonl");
}

// The ledger is read back whole (`foo agent logs|rate|telemetry` parse every
// line), so an unbounded file would make those reads grow with history. At
// the cap the current file rotates to `<name>.1` — one backup generation, the
// oldest events falling off first (cli-performance-v0 R-004, audit F7).
export const LEDGER_MAX_BYTES = 5 * 1024 * 1024;

// Single append per event, with size-cap rotation: every ledger write goes
// through here so no site can rewrite the file. Rotation is one rename (the
// live file becomes the backup, replaced in turn by the next rotation) —
// never a read-and-rewrite of the corpus. The cap is a parameter so tests can
// exercise the boundary without materializing megabytes.
export function appendLedgerEvent(logPath: string, line: string, maxBytes: number = LEDGER_MAX_BYTES): void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  if (maxBytes > 0) {
    try {
      if (statSync(logPath).size >= maxBytes) renameSync(logPath, `${logPath}.1`);
    } catch (error) {
      // No ledger yet is the normal first-append case, not a failure; any
      // other stat error (permissions, EACCES) is real and must surface.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  appendFileSync(logPath, line);
}

export function agentTelemetryConfigPath(root: string): string {
  return path.join(root, ".foo", "telemetry.json");
}

// The tester id is a PER-MACHINE identity (one human, one id), so it lives
// under the home dir — never the project dir. Persisting it per-project minted
// a fresh id (and fired a fresh activation event) in every directory a tester
// ran foo from, inflating install counts. FOO_STATE_DIR overrides for tests.
export function machineTelemetryConfigPath(): string {
  return path.join(machineStateDir(), "telemetry.json");
}

export function nextAgentEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Per-process memo (cli_performance-v0 R-002): telemetry config is read 3× per
// invocation today (cli.ts usage path ×2 + resolveTesterId). Keyed on
// (mtime, size) so an external write between reads — a test fixture, another
// process — invalidates naturally; every in-process write deletes its entry.
const telemetryFileCache = new Map<string, MemoEntry<{ config: Partial<AgentTelemetryConfig>; exists: boolean }>>();

export function readTelemetryFile(configPath: string): { config: Partial<AgentTelemetryConfig>; exists: boolean } {
  const key = fileStatKey(configPath);
  const cached = readMemoized(telemetryFileCache, configPath, key);
  if (cached !== undefined) return { exists: cached.exists, config: { ...cached.config } };
  let value: { config: Partial<AgentTelemetryConfig>; exists: boolean };
  if (key === "absent") value = { config: {}, exists: false };
  else {
    try {
      value = { config: readJson<Partial<AgentTelemetryConfig>>(configPath), exists: true };
    } catch {
      value = { config: {}, exists: false };
    }
  }
  writeMemoized(telemetryFileCache, configPath, key, value);
  return { exists: value.exists, config: { ...value.config } };
}

// Merged view: the tester id comes from the machine config first (project as a
// pre-fix fallback, adopted upward by resolveTesterId); the opt-out honors a
// `false` at EITHER scope, so a disable always holds.
export function readAgentTelemetryConfig(root: string): { config: AgentTelemetryConfig; exists: boolean } {
  const project = readTelemetryFile(agentTelemetryConfigPath(root));
  const machine = readTelemetryFile(machineTelemetryConfigPath());
  const testerId = machine.config.testerId ?? project.config.testerId;
  return {
    config: {
      enabled: project.config.enabled !== false && machine.config.enabled !== false,
      ...(testerId ? { testerId } : {}),
    },
    exists: project.exists || machine.exists,
  };
}

function writeTelemetryFile(configPath: string, config: AgentTelemetryConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ schema_version: "0.1", ...config }, null, 2)}\n`);
  // Same-process reads must observe the write (enable/disable then read).
  telemetryFileCache.delete(configPath);
}

// Per-repo settings (the enable/disable opt-out) stay in the project config.
export function writeAgentTelemetryConfig(root: string, config: AgentTelemetryConfig): void {
  writeTelemetryFile(agentTelemetryConfigPath(root), config);
}

// Identity writes go to the machine config — one id per human per machine.
export function writeMachineTesterId(testerId: string): void {
  const { config } = readTelemetryFile(machineTelemetryConfigPath());
  writeTelemetryFile(machineTelemetryConfigPath(), { ...config, enabled: config.enabled !== false, testerId });
}

export function generateTesterId(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

// Local installation identifier. Precedence:
// FOO_TESTER_ID env (maintainer-issued at invite) > machine config > project
// config (pre-fix installs; adopted upward once) > freshly generated. Opaque
// token, never a name; it attributes metadata-only usage and count-only
// Firecrawl bridge metering. The bridge is untrusted transport; sealing and
// exact-byte receipt validation are separate, and there is no multi-model panel.
// Returns undefined when telemetry is opted out — no id is minted
// or emitted in that case.
export function resolveTesterId(root: string): string | undefined {
  const { config } = readAgentTelemetryConfig(root);
  if (!config.enabled) return undefined;
  const machine = readTelemetryFile(machineTelemetryConfigPath()).config;
  const fromEnv = process.env.FOO_TESTER_ID?.trim();
  if (fromEnv) {
    if (machine.testerId !== fromEnv) writeMachineTesterId(fromEnv);
    return fromEnv;
  }
  if (machine.testerId) return machine.testerId;
  // Pre-fix installs persisted the id per-project: adopt it upward once so the
  // tester keeps their identity and no duplicate activation fires.
  if (config.testerId) {
    writeMachineTesterId(config.testerId);
    return config.testerId;
  }
  const generated = generateTesterId();
  writeMachineTesterId(generated);
  return generated;
}

// Which invocations may trigger the install-once-wire-all self-wiring
// (maybeAutoWireHarnesses, commands/agent.ts). Trivial meta commands are
// exempt, and so is the BARE invocation (no domain at all): a stranger's
// first-ever `foo` must answer before it writes — the front door used to wire
// `~/.claude/commands/*` and stamp `~/.foo` on the way to printing
// "domain missing" (FTUX defect: mutate-before-hello). Lives here (not the
// heavy agent domain) because dispatch consults it on every invocation.
export function autoWireEligibleDomain(domain: string | undefined): boolean {
  if (domain === undefined) return false;
  return !["--version", "-v", "version", "help", "--help", "-h"].includes(domain);
}

// Flag-only invocations (`--version`, `help`) carry no usage signal worth a
// ledger line: appending one trained a spurious event into every machine's
// ledger on every boot (cli-performance-v0 R-004, audit F7). Derived-domain
// form — deriveCliCommand normalizes --version/-v and --help/-h before this
// sees them. The keyed auto-report is a separate egress flow and is unaffected.
export function isFlagOnlyDomain(domain: string): boolean {
  return domain === "version" || domain === "help";
}
