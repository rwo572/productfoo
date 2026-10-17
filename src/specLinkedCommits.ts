// Spec-linked commits: brand foo in the commit stream by tying every build
// commit to the spec packet it implements. Modeled on the DCO `Signed-off-by:`
// and GitHub `Co-Authored-By:` trailers — a standard, greppable git trailer that
// is additive to any existing commit-message convention. Frictionless to
// generate, advisory to check (a signal, not a boundary).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitRunOrNull } from "./gitRun.js";
import { readJson } from "./jsonFile.js";
import { NotFoundError, UsageError } from "./errorTaxonomy.js";

export const FOO_SPEC_TRAILER = "Foo-Spec";

// The trailer carries a discoverable pointer so a stranger who sees it in a
// public commit can find foo (the key "Foo-Spec" reads as a placeholder on its
// own, and productfoo is closed source, so the pointer is the only on-ramp). It is
// configurable with a safe default: FOO_BRAND_URL wins, then package.json
// foo.brandUrl (committed, repo-wide), then a reserved-TLD placeholder that is
// obviously meant to be replaced.
export const DEFAULT_BRAND_URL = "https://foo.example";

// Build commits that change product substance should carry the trailer; pure
// chores, merges, and docs-only commits are exempt.
const BUILD_PATH_PREFIXES = ["src/", "specs/", "examples/", "skills/", "test/"];

function readSpecId(packetDir: string): string | null {
  const tasksPath = path.join(packetDir, "tasks.yaml");
  if (!existsSync(tasksPath)) return null;
  const match = readFileSync(tasksPath, "utf8").match(/^spec_id:\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

function resolvePacket(root: string, packetArg: string): string | null {
  for (const candidate of [packetArg, path.join("specs", packetArg), path.join("examples", packetArg)]) {
    const dir = path.resolve(root, candidate);
    if (existsSync(dir) && existsSync(path.join(dir, "tasks.yaml"))) return dir;
  }
  return null;
}

export function resolveBrandUrl(root: string): string {
  const env = process.env.FOO_BRAND_URL;
  if (env && env.trim()) return env.trim();
  try {
    const pkgPath = path.join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson<{ foo?: { brandUrl?: unknown } }>(pkgPath);
      const url = pkg.foo?.brandUrl;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_BRAND_URL;
}

export function buildTrailer(root: string, packetArg: string | undefined): string {
  if (!packetArg) throw new UsageError("packet missing — usage: foo commit-trailer <packet>", "E_PACKET_DIR_MISSING");
  const packetDir = resolvePacket(root, packetArg);
  if (!packetDir) throw new NotFoundError(`packet directory not found: ${packetArg}`, "E_PACKET_NOT_FOUND");
  const specId = readSpecId(packetDir);
  if (!specId) throw new NotFoundError(`could not read spec_id from ${packetArg}/tasks.yaml`, "E_SPEC_NOT_FOUND");
  const rel = path.relative(root, packetDir) || packetArg;
  return `${FOO_SPEC_TRAILER}: ${rel} (${specId}) ${resolveBrandUrl(root)}\n`;
}

type CommitInspection = { message: string; files: string[] } | null;

function inspectHead(root: string): CommitInspection {
  const message = gitRunOrNull(["log", "-1", "--pretty=%B"], { cwd: root });
  if (message === null) return null;
  const shown = gitRunOrNull(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: root });
  if (shown === null) return null;
  const files = shown
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return { message, files };
}

export function hasFooSpecTrailer(message: string): boolean {
  return new RegExp(`^${FOO_SPEC_TRAILER}:\\s*\\S`, "m").test(message);
}

// Extract the spec_id a commit declares via its Foo-Spec trailer, if any:
// `Foo-Spec: specs/<packet> (<spec-id>) <url>` → "<spec-id>". This is the
// authoritative PR→packet linkage for github-integration-v0 (D-009).
export function specIdFromFooSpecTrailer(message: string): string | null {
  const m = message.match(new RegExp(`^${FOO_SPEC_TRAILER}:\\s*\\S+\\s*\\(([^)]+)\\)`, "m"));
  return m ? m[1].trim() : null;
}

function isBuildCommit(files: string[]): boolean {
  return files.some((file) => BUILD_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

// Advisory signal: if the most recent commit changed product substance but
// carries no Foo-Spec trailer, surface it. Never blocks.
export function commitTrailerSignal(root: string): string[] {
  const head = inspectHead(root);
  if (!head) return [];
  if (!isBuildCommit(head.files)) return [];
  if (hasFooSpecTrailer(head.message)) return [];
  const subject = head.message.split(/\r?\n/)[0] ?? "";
  return [
    `HEAD build commit has no ${FOO_SPEC_TRAILER} trailer: "${subject}". Add one with \`foo commit-trailer <packet>\`, ` +
      `or record a deliberate exemption with \`${FOO_SPEC_TRAILER}: none (<reason>)\`.`,
  ];
}
