import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordDisposition } from '../src/evidenceIntake.js';
import { minimizeSummary } from '../src/sourceIngress.js';

for (const [label, module, body] of [
  ['summary scrubbing', 'sourceIngress', "minimizeSummary('+'.repeat(200000))"],
  ['stack fingerprinting', 'errorTaxonomy', "errorFingerprint('E_TEST', 'at ! ('.repeat(100000))"],
]) {
  test(`${label} finishes on long adversarial input`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { ${module === 'sourceIngress' ? 'minimizeSummary' : 'errorFingerprint'} } from './dist/src/${module}.js'; ${body}`], { timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
  });
}

test('summary redaction preserves email matching across adjacent addresses and invalid prefixes', () => {
  assert.equal(minimizeSummary('a@b.c+d@e.f @missing example+tag@host.test'), '[email][email] @missing [email]');
});

test('evidence disposition treats candidate metacharacters literally', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'foo-evidence-literal-'));
  try {
    writeFileSync(path.join(dir, 'tasks.yaml'), 'schema_version: "0.1"\nspec_id: security_test\ntasks:\n  - id: T.[001]\n    title: Literal candidate\n    status: doing\n    notes: "Evidence: https://example.com/proof"\n');
    writeFileSync(path.join(dir, 'events.jsonl'), '');
    recordDisposition(dir, 'T.[001]', { action: 'accept', by: 'maintainer' });
    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].data.evidence_url, 'https://example.com/proof');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('example renderer escapes quotes in HTML attributes', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {render} from './examples/outside-in-audit/render.mjs'; console.log(render({map:[],moves:[],mark:'logo" onerror="alert(1)',quotes:[{receipts:[{href:'https://example.com/" onclick="alert(1)',label:'proof'}]}]}));`], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('src="logo&quot; onerror=&quot;alert(1)"'));
  assert.ok(result.stdout.includes('href="https://example.com/&quot; onclick=&quot;alert(1)"'));
});
