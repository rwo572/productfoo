# Working Backwards PR/FAQ template

The narrative half of a Pitch paper. Start with the customer and work backwards:
write the launch-day press release *before* the thing exists, then use the FAQ to
map the dragons between here and there. The press release is a forcing function to
stay laser-focused on the customer; the FAQ proves you can actually get there.

**Posture:** truth-seeking, not selling. A pitch that requires solving *no* hard
problem should go back to the drawing board. The document must be able to conclude
**NO-GO** or **NOT-NOW**, and must argue against itself (see the counter-case).

## Press Release

- **Heading** — name the product so the target customer understands it. One sentence under the title.
- **Subheading** — the specific customer segment and the benefit they gain. One sentence. *If it's "for everyone," it's for no one — name the segment precisely.*
- **Summary paragraph** — city / outlet / **a real, meaningful launch (or ship) date**, then the product + benefit in brief. For internal or agent-facing work, define "launch to whom" (a PM? agents enabled? a release channel?).
- **Problem paragraph** — the customer's problem, written from *their* point of view. Not all problems are equal; pick the one that matters most.
- **Solution paragraph(s)** — how the product simply and directly solves that problem, in enough detail to be concrete. **Acknowledge the competition:** "Today customers use X / Y / Z; those fall short at …; we address the unmet need by …". If you solve the same problem the same way as what exists, go back to the drawing board.
- **Quotes & getting started** — one spokesperson quote, one hypothetical-customer quote naming the benefit; how easy it is to get started + where to learn more.

## FAQ

**External FAQ** — what the press and customers will ask: price, how it works, how to get help, where to get it, what happens in edge case X.

**Internal FAQ** — the hard questions from every function (finance, marketing, support, ops, legal, eng) and the challenging problems (technical, financial, legal, operational) that must be solved to build it. In a Pitch paper, **the staged opportunity assessment (`opportunity-assessment.md`) IS the Internal FAQ** — fuse them, don't bolt on two lists.

A great FAQ is optimistic *and* realistic: a data-based read on the opportunity, a firm grasp of what building it takes, the risks, and the conditions under which it succeeds or fails. It shows multiple options were considered for both the problem and the solution.

## Evidence ledger

Keep provenance out of the Press Release and FAQ prose. Put ordinary Markdown
citations beside sourced claims, then finish the paper with a compact ledger:

| Claim | Source type | Confidence | Citation |
| --- | --- | --- | --- |
| Concise load-bearing claim | primary / vendor / social / call / hypothesis | low / medium / high | Ordinary Markdown link or repo reference |

Use `hypothesis` as the source type for an estimate and state what would validate
it. Never wrap a citation inside an evidence tag or code span.

## The counter-case (non-negotiable — this is what keeps a pitch honest)

Always answer, explicitly:
- **What must be true** for this to succeed?
- **Top 3 reasons this fails.**
- **There is always a current solution** — will the customer actually change behavior and switch because we're meaningfully better / faster / cheaper?

## Watch-outs (Amazon's, worth keeping)

- **Velocity over speed** — direction matters more than raw pace; clarity up front makes the build fast.
- **Selling vs. truth-seeking** — don't pitch to "win" budget; surface what would prevent success.
- **Don't discount the competition** — a real problem already has a current solution.
- **Customer-backwards, not skills-forward** — start from what customers want, not what we're good at building today.
- **Great product, wrong problem** — a great product that solves no real problem still fails.
