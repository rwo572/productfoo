// Scores a research report against the research/README.md gold-standard rubric.
//
// The bar is binary and high: a report PASSES only when EVERY applicable check is
// clean. There is no partial pass — a warning is a miss. Rows that genuinely do not
// apply (decision-grade rows on a non-decision lookup; a run receipt on a
// hand-authored report) are marked `n/a` and excused from the count, never counted
// as passes. The heuristics stay lenient per-row so a genuinely-good report that is
// styled differently still clears the bar — a gate that false-positives on taste is
// one people learn to override on sight (AGENTS.md B3/B5).

export type RowStatus = "pass" | "fail" | "na";
export type RowKind = "req" | "decision";

export interface FormatRow {
  n: number;
  label: string;
  kind: RowKind;
  status: RowStatus;
  note: string;
}

export interface FormatScore {
  rows: FormatRow[];
  isDecisionReport: boolean;
  blocked: FormatRow[]; // failing (applicable) rows
  applicable: number;
  clean: number;
  passed: boolean;
}

function stripFrontmatter(md: string): { body: string; frontmatter: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (m) return { frontmatter: m[1], body: md.slice(m[0].length) };
  return { frontmatter: "", body: md };
}

export function scoreReportFormat(md: string, _opts: { strict?: boolean } = {}): FormatScore {
  const { body, frontmatter } = stripFrontmatter(md);
  const lines = body.split("\n");
  const headings = lines.filter((l) => /^#{2,3}\s+/.test(l)).map((l) => l.replace(/^#{2,3}\s+/, "").trim());
  const h2 = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  const head = body.slice(0, 2500);
  const lower = body.toLowerCase();
  const links = (body.match(/https?:\/\/\S+/g) || []).length;
  const has = (re: RegExp) => re.test(body);
  const headHas = (re: RegExp) => re.test(head);

  const rows: FormatRow[] = [];
  const req = (n: number, label: string, ok: boolean, okNote: string, badNote: string) =>
    rows.push({ n, label, kind: "req", status: ok ? "pass" : "fail", note: ok ? okNote : badNote });

  const isDecisionReport =
    /recommend|verdict|decision|which model|build vs|invest|strateg|should (we|foo)/i.test(headings.join(" ") + " " + head) ||
    /## recommend|## verdict|## the decision/i.test(body);

  req(1, "Provenance (how made, sources reached/not)",
    headHas(/prepared via|provenance|source status|deep-research|research run/i) || /^##\s+(source status|provenance)/im.test(body),
    "present", "no provenance block (how it was made, which sources reached/not)");

  req(2, "Claim-label legend (truth vs as-stated)",
    /as-stated/i.test(lower) || (/\bprimary\b/.test(lower) && /\bvendor\b/.test(lower) && /confidence/.test(lower)) || /source[- ]type label/i.test(lower),
    "present", "no claim-label legend (define tiers; confidence = truth vs as-stated)");

  const inlineLabels = (body.match(/\[[a-z][\w /–—-]*,\s*(high|med|medium|low|as-stated)/gi) || []).length;
  const tierBullets = (body.match(/\b(high|medium|low)[- ]confidence\b/gi) || []).length;
  req(3, "Claims carry evidence labels", inlineLabels >= 3 || tierBullets >= 2,
    `${inlineLabels} inline + ${tierBullets} tiered`, "claims are not consistently labeled by evidence tier");

  req(4, "Measured vs forecast kept distinct",
    /forecast|derived|estimate|as-magnitude|projected|hypothesis|approximate|±|treat .{1,30}as|reported unless/i.test(lower),
    "distinguishes measured from forecast", "no signal that forecast/derived numbers are flagged as such");

  req(5, "Plain-English lead",
    headHas(/in plain english|in one line|\bin short\b|tl;?dr|the short version/i),
    "present", "no plain-English lead near the top (add 'In plain English:' / 'In one line:')");

  const answerIdx = h2.findIndex((t) => /bottom line|executive|verdict|the answer|key finding/i.test(t));
  req(6, "Answer-first (Bottom line / Verdict up top)",
    answerIdx >= 0 && answerIdx < Math.max(2, Math.ceil(h2.length * 0.4)),
    "near the top", answerIdx < 0 ? "no Bottom line / Verdict / Executive section" : "answer section is too far down — move it up");

  req(7, "Skimmable (headings + a table)", headings.length >= 3, `${headings.length} sections`, "too few sections to skim");

  const hasSources = /^##\s+(sources|references)\b/im.test(body);
  req(11, "Sources with working links", (hasSources && links >= 2) || links >= 5,
    `${links} link(s)${hasSources ? " + Sources section" : ""}`,
    hasSources ? "Sources section has too few real links" : "no Sources section and few links");

  const decision = (n: number, label: string, ok: boolean, okNote: string, badNote: string) => {
    if (!isDecisionReport) { rows.push({ n, label, kind: "decision", status: "na", note: "n/a — not a decision report" }); return; }
    rows.push({ n, label, kind: "decision", status: ok ? "pass" : "fail", note: ok ? okNote : badNote });
  };
  decision(8, "What would have to be true", has(/what (would|has to) (have to )?be true|would have to be true|assumptions? that must hold/i), "present", "add 'what would have to be true' for a bet");
  decision(9, "Questions for the room / open questions", has(/questions for the room|open questions|diligence (list|questions)|questions? (for|to) (the )?(room|founders?|owner)/i), "present", "add the questions only a human can answer");
  decision(10, "Dissent kept", has(/dissent|counter-thesis|read this part|position a[\s\S]{0,40}position b|the opposite|judgment ledger/i), "present", "surface and rule on dissent");

  // research_run: required if the report claims a governed foo run; n/a for hand-authored
  if (/research_run\s*:/i.test(frontmatter)) req(12, "research_run id in frontmatter", true, "run receipt present", "");
  else rows.push({ n: 12, label: "research_run id in frontmatter", kind: "req", status: "na", note: "n/a — hand-authored (no run receipt to fake)" });

  rows.sort((a, b) => a.n - b.n);
  const applicable = rows.filter((r) => r.status !== "na");
  const blocked = rows.filter((r) => r.status === "fail");
  return {
    rows,
    isDecisionReport,
    blocked,
    applicable: applicable.length,
    clean: applicable.filter((r) => r.status === "pass").length,
    passed: blocked.length === 0,
  };
}

export function renderFormatScore(score: FormatScore): string {
  const icon = (s: RowStatus) => ({ pass: "✔", fail: "✗", na: "–" }[s]);
  const body = score.rows.map((r) => `  ${icon(r.status)} ${String(r.n).padStart(2)}. ${r.label}${r.status === "pass" || r.status === "na" ? "" : ` — ${r.note}`}`);
  const naN = score.rows.filter((r) => r.status === "na").length;
  const verdict = score.passed
    ? `format: PASS — ${score.clean}/${score.applicable} checks clean${naN ? ` (${naN} n/a)` : ""}`
    : `format: NEEDS WORK — ${score.blocked.length} to fix: ${score.blocked.map((r) => r.label).join("; ")}`;
  return [verdict, ...body].join("\n");
}
