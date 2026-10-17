// Is the client you are running the newest one that was published?
//
// Nothing here self-updates: `npm install` pins whatever was published that day,
// and nothing ever revisits it. So a release can land and productfoo keeps serving the
// old client while cheerfully reporting a version number — which is exactly how
// the dist channel sat on 0.1.6 for a day after 0.1.10 shipped, with no surface
// anywhere saying so.
//
// The update notice (`updateNotice.ts`) covers this for testers who are working:
// the skill server stamps every response with the current version. But it can
// only speak to a client that CALLS the server, so it is silent for anyone
// resolving skills locally, and silent in any session that loads no skill. That
// leaves doctor — the one command whose whole job is "tell me if my setup is
// wrong" — as the only surface that can answer the question unprompted. So it
// answers it for every install, not just the channel one.
//
// This is an advisory doctor signal, never a block, and it is offline-safe:
// when the newest release cannot be read, doctor says it could not check rather
// than reporting a reassuring "current".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./jsonFile.js";

// ── The distribution-target contract ─────────────────────────────────────────
// productfoo's canonical distribution target is the npm package this artifact ships
// as. Every surface that names it — the update notice, doctor, the invite
// email, `foo update`'s argv — resolves it through the functions below instead
// of repeating a string. The published-package NAME is an open owner decision
// (spec D-006/D-007), so the contract keeps that decision in ONE place:
// settling it, or moving to a successor name, is a package.json edit plus this
// module — never a grep across the tree.
//
// The Git install (`github:rwo572/foo-dist`) is retired, not bridged (R-009):
// it was the private alpha channel, and the private repository it pointed at
// stops resolving. The only deliberate survivors are commented historical
// references, each saying why it survives.

// Historical name of the retired private dist channel. Recorded here (and only
// here) so the successor-seam comment below has a concrete referent; no install
// surface may print it again.
export const RETIRED_DIST_PACKAGE = "github:rwo572/foo-dist";

// The successor-package seam (spec D-006): a later scope move republishes under
// a new name and deprecates the old, and this contract is the one place the new
// name lands. FOO_DISTRIBUTION_PACKAGE exists for the transition window — an
// operator run whose package.json name and publish name differ — and for tests.
export function distributionPackageName(): string {
  const forced = (process.env.FOO_DISTRIBUTION_PACKAGE ?? "").trim();
  if (forced) return forced;
  try {
    const name = readJson<{ name?: string }>(path.join(PACKAGE_ROOT, "package.json")).name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // Fall through to the shipped-name fallback below.
  }
  // The name this artifact ships today. One hardcoded name, inside the
  // contract, so an unreadable package.json still yields a command a human can
  // run — never a Git URL.
  return "productfoo";
}

// The two install commands. One place, so the notice prints the same thing
// `foo update` execs and doctor points at. `--prefix` is absolute because argv
// is not a shell and nothing expands a tilde there.
export function globalInstallCommand(): string {
  return `npm install -g ${distributionPackageName()}`;
}

export function channelInstallCommand(home: string = fooHome()): string {
  return `npm install --prefix ${path.join(home, "versions", "dist")} ${distributionPackageName()}`;
}

export type ChannelFreshnessState = "no-channel" | "unknown" | "current" | "behind";

// Which productfoo is running, because that decides both what "behind" means and which
// command would fix it. A repo checkout has no published build to be behind; an
// installed client is the thing the user would have to update.
export type ClientKind = "repo" | "channel" | "global";

export type ChannelFreshness = {
  state: ChannelFreshnessState;
  installed: string | null;
  latest: string | null;
  kind: ClientKind;
};

// This file compiles to dist/src/channelFreshness.js, so two levels up is productfoo's
// own package root — the client actually executing, whatever directory it was
// invoked from.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Deliberately not `clientVersion()` from updateNotice: that module already
// imports compareVersions from here, and importing back would close a cycle.
// The semantics differ anyway — null means "cannot tell", which must never be
// compared against a real version.
export function runningVersion(packageRoot: string = PACKAGE_ROOT): string | null {
  try {
    const version = readJson<{ version?: string }>(path.join(packageRoot, "package.json")).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

// A repo checkout carries productfoo's TypeScript source; no npm install does
// (package.json "files" ships the compiled dist-public/, never src/, and
// test/channelFreshness.test.ts pins that against open-source/npm-files.json).
// #892: this used to key on skills/, but the public package bundles skills/
// since #813, so every npm install read as a checkout and could never update.
export function isSourceCheckout(packageRoot: string = PACKAGE_ROOT): boolean {
  return existsSync(path.join(packageRoot, "src", "cli.ts"));
}

export function runningClientKind(packageRoot: string = PACKAGE_ROOT, home: string = fooHome()): ClientKind {
  if (isSourceCheckout(packageRoot)) return "repo";
  return packageRoot.startsWith(path.join(home, "versions", "dist") + path.sep) ? "channel" : "global";
}

// Numeric, segment-by-segment. A string compare says "0.1.10" < "0.1.6", which
// would hide the very release this check exists to catch.
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.replace(/^v/, "").split(".").map((segment) => Number.parseInt(segment, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// Pure decision, so every state is unit-testable without a network or a $HOME.
export function channelFreshnessPlan(input: {
  installed: string | null;
  latest: string | null;
  kind?: ClientKind;
}): ChannelFreshness {
  const { installed, latest } = input;
  const kind = input.kind ?? "channel";
  if (installed === null) return { state: "no-channel", installed, latest, kind };
  if (latest === null) return { state: "unknown", installed, latest, kind };
  return { state: compareVersions(installed, latest) < 0 ? "behind" : "current", installed, latest, kind };
}

export function fooHome(): string {
  return process.env.FOO_HOME ?? path.join(homedir(), ".foo");
}

// What the `dist` channel actually has installed right now.
export function installedDistVersion(home: string = fooHome()): string | null {
  // #892: the channel copy lives under its published name, whatever that is.
  const manifest = path.join(home, "versions", "dist", "node_modules", ...distributionPackageName().split("/"), "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const version = readJson<{ version?: string }>(manifest).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

// Newest published release, read from the npm registry — the same source `npm
// install` resolves. The update notice rides the skill-server header (the
// server is the source of truth for a client that is running); this probe is
// the offline-safe backstop doctor uses, and it needs no credentials now that
// the target is a public package. Bounded and silent: any failure — offline, no
// npm on PATH, a slow registry — returns null, which doctor reports as "could
// not check", never a reassuring "current". Set FOO_SKIP_UPDATE_CHECK=1 to skip
// the probe entirely.
export function latestPublishedVersion(registryTimeoutMs = 5_000): string | null {
  if (process.env.FOO_SKIP_UPDATE_CHECK === "1") return null;
  // A test NEVER touches the registry — the same posture as telemetry, and for
  // the same reason. The suite spawns `foo doctor` ~19 times and inherits the
  // real HOME, so without this every one of them fired a network probe:
  // ~0.5s each, network-dependent, and an intermittent failure whenever the
  // network was slow enough to push a spawn toward the timeout.
  if ((process.env.NODE_ENV ?? "").trim() === "test") return null;
  const res = spawnSync("npm", ["view", distributionPackageName(), "version", "--json"], {
    encoding: "utf8",
    timeout: registryTimeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  // `npm view <pkg> version --json` prints a bare JSON string: "0.1.37".
  try {
    const version = JSON.parse(res.stdout);
    if (typeof version !== "string") return null;
    const clean = version.trim().replace(/^v/, "");
    return /^\d+(\.\d+)*$/.test(clean) ? clean : null;
  } catch {
    return null;
  }
}

// Freshness of the client that is running right now — the one whose version the
// user would have to change.
//
// A repo run is the exception, and it is the case this check was originally
// built for: a dev checkout has no published build to be behind, but bare `foo`
// may still be serving a stale channel install while `bin/foo` runs new code.
// So a repo run reports the channel; an installed run reports itself.
export function channelFreshness(
  packageRoot: string = PACKAGE_ROOT,
  home: string = fooHome(),
): ChannelFreshness {
  const kind = runningClientKind(packageRoot, home);
  const installed = kind === "repo" ? installedDistVersion(home) : runningVersion(packageRoot);
  // Don't go to the network at all when there is nothing that could be stale.
  if (installed === null) return channelFreshnessPlan({ installed: null, latest: null, kind });
  return channelFreshnessPlan({ installed, latest: latestPublishedVersion(), kind });
}
