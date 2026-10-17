import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyRelease } from './verify-release.mjs';

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'foo-release-guard-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'productfoo', version: '1.0.0' }));
  writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  git('add', '.'); git('commit', '-qm', 'Public root');
  const root = git('rev-parse', 'HEAD');
  mkdirSync(path.join(cwd, '.github'));
  const manifest = { package: 'productfoo', version: '1.0.0', payload_root: root,
    tarball: 'productfoo-1.0.0.tgz', tarball_sha256: createHash('sha256').update('fixture package').digest('hex') };
  writeFileSync(path.join(cwd, '.github/release-candidate.json'), JSON.stringify(manifest));
  git('add', '.github'); git('commit', '-qm', 'Release configuration');
  git('tag', 'v1.0.0');
  const env = { GITHUB_REPOSITORY: 'rwo572/productfoo', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/tags/v1.0.0', GITHUB_SHA: git('rev-parse', 'HEAD'), EXPECTED_SHA: git('rev-parse', 'HEAD') };
  return { cwd, git, env, manifest, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('accepts the exact public payload, approved tag and exact package bytes', () => {
  const f = fixture();
  try {
    assert.equal(verifyRelease(f.cwd, 'source', {}).version, '1.0.0');
    assert.equal(verifyRelease(f.cwd, 'release', f.env).version, '1.0.0');
    writeFileSync(path.join(f.cwd, f.manifest.tarball), 'fixture package');
    assert.equal(verifyRelease(f.cwd, 'package', f.env).tarball_sha256, f.manifest.tarball_sha256);
  } finally { f.close(); }
});

test('rejects wrong repository, trigger, tag, expected commit, and tag target', () => {
  const f = fixture();
  try {
    for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'other/productfoo',
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', EXPECTED_SHA: '0'.repeat(40), GITHUB_SHA: '1'.repeat(40) })) {
      assert.throws(() => verifyRelease(f.cwd, 'release', { ...f.env, [key]: value }));
    }
    f.git('tag', '-f', 'v1.0.0', f.manifest.payload_root);
    assert.throws(() => verifyRelease(f.cwd, 'release', f.env), /tag/);
  } finally { f.close(); }
});

test('rejects dirty tracked files, unexpected untracked files, and changed product bytes', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cwd, 'private-notes.txt'), 'synthetic private fixture');
    assert.throws(() => verifyRelease(f.cwd, 'source', {}), /untracked/);
    rmSync(path.join(f.cwd, 'private-notes.txt'));
    writeFileSync(path.join(f.cwd, 'package.json'), JSON.stringify({ name: 'productfoo', version: '1.0.1' }));
    assert.throws(() => verifyRelease(f.cwd, 'source', {}));
    f.git('add', '.'); f.git('commit', '-qm', 'Alter product');
    assert.throws(() => verifyRelease(f.cwd, 'source', {}), /payload/);
  } finally { f.close(); }
});

test('rejects a package with different bytes and a mismatched lock version', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cwd, f.manifest.tarball), 'wrong bytes');
    assert.throws(() => verifyRelease(f.cwd, 'package', f.env), /hash/);
    rmSync(path.join(f.cwd, f.manifest.tarball));
    const lock = JSON.parse(readFileSync(path.join(f.cwd, 'package-lock.json')));
    lock.packages[''].version = '0.1.37';
    writeFileSync(path.join(f.cwd, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => verifyRelease(f.cwd, 'source', {}));
  } finally { f.close(); }
});

test('rejects merged foreign history even when the resulting product files match', () => {
  const f = fixture();
  try {
    const tree = f.git('rev-parse', 'HEAD^{tree}');
    const foreign = execFileSync('git', ['commit-tree', tree, '-m', 'Foreign root'], { cwd: f.cwd, encoding: 'utf8' }).trim();
    const merged = f.git('commit-tree', tree, '-p', f.git('rev-parse', 'HEAD'), '-p', foreign, '-m', 'Mixed history');
    f.git('update-ref', 'HEAD', merged);
    assert.throws(() => verifyRelease(f.cwd, 'source', {}), /root/);
  } finally { f.close(); }
});

test('accepts a reviewed payload revision without replacing the original public root', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cwd, 'README.md'), '# productfoo\n');
    f.git('add', 'README.md'); f.git('commit', '-qm', 'Reviewed branding');
    f.manifest.payload_commit = f.git('rev-parse', 'HEAD');
    writeFileSync(path.join(f.cwd, '.github/release-candidate.json'), JSON.stringify(f.manifest));
    f.git('add', '.github'); f.git('commit', '-qm', 'Pin reviewed revision');
    assert.equal(verifyRelease(f.cwd, 'source', {}).payload_commit, f.manifest.payload_commit);
    writeFileSync(path.join(f.cwd, 'README.md'), '# Unreviewed change\n');
    f.git('add', 'README.md'); f.git('commit', '-qm', 'Alter reviewed payload');
    assert.throws(() => verifyRelease(f.cwd, 'source', {}), /payload/);
  } finally { f.close(); }
});

test('rejects a payload pin that is not a full ancestor commit', () => {
  const f = fixture();
  try {
    const foreign = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'Unrelated payload');
    for (const pin of [foreign, 'HEAD', 'f'.repeat(40)]) {
      f.manifest.payload_commit = pin;
      writeFileSync(path.join(f.cwd, '.github/release-candidate.json'), JSON.stringify(f.manifest));
      f.git('add', '.github'); f.git('commit', '-qm', 'Invalid pin');
      assert.throws(() => verifyRelease(f.cwd, 'source', {}));
    }
  } finally { f.close(); }
});
