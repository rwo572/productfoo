// Recoverability class for foo findings — Fiona Fung's "bad vs. sad" frame
// (bad-vs-sad-severity-v0). Orthogonal to `severity` (how much a finding
// matters): `class` answers "can this be recovered from?"
//
//   - bad: unrecoverable / boundary-breaking. A false "done", a structurally
//     unprovable requirement — you cannot trust the result until it is fixed.
//   - sad: recoverable. Missing proof, an unfinished-but-referenced requirement
//     — real, but cleaned up by finishing the obvious next step.
//
// This is a shared signal primitive: `verify` adopts it first, and other signal
// surfaces (reconcile, self check) can stamp the same axis later so a triager
// sees one consistent "fix-now vs. clean-up" split everywhere.

export type SeverityClass = "bad" | "sad";

export interface SeverityClassSpec {
  /** The word that carries the meaning. */
  label: SeverityClass;
  /** One-line gloss for a legend or help surface. */
  gloss: string;
  /** Maps to the web design tokens (web/tokens.css), like the glyph vocabulary. */
  tone: "warn" | "neutral";
}

export const SEVERITY_CLASS: Record<SeverityClass, SeverityClassSpec> = {
  bad: { label: "bad", gloss: "unrecoverable — cannot trust the result until fixed", tone: "warn" },
  sad: { label: "sad", gloss: "recoverable — real, but cleaned up by finishing the next step", tone: "neutral" },
};

// Aggregate counts of findings by class, for a report header.
export interface SeverityClassCounts {
  bad: number;
  sad: number;
}

export function countByClass(classes: Iterable<SeverityClass>): SeverityClassCounts {
  const counts: SeverityClassCounts = { bad: 0, sad: 0 };
  for (const c of classes) counts[c] += 1;
  return counts;
}
