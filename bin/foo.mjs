#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Repository checkouts run their built CLI from dist/. Packed installations
// ship dist-public/. Private operator output is never a launcher candidate.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, "..", "dist", "src", "cli.js"),
  path.join(here, "..", "dist-public", "src", "cli.js"),
];
const cliPath = candidates.find((candidate) => existsSync(candidate));

if (!cliPath) {
  process.stderr.write(
    "foo: CLI build not found (dist/src/cli.js or dist-public/src/cli.js).\n" +
      "This checkout has no built CLI. From the repo root run:\n" +
      "  npm ci && npm run build\n",
  );
  process.exit(1);
}

import(pathToFileURL(cliPath).href)
  .then(({ main }) => main(process.argv.slice(2)))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error?.message ?? String(error);
    if (error?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(message)) {
      // Explain dependency repair without exposing an import stack trace.
      process.stderr.write(
        "foo: a runtime dependency is missing (node_modules).\n" +
          "For a source checkout, run npm ci && npm run build.\n" +
          "For an installed package, reinstall the reviewed tarball.\n",
      );
    } else {
      process.stderr.write(`foo: failed to start CLI: ${message}\n`);
    }
    process.exit(1);
  });
