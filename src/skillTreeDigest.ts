// One deterministic digest of a canonical skill tree, shared by every consumer
// that has to agree on what "this exact tree" means: the development-trust
// record (skillLocal.ts), the bundled-install anchor (skillClientPolicy.ts),
// the anchor drift test, and scripts/skill-tree-anchor.mjs. A second
// hand-written walk is exactly how two digests that claim to name the same
// tree drift apart, so the walk lives here and nowhere else.
//
// The digest covers every regular file, symlink, and directory under each
// top-level skill folder (folders whose names are valid skill ids), sorted
// canonically, domain-separated by the caller's hash-domain string. Any
// edit, addition, removal, or permission change under skills/ moves the hash.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

export interface SkillTreeSnapshot {
  /** Digest over the whole canonical tree under `domain`. */
  hash: string;
  /** Bytes of `targetRelative` (posix-style, relative to the skills root), when asked for. */
  targetBytes: Buffer | null;
}

const compareNames = (left: string, right: string): number => left.localeCompare(right);

export function skillTreeSnapshot(
  rootValue: string,
  domain: string,
  targetRelative?: string,
): SkillTreeSnapshot {
  const root = realpathSync(rootValue);
  const skillsRoot = path.join(root, "skills");
  const skillsReal = realpathSync(skillsRoot);
  if (skillsReal !== skillsRoot) throw new TypeError("development skills root must not be a symlink");
  const normalizedTarget = targetRelative?.split(path.sep).join(path.posix.sep);

  const entries: Array<{ relative: string; kind: "file" | "symlink"; bytes: Buffer }> = [];
  const topLevel = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .sort((left, right) => compareNames(left.name, right.name));

  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => compareNames(left.name, right.name))) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      const stat = lstatSync(childAbsolute);
      if (stat.isDirectory()) {
        visit(childAbsolute, childRelative);
      } else if (stat.isFile()) {
        entries.push({ relative: childRelative, kind: "file", bytes: readFileSync(childAbsolute) });
      } else if (stat.isSymbolicLink()) {
        entries.push({ relative: childRelative, kind: "symlink", bytes: Buffer.from(readlinkSync(childAbsolute), "utf8") });
      } else {
        throw new TypeError("development skill tree contains an unsupported filesystem object");
      }
    }
  };
  for (const entry of topLevel) visit(path.join(skillsRoot, entry.name), entry.name);

  const hash = createHash("sha256").update(`${domain}\0`, "utf8");
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.relative}\0${entry.bytes.length}\0`, "utf8");
    hash.update(entry.bytes);
  }
  const target = normalizedTarget === undefined
    ? null
    : entries.find((entry) => entry.relative === normalizedTarget && entry.kind === "file")?.bytes ?? null;
  return { hash: hash.digest("hex"), targetBytes: target === null ? null : Buffer.from(target) };
}

/** How many top-level folders the canonical tree carries (valid skill-id names only). */
export function topLevelSkillFolderCount(rootValue: string): number {
  const skillsRoot = path.join(realpathSync(rootValue), "skills");
  return readdirSync(realpathSync(skillsRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .length;
}
