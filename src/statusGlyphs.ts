// Friendly status-glyph vocabulary (specs/foo-status-glyphs-v0).
//
// One glyph per foo state — a scannable skin over the state model foo already
// has (proven/done/doing/blocked/open, plus needs-human, drift, classification).
// The friendliness comes from consistency, not decoration: the same glyph means
// the same thing on every surface, so it stays "checksum-like," never a badge pile.
//
// Two hard rules this module enforces by construction:
//   1. The glyph is always paired with its text word — the word carries the
//      meaning, the emoji is decoration. So a screen reader, a grep, or a future
//      reader without the legend still understands the state.
//   2. Human surfaces only. `glyphsEnabled` gates them (R-008): off for --json,
//      NO_COLOR, and non-TTY/piped output, on for an interactive terminal.
//      Machine-readable output (events.jsonl, tasks.yaml values, --json) never
//      carries a glyph.

export type FooState =
  | "proven"
  | "claimed"
  | "doing"
  | "blocked"
  | "needs_input"
  | "todo"
  | "drift"
  | "classification"
  | "parked"
  | "killed";

export interface GlyphSpec {
  glyph: string;
  /** The word that carries the meaning when glyphs are off. */
  label: string;
  /** Maps to the web design tokens (web/tokens.css) for the eventual HTML skin. */
  tone: "proof" | "attention" | "warn" | "neutral";
}

// The locked vocabulary. The internal `claimed` state renders as the actionable
// human label 🟡 done — proof pending, keeping productfoo's signature distinction
// legible — "done is a claim, proof is a receipt" — without two look-alike
// checkmarks. 🚧 (stuck on a thing) and ✋ (stuck on you) are a clean pair that
// can never be confused.
export const STATUS_GLYPHS: Record<FooState, GlyphSpec> = {
  proven: { glyph: "✅", label: "proven", tone: "proof" },
  claimed: { glyph: "🟡", label: "done — proof pending", tone: "neutral" },
  doing: { glyph: "🔄", label: "doing", tone: "neutral" },
  blocked: { glyph: "🚧", label: "blocked", tone: "warn" },
  needs_input: { glyph: "✋", label: "needs your input", tone: "warn" },
  todo: { glyph: "📋", label: "todo", tone: "neutral" },
  drift: { glyph: "⚠️", label: "drift", tone: "attention" },
  classification: { glyph: "🏷️", label: "classification", tone: "neutral" },
  // Lifecycle verdicts (packet-lifecycle-v0): retired intent gets a visible,
  // reasoned state instead of masquerading as backlog. ⏸️ may resume; 🪦 won't.
  parked: { glyph: "⏸️", label: "parked", tone: "neutral" },
  killed: { glyph: "🪦", label: "killed", tone: "neutral" },
};

// The order a legend or help screen should list them: proof first, then the
// in-flight states, then the human/attention markers.
export const STATUS_ORDER: FooState[] = [
  "proven",
  "claimed",
  "doing",
  "blocked",
  "todo",
  "needs_input",
  "drift",
  "classification",
  "parked",
  "killed",
];

// Prefix text with a state glyph when glyphs are on; return it untouched when
// off. The label stays in `text`, so the word always carries the meaning.
export function withGlyph(state: FooState, text: string, glyphsOn: boolean): string {
  return glyphsOn ? `${STATUS_GLYPHS[state].glyph} ${text}` : text;
}

// Just the glyph (or "" when off), for tight inline spots where the caller
// already prints the word.
export function glyphFor(state: FooState, glyphsOn: boolean): string {
  return glyphsOn ? STATUS_GLYPHS[state].glyph : "";
}

// A one-line legend, e.g. for `foo` help or a packet footer. Honors the gate:
// returns "" when glyphs are off so it never leaks into machine output.
export function legendLine(glyphsOn: boolean): string {
  if (!glyphsOn) return "";
  return STATUS_ORDER.map((s) => `${STATUS_GLYPHS[s].glyph} ${STATUS_GLYPHS[s].label}`).join("   ");
}

// The human-surface gate (R-008): glyphs decorate an interactive terminal view
// only, so they never corrupt machine-readable output. Off for --json, NO_COLOR,
// and any non-TTY/piped stdout; on for a plain interactive terminal.
export function glyphsEnabled(opts: {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  args: string[];
}): boolean {
  if (opts.args.includes("--json")) return false;
  if (opts.env.NO_COLOR) return false;
  return Boolean(opts.isTTY);
}
