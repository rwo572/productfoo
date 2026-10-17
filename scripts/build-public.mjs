#!/usr/bin/env node
// Build only reviewed public TypeScript sources into a fresh dist-public/.
// The public source inventory is shipped with this repository. It is required:
// adding a module requires a deliberate inventory update, never a private repo.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, "dist-public");
const GENERATED_CONFIG = path.join(ROOT, "tsconfig.public.generated.json");

function fail(message) {
  console.error(message);
  process.exit(2);
}

function walkEmitted(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkEmitted(full, acc);
      continue;
    }
    acc.push(path.relative(OUT_DIR, full).split(path.sep).join("/"));
  }
  return acc;
}

// 1. Never build on top of previous output; the mixed dist/ tree is never read.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const inventoryPath = path.join(ROOT, "config", "public-source-files.json");
if (!existsSync(inventoryPath)) fail("build-public: missing config/public-source-files.json; restore the reviewed public source inventory.");
const sourceInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
if (sourceInventory.schema_version !== 1 || !Array.isArray(sourceInventory.files)) fail("build-public: invalid public source inventory");
const inputFiles = sourceInventory.files.filter(p => p.startsWith("src/") && p.endsWith(".ts"));
for (const entrypoint of ["src/cli.ts", "src/index.ts"]) {
  if (!inputFiles.includes(entrypoint)) fail(`build-public: entrypoint ${entrypoint} is not reviewed.`);
}
for (const source of inputFiles) {
  if (!existsSync(path.join(ROOT, source))) fail(`build-public: reviewed source missing: ${source}`);
}

// 2. Compile exactly the computed file list through the reviewed base config.
writeFileSync(GENERATED_CONFIG, `${JSON.stringify({ extends: "./config/tsconfig.public.json", files: inputFiles }, null, 2)}\n`);
const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", GENERATED_CONFIG], {
  cwd: ROOT,
  encoding: "utf8",
});
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout ?? "");
  process.stderr.write(tsc.stderr ?? "");
  process.exit(1);
}

// 3. Bundle the one runtime dependency so dist-public stays self-contained —
// the same esbuild pass the mixed build runs (scripts/bundle-vendor.mjs),
// aimed at the public outDir. esbuild is pinned for a reproducible bundle.
await build({
  entryPoints: [path.join(ROOT, "src", "vendorYaml.ts")],
  outfile: path.join(OUT_DIR, "src", "vendorYaml.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  banner: {
    js: "import { createRequire as __fooCreateRequire } from 'node:module'; const require = __fooCreateRequire(import.meta.url);",
  },
});
// esbuild embeds module paths relative to the build cwd. Normalize a leading
// ../-walk before node_modules/ so the bundle bytes are location-independent
// (see scripts/bundle-vendor.mjs for the full rationale).
const vendorPath = path.join(OUT_DIR, "src", "vendorYaml.js");
const normalized = readFileSync(vendorPath, "utf8").replace(/(?:\.\.\/)+node_modules\//g, "node_modules/");
writeFileSync(vendorPath, normalized);

// 4. Prove the emitted set (C-010).
const emitted = walkEmitted(OUT_DIR);
const findings = [];

// Every emitted file must map back to a source that exists on disk.
for (const relative of emitted) {
  const sourceTs = relative.replace(/\.d\.ts$/, ".ts").replace(/\.js$/, ".ts");
  if (!existsSync(path.join(ROOT, sourceTs))) {
    findings.push(`emitted ${relative} has no source ${sourceTs} — stale or misdirected output`);
  }
}

// Every listed input must have been emitted — no silent partial build.
const emittedJs = new Set(emitted.filter((p) => p.endsWith(".js")));
for (const input of inputFiles) {
  if (!emittedJs.has(input.replace(/\.ts$/, ".js"))) {
    findings.push(`compile input ${input} produced no output — the build is partial`);
  }
}

// Transitive imports must also belong to the reviewed public source set.
const reviewed = new Set(inputFiles);
const emittedSources = emitted.filter(p => p.endsWith(".js")).map(p => p.replace(/\.js$/, ".ts"));
for (const source of emittedSources) {
  if (!reviewed.has(source)) findings.push(`unreviewed module compiled: ${source}`);
}
const compiledModules = emittedSources.length;

if (findings.length) {
  console.error(`build-public: the public-only build is not proven — ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

const testCount = inputFiles.filter((p) => p.startsWith("test/")).length;
// stderr, not stdout: prepack runs this script inside `npm pack --json`, whose
// stdout must stay a clean JSON document — test/foo_cli.test.ts parses it.
console.error(
  `build-public: OK — ${compiledModules} reviewed public src modules compiled, ${emitted.length} emitted files in dist-public/, ${testCount} public test file(s) compiled.`,
);
