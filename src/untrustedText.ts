// Pure, local text neutralization shared by local capture paths. This module
// does not fetch, approve, render, validate, or issue a trust result: it only
// replaces directive-shaped substrings in caller-provided text.
const DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^\n]{0,60}?\b(previous|prior|above|all|earlier)\b[^\n]{0,40}?\b(instruction|prompt|rule|direction)s?\b/gi,
  /\b(system|developer)\s*:|\byou (must|should|are|will) now\b|\bnew instructions?\b\s*:/gi,
  /\b(send|post|upload|transmit|email|exfiltrate|leak|curl|wget|fetch|forward)\b[^\n]{0,100}?\b(to|https?:\/\/|api|webhook|endpoint|\.env|secret|token|key|credential)\b[^\n]{0,80}/gi,
  /\b(read|open|cat|print|reveal|show|dump|access)\b[^\n]{0,100}?\b(\.env|secret|api[_ -]?key|token|credential|password|private[_ -]?key)s?\b/gi,
];

export interface NeutralizedText {
  inert_text: string;
  stripped_directives: string[];
  triggered: boolean;
}

export function neutralizeUntrustedText(content: string): NeutralizedText {
  const stripped: string[] = [];
  let inert = content;
  for (const pattern of DIRECTIVE_PATTERNS) {
    inert = inert.replace(pattern, (match) => {
      stripped.push(match.trim());
      return "[stripped: untrusted directive — treated as inert data, never executed]";
    });
  }
  return { inert_text: inert, stripped_directives: stripped, triggered: stripped.length > 0 };
}
