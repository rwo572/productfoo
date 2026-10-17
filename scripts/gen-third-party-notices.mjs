#!/usr/bin/env node
// Generate docs/THIRD_PARTY_NOTICES.md from the production dependency tree.
//
// This generator walks package.json's direct runtime `dependencies` and
// renders one section per package: identity,
// version, license, homepage, and the license text as installed. Build-time
// tooling (devDependencies such as esbuild, tsc, tsx) is not distributed and
// is intentionally out of scope.
//
// `--check` regenerates and compares, exiting 1 on drift; CI runs the check
// so a dependency or license change without a matching notice update fails
// the build.
//
// Usage:
//   node scripts/gen-third-party-notices.mjs          # rewrite the notices
//   node scripts/gen-third-party-notices.mjs --check  # exit 1 if stale

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(repoRoot, "docs/THIRD_PARTY_NOTICES.md");

const HEADER = `# Third-party notices

This file lists productfoo's direct runtime dependencies and their licenses.
It is generated from the package's declared dependencies by
\`scripts/gen-third-party-notices.mjs\` — do not edit it by hand. To
regenerate after adding or upgrading a runtime dependency, run:

\`\`\`bash
node scripts/gen-third-party-notices.mjs
\`\`\`

Scope note: runtime dependencies may be bundled into the build or installed
alongside the package by npm. Development and build-time tooling is not
distributed with the package and is not listed here. productfoo itself is
licensed under the [Apache License 2.0](https://github.com/rwo572/productfoo/blob/main/LICENSE).
`;

function licenseFilePath(pkgDir) {
  for (const entry of readdirSync(pkgDir)) {
    if (/^licen[cs]e/i.test(entry) && !entry.endsWith(".json")) {
      return join(pkgDir, entry);
    }
  }
  return null;
}

function collect() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const deps = Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  if (deps.length === 0) {
    return "productfoo currently has no runtime dependencies.\n";
  }

  const sections = deps.map(([name]) => {
    const dir = join(repoRoot, "node_modules", ...name.split("/"));
    if (!existsSync(dir)) {
      throw new Error(
        `gen-third-party-notices: ${name} is not installed — run \`npm install\` first.`
      );
    }
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const license = meta.license ?? "UNKNOWN";
    const homepage = meta.homepage ?? meta.repository?.url ?? "(no homepage)";
    const licenseFile = licenseFilePath(dir);
    if (!licenseFile) {
      throw new Error(
        `gen-third-party-notices: ${name} ships no license file; add its license text manually to the generator's render step.`
      );
    }
    const licenseText = readFileSync(licenseFile, "utf8").trim();
    return [
      `## ${meta.name ?? name} ${meta.version ?? ""}`.trim() + "\n",
      `- License: ${license}`,
      `- Homepage: ${homepage}`,
      "",
      "```text",
      licenseText,
      "```",
    ].join("\n");
  });

  return `${HEADER}\n${sections.join("\n\n")}\n`;
}

const next = collect();

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT_FILE, "utf8");
  if (current !== next) {
    console.error(
      "gen-third-party-notices: docs/THIRD_PARTY_NOTICES.md is stale. Run `node scripts/gen-third-party-notices.mjs` and commit the result."
    );
    process.exit(1);
  }
  console.log("gen-third-party-notices: docs/THIRD_PARTY_NOTICES.md is up to date.");
} else {
  writeFileSync(OUT_FILE, next);
  console.log("gen-third-party-notices: wrote docs/THIRD_PARTY_NOTICES.md");
}
