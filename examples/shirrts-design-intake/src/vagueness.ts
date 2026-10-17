// A non-answer is not an answer. (R-001, D-002)
//
// The old form accepted any non-empty string in "describe your design", which is
// how "something cool" became a passing submission. The agent's job is to refuse
// to advance on one — not to soften it with a hint and take it anyway.

/** Answers that carry no design information at all. */
const NON_ANSWERS: readonly string[] = [
  "something cool",
  "something nice",
  "something fun",
  "you decide",
  "you pick",
  "surprise me",
  "whatever looks good",
  "whatever you think",
  "anything",
  "up to you",
  "dealer's choice",
  "idk",
  "i don't know",
  "dunno",
  "cool design",
  "make it pop",
];

/** Words that describe a feeling about the art instead of the art. */
const EMPTY_ADJECTIVES: readonly string[] = [
  "cool",
  "nice",
  "awesome",
  "great",
  "pretty",
  "fun",
  "sick",
  "dope",
  "good",
];

export interface VaguenessVerdict {
  vague: boolean;
  /** The concrete follow-up to re-ask. Empty when the answer was usable. */
  followUp: string;
  reason: string;
}

const USABLE: VaguenessVerdict = { vague: false, followUp: "", reason: "" };

function normalize(answer: string): string {
  return answer.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

/**
 * Judge a free-text design answer. Returns a concrete follow-up question when
 * the answer cannot be drawn from — never a hint that still lets it through.
 */
export function judgeDesignAnswer(answer: string, followUp: string): VaguenessVerdict {
  const text = normalize(answer);

  if (text.length === 0) {
    return { vague: true, followUp, reason: "The answer was empty." };
  }

  if (NON_ANSWERS.includes(text)) {
    return {
      vague: true,
      followUp,
      reason: `"${answer.trim()}" tells us how you want to feel about the shirt, not what to print on it.`,
    };
  }

  const words = text.split(" ").filter(Boolean);

  // "cool" / "something nice" / "a fun design" — adjectives with no subject.
  const contentWords = words.filter(
    (word) => !EMPTY_ADJECTIVES.includes(word) && !["a", "an", "the", "some", "something", "design", "shirt", "just", "really", "very"].includes(word),
  );
  if (contentWords.length === 0) {
    return {
      vague: true,
      followUp,
      reason: `"${answer.trim()}" describes a feeling, not a picture. We cannot cut from it.`,
    };
  }

  // Even a sentence can be empty: "I want a really cool design" has one content
  // word ("want") and still names nothing to print.
  if (words.length < 3 && contentWords.length < 2) {
    return {
      vague: true,
      followUp,
      reason: `"${answer.trim()}" is too short for us to draw from.`,
    };
  }

  return USABLE;
}

/** Exposed so the shop owner can see what the agent will bounce. */
export function knownNonAnswers(): readonly string[] {
  return NON_ANSWERS;
}
