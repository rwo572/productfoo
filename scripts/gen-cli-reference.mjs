#!/usr/bin/env node
// Generate docs/cli-reference.md from the CLI's own `help --all` output.
//
// The generated file is the single public CLI reference. Because its body is
// captured verbatim from the compiled CLI (not hand-written), it cannot drift
// silently: `--check` regenerates and compares, and CI runs the check so a
// help-text change without a matching doc update fails the build.
//
// Usage:
//   node scripts/gen-cli-reference.mjs          # rewrite docs/cli-reference.md
//   node scripts/gen-cli-reference.mjs --check  # exit 1 if it is stale

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = "docs/cli-reference.md";
const OUT_FILE = join(repoRoot, DOC_PATH);

const header = `# CLI reference

This is the complete command surface of the \`foo\` CLI, captured from
\`foo help --all\`. The file is generated — do not edit it by hand. To
regenerate it after changing help text, run:

\`\`\`bash
node scripts/gen-cli-reference.mjs
\`\`\`

Every command also reports its own usage when run without required arguments.
If this reference and the CLI ever disagree, the CLI is the source of truth:
[file an issue](https://github.com/rwo572/productfoo/issues).

<!-- The listing below is generated; edit the CLI's help text instead. -->

\`\`\`text
`;

const footer = `\`\`\`
`;

function render() {
  let help;
  // Pin the reference to the PUBLIC CLI posture: bin/foo prefers the operator
  // entrypoint in this checkout (hosted commands wired on top), whose help
  // adds lines the exported public tree and the npm package cannot reproduce.
  // Both builds compile the same src/cli.ts, so `help --all` is identical
  // across them and the generated doc regenerates clean everywhere.
  const cliCandidates = ["dist/src/cli.js", "dist-public/src/cli.js"];
  const cliEntry = cliCandidates
    .map((rel) => join(repoRoot, rel))
    .find((candidate) => existsSync(candidate));
  if (!cliEntry) {
    console.error(
      "gen-cli-reference: no compiled public CLI entry found (dist/src/cli.js or dist-public/src/cli.js). From the repo root run: npm install && npm run build",
    );
    process.exit(1);
  }
  try {
    help = execFileSync(process.execPath, [cliEntry, "help", "--all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    console.error("gen-cli-reference: `help --all` failed:", err.message);
    process.exit(1);
  }
  // Normalize trailing whitespace so the check is byte-stable across builds.
  const body = help.replace(/\s+$/, "\n");
  return `${header}${body}${footer}`;
}

const next = render();

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT_FILE, "utf8");
  if (current !== next) {
    console.error(
      `gen-cli-reference: ${DOC_PATH} is stale. Run \`node scripts/gen-cli-reference.mjs\` and commit the result.`
    );
    process.exit(1);
  }
  console.log(`gen-cli-reference: ${DOC_PATH} is up to date.`);
} else {
  writeFileSync(OUT_FILE, next);
  console.log(`gen-cli-reference: wrote ${DOC_PATH}`);
}
