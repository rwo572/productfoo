// `foo update` — take the build foo just told you about.
//
// The notice (updateNotice.ts) says a new version exists. This is the other
// half: the thing you type when it does. Without it, "0.1.19 is available" ends
// in a paste — select a long npm string out of a scrollback, trust it, run it —
// and a tester who is mid-task simply doesn't, which is how someone sits on a
// stale build for days while being told, correctly, every morning.
//
// Four rules:
//   - UPDATE THE COPY THAT ACTUALLY RUNS. There can be two `foo` installs on one
//     machine: the global npm one, and the channel one under ~/.foo/versions/dist
//     that the PATH shim (`~/.foo/bin/foo`) execs. They are different directories,
//     and `npm install -g` moves only the first. This is not hypothetical — it is
//     why the owner's `foo` sat on 0.1.18 while a global install of 0.1.20
//     reported success: the command updated a copy she never ran. An update
//     command that installs somewhere other than where you are running from is
//     worse than none, because it lies. So the install target is derived from
//     where THIS process is executing, never assumed.
//   - Never update a repo checkout. `npm install` over a dev build would replace
//     what the developer is editing with a published copy. A repo run refuses.
//   - Pin the version npm named. A bare package spec installs whatever
//     is newest at that instant — the same drift the retired Git channel had
//     when bare `main` floated — while `pkg@0.1.20` installs the build the
//     user was actually told about.
//   - Say what it will run before it runs it. This mutates an npm prefix; that
//     is not something to do behind a spinner.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compareVersions, distributionPackageName, fooHome, runningClientKind, type ClientKind } from "../channelFreshness.js";
import {
  CHANGELOG_URL,
  clientVersion,
  pendingUpdate,
  recordRelaySpoken,
  recordUpdateSpoken,
} from "../updateNotice.js";
import { glyphsEnabled, withGlyph } from "../statusGlyphs.js";

// Public updates use npm package metadata. No productfoo account, token or hosted
// service participates; old private clients retain their existing server path.
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// Match npm install's effective registry, including local npmrc settings.
// Config lookup is local; an absent npm executable falls back to public npm.
function npmRegistry(env: NodeJS.ProcessEnv, kind?: ClientKind): string {
  const configured = env.npm_config_registry?.trim() || env.NPM_CONFIG_REGISTRY?.trim();
  if (configured) return configured;
  const args = ["config", "get", "registry"];
  if (kind === "global") args.push("--global");
  if (kind === "channel") args.push("--prefix", path.join(fooHome(), "versions", "dist"));
  const result = spawnSync("npm", args, { env, encoding: "utf8", timeout: 2_000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : DEFAULT_REGISTRY;
}

export async function fetchLatestVersion(
  registry: string = npmRegistry(process.env),
  timeoutMs = 10_000,
): Promise<string | null> {
  try {
    const packageName = distributionPackageName().replace("/", "%2f");
    const res = await fetch(`${registry.replace(/\/+$/, "")}/${packageName}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json() as { version?: unknown };
    return typeof body?.version === "string" && STABLE_VERSION.test(body.version) ? body.version : null;
  } catch {
    // Unknown stays unknown: an offline or malformed reply is never proof
    // that the running copy is current.
    return null;
  }
}

export type UpdateAction = "install" | "current" | "unreachable" | "repo";

export type UpdatePlan = {
  action: UpdateAction;
  running: string;
  latest: string | null;
  /** Exactly what an install would exec — argv, so a path with a space is not a bug. */
  argv: string[] | null;
  /** The same thing, as the line we show the user before running it. */
  command: string | null;
};

// What npm installs: the published package at the version npm named,
// resolved through the ONE distribution-target contract (channelFreshness.ts)
// — the package name is never hardcoded here, so the owner's final npm
// identity (or a later successor rename) flows through unchanged.
//
// Where the foo that is RUNNING lives decides what npm has to be pointed at to
// replace it:   global — the ordinary `npm install -g` copy;   channel — the copy
// under ~/.foo/versions/<channel> that the PATH shim execs, where `-g` would
// install past it and change nothing the user runs.
//
// `--prefix <abs path>`, not the `~/.foo/...` string the docs print: argv is not
// a shell, and nothing expands a tilde here.
export function installArgv(kind: ClientKind, latest: string, home: string = fooHome()): string[] | null {
  const pkg = `${distributionPackageName()}@${latest}`;
  if (kind === "global") return ["npm", "install", "-g", pkg];
  if (kind === "channel") return ["npm", "install", "--prefix", path.join(home, "versions", "dist"), pkg];
  return null; // repo — nothing to install over
}

// Pure decision, no network and no npm. Every branch below is a test.
export function updatePlan(input: { running: string; latest: string | null; kind: ClientKind; home?: string }): UpdatePlan {
  const { running, latest, kind } = input;
  const none = { running, latest, argv: null, command: null };
  if (kind === "repo") return { action: "repo", ...none };
  if (!latest || !STABLE_VERSION.test(latest)) return { action: "unreachable", ...none, latest: null };
  if (compareVersions(running, latest) >= 0) return { action: "current", ...none };
  const argv = installArgv(kind, latest, input.home ?? fooHome());
  return { action: "install", running, latest, argv, command: argv ? argv.join(" ") : null };
}

export type UpdateOutcome = { output: string; exitCode: number };

// The npm call, isolated so a test can prove what would be run without running
// it. `shell: false` (spawnSync's default with an argv array) — the version
// string comes off the wire, and a version string is not a place to trust a shell.
export type Installer = (argv: string[]) => { status: number | null };

const npmInstaller: Installer = ([command, ...args]) => spawnSync(command, args, { stdio: "inherit" });

/**
 * The offer — the LAST thing a run does, and the only place foo installs
 * anything you did not ask it to install.
 *
 * The same two rules that shape the error-report ask, pulling the same two ways:
 *
 *   Never interrupt the work. The question waits until the command has finished
 *   and printed everything it meant to print. foo learns about the new build
 *   mid-run (from a response to a request it was already making) and says
 *   nothing until the work is done.
 *
 *   Never hang. Most productfoo runs are piped or agent-driven. A prompt with nobody
 *   there to answer is not a question, it is a deadlock — so productfoo asks only when
 *   a real human is on BOTH ends of the terminal, and otherwise prints the one
 *   line and gets out of the way.
 *
 * The answer defaults to no. Silence is not consent — least of all consent to
 * write to an npm prefix. And a `no` is a real no: foo records that it spoke,
 * and does not ask again about this build today.
 */
export async function offerUpdate(
  io: { stdin?: NodeJS.ReadStream; stderr?: NodeJS.WriteStream; args?: string[]; install?: Installer; kind?: ClientKind } = {},
): Promise<void> {
  try {
    const p = pendingUpdate();
    if (!p) return;

    const stdin = io.stdin ?? process.stdin;
    const stderr = io.stderr ?? process.stderr;
    const args = io.args ?? [];
    const kind = io.kind ?? runningClientKind();

    // The agent relay: a line for the coding agent that ran foo to surface to its
    // human. Never under --json — it would corrupt the payload the agent is
    // parsing — and when suppressed there, do NOT record, so a later non-json run
    // in the same session still gets to relay (R-004).
    if (p.audience === "agent") {
      if (args.includes("--json")) return;
      stderr.write(`${p.line}\n`);
      // Record into the agent's OWN session ration, never the human's day
      // ration — otherwise a person who also runs foo by hand loses their
      // interactive offer for the rest of the day (R-001 says it is unchanged).
      recordRelaySpoken(p.latest);
      return;
    }

    // Whatever happens below, this build has now been spoken about today. Record
    // it FIRST: if the install throws, or the user ^C's out of the prompt, the
    // one thing that must not happen is foo re-asking on their very next command.
    recordUpdateSpoken(p.latest);

    // Three reasons to state the fact and never ask:
    //   - nobody is on the other end (piped, hooked, agent-driven);
    //   - the run is emitting machine output, and a machine cannot answer;
    //   - it is a repo checkout, where there is nothing to install over anyway.
    const canAsk = Boolean(stdin.isTTY) && Boolean(stderr.isTTY) && !args.includes("--json") && kind !== "repo";
    if (!canAsk) {
      stderr.write(`${p.line}\n`);
      return;
    }

    const plan = updatePlan({ running: p.running, latest: p.latest, kind });
    if (plan.action !== "install" || !plan.argv) {
      stderr.write(`${p.line}\n`);
      return;
    }

    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: stdin, output: stderr });
    try {
      stderr.write(`\nfoo ${p.running} → ${p.latest} is available.\n`);
      stderr.write(`  What's new: ${CHANGELOG_URL}\n`);
      // Say what the yes DOES. "Install now? [y/N]" hides the fact that a key is
      // about to write to an npm prefix; someone on a locked-down machine needs
      // to know which command they are authorizing BEFORE they press y.
      stderr.write(`  Installing runs: ${plan.command}\n`);
      const answer = (await rl.question("  Install it now? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        stderr.write("  Not installing. Run `foo update` whenever you want it.\n");
        return;
      }
      stderr.write("\n");
      const result = (io.install ?? npmInstaller)(plan.argv);
      stderr.write(
        result.status === 0
          ? `\nfoo ${p.latest} is installed — it takes effect on your next command.\n`
          : `\nThe install failed, so you are still on foo ${p.running}. npm's error is above; \`foo update\` retries.\n`,
      );
    } finally {
      rl.close();
    }
  } catch {
    // An update offer may never change what the command was asked to do, and may
    // never be the reason a run fails.
  }
}

export async function updateCommand(
  args: string[] = [],
  deps: {
    latest?: () => Promise<string | null>;
    install?: Installer;
    running?: string;
    kind?: ClientKind;
    isTTY?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<UpdateOutcome> {
  const env = deps.env ?? process.env;
  const asJson = args.includes("--json");
  const checkOnly = args.includes("--check");
  const glyphs = glyphsEnabled({ isTTY: deps.isTTY ?? Boolean(process.stdout.isTTY), env, args });

  const running = deps.running ?? clientVersion();
  const kind = deps.kind ?? runningClientKind();
  const latest = await (deps.latest ?? (() => fetchLatestVersion(npmRegistry(env, kind))))();
  const plan = updatePlan({ running, latest, kind });

  if (asJson) {
    return {
      output: `${JSON.stringify({ running: plan.running, latest: plan.latest, state: plan.action, command: plan.command }, null, 2)}\n`,
      exitCode: plan.action === "unreachable" ? 1 : 0,
    };
  }

  switch (plan.action) {
    case "repo":
      // The owner, in the checkout. Nothing to install over, and saying "you are
      // current" would be meaningless — the repo build is whatever they last
      // edited. Give them the one fact they might actually want.
      return {
        output: `foo ${plan.running} — you're running the repo build, so there is nothing to install over it.${
          plan.latest ? ` The published release is ${plan.latest}.` : ""
        }\n`,
        exitCode: 0,
      };

    case "unreachable":
      return {
        output: withGlyph(
          "blocked",
          `blocked — couldn't get a valid latest version from npm, so we can't tell whether ${plan.running} is current. Your install is unchanged; retry with foo update --check.\n`,
          glyphs,
        ),
        exitCode: 1,
      };

    case "current":
      return { output: withGlyph("proven", `proven — foo ${plan.running} is the newest published build.\n`, glyphs), exitCode: 0 };

    case "install": {
      const header = `foo ${plan.running} → ${plan.latest}\nWhat's new: ${CHANGELOG_URL}\n`;
      if (checkOnly) {
        // --check is what a script or an agent runs: report, never mutate.
        return { output: `${header}Update with: foo update\n`, exitCode: 0 };
      }

      process.stdout.write(`${header}Running: ${plan.command}\n\n`);
      const result = (deps.install ?? npmInstaller)(plan.argv as string[]);
      if (result.status !== 0) {
        // npm already printed its own failure to the inherited stderr; do not
        // paraphrase it. Say only what the user needs: nothing changed.
        return {
          output: withGlyph(
            "blocked",
            `\nblocked — the install failed, so you are still on foo ${plan.running}. npm's error is above.\n`,
            glyphs,
          ),
          exitCode: 1,
        };
      }
      return {
        output: withGlyph("proven", `\nproven — foo ${plan.latest} is installed. Check it: foo --version\n`, glyphs),
        exitCode: 0,
      };
    }
  }
}
