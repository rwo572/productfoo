#!/usr/bin/env node
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryFindings, readInventory, requireClean, sourceFindings, trackedFiles } from './lib/publicManifest.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const reviewed = readInventory(root, 'public-source-files.json');
  const actual = trackedFiles(root);
  const missing = actual.filter(p => !existsSync(path.join(root, p))).map(p => `tracked file missing: ${p}`);
  const links = actual.filter(p => existsSync(path.join(root, p)) && lstatSync(path.join(root, p)).isSymbolicLink()).map(p => `tracked symlink requires a separately reviewed distribution rule: ${p}`);
  requireClean([...sourceFindings(actual), ...inventoryFindings(actual, reviewed), ...missing, ...links], 'Public source verification failed');
  console.log(`verify-public-git-manifest: ${actual.length} tracked files match the reviewed public source inventory.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
