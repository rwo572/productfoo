import { parseHypotheses, type ParsedHypothesis } from "./specSections.js";

export type HypothesisProof = "untested" | "supported" | "falsified" | "not_assessable";

export interface DecisionSignalProvenance {
  source: string;
  section: "Expected Impact" | "Hypotheses";
  line: number;
}

export type ExpectedImpactSignal =
  | {
      status: "recorded";
      outcome: string;
      target: string | null;
      provenance: DecisionSignalProvenance;
    }
  | { status: "missing"; label: "Impact not stated" };

export interface RecordedHypothesisSignal {
  status: "recorded";
  id: string;
  statement: string;
  authoredState: string | null;
  validationRefs: string[];
  evidence: string | null;
  proof: HypothesisProof;
  proofDetail: string;
  provenance: DecisionSignalProvenance;
}

export type PrimaryHypothesisSignal =
  | RecordedHypothesisSignal
  | {
      status: "missing";
      label: "Hypothesis missing";
      proof: "not_assessable";
      proofDetail: "No hypothesis is recorded in the spec.";
    };

export interface SpecDecisionSignals {
  expectedImpact: ExpectedImpactSignal;
  primaryHypothesis: PrimaryHypothesisSignal;
  hypotheses: RecordedHypothesisSignal[];
}

function cleanField(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownFenceMarker(line: string): "`" | "~" | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  return match ? (match[1][0] as "`" | "~") : null;
}

function expectedImpact(specText: string, source: string): ExpectedImpactSignal {
  const lines = specText.split(/\r?\n/);
  let inSection = false;
  let inComment = false;
  let inFence: "`" | "~" | null = null;
  let outcome: { value: string; line: number } | null = null;
  let target: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFence) {
      if (markdownFenceMarker(line) === inFence) inFence = null;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    const marker = markdownFenceMarker(line);
    if (marker) {
      inFence = marker;
      continue;
    }
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      inSection = /^##\s+Expected Impact\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const field = line.match(/^\s*-\s+(Outcome|Target):\s*(.*?)\s*$/i);
    if (!field) continue;
    const value = cleanField(field[2]);
    if (field[1].toLowerCase() === "outcome" && value && !outcome) outcome = { value, line: i + 1 };
    if (field[1].toLowerCase() === "target" && value && !target) target = value;
  }

  if (!outcome) return { status: "missing", label: "Impact not stated" };
  return {
    status: "recorded",
    outcome: outcome.value,
    target,
    provenance: { source, section: "Expected Impact", line: outcome.line },
  };
}

function hasEvidenceReference(evidence: string | null): evidence is string {
  if (!evidence) return false;
  return !/^(?:none|none recorded|not stated|n\/?a|unknown)$/i.test(evidence.trim());
}

function proofFor(hypothesis: ParsedHypothesis): Pick<RecordedHypothesisSignal, "proof" | "proofDetail"> {
  const state = hypothesis.state?.trim().toLowerCase().replace(/-/g, "_") ?? null;
  if (state === "supported" || state === "falsified") {
    if (hasEvidenceReference(hypothesis.evidence)) {
      return {
        proof: state,
        proofDetail: state === "supported" ? "The spec records supporting evidence." : "The spec records falsifying evidence.",
      };
    }
    return {
      proof: "untested",
      proofDetail: `Authored as ${state}, but no evidence reference is recorded.`,
    };
  }
  if (state === "untested") {
    return { proof: "untested", proofDetail: "The spec records this hypothesis as untested." };
  }
  if (state === "not_assessable") {
    return { proof: "not_assessable", proofDetail: "The spec marks this hypothesis not assessable." };
  }
  if (!state) return { proof: "not_assessable", proofDetail: "No hypothesis state is recorded." };
  return { proof: "not_assessable", proofDetail: `Unrecognized hypothesis state: ${hypothesis.state}.` };
}

function projectHypothesis(hypothesis: ParsedHypothesis, source: string): RecordedHypothesisSignal {
  return {
    status: "recorded",
    id: hypothesis.id,
    statement: hypothesis.statement,
    authoredState: hypothesis.state,
    validationRefs: hypothesis.validationRefs,
    evidence: hypothesis.evidence,
    ...proofFor(hypothesis),
    provenance: { source, section: "Hypotheses", line: hypothesis.line },
  };
}

export function deriveSpecDecisionSignals(specText: string, source = "spec.md"): SpecDecisionSignals {
  const hypotheses = parseHypotheses(specText).map((hypothesis) => projectHypothesis(hypothesis, source));
  return {
    expectedImpact: expectedImpact(specText, source),
    primaryHypothesis: hypotheses[0] ?? {
      status: "missing",
      label: "Hypothesis missing",
      proof: "not_assessable",
      proofDetail: "No hypothesis is recorded in the spec.",
    },
    hypotheses,
  };
}
