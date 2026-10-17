#!/usr/bin/env node
// The marketplace plugin is another packaging of the installed skill launcher.
// Keep command behavior in src/commandContract.ts, never in this generator.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
let output = path.join(root, "plugins/foo-anthropic/skills");
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--check") continue;
  if (args[i] === "--output-dir" && args[i + 1] && !args[i + 1].startsWith("--")) {
    output = path.resolve(args[++i]);
    continue;
  }
  console.error("Usage: node scripts/build-anthropic-plugin.mjs [--check] [--output-dir <directory>]");
  process.exit(2);
}

const contractPath = path.join(root, "dist/src/commandContract.js");
if (!existsSync(contractPath)) {
  console.error("The compiled command contract is missing. Run npm run build, then rerun node scripts/build-anthropic-plugin.mjs" + (check ? " --check" : "") + ".");
  process.exit(1);
}
const { FOO_COMMAND_CONTRACT, renderLauncher } = await import(pathToFileURL(contractPath).href);
const expected = new Set(FOO_COMMAND_CONTRACT.map((entry) => entry.id));
const drift = [];
if (existsSync(output)) {
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(path.join(output, entry.name, "SKILL.md")) && !expected.has(entry.name)) {
      drift.push(`unexpected launcher: ${entry.name}/SKILL.md (remove or register the command deliberately)`);
    }
  }
}
for (const entry of FOO_COMMAND_CONTRACT) {
  const file = path.join(output, entry.id, "SKILL.md");
  // Matches renderPluginSkill in src/commands/agent.ts: only plugin frontmatter
  // differs from the canonical launcher. Bug's consent steps stay canonical.
  const text = renderLauncher(entry).replace(/^---\n/, `---\nname: ${entry.id}\n`);
  if (check) {
    if (!existsSync(file)) drift.push(`missing launcher: ${entry.id}/SKILL.md`);
    else if (readFileSync(file, "utf8") !== text) drift.push(`changed launcher: ${entry.id}/SKILL.md`);
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
if (drift.length) {
  console.error(`Anthropic plugin drift:\n${drift.map((item) => `- ${item}`).join("\n")}\nRun npm run build, then node scripts/build-anthropic-plugin.mjs; review unexpected launchers separately.`);
  process.exit(1);
}
console.log(`Anthropic plugin: ${FOO_COMMAND_CONTRACT.length} launchers ${check ? "match the command contract" : "generated"}.`);
