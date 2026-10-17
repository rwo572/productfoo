# Local egress experiment

An experimental MCP-shaped skill server, client, and capture analyzer. This is a
self-contained demonstration of inspecting network payloads, not the productfoo
skill-delivery architecture or proof of current product security. No historical
private packet or PASS report is required or included.

## Run with synthetic data

Use Node 22.12 or newer and a disposable workspace. The server reads the bundled
`skills/check-spec-health/SKILL.md`; no dependency installation is needed.
From this directory, in one terminal:

```sh
SPIKE_TOKEN=synthetic-example-only node server.mjs
```

In a second terminal, from this directory:

```sh
SPIKE_TOKEN=synthetic-example-only node client.mjs
```

Both use localhost port 4030. The example token above is a disposable placeholder,
not a credential for any service. To inspect a different working directory, invoke
`client.mjs` by absolute path from a disposable synthetic project. Keep the server
local; the client supports `SPIKE_SERVER` but remote operation is outside this
example's recommended setup.

Create `canaries.json` beside the scripts using distinctive synthetic values you
want to search for, for example:

```json
[{"value":"synthetic-project-canary-4729"}]
```

Run `node analyze.mjs`. Alternatively, `node analyze.mjs /path/to/capture` reads
`wire-log.jsonl` and `canaries.json` from that directory. The analyzer writes
`.foo/egress-inventory.md` inside the capture directory, never into a spec packet.
Exit 0 means no supplied canary matched, exit 1 means a match, and exit 2 means the
inputs could not establish a result. Missing or empty captures and canary sets
are refused. An old report is not evidence for a failed subsequent invocation.

## Limits and local data

The server records headers and bodies, including the disposable bearer token.
The client log also records its working directory. These raw files, canaries,
and reports are ignored here; do not commit them or use real private data.
An external capture directory needs equivalent local handling.

The analyzer checks literal substrings only. It does not cover encoded values,
uncaptured requests, or other processes. Its report omits raw payloads and canary
values; it makes no general claim that data cannot leave the machine. Stop the
server with Ctrl-C when finished, and remove the generated local files when no
longer needed. Repeat a synthetic positive control with a canary known to occur
in the request, such as `prompts/get`, and expect exit 1 before trusting a run.
