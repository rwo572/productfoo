#!/usr/bin/env node
// skill-tree-anchor.mjs — regenerate (default) or verify (--check) the bundled
// skill-tree anchor in src/skillClientPolicy.ts.
//
// The anchor is the digest of the canonical skills/ tree this build ships
// (the public skill-delivery contract). It is what lets an installed package
// run its own bundled skills with no hosted call and no per-machine approval:
// npm's tarball integrity binds the install, the anchor binds every read. Run
// this after any reviewed change to skills/, then commit both together.
//
// `--check` exits 1 when the committed anchor no longer names the tree — the
// CI step that keeps a stale anchor from shipping a smoke test that refuses
// clean installs. Both modes read the tree through the compiled walker
// (dist/src/skillTreeDigest.js, produced by npm run build), so the anchor, the runtime trust check, and the drift test all
// share one implementation instead of three hand-copied walks.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "src", "skillClientPolicy.ts");
const WALKER_PATH = path.join(ROOT, "dist", "src", "skillTreeDigest.js");
const BEGIN = "  // ==== skill-tree-anchor:generated (scripts/skill-tree-anchor.mjs) ====";
const END = "  // ==== end skill-tree-anchor:generated ====";

const check = process.argv.includes("--check");

const walkerHref = pathToFileURL(WALKER_PATH).href;
let walker;
try {
  walker = await import(walkerHref);
} catch {
  console.error(`skill-tree-anchor: ${path.relative(ROOT, WALKER_PATH)} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const domainMatch = readFileSync(POLICY_PATH, "utf8").match(/export const BUNDLED_SKILL_TREE_DOMAIN = "([^"]+)";/);
if (!domainMatch) {
  console.error("skill-tree-anchor: BUNDLED_SKILL_TREE_DOMAIN not found in src/skillClientPolicy.ts");
  process.exit(1);
}

const { hash } = walker.skillTreeSnapshot(ROOT, domainMatch[1]);
const skill_count = walker.topLevelSkillFolderCount(ROOT);
const block = `${BEGIN}\n  skill_count: ${skill_count},\n  tree_sha256: "${hash}",\n  ${END}`;

const source = readFileSync(POLICY_PATH, "utf8");
const pattern = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
if (!pattern.test(source)) {
  console.error("skill-tree-anchor: generated marker block missing from src/skillClientPolicy.ts — restore it before regenerating.");
  process.exit(1);
}

if (check) {
  const current = source.match(pattern)[0];
  if (current !== block) {
    console.error("skill-tree-anchor: the committed anchor does not name the current skills/ tree.");
    console.error("  skills/ changed without re-anchoring — a clean install would refuse its own bundled skills.");
    console.error("  Regenerate and commit together: node scripts/skill-tree-anchor.mjs");
    process.exit(1);
  }
  console.log(`skill-tree-anchor: ok (${skill_count} skills, ${hash.slice(0, 12)}…)`);
} else {
  writeFileSync(POLICY_PATH, source.replace(pattern, block));
  console.log(`skill-tree-anchor: wrote ${skill_count} skills, ${hash.slice(0, 12)}… to src/skillClientPolicy.ts`);
}
