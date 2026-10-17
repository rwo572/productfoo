#!/usr/bin/env node
// Run with the Node version being tested against an already installed package.
// Build/install provisioning is deliberately separate from runtime compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanInstallEnv, REPORTING_NET_DENY_PRELOAD_SOURCE } from './lib/publicSmokeCore.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/test-installed-runtime.mjs <installed-package-root>');
const packageRoot = path.resolve(process.argv[2]);
const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const work = mkdtempSync(path.join(tmpdir(), 'productfoo-runtime-'));
const passed = [];
try {
  const project = path.join(work, 'project');
  mkdirSync(project);
  const guard = path.join(work, 'deny-network.cjs');
  const attempts = path.join(work, 'network-attempts.log');
  writeFileSync(guard, REPORTING_NET_DENY_PRELOAD_SOURCE);
  writeFileSync(attempts, '');
  const env = { ...cleanInstallEnv(path.join(work, 'home')), FOO_HANDOFF: 'never', FOO_SKIP_UPDATE_CHECK: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(guard)}`, FOO_REPORT_NETWORK_ATTEMPTS: attempts };
  const control = spawnSync(process.execPath, ['-e', 'require("node:net").connect(443, "example.test")'], { env, encoding: 'utf8' });
  assert.notEqual(control.status, 0, 'network denial positive control did not fail');
  assert.ok(readFileSync(attempts, 'utf8').trim(), 'network denial positive control was not recorded');
  writeFileSync(attempts, '');
  const invoke = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, metadata.bin.foo), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 1 << 24,
    });
    assert.equal(result.status, expected, `${args.join(' ')}: ${result.error?.message || ''}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const check = (name, fn) => { fn(); passed.push(name); };
  check('version', () => assert.equal(invoke(['--version']).trim(), metadata.version));
  check('help', () => assert.match(invoke(['help', '--all']), /research/));
  check('nine commands', () => assert.deepEqual(JSON.parse(invoke(['commands', 'list', '--json'])).commands.map(c => c.id).sort(),
    ['bug', 'discovery', 'ideate', 'init', 'pitch', 'preview', 'research', 'roast', 'spec']));
  check('doctor', () => assert.ok(JSON.parse(invoke(['doctor', '--json']))));
  check('bundled skill', () => assert.ok(invoke(['skill', 'create-prd']).trim().length > 100));
  check('init', () => invoke(['init', '--json']));
  check('spec creation', () => invoke(['spec', 'start', 'Synthetic compatibility fixture', '--request', 'Check local packet creation', '--packet', 'runtime-v0']));
  check('packet validation', () => assert.equal(JSON.parse(invoke(['asp', 'validate', 'specs/runtime-v0', '--json'])).ok, true));
  check('research planning', () => invoke(['research', 'Synthetic local compatibility fixture', '--json']));
  check('discovery planning', () => {
    mkdirSync(path.join(project, 'discovery/inbox'), { recursive: true });
    writeFileSync(path.join(project, 'discovery/inbox/scope.yaml'), [
      'schema_version: "0.1"', 'scopes:', '  - scope_id: runtime_fixture', '    provider: granola',
      '    connection_alias: main', '    state: approved', '    approved_by: Synthetic Fixture',
      '    approved_at: 2026-10-16T00:00:00.000Z', '    time_window:',
      '      start: 2026-10-01T00:00:00Z', '      end: 2026-10-31T23:59:59Z',
      '    participant_allowlist:', '      - Synthetic Participant', '',
    ].join('\n'));
    invoke(['discovery', 'plan', '--inbox', '--json']);
  });
  check('ideation planning', () => invoke(['ideate', 'Synthetic local compatibility fixture', '--json']));
  check('pitch planning', () => invoke(['pitch', 'Synthetic local compatibility fixture', '--json']));
  check('roast planning', () => invoke(['roast', 'specs/runtime-v0', '--json']));
  check('preview planning', () => invoke(['preview', 'specs/runtime-v0', '--json']));
  check('adapter dry-run', () => invoke(['agent', 'setup', '--agent', 'all', '--scope', 'project', '--dry-run']));
  check('local report lifecycle', () => {
    const saved = JSON.parse(invoke(['report', 'add', '--expected', 'Synthetic expectation', '--actual', 'Synthetic result', '--json']));
    const shown = JSON.parse(invoke(['report', 'show', saved.capsule_id, '--json']));
    assert.equal(shown.capsule_id, saved.capsule_id);
    assert.equal(JSON.parse(invoke(['report', 'delete', saved.capsule_id, '--approve', saved.payload_digest, '--json'])).status, 'deleted');
  });
  check('library import', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist-public/src/index.js')).href)}); if (typeof m.main !== 'function') process.exit(1);`],
      { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
  });
  assert.equal(readFileSync(attempts, 'utf8'), '', 'runtime checks attempted network access');
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, package: metadata.name, version: metadata.version, checks: passed, result: 'pass' }));
} finally { rmSync(work, { recursive: true, force: true }); }
