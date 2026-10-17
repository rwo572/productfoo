// Experimental local egress client; see README.md.
// Simulates fetching a skill from a disposable synthetic project:
// fetches the skill per-run against a live token, holds it in memory only,
// and never writes it to disk. Every outbound byte goes through send(),
// which records the exact payload to client-egress.jsonl before sending.
import { appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SERVER = process.env.SPIKE_SERVER || 'http://127.0.0.1:4030';
const TOKEN = process.env.SPIKE_TOKEN; // supplied at run time; never committed
if (!TOKEN) { console.error('set SPIKE_TOKEN'); process.exit(1); }
const SKILL = process.env.SPIKE_SKILL || 'check-spec-health';
const EGRESS_LOG = path.join(import.meta.dirname, 'client-egress.jsonl');

// The ONLY egress path in this client. Records exact bytes, then sends.
async function send(url, init) {
  appendFileSync(EGRESS_LOG, JSON.stringify({
    at: new Date().toISOString(),
    cwd_at_send_time_NOT_SENT: process.cwd(), // recorded locally for analysis; never part of the request
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
  }) + '\n');
  return fetch(url, init);
}

// What the client COULD see in the disposable project...
const visibleFiles = readdirSync(process.cwd()).length;
console.log(`[spike-client] running from ${process.cwd()} — ${visibleFiles} entries visible locally`);

// ...and what it actually sends: token + skill name. Nothing else.
const res = await send(`${SERVER}/mcp`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'prompts/get', params: { name: SKILL } }),
});
if (!res.ok) {
  console.error(`[spike-client] server refused: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { text } = await res.json();
console.log(`[spike-client] skill received in memory: ${text.length} bytes; first line: ${text.split('\n')[0]}`);
console.log('[spike-client] skill is NOT written to disk; handoff would print here.');
