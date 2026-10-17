import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed-release guard. Updating the payload or version requires a new reviewed
// manifest, artifact verification and approval; a tag alone never grants it.
export function verifyRelease(cwd, mode, env = process.env) {
  assert.ok(['source', 'release', 'package'].includes(mode), 'unknown verification mode');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const read = p => JSON.parse(readFileSync(path.join(cwd, p), 'utf8'));
  const candidate = read('.github/release-candidate.json');
  assert.match(candidate.payload_root, /^[a-f0-9]{40}$/, 'invalid payload root');
  assert.match(candidate.tarball_sha256, /^[a-f0-9]{64}$/, 'invalid package hash');
  assert.equal(candidate.package, 'productfoo', 'wrong package');
  assert.equal(candidate.status, 'approved', 'candidate must be approved');
  assert.equal(candidate.version, '1.0.1', 'approved release must be 1.0.1');
  assert.equal(candidate.tarball, 'productfoo-1.0.1.tgz', 'wrong package filename');
  assert.equal(git('rev-list', '--max-parents=0', 'HEAD'), candidate.payload_root, 'history must have only the approved public root');
  // Keep the original public-only history, while allowing an explicitly reviewed
  // revision to become the frozen payload without rewriting published Git refs.
  const payload = candidate.payload_commit ?? candidate.payload_root;
  assert.match(payload, /^[a-f0-9]{40}$/, 'invalid payload commit');
  assert.equal(git('cat-file', '-t', payload), 'commit', 'payload pin must be a commit');
  git('merge-base', '--is-ancestor', payload, 'HEAD');
  assert.equal(git('diff', '--name-only', payload, 'HEAD', '--', '.', ':(exclude).github'), '', 'product payload differs from the verified commit');
  assert.equal(git('diff', '--name-only', 'HEAD'), '', 'tracked worktree must be clean');
  const unexpected = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)
    .filter(p => !p.startsWith('dist/') && !p.startsWith('dist-public/') && p !== 'tsconfig.public.generated.json' && p !== candidate.tarball);
  assert.deepEqual(unexpected, [], 'unexpected untracked files');
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(pkg.name, candidate.package, 'package identity mismatch');
  for (const v of [pkg.version, lock.version, lock.packages?.['']?.version]) assert.equal(v, candidate.version, 'version mismatch');
  if (mode !== 'source') {
    assert.equal(env.GITHUB_REPOSITORY, 'rwo572/productfoo', 'wrong publishing repository');
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'release must be manually dispatched');
    assert.equal(env.GITHUB_REF, 'refs/tags/v1.0.1', 'release must run on the approved tag');
    const head = git('rev-parse', 'HEAD');
    assert.equal(env.GITHUB_SHA, head, 'workflow SHA mismatch');
    assert.equal(env.EXPECTED_SHA, head, 'approved SHA mismatch');
    assert.equal(git('rev-parse', 'refs/tags/v1.0.1^{commit}'), head, 'tag target mismatch');
  }
  if (mode === 'package') {
    const hash = createHash('sha256').update(readFileSync(path.join(cwd, candidate.tarball))).digest('hex');
    assert.equal(hash, candidate.tarball_sha256, 'package hash mismatch');
  }
  return candidate;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const candidate = verifyRelease(process.cwd(), process.argv[2]);
    console.log(`Verified ${candidate.package}@${candidate.version}: ${process.argv[2]}`);
  } catch (error) {
    console.error(`Release refused: ${error.message}`);
    process.exitCode = 1;
  }
}
