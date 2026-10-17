import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

function launch(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'foo-launcher-'));
  try {
    mkdirSync(path.join(root, 'bin'));
    copyFileSync(path.resolve('bin/foo'), path.join(root, 'bin/foo'));
    copyFileSync(path.resolve('bin/foo.mjs'), path.join(root, 'bin/foo.mjs'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    }
    return spawnSync(process.execPath, [path.join(root, 'bin/foo'), 'argument with spaces'], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const publicCli = 'export function main(args) { console.log(JSON.stringify(args)); return 0; }';
const staleOperator = 'throw new Error("stale operator executed");';

test('launcher ignores a stale private operator build when the repository CLI exists', () => {
  const result = launch({ 'dist/src/cliOperator.js': staleOperator, 'dist/src/cli.js': publicCli });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['argument with spaces']);
});

test('launcher runs the packaged CLI even when stale operator output is present', () => {
  const result = launch({ 'dist/src/cliOperator.js': staleOperator, 'dist-public/src/cli.js': publicCli });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['argument with spaces']);
});

test('launcher refuses an operator-only checkout and explains how to build the public CLI', () => {
  const result = launch({ 'dist/src/cliOperator.js': staleOperator });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI build not found/);
  assert.match(result.stderr, /npm ci && npm run build/);
  assert.doesNotMatch(result.stderr, /stale operator executed/);
});
