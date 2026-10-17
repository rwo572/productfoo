// Small cross-domain CLI utilities shared by the command modules under
// src/commands/. Kept here (not in cli.ts) so domain modules never import the
// entry point — no circular imports.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyThrown, type FailureMark, markFailure, NotFoundError, UsageError } from "../errorTaxonomy.js";
import { parse as parseYaml } from "../vendorYaml.js";
import { readJson } from "../jsonFile.js";
import { SkillDeliveryError, markSkillFailure } from "../skillLocal.js";

type SkillRegistry = {
  skills?: Array<{
    id?: unknown;
    path?: unknown;
  }>;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// productfoo's own install dir, for loading productfoo's bundled assets (commands/), NOT for
// resolving the user's packets. Resolved relative to this module's compiled
// location (dist/src/commands/) — three levels up to the package root.
export const ROOT = path.resolve(moduleDir, "..", "..", "..");

// error-instrumentation-v0 T-001. Two ways to fail, and they are NOT the same thing:
//
//   failWith(literal)  — "you invoked this wrong". A missing arg, an unknown domain.
//                        foo prints usage. It is a typo. It must never page anyone.
//   failThrown(error)  — something threw. Nobody predicted it. It IS a defect.
//                        It pages, and it carries its message and stack to the LOCAL log.
//
// They are separate functions on purpose. When both were spelled `failWith`, a genuine
// crash caught in a dispatch catch-block was indistinguishable from a typo — and marking
// those 39 catch-alls as usage errors would have SILENCED every real bug in foo. A false
// "typo" hides a defect; a false "defect" merely pages you. So the shapes must differ,
// and the honest default is to page.
export function failWith(message: string, mark?: Partial<FailureMark>): number {
  markFailure({
    errorClass: mark?.errorClass ?? "usage_error",
    errorCode: mark?.errorCode ?? "E_BAD_FLAG",
    message: mark?.message ?? message,
    ...(mark?.stack ? { stack: mark.stack } : {}),
  });
  process.stderr.write(`${message}\n`);
  process.stderr.write("Run `foo --help` to see all commands.\n");
  return 1;
}

/**
 * A command threw. Classify it honestly (io_error for an errno, command_error otherwise),
 * keep the message and stack for the local log, and print the message as before.
 */
export function failSkillDelivery(error: unknown): number | null {
  if (!(error instanceof SkillDeliveryError)) return null;
  markSkillFailure(error.kind, error.message);
  process.stderr.write(`${error.message}\n`);
  return 1;
}

export function failThrown(error: unknown, args: string[] = process.argv.slice(2)): number {
  const skill = failSkillDelivery(error);
  if (skill !== null) return skill;
  const mark = classifyThrown(error);
  markFailure(mark);
  process.stderr.write(`${mark.message}\n`);
  process.stderr.write("Run `foo --help` to see all commands.\n");
  return 1;
}

export function loadRegisteredSkills(root: string): Map<string, string> {
  void root;
  // Every branch below is an integrity check on productfoo's own bundled tree: the
  // registry is missing, malformed, or names a path that escapes skills/.
  // That is a broken or tampered install, and saying so beats reporting an
  // outage the reader can neither wait out nor fix.
  const unreadable = (): never => {
    throw new SkillDeliveryError(
      "unapproved-source",
      "productfoo's bundled skill registry could not be read safely — it is missing, malformed, or points outside skills/. Reinstall or update productfoo.",
    );
  };

  try {
    const lexicalSkillsRoot = path.join(ROOT, "skills");
    const realSkillsRoot = realpathSync(lexicalSkillsRoot);
    const registryPath = path.join(realSkillsRoot, "skill-registry.yaml");
    if (!statSync(registryPath).isFile()) return unreadable();
    const registry = parseYaml(readFileSync(registryPath, "utf8")) as SkillRegistry;
    if (!Array.isArray(registry.skills)) return unreadable();

    const resolved = new Map<string, string>();
    for (const skill of registry.skills) {
      if (typeof skill.id !== "string" || typeof skill.path !== "string" || path.isAbsolute(skill.path)) return unreadable();
      const candidate = path.resolve(ROOT, skill.path);
      const lexicalRelative = path.relative(lexicalSkillsRoot, candidate);
      if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === ".." || path.isAbsolute(lexicalRelative)) return unreadable();
      if (!existsSync(candidate) || !statSync(candidate).isFile()) return unreadable();
      const realCandidate = realpathSync(candidate);
      const realRelative = path.relative(realSkillsRoot, realCandidate);
      if (!realRelative || realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) return unreadable();
      if (resolved.has(skill.id)) return unreadable();
      resolved.set(skill.id, realCandidate);
    }
    return resolved;
  } catch (error) {
    if (error instanceof SkillDeliveryError) throw error;
    return unreadable();
  }
}

export function registeredSkillPath(registeredSkills: Map<string, string>, skill: string): string {
  const skillPath = registeredSkills.get(skill);
  if (!skillPath) throw new SkillDeliveryError("not-found", `"${skill}" is not a registered productfoo skill.`);
  return skillPath;
}

export function resolvePacketDir(root: string, packetArg: string | undefined): { packetDir: string; packetArg: string } {
  // A missing packet arg is a typo (usage_error); a named-but-absent packet is a not_found.
  // Neither is a defect, and neither may page — but as bare Errors both classified as
  // command_error and paged, because nearly every packet command funnels through here.
  if (!packetArg) throw new UsageError("packet-dir missing", "E_PACKET_DIR_MISSING");
  const packetDir = path.resolve(root, packetArg);
  if (!existsSync(packetDir)) throw new NotFoundError(`packet directory not found: ${packetArg}`, "E_PACKET_NOT_FOUND");
  return { packetDir, packetArg };
}

// Re-exported from the shared argv helpers so existing `./shared.js` importers
// keep working; new call sites can import from ../cliArgs.js directly.
export { hasFlag, flagValue } from "../cliArgs.js";

// productfoo's OWN version — resolved module-relative (this file compiles to
// dist/src/commands/shared.js, so ../../../package.json is productfoo's package root
// in every layout: repo checkout, bare clone, and npm-installed thin client).
// The old cwd-based read was wrong twice over: "unknown" from a clean install,
// and — worse — a tester running foo inside THEIR project reported THEIR app's
// version into telemetry. cwd stays only as a last-resort fallback, and only
// when its package.json actually declares the `foo` bin.
function versionFrom(pkgPath: string, requireFooBin: boolean): string | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = readJson<{ version?: unknown; bin?: Record<string, unknown> }>(pkgPath);
    if (requireFooBin && !(pkg.bin && typeof pkg.bin === "object" && "foo" in pkg.bin)) return null;
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function readPackageVersion(root: string): string {
  const selfPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
  return versionFrom(selfPkg, true) ?? versionFrom(path.join(root, "package.json"), true) ?? "unknown";
}
