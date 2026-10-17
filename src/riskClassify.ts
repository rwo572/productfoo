// B3 risky-work classifier. productfoo treats spec-first as a boundary only for work
// that is irreversible, agentic/delegated, or outbound-facing; everything else
// is advisory. This makes that judgment concrete, inspectable, and overridable
// with a recorded reason — never a silent verdict.

import { withGlyph } from "./statusGlyphs.js";

export type RiskDimension = "irreversible" | "agentic" | "outbound";

/**
 * How much the verdict is worth. A keyword hit is evidence, not proof — say so.
 * high   : the work names a behaviour only risky work has (a loop, an autonomous actor).
 * medium : risky terms, no governing frame. Treated as risky; the usual case.
 * low    : risky terms, but the work reads as *governing* them rather than doing them.
 */
export type RiskConfidence = "high" | "medium" | "low";

export type RiskClassification = {
  work: string;
  risky: boolean;
  dimensions: Record<RiskDimension, string[]>;
  confidence: RiskConfidence;
  /** True when risky terms matched but the work reads as governing, testing, or documenting them. */
  governed_frame: boolean;
  rationale: string;
  override?: string;
  spec_first_required: boolean;
};

const SIGNAL_TERMS: Record<RiskDimension, string[]> = {
  irreversible: [
    "delete", "drop", "destroy", "wipe", "purge", "truncate", "overwrite",
    "migrate", "migration", "schema", "production", "prod", "deploy", "release",
    "payment", "charge", "refund", "billing", "money", "irreversible", "destructive",
  ],
  agentic: [
    "agent", "agentic", "autonomous", "autonomy", "unattended", "delegate",
    "delegated", "loop", "background", "automatic", "auto-run", "self-serve",
    "on behalf", "without approval", "cron", "scheduled", "nightly", "automatically",
  ],
  outbound: [
    "email", "send", "publish", "post", "notify", "notification", "customer",
    "external", "outbound", "broadcast", "slack", "tweet", "sms", "webhook",
    "public", "message users",
  ],
};

/**
 * Terms whose risk a governing frame cannot talk away.
 *
 * These name a *behaviour being created* — something that will act on its own — and
 * "I'm only adding a monitor for it" does not make that safe. Everything else in the
 * lexicon is a noun that risky work and work *about* risky work mention equally often.
 *
 * This is the line that keeps the dampener below from becoming a hole: "add a
 * background loop that watches deploys and auto-rolls-back" still blocks, because
 * `loop` and `automatically` live here, even though `watches` reads like governance.
 */
const BEHAVIOUR_TERMS: string[] = [
  "autonomous", "autonomy", "unattended", "auto-run", "automatically", "loop",
  "cron", "scheduled", "nightly", "on behalf", "without approval", "delegate", "delegated",
];

/** Verbs a *build* statement opens with. "delete the prod table" opens with none of them. */
const BUILD_VERBS: string[] = [
  "add", "create", "write", "wire", "fix", "update", "refactor", "rename",
  "introduce", "implement", "build", "make", "extend", "tighten", "calibrate", "harden",
];

/** What the work is doing TO the risky thing: constraining it, or watching it. */
const GOVERNANCE_TERMS: string[] = [
  "hook", "gate", "guard", "block", "blocks", "deny", "denies", "refuse", "refuses",
  "prevent", "prevents", "test", "tests", "lint", "check", "checks", "validate",
  "verify", "audit", "document", "warn", "warns", "log", "logs", "monitor", "monitors",
  "detect", "detects", "review", "classify", "surface", "report", "dry-run", "spec",
];

function matchTerms(work: string, terms: string[]): string[] {
  const haystack = work.toLowerCase();
  const matched: string[] = [];
  for (const term of terms) {
    // Tolerate the inflections, because a gate that misses is worse than one that asks.
    // `\bdeploy\b` does not match "deploys"; `\bdelete\b` does not match "deleting". The
    // exact-word matcher waved both through — a false negative in a safety gate, and the
    // more dangerous direction to be wrong in.
    const pattern = /^[a-z]+$/.test(term)
      ? new RegExp(`\\b${term}(s|d|es|ed|ing)?\\b`)
      : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (pattern.test(haystack)) matched.push(term);
  }
  return matched;
}

/**
 * Is the work *governing* the risky thing rather than *doing* it?
 *
 * "Add a hook that denies raw research agents" mentions agents; it does not act
 * agentically — it is the thing that stops agents. "Add a test for the delete path"
 * mentions delete; it deletes nothing. A bag of words cannot tell those from "delete
 * the production table", and this classifier used to call all three risky.
 *
 * The tell is grammatical, and it is cheap to read: the statement OPENS with a build
 * verb (so the risky term is an object, not the action) and names a governing
 * construct (a hook, a gate, a test, an audit). Real risky work does not open with
 * "add a guard that…".
 *
 * This is a heuristic and it will be wrong sometimes. That is why it lowers confidence
 * and prints its reasoning instead of silently flipping the verdict.
 */
export function isGovernedFrame(work: string): boolean {
  const words = work.toLowerCase().split(/[^a-z-]+/).filter(Boolean);
  // The head is either a build verb ("add a hook that blocks deploys") or the governing
  // act itself ("document the refund flow", "audit the payment path"). Risky work opens
  // with neither — "delete the production table" leads with the destruction.
  const head = words.slice(0, 5);
  const opensGoverning = head.some((w) => BUILD_VERBS.includes(w) || GOVERNANCE_TERMS.includes(w));
  return opensGoverning && matchTerms(work, GOVERNANCE_TERMS).length > 0;
}

export interface ClassifyOptions {
  /** Block on any keyword hit — the pre-calibration behaviour. `--strict`. */
  strict?: boolean;
}

export function classifyWork(work: string, override?: string, options: ClassifyOptions = {}): RiskClassification {
  const dimensions: Record<RiskDimension, string[]> = {
    irreversible: matchTerms(work, SIGNAL_TERMS.irreversible),
    agentic: matchTerms(work, SIGNAL_TERMS.agentic),
    outbound: matchTerms(work, SIGNAL_TERMS.outbound),
  };

  const hits = (Object.keys(dimensions) as RiskDimension[]).filter((dim) => dimensions[dim].length > 0);
  const matched = hits.flatMap((dim) => dimensions[dim]);
  const behaviour = matched.filter((term) => BEHAVIOUR_TERMS.includes(term));

  const strict = options.strict === true;
  // A governing frame only earns the downgrade when nothing in the work names a
  // behaviour that acts on its own. "A loop that monitors deploys" is still a loop.
  const governed_frame = hits.length > 0 && behaviour.length === 0 && isGovernedFrame(work);

  const confidence: RiskConfidence =
    hits.length === 0 ? "high" : behaviour.length > 0 ? "high" : governed_frame ? "low" : "medium";

  const risky = hits.length > 0 && (strict || !governed_frame);

  const evidence = hits.map((dim) => `${dim} (${dimensions[dim].join(", ")})`).join("; ");

  let rationale: string;
  if (hits.length === 0) {
    rationale = "No irreversible, agentic, or outbound-facing signals matched; treat spec-first as advisory.";
  } else if (governed_frame && !strict) {
    // Never silently downgrade. Show the evidence, the reasoning, and the dissent —
    // the reader has to be able to disagree with this and re-run it.
    rationale =
      `Matched ${evidence} — but this work reads as governing or testing those things, not doing them ` +
      `(it opens with a build verb and names a guard, gate, test, or check). Keyword matches are evidence, ` +
      `not proof, and a classifier that blocks on the mere mention of "agent" or "delete" is one people learn ` +
      `to override on sight. Spec-first is advisory here. If this work really does act — delegates autonomy, ` +
      `touches production, or reaches a user — it is risky and \`foo spec\` is the reflex. Force the block with --strict.`;
  } else if (behaviour.length > 0) {
    rationale = `Matched ${evidence}. ${behaviour.join(", ")} names a behaviour that acts on its own, so a governing frame cannot excuse it.`;
  } else {
    rationale = `Matched ${evidence}.`;
  }

  // An override is a recorded human decision to waive the boundary, not a silent skip.
  const spec_first_required = risky && !override;

  return { work, risky, dimensions, confidence, governed_frame, rationale, override, spec_first_required };
}

export function renderClassification(classification: RiskClassification, asJson: boolean, glyphsOn = false): string {
  if (asJson) return `${JSON.stringify({ schema_version: "0.1", ...classification }, null, 2)}\n`;

  const lines = [
    `Risk classification for: ${classification.work}`,
    "",
    withGlyph(
      "classification",
      `Verdict: ${classification.risky ? "risky" : "routine"} (confidence: ${classification.confidence})`,
      glyphsOn,
    ),
    `Rationale: ${classification.rationale}`,
  ];
  if (classification.override) {
    lines.push(`Override recorded: ${classification.override}`);
  }
  lines.push(
    "",
    classification.spec_first_required
      ? withGlyph("needs_input", "Boundary (B3): spec-first is required before build. Run `foo spec` or `foo spec start`.", glyphsOn)
      : classification.override
        ? "Boundary (B3) waived by recorded override; proceed with the override on record."
        : "Signal: spec-first is advisory for this work. `foo spec` is still the faster reflex.",
    "",
  );
  return lines.join("\n");
}
