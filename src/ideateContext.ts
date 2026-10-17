import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Read-only, bounded discovery of existing public project artifacts. The agent
// must read and assess candidates; keyword matches are neither evidence nor a
// claim that all relevant work was found. Never walk caches/private raw stores.
const HOMES = ["ideas", "research", "specs", "docs/brainstorms"];
const SKIP = new Set(["quarantine", "incoming", "raw", "transcripts", "node_modules"]);
const STOP = new Set("a an and are as at be better by can do for from help how i improve improving in is it make my of on or our should that the this to we what with would".split(" "));
const words = (value: string) => [...new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)))];

export function findIdeateContext(root: string, idea: string) {
  const terms = words(idea);
  const candidates: { path: string; title: string; matched_terms: string[]; weights: number[]; score: number }[] = [];
  const frequency = new Map<string, number>();
  let scanned = 0;
  let visited = 0;
  let truncated = false;
  function walk(relative: string, depth: number): void {
    if (depth > 3 || visited >= 1500) { truncated = true; return; }
    const full = path.join(root, relative);
    try {
      let component = root;
      for (const part of relative.split("/")) {
        component = path.join(component, part);
        if (lstatSync(component).isSymbolicLink()) return;
      }
      if (!lstatSync(full).isDirectory() || lstatSync(full).isSymbolicLink()) return;
      for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (visited++ >= 1500) { truncated = true; break; }
        if (entry.name.startsWith(".") || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const rel = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) { walk(rel, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "AGENTS.md") continue;
        scanned++;
        const file = path.join(root, rel);
        if (lstatSync(file).size > 128 * 1024) { truncated = true; continue; }
        const body = readFileSync(file, "utf8");
        if (relative === "ideas" && /^recommendation:\s*null\s*$/m.test(body)) continue;
        const title = body.match(/^#\s+(.+)$/m)?.[1] ?? entry.name;
        const filename = new Set(words(rel));
        const heading = new Set(words(title));
        const content = new Set(words(body));
        const matched = terms.filter((term) => filename.has(term) || content.has(term));
        if (!matched.length) continue;
        for (const term of matched) frequency.set(term, (frequency.get(term) ?? 0) + 1);
        const weights = matched.map((term) => (filename.has(term) ? 6 : 0) + (heading.has(term) ? 4 : 0) + (content.has(term) ? 1 : 0));
        candidates.push({ path: rel, title: title.slice(0, 180), matched_terms: matched, weights, score: 0 });
      }
    } catch { /* Missing/unreadable homes are reported through discovery limits. */ }
  }
  for (const home of HOMES) walk(home, 0);
  for (const candidate of candidates) {
    candidate.score = candidate.matched_terms.reduce((score, term, i) => score + candidate.weights[i] * Math.log(1 + scanned / (1 + (frequency.get(term) ?? 0))), 0);
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    searched: HOMES,
    candidates: candidates.slice(0, 10).map(({ score: _score, weights: _weights, ...candidate }) => candidate),
    scanned,
    truncated: truncated || candidates.length > 10,
    limitations: "Local keyword discovery only; no match does not prove no prior work. Read candidates, follow their references, distinguish findings from hypotheses, and record gaps. No web or connected sources were queried.",
  };
}
