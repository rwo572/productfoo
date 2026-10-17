// default-agent-routing-v0 T-006 (R-006): packet-local vocabulary. The final
// `## Glossary` section of a packet's spec.md is the V0 vocabulary source —
// accepted domain terms that packet-reading flows (shaping, patching,
// validating, planning handoffs) may use. Vocabulary is strictly packet-local:
// nothing here feeds global productfoo command semantics, and a term in one packet
// never leaks into another.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface GlossaryTerm {
  term: string;
  definition: string;
}

export function readPacketGlossary(packetDir: string): GlossaryTerm[] {
  const specPath = path.join(packetDir, "spec.md");
  if (!existsSync(specPath)) return [];
  const text = readFileSync(specPath, "utf8");
  // The FINAL ## Glossary section wins (the spec contract places it last).
  const idx = text.lastIndexOf("\n## Glossary");
  if (idx === -1) return [];
  const section = text.slice(idx + 1);
  const body = section.slice(section.indexOf("\n") + 1);
  const end = body.search(/\n## /);
  const content = end === -1 ? body : body.slice(0, end);

  const terms: GlossaryTerm[] = [];
  for (const line of content.split("\n")) {
    // Accepted bullet shapes: `- term: definition`, `- **term** — definition`,
    // `- term — definition`.
    const match = line.match(/^-\s+(?:\*\*(.+?)\*\*|([^:—]+?))\s*(?:[:—]|--)\s+(.+)$/);
    if (match) {
      const term = (match[1] ?? match[2] ?? "").trim();
      const definition = match[3].trim();
      if (term && definition) terms.push({ term, definition });
    }
  }
  return terms;
}

// Which packet-local terms appear in a piece of text (case-insensitive, whole
// word). Used to carry vocabulary context into decisions and patch proposals.
export function matchGlossaryTerms(terms: GlossaryTerm[], text: string): GlossaryTerm[] {
  // Whole-word, case-insensitive, tolerating a simple plural on the last word
  // ("saved filter" matches "Saved filters").
  return terms.filter((t) => new RegExp(`\\b${t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?\\b`, "i").test(text));
}
