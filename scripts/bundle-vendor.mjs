// Bundle productfoo's single third-party runtime dependency (`yaml`) into a
// self-contained dist/src/vendorYaml.js, so the committed dist runs `foo` from
// a bare clone with NO `npm install` at all (npm-installer-v0 R-013). tsc emits
// the rest of dist; this esbuild pass inlines yaml (tree-shaken to parse +
// stringify) into the one vendor module every other module imports.
//
// The banner provides a `require` for the few Node builtins yaml reaches for
// (esbuild's dynamic-require shim delegates to it), so the ESM bundle needs only
// Node itself — no node_modules — at runtime. esbuild is pinned for a
// reproducible bundle, so the committed dist stays byte-stable for CI's
// stale-dist guard.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const OUTFILE = "dist/src/vendorYaml.js";

await build({
  entryPoints: ["src/vendorYaml.ts"],
  outfile: OUTFILE,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  banner: {
    js: "import { createRequire as __fooCreateRequire } from 'node:module'; const require = __fooCreateRequire(import.meta.url);",
  },
});

// esbuild embeds each bundled module's path *relative to the build cwd* as a
// comment. A repo-root build emits `node_modules/...`; a git-worktree build
// (which AGENTS.md mandates, and which has no local node_modules) resolves the
// dep two levels up and emits `../../node_modules/...`. That makes the bundle
// non-reproducible across build locations and trips CI's stale-dist guard.
// Normalize any leading `../`-walk before `node_modules/` so the committed
// bytes are location-independent regardless of where the build ran.
const normalized = readFileSync(OUTFILE, "utf8").replace(/(?:\.\.\/)+node_modules\//g, "node_modules/");
writeFileSync(OUTFILE, normalized);
