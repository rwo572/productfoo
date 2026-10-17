// `foo doctor` and its --fix: install readiness, skills-bundle adapter checks,
// and the .githooks wiring status. Setup/repair of harness command files lives
// in the agent module (foo agent setup).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gitRun, gitRunOrNull } from "../gitRun.js";
import { readPackageVersion, ROOT } from "./shared.js";
import { HARNESS_GATES } from "../harnessGates.js";
import { AGENT_DEFINITIONS, agentCommandState, codexGlobalAdapterStatus, type AgentDefinition } from "./agent.js";
import {
  channelFreshness,
  distributionPackageName,
  type ChannelFreshness,
} from "../channelFreshness.js";
import { UPDATE_COMMAND, noticeAudience } from "../updateNotice.js";
import { firecrawlKeyStatus } from "./login.js";
import { resolveHarnessCommandTarget } from "../agentAdapters.js";
import { bundledSkillTreeVerified, inspectDevelopmentSkillTrust } from "../skillLocal.js";
import { BUNDLED_SKILL_TREE } from "../skillClientPolicy.js";
import { clientVersion } from "../updateNotice.js";

// Top-level `foo doctor` reports whether productfoo's skills-bundle adapter is present
// for each agent; the command/plugin layer is handled by `foo agent` instead.
function adapterStatus(
  root: string,
  homeRoot: string,
  agent: AgentDefinition,
): { scope: "project" | "global" | "unsupported"; resolvedPath: string; status: "ready" | "missing" | "drift" | "unsupported" } {
  const project = resolveHarnessCommandTarget(agent, "project");
  const global = resolveHarnessCommandTarget(agent, "global");
  const scope = project.supported ? "project" : global.supported ? "global" : "unsupported";
  if (scope === "unsupported") {
    const projectReason = project.supported ? null : project.reason;
    const globalReason = global.supported ? null : global.reason;
    return { scope, resolvedPath: `unsupported: ${projectReason ?? globalReason ?? "no supported command scope"}`, status: "unsupported" };
  }
  if (agent.id === "codex") {
    const codex = codexGlobalAdapterStatus(homeRoot);
    return { scope: "global", resolvedPath: codex.command_path, status: codex.status };
  }
  const base = scope === "global" ? homeRoot : root;
  const resolvedPath = path.join(base, agent.projectPath);
  if (existsSync(resolvedPath)) return { scope, resolvedPath, status: "ready" };
  // #930: first-run setup (#913) installs productfoo's commands in GLOBAL scope, in
  // the user's home, for every project. A project without its own copy is
  // still set up when productfoo's command files are installed globally, so report
  // that rather than "missing". The check looks for productfoo's own launchers,
  // never just a directory the user may use for their own commands.
  if (scope === "project" && global.supported && agentCommandState(homeRoot, agent, "global").installed.length > 0) {
    return { scope: "global", resolvedPath: path.join(homeRoot, global.dir), status: "ready" };
  }
  return { scope, resolvedPath, status: "missing" };
}

type HooksWiringState = "wired" | "unset-safe" | "conflict" | "no-dir";

// Pure decision: given whether .githooks exists and the current core.hooksPath,
// what should `foo doctor` do? Side-effect-free so it is unit-testable.
export function hooksWiringPlan(input: { dirPresent: boolean; currentHooksPath: string | null }): {
  state: HooksWiringState;
  wired: boolean;
} {
  if (!input.dirPresent) return { state: "no-dir", wired: false };
  const value = input.currentHooksPath;
  if (value === null || value === "") return { state: "unset-safe", wired: false };
  const normalized = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === ".githooks") return { state: "wired", wired: true };
  return { state: "conflict", wired: false };
}

// Hooks operate on the repo the user is in (cwd), not productfoo's install dir (root).
function repoRootFromCwd(): string | null {
  const out = gitRunOrNull(["rev-parse", "--show-toplevel"]);
  return out === null ? null : out.trim() || null;
}

function hooksStatus(): { dirPresent: boolean; currentHooksPath: string | null; state: HooksWiringState; wired: boolean } {
  const repo = repoRootFromCwd();
  if (!repo) return { dirPresent: false, currentHooksPath: null, ...hooksWiringPlan({ dirPresent: false, currentHooksPath: null }) };
  const dirPresent = existsSync(path.join(repo, ".githooks"));
  const configOut = gitRunOrNull(["-C", repo, "config", "--local", "core.hooksPath"]);
  const currentHooksPath = configOut === null ? null : configOut.trim() || null;
  return { dirPresent, currentHooksPath, ...hooksWiringPlan({ dirPresent, currentHooksPath }) };
}

export function wireHooks(): string {
  const repo = repoRootFromCwd();
  if (!repo) return "foo doctor --fix: not inside a git repository.\n";
  const status = hooksStatus();
  if (status.state === "no-dir") return "foo doctor --fix: no .githooks/ directory to wire.\n";
  if (status.state === "wired") return "foo doctor --fix: commit hooks already active (core.hooksPath -> .githooks).\n";
  if (status.state === "conflict") {
    return `foo doctor --fix: core.hooksPath is set to "${status.currentHooksPath}", not .githooks. ` +
      "Refusing to clobber a custom hooks path; set it yourself if intended: git config core.hooksPath .githooks\n";
  }
  const set = gitRun(["-C", repo, "config", "--local", "core.hooksPath", ".githooks"]);
  if (!set.ok) {
    return `foo doctor --fix: could not set core.hooksPath (${set.message}).\n`;
  }
  return "foo doctor --fix: wired core.hooksPath -> .githooks. productfoo's commit hooks (branch guard + spec-after keep-it nudge) are now active.\n";
}

function hooksDoctorLine(status: { state: HooksWiringState; currentHooksPath: string | null }): string {
  switch (status.state) {
    case "wired":
      return "Commit hooks: active (.githooks)";
    case "unset-safe":
      return "Commit hooks: present but not wired — run `foo doctor --fix`";
    case "conflict":
      return `Commit hooks: core.hooksPath set elsewhere (${status.currentHooksPath}) — wire .githooks manually if intended`;
    case "no-dir":
      return "Commit hooks: no .githooks/ directory";
  }
}

type BuildFreshnessState = "no-src" | "no-build" | "fresh" | "stale";

// Pure decision: given the newest source mtime and the compiled CLI's mtime,
// is the build the CLI is running from stale? Side-effect-free so it is
// unit-testable. `null` means the tree is absent — an npm install ships
// dist/ without src/, so "no-src" is the healthy installed state.
export function buildFreshnessPlan(input: { newestSrcMtimeMs: number | null; distMtimeMs: number | null }): {
  state: BuildFreshnessState;
  stale: boolean;
} {
  if (input.newestSrcMtimeMs === null) return { state: "no-src", stale: false };
  if (input.distMtimeMs === null) return { state: "no-build", stale: true };
  if (input.newestSrcMtimeMs > input.distMtimeMs) return { state: "stale", stale: true };
  return { state: "fresh", stale: false };
}

function newestSourceMtimeMs(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    let candidate: number | null = null;
    if (entry.isDirectory()) candidate = newestSourceMtimeMs(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) candidate = lstatSync(full).mtimeMs;
    if (candidate !== null && (newest === null || candidate > newest)) newest = candidate;
  }
  return newest;
}

// Compares productfoo's OWN src/ and dist/ (module-relative ROOT), never the cwd: a
// tester running doctor inside THEIR project (which has a src/ but no foo
// build) was told "run `npm run build`" about code that wasn't productfoo's.
function buildFreshnessStatus(selfRoot: string): { state: BuildFreshnessState; stale: boolean } {
  const distCli = path.join(selfRoot, "dist", "src", "cli.js");
  return buildFreshnessPlan({
    newestSrcMtimeMs: newestSourceMtimeMs(path.join(selfRoot, "src")),
    distMtimeMs: existsSync(distCli) ? lstatSync(distCli).mtimeMs : null,
  });
}

// Advisory signal, never a block: a stale build means `bin/foo` is silently
// running old code. Omitted entirely for npm installs (no src/ to compare).
function buildDoctorLine(status: { state: BuildFreshnessState }): string | null {
  switch (status.state) {
    case "no-src":
      return null;
    case "no-build":
      return "Build: src/ present but no compiled dist/src/cli.js — run `npm run build`";
    case "stale":
      return "Build: stale — src/ is newer than dist/, so the CLI is running old code. Run `npm run build`";
    case "fresh":
      return "Build: dist/ up to date with src/";
  }
}

// Advisory signal, never a block. Every install gets an answer: a tester on a
// stale build asked doctor what was wrong and doctor said nothing, because this
// line used to be gated on having a channel install — which only the owner has.
// "Nothing to update" is the one silent state, and only for a repo checkout with
// no channel beside it.
//
// The wording follows the install: an owner running the repo build is being told
// about a channel they know they have; a tester is being told about the client
// they are running. Neither should have to learn the other's vocabulary.
function channelDoctorLine(freshness: ChannelFreshness): string | null {
  // An installed client updates itself now — one word, and `foo update` installs
  // into whichever prefix it is actually running from (global npm, or the channel
  // dir the PATH shim execs). The exception is a REPO run: it is telling you about
  // a channel install that `bin/foo update` deliberately will not touch, so that
  // one still names the npm line that would fix it — pinned to the version the
  // check just read, in the tilde form the docs print. This is a display line,
  // not an argv; the executable form lives in commands/update.ts, which builds
  // it from the same contract (the package name is never re-hardcoded here).
  const channelRefreshDisplay = (): string | null => {
    if (!freshness.latest) return null; // only the "behind" state reaches this; keep the type honest
    return `npm install --prefix ~/.foo/versions/dist ${distributionPackageName()}@${freshness.latest}`;
  };
  const refresh = freshness.kind === "repo" ? channelRefreshDisplay() : UPDATE_COMMAND;
  if (freshness.kind === "repo") {
    switch (freshness.state) {
      case "no-channel":
        return null;
      case "current":
        return `Client: dist channel ${freshness.installed} — the newest published release`;
      case "unknown":
        return `Client: dist channel ${freshness.installed} — could not check npm for a newer release, so one may exist`;
      case "behind":
        return refresh
          ? `Client: dist channel ${freshness.installed} is behind the published ${freshness.latest} — bare \`foo\` is serving the old client. Refresh it: ${refresh}`
          : null;
    }
  }
  switch (freshness.state) {
    case "no-channel":
      return null;
    case "current":
      return `Client: ${freshness.installed} — the newest published release`;
    case "unknown":
      return `Client: ${freshness.installed} — could not check for a newer release, so one may exist`;
    case "behind":
      return `Client: ${freshness.installed} — ${freshness.latest} is available. Update: ${refresh}`;
  }
}

// selfRoot is productfoo's own install dir (module-relative ROOT); the parameter is a
// test seam — the running binary can't fake where it is installed. `freshness`
// is the same: it is the only part of doctor that can touch the network, so a
// test injects it rather than reaching for a remote.
// The gate is wired per HARNESS, in each harness's own hook config — never in
// git. The previous line keyed off core.hooksPath (git's COMMIT-hook wiring)
// and told a machine with six freshly wired harnesses "not wired in this
// harness yet" (found live 2026-07-22): a category error on the one line whose
// whole job is reporting the actual regime. This probe reads the files
// `foo research install-gate` writes (and the repo's own .claude/settings.json)
// and reports only what it can verify in them.
export type ResearchGateWiring = { label: string; format: string; wired: boolean };

export function researchGateWiring(root: string): ResearchGateWiring[] {
  return HARNESS_GATES.map((gate) => {
    const file = path.join(root, gate.configPath);
    let wired = false;
    try {
      wired = existsSync(file) && /guard-research|foo-research-gate/i.test(readFileSync(file, "utf8"));
    } catch {
      wired = false; // unreadable config is not verifiable wiring — never claim it
    }
    return { label: gate.label, format: gate.format, wired };
  });
}

// Which coding agent this shell belongs to, by the markers harnesses set for
// their tool shells (same source of truth as the handoff detector).
const HARNESS_MARKER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["CLAUDECODE", "Claude Code"],
  ["CLAUDE_CODE", "Claude Code"],
  ["CODEX_SANDBOX", "Codex"],
  ["CURSOR_AGENT", "Cursor"],
  ["OPENCODE", "OpenCode"],
];

export function currentHarnessLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const [marker, label] of HARNESS_MARKER_LABELS) if (env[marker]) return label;
  return null;
}

export function researchGateDoctorLine(wiring: ResearchGateWiring[], currentLabel: string | null): string {
  const wiredLabels = wiring.filter((entry) => entry.wired).map((entry) => entry.label);
  const notWired = wiring.filter((entry) => !entry.wired).map((entry) => entry.label);
  const summary = `${wiredLabels.length ? `Wired: ${wiredLabels.join(", ")}` : "Wired: none"}${notWired.length ? ` · not wired: ${notWired.join(", ")} — \`foo research install-gate\`` : ""}`;
  const paperRefusal = "an ungoverned paper is still refused as evidence — a paper naming no `foo research` run does not count.";
  if (currentLabel === null) {
    return `Research gate: no coding agent detected in this shell — enforcement lives in the agent's tool hooks. ${summary}. Everywhere else, ${paperRefusal}`;
  }
  const here = wiring.find((entry) => entry.label === currentLabel);
  if (!here) {
    // An unknown harness has no verified gate adapter.
    return `Research gate: ${currentLabel} cannot enforce tool hooks — here, ${paperRefusal} ${summary}.`;
  }
  return here.wired
    ? `Research gate: enforced here in ${currentLabel} (web refused until \`foo research\` runs). ${summary}.`
    : `Research gate: not wired in ${currentLabel} yet — \`foo research install-gate\`. Until then, ${paperRefusal} ${summary}.`;
}

export function renderDoctor(
  root: string,
  format: "text" | "json",
  selfRoot: string = ROOT,
  freshness: ChannelFreshness = channelFreshness(),
  homeRoot: string = homedir(),
  now: () => string = () => new Date().toISOString(),
): string {
  const version = readPackageVersion(root);
  // Only the running package can supply trusted skills. A caller repository may
  // contain a same-shaped registry, but it cannot change delivery mode or make
  // an incomplete install report itself as bundled.
  const skillsPresent = existsSync(path.join(selfRoot, "skills", "skill-registry.yaml"));
  const developmentTrust = skillsPresent
    ? inspectDevelopmentSkillTrust(
        selfRoot,
        path.join(homeRoot, ".foo", "trust", "development-skill-source.json"),
        now(),
      )
    : null;
  const firecrawl = firecrawlKeyStatus();
  // #897: bundled skills that match this release's anchor load with no
  // approval step (skillLocal readBundledCanonicalSkill), so doctor must not
  // send that install to `foo skill trust`. Only an edited or unanchored tree
  // genuinely needs the development approval.
  const bundledVerified = skillsPresent && developmentTrust?.status !== "ready" && bundledSkillTreeVerified(selfRoot);
  const skillsMode: "verified" | "bundled" | "needs_approval" | "unavailable" = skillsPresent
    ? developmentTrust?.status === "ready" ? "verified" : bundledVerified ? "bundled" : "needs_approval"
    : "unavailable";
  const adapters = AGENT_DEFINITIONS.map((agent) => {
    const resolved = adapterStatus(root, homeRoot, agent);
    return {
      id: agent.id,
      label: agent.label,
      project_path: agent.projectPath,
      scope: resolved.scope,
      resolved_path: resolved.resolvedPath,
      status: resolved.status,
    };
  });
  const anyAdapterReady = adapters.some((adapter) => adapter.status === "ready");
  const hooks = hooksStatus();
  const gateWiring = researchGateWiring(root);
  const harnessLabel = currentHarnessLabel();
  const gateHere = gateWiring.find((entry) => entry.label === harnessLabel);
  const build = buildFreshnessStatus(selfRoot);

  // Installed = foo resolves its own package (version known). Skills are a
  // separate axis: bundled (repo/full install) or unavailable (no trusted
  // local package content). A token never turns a missing skill remote.
  const installed = version !== "unknown";
  const setUp = anyAdapterReady;
  // doctor is the readiness check; `foo init` is the hero first-run. Once
  // companions are set up, doctor hands off to `foo init`. Until then it keeps
  // the setup hand-off (preserving the installer's machine-readable signal,
  // npm-installer-v0 R-005).
  const nextCommand = !installed
    ? "reinstall foo: the CLI cannot resolve its own package"
    : skillsMode === "needs_approval"
      ? "foo skill trust"
    : skillsMode === "unavailable"
      ? "reinstall productfoo with its bundled skills, then run `foo doctor`"
      : setUp
        ? "foo init"
        : "foo agent setup --agent all --scope project --dry-run";

  const payload = {
    schema_version: "0.1",
    foo: {
      installed,
      version,
      bundled_skills: skillsPresent,
      skills_mode: skillsMode,
      development_trust: developmentTrust,
      firecrawl_key: firecrawl.present,
      firecrawl_key_source: firecrawl.source,
    },
    companions: {
      set_up: setUp,
      adapters,
    },
    hooks: {
      dir_present: hooks.dirPresent,
      hooks_path: hooks.currentHooksPath,
      wired: hooks.wired,
      state: hooks.state,
    },
    research_gate: {
      current_harness: harnessLabel,
      enforced_here: harnessLabel === null ? null : Boolean(gateHere?.wired),
      harnesses: gateWiring.map(({ label, wired }) => ({ label, wired })),
    },
    build: {
      state: build.state,
      stale: build.stale,
    },
    client: {
      channel_state: freshness.state,
      kind: freshness.kind,
      installed: freshness.installed,
      latest_published: freshness.latest,
    },
    update_relay: noticeAudience(process.env, false) === "agent" ? "active" : "terminal_only",
    next_command: nextCommand,
  };

  if (format === "json") return `${JSON.stringify(payload, null, 2)}\n`;

// Where does B5 actually bind? Two different answers, and conflating them is how a
// boundary becomes a comforting lie.
//
// Tool-hook coverage depends on the selected harness and its wiring. The registry
// reports those limits; an unwired or partially covered host cannot refuse every
// research action. Evidence validation must therefore remain independent of hooks.
//
// There, productfoo refuses the RESULT instead: a paper that cannot name a run `foo research`
// actually minted is not evidence, and that check is productfoo's own CLI, so it holds everywhere.
// The reading is not stopped. It just does not count.

// Which surface the update offer can actually reach here — the same honesty rule
// as the research gate: never claim a reach productfoo does not have. `relay active`
// means a harness is detected, so a person who only ever drives foo through an
// agent still gets offered updates. `terminal-only` means no marker, so the offer
// reaches only an attended terminal. (agent-relay R-005)
function updateRelayDoctorLine(env: NodeJS.ProcessEnv = process.env): string {
  // Force the non-TTY view: the question is "would an agent-only run be reached",
  // not "is a human at the terminal right now".
  const relayActive = noticeAudience(env, false) === "agent";
  return relayActive
    ? "Update relay: active — an agent running productfoo will be offered new builds to pass on to you, even with no terminal."
    : "Update relay: terminal-only — the update offer reaches only an attended terminal; an agent-only run cannot be told (no harness detected).";
}

  return [
    "foo doctor",
    "",
    `productfoo installed: ${installed ? "yes" : "no"} (version ${version})`,
    skillsMode === "verified" && developmentTrust?.status === "ready"
      ? `Skills: verified development tree ${developmentTrust.skills_sha256.slice(0, 12)} (valid until ${developmentTrust.expires_at})`
      : skillsMode === "bundled"
        ? `Skills: ${BUNDLED_SKILL_TREE.skill_count} bundled skills, verified against this release — no approval step needed`
      : skillsMode === "needs_approval"
        ? "Skills: on disk but not approved — run `foo skill trust`"
        : "Skills: unavailable in this build — reinstall productfoo with its bundled skills",
    `Firecrawl: ${firecrawl.detail}`,
    `Companion stack set up: ${setUp ? "yes" : "no"}`,
    // Say plainly WHERE the research boundary actually binds. productfoo can refuse a web read
    // only in a harness that gives it a tool-call hook; everywhere else the reading
    // happens and productfoo refuses the RESULT instead. Reporting "enforced" in a harness where
    // it isn't would be the worst outcome — a boundary people trust and don't have.
    researchGateDoctorLine(gateWiring, harnessLabel),
    updateRelayDoctorLine(),
    hooksDoctorLine(hooks),
    buildDoctorLine(build) ?? "",
    channelDoctorLine(freshness) ?? "",
    "",
    ...adapters.map((adapter) => `${adapter.label}: ${adapter.status} (${adapter.scope}: ${adapter.resolved_path})`),
    "",
    "Install puts foo on the machine; setup makes the companion stack real.",
    `Next: ${nextCommand}`,
    installed && setUp ? "Start here: foo init reads your repo and suggests a first move." : "",
    "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}
