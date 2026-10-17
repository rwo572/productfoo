// Live mode for the packet index (packet_index_v0). Serves the same
// self-contained HTML that `--html` writes, but re-rendered from each packet's
// tasks.yaml on every request, and tells the browser to reload only when the
// derived spec state actually changes — so an open rollover does not collapse on
// a timer. Read-only: it renders from disk and writes nothing.

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { derivePacketIndex, renderIndexHtml, type PacketIndexEntry } from "./packetIndex.js";

export const DEFAULT_SERVE_PORT = 8000;
// Bind to loopback by default: the dashboard is unauthenticated, so it must not
// be reachable from the local network (security-review-remediation-v0 R-003).
export const DEFAULT_SERVE_HOST = "127.0.0.1";
const DEFAULT_POLL_MS = 2000;

// A content fingerprint of the derived index. The browser reloads only when this
// changes, so formatting-stable polls never thrash the page.
export function indexStateHash(index: PacketIndexEntry[]): string {
  return createHash("sha1").update(JSON.stringify(index)).digest("hex");
}

// Inject a poll-and-reload client before </body>. It reloads only when the state
// hash changes, preserving scroll and open rollovers until something moves.
export function injectLiveReload(html: string, pollMs: number = DEFAULT_POLL_MS): string {
  const script = [
    "<script>",
    "(function(){var last=null;",
    "function tick(){",
    "fetch('/__state',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){",
    "if(last!==null&&s.hash!==last){location.reload();return;}",
    "last=s.hash;setTimeout(tick," + pollMs + ");",
    "}).catch(function(){setTimeout(tick," + pollMs + ");});",
    "}tick();})();",
    "</script>",
  ].join("");
  return html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : html + script;
}

// A cheap fingerprint of everything derivePacketIndex reads: the recursive
// shape of <root>/specs, hashed from each file's relative path, mtime, and
// size. Statting ~3 files per packet is far cheaper than re-reading and
// re-parsing them, so an unchanged specs tree (the common case for an open
// dashboard) can skip re-derivation entirely (cli-performance-v0 R-004).
// Deterministic within the walk: entries are sorted so directory order never
// leaks into the hash. Throws (ENOENT) when specs/ is missing — the request
// handler's generic 500 path, same as a failing derivation.
function specsTreeFingerprint(root: string): string {
  const specsDir = path.join(root, "specs");
  const hash = createHash("sha1");
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSync(abs);
      hash.update(`${relPath}\0${stats.mtimeMs}\0${stats.size}\0`);
    }
  };
  walk(specsDir, "");
  return hash.digest("hex");
}

export interface ServeOptions {
  port?: number;
  pollMs?: number;
  // Bind address. Defaults to loopback (127.0.0.1); override only for intentional
  // exposure (e.g. a container's 0.0.0.0) — the server has no authentication.
  host?: string;
  // Injection seam for the derivation itself (cli-performance-v0 C-008): tests
  // pass a counting spy to prove the server calls it exactly once per state
  // check and zero times on mtime-unchanged polls. Defaults to the real reader.
  deriveIndex?: (root: string) => PacketIndexEntry[];
}

// Start the live dashboard server and return the listening server so callers
// (and tests) can read its address and close it. The index is derived from disk
// at most once per change to the specs tree: a state check re-derives only when
// the fingerprint moves, and the page render reuses the same derivation — so
// uncommitted tasks.yaml edits still show up immediately, but an unchanged poll
// costs a directory stat walk, not a full re-derivation (cli-performance-v0 R-004).
export function serveIndex(root: string, options: ServeOptions = {}): Server {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const derive = options.deriveIndex ?? derivePacketIndex;
  // Per-server cache, not module state: parallel servers (tests, two roots)
  // must never see each other's derivations.
  let cache: { fingerprint: string; index: PacketIndexEntry[]; hash: string } | null = null;
  const derivedState = (): { index: PacketIndexEntry[]; hash: string } => {
    const fingerprint = specsTreeFingerprint(root);
    if (cache && cache.fingerprint === fingerprint) return cache;
    const index = derive(root);
    cache = { fingerprint, index, hash: indexStateHash(index) };
    return cache;
  };
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (url === "/__state") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ hash: derivedState().hash }));
        return;
      }
      if (url === "/" || url === "/packet-index.html" || url === "/index.html") {
        const html = injectLiveReload(renderIndexHtml(derivedState().index), pollMs);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (error) {
      // Never disclose internals (stack traces, filesystem paths) to the client.
      // Log the detail server-side for the operator; return a generic message.
      console.error("packet-index dashboard render error:", error instanceof Error ? (error.stack ?? error.message) : String(error));
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dashboard render error");
    }
  });
  server.listen(options.port ?? DEFAULT_SERVE_PORT, options.host ?? DEFAULT_SERVE_HOST);
  return server;
}
