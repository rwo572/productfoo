// The five things fabric-cutting depends on. (R-002, D-004)
//
// One ordered question set. Each question owns its own parser, so a bad answer
// fails on that question and the interview loops there — it does not fail the
// whole interview and it does not skip ahead.

import {
  GARMENTS,
  PLACEMENTS,
  SIZES,
  type Garment,
  type Placement,
  type Size,
  type SizeRun,
} from "./types.js";

/** The cut-critical fields. Named here once; everything else reads this. */
export type CutCriticalField = "garment" | "sizeRun" | "placement" | "colors" | "quantity";

export const CUT_CRITICAL_FIELDS: readonly CutCriticalField[] = [
  "garment",
  "sizeRun",
  "placement",
  "colors",
  "quantity",
];

/** The artwork question is not cut-critical on its own — it is the design itself. */
export type QuestionField = CutCriticalField | "artwork";

export type ParsedAnswer =
  | { ok: true; value: Garment }
  | { ok: true; value: SizeRun[] }
  | { ok: true; value: Placement }
  | { ok: true; value: string[] }
  | { ok: true; value: number }
  | { ok: true; value: string }
  | { ok: false; followUp: string };

export interface Question {
  field: QuestionField;
  /** What the agent says. */
  ask: string;
  /** What the agent says when the answer did not land. Never a scold. */
  followUp: string;
  parse: (answer: string) => ParsedAnswer;
}

function fail(followUp: string): ParsedAnswer {
  return { ok: false, followUp };
}

export function parseGarment(answer: string): ParsedAnswer {
  const text = answer.trim().toLowerCase().replace(/\s+/g, "-").replace(/s$/, "");
  const aliases: Record<string, Garment> = {
    tee: "tee",
    "t-shirt": "tee",
    tshirt: "tee",
    shirt: "tee",
    "long-sleeve": "long-sleeve",
    longsleeve: "long-sleeve",
    hoodie: "hoodie",
    hoody: "hoodie",
    sweatshirt: "crewneck",
    crewneck: "crewneck",
    crew: "crewneck",
  };
  const garment = aliases[text] ?? (GARMENTS.includes(text as Garment) ? (text as Garment) : null);
  if (!garment) {
    return fail(`We print on ${GARMENTS.join(", ")}. Which one of those did you want?`);
  }
  return { ok: true, value: garment };
}

/**
 * A size run, not a size. "12 mediums, 6 larges" is what a real order looks like,
 * and it is what the cutting table needs. The old form asked for one size and one
 * quantity, which is why every group order became an email thread.
 */
export function parseSizeRun(answer: string): ParsedAnswer {
  const text = answer.trim();
  if (text.length === 0) return fail("How many of each size? For example: 12 medium, 6 large, 2 XL.");

  const run: SizeRun[] = [];
  // Longest size alternative first, and the "12 x M" multiplier must be followed
  // by whitespace — otherwise the optional `x` eats the X of "2 XL" and the run
  // silently books two larges.
  const pattern = /(\d+)\s*(?:x\s+)?(3XL|2XL|XL|XS|S|M|L|small|medium|large|extra[- ]large)\b/gi;
  const alias: Record<string, Size> = {
    small: "S",
    medium: "M",
    large: "L",
    "extra-large": "XL",
    "extra large": "XL",
  };

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const quantity = Number.parseInt(match[1], 10);
    const raw = match[2].toLowerCase();
    const size = (alias[raw] ?? (match[2].toUpperCase() as Size));
    if (!SIZES.includes(size) || quantity < 1) continue;
    const existing = run.find((entry) => entry.size === size);
    if (existing) existing.quantity += quantity;
    else run.push({ size, quantity });
  }

  if (run.length === 0) {
    return fail("How many of each size? For example: 12 medium, 6 large, 2 XL.");
  }
  return { ok: true, value: run };
}

export function parsePlacement(answer: string): ParsedAnswer {
  const text = answer.trim().toLowerCase();
  const table: Array<[RegExp, Placement]> = [
    [/left[- ]chest|small.*chest|pocket/, "front-left-chest"],
    [/front|chest/, "front-center"],
    [/back/, "back-full"],
    [/left sleeve/, "sleeve-left"],
    [/right sleeve|sleeve/, "sleeve-right"],
  ];
  for (const [re, placement] of table) {
    if (re.test(text)) return { ok: true, value: placement };
  }
  return fail(
    `Where on the shirt does the artwork go? We can do ${PLACEMENTS.join(", ")}.`,
  );
}

/**
 * Colors, counted. "Three colors" is not an answer — the screen printer needs to
 * know WHICH three, because each one is a separate screen.
 */
export function parseColors(answer: string): ParsedAnswer {
  const text = answer.trim().toLowerCase();
  if (text.length === 0) return fail("Which exact colors are in the artwork? Name each one — every color is its own screen.");

  // "three colors", "3 colours", "a few colors" — a count is not a color.
  if (/^\s*(a few|several|some|\d+|one|two|three|four|five)\b[^,]*\bcolou?rs?\b\s*$/.test(text)) {
    return fail("Which exact colors? Name each one — every color is its own screen, so we need the list, not the count.");
  }

  const colors = text
    .split(/,| and |\/|\+/)
    .map((part) => part.replace(/\bcolou?rs?\b/g, "").trim())
    .filter((part) => part.length > 0 && part.length < 40);

  if (colors.length === 0) {
    return fail("Which exact colors are in the artwork? Name each one.");
  }
  return { ok: true, value: colors };
}

export function parseQuantity(answer: string): ParsedAnswer {
  const match = answer.trim().match(/\d+/);
  const quantity = match ? Number.parseInt(match[0], 10) : Number.NaN;
  if (!Number.isInteger(quantity) || quantity < 1) {
    return fail("How many shirts in total? A whole number of 1 or more.");
  }
  return { ok: true, value: quantity };
}

/** The design itself. Vagueness is judged separately, in vagueness.ts. */
export function parseArtwork(answer: string): ParsedAnswer {
  const text = answer.trim();
  if (text.length === 0) return fail("What should we print? Describe the picture — what is in it, and what it looks like.");
  return { ok: true, value: text };
}

/** The question set, in ask order. Artwork first: everything else serves it. */
export const QUESTIONS: readonly Question[] = [
  {
    field: "artwork",
    ask: "What would you like us to print? Describe the picture — what's in it and what it looks like.",
    followUp: "Tell us what's actually in the picture — the subject, and what it's doing. \"A coiled red dragon, side view, mouth open\" is enough to draw from.",
    parse: parseArtwork,
  },
  {
    field: "garment",
    ask: `What are we printing on? We do ${GARMENTS.join(", ")}.`,
    followUp: `We print on ${GARMENTS.join(", ")}. Which one?`,
    parse: parseGarment,
  },
  {
    field: "sizeRun",
    ask: "How many of each size? For example: 12 medium, 6 large, 2 XL.",
    followUp: "Give us a count per size — 12 medium, 6 large, 2 XL.",
    parse: parseSizeRun,
  },
  {
    field: "placement",
    ask: `Where on the shirt does the artwork go? We can do ${PLACEMENTS.join(", ")}.`,
    followUp: `Pick a spot: ${PLACEMENTS.join(", ")}.`,
    parse: parsePlacement,
  },
  {
    field: "colors",
    ask: "Which colors are in the artwork? Name each one — every color is its own screen.",
    followUp: "Name the exact colors, not the count — each color is a separate screen.",
    parse: parseColors,
  },
  {
    field: "quantity",
    ask: "How many shirts in total?",
    followUp: "A total count, as a whole number.",
    parse: parseQuantity,
  },
];

export function questionFor(field: QuestionField): Question {
  const question = QUESTIONS.find((entry) => entry.field === field);
  if (!question) throw new Error(`no question for field ${field}`);
  return question;
}
