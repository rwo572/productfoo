// Deterministic eval checks (foo-eval-system-v0 R-002). Every check that can
// be code is code — no judge spend where a regex suffices. Carried posture from
// the research-format gate: only unambiguous misses hard-fail ("fail");
// ambiguous findings surface as advisory ("warn") with reasons, and strict mode
// promotes them.

export type EvalCheckSeverity = "fail" | "warn";

export type EvalCheckFinding = {
  check: string;
  line: number;
  phrase: string;
  message: string;
  severity: EvalCheckSeverity;
};

export type EvalChecksResult = {
  ok: boolean;
  findings: EvalCheckFinding[];
};

export type EvalCheckRequest = {
  id: string;
  params?: Record<string, unknown>;
};

type CheckFn = (
  lines: ProseLine[],
  params: Record<string, unknown>,
  findings: EvalCheckFinding[],
) => void;

type ProseLine = { line: number; text: string };

// A quantity the one-number rule counts: plain numbers, money, percents,
// multipliers, and unit-suffixed figures. A number inside a word (v2, utf8)
// is not a quantity.
const QUANTITY = /(?<![\w.$])\$?\d[\d,]*(?:\.\d+)?(?:\s?%|x|k|M|B|bn)?(?![\w.])/g;

// Markers that make a quantity accounted-for under the sourcing lint: a
// markdown link in the same sentence, an estimate flag, or the "our rule"
// label the seed roast introduced.
const SOURCE_MARKERS = [
  /\[[^\]]+\]\([^)]+\)/, // markdown link
  /(?<![\w-])(?:estimate[ds]?|est\.)(?![\w-])/i,
  /(?<![\w-])our rule(?![\w-])/i,
] as const;

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
}

function proseLines(text: string): ProseLine[] {
  const output: ProseLine[] = [];
  let inFence = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    output.push({ line: index + 1, text: stripInlineCode(raw) });
  }
  return output;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function quantities(sentence: string): string[] {
  return [...sentence.matchAll(QUANTITY)].map((match) => match[0]);
}

function numberValue(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const oneNumberRule: CheckFn = (lines, params, findings) => {
  const max = numberValue(params, "maxPerSentence", 2);
  for (const { line, text } of lines) {
    for (const sentence of sentences(text)) {
      const found = quantities(sentence);
      if (found.length > max) {
        findings.push({
          check: "one-number-rule",
          line,
          phrase: found.join(", "),
          message: `Sentence carries ${found.length} quantities; the limit is ${max}. Split the sentence or move figures to a table.`,
          severity: "fail",
        });
      }
    }
  }
};

const lengthLimit: CheckFn = (lines, params, findings) => {
  const maxWords = numberValue(params, "maxWords", 1000);
  const words = lines.reduce(
    (count, { text }) => count + text.split(/\s+/).filter((word) => word.length > 0).length,
    0,
  );
  if (words > maxWords) {
    findings.push({
      check: "length-limit",
      line: lines.at(-1)?.line ?? 1,
      phrase: `${words} words`,
      message: `The artifact runs ${words} words against a limit of ${maxWords}. Cut before polishing.`,
      severity: "fail",
    });
  }
};

const numberSourcing: CheckFn = (lines, _params, findings) => {
  for (const { line, text } of lines) {
    for (const sentence of sentences(text)) {
      const found = quantities(sentence);
      if (found.length === 0) continue;
      const sourced = SOURCE_MARKERS.some((marker) => marker.test(sentence));
      if (!sourced) {
        // Advisory, not a hard fail: a bare number can be legitimately
        // self-evident (a date, a version); the reader rules, strict promotes.
        findings.push({
          check: "number-sourcing",
          line,
          phrase: found[0],
          message:
            "A quantity with no source link, estimate flag, or “our rule” label in its sentence. Source it, flag it, or own it.",
          severity: "warn",
        });
      }
    }
  }
};

const flagConservation: CheckFn = (lines, params, findings) => {
  // Guarded substance the improve loop must not trade away (R-005): counts of
  // these markers may grow, never shrink, relative to the recorded baseline.
  const baselines: Array<{ key: string; pattern: RegExp; label: string }> = [
    { key: "minCitations", pattern: /\[[^\]]+\]\([^)]+\)/g, label: "citations" },
    { key: "minEstimateFlags", pattern: /(?<![\w-])(?:estimate[ds]?|est\.)(?![\w-])/gi, label: "estimate flags" },
    { key: "minOurRuleLabels", pattern: /(?<![\w-])our rule(?![\w-])/gi, label: "“our rule” labels" },
  ];
  const text = lines.map(({ text: value }) => value).join("\n");
  for (const { key, pattern, label } of baselines) {
    const floor = numberValue(params ?? {}, key, 0);
    if (floor <= 0) continue;
    const count = [...text.matchAll(pattern)].length;
    if (count < floor) {
      findings.push({
        check: "flag-conservation",
        line: 1,
        phrase: `${count} ${label}`,
        message: `The artifact carries ${count} ${label}; the recorded baseline is ${floor}. A higher score bought by cutting guarded substance is refused.`,
        severity: "fail",
      });
    }
  }
};

// ── Agent-relay update-notice checks (seed 2, foo-eval-system-v0) ───────────
//
// The update-notice relay (src/updateNotice.ts) addresses the coding agent
// that ran foo and rides stderr; under --json it is suppressed entirely. The
// observed failures these checks pin (agent-relay-update-notice-v0 R-004):
// the notice reaching a payload an agent parses, and a structured payload
// carrying relay addressing vocabulary. The signature markers are the
// renderer's own stable strings — the address prefix and the head — chosen
// because updateNotice never renders them inside code spans (only the
// `foo update` span is backticked, which stripInlineCode blanks).

const RELAY_SIGNATURE = [
  "[foo → the human you're working for]",
  "A newer productfoo is available",
] as const;

// Corpus capture format for two-channel runs: the packet's evals/README.md
// documents it. Checks that read a channel refuse to guess on other shapes.
const STDOUT_DELIMITER = "--- stdout ---";
const STDERR_DELIMITER = "--- stderr ---";

type CaptureChannels = { stdout: ProseLine[]; stderr: ProseLine[] };

function channelLines(lines: ProseLine[]): CaptureChannels | null {
  let current: "stdout" | "stderr" | null = null;
  const channels: CaptureChannels = { stdout: [], stderr: [] };
  for (const entry of lines) {
    if (entry.text.trim() === STDOUT_DELIMITER) {
      current = "stdout";
      continue;
    }
    if (entry.text.trim() === STDERR_DELIMITER) {
      current = "stderr";
      continue;
    }
    if (current === "stdout") channels.stdout.push(entry);
    else if (current === "stderr") channels.stderr.push(entry);
  }
  // No delimiters seen at all: not an artifact this check can read.
  return current === null ? null : channels;
}

// One finding per line even when both signature markers hit — the phrase
// carries every marker that matched.
function relaySignatureFindings(
  check: string,
  lines: ProseLine[],
  message: string,
  findings: EvalCheckFinding[],
): void {
  for (const { line, text } of lines) {
    const hits = RELAY_SIGNATURE.filter((marker) => text.includes(marker));
    if (hits.length === 0) continue;
    findings.push({ check, line, phrase: hits.join(", "), message, severity: "fail" });
  }
}

function noCaptureSections(check: string, findings: EvalCheckFinding[]): void {
  findings.push({
    check,
    line: 1,
    phrase: STDOUT_DELIMITER,
    message: `The artifact carries no ${STDOUT_DELIMITER} / ${STDERR_DELIMITER} capture sections; this check reads a two-channel run capture (packet evals/README.md documents the format).`,
    severity: "warn",
  });
}

// Relay addressing vocabulary as JSON keys, matched on PARSED keys so token
// boundaries are exact: a value or key named "protocol" does not carry the
// key "to", and "history" does not carry "to" as a substring.
const RELAY_FORBIDDEN_KEYS = [
  /^to$/i,
  /^(?:relay|chat|webhook)(?:[-_](?:target|url|endpoint|channel|thread|id))?$/i,
  /^spawn(?:[-_]agents?)?$/i,
] as const;

function forbiddenRelayKey(key: string): boolean {
  return RELAY_FORBIDDEN_KEYS.some((pattern) => pattern.test(key));
}

function walkRelayKeys(
  node: unknown,
  path: string,
  lines: ProseLine[],
  findings: EvalCheckFinding[],
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkRelayKeys(item, `${path}[${index}]`, lines, findings));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (forbiddenRelayKey(key)) {
      findings.push({
        check: "relay-json-exclusion",
        line: lines.find(({ text }) => text.includes(`"${key}"`))?.line ?? 1,
        phrase: `"${key}"`,
        message: `Structured payload carries relay addressing key "${key}"${path ? ` at ${path}` : ""}. The --json payload speaks data, never relay addressing.`,
        severity: "fail",
      });
    }
    walkRelayKeys(value, path ? `${path}.${key}` : key, lines, findings);
  }
}

const relayJsonExclusion: CheckFn = (lines, _params, findings) => {
  // 1. The relay line itself, rendered or quoted, anywhere in the payload.
  relaySignatureFindings(
    "relay-json-exclusion",
    lines,
    "The update-notice relay line reaches a payload an agent parses as data. The notice rides stderr only — never stdout, never --json.",
    findings,
  );

  // 2. Addressing vocabulary as JSON keys — parseable payloads only, so the
  //    key match is structural, not a substring guess.
  let payload: unknown;
  try {
    payload = JSON.parse(lines.map(({ text }) => text).join("\n"));
  } catch {
    payload = undefined;
  }
  if (payload !== undefined) {
    walkRelayKeys(payload, "", lines, findings);
    return;
  }

  // Unparseable: a corrupted payload leaves the relay-line scan above as the
  // evidence; an artifact with no JSON at all is the wrong target and the
  // check says so instead of reading as covered.
  const hasStructure = lines.some(({ text }) => text.includes("{"));
  findings.push({
    check: "relay-json-exclusion",
    line: 1,
    phrase: hasStructure ? "unparseable JSON" : "no JSON payload",
    message: hasStructure
      ? "The artifact is not valid JSON, so key-level relay addressing cannot be measured. If this is a corrupted payload, the relay-line scan above carries the evidence."
      : "The artifact carries no JSON payload; this check targets the --json output surface and cannot see anything here.",
    severity: "warn",
  });
};

const relayStdoutClean: CheckFn = (lines, _params, findings) => {
  const channels = channelLines(lines);
  if (!channels) {
    noCaptureSections("relay-stdout-clean", findings);
    return;
  }
  relaySignatureFindings(
    "relay-stdout-clean",
    channels.stdout,
    "The update-notice relay line reached stdout — the machine-readable channel an agent parses. The relay rides stderr only.",
    findings,
  );
};

const relayHeadlessSilent: CheckFn = (lines, _params, findings) => {
  const channels = channelLines(lines);
  if (!channels) {
    noCaptureSections("relay-headless-silent", findings);
    return;
  }
  const message =
    "A headless run carried the update-notice relay line. With no agent present, the relay has no addressee — silence is the contract.";
  relaySignatureFindings("relay-headless-silent", channels.stdout, message, findings);
  relaySignatureFindings("relay-headless-silent", channels.stderr, message, findings);
};

const REGISTRY: Record<string, CheckFn> = {
  "one-number-rule": oneNumberRule,
  "length-limit": lengthLimit,
  "number-sourcing": numberSourcing,
  "flag-conservation": flagConservation,
  "relay-json-exclusion": relayJsonExclusion,
  "relay-stdout-clean": relayStdoutClean,
  "relay-headless-silent": relayHeadlessSilent,
};

export const DETERMINISTIC_CHECK_IDS = Object.freeze(Object.keys(REGISTRY));

/** Run the requested deterministic checks over an artifact's markdown. */
export function runDeterministicChecks(
  artifactText: string,
  checks: EvalCheckRequest[],
  options: { strict?: boolean } = {},
): EvalChecksResult {
  const findings: EvalCheckFinding[] = [];
  const lines = proseLines(artifactText);

  for (const { id, params } of checks) {
    const check = REGISTRY[id];
    if (!check) {
      // Refuse unknown input rather than guess — an eval that silently
      // no-ops reads as "covered" when it is not.
      findings.push({
        check: id,
        line: 1,
        phrase: id,
        message: `Unknown deterministic check. Known checks: ${DETERMINISTIC_CHECK_IDS.join(", ")}.`,
        severity: "fail",
      });
      continue;
    }
    check(lines, params ?? {}, findings);
  }

  if (options.strict) {
    for (const finding of findings) finding.severity = "fail";
  }
  return { ok: findings.every((finding) => finding.severity !== "fail"), findings };
}
