export type HumanSurfaceRule = "HS-001" | "HS-002" | "HS-003" | "HS-004";

export type HumanSurfaceFinding = {
  rule: HumanSurfaceRule;
  line: number;
  phrase: string;
  rewrite: string;
};

export type HumanSurfaceEvalResult = {
  ok: boolean;
  findings: HumanSurfaceFinding[];
  error?: "empty-input";
};

type Rule = {
  id: HumanSurfaceRule;
  pattern: RegExp;
  rewrite: string;
};

// This registry is intentionally narrow. It catches productfoo's filing system and
// process chrome, not ordinary product words. In particular, words such as
// "agent", "task", "spec", and "drift" are valid user language on their own.
// Token boundaries apply the same false-positive lesson as the research gate:
// a substring is not evidence that the risky phrase is present.
const RULES: readonly Rule[] = [
  {
    id: "HS-001",
    pattern: /(?<![\w-])(?:OQ-?\d{1,4}|(?:T|R|C|D)-\d{1,4})(?![\w-])/gi,
    rewrite: "Remove the internal identifier and ask or state the thing directly.",
  },
  {
    id: "HS-002",
    pattern:
      /(?<![\w-])(?:spec_id|done_when|next_action|decision_findings|tasks\.yaml|events\.jsonl)(?![\w-])|\bState:\s*needs-decision\b|\b(?:packet handoff|packet grammar|spec packet|loop contract)\b/gi,
    rewrite: "Describe the state or next step in ordinary words instead of exposing the storage format.",
  },
  {
    id: "HS-004",
    pattern:
      /\b(?:judgment ledger|Shape Brief|product bet|source and approval boundaries|MVP scope|validation bar|human judgment|human is the decider|read-only view of the (?:agent|assistant)|(?:Foo|productfoo) has taken over your default behavior)\b|\b(?:Capability|Skill adapter):/gi,
    rewrite: "Replace productfoo's filing or process label with what it means for this person.",
  },
] as const;

const PROCESS_LABELS = new Set([
  "what the assistant sees",
  "what the agent sees",
  "thinks",
  "based on",
  "would do",
  "needs you",
  "updates",
  "this direction",
]);

const PROCESS_LABEL_REWRITE =
  "Remove the process label and state the useful fact, question, or action directly.";

function normalizedProcessLabel(line: string): string | undefined {
  let label = line.trim();
  label = label.replace(/^#{1,6}\s+/, "").replace(/:\s*$/, "").trim();

  // Markdown decoration does not make productfoo's process chrome user language.
  // Peel matching emphasis pairs, including nested pairs, before comparison.
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of ["**", "__", "*", "_"]) {
      if (label.length > marker.length * 2 && label.startsWith(marker) && label.endsWith(marker)) {
        label = label.slice(marker.length, -marker.length).trim();
        changed = true;
        break;
      }
    }
  }

  // productfoo renders the state name as uppercase DRIFT. Lowercase/title-case
  // "drift" remains ordinary product language and must not be blocked.
  return label === "DRIFT" || PROCESS_LABELS.has(label.toLocaleLowerCase("en-US")) ? label : undefined;
}

function blankInlineCode(line: string): string {
  const output = [...line];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }

    let runEnd = index;
    while (line[runEnd] === "`") runEnd += 1;
    const delimiter = line.slice(index, runEnd);
    const close = line.indexOf(delimiter, runEnd);
    if (close === -1) {
      index = runEnd;
      continue;
    }

    output.fill(" ", index, close + delimiter.length);
    index = close + delimiter.length;
  }
  return output.join("");
}

function proseLines(text: string): Array<{ line: number; text: string }> {
  const output: Array<{ line: number; text: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    const fenceRun = trimmed.match(/^(`{3,}|~{3,})/)?.[1];

    if (!fence && fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      continue;
    }

    if (fence) {
      const closesFence =
        fenceRun !== undefined &&
        fenceRun[0] === fence.marker &&
        fenceRun.length >= fence.length &&
        trimmed.slice(fenceRun.length).trim() === "";
      if (closesFence) fence = undefined;
      continue;
    }

    output.push({ line: index + 1, text: blankInlineCode(raw) });
  }

  return output;
}

export function evaluateHumanSurface(text: string): HumanSurfaceEvalResult {
  if (!text.trim()) return { ok: false, findings: [], error: "empty-input" };

  const findings: HumanSurfaceFinding[] = [];
  for (const candidate of proseLines(text)) {
    const processLabel = normalizedProcessLabel(candidate.text);
    if (processLabel) {
      findings.push({
        rule: "HS-003",
        line: candidate.line,
        phrase: processLabel,
        rewrite: PROCESS_LABEL_REWRITE,
      });
    }

    for (const rule of RULES) {
      // RegExp instances with the global flag retain lastIndex. matchAll on a
      // fresh clone keeps every line independent and finds multiple leaks on
      // one line without mutating the shared registry.
      const matches = candidate.text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags));
      for (const match of matches) {
        const phrase = match[0].trim();
        if (!phrase) continue;
        findings.push({ rule: rule.id, line: candidate.line, phrase, rewrite: rule.rewrite });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

export function renderHumanSurfaceEval(result: HumanSurfaceEvalResult): string {
  if (result.error === "empty-input") return "No user-facing copy was provided. Pass the draft on stdin and try again.\n";
  if (result.ok) return "User-facing copy is clear.\n";

  return [
    `User-facing copy needs a rewrite (${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}).`,
    ...result.findings.map((finding) => `- Line ${finding.line}: replace "${finding.phrase}". ${finding.rewrite}`),
    "Rewrite the draft and run this check again before showing it to the user.",
    "",
  ].join("\n");
}

export class HumanSurfaceLeakError extends Error {
  readonly result: HumanSurfaceEvalResult;

  constructor(result: HumanSurfaceEvalResult) {
    // This error can cross the CLI boundary. Keep its message safe for the
    // person at the terminal; detailed findings stay on the typed result for
    // tests and the explicit agent-only stdin evaluator.
    super("productfoo could not prepare clear user-facing copy. Nothing was shown; update productfoo and try again.");
    this.name = "HumanSurfaceLeakError";
    this.result = result;
  }
}

export function guardHumanSurface(text: string): string {
  const result = evaluateHumanSurface(text);
  if (!result.ok) throw new HumanSurfaceLeakError(result);
  return text;
}
