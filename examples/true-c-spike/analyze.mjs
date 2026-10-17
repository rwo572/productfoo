// Local egress experiment. Inspect one capture against explicit synthetic canaries.
// A clean match result does not establish containment or absence of other data.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function analyze() {
  if (process.argv.length > 3) throw new Error('Usage: node analyze.mjs [capture-directory]');
  const dir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
  const lines = readFileSync(path.join(dir, 'wire-log.jsonl'), 'utf8').trim();
  const wire = lines ? lines.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)) : [];
  const canaries = JSON.parse(readFileSync(path.join(dir, 'canaries.json'), 'utf8'));
  if (wire.length === 0) throw new Error('Capture must contain at least one request.');
  if (!Array.isArray(canaries) || canaries.length === 0 || canaries.some((c) =>
    !c || typeof c.value !== 'string' || c.value.trim().length === 0)) {
    throw new Error('Canaries must be a non-empty array of objects with non-empty string values.');
  }
  if (wire.some((r) => !r || typeof r.url !== 'string' || typeof r.body !== 'string' ||
    !r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers))) {
    throw new Error('Every captured request must contain a URL, headers object, and string body.');
  }

  const sentBytes = wire.map((r) => JSON.stringify({ url: r.url, headers: r.headers, body: r.body }));
  const violations = [];
  for (const [canary, c] of canaries.entries()) {
    for (const [request, bytes] of sentBytes.entries()) {
      if (bytes.includes(c.value)) violations.push({ request: request + 1, canary: canary + 1 });
    }
  }
  const result = violations.length === 0
    ? 'NO CANARY MATCHES — only the supplied values and captured requests were checked'
    : `CANARY MATCHES — ${violations.length} request/canary pair(s)`;
  const report = `# Local egress experiment

## Result

${result}

Requests captured: ${wire.length}. Synthetic canaries checked: ${canaries.length}.
${violations.map((v) => `- Request ${v.request}: canary ${v.canary} matched.`).join('\n')}

## Scope and limitations

This is a literal substring check of the captured URL, headers, and body.
It does not inspect uncaptured requests, transformations or encodings, responses,
or any other process. A clean result is not proof that no private data left a
machine, and is not a security certification of productfoo or a coding agent.

The capture may include credentials and local data. This report deliberately
omits request bodies, header values, and canary values or labels. Keep the raw
inputs local and use disposable synthetic values for this experiment.
`;
  const output = path.join(dir, '.foo', 'egress-inventory.md');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, report);
  console.log(`${result}. Report: ${output}`);
  process.exitCode = violations.length === 0 ? 0 : 1;
}

try {
  analyze();
} catch {
  // JSON parse errors can include input snippets; never echo those or raw data.
  console.error('Analysis refused: provide a valid non-empty wire-log.jsonl and canaries.json in a writable capture directory. No current result was produced.');
  process.exitCode = 2;
}
