#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryFindings, packageFindings, packedFiles, readInventory, requireClean } from './lib/publicManifest.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const source = readInventory(root, 'public-source-files.json');
  const reviewed = readInventory(root, 'public-package-files.json');
  const actual = packedFiles(root);
  requireClean([...packageFindings(actual, source), ...inventoryFindings(actual, reviewed)], 'Public package verification failed');
  console.log(`verify-public-package: ${actual.length} files match the reviewed public inventory.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
