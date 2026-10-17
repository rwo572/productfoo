// Cross-agent runtime registry for portable routines (portable-routines-v0).
//
// A routine's *contract* is canonical and runtime-neutral (purpose, observation
// source, allowed actions, verification check, terminal states, approval
// boundaries — see routines.ts). What differs per coding agent is only the
// *binding*: how a schedule is armed, and how that agent is invoked headless for
// one pass. This registry is that binding, kept in one place so adding a runtime
// is a data edit, not a code change.
//
// productfoo never runs a scheduler itself. It validates the canonical contract and
// emits the per-runtime binding artifact (a crontab line, a CI workflow, a
// `.claude`/`.codex` descriptor). The runtime's own scheduler fires it; each
// pass writes its iteration record back into the packet ledger, so the loop's
// output stays runtime-neutral no matter who ran it.

export type RuntimeId =
  | "claude"
  | "codex"
  | "cursor"
  | "github-actions";

export type AdapterSupport = "supported" | "planned";

export type TriggerKind = "manual" | "schedule" | "event";

export interface AgentAdapter {
  id: RuntimeId;
  label: string;
  /** supported = productfoo can emit a working binding today; planned = mapped, not yet emitted. */
  support: AdapterSupport;
  /** Runtime config home, where a committed binding would live. null when external (e.g. CI). */
  config_dir: string | null;
  /** Can this runtime run one routine pass non-interactively? Required for any unattended trigger. */
  can_run_headless: boolean;
  /** Trigger kinds this runtime can arm natively. */
  trigger_mechanisms: TriggerKind[];
  /**
   * Headless invocation template for one pass. {prompt} is the routine's pass
   * instruction; {packet} is the packet dir. null when the runtime cannot yet
   * be driven headless. Templates are illustrative bindings, not a promise the
   * binary exists on PATH — the emitted artifact is reviewed before it is armed.
   */
  invoke_template: string | null;
  /** What we would need to fit this runtime fully (the honest gap). */
  notes: string;
}

// `unsupported` is a harness whose command surface is mapped honestly but NOT
// installed for this scope — a global-only harness at project scope, or a
// `planned` harness (unverified dir / un-emittable format). See D-002.
export type HarnessAdapterStatus = "ready" | "missing" | "drift" | "unsupported";

export type HarnessAdapterId =
  | "codex"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "grok";

// harness-command-dirs-v0 R-001: bindings vary in three dimensions the old
// single-string model could not express — directory, SCOPE, and file FORMAT.
export type HarnessCommandFormat = "markdown" | "toml";
export type HarnessCommandSupport = "supported" | "planned";

// Where a harness actually reads slash-commands, per install scope. Paths are
// relative to the scope base (the user's home for `global`, the repo root for
// `project`). A `null` scope means the harness has no directory there — e.g.
// Codex is global-only (`project: null`).
export interface HarnessCommandDirs {
  global: string | null;
  project: string | null;
}

export interface HarnessCommandAdapter {
  id: HarnessAdapterId;
  label: string;
  /** The real per-scope command directories. Replaces the aspirational shared `.agents/commands`. */
  commandsDir: HarnessCommandDirs;
  /** Filename extension for emitted command files: ".md" | ".prompt.md" | ".toml". */
  commandExtension: string;
  /** Content format productfoo must emit. "markdown" ships today; "toml" is not yet emittable. */
  commandFormat: HarnessCommandFormat;
  /** Plugin skills use <id>/SKILL.md instead of flat command files. */
  commandLayout?: "flat" | "skills";
  /**
   * Command-surface support (D-002): "supported" = directory AND format are
   * verified and emittable; "planned" = mapped honestly but NOT installed
   * (unverified dir or un-emittable format). `unsupportedReason` names the gap.
   */
  support: HarnessCommandSupport;
  unsupportedReason?: string;
  /**
   * Flat (non-plugin) harnesses prefix productfoo's commands (e.g. `foo-spec`) so they
   * group together and cannot collide with a user's own `/spec`. Plugin harnesses
   * namespace instead and leave this unset.
   */
  commandPrefix?: string;
  /**
   * Setup/readiness path for the command surface. This is an adapter surface,
   * not a productfoo core dependency; unknown harnesses can still call `foo` directly.
   */
  projectPath: string;
  /**
   * Namespaced command wrapper, when a harness supports a plugin-like command
   * surface. Plain command adapters leave this unset and use the `commandPrefix`
   * convention instead.
   */
  plugin?: { dir: string; name: string; manifestRelPath: string };
  /** Personal Codex marketplace entry required to install this plugin. */
  marketplace?: { manifestRelPath: string; name: string };
  /**
   * Directory-derived namespace: the harness types commands as /<ns>:<id>
   * because they live in a subdirectory named <ns> of its native commands dir
   * (no plugin, no registration). Mutually exclusive with `plugin`.
   */
  commandNamespace?: string;
  /**
   * Namespace the HARNESS imposes in its own slash menu, independent of where
   * the files sit. Unlike `commandNamespace`, this never affects a path.
   * Retained for flat adapters that impose their own menu namespace.
   */
  invocationNamespace?: string;
  /**
   * Commands to exclude from this harness (e.g., "bug" for third-party bots).
   * When set, setup skips these command IDs for this adapter only.
   */
  excludedCommands?: readonly string[];
  /**
   * Paths written by older productfoo adapter versions. Setup removes only productfoo-managed
   * files/symlinks at these paths so harness-specific shims do not leak into
   * the core contract.
   */
  legacyPaths: string[];
  legacyCommandsDir?: string;
  legacyCommandPrefix?: string;
  /** A retired plugin install dir (manifest + commands) that setup migrates away from. */
  legacyPluginDir?: string;
}

// The resolved answer to "where + what do I write for this harness at this
// scope, or why can't I?" — the single source of truth every consumer uses so
// no code path re-derives a directory (that divergence was the original bug).
export type HarnessCommandTarget =
  | { supported: true; dir: string; extension: string; format: HarnessCommandFormat; prefix: string }
  | { supported: false; reason: string };

export function resolveHarnessCommandTarget(
  adapter: HarnessCommandAdapter,
  scope: "global" | "project",
): HarnessCommandTarget {
  if (adapter.support === "planned") {
    return { supported: false, reason: adapter.unsupportedReason ?? `${adapter.label} command surface not yet supported` };
  }
  const dir = scope === "global" ? adapter.commandsDir.global : adapter.commandsDir.project;
  if (dir == null) {
    return { supported: false, reason: `${adapter.label} has no ${scope}-scope command directory` };
  }
  return { supported: true, dir, extension: adapter.commandExtension, format: adapter.commandFormat, prefix: adapter.commandPrefix ?? "" };
}

// Claude and Codex are the two supported runtimes for V0; the rest are mapped
// with the concrete gap so "what else we'd want to fit for" is explicit, not lost.
export const AGENT_ADAPTERS: Record<RuntimeId, AgentAdapter> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    support: "supported",
    config_dir: ".claude",
    can_run_headless: true,
    trigger_mechanisms: ["manual", "schedule", "event"],
    // Headless one-shot, least-privilege by default: -p runs non-interactively
    // and exits, with normal permission prompts intact. Raising autonomy
    // (acceptEdits / skip-permissions) for an unattended routine is a deliberate
    // opt-in, never the emitted default (foo-roast Agent-Safety finding).
    invoke_template: 'claude -p "{prompt}"',
    notes:
      "Schedule via the harness scheduler (cron) or the /loop skill; events via hooks. Pass --output-format json to capture the iteration record for the ledger. Raise autonomy explicitly if a routine truly needs unattended edits.",
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    support: "supported",
    config_dir: ".codex",
    can_run_headless: true,
    trigger_mechanisms: ["manual", "schedule"],
    // `codex exec` is Codex's non-interactive one-shot.
    invoke_template: 'codex exec "{prompt}"',
    notes:
      "Headless via `codex exec`. No first-party scheduler yet — arm the schedule with system cron or github-actions and let the binding invoke `codex exec`.",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    // A headless CLI now EXISTS — `cursor-agent -p "<prompt>"` — so the gap is no
    // longer "no CLI"; it is RELIABILITY. `-p` has documented hang / terminal-not-
    // released bugs (community reports, early 2026), which is precisely the B4
    // failure mode: an unattended loop that never returns. So `can_run_headless`
    // stays false until `-p` reliability is confirmed on a pinned version. First-
    // class on the command surface (HARNESS_COMMAND_ADAPTERS); gated as an
    // UNATTENDED runtime on purpose. (cursor.com/docs/cli/headless)
    support: "planned",
    config_dir: ".cursor",
    can_run_headless: false,
    trigger_mechanisms: ["manual"],
    invoke_template: null,
    notes:
      "Headless CLI exists (`cursor-agent -p`), but `-p` has reported reliability issues (hangs / does not release the terminal) that make it unsafe to arm for unattended loops today. Promote `can_run_headless` once `-p` is confirmed reliable on a pinned version; until then run a watched one-shot manually, or arm via github-actions running a supported runtime.",
  },
  "github-actions": {
    id: "github-actions",
    label: "GitHub Actions",
    support: "planned",
    config_dir: ".github/workflows",
    can_run_headless: true,
    // CI is the strongest portable *scheduling substrate*: it can arm a cron and
    // then invoke ANY of the runtimes above in a job step.
    trigger_mechanisms: ["schedule", "event"],
    invoke_template: null,
    notes:
      "Meta-adapter: `on: schedule` (cron) or `on:` events host any runtime's headless invocation in a step. Best path to arm Codex on a cadence today; needs secrets handling and a committed workflow.",
  },
};

// Human command surfaces for `foo agent setup`. The canonical behavior lives in
// `commands/*.md` and the CLI; these descriptors only adapt that portable
// payload to a harness filesystem convention.
export const HARNESS_COMMAND_ADAPTERS: Record<HarnessAdapterId, HarnessCommandAdapter> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    // Claude Code namespaces slash commands by SUBDIRECTORY of its native
    // commands dir: .claude/commands/foo/spec.md is typed /foo:spec, loaded in
    // every session with zero registration. The earlier plugin install
    // (.claude/skills/foo/ + .claude-plugin/plugin.json) is retired: Claude
    // Code only loads plugins registered in its plugin manager or passed via
    // --plugin-dir, so the unregistered directory silently loaded nothing and
    // fresh sessions had no /foo:* commands at all.
    commandsDir: { global: ".claude/commands/foo", project: ".claude/commands/foo" },
    commandExtension: ".md",
    commandFormat: "markdown",
    support: "supported",
    commandNamespace: "foo",
    projectPath: ".claude/commands",
    legacyPaths: [".claude/skills"],
    legacyCommandsDir: ".claude/skills/foo/commands",
    legacyPluginDir: ".claude/skills/foo",
  },
  codex: {
    id: "codex",
    label: "Codex",
    // Current Codex App + CLI share the plugin substrate. A personal plugin is
    // the verified way to expose the SAME /foo:* namespace in both.
    commandsDir: { global: "plugins/foo/skills", project: null },
    commandExtension: ".md",
    commandFormat: "markdown",
    commandLayout: "skills",
    support: "supported",
    plugin: { dir: "plugins/foo", name: "foo", manifestRelPath: ".codex-plugin/plugin.json" },
    marketplace: { manifestRelPath: ".agents/plugins/marketplace.json", name: "personal" },
    projectPath: "plugins/foo",
    legacyPaths: [".agents/skills"],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    // ~/.config/opencode/commands (global) + .opencode/commands (project) — NOT .agents/.
    commandsDir: { global: ".config/opencode/commands", project: ".opencode/commands" },
    commandExtension: ".md",
    commandFormat: "markdown",
    support: "supported",
    commandPrefix: "foo-",
    projectPath: ".opencode/commands",
    legacyPaths: [".agents/skills"],
    legacyCommandsDir: ".agents/commands",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    // ~/.cursor/commands (global) + .cursor/commands (project); markdown, /-invoked.
    commandsDir: { global: ".cursor/commands", project: ".cursor/commands" },
    commandExtension: ".md",
    commandFormat: "markdown",
    support: "supported",
    commandPrefix: "foo-",
    projectPath: ".cursor/commands",
    legacyPaths: [".agents/skills"],
    legacyCommandsDir: ".agents/commands",
  },
  grok: {
    id: "grok",
    label: "Grok Bot",
    // Grok Bot command directory follows the common .grok/commands pattern.
    // D-001 (embedded invocation): bot skills embed command contract and call `foo <command>`.
    // D-002: eight commands only (init, spec, ideate, pitch, research, preview, roast, discovery) — bug excluded.
    commandsDir: { global: ".grok/commands", project: ".grok/commands" },
    commandExtension: ".md",
    commandFormat: "markdown",
    support: "supported",
    commandPrefix: "foo-",
    projectPath: ".grok/commands",
    excludedCommands: ["bug"], // D-002: exclude bug from third-party Grok Bot
    legacyPaths: [],
  },
};

export function getAdapter(id: string): AgentAdapter | undefined {
  return (AGENT_ADAPTERS as Record<string, AgentAdapter>)[id];
}

export function supportedRuntimes(): RuntimeId[] {
  return (Object.keys(AGENT_ADAPTERS) as RuntimeId[]).filter((id) => AGENT_ADAPTERS[id].support === "supported");
}

export function knownRuntimes(): RuntimeId[] {
  return Object.keys(AGENT_ADAPTERS) as RuntimeId[];
}

export function knownHarnessCommandAdapters(): HarnessAdapterId[] {
  return Object.keys(HARNESS_COMMAND_ADAPTERS) as HarnessAdapterId[];
}

export function getHarnessCommandAdapter(id: string): HarnessCommandAdapter | undefined {
  return (HARNESS_COMMAND_ADAPTERS as Record<string, HarnessCommandAdapter>)[id];
}
