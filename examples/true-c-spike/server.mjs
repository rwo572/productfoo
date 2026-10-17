// Experimental local MCP-shaped skill server; see README.md.
// Serves skill text per-run against a bearer token and records EVERY inbound
// request verbatim to wire-log.jsonl: that file is the authoritative record of
// what a tester's machine actually sent to the server.
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.SPIKE_PORT || 4030);
const TOKEN = process.env.SPIKE_TOKEN; // supplied at run time; never committed
if (!TOKEN) { console.error('set SPIKE_TOKEN'); process.exit(1); }
const LOG = path.join(import.meta.dirname, 'wire-log.jsonl');

// One bundled skill, loaded server-side for this experiment.
const SKILL_NAME = process.env.SPIKE_SKILL || 'check-spec-health';
const SKILL_PATH = path.join(import.meta.dirname, '..', '..', 'skills', SKILL_NAME, 'SKILL.md');
const SKILL_TEXT = readFileSync(SKILL_PATH, 'utf8');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Authoritative wire record: everything the server observed, verbatim.
    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(),
      remote: req.socket.remoteAddress,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    }) + '\n');

    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid or revoked token' }));
      return;
    }

    let rpc;
    try { rpc = JSON.parse(body || '{}'); } catch {
      res.writeHead(400).end('{"error":"bad json"}');
      return;
    }

    // MCP-shaped surface: prompts/list and prompts/get.
    if (req.method === 'POST' && req.url === '/mcp' && rpc.method === 'prompts/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prompts: [{ name: SKILL_NAME }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/mcp' && rpc.method === 'prompts/get') {
      if (rpc.params?.name !== SKILL_NAME) {
        res.writeHead(404).end('{"error":"unknown skill"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ description: `foo skill ${SKILL_NAME} (served, never on disk)`, text: SKILL_TEXT }));
      return;
    }
    res.writeHead(404).end('{"error":"not found"}');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[spike-server] skill "${SKILL_NAME}" (${SKILL_TEXT.length} bytes) on 127.0.0.1:${PORT}; wire log: ${LOG}`);
});
