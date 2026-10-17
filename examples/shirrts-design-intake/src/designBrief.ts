// The artifact the shop cuts from. (R-004)
//
// A brief is emitted only from a finished interview. An unfinished one yields the
// list of what is still open — never a half-brief, because a half-brief is what
// the old form produced and it is exactly the thing that became an email thread.

import type { CutCriticalField, QuestionField } from "./questions.js";
import type { Refusal } from "./refusals.js";
import type { Garment, Placement, SizeRun } from "./types.js";

export interface DesignBrief {
  garment: Garment;
  sizeRun: SizeRun[];
  placement: Placement;
  colors: string[];
  quantity: number;
  /** The customer's own words. We do not paraphrase the design. */
  artworkInCustomerWords: string;
  /** Rights problems raised during the interview, for the owner. */
  refusals: Refusal[];
}

export interface CutCriticalAnswers {
  garment?: Garment;
  sizeRun?: SizeRun[];
  placement?: Placement;
  colors?: string[];
  quantity?: number;
  artwork?: string;
}

export type BriefResult =
  | { complete: true; brief: DesignBrief }
  | { complete: false; brief: null; stillOpen: QuestionField[] };

/** Which cut-critical fields are still unanswered. Empty means ready to cut. */
export function openFields(answers: CutCriticalAnswers): CutCriticalField[] {
  const open: CutCriticalField[] = [];
  if (!answers.garment) open.push("garment");
  if (!answers.sizeRun || answers.sizeRun.length === 0) open.push("sizeRun");
  if (!answers.placement) open.push("placement");
  if (!answers.colors || answers.colors.length === 0) open.push("colors");
  if (answers.quantity === undefined || answers.quantity < 1) open.push("quantity");
  return open;
}

/**
 * Build the brief. Refuses to build a partial one: an incomplete interview gets
 * the list of what is still open instead.
 */
export function buildDesignBrief(answers: CutCriticalAnswers, refusals: Refusal[]): BriefResult {
  const stillOpen: QuestionField[] = openFields(answers);
  if (!answers.artwork) {
    return { complete: false, brief: null, stillOpen: [...stillOpen, "artwork"] };
  }
  if (stillOpen.length > 0) {
    return { complete: false, brief: null, stillOpen };
  }

  return {
    complete: true,
    brief: {
      garment: answers.garment!,
      sizeRun: answers.sizeRun!,
      placement: answers.placement!,
      colors: answers.colors!,
      quantity: answers.quantity!,
      artworkInCustomerWords: answers.artwork,
      refusals,
    },
  };
}
