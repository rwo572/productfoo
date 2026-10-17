import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import path from 'node:path';

export function stagePublicHistory(root, paths) {
  assert.ok(paths.length > 0, 'public manifest is empty');
  for (const p of paths) assert.ok(p && !p.includes('\0') && !path.isAbsolute(p) && !p.split('/').includes('..'), 'invalid public path');
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  // The private .gitignore can ignore an explicitly reviewed public fixture.
  // Force only the manifest paths, never the surrounding working directory.
  git(['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') + '\0' });
  const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    return { path: record.slice(tab + 1), mode, oid, stage };
  });
  assert.deepEqual(entries.map(e => e.path).sort(), [...paths].sort(), 'index differs from the reviewed manifest');
  for (const entry of entries) {
    const stat = lstatSync(path.join(root, entry.path));
    assert.ok(stat.isFile(), 'public history requires regular files');
    assert.equal(entry.stage, '0', 'unmerged public path');
    assert.equal(entry.mode, stat.mode & 0o111 ? '100755' : '100644', `mode mismatch: ${entry.path}`);
    assert.equal(entry.oid, git(['hash-object', '--no-filters', '--', entry.path]).trim(), `bytes mismatch: ${entry.path}`);
  }
}
