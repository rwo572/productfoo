import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve('.');
const cli = join(root, 'bin/foo');

test('the quickstart task-update command executes against a freshly created packet', () => {
  const work = mkdtempSync(join(tmpdir(), 'productfoo-doc-journey-'));
  const env = { PATH: process.env.PATH, HOME: work, TMPDIR: tmpdir(), NODE_ENV: 'test', FOO_HANDOFF: 'never', DO_NOT_TRACK: '1', FOO_STATE_DIR: join(work, '.foo') };
  const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: work, env, encoding: 'utf8' });
  try {
    run(['asp', 'init', 'specs/my-feature']);
    const guide = readFileSync(join(root, 'docs/getting-started.md'), 'utf8');
    const line = guide.split('\n').find(line => /^(?:bin\/)?foo asp task /.test(line));
    assert.ok(line, 'the quickstart must demonstrate task update');
    const tokens = [...line.matchAll(/"([^"]*)"|([^\s]+)/g)].map(m => m[1] ?? m[2]);
    run(tokens.slice(1));
    const state = readFileSync(join(work, 'specs/my-feature/tasks.yaml'), 'utf8');
    assert.match(state, /status: done/);
    assert.match(state, /test or review link/);
    assert.equal(JSON.parse(run(['asp', 'validate', 'specs/my-feature', '--json'])).ok, true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('documented project adapter preview works in a fresh home without creating project files', () => {
  const work = mkdtempSync(join(tmpdir(), 'productfoo-doc-adapters-'));
  try {
    const output = execFileSync(process.execPath, [cli, 'agent', 'setup', '--agent', 'all', '--scope', 'project', '--dry-run'], {
      cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: work, NODE_ENV: 'test', DO_NOT_TRACK: '1', FOO_STATE_DIR: join(work, 'state') },
    });
    assert.ok(output.length > 0);
    for (const directory of [".claude", ".agents", ".cursor", ".grok", ".opencode"]) assert.equal(existsSync(join(work, directory)), false, directory);
    const guide = readFileSync(join(root, 'docs/agent-adapters.md'), 'utf8');
    assert.match(guide, /foo agent setup --agent codex --scope global --yes/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
