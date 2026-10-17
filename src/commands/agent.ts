// The `foo agent` family: adapter status/doctor/setup for harness command
// surfaces, plus the local experience/usage/rating ledger and its telemetry
// config. The per-invocation ledger/telemetry primitives used by cli.ts live
// in ../agentState.js (boot-path: keeps this heavy domain out of the static
// import graph) and are re-exported here for the stable import surface.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { HARNESS_COMMAND_ADAPTERS, resolveHarnessCommandTarget, type HarnessCommandAdapter } from "../agentAdapters.js";
import { FOO_COMMAND_CONTRACT, FOO_COMMAND_MARKER, renderLauncher, showCommandContract } from "../commandContract.js";
import { redactText } from "../redactEngine.js";
import { loadRepoAllowlist } from "../redactConfig.js";
import { readPackageVersion, ROOT } from "./shared.js";
import { UsageError } from "../errorTaxonomy.js";
import { readJson } from "../jsonFile.js";
import { isSourceCheckout } from "../channelFreshness.js";
import {
  agentLogPath,
  appendLedgerEvent,
  agentTelemetryConfigPath,
  generateTesterId,
  machineTelemetryConfigPath,
  nextAgentEventId,
  readAgentTelemetryConfig,
  readTelemetryFile,
  resolveTesterId,
  writeAgentTelemetryConfig,
  writeMachineTesterId,
  type AgentTelemetryConfig,
  type CliUsageEvent,
} from "../agentState.js";

export {
  agentLogPath,
  autoWireEligibleDomain,
  nextAgentEventId,
  readAgentTelemetryConfig,
  resolveTesterId,
} from "../agentState.js";
export type { AgentTelemetryConfig, CliUsageEvent } from "../agentState.js";

export type AgentDefinition = HarnessCommandAdapter;

type AgentAdapterStatus = "ready" | "missing" | "drift" | "unsupported";

type AgentStatus = {
  id: string;
  label: string;
  command_path: string;
  namespace: string | null;
  invocations: string[];
  status: AgentAdapterStatus;
  installed: string[];
  conflicts: string[];
  legacy: string[];
  stale: string[];
  outdated: string[];
  surfaces?: { app: string[]; cli: string[] };
};

type AgentCommandOptions = {
  agent: string;
  dryRun: boolean;
  format: "text" | "json" | "markdown";
  scope: "project" | "global";
  yes: boolean;
};

type AgentExperienceKind = "failure" | "poor_experience" | "good_experience";

type AgentLogOptions = {
  kind: AgentExperienceKind;
  summary: string;
  agent?: string;
  packet?: string;
  command?: string;
  prompt?: string;
  promptSummary?: string;
  promptMode?: "metadata" | "summary" | "raw";
  includePrompt: boolean;
  format: "text" | "json";
};

type AgentExperienceEvent = {
  schema_version: "0.1";
  event_type: "agent_experience";
  id: string;
  timestamp: string;
  kind: AgentExperienceKind;
  summary: string;
  agent?: string;
  packet?: string;
  command?: string;
  prompt_captured: boolean;
  prompt?: string;
  source: {
    agent?: string;
    packet?: string;
    command?: string;
  };
  prompt_context: {
    mode: "metadata" | "summary" | "raw";
    captured: boolean;
    summary?: string;
    redactions?: number;
  };
};


// R-010 product-management ratings + R-012 design/workflow ratings, 1-7 scale.
const RATING_FIELDS = [
  "spec_clarity",
  "intent_fidelity",
  "product_judgment_lift",
  "build_readiness",
  "output_intent_match",
  "spec_to_output_lift",
  "avoidable_rework",
  "trust_to_delegate_next_time",
  "experience_clarity",
  "trust_explainability",
] as const;

const REROUTE_CHOICES = ["spec", "review", "artifact", "none"] as const;

// Recorded by `foo agent rate` at a checkpoint (R-010/R-011/R-012). 1-7 ratings
// plus qualitative notes kept separate from any raw prompt text.
type AgentRatingEvent = {
  schema_version: "0.1";
  event_type: "rating";
  id: string;
  timestamp: string;
  checkpoint: string;
  ratings: Record<string, number>;
  qualitative: Record<string, string>;
  baseline_mode?: string;
  lift_drivers?: string;
  agent?: string;
  packet_ref?: string;
  commit_ref?: string;
  artifact_ref?: string;
  reroute: { required: boolean; choice: string | null };
  source: { agent?: string; checkpoint: string };
};

type AgentRateOptions = {
  checkpoint: string;
  ratings: Record<string, number>;
  qualitative: Record<string, string>;
  baselineMode?: string;
  liftDrivers?: string;
  agent?: string;
  packet?: string;
  commit?: string;
  artifact?: string;
  reroute?: string;
  format: "text" | "json";
};

type LedgerEvent = AgentExperienceEvent | CliUsageEvent | AgentRatingEvent;

type AgentTelemetryOptions = {
  format: "text" | "json";
};

// productfoo installs exactly these human-facing commands. Every other skill stays
// internal package payload that these commands route to (see R-014/R-015).
// Single-sourced from the command contract (R-001): the adapter surface can
// never drift from what `foo commands list` declares.
const FOO_COMMANDS: readonly string[] = FOO_COMMAND_CONTRACT.map((c) => c.id);

// Resolve the commands to install for a given harness, respecting exclusions (e.g., bug for third-party bots).
function commandsForHarness(adapter: AgentDefinition): readonly string[] {
  if (!adapter.excludedCommands || adapter.excludedCommands.length === 0) return FOO_COMMANDS;
  return FOO_COMMANDS.filter((id) => !adapter.excludedCommands!.includes(id));
}

const FOO_ROUTING_CONTRACT = {
  schema_version: "0.1",
  applies_when: [
    "bin/foo is available in the repo",
    "the user asks product, spec, packet, planning, decision, correction, validation, or drift work",
  ],
  first_actions: ["foo spec", "foo spec start", "foo asp validate", "foo asp reconcile", "foo asp event", "foo asp task"],
  downstream_companions: ["Compound Engineering", "Superpowers", "generic planning tools"],
  // default-agent-routing-v0 T-004 (R-004): productfoo defers implementation planning
  // to downstream companions, but the handoff must carry the packet contract —
  // never a bare prompt. There is deliberately no public `foo plan` in V0.
  planning_handoff: {
    packet_path: "<packet-dir>",
    include: [
      "relevant requirements (spec.md ## Requirements)",
      "relevant tasks and their done_when checks (tasks.yaml)",
      "the validation bar: foo asp validate <packet-dir> must stay green",
    ],
    note: "productfoo-native planning (`foo plan`) is a possible future slice after adapter-first routing is proven; V0 routes planning to companions with this contract.",
  },
  public_commands_added: [] as string[],
  requires_hook: false,
};

// Some harnesses namespace commands only when they come from a plugin, so the
// adapter can install them as a tiny auto-loaded plugin named `foo`.
const FOO_PLUGIN_NAME = "foo";

function fooPluginManifest(version = "0.1.0"): string {
  return `${JSON.stringify(
    {
      name: FOO_PLUGIN_NAME,
      version,
      description: "productfoo product-shaping commands: init (start here), research, discovery, pitch, ideate, spec, roast, preview.",
      author: { name: "productfoo" },
      skills: "./skills/",
      interface: {
        displayName: "productfoo",
        shortDescription: "Product shaping, specs, proof, and drift checks",
        longDescription: "productfoo turns product intent into agreed specs, proof, approval boundaries, and aligned implementation work.",
        developerName: "productfoo",
        category: "Coding",
        capabilities: ["Interactive", "Write"],
      },
    },
    null,
    2,
  )}\n`;
}

function pluginManifestForAgent(agent: AgentDefinition): string {
  if (agent.id === "codex") return fooPluginManifest(codexPluginVersion());
  return fooPluginManifest("0.1.0");
}

export const AGENT_DEFINITIONS: AgentDefinition[] = Object.values(HARNESS_COMMAND_ADAPTERS);

function parseAgentOptions(args: string[]): AgentCommandOptions {
  const options: AgentCommandOptions = {
    agent: "all",
    dryRun: false,
    format: "text",
    scope: "project",
    yes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.format = "json";
      continue;
    }

    if (arg === "--markdown") {
      options.format = "markdown";
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--yes") {
      options.yes = true;
      continue;
    }

    if (arg === "--agent") {
      const value = args[index + 1];
      if (!value) throw new UsageError("--agent requires a value", "E_BAD_FLAG");
      options.agent = value;
      index += 1;
      continue;
    }

    if (arg === "--scope") {
      const value = args[index + 1];
      if (value !== "project" && value !== "global") throw new UsageError("--scope must be project or global", "E_BAD_FLAG");
      options.scope = value;
      index += 1;
      continue;
    }

    throw new UsageError(`unknown agent argument: ${arg}`, "E_BAD_FLAG");
  }

  return options;
}

function parseAgentLogOptions(args: string[]): AgentLogOptions {
  const options: Partial<AgentLogOptions> & {
    includePrompt: boolean;
    format: "text" | "json";
  } = {
    includePrompt: false,
    format: "text",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.format = "json";
      continue;
    }

    if (arg === "--include-prompt") {
      options.includePrompt = true;
      continue;
    }

    if (["--kind", "--summary", "--agent", "--packet", "--command", "--prompt", "--prompt-summary"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new UsageError(`${arg} requires a value`, "E_BAD_FLAG");

      if (arg === "--kind") {
        if (value !== "failure" && value !== "poor_experience" && value !== "good_experience") {
          throw new UsageError("--kind must be failure, poor_experience, or good_experience", "E_BAD_FLAG");
        }
        options.kind = value;
      }

      if (arg === "--summary") options.summary = value;
      if (arg === "--agent") options.agent = value;
      if (arg === "--packet") options.packet = value;
      if (arg === "--command") options.command = value;
      if (arg === "--prompt") options.prompt = value;
      if (arg === "--prompt-summary") options.promptSummary = value;

      index += 1;
      continue;
    }

    if (arg === "--prompt-mode") {
      const value = args[index + 1];
      if (value !== "metadata" && value !== "summary" && value !== "raw") {
        throw new UsageError("--prompt-mode must be metadata, summary, or raw", "E_BAD_FLAG");
      }
      options.promptMode = value;
      index += 1;
      continue;
    }

    throw new UsageError(`unknown agent log argument: ${arg}`, "E_BAD_FLAG");
  }

  if (!options.kind) throw new UsageError("--kind is required", "E_BAD_FLAG");
  if (!options.summary) throw new UsageError("--summary is required", "E_BAD_FLAG");

  return options as AgentLogOptions;
}

function parseAgentLogsOptions(args: string[]): { format: "text" | "json"; usage: boolean; ratings: boolean } {
  let format: "text" | "json" = "text";
  let usage = false;
  let ratings = false;

  for (const arg of args) {
    if (arg === "--json") {
      format = "json";
      continue;
    }

    if (arg === "--usage") {
      usage = true;
      continue;
    }

    if (arg === "--ratings") {
      ratings = true;
      continue;
    }

    throw new UsageError(`unknown agent logs argument: ${arg}`, "E_BAD_FLAG");
  }

  return { format, usage, ratings };
}

function parseAgentTelemetryOptions(args: string[]): AgentTelemetryOptions {
  let format: "text" | "json" = "text";

  for (const arg of args) {
    if (arg === "--json") {
      format = "json";
      continue;
    }

    throw new UsageError(`unknown agent telemetry argument: ${arg}`, "E_BAD_FLAG");
  }

  return { format };
}

function selectAgents(agent: string): AgentDefinition[] {
  if (agent === "all") return AGENT_DEFINITIONS;
  const selected = AGENT_DEFINITIONS.find((definition) => definition.id === agent);
  if (!selected) throw new UsageError(`unknown agent: ${agent}`, "E_BAD_FLAG");
  return [selected];
}

type AgentCommandState = {
  installed: string[];
  conflicts: string[];
  legacy: string[];
  stale: string[];
  outdated: string[];
  manifestReady: boolean;
  status: AgentAdapterStatus;
  reason?: string;
};

type AgentSetupChange = {
  action: "install-commands" | "verify-existing" | "repair-legacy" | "conflict" | "unsupported";
  agent: string;
  command_path: string;
  namespace: string | null;
  commands: string[];
  install: string[];
  install_manifest: boolean;
  conflicts: string[];
  legacy: string[];
  stale: string[];
  outdated: string[];
  unsupported_reason?: string;
  surfaces?: { app: string[]; cli: string[] };
};

function commandSourcePath(id: string): string {
  return path.join(ROOT, "commands", `${id}.md`);
}

function isFooManagedCommand(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  if (!lstatSync(filePath).isFile()) return false;
  return readFileSync(filePath, "utf8").includes(FOO_COMMAND_MARKER);
}

// Adapters install into the runtime the caller is using, never the productfoo package
// directory: the user's project (cwd) for project scope, home for global scope.
function targetBaseForScope(scope: "project" | "global"): string {
  const releaseGateRoot = process.env.FOO_RELEASE_GATE_ADAPTER_ROOT?.trim();
  if (scope === "global" && releaseGateRoot) {
    if (process.env.FOO_CODEX_PLUGIN_NO_INSTALL !== "1" || !path.isAbsolute(releaseGateRoot)) {
      throw new UsageError(
        "FOO_RELEASE_GATE_ADAPTER_ROOT requires an absolute path and FOO_CODEX_PLUGIN_NO_INSTALL=1",
        "E_BAD_FLAG",
      );
    }
    return path.resolve(releaseGateRoot);
  }
  return scope === "global" ? homedir() : process.cwd();
}

function agentNamespace(agent: AgentDefinition): string | null {
  return agent.plugin?.name ?? agent.commandNamespace ?? agent.invocationNamespace ?? null;
}

// How the user actually types ONE command. A namespace and a filename prefix are
// independent, and both are part of what gets typed:
//   Claude   ns=foo,     no prefix   -> /foo:spec
//   Codex    plugin=foo, no prefix   -> /foo:spec
//   OpenCode no ns,      prefix foo- -> /foo-spec
export function typedCommand(agent: AgentDefinition, command: string): string {
  const ns = agentNamespace(agent);
  const prefix = agent.commandPrefix ?? "";
  return ns ? `/${ns}:${prefix}${command}` : `/${prefix}${command}`;
}

export function agentInvocations(agent: AgentDefinition): string[] {
  return commandsForHarness(agent).map((command) => typedCommand(agent, command));
}

function cliPluginInvocations(agent: AgentDefinition): string[] {
  if (!agent.plugin) return [];
  return commandsForHarness(agent).map((command) => `$${agent.plugin!.name}:${command}`);
}

function pluginManifestPath(base: string, agent: AgentDefinition): string | null {
  return agent.plugin ? path.join(base, agent.plugin.dir, agent.plugin.manifestRelPath) : null;
}

// productfoo-managed command files a previous setup wrote into the current install
// directory whose id has since left FOO_COMMANDS (e.g. a demoted `detect`). We
// own these — the marker proves it — so setup should prune them; leaving them
// keeps a retired command in the harness menu forever.
// The on-disk filename for a command: prefix + id + the harness's extension,
// e.g. `foo-spec.md` (Cursor) or `spec.md` (Claude Code). Codex plugin skills
// use <id>/SKILL.md via commandFilePath. One place keeps setup/state aligned.
function commandFileName(prefix: string, id: string, extension: string): string {
  return `${prefix}${id}${extension}`;
}

function commandFilePath(dir: string, agent: AgentDefinition, target: { prefix: string; extension: string }, id: string): string {
  return agent.commandLayout === "skills"
    ? path.join(dir, id, `SKILL${target.extension}`)
    : path.join(dir, commandFileName(target.prefix, id, target.extension));
}

function renderPluginSkill(id: string): string {
  return renderLauncher(showCommandContract(id)).replace(/^---\n/, `---\nname: ${id}\n`);
}

// The exact bytes setup would write for this command today. An installed shim
// that differs is outdated: it still carries the managed marker, so presence
// checks pass, but its instructions describe a contract the CLI no longer
// honors (a repurposed command's old shim advertised a front door that had
// been removed — issue #520).
function expectedCommandContent(agent: AgentDefinition, id: string): string {
  // grok-bot-foo-first-override-v0: Grok launchers include the override flag.
  return agent.commandLayout === "skills" 
    ? renderPluginSkill(id) 
    : renderLauncher(showCommandContract(id), { grokFooFirst: agent.id === "grok" });
}

function codexPluginVersion(): string {
  const digest = createHash("sha256")
    .update(FOO_COMMANDS.map((id) => renderPluginSkill(id)).join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `${readPackageVersion(ROOT)}+codex.${digest}`;
}

function ensurePersonalMarketplace(base: string, agent: AgentDefinition): string | null {
  if (!agent.marketplace || !agent.plugin) return null;
  const marketplacePath = path.join(base, agent.marketplace.manifestRelPath);
  let marketplace: { name?: string; interface?: { displayName?: string }; plugins?: Array<Record<string, unknown>> } = {};
  if (existsSync(marketplacePath))
    marketplace = readJson<{ name?: string; interface?: { displayName?: string }; plugins?: Array<Record<string, unknown>> }>(marketplacePath);
  if (marketplace.name && marketplace.name !== agent.marketplace.name) {
    throw new Error(`refusing to rewrite marketplace ${marketplacePath}: expected ${agent.marketplace.name}, found ${marketplace.name}`);
  }
  marketplace.name = agent.marketplace.name;
  marketplace.interface ??= { displayName: "Personal" };
  marketplace.interface.displayName ??= "Personal";
  marketplace.plugins ??= [];
  const expectedPath = `./${agent.plugin.dir}`;
  const existing = marketplace.plugins.find((entry) => entry.name === agent.plugin!.name);
  if (existing) {
    const source = existing.source as { source?: string; path?: string } | undefined;
    if (source?.source !== "local" || source.path !== expectedPath) {
      throw new Error(`refusing to replace non-productfoo marketplace entry: ${agent.plugin.name}`);
    }
  } else {
    marketplace.plugins.push({
      name: agent.plugin.name,
      source: { source: "local", path: expectedPath },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  }
  mkdirSync(path.dirname(marketplacePath), { recursive: true });
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return marketplace.name;
}

function detectStaleCommands(base: string, agent: AgentDefinition, scope: "global" | "project"): string[] {
  const target = resolveHarnessCommandTarget(agent, scope);
  if (!target.supported) return [];
  const dir = path.join(base, target.dir);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  const stale: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(target.extension)) continue;
    let id = entry.slice(0, -target.extension.length);
    if (target.prefix && id.startsWith(target.prefix)) id = id.slice(target.prefix.length);
    if (FOO_COMMANDS.includes(id)) continue;
    if (isFooManagedCommand(path.join(dir, entry))) stale.push(id);
  }
  return stale.sort();
}

// Paths from earlier productfoo adapter versions that this setup should clean up:
// skill symlink adapters, and flat command directories holding productfoo-managed files.
function detectLegacyPaths(base: string, agent: AgentDefinition): string[] {
  const legacy: string[] = [];

  for (const symlinkRel of agent.legacyPaths) {
    const symlinkFull = path.join(base, symlinkRel);
    if (existsSync(symlinkFull) && lstatSync(symlinkFull).isSymbolicLink()) legacy.push(symlinkRel);
  }

  if (agent.legacyCommandsDir) {
    const flatDir = path.join(base, agent.legacyCommandsDir);
    const prefix = agent.legacyCommandPrefix ?? "";
    const hasFooFiles = FOO_COMMANDS.some((id) => isFooManagedCommand(path.join(flatDir, `${prefix}${id}.md`)));
    if (hasFooFiles) legacy.push(agent.legacyCommandsDir);
  }

  // A retired plugin install: productfoo's own manifest still on disk means the old
  // (never-auto-loaded) plugin wrapper needs migrating to the commands dir.
  if (agent.legacyPluginDir) {
    const manifest = path.join(base, agent.legacyPluginDir, ".claude-plugin", "plugin.json");
    if (isFooPluginManifest(manifest)) legacy.push(agent.legacyPluginDir);
  }

  return legacy;
}

export function agentCommandState(base: string, agent: AgentDefinition, scope: "global" | "project"): AgentCommandState {
  const target = resolveHarnessCommandTarget(agent, scope);
  // Planned harness (unverified dir / un-emittable format) or global-only harness
  // at project scope: report `unsupported`, never a silent success (D-002).
  if (!target.supported) {
    return { installed: [], conflicts: [], legacy: [], stale: [], outdated: [], manifestReady: true, status: "unsupported", reason: target.reason };
  }
  const harnessCommands = commandsForHarness(agent);
  const dir = path.join(base, target.dir);
  const installed: string[] = [];
  const conflicts: string[] = [];
  const outdated: string[] = [];
  for (const id of harnessCommands) {
    const filePath = commandFilePath(dir, agent, target, id);
    if (!existsSync(filePath)) continue;
    if (isFooManagedCommand(filePath)) {
      installed.push(id);
      // Presence is not currency: a managed shim whose content no longer
      // matches what setup would write today instructs the agent to run a
      // contract the CLI may have dropped. Content drift is drift.
      if (readFileSync(filePath, "utf8") !== expectedCommandContent(agent, id)) outdated.push(id);
    } else conflicts.push(id);
  }
  const legacy = detectLegacyPaths(base, agent);
  const stale = detectStaleCommands(base, agent, scope);
  const manifest = pluginManifestPath(base, agent);
  const manifestReady = manifest ? existsSync(manifest) : true;
  const status: AgentAdapterStatus =
    conflicts.length > 0 || legacy.length > 0 || stale.length > 0 || outdated.length > 0
      ? "drift"
      : installed.length === harnessCommands.length && manifestReady
        ? "ready"
        : "missing";
  return { installed, conflicts, legacy, stale, outdated, manifestReady, status };
}

export function codexGlobalAdapterStatus(home: string = homedir()): {
  status: AgentAdapterStatus;
  command_path: string;
} {
  const agent = AGENT_DEFINITIONS.find((definition) => definition.id === "codex");
  if (!agent) return { status: "unsupported", command_path: "unsupported: Codex adapter missing" };
  const target = resolveHarnessCommandTarget(agent, "global");
  if (!target.supported) return { status: "unsupported", command_path: `unsupported: ${target.reason}` };
  return {
    status: agentCommandState(home, agent, "global").status,
    command_path: path.join(home, target.dir),
  };
}

function renderAgentStatus(options: AgentCommandOptions): string {
  const base = targetBaseForScope(options.scope);
  const agents: AgentStatus[] = selectAgents(options.agent).map((agent) => {
    const state = agentCommandState(base, agent, options.scope);
    const target = resolveHarnessCommandTarget(agent, options.scope);
    const surfaces = agent.plugin ? { app: agentInvocations(agent), cli: cliPluginInvocations(agent) } : undefined;
    return {
      id: agent.id,
      label: agent.label,
      command_path: target.supported ? target.dir : `unsupported: ${state.reason ?? "no command surface for this scope"}`,
      namespace: agentNamespace(agent),
      invocations: agentInvocations(agent),
      status: state.status,
      installed: state.installed,
      conflicts: state.conflicts,
      legacy: state.legacy,
      stale: state.stale,
      outdated: state.outdated,
      ...(surfaces ? { surfaces } : {}),
    };
  });

  const payload = {
    schema_version: "0.1",
    scope: options.scope,
    base,
    canonical_commands: [...FOO_COMMANDS],
    agents,
    next_actions: agents.some((agent) => agent.status !== "ready")
      ? [`foo agent setup --agent all --scope ${options.scope} --dry-run`]
      : ["foo agent doctor"],
  };

  if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

  const describe = (agent: AgentStatus): string => {
    const extra =
      agent.status === "drift"
        ? agent.legacy.length > 0
          ? ` (drift: legacy ${agent.legacy.join(", ")})`
          : agent.stale.length > 0
            ? ` (drift: retired ${agent.stale.join(", ")})`
            : agent.outdated.length > 0
              ? ` (drift: outdated ${agent.outdated.join(", ")} — re-run setup to refresh)`
              : ` (drift: conflicting ${agent.conflicts.join(", ")})`
        : agent.status === "ready"
          ? ` as ${agent.invocations.join(", ")}`
          : "";
    return `${agent.label}: ${agent.status} (${agent.command_path})${extra}`;
  };

  if (options.format === "markdown") {
    return [
      "# productfoo Agent Status",
      "",
      `Canonical commands: ${FOO_COMMANDS.join(", ")}`,
      "",
      ...agents.map((agent) => `- ${describe(agent)}`),
      "",
    ].join("\n");
  }

  return [
    "foo agent status",
    "",
    `Canonical commands: ${FOO_COMMANDS.join(", ")}`,
    ...agents.map(describe),
    "",
  ].join("\n");
}

function renderAgentDoctor(): string {
  const base = targetBaseForScope("project");
  const agents = selectAgents("all").map((agent) => ({ agent, state: agentCommandState(base, agent, "project") }));

  return [
    "foo agent doctor",
    "",
    `Canonical commands: ${FOO_COMMANDS.join(", ")}`,
    `productfoo installs only these ${FOO_COMMANDS.length} commands; all other skills stay internal package payload.`,
    "",
    ...agents.map(({ agent, state }) => {
      const note =
        state.legacy.length > 0
          ? ` (legacy ${state.legacy.join(", ")} — re-run setup to repair)`
          : state.stale.length > 0
            ? ` (retired ${state.stale.join(", ")} — re-run setup to prune)`
            : state.outdated.length > 0
              ? ` (outdated ${state.outdated.join(", ")} — re-run setup to refresh)`
              : state.status === "ready"
                ? ` as ${agentInvocations(agent).join(", ")}`
                : "";
      return `${agent.label}: ${state.status} (${agent.commandsDir})${note}`;
    }),
    "",
    "Next: foo agent setup --agent all --scope project --dry-run",
    "",
  ].join("\n");
}

function agentSetupChanges(base: string, agents: AgentDefinition[], scope: "global" | "project"): AgentSetupChange[] {
  return agents.map((agent) => {
    const state = agentCommandState(base, agent, scope);
    const target = resolveHarnessCommandTarget(agent, scope);
    const harnessCommands = commandsForHarness(agent);
    if (!target.supported) {
      return {
        action: "unsupported",
        agent: agent.id,
        command_path: `unsupported: ${state.reason ?? "no command surface for this scope"}`,
        namespace: agentNamespace(agent),
        commands: [...harnessCommands],
        install: [],
        install_manifest: false,
        conflicts: [],
        legacy: [],
        stale: [],
        outdated: [],
        unsupported_reason: state.reason,
      };
    }
    // An outdated shim re-installs like a missing one: setup rewrites every
    // command file from the current contract, so refresh needs no extra step —
    // it just must not be reported as "verify-existing" when content drifted.
    const install = harnessCommands.filter((id) => (!state.installed.includes(id) || state.outdated.includes(id)) && !state.conflicts.includes(id));
    const installManifest = Boolean(agent.plugin) && !state.manifestReady;
    const action: AgentSetupChange["action"] =
      state.conflicts.length > 0
        ? "conflict"
        : state.legacy.length > 0 || state.stale.length > 0
          ? "repair-legacy"
          : install.length > 0 || installManifest
            ? "install-commands"
            : "verify-existing";
    return {
      action,
      agent: agent.id,
      command_path: target.dir,
      namespace: agentNamespace(agent),
      commands: [...harnessCommands],
      install: [...install],
      install_manifest: installManifest,
      conflicts: state.conflicts,
      legacy: state.legacy,
      stale: state.stale,
      outdated: state.outdated,
      ...(agent.plugin ? { surfaces: { app: agentInvocations(agent), cli: cliPluginInvocations(agent) } } : {}),
    };
  });
}

// True only for a plugin.json productfoo itself wrote (never a user's own plugin).
function isFooPluginManifest(manifestPath: string): boolean {
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) return false;
  try {
    return readJson<{ name?: string }>(manifestPath).name === FOO_PLUGIN_NAME;
  } catch {
    return false;
  }
}

function removeDirIfEmpty(dir: string): void {
  if (existsSync(dir) && lstatSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir);
}

// Remove a legacy path productfoo created earlier: a skills symlink, the productfoo-managed
// command files inside an old flat command directory (leaving the user's own),
// or a retired plugin install (productfoo's manifest + its command files + the dirs
// they leave empty — anything the user added in there survives).
function removeLegacyPath(base: string, rel: string, prefix = ""): void {
  const full = path.join(base, rel);
  if (!existsSync(full)) return;
  if (lstatSync(full).isSymbolicLink()) {
    unlinkSync(full);
    return;
  }
  for (const subdir of [full, path.join(full, "commands")]) {
    for (const id of FOO_COMMANDS) {
      const file = path.join(subdir, `${prefix}${id}.md`);
      if (isFooManagedCommand(file)) unlinkSync(file);
    }
  }
  const manifest = path.join(full, ".claude-plugin", "plugin.json");
  if (isFooPluginManifest(manifest)) unlinkSync(manifest);
  for (const dir of [path.join(full, ".claude-plugin"), path.join(full, "commands"), full]) removeDirIfEmpty(dir);
}

// Broken-install check shared by dry-run and apply: a payload without its
// commands/ (the 0.1.0 foo-dist regression) must fail the DRY RUN too — a
// dry-run that passes while --yes aborts is a lie about readiness.
function assertCanonicalCommandSources(): void {
  for (const id of FOO_COMMANDS) {
    if (!existsSync(commandSourcePath(id))) {
      throw new Error(`canonical command source missing: commands/${id}.md — this foo install is missing its commands/ payload; reinstall foo`);
    }
  }
}

function applyAgentSetup(base: string, agents: AgentDefinition[], scope: "global" | "project"): void {
  assertCanonicalCommandSources();

  if (process.env.FOO_CODEX_PLUGIN_NO_INSTALL !== "1"
    && agents.some((agent) =>
      agent.id === "codex"
      && agent.marketplace
      && resolveHarnessCommandTarget(agent, scope).supported)) {
    try {
      execFileSync("codex", ["--version"], { stdio: "pipe" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UsageError(
          "Codex CLI is not installed or not on PATH; install Codex, then rerun `foo agent setup --agent codex --scope global --yes`",
        );
      }
      throw error;
    }
  }

  // Refuse the whole apply if any target name is owned by a non-productfoo file, so a
  // setup run never half-overwrites a user's own commands.
  const blocked = agents
    .map((agent) => ({ agent, state: agentCommandState(base, agent, scope) }))
    .filter(({ state }) => state.conflicts.length > 0);
  if (blocked.length > 0) {
    const detail = blocked
      .map(({ agent, state }) => `${agent.id} (${state.conflicts.join(", ")})`)
      .join("; ");
    throw new Error(`refusing to overwrite non-productfoo command files: ${detail}`);
  }

  for (const agent of agents) {
    const target = resolveHarnessCommandTarget(agent, scope);
    // Planned harness or global-only harness at the wrong scope: write nothing.
    // Honest no-op — never a broken markdown/TOML binding (D-002/D-004).
    if (!target.supported) continue;

    const state = agentCommandState(base, agent, scope);
    for (const rel of state.legacy) {
      removeLegacyPath(base, rel, rel === agent.legacyCommandsDir ? agent.legacyCommandPrefix : "");
    }

    // Prune productfoo-managed command files whose id has left FOO_COMMANDS, so a
    // demoted command does not linger in the harness menu after re-setup.
    const dir = path.join(base, target.dir);
    for (const id of state.stale) {
      const file = commandFilePath(dir, agent, target, id);
      if (isFooManagedCommand(file)) unlinkSync(file);
    }

    const manifest = pluginManifestPath(base, agent);
    if (manifest) {
      mkdirSync(path.dirname(manifest), { recursive: true });
      writeFileSync(manifest, pluginManifestForAgent(agent));
    }

    mkdirSync(dir, { recursive: true });
    const harnessCommands = commandsForHarness(agent);
    for (const id of harnessCommands) {
      // R-004: launchers are disposable artifacts generated from the CLI
      // command contract — rerunning setup recreates them; a metadata change
      // flows into every adapter surface from one source.
      const file = commandFilePath(dir, agent, target, id);
      mkdirSync(path.dirname(file), { recursive: true });
      // grok-bot-foo-first-override-v0: Grok launchers get the productfoo-first override
      // block for spec/ideate/pitch/preview commands to beat generic coordinator
      // instructions (D-001, R-001).
      const content = agent.commandLayout === "skills" 
        ? renderPluginSkill(id) 
        : renderLauncher(showCommandContract(id), { grokFooFirst: agent.id === "grok" });
      writeFileSync(file, content);
    }

    const marketplaceName = ensurePersonalMarketplace(base, agent);
    if (agent.id === "codex" && marketplaceName && process.env.FOO_CODEX_PLUGIN_NO_INSTALL !== "1") {
      try {
        execFileSync("codex", ["plugin", "add", `${agent.plugin!.name}@${marketplaceName}`], { stdio: "pipe" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new UsageError(
            "Codex CLI disappeared during setup; restore it on PATH, then rerun `foo agent setup --agent codex --scope global --yes`",
          );
        }
        throw error;
      }
    }
  }
}

// install-once-wire-all, ask-first (#913, #622): an installed client offers to
// wire its harness command launchers once, names the agents it will touch, and
// remembers the answer in ~/.foo/harness-wired.json:
//   - the question defaults to yes (owner decision, #913): Enter sets up the
//     named agents; only an explicit n/no declines.
//   - consent "yes": the agents are wired, and after an upgrade (stamped version
//     differs) those same agents are refreshed without asking again — the
//     person already said yes to exactly them.
//   - consent "no": never asked again; `foo agent setup` is always there.
//   - no stamp and nobody at a terminal (an agent-invoked or piped run): nothing
//     is written and nothing is stamped, so the question waits for a person.
// Which agents: the profile's harnesses (the first-run survey answer — asked,
// so it must drive something), else every supported agent. Codex is set up
// through its own CLI (`foo agent setup --agent codex`), never silently.
// Guarantees that keep it safe on the hot path:
//   - installs only: a source checkout manages its own harnesses (isSourceCheckout,
//     the same test `foo update` uses — bundled skills no longer read as a checkout).
//   - opt-out: FOO_NO_AUTOWIRE=1.
//   - idempotent + conflict-safe: reuses applyAgentSetup, which only touches
//     productfoo-managed files and refuses to overwrite a user's own command.
//   - best-effort: the caller wraps this in try/catch so it can NEVER break a command.
const HARNESS_STAMP_REL = path.join(".foo", "harness-wired.json");

export function harnessStampPath(home: string): string {
  return path.join(home, HARNESS_STAMP_REL);
}

type HarnessStamp = { version?: string; agents?: string[]; consent?: "yes" | "no" };

export type AutoWireResult =
  | { reason: "first-run" | "upgrade"; wired: string[] }
  | { reason: "declined"; wired: []; offered: string[] };

export type AutoWireOptions = {
  home?: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Harness ids the person named (profile), in order. Empty = every supported agent. */
  preferred?: readonly string[];
  /** Asks the person; resolves true unless they explicitly decline (Enter = yes). Absent = nobody to ask. */
  ask?: (question: string) => Promise<boolean>;
};

/** The agents an offer would touch: the preferred ones productfoo can wire globally,
 *  else every supported agent (Codex excluded — it is set up through its CLI). */
export function autoWireAgents(preferred: readonly string[] = []): AgentDefinition[] {
  const eligible = selectAgents("all").filter((agent) => agent.id !== "codex" && resolveHarnessCommandTarget(agent, "global").supported);
  const chosen = preferred.length ? eligible.filter((agent) => preferred.includes(agent.id)) : eligible;
  return chosen;
}

export async function maybeAutoWireHarnesses(version: string, opts: AutoWireOptions = {}): Promise<AutoWireResult | null> {
  const env = opts.env ?? process.env;
  if ((env.FOO_NO_AUTOWIRE ?? "").trim() === "1") return null;
  if (isSourceCheckout(opts.packageRoot ?? ROOT)) return null;

  const home = opts.home ?? targetBaseForScope("global");
  const stampPath = harnessStampPath(home);
  let stamp: HarnessStamp | null = null;
  try {
    stamp = readJson<HarnessStamp>(stampPath);
  } catch {
    stamp = null; // no stamp yet (fresh install)
  }
  const writeStamp = (next: HarnessStamp) => {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, `${JSON.stringify({ ...next, at: new Date().toISOString() }, null, 2)}\n`);
  };

  if (stamp?.consent === "no") return null; // they said no; foo agent setup is theirs to run
  if (stamp && stamp.version === version) return null; // already wired for this exact version — fast path

  if (stamp) {
    // Upgrade: refresh exactly what was consented to. A stamp written before
    // ask-first existed (no consent field) came from an alpha install that was
    // wired then; keep refreshing its agents rather than asking a returning tester.
    const agents = stamp.agents?.length
      ? selectAgents("all").filter((agent) => stamp!.agents!.includes(agent.id))
      : autoWireAgents();
    applyAgentSetup(home, agents, "global"); // may throw on a user conflict — caller catches
    const wired = agents.map((agent) => agent.id);
    writeStamp({ version, agents: wired, consent: "yes" });
    return { reason: "upgrade", wired };
  }

  // First run: ask, or wait for someone who can answer.
  if (!opts.ask) return null;
  const agents = autoWireAgents(opts.preferred ?? []);
  if (agents.length === 0) return null;
  const names = agents.map((agent) => agent.label);
  const yes = await opts.ask(`Set up productfoo's commands in ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}? [Y/n] `);
  if (!yes) {
    writeStamp({ version, agents: [], consent: "no" });
    return { reason: "declined", wired: [], offered: agents.map((agent) => agent.id) };
  }
  applyAgentSetup(home, agents, "global");
  const wired = agents.map((agent) => agent.id);
  writeStamp({ version, agents: wired, consent: "yes" });
  return { reason: "first-run", wired };
}

/** The one line each auto-wire outcome prints (#913). */
export function autoWireMessage(outcome: { reason: "first-run" | "upgrade" | "declined"; wired: readonly string[] }): string {
  if (outcome.reason === "declined") {
    return "Okay — foo won't set up your coding agents. Any time: foo agent setup --agent all --scope global --yes\n";
  }
  return `foo set up its slash-commands in your coding agents (${outcome.wired.join(", ")})${outcome.reason === "upgrade" ? " after the upgrade" : ""} — reopen your agent to see the /foo-* commands. (disable: FOO_NO_AUTOWIRE=1)\n`;
}

function renderAgentSetup(args: string[]): string {
  const options = parseAgentOptions(args);
  assertCanonicalCommandSources();
  const base = targetBaseForScope(options.scope);
  const selectedAgents = selectAgents(options.agent);
  const changes = agentSetupChanges(base, selectedAgents, options.scope);
  const hasConflict = changes.some((change) => change.action === "conflict");

  const payload = {
    schema_version: "0.1",
    status: options.dryRun ? "dry_run" : "applied",
    scope: options.scope,
    base,
    agents: selectedAgents.map((agent) => agent.id),
    commands: [...FOO_COMMANDS],
    routing_contract: FOO_ROUTING_CONTRACT,
    changes,
    human_handoff: {
      reason: "Review command adapter changes before writing files.",
      resume_command: `foo agent setup --agent ${options.agent} --scope ${options.scope} --yes`,
    },
  };

  if (!options.dryRun && !options.yes) {
    throw new UsageError("agent setup writes command files; rerun with --dry-run or --yes", "E_BAD_FLAG");
  }

  if (!options.dryRun) applyAgentSetup(base, selectedAgents, options.scope);

  if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

  // Show the commands exactly as the user will type them in that harness, so the
  // setup summary and `agent status` can never disagree about the name.
  const named = (change: AgentSetupChange): string => {
    const agent = AGENT_DEFINITIONS.find((candidate) => candidate.id === change.agent);
    if (!agent) return change.commands.join(", ");
    return change.commands.map((command) => typedCommand(agent, command).replace(/^\//, "")).join(", ");
  };

  const describe = (change: AgentSetupChange): string => {
    if (change.action === "unsupported") {
      return `unsupported: ${change.agent} — ${change.unsupported_reason ?? "no command surface for this scope"}`;
    }
    if (change.action === "conflict") {
      return `conflict: ${change.agent} ${change.conflicts.join(", ")} (not productfoo-managed)`;
    }
    if (change.action === "repair-legacy") {
      const removed = [...change.legacy, ...change.stale.map((id) => `${id}.md`)].join(", ");
      return `repair-legacy: ${change.agent} remove ${removed}, install ${named(change)} -> ${change.command_path}`;
    }
    if (change.action === "verify-existing") {
      return `verify-existing: ${change.agent} ${named(change)} -> ${change.command_path}`;
    }
    return `install-commands: ${change.agent} ${named(change)} -> ${change.command_path}`;
  };

  const lines = [
    options.dryRun ? "foo agent setup dry run" : "foo agent setup applied",
    "",
    ...changes.map(describe),
    "",
  ];

  if (hasConflict && options.dryRun) {
    lines.push("Some agents have conflicting command files; resolve them before applying.", "");
  }
  if (options.dryRun) lines.push(`Next: ${payload.human_handoff.resume_command}`, "");

  return lines.join("\n");
}

function relativeAgentLogPath(): string {
  return "~/.foo/agent-events.jsonl";
}

function relativeAgentTelemetryConfigPath(): string {
  return "~/.foo/telemetry.json (tester id, machine-wide) · .foo/telemetry.json (per-repo opt-out)";
}

function readAgentEvents(root: string): LedgerEvent[] {
  const logPath = agentLogPath(root);
  if (!existsSync(logPath)) return [];

  // A malformed ledger line is skipped, not fatal: the ledger is append-only
  // and one corrupt write must not brick `foo agent logs|rate|telemetry`.
  const events: LedgerEvent[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LedgerEvent);
    } catch {
      continue;
    }
  }
  return events;
}

// Experience readers must partition by event_type so the per-invocation
// cli_usage firehose never dilutes the curated experience ledger (R-018).
function experienceEvents(events: LedgerEvent[]): AgentExperienceEvent[] {
  return events.filter((event): event is AgentExperienceEvent => event.event_type === "agent_experience");
}

function usageEvents(events: LedgerEvent[]): CliUsageEvent[] {
  return events.filter((event): event is CliUsageEvent => event.event_type === "cli_usage");
}

function ratingEvents(events: LedgerEvent[]): AgentRatingEvent[] {
  return events.filter((event): event is AgentRatingEvent => event.event_type === "rating");
}

function agentLogExists(root: string): boolean {
  return existsSync(agentLogPath(root));
}

function agentTelemetryPayload(root: string) {
  const { config, exists } = readAgentTelemetryConfig(root);
  return {
    schema_version: "0.1",
    enabled: config.enabled,
    tester_id: resolveTesterId(root) ?? null,
    default_state: "enabled",
    config_path: relativeAgentTelemetryConfigPath(),
    config_exists: exists,
    storage: "local",
    network_requests: [],
    disclosure: "Usage logs, profile answers, ratings, and diagnostic reports stay on this machine. Local usage logging is enabled by default and can be disabled. Explicit experience summaries and diagnostic reports can contain sensitive text; inspect them before sharing. Bundled skills load from the installed package. Update checks and provider operations have their own network behavior and settings; your coding agent may use external tools and incur charges.",
    captures: ["command family and version", "exit status and bounded error code", "duration", "packet identifier when present", "local installation identifier", "terminal interactivity", "explicit experience summaries and ratings", "bounded profile picks"],
    excludes: ["raw command arguments in usage events", "error messages and stack traces in usage events", "free-text profile answers in usage events"],
    opt_out_command: "foo agent telemetry disable",
  };
}

function summarizeAgentEvents(events: AgentExperienceEvent[]) {
  const counts = {
    failure: events.filter((event) => event.kind === "failure").length,
    poor_experience: events.filter((event) => event.kind === "poor_experience").length,
    good_experience: events.filter((event) => event.kind === "good_experience").length,
  };
  const agentIds = [...new Set(events.map((event) => event.source?.agent ?? event.agent).filter(Boolean))].sort();
  const byAgent = Object.fromEntries(
    agentIds.map((agent) => [
      agent,
      {
        failure: events.filter((event) => (event.source?.agent ?? event.agent) === agent && event.kind === "failure").length,
        poor_experience: events.filter(
          (event) => (event.source?.agent ?? event.agent) === agent && event.kind === "poor_experience",
        ).length,
        good_experience: events.filter(
          (event) => (event.source?.agent ?? event.agent) === agent && event.kind === "good_experience",
        ).length,
      },
    ]),
  );

  return {
    counts,
    analytics: {
      schema_version: "0.1",
      total_events: events.length,
      by_agent: byAgent,
    },
  };
}

// Usage rollup answers "which commands run / fail most" without touching the
// experience ledger's signal. Groups by command and exit code (R-018).
function summarizeUsageEvents(events: CliUsageEvent[]) {
  const byCommand: Record<string, { runs: number; failures: number; by_exit_code: Record<string, number> }> = {};
  for (const event of events) {
    const key = event.command || event.domain || "unknown";
    const slot = (byCommand[key] ??= { runs: 0, failures: 0, by_exit_code: {} });
    slot.runs += 1;
    if (event.exit_code !== 0) slot.failures += 1;
    const codeKey = String(event.exit_code);
    slot.by_exit_code[codeKey] = (slot.by_exit_code[codeKey] ?? 0) + 1;
  }

  return {
    schema_version: "0.1" as const,
    total: events.length,
    by_command: byCommand,
  };
}

// T-010 (spec-after-capture-v0): the load-bearing pull-through metric. Counts how
// many `foo spec from` runs were each followed by a `foo asp reconcile` run — the
// developer advancing into the loop rather than treating the one-shot drift report
// as done. V0a proxy: a same-log greedy sequential match by timestamp; coarse
// until V0b writes spec ids that tie a reconcile to the exact spec it reconciles.
export function specAfterPullThrough(events: ReadonlyArray<{ command: string; timestamp: string }>): {
  spec_from_runs: number;
  reconcile_runs: number;
  pulled_through: number;
  rate: number | null;
} {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let openSpecFrom = 0;
  let specFromRuns = 0;
  let reconcileRuns = 0;
  let pulled = 0;
  for (const event of sorted) {
    if (event.command === "spec from") {
      specFromRuns += 1;
      openSpecFrom += 1;
    } else if (event.command === "asp reconcile") {
      reconcileRuns += 1;
      if (openSpecFrom > 0) {
        pulled += 1;
        openSpecFrom -= 1;
      }
    }
  }
  return {
    spec_from_runs: specFromRuns,
    reconcile_runs: reconcileRuns,
    pulled_through: pulled,
    rate: specFromRuns > 0 ? Math.round((pulled / specFromRuns) * 100) / 100 : null,
  };
}

// Averages 1-7 ratings by field and by checkpoint (R-010/R-012, C-002/C-006) and
// counts low-rating reroute follow-ups (R-011, C-004). No raw prompt text.
function summarizeRatingEvents(events: AgentRatingEvent[]) {
  const round = (sum: number, count: number) => Math.round((sum / count) * 100) / 100;
  const fieldSum: Record<string, { sum: number; count: number }> = {};
  const byCheckpoint: Record<string, { count: number; fields: Record<string, { sum: number; count: number }> }> = {};

  for (const event of events) {
    const slot = (byCheckpoint[event.checkpoint] ??= { count: 0, fields: {} });
    slot.count += 1;
    for (const [field, value] of Object.entries(event.ratings)) {
      (fieldSum[field] ??= { sum: 0, count: 0 });
      fieldSum[field].sum += value;
      fieldSum[field].count += 1;
      (slot.fields[field] ??= { sum: 0, count: 0 });
      slot.fields[field].sum += value;
      slot.fields[field].count += 1;
    }
  }

  return {
    schema_version: "0.1" as const,
    total: events.length,
    reroute_required: events.filter((event) => event.reroute.required).length,
    average_by_field: Object.fromEntries(
      Object.entries(fieldSum).map(([field, { sum, count }]) => [field, round(sum, count)]),
    ),
    by_checkpoint: Object.fromEntries(
      Object.entries(byCheckpoint).map(([checkpoint, { count, fields }]) => [
        checkpoint,
        {
          count,
          average_by_field: Object.fromEntries(
            Object.entries(fields).map(([field, { sum, count: fieldCount }]) => [field, round(sum, fieldCount)]),
          ),
        },
      ]),
    ),
  };
}

function renderAgentLog(root: string, args: string[]): string {
  const options = parseAgentLogOptions(args);
  const promptMode = options.includePrompt
    ? "raw"
    : options.promptMode ?? (options.promptSummary ? "summary" : "metadata");
  const promptCaptured = promptMode === "raw" && Boolean(options.prompt);
  // T-004 (R-005): never store a raw secret. Redact the captured prompt before
  // it lands in the local ledger; the receipt reports what was scrubbed. A
  // secret-free prompt passes through unchanged (redactions = 0).
  const redaction = promptCaptured ? redactText(options.prompt as string, { allowlist: loadRepoAllowlist(root) }) : null;
  const event: AgentExperienceEvent = {
    schema_version: "0.1",
    event_type: "agent_experience",
    id: nextAgentEventId(),
    timestamp: new Date().toISOString(),
    kind: options.kind,
    summary: options.summary,
    agent: options.agent,
    packet: options.packet,
    command: options.command,
    prompt_captured: promptCaptured,
    ...(redaction ? { prompt: redaction.redactedText } : {}),
    source: {
      agent: options.agent,
      packet: options.packet,
      command: options.command,
    },
    prompt_context: {
      mode: promptMode,
      captured: promptCaptured,
      ...(redaction && redaction.receipt.redactions > 0 ? { redactions: redaction.receipt.redactions } : {}),
      ...(options.promptSummary ? { summary: options.promptSummary } : {}),
    },
  };

  // One append per event, size-cap rotation (cli-performance-v0 R-004).
  appendLedgerEvent(agentLogPath(root), `${JSON.stringify(event)}\n`);

  if (options.format === "json") return `${JSON.stringify(event, null, 2)}\n`;

  return [
    "foo agent log recorded",
    "",
    `Kind: ${event.kind}`,
    `Summary: ${event.summary}`,
    `Prompt captured: ${event.prompt_captured ? "yes" : "no"}`,
    ...(redaction ? [`Prompt redactions: ${redaction.receipt.redactions} (secret values scrubbed before storage; R-007)`] : []),
    `Path: ${relativeAgentLogPath()}`,
    "",
  ].join("\n");
}

function parseRateKeyValue(arg: string, raw: string | undefined): [string, string] {
  if (!raw) throw new UsageError(`${arg} requires a <key>=<value>`, "E_BAD_FLAG");
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new UsageError(`${arg} expects <key>=<value>, got: ${raw}`, "E_BAD_FLAG");
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function parseAgentRateOptions(args: string[]): AgentRateOptions {
  const options: AgentRateOptions = {
    checkpoint: "",
    ratings: {},
    qualitative: {},
    format: "text",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.format = "json";
      continue;
    }

    if (arg === "--rating") {
      const [field, value] = parseRateKeyValue(arg, args[index + 1]);
      if (!(RATING_FIELDS as readonly string[]).includes(field)) {
        throw new UsageError(`unknown rating field: ${field} (allowed: ${RATING_FIELDS.join(", ")})`, "E_BAD_FLAG");
      }
      if (!/^[1-7]$/.test(value)) throw new UsageError(`--rating ${field} must be an integer 1-7, got: ${value}`, "E_BAD_FLAG");
      options.ratings[field] = Number(value);
      index += 1;
      continue;
    }

    if (arg === "--note") {
      const [key, value] = parseRateKeyValue(arg, args[index + 1]);
      options.qualitative[key] = value;
      index += 1;
      continue;
    }

    if (
      ["--checkpoint", "--baseline-mode", "--lift-drivers", "--agent", "--packet", "--commit", "--artifact", "--reroute"].includes(
        arg,
      )
    ) {
      const value = args[index + 1];
      if (!value) throw new UsageError(`${arg} requires a value`, "E_BAD_FLAG");
      if (arg === "--checkpoint") options.checkpoint = value;
      if (arg === "--baseline-mode") options.baselineMode = value;
      if (arg === "--lift-drivers") options.liftDrivers = value;
      if (arg === "--agent") options.agent = value;
      if (arg === "--packet") options.packet = value;
      if (arg === "--commit") options.commit = value;
      if (arg === "--artifact") options.artifact = value;
      if (arg === "--reroute") {
        if (!(REROUTE_CHOICES as readonly string[]).includes(value)) {
          throw new UsageError(`--reroute must be one of: ${REROUTE_CHOICES.join(", ")}`, "E_BAD_FLAG");
        }
        options.reroute = value;
      }
      index += 1;
      continue;
    }

    throw new UsageError(`unknown agent rate argument: ${arg}`, "E_BAD_FLAG");
  }

  if (!options.checkpoint) throw new UsageError("--checkpoint is required", "E_BAD_FLAG");
  if (Object.keys(options.ratings).length === 0) {
    throw new UsageError("at least one --rating <field>=<1-7> is required", "E_BAD_FLAG");
  }

  return options;
}

// `foo agent rate` records product-management (R-010) and design/workflow (R-012)
// ratings at a checkpoint. A rating of 3 or lower flags a reroute follow-up but
// never restarts a loop automatically — the user records the choice (R-011, C-004).
function renderAgentRate(root: string, args: string[]): string {
  const options = parseAgentRateOptions(args);
  const lowRating = Object.values(options.ratings).some((value) => value <= 3);
  const event: AgentRatingEvent = {
    schema_version: "0.1",
    event_type: "rating",
    id: nextAgentEventId(),
    timestamp: new Date().toISOString(),
    checkpoint: options.checkpoint,
    ratings: options.ratings,
    qualitative: options.qualitative,
    ...(options.baselineMode ? { baseline_mode: options.baselineMode } : {}),
    ...(options.liftDrivers ? { lift_drivers: options.liftDrivers } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.packet ? { packet_ref: options.packet } : {}),
    ...(options.commit ? { commit_ref: options.commit } : {}),
    ...(options.artifact ? { artifact_ref: options.artifact } : {}),
    reroute: { required: lowRating, choice: options.reroute ?? null },
    source: { agent: options.agent, checkpoint: options.checkpoint },
  };

  // One append per event, size-cap rotation (cli-performance-v0 R-004).
  appendLedgerEvent(agentLogPath(root), `${JSON.stringify(event)}\n`);

  if (options.format === "json") return `${JSON.stringify(event, null, 2)}\n`;

  const needsRerouteChoice = event.reroute.required && !event.reroute.choice;
  return [
    "foo agent rating recorded",
    "",
    `Checkpoint: ${event.checkpoint}`,
    `Ratings: ${Object.entries(event.ratings).map(([field, value]) => `${field}=${value}`).join(", ")}`,
    `Reroute required: ${event.reroute.required ? "yes" : "no"}${event.reroute.choice ? ` (choice: ${event.reroute.choice})` : ""}`,
    ...(needsRerouteChoice
      ? [
          "",
          "A rating of 3 or lower was recorded. productfoo will not reroute automatically.",
          "Record your choice: re-run with --reroute spec|review|artifact|none",
        ]
      : []),
    `Path: ${relativeAgentLogPath()}`,
    "",
  ].join("\n");
}

function renderAgentLogs(root: string, args: string[]): string {
  if (args[0] === "sync") throw new UsageError("Log sync is not available. Logs stay local; use foo agent logs --json to inspect them.", "E_BAD_FLAG");

  const options = parseAgentLogsOptions(args);
  const all = readAgentEvents(root);
  const logExists = agentLogExists(root);

  if (options.usage) {
    const usageList = usageEvents(all);
    const usage = summarizeUsageEvents(usageList);
    const pullThrough = specAfterPullThrough(usageList);
    const payload = {
      schema_version: "0.1",
      log_path: relativeAgentLogPath(),
      log_exists: logExists,
      usage_count: usage.total,
      by_command: usage.by_command,
      spec_after_pull_through: pullThrough,
    };

    if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

    const rows = Object.entries(usage.by_command)
      .sort((a, b) => b[1].runs - a[1].runs)
      .map(([command, stat]) => `${command}: ${stat.runs} run(s), ${stat.failures} failure(s)`);
    const pullThroughLine =
      pullThrough.spec_from_runs > 0
        ? [
            "",
            `spec-after pull-through: ${pullThrough.pulled_through}/${pullThrough.spec_from_runs} ` +
              `\`foo spec from\` run(s) advanced into \`foo asp reconcile\` (rate ${pullThrough.rate}).`,
          ]
        : [];
    return [
      "foo agent usage",
      "",
      `Path: ${payload.log_path}`,
      `Invocations: ${usage.total}`,
      ...(rows.length ? ["", ...rows] : ["", "No CLI usage events recorded yet."]),
      ...pullThroughLine,
      "",
    ].join("\n");
  }

  if (options.ratings) {
    const summary = summarizeRatingEvents(ratingEvents(all));
    const payload = {
      schema_version: "0.1",
      log_path: relativeAgentLogPath(),
      log_exists: logExists,
      rating_count: summary.total,
      reroute_required: summary.reroute_required,
      average_by_field: summary.average_by_field,
      by_checkpoint: summary.by_checkpoint,
    };

    if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

    const rows = Object.entries(summary.average_by_field).map(([field, avg]) => `${field}: ${avg}`);
    return [
      "foo agent ratings",
      "",
      `Path: ${payload.log_path}`,
      `Ratings: ${summary.total} (reroute follow-ups: ${summary.reroute_required})`,
      ...(rows.length ? ["", "Average by field:", ...rows] : ["", "No ratings recorded yet."]),
      "",
    ].join("\n");
  }

  const events = experienceEvents(all);
  const { counts, analytics } = summarizeAgentEvents(events);
  const payload = {
    schema_version: "0.1",
    log_path: relativeAgentLogPath(),
    log_exists: logExists,
    counts,
    analytics,
    events,
  };

  if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

  return [
    "foo agent logs",
    "",
    `Path: ${payload.log_path}`,
    `Failures: ${counts.failure}`,
    `Poor experiences: ${counts.poor_experience}`,
    `Good experiences: ${counts.good_experience}`,
    ...(events.length
      ? []
      : [
          "",
          "No local agent experience events recorded yet.",
          'Start one with: foo agent log --kind good_experience --summary "..." --agent codex',
        ]),
    "",
  ].join("\n");
}

function renderAgentTelemetry(root: string, command: string | undefined, args: string[]): string {
  if (!command) throw new UsageError("agent telemetry command missing", "E_COMMAND_MISSING");
  // `set-id <id>` takes a positional; keep it out of the flag parser.
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const options = parseAgentTelemetryOptions(args.filter((arg) => arg.startsWith("--")));

  const projectCurrent = readTelemetryFile(agentTelemetryConfigPath(root)).config;
  if (command === "enable") writeAgentTelemetryConfig(root, { ...projectCurrent, enabled: true });
  else if (command === "disable") writeAgentTelemetryConfig(root, { ...projectCurrent, enabled: false });
  else if (command === "set-id") {
    const id = positionals[0]?.trim();
    if (!id) throw new UsageError("usage: foo agent telemetry set-id <id>", "E_BAD_FLAG");
    writeMachineTesterId(id);
  } else if (command === "reset-id") {
    writeMachineTesterId(generateTesterId());
  } else if (command !== "status") {
    throw new UsageError(`unknown agent telemetry command: ${command}`, "E_BAD_FLAG");
  }

  const payload = agentTelemetryPayload(root);
  if (options.format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

  return [
    "foo local usage logging", "",
    `Enabled: ${payload.enabled ? "yes" : "no"}`,
    `Local installation id: ${payload.tester_id ?? "(none — logging off)"}`,
    `Config: ${payload.config_path}`,
    payload.disclosure, "",
    `Recorded locally: ${payload.captures.join(", ")}`,
    `Excluded from usage events: ${payload.excludes.join(", ")}`,
    `Opt out: ${payload.opt_out_command}`, "",
  ].join("\n");
}

export function runAgentCommand(root: string, command: string | undefined, args: string[]): string {
  if (!command) throw new UsageError("agent command missing", "E_COMMAND_MISSING");

  if (command === "status") return renderAgentStatus(parseAgentOptions(args));
  if (command === "doctor") return renderAgentDoctor();
  if (command === "setup") return renderAgentSetup(args);
  if (command === "log") return renderAgentLog(root, args);
  if (command === "rate") return renderAgentRate(root, args);
  if (command === "logs") return renderAgentLogs(root, args);
  if (command === "telemetry") return renderAgentTelemetry(root, args[0], args.slice(1));

  throw new UsageError(`unknown agent command: ${command}`, "E_BAD_FLAG");
}
