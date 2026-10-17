// Rights problems refuse and escalate. (R-003, D-003)
//
// A flat "no" loses the order. The owner wants to see these — some are fine with
// a license, and she is the one who decides. So the agent stops the interview
// from taking the design, states the rule it hit, tells the customer what they
// CAN do, and hands the request to the owner.

export type RefusalRule = "copyrighted-character" | "trademarked-logo";

export interface RefusalListing {
  rule: RefusalRule;
  /** Names the owner can extend without touching code. */
  terms: string[];
}

/**
 * The refusal list, as data. The owner edits this; nobody edits the matcher.
 * (R-003 — "the refusal list is a data file the owner can extend".)
 */
export const REFUSAL_LIST: RefusalListing[] = [
  {
    rule: "copyrighted-character",
    terms: [
      "mickey mouse",
      "spider-man",
      "spiderman",
      "batman",
      "pikachu",
      "hello kitty",
      "elsa",
      "darth vader",
      "baby yoda",
      "grogu",
      "sonic the hedgehog",
      "super mario",
      "mario",
      "snoopy",
    ],
  },
  {
    rule: "trademarked-logo",
    terms: [
      "nike swoosh",
      "nike",
      "adidas",
      "supreme",
      "starbucks",
      "coca-cola",
      "coca cola",
      "apple logo",
      "louis vuitton",
      "gucci",
      "nfl",
      "nba",
    ],
  },
];

export interface Refusal {
  rule: RefusalRule;
  /** The exact term that tripped it, so the owner can judge the call. */
  term: string;
  /** What the agent says to the customer. */
  message: string;
  /** What the customer can do instead. Never just "no". */
  alternative: string;
  /** Rights problems go to a person, not to a silent decline. (D-003) */
  escalateTo: "shop-owner";
}

const RULE_LABEL: Record<RefusalRule, string> = {
  "copyrighted-character": "a copyrighted character",
  "trademarked-logo": "a trademarked logo",
};

function mentions(text: string, term: string): boolean {
  // Word-boundary match so "marion" does not trip "mario" and "supremely" does
  // not trip "supreme".
  const escaped = term.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Check a design answer against the refusal list. Returns every rule it hits —
 * an escalation the owner reads, not a decline the customer eats.
 */
export function checkRights(designText: string): Refusal[] {
  const text = designText.toLowerCase();
  const refusals: Refusal[] = [];

  for (const listing of REFUSAL_LIST) {
    for (const term of listing.terms) {
      if (!mentions(text, term)) continue;
      // One refusal per rule — naming five Disney characters is still one problem.
      if (refusals.some((existing) => existing.rule === listing.rule)) continue;
      refusals.push({
        rule: listing.rule,
        term,
        message: `We can't print "${term}" — it's ${RULE_LABEL[listing.rule]}, and we're not licensed for it.`,
        alternative:
          listing.rule === "copyrighted-character"
            ? "Tell us what you love about it — the pose, the colors, the vibe — and we'll draw something original in that spirit. If you hold a license, send it over and we'll pass it to the owner."
            : "We can print your own logo or wordmark. If you own or are licensed for this one, send proof and we'll pass it to the owner.",
        escalateTo: "shop-owner",
      });
    }
  }

  return refusals;
}
