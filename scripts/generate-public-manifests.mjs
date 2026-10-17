#!/usr/bin/env node
// Update path inventories deliberately after reviewing and staging intended files.
// This does not certify content safety or approve a release.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryFindings, packageFindings, packedFiles, readInventory, requireClean, sourceFindings, trackedFiles } from './lib/publicManifest.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const source = trackedFiles(root);
  const sourceOnly = process.argv.includes('--source-only');
  const packed = sourceOnly ? [] : packedFiles(root);
  requireClean([...sourceFindings(source), ...packageFindings(packed, source)], 'Cannot generate public inventories');
  const inventories = [['public-source-files.json', source], ...(sourceOnly ? [] : [['public-package-files.json', packed]])];
  for (const [name, files] of inventories) {
    if (process.argv.includes('--write')) {
      writeFileSync(path.join(root, 'config', name), `${JSON.stringify({ schema_version: 1, description: 'Reviewed public paths. Regenerate deliberately with node scripts/generate-public-manifests.mjs --write; review and commit the diff.', files }, null, 2)}\n`);
    } else {
      requireClean(inventoryFindings(files, readInventory(root, name)), `${name} is stale`);
    }
  }
  console.log(process.argv.includes('--write') ? 'Public inventories written. Review additions and removals before committing.' : 'Public inventories match.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
