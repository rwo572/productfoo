# Outside-in audit — data contract

`node render.mjs <company>.json > out.html`. Content is data; the renderer owns
markup, styles, and behavior. Escaping happens once in the renderer — **never
pre-escape values in the JSON** (write real `—`, `"`, `'`; do not write `&amp;`).

One field is trusted HTML: `read` (may contain `<strong>…</strong>`). Everything
else is escaped as plain text.

```jsonc
{
  "title":   "browser tab title",
  "tagline": "masthead line after the /\\/\\ mark",
  "date":    "YYYY-MM-DD (the prepared date)",
  "recipient": "verified full name — NEVER the LinkedIn handle; confirm from a fetched source",
  "company": "Company",
  "mark":    "data:image/png;base64,… (the company's own favicon/webclip, ≤36px, inlined)",
  "h1":      "We ran foo for <Company>.",
  "lede":    "one-line promise",
  "bridge":  "the conversion bridge, rendered right under the lede (above the fold). Names the artifact as productfoo's OUTPUT and says foo re-runs it continuously, so a skimmer converts 'great analysis of my company' into 'foo made this and will keep making it for me.' Target-relevant payoff, plain language, no machinery words.",

  "readTitle": "What you can't hear from inside   (founder edition; else 'The outsider's read on your positioning')",
  "read":      "one synthesis paragraph. TRUSTED HTML — <strong> allowed for the closing law.",
  "positioning": [
    // April Dunford's positioning components, READ FROM THE OUTSIDE. Renders as a scannable
    // labeled list under the read paragraph. Preferred over `quotes` — fold quote evidence in as receipts.
    // Fixed order: Alternatives · Unique attributes · Value (+ proof) · Best-fit buyers · Category · Trend to ride.
    { "label": "Alternatives", "finding": "one line — what buyers use if this company didn't exist",
      "receipts": [ { "label": "domain · YYYY-MM-DD", "href": "…" } ] }
  ],
  "quotes": [
    // OPTIONAL / legacy. If `positioning` is present the renderer shows it instead. 3 quotes forming an
    // arc (declared → chosen → paid-for). For a FOUNDER recipient: perception-gap / absence / world-moving, NEVER biography.
    { "takeaway": "bold lead line", "quote": "verbatim, in the renderer's own quotes",
      "body": "optional extra sentence, unquoted", "who": "attribution (name the speaker)",
      "receipts": [ { "label": "domain · YYYY-MM-DD", "href": "…" } ] }
  ],

  "mapTitle": "What's moving outside your walls  (founder edition; else 'The map: who's coming, from where')",
  "map": [
    // exactly 3, fixed slots: 1 incumbents' transformation · 2 category peers' AI-native DISTRIBUTION · 3 insurgents.
    // Actors re-derived for THIS company's category (NO cross-target porting). Receipts primary-source, ≤90d where possible.
    { "claim": "bold claim w/ money/power verb", "body": "1–2 sentences + closing law",
      "receipts": [ … ], "research": "/foo:research \"natural-language deep-dive question\"" }
  ],

  "movesTitle":   "Three moves the outside read supports",
  "movesCaption": "each one builds the trust the next one needs · paste a prompt into your agent to get the full pitch",
  "moves": [
    // exactly 3. Each an AI-native lean, channel-first, sized honestly and BITEABLE
    // (a first sprint, not a moonshot). Ladder: fast move / revenue move / identity move.
    { "num": "01", "title": "Move name", "verdict": "the fast move · listing live in 30 days",
      "lead": "bold one-liner", "body": "2 short sentences, simple prose",
      "receipts": [ … ],
      "highlight": true,   // OPTIONAL, put on exactly ONE move: the repositioning bet. Renders a highlighted box + tag so the 30-second eye lands on it.
      "impact": {          // a MODELED projection, not a lone number. headline shows; the math hides behind "show the math"; a `modeled` chip labels it.
        "headline": "the lever + the band (e.g. '~$1.4–2.5M new ARR'). Do NOT write the word 'modeled' — the chip already says it.",
        "basis": [ "each line one step of a bottoms-up model from PUBLIC data: pricing, community/Reddit signal, category ACV, unit economics", "→ arithmetic that lands the headline band" ],
        "sources": "which inputs are public vs. which are stated assumptions — always name the assumptions"
      },
      "spec": "/foo:spec \"imperative commands, sharp\"" }
  ],

  "honesty": "read entirely from public evidence; …",
  "whatis":  "one concrete sentence defining foo",
  "ctaHeadline": "Go from idea to revenue in 30 days with foo.",
  "ctaPrompt":   "the product you keep not building"
}
```

## Pre-flight checklist (run before render — these are the swarm lenses baked as rules)

- **Recipient verified** from a fetched source, not the LinkedIn URL.
- **No cross-target receipts** — every receipt was gathered for THIS company.
- **Freshness** — target-specific receipts ≤90d, or framed as history/absence.
- **Source weight** — funding/M&A from primary announcements or major press, never landscape blogs / aggregators / trackers.
- **Founder rule** — if the recipient authored the material, the read must not mirror it back.
- **Audience-fit for the read** — "buzz-silence" beats (no HN stories, no dev chatter) only land for BOTTOMS-UP / developer-audience companies. For an enterprise, sales-led company they read as irrelevant (it doesn't court that crowd) — use a perception/positioning/attention gap the buyer actually feels instead. Two strong beats beat three with a weak one.
- **Recommendations stress-tested** — run the strategy + feasibility swarm on the three moves; a move that can't be built (e.g. "run a funnel inside ChatGPT") gets cut, not shipped. Each move biteable.
- **Technical docs read** — the target's developer/API documentation is a required intake source, not optional. It is where you learn the product's real primitives and limits (for example an MCP surface, rate limits, an activity log) — the feasibility red-team stands on it, and a move built against a constraint the docs disclose (a publish throttle, a sandboxed payment lane) is caught here, not after send.
- **Impact estimated** — every move carries an `impact` line: the lever it moves, one unit-economics anchor on a PUBLIC price, the assumption named inline. Never a forecast of the target's private actuals; hand them the multiplier. Match the framing to the business model (self-serve ARR math vs enterprise pipeline/retention levers).
- **Prose simple, specs sharp** — explanation reads in a glance; the `/foo:spec` is imperative and copy-run-able.
- **Standing:** the page names a real person + carries a real mark — it never travels without an explicit send decision.
